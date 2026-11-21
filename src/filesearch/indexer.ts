import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface IndexedFile {
  /** POSIX-style relative path from workspace root (e.g. `src/termio/osc.ts`). */
  readonly relPath: string;
  /** Absolute native OS path for reading file content / building `file://` URIs. */
  readonly absPath: string;
  /** Basename of the file (e.g. `osc.ts`). */
  readonly name: string;
  /** Relative POSIX parent directory (e.g. `src/termio` or `""` for root files). */
  readonly dir: string;
}

export interface FileSearchMatch {
  readonly file: IndexedFile;
  readonly score: number;
  /** UTF-16 `[start, end)` highlight spans within `file.relPath`. */
  readonly hits: readonly (readonly [number, number])[];
}

export interface FileIndexerOptions {
  /** Directory names to ignore anywhere in the tree. Defaults to {@link DEFAULT_IGNORED_DIRS}. */
  readonly ignoreDirs?: ReadonlySet<string> | readonly string[];
  /** Additional directory names appended to the default ignore list. */
  readonly extraIgnoreDirs?: readonly string[];
  /** File names to ignore (e.g. `.DS_Store`). Defaults to {@link DEFAULT_IGNORED_FILES}. */
  readonly ignoreFiles?: ReadonlySet<string> | readonly string[];
  /** Include dotfiles / dot-directories other than explicitly ignored ones. Default `true`. */
  readonly includeHidden?: boolean;
  /** Maximum number of files to index before truncating. Default `20_000`. */
  readonly maxFiles?: number;
  /** Maximum directory traversal depth. Default `16`. */
  readonly maxDepth?: number;
  /** Maximum concurrent `readdir` operations. Default `16`. */
  readonly concurrency?: number;
}

export type IndexerStatus = 'idle' | 'scanning' | 'ready' | 'error';

export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'vendor',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.idea',
  '.vscode',
]);

export const DEFAULT_IGNORED_FILES: ReadonlySet<string> = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
]);

function isWordBoundary(text: string, index: number): boolean {
  if (index <= 0) return true;
  const prev = text.charCodeAt(index - 1);
  // '/', '-', '_', '.', ' '
  if (prev === 47 || prev === 45 || prev === 95 || prev === 46 || prev === 32) {
    return true;
  }
  const curr = text.charCodeAt(index);
  // camelCase boundary: lowercase followed by uppercase
  const prevIsLower = prev >= 97 && prev <= 122;
  const currIsUpper = curr >= 65 && curr <= 90;
  return prevIsLower && currIsUpper;
}

function mergeContiguousIndices(indices: readonly number[]): [number, number][] {
  if (indices.length === 0) return [];
  const spans: [number, number][] = [];
  let start = indices[0]!;
  let end = start + 1;
  for (let i = 1; i < indices.length; i++) {
    const idx = indices[i]!;
    if (idx === end) {
      end = idx + 1;
    } else {
      spans.push([start, end]);
      start = idx;
      end = idx + 1;
    }
  }
  spans.push([start, end]);
  return spans;
}

interface SubsequenceEval {
  readonly score: number;
  readonly indices: number[];
}

/**
 * Evaluates a subsequence match of `queryLower` within `target` starting from
 * `searchFrom` (e.g. either `0` for full path or `baseOffset` for filename).
 */
function scoreSubsequence(
  query: string,
  queryLower: string,
  target: string,
  targetLower: string,
  searchFrom: number,
  baseOffset: number,
): SubsequenceEval | null {
  const qLen = queryLower.length;
  const tLen = targetLower.length;
  if (qLen === 0) return { score: 0, indices: [] };
  if (tLen - searchFrom < qLen) return null;

  // Quick forward feasibility scan
  let probe = searchFrom;
  for (let qi = 0; qi < qLen; qi++) {
    const found = targetLower.indexOf(queryLower[qi]!, probe);
    if (found === -1) return null;
    probe = found + 1;
  }

  // Greedy preference for boundary/consecutive matches using DP over (qi, ti)
  // For typical file paths (< 256 chars) and queries (< 64 chars), DP is fast and exact.
  const spanLen = tLen - searchFrom;
  if (qLen <= 64 && spanLen <= 256) {
    const NEG_INF = -1e9;
    // dp[qi][ti] = best score matching query[0..qi] with query[qi] placed at searchFrom + ti
    const cols = spanLen;
    const prevRow = new Float64Array(cols);
    const currRow = new Float64Array(cols);
    const backPtr = new Int16Array(qLen * cols);
    backPtr.fill(-1);

    for (let ti = 0; ti < cols; ti++) {
      const pos = searchFrom + ti;
      if (targetLower.charCodeAt(pos) === queryLower.charCodeAt(0)) {
        let s = 10;
        if (target.charCodeAt(pos) === query.charCodeAt(0)) s += 1;
        if (pos === baseOffset) s += 20;
        else if (isWordBoundary(target, pos)) s += 12;
        if (pos >= baseOffset) s += 8;
        s -= (pos - searchFrom) * 0.25;
        prevRow[ti] = s;
      } else {
        prevRow[ti] = NEG_INF;
      }
    }

    for (let qi = 1; qi < qLen; qi++) {
      currRow.fill(NEG_INF);
      let bestPrevScore = NEG_INF;
      let bestPrevTi = -1;

      for (let ti = 0; ti < cols; ti++) {
        const pos = searchFrom + ti;
        if (ti > 0 && prevRow[ti - 1]! > bestPrevScore) {
          bestPrevScore = prevRow[ti - 1]!;
          bestPrevTi = ti - 1;
        }

        if (targetLower.charCodeAt(pos) !== queryLower.charCodeAt(qi)) {
          continue;
        }

        let charBonus = 10;
        if (target.charCodeAt(pos) === query.charCodeAt(qi)) charBonus += 1;
        if (pos === baseOffset) charBonus += 18;
        else if (isWordBoundary(target, pos)) charBonus += 12;
        if (pos >= baseOffset) charBonus += 6;

        // Option 1: consecutive match from ti - 1
        let bestHere = NEG_INF;
        let chosenPrev = -1;
        if (ti > 0 && prevRow[ti - 1]! > NEG_INF / 2) {
          const consec = prevRow[ti - 1]! + charBonus + 18;
          if (consec > bestHere) {
            bestHere = consec;
            chosenPrev = ti - 1;
          }
        }

        // Option 2: best earlier non-consecutive position (with gap penalty)
        if (bestPrevTi !== -1 && bestPrevScore > NEG_INF / 2) {
          const gap = ti - bestPrevTi - 1;
          const nonConsec = bestPrevScore + charBonus - gap * 0.6;
          if (nonConsec > bestHere) {
            bestHere = nonConsec;
            chosenPrev = bestPrevTi;
          }
        }

        currRow[ti] = bestHere;
        backPtr[qi * cols + ti] = chosenPrev;
      }

      prevRow.set(currRow);
    }

    let bestEndScore = NEG_INF;
    let bestEndTi = -1;
    for (let ti = 0; ti < cols; ti++) {
      if (prevRow[ti]! > bestEndScore) {
        bestEndScore = prevRow[ti]!;
        bestEndTi = ti;
      }
    }

    if (bestEndTi === -1 || bestEndScore <= NEG_INF / 2) return null;

    const indices = new Array<number>(qLen);
    let cursorTi = bestEndTi;
    for (let qi = qLen - 1; qi >= 0; qi--) {
      indices[qi] = searchFrom + cursorTi;
      cursorTi = backPtr[qi * cols + cursorTi]!;
    }

    return { score: bestEndScore, indices };
  }

  // Greedy fallback for very long paths/queries
  const indices: number[] = [];
  let score = 0;
  let pos = searchFrom;
  let prevMatch = -2;
  for (let qi = 0; qi < qLen; qi++) {
    const found = targetLower.indexOf(queryLower[qi]!, pos);
    if (found === -1) return null;
    indices.push(found);
    score += 10;
    if (found === prevMatch + 1) score += 15;
    if (isWordBoundary(target, found)) score += 10;
    if (found >= baseOffset) score += 6;
    prevMatch = found;
    pos = found + 1;
  }
  return { score, indices };
}

/**
 * Computes fuzzy match score and highlight spans for a single indexed file.
 * Returns `null` if the file does not match `rawQuery`.
 */
export function fuzzyMatchFile(rawQuery: string, file: IndexedFile): FileSearchMatch | null {
  const query = rawQuery.trim().replace(/\\/g, '/');
  if (query.length === 0) {
    // Prefer shallower, shorter paths when query is empty
    const depth = file.dir.length === 0 ? 0 : file.dir.split('/').length;
    return {
      file,
      score: Math.max(0, 100 - depth * 5 - file.relPath.length * 0.05),
      hits: [],
    };
  }

  const queryLower = query.toLowerCase();
  const relPath = file.relPath;
  const relLower = relPath.toLowerCase();
  const baseOffset = relPath.length - file.name.length;
  const nameLower = file.name.toLowerCase();

  let best: SubsequenceEval | null = null;

  // Prefer matching directly against the filename when query has no path separator
  if (!queryLower.includes('/')) {
    const nameEval = scoreSubsequence(query, queryLower, relPath, relLower, baseOffset, baseOffset);
    if (nameEval) {
      let bonus = 35;
      if (nameLower === queryLower) bonus += 120;
      else if (nameLower.startsWith(queryLower)) bonus += 60;
      else if (nameLower.includes(queryLower)) bonus += 25;
      best = { score: nameEval.score + bonus, indices: nameEval.indices };
    }
  }

  const pathEval = scoreSubsequence(query, queryLower, relPath, relLower, 0, baseOffset);
  if (pathEval) {
    let bonus = 0;
    if (relLower === queryLower) bonus += 150;
    else if (relLower.startsWith(queryLower)) bonus += 40;
    else if (relLower.includes(queryLower)) bonus += 15;
    const candidate: SubsequenceEval = {
      score: pathEval.score + bonus,
      indices: pathEval.indices,
    };
    if (!best || candidate.score > best.score) {
      best = candidate;
    }
  }

  if (!best) return null;

  // Small tie-breaking penalty for longer paths so concise matches rise to the top
  const finalScore = best.score - relPath.length * 0.15;
  return {
    file,
    score: finalScore,
    hits: mergeContiguousIndices(best.indices),
  };
}

/**
 * Filters and ranks an array of indexed files by fuzzy match score.
 */
export function searchIndexedFiles(
  files: readonly IndexedFile[],
  query: string,
  limit = 20,
): FileSearchMatch[] {
  if (limit <= 0) return [];
  const matches: FileSearchMatch[] = [];
  for (const file of files) {
    const match = fuzzyMatchFile(query, file);
    if (match) matches.push(match);
  }
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.file.relPath.localeCompare(b.file.relPath);
  });
  return matches.length > limit ? matches.slice(0, limit) : matches;
}

/**
 * Asynchronous workspace file scanner with fuzzy search and ranking for `@file` completion.
 */
export class WorkspaceFileIndexer {
  readonly cwd: string;
  readonly #ignoreDirs: ReadonlySet<string>;
  readonly #ignoreFiles: ReadonlySet<string>;
  readonly #includeHidden: boolean;
  readonly #maxFiles: number;
  readonly #maxDepth: number;
  readonly #concurrency: number;

  #files: IndexedFile[] = [];
  #status: IndexerStatus = 'idle';
  #truncated = false;
  #lastError: Error | undefined;
  #inFlight: Promise<readonly IndexedFile[]> | null = null;
  #abortController: AbortController | null = null;

  constructor(cwd: string, options: FileIndexerOptions = {}) {
    this.cwd = resolve(cwd);
    const baseIgnoreDirs = options.ignoreDirs
      ? new Set(options.ignoreDirs)
      : new Set(DEFAULT_IGNORED_DIRS);
    if (options.extraIgnoreDirs) {
      for (const d of options.extraIgnoreDirs) baseIgnoreDirs.add(d);
    }
    this.#ignoreDirs = baseIgnoreDirs;
    this.#ignoreFiles = options.ignoreFiles
      ? new Set(options.ignoreFiles)
      : DEFAULT_IGNORED_FILES;
    this.#includeHidden = options.includeHidden ?? true;
    this.#maxFiles = Math.max(1, options.maxFiles ?? 20_000);
    this.#maxDepth = Math.max(0, options.maxDepth ?? 16);
    this.#concurrency = Math.max(1, options.concurrency ?? 16);
  }

  get files(): readonly IndexedFile[] {
    return this.#files;
  }

  get status(): IndexerStatus {
    return this.#status;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  get lastError(): Error | undefined {
    return this.#lastError;
  }

  /**
   * Starts scanning if not yet scanned, or returns the in-flight / cached scan result.
   */
  start(): Promise<readonly IndexedFile[]> {
    if (this.#status === 'ready') {
      return Promise.resolve(this.#files);
    }
    if (this.#inFlight) {
      return this.#inFlight;
    }
    return this.refresh();
  }

  /**
   * Cancels any active scan and performs a fresh asynchronous scan of `cwd`.
   */
  refresh(): Promise<readonly IndexedFile[]> {
    this.#abortController?.abort();
    const controller = new AbortController();
    this.#abortController = controller;
    this.#status = 'scanning';
    this.#truncated = false;
    this.#lastError = undefined;

    const task = this.#scan(controller.signal).then(
      (scanned) => {
        if (!controller.signal.aborted) {
          scanned.sort((a, b) => a.relPath.localeCompare(b.relPath));
          this.#files = scanned;
          this.#status = 'ready';
        }
        if (this.#inFlight === task) {
          this.#inFlight = null;
        }
        return this.#files;
      },
      (err) => {
        if (!controller.signal.aborted) {
          this.#lastError = err instanceof Error ? err : new Error(String(err));
          this.#status = 'error';
        }
        if (this.#inFlight === task) {
          this.#inFlight = null;
        }
        return this.#files;
      },
    );

    this.#inFlight = task;
    return task;
  }

  /**
   * Aborts any ongoing directory scan.
   */
  dispose(): void {
    this.#abortController?.abort();
    this.#abortController = null;
    this.#inFlight = null;
  }

  /**
   * Synchronously searches the currently indexed file snapshot.
   */
  search(query: string, limit = 20): FileSearchMatch[] {
    return searchIndexedFiles(this.#files, query, limit);
  }

  /**
   * Ensures at least one scan completes before searching.
   */
  async searchAsync(query: string, limit = 20): Promise<FileSearchMatch[]> {
    await this.start();
    return this.search(query, limit);
  }

  async #scan(signal: AbortSignal): Promise<IndexedFile[]> {
    const collected: IndexedFile[] = [];
    const queue: Array<{ absDir: string; relDir: string; depth: number }> = [
      { absDir: this.cwd, relDir: '', depth: 0 },
    ];

    let active = 0;
    let queueHead = 0;

    await new Promise<void>((resolveDone) => {
      const pump = (): void => {
        if (signal.aborted) {
          if (active === 0) resolveDone();
          return;
        }

        while (
          active < this.#concurrency &&
          queueHead < queue.length &&
          collected.length < this.#maxFiles
        ) {
          const item = queue[queueHead++]!;
          active += 1;

          void this.#visitDir(item.absDir, item.relDir, item.depth, collected, queue, signal).finally(
            () => {
              active -= 1;
              if (
                signal.aborted ||
                collected.length >= this.#maxFiles ||
                (queueHead >= queue.length && active === 0)
              ) {
                if (active === 0) resolveDone();
              } else {
                pump();
              }
            },
          );
        }

        if (active === 0) {
          resolveDone();
        }
      };

      pump();
    });

    return collected;
  }

  async #visitDir(
    absDir: string,
    relDir: string,
    depth: number,
    collected: IndexedFile[],
    queue: Array<{ absDir: string; relDir: string; depth: number }>,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted || collected.length >= this.#maxFiles) return;

    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (signal.aborted) return;
      const name = entry.name;
      if (!this.#includeHidden && name.startsWith('.')) continue;

      // Never follow symlinked directories to avoid infinite loops
      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (this.#ignoreDirs.has(name)) continue;
        if (depth >= this.#maxDepth) continue;
        const nextRel = relDir.length === 0 ? name : `${relDir}/${name}`;
        queue.push({
          absDir: join(absDir, name),
          relDir: nextRel,
          depth: depth + 1,
        });
        continue;
      }

      if (entry.isFile()) {
        if (this.#ignoreFiles.has(name)) continue;
        if (collected.length >= this.#maxFiles) {
          this.#truncated = true;
          return;
        }
        const relPath = relDir.length === 0 ? name : `${relDir}/${name}`;
        collected.push({
          relPath,
          absPath: join(absDir, name),
          name,
          dir: relDir,
        });
      }
    }
  }
}
