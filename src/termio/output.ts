import type { TermOutput } from '@stencil-hq/tern';

/**
 * Underlying writable stream interface accepted by {@link SafeTermOutput}.
 * Compatible with `process.stdout`, `TermOutput`, and in-memory test fakes.
 */
export interface RawTermTarget {
  write(data: Uint8Array | string): unknown;
  readonly isTTY?: boolean;
  readonly columns?: number;
}

const STREAM_CLOSED_CODES = new Set([
  'EPIPE',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
  'EBADF',
]);

function isClosedStreamError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && STREAM_CLOSED_CODES.has(code);
}

const HIDE_CURSOR_SEQ = '\x1b[?25l';
const SHOW_CURSOR_SEQ = '\x1b[?25h';
const DEFAULT_REASSERT_MIN_INTERVAL_MS = 200;

export interface SafeTermOutputOptions {
  readonly now?: () => number;
}

/**
 * Atomic, close-guarded {@link TermOutput} wrapper around a TTY output stream.
 *
 * Ensures that TSP APC frames and OSC 7501 / OSC 1337 / OSC 7 control sequences
 * are always submitted in a single `.write()` call without interleaving, tracks
 * DECTCEM cursor-hidden guard state for Windows ConPTY re-assertion, and
 * silently drops any dangling writes once {@link close} has been invoked
 * (typically right after `session.close()`).
 */
export class SafeTermOutput implements TermOutput {
  readonly #target: RawTermTarget;
  readonly #now: () => number;
  #closed = false;
  #cursorHiddenDesired = false;
  #lastCursorHideAt = -Infinity;

  constructor(target: RawTermTarget = process.stdout, options: SafeTermOutputOptions = {}) {
    this.#target = target;
    this.#now = options.now ?? (() => Date.now());
  }

  get isTTY(): boolean | undefined {
    return this.#target.isTTY;
  }

  get columns(): number | undefined {
    return this.#target.columns;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Whether DECTCEM native cursor suppression is currently armed. */
  get cursorHidden(): boolean {
    return this.#cursorHiddenDesired;
  }

  /**
   * Atomically writes a complete chunk (`Uint8Array` or `string`) to the
   * underlying stream in one `.write()` call.
   *
   * Returns `true` if written (or empty no-op while open), `false` if dropped
   * because the output is closed or the underlying stream has already ended.
   */
  write(data: Uint8Array | string): boolean {
    if (this.#closed) return false;
    if (typeof data === 'string' ? data.length === 0 : data.byteLength === 0) {
      return true;
    }
    try {
      this.#target.write(data);
      return true;
    } catch (err) {
      if (isClosedStreamError(err)) {
        this.#closed = true;
        return false;
      }
      throw err;
    }
  }

  /**
   * Concatenates string fragments into a single string and submits them
   * atomically in one `.write()` call.
   */
  writeAtomic(...chunks: readonly string[]): boolean {
    if (this.#closed || chunks.length === 0) return !this.#closed;
    const payload = chunks.length === 1 ? chunks[0]! : chunks.join('');
    return this.write(payload);
  }

  /**
   * Arms or disarms the DECTCEM native cursor guard and immediately writes
   * `\x1b[?25l` (`hidden === true`) or `\x1b[?25h` (`hidden === false`).
   */
  setCursorHidden(hidden: boolean): boolean {
    this.#cursorHiddenDesired = hidden;
    if (hidden) {
      this.#lastCursorHideAt = this.#now();
      return this.write(HIDE_CURSOR_SEQ);
    }
    return this.write(SHOW_CURSOR_SEQ);
  }

  /**
   * Re-emits `\x1b[?25l` while the cursor-hidden guard is armed (e.g. right after
   * `surface.open()`, first render/focus, Windows ConPTY `resize`, or `settle`)
   * with lightweight throttling so ConPTY DECTCEM resets never leave an orphan
   * native terminal bar cursor behind.
   */
  reassertCursorHidden(
    options: { readonly force?: boolean; readonly minIntervalMs?: number } = {},
  ): boolean {
    if (this.#closed || !this.#cursorHiddenDesired) return false;
    const now = this.#now();
    const minInterval = options.minIntervalMs ?? DEFAULT_REASSERT_MIN_INTERVAL_MS;
    if (!options.force && now - this.#lastCursorHideAt < minInterval) {
      return false;
    }
    this.#lastCursorHideAt = now;
    return this.write(HIDE_CURSOR_SEQ);
  }

  /**
   * Arms the close guard so all subsequent writes are silently discarded.
   * Does not end or destroy the underlying stream (e.g. `process.stdout`).
   */
  close(): void {
    this.#cursorHiddenDesired = false;
    this.#closed = true;
  }
}
