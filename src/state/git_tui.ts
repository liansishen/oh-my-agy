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
  | 'copied'
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
  /** Resolved absolute Git path env (e.g. `GIT_DIR`, `GIT_WORK_TREE`) captured before changing cwd. */
  readonly gitEnv?: Readonly<Record<string, string>>;
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
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<GitExecResult> {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Strip inherited Git pathspec env overrides (`GIT_LITERAL_PATHSPECS`, `GIT_GLOB_PATHSPECS`,
    // `GIT_NOGLOB_PATHSPECS`, `GIT_ICASE_PATHSPECS`) so explicit `--literal-pathspecs` CLI flags
    // always behave deterministically regardless of caller shell environment.
    const cleanEnv: Record<string, string | undefined> = {
      ...process.env,
      ...(options.env ?? {}),
      GIT_OPTIONAL_LOCKS: '0',
    };
    delete cleanEnv['GIT_LITERAL_PATHSPECS'];
    delete cleanEnv['GIT_GLOB_PATHSPECS'];
    delete cleanEnv['GIT_NOGLOB_PATHSPECS'];
    delete cleanEnv['GIT_ICASE_PATHSPECS'];

    proc = Bun.spawn(['git', ...args], {
      cwd: options.cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      env: cleanEnv,
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
      return 'renamed';
    case 'C':
      return 'copied';
    case 'U':
      return 'conflicted';
    case '?':
      return 'untracked';
    default:
      return 'modified';
  }
}

/**
 * Compute exact repository-relative paths to pass for staging or unstaging one entry:
 * - Unstaging a staged **rename** (`R`) must reset both destination and `origPath` so
 *   `D <origPath>` does not remain stranded in the index.
 * - Staging an unstaged modification on a renamed file (`RM`), or unstaging a **copy** (`C`),
 *   must touch ONLY `file.path` so unrelated/recreated source files or source modifications
 *   are never altered.
 */
export function resolveGitStageActionPaths(
  file: GitChangedFile,
  op: 'stage' | 'unstage',
): string[] {
  if (
    op === 'unstage' &&
    file.area === 'staged' &&
    file.kind === 'renamed' &&
    file.origPath &&
    file.origPath !== file.path
  ) {
    return [file.path, file.origPath];
  }
  return [file.path];
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
      const xHasOrig = (x === 'R' || x === 'C') && Boolean(origPath);
      staged.push({
        path: filePath,
        ...(xHasOrig ? { origPath } : {}),
        kind: kindFromCode(x),
        area: 'staged',
      });
    }
    if (y !== ' ' && y !== '?') {
      const yHasOrig = (y === 'R' || y === 'C') && Boolean(origPath);
      unstaged.push({
        path: filePath,
        ...(yHasOrig ? { origPath } : {}),
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

const RELATIVE_GIT_PATH_ENV_KEYS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_COMMON_DIR',
] as const;

/**
 * Strip only the single line terminator Git appends to stdout:
 * - On POSIX, strips ONLY a trailing `\n` so a directory name containing a literal
 *   trailing `\r` or space is preserved verbatim.
 * - On Windows, strips a trailing `\r\n` or `\n`.
 */
export function stripGitLineEnding(
  stdout: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return stdout.replace(/\r?\n$/, '');
  }
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
}

function hasCustomGitPathEnv(
  sourceEnv: Readonly<Record<string, string | undefined>>,
): boolean {
  for (const key of RELATIVE_GIT_PATH_ENV_KEYS) {
    const val = sourceEnv[key];
    if (typeof val === 'string' && val.length > 0) return true;
  }
  const altDirs = sourceEnv['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
  return typeof altDirs === 'string' && altDirs.length > 0;
}

interface ParsedGitAltEntry {
  readonly raw: string;
  readonly decoded: string;
  readonly quoted: boolean;
  readonly malformed: boolean;
}

/**
 * Parse `GIT_ALTERNATE_OBJECT_DIRECTORIES` following Git's `link_alt_odb_entries()`
 * and `unquote_c_style()` semantics: entries starting with `"` are C-style quoted
 * and may contain the path delimiter (`:` on POSIX, `;` on Windows) without being split.
 */
export function parseGitAlternateObjectDirectories(
  raw: string,
  delimiter: string = path.delimiter,
): ParsedGitAltEntry[] {
  const entries: ParsedGitAltEntry[] = [];
  let i = 0;
  const len = raw.length;

  while (i < len) {
    if (raw[i] === delimiter) {
      entries.push({ raw: '', decoded: '', quoted: false, malformed: false });
      i += 1;
      continue;
    }

    const start = i;
    if (raw[i] === '"') {
      i += 1;
      const bytes: number[] = [];
      let closed = false;
      while (i < len) {
        const ch = raw[i]!;
        if (ch === '"') {
          i += 1;
          closed = true;
          break;
        }
        if (ch === '\\' && i + 1 < len) {
          const next = raw[i + 1]!;
          if (next >= '0' && next <= '7') {
            let oct = next;
            let k = i + 2;
            while (k < len && oct.length < 3 && raw[k]! >= '0' && raw[k]! <= '7') {
              oct += raw[k]!;
              k += 1;
            }
            bytes.push(Number.parseInt(oct, 8) & 0xff);
            i = k;
            continue;
          }
          const escMap: Record<string, number> = {
            a: 0x07,
            b: 0x08,
            f: 0x0c,
            n: 0x0a,
            r: 0x0d,
            t: 0x09,
            v: 0x0b,
            '\\': 0x5c,
            '"': 0x22,
          };
          const mapped = escMap[next];
          if (mapped !== undefined) {
            bytes.push(mapped);
            i += 2;
            continue;
          }
          for (const b of Buffer.from(next, 'utf8')) bytes.push(b);
          i += 2;
          continue;
        }
        const cp = raw.codePointAt(i)!;
        const step = cp > 0xffff ? 2 : 1;
        for (const b of Buffer.from(raw.slice(i, i + step), 'utf8')) {
          bytes.push(b);
        }
        i += step;
      }

      let trailing = '';
      while (i < len && raw[i] !== delimiter) {
        trailing += raw[i]!;
        i += 1;
      }
      const rawToken = raw.slice(start, i);
      const decoded = Buffer.from(bytes).toString('utf8') + trailing;
      entries.push({
        raw: rawToken,
        decoded,
        quoted: true,
        malformed: !closed,
      });
      if (i < len && raw[i] === delimiter) {
        i += 1;
      }
      continue;
    }

    while (i < len && raw[i] !== delimiter) {
      i += 1;
    }
    const token = raw.slice(start, i);
    entries.push({ raw: token, decoded: token, quoted: false, malformed: false });
    if (i < len && raw[i] === delimiter) {
      i += 1;
    }
  }

  return entries;
}

/**
 * Format a resolved path for `GIT_ALTERNATE_OBJECT_DIRECTORIES`, applying Git C-style
 * quoting whenever the path contains the platform delimiter, quotes, or control chars.
 */
export function formatGitAlternateObjectPath(
  entryPath: string,
  delimiter: string = path.delimiter,
): string {
  const needsQuote =
    entryPath.startsWith('"') ||
    entryPath.includes(delimiter) ||
    entryPath.includes('"') ||
    /[\x00-\x1f\x7f]/.test(entryPath);
  if (!needsQuote) return entryPath;

  let out = '"';
  for (let i = 0; i < entryPath.length; i++) {
    const ch = entryPath[i]!;
    const code = ch.charCodeAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += ch;
  }
  out += '"';
  return out;
}

function isPathInsideDir(
  candidate: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normCandidate =
    platform === 'win32' ? pathApi.resolve(candidate).toLowerCase() : pathApi.resolve(candidate);
  const normParent =
    platform === 'win32' ? pathApi.resolve(parent).toLowerCase() : pathApi.resolve(parent);
  const rel = pathApi.relative(normParent, normCandidate);
  const isOutside = rel === '..' || rel.startsWith(`..${pathApi.sep}`) || pathApi.isAbsolute(rel);
  return !isOutside;
}

/**
 * Normalize `GIT_ALTERNATE_OBJECT_DIRECTORIES` while preserving Git's C-style quoting
 * semantics for paths containing delimiters (`:` / `;`). Absolute entries keep their
 * original quoting intact; relative entries are resolved against `baseDir` and re-quoted
 * if needed.
 */
export function normalizeGitAlternateObjectDirectories(
  raw: string,
  baseDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const delimiter = pathApi.delimiter;
  const parsed = parseGitAlternateObjectDirectories(raw, delimiter);
  return parsed
    .map(entry => {
      if (entry.malformed || entry.decoded.length === 0) {
        return entry.raw;
      }
      if (pathApi.isAbsolute(entry.decoded)) {
        return entry.raw;
      }
      const resolved = pathApi.resolve(baseDir, entry.decoded);
      return formatGitAlternateObjectPath(resolved, delimiter);
    })
    .join(delimiter);
}

export interface GitRepoContext {
  readonly repoRoot: string;
  readonly gitEnv?: Readonly<Record<string, string>>;
}

/**
 * Resolve the Git working tree top-level root for `cwd`.
 * Strips only the trailing line terminator (preserving legitimate trailing spaces
 * and POSIX trailing `\r`). Falls back to `cwd` when `rev-parse` is unavailable.
 */
export async function resolveGitRepoRoot(
  cwd: string,
  options?: {
    readonly timeoutMs?: number;
    readonly exec?: GitExecFn;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly platform?: NodeJS.Platform;
  },
): Promise<string> {
  const exec = options?.exec ?? runDefaultGit;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TUI_TIMEOUT_MS;
  const res = await exec(['rev-parse', '--show-toplevel'], {
    cwd,
    timeoutMs,
    ...(options?.env ? { env: options.env } : {}),
  });
  if (res.exitCode === 0) {
    const raw = stripGitLineEnding(res.stdout, options?.platform);
    if (raw.length > 0) {
      return path.resolve(raw);
    }
  }
  return cwd;
}

/**
 * Resolve the repository root AND let Git itself resolve any custom/relative Git path
 * environment variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, etc.) in the
 * original launch `cwd` and original environment BEFORE switching to `repoRoot`.
 *
 * - Relative `GIT_INDEX_FILE` is resolved by Git (`rev-parse --git-path index`), matching
 *   native Git's repo-root semantics rather than prematurely resolving against a subdir.
 * - Bare repositories (where `rev-parse --show-toplevel` fails) never receive a synthetic
 *   `GIT_WORK_TREE`, so `git status` fails cleanly just like native Git.
 */
export async function resolveGitRepoContext(
  cwd: string,
  options?: {
    readonly timeoutMs?: number;
    readonly exec?: GitExecFn;
    readonly sourceEnv?: Readonly<Record<string, string | undefined>>;
    readonly platform?: NodeJS.Platform;
  },
): Promise<GitRepoContext> {
  const exec = options?.exec ?? runDefaultGit;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TUI_TIMEOUT_MS;
  const sourceEnv = options?.sourceEnv ?? process.env;
  const platform = options?.platform;
  const customEnvPresent = hasCustomGitPathEnv(sourceEnv);
  const hasIndexEnv =
    typeof sourceEnv['GIT_INDEX_FILE'] === 'string' && sourceEnv['GIT_INDEX_FILE'].length > 0;
  const hasObjectDirEnv =
    typeof sourceEnv['GIT_OBJECT_DIRECTORY'] === 'string' &&
    sourceEnv['GIT_OBJECT_DIRECTORY'].length > 0;
  const hasCommonDirEnv =
    typeof sourceEnv['GIT_COMMON_DIR'] === 'string' && sourceEnv['GIT_COMMON_DIR'].length > 0;

  const probeOpts = { cwd, timeoutMs };
  const [topRes, gitDirRes, indexRes, objDirRes, commonDirRes] = await Promise.all([
    exec(['rev-parse', '--show-toplevel'], probeOpts),
    customEnvPresent
      ? exec(['rev-parse', '--absolute-git-dir'], probeOpts)
      : Promise.resolve<GitExecResult>({ exitCode: 1, stdout: '' }),
    hasIndexEnv
      ? exec(['rev-parse', '--git-path', 'index'], probeOpts)
      : Promise.resolve<GitExecResult>({ exitCode: 1, stdout: '' }),
    hasObjectDirEnv
      ? exec(['rev-parse', '--git-path', 'objects'], probeOpts)
      : Promise.resolve<GitExecResult>({ exitCode: 1, stdout: '' }),
    hasCommonDirEnv
      ? exec(['rev-parse', '--git-common-dir'], probeOpts)
      : Promise.resolve<GitExecResult>({ exitCode: 1, stdout: '' }),
  ]);

  const rawTop = topRes.exitCode === 0 ? stripGitLineEnding(topRes.stdout, platform) : '';
  const hasWorkTree = rawTop.length > 0;
  const repoRoot = hasWorkTree ? path.resolve(rawTop) : cwd;

  if (!customEnvPresent) {
    return { repoRoot };
  }

  const pinnedEnv: Record<string, string> = {};

  const rawGitDir = gitDirRes.exitCode === 0 ? stripGitLineEnding(gitDirRes.stdout, platform) : '';
  if (rawGitDir.length > 0) {
    pinnedEnv['GIT_DIR'] = path.resolve(cwd, rawGitDir);
  } else if (typeof sourceEnv['GIT_DIR'] === 'string' && sourceEnv['GIT_DIR'].length > 0) {
    pinnedEnv['GIT_DIR'] = path.resolve(cwd, sourceEnv['GIT_DIR']);
  }

  // Only pin `GIT_WORK_TREE` when Git actually detected a working tree (never for bare repos).
  if (hasWorkTree) {
    pinnedEnv['GIT_WORK_TREE'] = repoRoot;
  }

  if (hasIndexEnv) {
    const rawIdx = indexRes.exitCode === 0 ? stripGitLineEnding(indexRes.stdout, platform) : '';
    if (rawIdx.length > 0) {
      pinnedEnv['GIT_INDEX_FILE'] = path.resolve(cwd, rawIdx);
    } else {
      pinnedEnv['GIT_INDEX_FILE'] = path.resolve(repoRoot, sourceEnv['GIT_INDEX_FILE']!);
    }
  }

  if (hasObjectDirEnv) {
    const rawObj = objDirRes.exitCode === 0 ? stripGitLineEnding(objDirRes.stdout, platform) : '';
    if (rawObj.length > 0) {
      pinnedEnv['GIT_OBJECT_DIRECTORY'] = path.resolve(cwd, rawObj);
    } else {
      pinnedEnv['GIT_OBJECT_DIRECTORY'] = path.resolve(cwd, sourceEnv['GIT_OBJECT_DIRECTORY']!);
    }
  }

  if (hasCommonDirEnv) {
    const rawCommon =
      commonDirRes.exitCode === 0 ? stripGitLineEnding(commonDirRes.stdout, platform) : '';
    if (rawCommon.length > 0) {
      pinnedEnv['GIT_COMMON_DIR'] = path.resolve(cwd, rawCommon);
    } else {
      pinnedEnv['GIT_COMMON_DIR'] = path.resolve(cwd, sourceEnv['GIT_COMMON_DIR']!);
    }
  }

  const altDirs = sourceEnv['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
  if (typeof altDirs === 'string' && altDirs.length > 0) {
    const effectivePlatform = platform ?? process.platform;
    // Native Git resolves relative `GIT_ALTERNATE_OBJECT_DIRECTORIES` against `repoRoot`
    // when invoked inside the working tree (since Git chdirs to the work-tree root first),
    // and against the original `cwd` when invoked outside the working tree via `GIT_DIR`.
    const altBaseDir =
      hasWorkTree && isPathInsideDir(cwd, repoRoot, effectivePlatform) ? repoRoot : cwd;
    pinnedEnv['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = normalizeGitAlternateObjectDirectories(
      altDirs,
      altBaseDir,
      effectivePlatform,
    );
  }

  return {
    repoRoot,
    ...(Object.keys(pinnedEnv).length > 0 ? { gitEnv: pinnedEnv } : {}),
  };
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
  const { repoRoot, gitEnv } = await resolveGitRepoContext(cwd, { exec, timeoutMs });
  const execOpts = gitEnv ? { cwd: repoRoot, timeoutMs, env: gitEnv } : { cwd: repoRoot, timeoutMs };

  const [statusRes, branchRes, headRes] = await Promise.all([
    exec(['status', '--porcelain=v1', '-z', '-uall'], execOpts),
    exec(['symbolic-ref', '--short', 'HEAD'], execOpts),
    exec(['log', '-1', '--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%P'], execOpts),
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
        ? exec(['diff', '--numstat'], execOpts)
        : Promise.resolve<GitExecResult>({ exitCode: 0, stdout: '' }),
      staged.length > 0
        ? exec(['diff', '--cached', '--numstat'], execOpts)
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
      exec(['show', '--format=', '--name-status', '--root', headMeta.sha], execOpts),
      exec(['show', '--format=', '--numstat', '--root', headMeta.sha], execOpts),
    ]);
    const statsMap = numstatRes.exitCode === 0 ? parseNumstatMap(numstatRes.stdout) : new Map();
    const headFiles =
      nameStatusRes.exitCode === 0
        ? parseCommitNameStatus(nameStatusRes.stdout, statsMap)
        : [];
    headCommit = { ...headMeta, files: headFiles };
  }

  return {
    cwd: repoRoot,
    ...(gitEnv ? { gitEnv } : {}),
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
    readonly gitEnv?: Readonly<Record<string, string>>;
  },
): Promise<GitFileDiffResult> {
  const exec = options?.exec ?? runDefaultGit;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TUI_TIMEOUT_MS;
  const key = gitFileKey(file.area, file.path);
  const contextArg = options?.wholeFile ? '-U99999' : '-U3';

  if (file.area === 'unstaged' && file.kind === 'untracked') {
    const absPath = path.resolve(cwd, file.path);
    try {
      // Use `lstat` so untracked symlinks are previewed as symlink targets (matching Git)
      // instead of dereferencing and reading arbitrary files outside the repository.
      const st = await fs.lstat(absPath);
      if (st.isSymbolicLink()) {
        const linkTarget = await fs.readlink(absPath);
        const targetLines = linkTarget.replace(/\r\n/g, '\n').split('\n');
        const unified = [
          `@@ -0,0 +1,${targetLines.length} @@`,
          ...targetLines.map(l => `+${l}`),
        ].join('\n');
        return {
          fileKey: key,
          filePath: file.path,
          area: file.area,
          kind: 'diff',
          unifiedDiff: unified,
          additions: targetLines.length,
          deletions: 0,
        };
      }
      if (!st.isFile()) {
        return {
          fileKey: key,
          filePath: file.path,
          area: file.area,
          kind: 'empty',
          unifiedDiff: '',
          additions: 0,
          deletions: 0,
          message: 'Untracked non-regular file.',
        };
      }
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
    args = ['--literal-pathspecs', 'diff', '--cached', '--no-color', contextArg, '--', file.path];
  } else if (file.area === 'commit') {
    const rev = options?.headSha || 'HEAD';
    args = [
      '--literal-pathspecs',
      'show',
      '--format=',
      '--no-color',
      '--root',
      contextArg,
      rev,
      '--',
      file.path,
    ];
  } else {
    args = ['--literal-pathspecs', 'diff', '--no-color', contextArg, '--', file.path];
  }

  const res = await exec(args, {
    cwd,
    timeoutMs,
    ...(options?.gitEnv ? { env: options.gitEnv } : {}),
  });
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
  options?: {
    readonly timeoutMs?: number;
    readonly exec?: GitExecFn;
    readonly gitEnv?: Readonly<Record<string, string>>;
  },
): Promise<GitActionResult> {
  const exec = options?.exec ?? runDefaultGit;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TUI_TIMEOUT_MS;
  const args =
    paths === 'all' ? ['add', '-A'] : ['--literal-pathspecs', 'add', '--', ...paths];
  const res = await exec(args, {
    cwd,
    timeoutMs,
    ...(options?.gitEnv ? { env: options.gitEnv } : {}),
  });
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
  options?: {
    readonly timeoutMs?: number;
    readonly exec?: GitExecFn;
    readonly gitEnv?: Readonly<Record<string, string>>;
  },
): Promise<GitActionResult> {
  const exec = options?.exec ?? runDefaultGit;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TUI_TIMEOUT_MS;
  const execOpts = options?.gitEnv ? { cwd, timeoutMs, env: options.gitEnv } : { cwd, timeoutMs };
  // Use `--literal-pathspecs` with raw paths so inherited `GIT_LITERAL_PATHSPECS=1`
  // or glob characters like `[1]` never misinterpret pathspec prefixes or wildcards.
  const args =
    paths === 'all' ? ['reset', 'HEAD'] : ['--literal-pathspecs', 'reset', 'HEAD', '--', ...paths];
  let res = await exec(args, execOpts);
  if (res.exitCode !== 0 && /ambiguous argument 'HEAD'|unknown revision/i.test(res.stderr ?? '')) {
    const rmArgs =
      paths === 'all'
        ? ['rm', '--cached', '-r', '.']
        : ['--literal-pathspecs', 'rm', '--cached', '--', ...paths];
    res = await exec(rmArgs, execOpts);
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
  options?: {
    readonly timeoutMs?: number;
    readonly exec?: GitExecFn;
    readonly gitEnv?: Readonly<Record<string, string>>;
  },
): Promise<GitActionResult> {
  const exec = options?.exec ?? runDefaultGit;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TUI_TIMEOUT_MS;
  const summary = params.summary.trim();
  const body = params.body?.trim() ?? '';

  if (!summary && !params.amend) {
    return { ok: false, message: 'Write a summary line first' };
  }

  if (params.stageAllIfEmpty) {
    const stageRes = await stageGitFiles(cwd, 'all', {
      timeoutMs,
      exec,
      ...(options?.gitEnv ? { gitEnv: options.gitEnv } : {}),
    });
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

  const res = await exec(args, {
    cwd,
    timeoutMs,
    ...(options?.gitEnv ? { env: options.gitEnv } : {}),
  });
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
