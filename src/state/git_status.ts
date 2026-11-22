/**
 * Lightweight asynchronous Git branch & dirty-state prober for `oma`.
 *
 * Uses `git status --porcelain=v2 --branch` with `GIT_OPTIONAL_LOCKS=0`
 * and a strict timeout fallback so non-Git directories, missing `git`
 * binaries, errors, or slow repositories safely return `null`.
 */

import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface GitStatusSnapshot {
  readonly branch: string;
  readonly detached: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly staged: number;
  readonly unstaged: number;
  readonly untracked: number;
  readonly isDirty: boolean;
}

export interface GitExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
}

export type GitExecFn = (
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly timeoutMs: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
) => Promise<GitExecResult>;

export interface ProbeGitStatusOptions {
  /** Maximum time in milliseconds before aborting and returning `null`. Default: 1500. */
  readonly timeoutMs?: number;
  /** Optional command executor override for offline unit tests. */
  readonly exec?: GitExecFn;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GIT_TIMEOUT_MS = 1_500;
const GIT_STATUS_ARGS = ['status', '--porcelain=v2', '--branch'] as const;

// ---------------------------------------------------------------------------
// Pure Porcelain v2 Parser
// ---------------------------------------------------------------------------

/**
 * Parse output of `git status --porcelain=v2 --branch` into a `GitStatusSnapshot`.
 * Returns `null` if the output lacks valid branch header lines.
 */
export function parseGitPorcelainV2(stdout: string): GitStatusSnapshot | null {
  if (!stdout || typeof stdout !== 'string') return null;

  let branchHead: string | null = null;
  let branchOid: string | null = null;
  let ahead = 0;
  let behind = 0;
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  const lines = stdout.split(/\r?\n/);
  for (const rawLine of lines) {
    if (!rawLine) continue;

    if (rawLine.startsWith('# branch.head ')) {
      branchHead = rawLine.slice('# branch.head '.length).trim();
      continue;
    }

    if (rawLine.startsWith('# branch.oid ')) {
      branchOid = rawLine.slice('# branch.oid '.length).trim();
      continue;
    }

    if (rawLine.startsWith('# branch.ab ')) {
      const abMatch = /^\+(\d+)\s+-(\d+)$/.exec(rawLine.slice('# branch.ab '.length).trim());
      if (abMatch) {
        ahead = Number.parseInt(abMatch[1]!, 10) || 0;
        behind = Number.parseInt(abMatch[2]!, 10) || 0;
      }
      continue;
    }

    if (rawLine.startsWith('# ')) {
      continue;
    }

    // Ordinary changed entry (`1 XY ...`) or renamed/copied entry (`2 XY ...`)
    if ((rawLine.startsWith('1 ') || rawLine.startsWith('2 ')) && rawLine.length >= 4) {
      const x = rawLine[2];
      const y = rawLine[3];
      if (x && x !== '.' && x !== ' ') {
        staged += 1;
      }
      if (y && y !== '.' && y !== ' ') {
        unstaged += 1;
      }
      continue;
    }

    // Unmerged entry (`u XY ...`): count as unstaged conflict change
    if (rawLine.startsWith('u ') && rawLine.length >= 4) {
      unstaged += 1;
      continue;
    }

    // Untracked entry (`? <path>`)
    if (rawLine.startsWith('? ')) {
      untracked += 1;
      continue;
    }

    // Ignored entry (`! <path>`) does not affect dirty state
  }

  if (branchHead === null) {
    return null;
  }

  let detached = false;
  let branch = branchHead;

  if (branchHead === '(detached)') {
    detached = true;
    if (branchOid && branchOid !== '(initial)' && /^[0-9a-fA-F]{7,}$/.test(branchOid)) {
      branch = branchOid.slice(0, 7);
    } else {
      branch = 'HEAD';
    }
  } else if (branch.length === 0) {
    return null;
  }

  const isDirty = staged > 0 || unstaged > 0 || untracked > 0;

  return {
    branch,
    detached,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    isDirty,
  };
}

/**
 * Value equality check for `GitStatusSnapshot` so `AppStore` can skip redundant `emit()`.
 */
export function areGitStatusEqual(
  a: GitStatusSnapshot | null,
  b: GitStatusSnapshot | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.branch === b.branch &&
    a.detached === b.detached &&
    a.ahead === b.ahead &&
    a.behind === b.behind &&
    a.staged === b.staged &&
    a.unstaged === b.unstaged &&
    a.untracked === b.untracked &&
    a.isDirty === b.isDirty
  );
}

// ---------------------------------------------------------------------------
// Default Subprocess Executor & Prober
// ---------------------------------------------------------------------------

const defaultGitExec: GitExecFn = (args, options) => {
  return new Promise<GitExecResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const finish = (result: GitExecResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(result);
    };

    let child;
    try {
      child = spawn('git', [...args], {
        cwd: options.cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: '0',
        },
      });
    } catch (err) {
      finish({
        exitCode: -1,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore kill failures
      }
      finish({ exitCode: -1, stdout: '', stderr: 'git status timed out' });
    }, options.timeoutMs);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    child.on('error', (err) => {
      finish({
        exitCode: -1,
        stdout: '',
        stderr: err.message,
      });
    });

    child.on('close', (code) => {
      finish({
        exitCode: typeof code === 'number' ? code : -1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
};

/**
 * Probe Git branch and working-tree status for `cwd`.
 * Safely returns `null` for non-Git directories, command errors, or timeouts.
 */
export async function probeGitStatus(
  cwd: string,
  options: ProbeGitStatusOptions = {},
): Promise<GitStatusSnapshot | null> {
  const normalizedCwd = cwd.trim();
  if (normalizedCwd.length === 0) return null;

  const rawTimeout = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const timeoutMs =
    Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.floor(rawTimeout)
      : DEFAULT_GIT_TIMEOUT_MS;

  const execFn = options.exec ?? defaultGitExec;

  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  try {
    const execPromise = Promise.resolve(execFn(GIT_STATUS_ARGS, { cwd: normalizedCwd, timeoutMs }));
    const timeoutPromise = new Promise<null>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
      if (typeof timeoutHandle.unref === 'function') {
        timeoutHandle.unref();
      }
    });

    const result = await Promise.race([execPromise, timeoutPromise]);
    if (!result || result.exitCode !== 0) {
      return null;
    }

    return parseGitPorcelainV2(result.stdout);
  } catch {
    return null;
  } finally {
    if (timeoutHandle !== null) {
      clearTimeout(timeoutHandle);
    }
  }
}
