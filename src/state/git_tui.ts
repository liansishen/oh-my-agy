/**
 * Git repository review model & CLI action runner backing `oma`'s `omp.app.git`-aligned
 * fullscreen Git overlay (triggered by clicking the bottom `git` status segment or `/git`).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { GitExecFn, GitExecResult } from './git_status';

export type GitChangeKind =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted';

export type GitChangeArea = 'unstaged' | 'staged' | 'commit';

export type GitDiffViewMode = 'split' | 'inline' | 'file';

export type GitSidebarStyle = 'path' | 'tree';

export interface GitChangedFile {
  readonly path: string;
  readonly origPath?: string;
  readonly kind: GitChangeKind;
  readonly area: GitChangeArea;
  readonly additions?: number;
  readonly deletions?: number;
}

export interface GitHeadCommit {
  readonly sha: string;
  readonly shortSha: string;
  readonly subject: string;
  readonly body: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authorDate: string;
  readonly parents: readonly string[];
  readonly files: readonly GitChangedFile[];
}

export interface GitRepoSnapshot {
  readonly cwd: string;
  readonly branch: string | null;
  readonly detached: boolean;
  readonly clean: boolean;
  readonly unstaged: readonly GitChangedFile[];
  readonly staged: readonly GitChangedFile[];
  readonly headCommit: GitHeadCommit | null;
}

export interface GitFileDiffResult {
  readonly fileKey: string;
  readonly filePath: string;
  readonly area: GitChangeArea;
  readonly kind: 'diff' | 'binary' | 'tooLarge' | 'empty' | 'error';
  readonly unifiedDiff: string;
  readonly additions: number;
  readonly deletions: number;
  readonly message?: string;
}

export interface GitOverlayStatusMessage {
  readonly text: string;
  readonly tone: 'success' | 'warning' | 'error' | 'accent' | 'muted';
}

export type GitFocusedField = 'summary' | 'description' | null;

export interface GitOverlayState {
  readonly loading: boolean;
  readonly busy: boolean;
  readonly error?: string;
  readonly snapshot: GitRepoSnapshot | null;
  readonly selectedFileKey: string | null;
  readonly diffLoading: boolean;
  readonly diff: GitFileDiffResult | null;
  readonly viewMode: GitDiffViewMode;
  readonly wrap: boolean;
  readonly sidebarStyle: GitSidebarStyle;
  readonly foldedSections: Readonly<Record<'unstaged' | 'staged', boolean>>;
  readonly foldedDirs: Readonly<Record<string, boolean>>;
  readonly commitSummary: string;
  readonly commitBody: string;
  readonly commitAmend: boolean;
  readonly focusedField: GitFocusedField;
  readonly statusMessage: GitOverlayStatusMessage | null;
}

export interface GitActionResult {
  readonly ok: boolean;
  readonly message: string;
}

const DEFAULT_GIT_TUI_TIMEOUT_MS = 4000;
const MAX_UNTRACKED_DIFF_BYTES = 512 * 1024;
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

export function gitFileKey(area: GitChangeArea, filePath: string): string {
  return `${area}:${filePath}`;
}

async function runDefaultGit(
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
): Promise<GitExecResult> {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    proc = Bun.spawn(['git', ...args], {
      cwd: options.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
      windowsHide: true,
    });
    const stdoutPromise = proc.stdout
      ? new Response(proc.stdout as ReadableStream<Uint8Array>).text().catch(() => '')
      : Promise.resolve('');
    const stderrPromise = proc.stderr
      ? new Response(proc.stderr as ReadableStream<Uint8Array>).text().catch(() => '')
      : Promise.resolve('');

    const timedOut = Symbol('timeout');
    const exitOrTimeout = await Promise.race([
      proc.exited,
      new Promise<typeof timedOut>(resolve => {
        timer = setTimeout(() => resolve(timedOut), options.timeoutMs);
      }),
    ]);

    if (exitOrTimeout === timedOut) {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      return { exitCode: -1, stdout: '', stderr: 'git timed out' };
    }

    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    return { exitCode: exitOrTimeout, stdout, stderr };
  } catch (err) {
    return {
      exitCode: -1,
      stdout: '',
      stderr: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function kindFromCode(code: string): GitChangeKind {
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    case 'U':
      return 'conflicted';
    case '?':
      return 'untracked';
    default:
      return 'modified';
  }
}

/**
 * Parse NUL-delimited `git status --porcelain=v1 -z -uall` output into staged
 * and unstaged `GitChangedFile` arrays (mirroring `omp`'s `GitModel`).
 */
export function parsePorcelainV1Z(stdout: string): {
  readonly unstaged: GitChangedFile[];
  readonly staged: GitChangedFile[];
} {
  const unstaged: GitChangedFile[] = [];
  const staged: GitChangedFile[] = [];
  if (!stdout) return { unstaged, staged };

  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (!entry || entry.length < 4) continue;
    const x = entry[0]!;
    const y = entry[1]!;
    const xy = `${x}${y}`;
    const filePath = entry.slice(3);
    if (!filePath) continue;

    let origPath: string | undefined;
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const next = tokens[i + 1];
      if (next) {
        origPath = next;
        i += 1;
      }
    }

    if (xy === '??') {
      unstaged.push({ path: filePath, kind: 'untracked', area: 'unstaged' });
      continue;
    }
    if (xy === '!!') continue;

    if (CONFLICT_CODES.has(xy)) {
      unstaged.push({
        path: filePath,
        ...(origPath ? { origPath } : {}),
        kind: 'conflicted',
        area: 'unstaged',
      });
      continue;
    }

    if (x !== ' ' && x !== '?') {
      staged.push({
        path: filePath,
        ...(origPath ? { origPath } : {}),
        kind: kindFromCode(x),
        area: 'staged',
      });
    }
    if (y !== ' ' && y !== '?') {
      unstaged.push({
        path: filePath,
        ...(origPath ? { origPath } : {}),
        kind: kindFromCode(y),
        area: 'unstaged',
      });
    }
  }

  unstaged.sort((a, b) => a.path.localeCompare(b.path));
  staged.sort((a, b) => a.path.localeCompare(b.path));
  return { unstaged, staged };
}

/**
 * Parse `git diff --numstat` (or `git show --numstat`) lines into a map of
 * `path -> { additions, deletions }`.
 */
export function parseNumstatMap(stdout: string): Map<string, { additions: number; deletions: number }> {
  const map = new Map<string, { additions: number; deletions: number }>();
  if (!stdout) return map;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const rawAdd = parts[0]!;
    const rawDel = parts[1]!;
    const rawPath = parts.slice(2).join('\t').trim();
    if (!rawPath) continue;
    // Normalize rename notation `dir/{old => new}` or `old => new` to destination path
    const resolvedPath = rawPath.includes(' => ')
      ? rawPath.replace(/\{([^{}]*?) => ([^{}]*?)\}/g, '$2').split(' => ').pop()!.trim()
      : rawPath;
    const additions = rawAdd === '-' ? 0 : Number.parseInt(rawAdd, 10) || 0;
    const deletions = rawDel === '-' ? 0 : Number.parseInt(rawDel, 10) || 0;
    map.set(resolvedPath, { additions, deletions });
  }
  return map;
}

function attachStats(
  files: readonly GitChangedFile[],
  stats: Map<string, { additions: number; deletions: number }>,
): GitChangedFile[] {
  return files.map(f => {
    const s = stats.get(f.path);
    if (!s) return f;
    return {
      ...f,
      additions: s.additions,
      deletions: s.deletions,
    };
  });
}

function parseHeadMeta(stdout: string): Omit<GitHeadCommit, 'files'> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('\x1f');
  if (parts.length < 7) return null;
  const sha = parts[0]?.trim() ?? '';
  const shortSha = parts[1]?.trim() || sha.slice(0, 8);
  const subject = parts[2]?.trim() ?? '';
  const body = parts[3]?.trim() ?? '';
  const authorName = parts[4]?.trim() ?? '';
  const authorEmail = parts[5]?.trim() ?? '';
  const authorDate = parts[6]?.trim() ?? '';
  const parentsRaw = parts[7]?.trim() ?? '';
  const parents = parentsRaw ? parentsRaw.split(/\s+/).filter(Boolean) : [];
  if (!sha) return null;
  return { sha, shortSha, subject, body, authorName, authorEmail, authorDate, parents };
}

function parseCommitNameStatus(
  stdout: string,
  numstat: Map<string, { additions: number; deletions: number }>,
): GitChangedFile[] {
  const files: GitChangedFile[] = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split('\t');
    const code = parts[0]?.[0];
    if (!code) continue;
    if ((code === 'R' || code === 'C') && parts.length >= 3) {
      const origPath = parts[1]!;
      const nextPath = parts[2]!;
      const st = numstat.get(nextPath);
      files.push({
        path: nextPath,
        origPath,
        kind: 'renamed',
        area: 'commit',
        ...(st ? { additions: st.additions, deletions: st.deletions } : {}),
      });
    } else if (parts.length >= 2) {
      const filePath = parts[1]!;
      const st = numstat.get(filePath);
      files.push({
        path: filePath,
        kind: kindFromCode(code),
        area: 'commit',
        ...(st ? { additions: st.additions, deletions: st.deletions } : {}),
      });
    }
  }
  return files;
}

/**
 * Load a full `GitRepoSnapshot` for `cwd` (branch, unstaged/staged file lists with
 * line stats, and HEAD commit metadata + files when clean).
 * Throws when `cwd` is not inside a Git repository.
 */
export async function loadGitRepoSnapshot(
  cwd: string,
  options?: { readonly timeoutMs?: number; readonly exec?: GitExecFn },
): Promise<GitRepoSnapshot> {
  const exec = options?.exec ?? runDefaultGit;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TUI_TIMEOUT_MS;

  const [statusRes, branchRes, headRes] = await Promise.all([
    exec(['status', '--porcelain=v1', '-z', '-uall'], { cwd, timeoutMs }),
    exec(['symbolic-ref', '--short', 'HEAD'], { cwd, timeoutMs }),
    exec(['log', '-1', '--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%P'], {
      cwd,
      timeoutMs,
    }),
  ]);

  if (statusRes.exitCode !== 0) {
    const errText = statusRes.stderr?.trim() || 'Not a git repository';
    throw new Error(errText);
  }

  const parsedStatus = parsePorcelainV1Z(statusRes.stdout);
  const detached = branchRes.exitCode !== 0 || branchRes.stdout.trim().length === 0;
  const headMeta = headRes.exitCode === 0 ? parseHeadMeta(headRes.stdout) : null;
  const branch = !detached
    ? branchRes.stdout.trim()
    : headMeta?.shortSha
      ? `@${headMeta.shortSha}`
      : null;

  const clean = parsedStatus.unstaged.length === 0 && parsedStatus.staged.length === 0;

  let unstaged = parsedStatus.unstaged;
  let staged = parsedStatus.staged;
  let headCommit: GitHeadCommit | null = headMeta ? { ...headMeta, files: [] } : null;

  if (!clean) {
    const [unstagedStatRes, stagedStatRes] = await Promise.all([
      unstaged.length > 0
        ? exec(['diff', '--numstat'], { cwd, timeoutMs })
        : Promise.resolve<GitExecResult>({ exitCode: 0, stdout: '' }),
      staged.length > 0
        ? exec(['diff', '--cached', '--numstat'], { cwd, timeoutMs })
        : Promise.resolve<GitExecResult>({ exitCode: 0, stdout: '' }),
    ]);
    if (unstagedStatRes.exitCode === 0) {
      unstaged = attachStats(unstaged, parseNumstatMap(unstagedStatRes.stdout));
    }
    if (stagedStatRes.exitCode === 0) {
      staged = attachStats(staged, parseNumstatMap(stagedStatRes.stdout));
    }
  } else if (headMeta) {
    const [nameStatusRes, numstatRes] = await Promise.all([
      exec(['show', '--format=', '--name-status', '--root', headMeta.sha], { cwd, timeoutMs }),
      exec(['show', '--format=', '--numstat', '--root', headMeta.sha], { cwd, timeoutMs }),
    ]);
    const statsMap = numstatRes.exitCode === 0 ? parseNumstatMap(numstatRes.stdout) : new Map();
    const headFiles =
      nameStatusRes.exitCode === 0
        ? parseCommitNameStatus(nameStatusRes.stdout, statsMap)
        : [];
    headCommit = { ...headMeta, files: headFiles };
  }

  return {
    cwd,
    branch,
    detached,
    clean,
    unstaged,
    staged,
    headCommit,
  };
}

function countUnifiedDiffStats(diffText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

function stripDiffPreamble(rawDiff: string): string {
  const lines = rawDiff.split(/\r?\n/);
  const firstHunk = lines.findIndex(l => l.startsWith('@@ '));
  if (firstHunk >= 0) {
    return lines.slice(firstHunk).join('\n');
  }
  return rawDiff;
}

/**
 * Load a unified diff for one changed file suitable for Tern's native `<diff>` element.
 */
export async function loadGitFileDiff(
  cwd: string,
  file: GitChangedFile,
  options?: {
    readonly wholeFile?: boolean;
    readonly headSha?: string;
    readonly timeoutMs?: number;
    readonly exec?: GitExecFn;
  },
): Promise<GitFileDiffResult> {
  const exec = options?.exec ?? runDefaultGit;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TUI_TIMEOUT_MS;
  const key = gitFileKey(file.area, file.path);
  const contextArg = options?.wholeFile ? '-U99999' : '-U3';

  if (file.area === 'unstaged' && file.kind === 'untracked') {
    const absPath = path.resolve(cwd, file.path);
    try {
      const st = await fs.stat(absPath);
      if (st.size > MAX_UNTRACKED_DIFF_BYTES) {
        return {
          fileKey: key,
          filePath: file.path,
          area: file.area,
          kind: 'tooLarge',
          unifiedDiff: '',
          additions: 0,
          deletions: 0,
          message: `Untracked file is too large to diff (${Math.round(st.size / 1024)} KB).`,
        };
      }
      const bytes = await fs.readFile(absPath);
      const checkLen = Math.min(bytes.byteLength, 8192);
      for (let i = 0; i < checkLen; i++) {
        if (bytes[i] === 0) {
          return {
            fileKey: key,
            filePath: file.path,
            area: file.area,
            kind: 'binary',
            unifiedDiff: '',
            additions: 0,
            deletions: 0,
            message: `Binary file (${Math.round(bytes.byteLength / 1024)} KB)`,
          };
        }
      }
      const text = new TextDecoder('utf-8').decode(bytes);
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
      }
      if (lines.length === 0) {
        return {
          fileKey: key,
          filePath: file.path,
          area: file.area,
          kind: 'empty',
          unifiedDiff: '',
          additions: 0,
          deletions: 0,
          message: 'Empty untracked file.',
        };
      }
      const unified = [
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map(l => `+${l}`),
      ].join('\n');
      return {
        fileKey: key,
        filePath: file.path,
        area: file.area,
        kind: 'diff',
        unifiedDiff: unified,
        additions: lines.length,
        deletions: 0,
      };
    } catch (err) {
      return {
        fileKey: key,
        filePath: file.path,
        area: file.area,
        kind: 'error',
        unifiedDiff: '',
        additions: 0,
        deletions: 0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  let args: string[];
  if (file.area === 'staged') {
    args = ['diff', '--cached', '--no-color', contextArg, '--', file.path];
  } else if (file.area === 'commit') {
    const rev = options?.headSha || 'HEAD';
    args = ['show', '--format=', '--no-color', '--root', contextArg, rev, '--', file.path];
  } else {
    args = ['diff', '--no-color', contextArg, '--', file.path];
  }

  const res = await exec(args, { cwd, timeoutMs });
  if (res.exitCode !== 0) {
    return {
      fileKey: key,
      filePath: file.path,
      area: file.area,
      kind: 'error',
      unifiedDiff: '',
      additions: 0,
      deletions: 0,
      message: res.stderr?.trim() || 'Failed to compute diff.',
    };
  }

  const raw = res.stdout;
  if (!raw.trim()) {
    return {
      fileKey: key,
      filePath: file.path,
      area: file.area,
      kind: 'empty',
      unifiedDiff: '',
      additions: 0,
      deletions: 0,
      message: 'No textual differences.',
    };
  }
  if (/^Binary files .+ differ$/m.test(raw) || /^GIT binary patch$/m.test(raw)) {
    return {
      fileKey: key,
      filePath: file.path,
      area: file.area,
      kind: 'binary',
      unifiedDiff: '',
      additions: 0,
      deletions: 0,
      message: 'Binary file changed.',
    };
  }

  const unifiedDiff = stripDiffPreamble(raw);
  const { additions, deletions } = countUnifiedDiffStats(unifiedDiff);
  return {
    fileKey: key,
    filePath: file.path,
    area: file.area,
    kind: 'diff',
    unifiedDiff,
    additions,
    deletions,
  };
}

export async function stageGitFiles(
  cwd: string,
  paths: readonly string[] | 'all',
  options?: { readonly timeoutMs?: number; readonly exec?: GitExecFn },
): Promise<GitActionResult> {
  const exec = options?.exec ?? runDefaultGit;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TUI_TIMEOUT_MS;
  const args = paths === 'all' ? ['add', '-A'] : ['add', '--', ...paths];
  const res = await exec(args, { cwd, timeoutMs });
  if (res.exitCode !== 0) {
    return { ok: false, message: res.stderr?.trim() || 'git add failed' };
  }
  return {
    ok: true,
    message:
      paths === 'all'
        ? 'Staged all changes'
        : `Staged ${paths.length === 1 ? paths[0] : `${paths.length} files`}`,
  };
}

export async function unstageGitFiles(
  cwd: string,
  paths: readonly string[] | 'all',
  options?: { readonly timeoutMs?: number; readonly exec?: GitExecFn },
): Promise<GitActionResult> {
  const exec = options?.exec ?? runDefaultGit;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TUI_TIMEOUT_MS;
  // Use `git reset HEAD -- ...` which also works on repos with commits; fallback to `git rm --cached` if unborn HEAD
  const args = paths === 'all' ? ['reset', 'HEAD'] : ['reset', 'HEAD', '--', ...paths];
  let res = await exec(args, { cwd, timeoutMs });
  if (res.exitCode !== 0 && /ambiguous argument 'HEAD'|unknown revision/i.test(res.stderr ?? '')) {
    const rmArgs = paths === 'all' ? ['rm', '--cached', '-r', '.'] : ['rm', '--cached', '--', ...paths];
    res = await exec(rmArgs, { cwd, timeoutMs });
  }
  if (res.exitCode !== 0) {
    return { ok: false, message: res.stderr?.trim() || 'git reset failed' };
  }
  return {
    ok: true,
    message:
      paths === 'all'
        ? 'Unstaged all changes'
        : `Unstaged ${paths.length === 1 ? paths[0] : `${paths.length} files`}`,
  };
}

export async function commitGitChanges(
  cwd: string,
  params: {
    readonly summary: string;
    readonly body?: string;
    readonly amend?: boolean;
    readonly stageAllIfEmpty?: boolean;
  },
  options?: { readonly timeoutMs?: number; readonly exec?: GitExecFn },
): Promise<GitActionResult> {
  const exec = options?.exec ?? runDefaultGit;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TUI_TIMEOUT_MS;
  const summary = params.summary.trim();
  const body = params.body?.trim() ?? '';

  if (!summary && !params.amend) {
    return { ok: false, message: 'Write a summary line first' };
  }

  if (params.stageAllIfEmpty) {
    const stageRes = await stageGitFiles(cwd, 'all', { timeoutMs, exec });
    if (!stageRes.ok) return stageRes;
  }

  const args = ['commit'];
  if (params.amend) args.push('--amend');
  if (summary) {
    args.push('-m', summary);
    if (body) args.push('-m', body);
  } else {
    args.push('--no-edit');
  }

  const res = await exec(args, { cwd, timeoutMs });
  if (res.exitCode !== 0) {
    return { ok: false, message: res.stderr?.trim() || res.stdout.trim() || 'git commit failed' };
  }
  return {
    ok: true,
    message: params.amend ? 'Amended HEAD commit' : `Committed: ${summary}`,
  };
}

export interface GitSidebarEntry {
  readonly kind: 'dir' | 'file';
  readonly key: string;
  readonly depth: number;
  readonly dirPath?: string;
  readonly dirName?: string;
  readonly collapsed?: boolean;
  readonly file?: GitChangedFile;
}

/**
 * Build flat path entries or collapsible folder-tree entries for a section's file list.
 */
export function buildGitSidebarEntries(
  files: readonly GitChangedFile[],
  area: GitChangeArea,
  style: GitSidebarStyle,
  foldedDirs: Readonly<Record<string, boolean>>,
): GitSidebarEntry[] {
  if (style === 'path') {
    return files.map(file => ({
      kind: 'file',
      key: gitFileKey(area, file.path),
      depth: 0,
      file,
    }));
  }

  // Group into nested directory tree
  interface DirNode {
    name: string;
    fullPath: string;
    dirs: Map<string, DirNode>;
    files: GitChangedFile[];
  }
  const root: DirNode = { name: '', fullPath: '', dirs: new Map(), files: [] };
  for (const file of files) {
    const segments = file.path.split('/');
    let cur = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const nextPath = cur.fullPath ? `${cur.fullPath}/${seg}` : seg;
      let child = cur.dirs.get(seg);
      if (!child) {
        child = { name: seg, fullPath: nextPath, dirs: new Map(), files: [] };
        cur.dirs.set(seg, child);
      }
      cur = child;
    }
    cur.files.push(file);
  }

  const out: GitSidebarEntry[] = [];
  const walk = (node: DirNode, depth: number): void => {
    const sortedDirs = [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
    for (const dir of sortedDirs) {
      const dirKey = `${area}:dir:${dir.fullPath}`;
      const collapsed = Boolean(foldedDirs[dirKey]);
      out.push({
        kind: 'dir',
        key: dirKey,
        depth: Math.min(depth, 8),
        dirPath: dir.fullPath,
        dirName: dir.name,
        collapsed,
      });
      if (!collapsed) {
        walk(dir, depth + 1);
      }
    }
    const sortedFiles = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
    for (const file of sortedFiles) {
      out.push({
        kind: 'file',
        key: gitFileKey(area, file.path),
        depth: Math.min(depth, 8),
        file,
      });
    }
  };
  walk(root, 0);
  return out;
}

export function getAllVisibleGitFiles(snapshot: GitRepoSnapshot | null): readonly GitChangedFile[] {
  if (!snapshot) return [];
  if (snapshot.clean) {
    return snapshot.headCommit?.files ?? [];
  }
  return [...snapshot.unstaged, ...snapshot.staged];
}
