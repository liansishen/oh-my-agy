import { hostname as osHostname } from 'node:os';
import type { TermOutput } from '@stencil-hq/tern';

const ESC = '\x1b';
const ST = '\x1b\\';
const BEL = '\x07';

/** DECTCEM sequence to hide the native terminal cursor (`ESC [ ? 25 l`). */
export const HIDE_CURSOR = '\x1b[?25l';
/** DECTCEM sequence to restore the native terminal cursor (`ESC [ ? 25 h`). */
export const SHOW_CURSOR = '\x1b[?25h';

export type OscBlockedKind = 'permission' | 'question' | 'auth' | (string & {});

export type Osc7501Status =
  | { readonly state: 'idle' }
  | { readonly state: 'working' }
  | { readonly state: 'blocked'; readonly kind: OscBlockedKind }
  | { readonly state: 'done' }
  | { readonly state: 'error' }
  | { readonly state: 'clear' };

/**
 * Strips control characters and OSC 7501 delimiter characters (`:` / `;`) from
 * field values so malformed tokens cannot corrupt the sequence.
 */
function sanitizeOscToken(value: string): string {
  return value.replace(/[\x00-\x1f\x7f:;]/g, '').trim();
}

/**
 * Encodes an OSC 7501 agent status sequence terminated by ST (`ESC \`).
 *
 * Key-value pairs are strictly separated by colons (`:`), e.g.
 * `\x1b]7501;state=blocked:kind=permission\x1b\\`.
 */
export function encodeOsc7501(status: Osc7501Status): string {
  switch (status.state) {
    case 'idle':
      return `${ESC}]7501;state=idle${ST}`;
    case 'working':
      return `${ESC}]7501;state=working${ST}`;
    case 'blocked': {
      const kind = sanitizeOscToken(status.kind) || 'permission';
      return `${ESC}]7501;state=blocked:kind=${kind}${ST}`;
    }
    case 'done':
      return `${ESC}]7501;state=done${ST}`;
    case 'error':
      return `${ESC}]7501;state=error${ST}`;
    case 'clear':
      return `${ESC}]7501;state=clear${ST}`;
  }
}

export function encodeOsc7501Idle(): string {
  return encodeOsc7501({ state: 'idle' });
}

export function encodeOsc7501Working(): string {
  return encodeOsc7501({ state: 'working' });
}

export function encodeOsc7501Blocked(kind: OscBlockedKind = 'permission'): string {
  return encodeOsc7501({ state: 'blocked', kind });
}

export function encodeOsc7501Done(): string {
  return encodeOsc7501({ state: 'done' });
}

export function encodeOsc7501Error(): string {
  return encodeOsc7501({ state: 'error' });
}

export function encodeOsc7501Clear(): string {
  return encodeOsc7501({ state: 'clear' });
}

/**
 * Encodes an iTerm2 / Tern `OSC 1337 SetUserVar` sequence terminated by BEL (`\x07`).
 * Passing an empty `value` clears the variable (`name=`).
 */
export function encodeOsc1337UserVar(name: string, value: string): string {
  const safeName = name.replace(/[^A-Za-z0-9_.-]/g, '');
  const encoded = value.length === 0 ? '' : Buffer.from(value, 'utf8').toString('base64');
  return `${ESC}]1337;SetUserVar=${safeName}=${encoded}${BEL}`;
}

/**
 * Encodes both reopen anchor user variables (`omp_restore=1` and
 * `omp_session_file=<indexFile>`) as a single atomic payload.
 */
export function encodeReopenAnchor(indexFile: string): string {
  return (
    encodeOsc1337UserVar('omp_restore', '1') +
    encodeOsc1337UserVar('omp_session_file', indexFile)
  );
}

/**
 * Encodes the clearing sequences for `omp_restore` and `omp_session_file`
 * emitted before a clean user-initiated exit.
 */
export function encodeClearReopenAnchor(): string {
  return (
    encodeOsc1337UserVar('omp_restore', '') +
    encodeOsc1337UserVar('omp_session_file', '')
  );
}

/**
 * Encodes a local directory path as a RFC 8089 `file://` URI path component.
 */
function encodePathForOsc7(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, '/');
  // Strip duplicate leading slash before Windows drive letter if already present
  if (/^\/[A-Za-z]:\//.test(normalized)) {
    normalized = normalized.slice(1);
  }
  const isWindowsDrive = /^[A-Za-z]:(?:\/|$)/.test(normalized);
  const segments = normalized.split('/');
  const encodedSegments = segments.map((seg, idx) => {
    if (idx === 0 && isWindowsDrive) {
      return seg; // Preserve drive letter & colon like `D:`
    }
    return encodeURIComponent(seg);
  });
  const joined = encodedSegments.join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

/**
 * Encodes an OSC 7 working directory notification (`ESC ] 7 ; file://host/path ST`).
 */
export function encodeOsc7(cwd: string, host?: string): string {
  const resolvedHost = encodeURIComponent(host ?? osHostname());
  const encodedPath = encodePathForOsc7(cwd);
  return `${ESC}]7;file://${resolvedHost}${encodedPath}${ST}`;
}

/**
 * Strips C0/DEL/C1 control characters from terminal title strings to prevent
 * OSC/CSI sequence injection.
 */
function sanitizeOscTitle(title: string): string {
  return title.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
}

/**
 * Encodes an OSC 2 window/pane title sequence (`ESC ] 2 ; <title> ST`).
 */
export function encodeOscTitle(title: string): string {
  const safe = sanitizeOscTitle(title);
  return `${ESC}]2;${safe}${ST}`;
}

/**
 * Atomically encodes an OSC 2 window/pane title immediately followed by
 * DECTCEM cursor hide (`ESC [ ? 25 l`), matching Tern's native `omp` startup sequence.
 */
export function encodeTitleAndHideCursor(title: string): string {
  return `${encodeOscTitle(title)}${HIDE_CURSOR}`;
}

const DEFAULT_CURSOR_REASSERT_MIN_INTERVAL_MS = 200;

export interface OscWriterOptions {
  /** Enable OSC 7501 status reporting. Default `true`. */
  readonly osc7501?: boolean;
  /** Enable OSC 1337 reopen anchor reporting. Default `true`. */
  readonly reopenAnchor?: boolean;
  /** Enable OSC 7 working directory reporting. Default `true`. */
  readonly osc7?: boolean;
  /** Override hostname embedded in OSC 7 `file://` URIs. */
  readonly hostname?: string;
  /** Clock provider used to throttle `reassertCursorHidden()`. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * High-level emitter for OSC 7501, OSC 1337 SetUserVar, OSC 7, OSC 2, and
 * DECTCEM cursor-suppression sequences over a {@link TermOutput} (typically {@link SafeTermOutput}).
 */
export class OscWriter {
  readonly #output: TermOutput;
  readonly #osc7501: boolean;
  readonly #reopenAnchor: boolean;
  readonly #osc7: boolean;
  readonly #hostname: string | undefined;
  readonly #now: () => number;
  #cursorHiddenDesired = false;
  #lastCursorHideAt = -Infinity;

  constructor(output: TermOutput, options: OscWriterOptions = {}) {
    this.#output = output;
    this.#osc7501 = options.osc7501 ?? true;
    this.#reopenAnchor = options.reopenAnchor ?? true;
    this.#osc7 = options.osc7 ?? true;
    this.#hostname = options.hostname;
    this.#now = options.now ?? (() => Date.now());
  }

  /** Whether native terminal cursor suppression (`\x1b[?25l`) is currently armed. */
  get cursorHidden(): boolean {
    return this.#cursorHiddenDesired;
  }

  #emit(sequence: string): boolean {
    const result = this.#output.write(sequence);
    return result !== false;
  }

  setStatus(status: Osc7501Status): boolean {
    if (!this.#osc7501) return false;
    return this.#emit(encodeOsc7501(status));
  }

  setStatusIdle(): boolean {
    return this.setStatus({ state: 'idle' });
  }

  setStatusWorking(): boolean {
    return this.setStatus({ state: 'working' });
  }

  setStatusBlocked(kind: OscBlockedKind = 'permission'): boolean {
    return this.setStatus({ state: 'blocked', kind });
  }

  setStatusDone(): boolean {
    return this.setStatus({ state: 'done' });
  }

  setStatusError(): boolean {
    return this.setStatus({ state: 'error' });
  }

  setStatusClear(): boolean {
    return this.setStatus({ state: 'clear' });
  }

  setReopenAnchor(indexFile: string): boolean {
    if (!this.#reopenAnchor || indexFile.length === 0) return false;
    return this.#emit(encodeReopenAnchor(indexFile));
  }

  clearReopenAnchor(): boolean {
    if (!this.#reopenAnchor) return false;
    return this.#emit(encodeClearReopenAnchor());
  }

  setWorkingDirectory(cwd: string): boolean {
    if (!this.#osc7 || cwd.length === 0) return false;
    return this.#emit(encodeOsc7(cwd, this.#hostname));
  }

  /**
   * Hides the native terminal cursor (DECTCEM) and arms the cursor-hidden guard.
   * Always enabled regardless of `osc7501` / `reopenAnchor` / `osc7` feature toggles.
   */
  hideCursor(): boolean {
    this.#cursorHiddenDesired = true;
    this.#lastCursorHideAt = this.#now();
    return this.#emit(HIDE_CURSOR);
  }

  /**
   * Re-asserts DECTCEM cursor suppression (`\x1b[?25l`) only while {@link cursorHidden}
   * is armed (e.g. immediately after `surface.open()`, first render/focus, Windows ConPTY
   * `resize`/`theme`/`features` events, or `settleTurn`). Throttled by `minIntervalMs`
   * unless `force: true` is passed.
   */
  reassertCursorHidden(
    options: { readonly force?: boolean; readonly minIntervalMs?: number } = {},
  ): boolean {
    if (!this.#cursorHiddenDesired) return false;
    const now = this.#now();
    const minInterval = options.minIntervalMs ?? DEFAULT_CURSOR_REASSERT_MIN_INTERVAL_MS;
    if (!options.force && now - this.#lastCursorHideAt < minInterval) {
      return false;
    }
    this.#lastCursorHideAt = now;
    return this.#emit(HIDE_CURSOR);
  }

  /**
   * Restores the native terminal cursor (DECTCEM) and disarms the cursor-hidden guard.
   * Always enabled regardless of `osc7501` / `reopenAnchor` / `osc7` feature toggles.
   */
  showCursor(): boolean {
    this.#cursorHiddenDesired = false;
    return this.#emit(SHOW_CURSOR);
  }

  /**
   * Sets the terminal/pane title via OSC 2. Always enabled regardless of
   * `osc7501` / `reopenAnchor` / `osc7` feature toggles.
   */
  setTitle(title: string): boolean {
    return this.#emit(encodeOscTitle(title));
  }

  /**
   * Atomically sets the terminal/pane title via OSC 2 and re-hides the native
   * terminal cursor (`\x1b[?25l`), arming the cursor-hidden guard.
   */
  setTitleAndHideCursor(title: string): boolean {
    this.#cursorHiddenDesired = true;
    this.#lastCursorHideAt = this.#now();
    return this.#emit(encodeTitleAndHideCursor(title));
  }
}

export function createOscWriter(output: TermOutput, options?: OscWriterOptions): OscWriter {
  return new OscWriter(output, options);
}
