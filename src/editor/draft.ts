/**
 * Dual-track UTF-16 editor draft engine (DESIGN.md 4.3.1).
 *
 * Track 1 (Key): regular character input, CJK/IME text, surrogate-pair-safe
 *   backspace/delete/movement, word navigation/deletion, Home/End/Ctrl+A/E,
 *   Shift+Enter/Alt+Enter newline, bracketed paste.
 * Track 2 (EditEvent): native Tern selection replacement, click cursor move,
 *   and soft-wrap movement. Strictly ignores events when `e.len !== text.length`.
 * Undo stack: up to 200 snapshots, coalescing continuous single-character typing
 *   within 500ms while keeping EditEvent/paste/delete/newline atomic.
 */

export interface DraftState {
  readonly text: string;
  readonly cursor: number;
  readonly anchor?: number;
}

export interface DraftSnapshot {
  readonly text: string;
  readonly cursor: number;
}

/**
 * Structural subset compatible with `@stencil-hq/tern` EditEvent.
 */
export interface DraftEditEvent {
  readonly from: number;
  readonly to: number;
  readonly text: string;
  readonly cursor: number;
  readonly len: number;
}

/**
 * Structural subset compatible with `@stencil-hq/tern` Key events.
 */
export interface DraftKeyEvent {
  readonly name?: string;
  readonly key?: string;
  readonly char?: string;
  readonly text?: string;
  readonly paste?: string;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
}

export interface KeyHandleResult {
  readonly handled: boolean;
  readonly changed: boolean;
}

export interface DraftEngineOptions {
  readonly maxUndoSteps?: number;
  readonly coalesceMs?: number;
  readonly now?: () => number;
  readonly initialText?: string;
  readonly initialCursor?: number;
}

const DEFAULT_MAX_UNDO = 200;
const DEFAULT_COALESCE_MS = 500;

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Clamp a UTF-16 index into [0, text.length] and avoid landing inside a surrogate pair.
 */
export function clampUtf16Offset(text: string, pos: number, bias: 'left' | 'right' = 'left'): number {
  if (!Number.isFinite(pos) || pos <= 0) return 0;
  if (pos >= text.length) return text.length;
  const idx = Math.trunc(pos);
  if (idx > 0 && idx < text.length) {
    const prev = text.charCodeAt(idx - 1);
    const curr = text.charCodeAt(idx);
    if (isHighSurrogate(prev) && isLowSurrogate(curr)) {
      return bias === 'right' ? idx + 1 : idx - 1;
    }
  }
  return idx;
}

/**
 * Move one Unicode scalar value backward in UTF-16 units.
 */
export function prevCodePointOffset(text: string, pos: number): number {
  const clamped = clampUtf16Offset(text, pos, 'left');
  if (clamped <= 0) return 0;
  if (clamped >= 2) {
    const prev = text.charCodeAt(clamped - 1);
    const prev2 = text.charCodeAt(clamped - 2);
    if (isLowSurrogate(prev) && isHighSurrogate(prev2)) {
      return clamped - 2;
    }
  }
  return clamped - 1;
}

/**
 * Move one Unicode scalar value forward in UTF-16 units.
 */
export function nextCodePointOffset(text: string, pos: number): number {
  const clamped = clampUtf16Offset(text, pos, 'right');
  if (clamped >= text.length) return text.length;
  if (clamped + 1 < text.length) {
    const curr = text.charCodeAt(clamped);
    const next = text.charCodeAt(clamped + 1);
    if (isHighSurrogate(curr) && isLowSurrogate(next)) {
      return clamped + 2;
    }
  }
  return clamped + 1;
}

function classifyWordChar(ch: string): 'space' | 'word' | 'punct' {
  if (/\s/.test(ch)) return 'space';
  // Treat ASCII word chars, CJK/letters/numbers/underscore and non-ASCII symbols safely
  if (/[\p{L}\p{N}_]/u.test(ch)) return 'word';
  return 'punct';
}

function codePointAtBackward(text: string, endPos: number): { start: number; ch: string } {
  const start = prevCodePointOffset(text, endPos);
  return { start, ch: text.slice(start, endPos) };
}

function codePointAtForward(text: string, startPos: number): { end: number; ch: string } {
  const end = nextCodePointOffset(text, startPos);
  return { end, ch: text.slice(startPos, end) };
}

/**
 * Find the previous word boundary in UTF-16 units (surrogate-pair safe).
 */
export function prevWordOffset(text: string, pos: number): number {
  let i = clampUtf16Offset(text, pos, 'left');
  if (i <= 0) return 0;

  // Skip whitespace backward (stop after crossing a single newline if needed)
  while (i > 0) {
    const prev = codePointAtBackward(text, i);
    if (classifyWordChar(prev.ch) !== 'space') break;
    i = prev.start;
    if (prev.ch === '\n') {
      return i;
    }
  }
  if (i <= 0) return 0;

  const first = codePointAtBackward(text, i);
  const kind = classifyWordChar(first.ch);
  i = first.start;

  while (i > 0) {
    const prev = codePointAtBackward(text, i);
    if (classifyWordChar(prev.ch) !== kind) break;
    i = prev.start;
  }
  return i;
}

/**
 * Find the next word boundary in UTF-16 units (surrogate-pair safe).
 */
export function nextWordOffset(text: string, pos: number): number {
  let i = clampUtf16Offset(text, pos, 'right');
  const len = text.length;
  if (i >= len) return len;

  const first = codePointAtForward(text, i);
  const firstKind = classifyWordChar(first.ch);

  if (firstKind === 'space') {
    while (i < len) {
      const next = codePointAtForward(text, i);
      if (classifyWordChar(next.ch) !== 'space') break;
      i = next.end;
      if (next.ch === '\n') return i;
    }
    if (i >= len) return len;
    const afterSpace = codePointAtForward(text, i);
    const kind = classifyWordChar(afterSpace.ch);
    while (i < len) {
      const next = codePointAtForward(text, i);
      if (classifyWordChar(next.ch) !== kind) break;
      i = next.end;
    }
    return i;
  }

  while (i < len) {
    const next = codePointAtForward(text, i);
    if (classifyWordChar(next.ch) !== firstKind) break;
    i = next.end;
  }
  return i;
}

/**
 * Start offset of the logical line containing `pos`.
 */
export function lineStartOffset(text: string, pos: number): number {
  const clamped = clampUtf16Offset(text, pos, 'left');
  const nl = text.lastIndexOf('\n', clamped - 1);
  return nl === -1 ? 0 : nl + 1;
}

/**
 * End offset of the logical line containing `pos` (before '\n' or at text.length).
 */
export function lineEndOffset(text: string, pos: number): number {
  const clamped = clampUtf16Offset(text, pos, 'right');
  const nl = text.indexOf('\n', clamped);
  return nl === -1 ? text.length : nl;
}

function normalizeNewlines(input: string): string {
  return input.replace(/\r\n?/g, '\n');
}

function countCodePoints(s: string): number {
  let count = 0;
  let i = 0;
  while (i < s.length) {
    i = nextCodePointOffset(s, i);
    count++;
  }
  return count;
}

function extractPrintableText(key: DraftKeyEvent): string | null {
  if (key.ctrl || key.meta || key.alt) return null;
  if (typeof key.text === 'string' && key.text.length > 0) {
    return key.text;
  }
  if (typeof key.char === 'string' && key.char.length > 0) {
    return key.char;
  }
  // Single-character key name fallback (e.g. name === 'a' or emoji/CJK)
  const name = key.name ?? key.key;
  if (name && name.length > 0) {
    // Exclude known control/named keys
    if (
      name === 'space' ||
      name === 'Space'
    ) {
      return ' ';
    }
    if (countCodePoints(name) === 1 && !/[\x00-\x1f\x7f]/.test(name)) {
      return name;
    }
  }
  return null;
}

function normalizedKeyName(key: DraftKeyEvent): string {
  const raw = key.name ?? key.key ?? '';
  return raw.toLowerCase();
}

export class DraftEngine {
  private _text: string;
  private _cursor: number;
  private _anchor: number | undefined;
  private readonly _undoStack: DraftSnapshot[] = [];
  private readonly _maxUndoSteps: number;
  private readonly _coalesceMs: number;
  private readonly _now: () => number;

  private _lastUndoKind: 'typing' | 'other' | null = null;
  private _lastTypingAt = 0;

  constructor(options: DraftEngineOptions = {}) {
    this._maxUndoSteps = Math.max(1, options.maxUndoSteps ?? DEFAULT_MAX_UNDO);
    this._coalesceMs = Math.max(0, options.coalesceMs ?? DEFAULT_COALESCE_MS);
    this._now = options.now ?? (() => Date.now());
    this._text = normalizeNewlines(options.initialText ?? '');
    this._cursor = clampUtf16Offset(this._text, options.initialCursor ?? this._text.length, 'left');
    this._anchor = undefined;
  }

  get text(): string {
    return this._text;
  }

  get cursor(): number {
    return this._cursor;
  }

  get anchor(): number | undefined {
    return this._anchor;
  }

  get undoDepth(): number {
    return this._undoStack.length;
  }

  isEmpty(): boolean {
    return this._text.length === 0;
  }

  isBlank(): boolean {
    return this._text.trim().length === 0;
  }

  getState(): DraftState {
    return this._anchor === undefined
      ? { text: this._text, cursor: this._cursor }
      : { text: this._text, cursor: this._cursor, anchor: this._anchor };
  }

  private getSelectionRange(): [number, number] | null {
    if (this._anchor === undefined || this._anchor === this._cursor) {
      return null;
    }
    return this._anchor < this._cursor
      ? [this._anchor, this._cursor]
      : [this._cursor, this._anchor];
  }

  private breakTypingGroup(): void {
    this._lastUndoKind = null;
    this._lastTypingAt = 0;
  }

  private pushSnapshot(kind: 'typing' | 'other'): void {
    const now = this._now();
    if (
      kind === 'typing' &&
      this._lastUndoKind === 'typing' &&
      this._undoStack.length > 0 &&
      now - this._lastTypingAt <= this._coalesceMs
    ) {
      this._lastTypingAt = now;
      return;
    }

    this._undoStack.push({ text: this._text, cursor: this._cursor });
    if (this._undoStack.length > this._maxUndoSteps) {
      this._undoStack.shift();
    }

    this._lastUndoKind = kind;
    this._lastTypingAt = kind === 'typing' ? now : 0;
  }

  /**
   * Apply a native Tern EditEvent.
   *
   * Strictly ignores the event if `e.len !== this._text.length` (keys in flight).
   * Returns true if the event was accepted (either text mutated or cursor moved),
   * false if ignored.
   */
  applyEdit(e: DraftEditEvent): boolean {
    if (e.len !== this._text.length) {
      return false;
    }

    const from = Math.trunc(e.from);
    const to = Math.trunc(e.to);
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      from < 0 ||
      to < 0 ||
      from > this._text.length ||
      to > this._text.length ||
      from > to
    ) {
      return false;
    }

    const inserted = normalizeNewlines(e.text);
    const mutatesText = from !== to || inserted.length > 0;

    if (mutatesText) {
      this.pushSnapshot('other');
      this._text = this._text.slice(0, from) + inserted + this._text.slice(to);
      this._cursor = clampUtf16Offset(this._text, e.cursor, 'left');
      this._anchor = undefined;
      this.breakTypingGroup();
    } else {
      this._cursor = clampUtf16Offset(this._text, e.cursor, 'left');
      this._anchor = undefined;
      this.breakTypingGroup();
    }

    return true;
  }

  /**
   * Restore the previous snapshot from the undo stack.
   */
  undo(): boolean {
    const snap = this._undoStack.pop();
    if (!snap) return false;
    this._text = snap.text;
    this._cursor = clampUtf16Offset(this._text, snap.cursor, 'left');
    this._anchor = undefined;
    this.breakTypingGroup();
    return true;
  }

  /**
   * Replace a UTF-16 range (used for completion acceptance or programmatic edits).
   */
  replaceRange(
    from: number,
    to: number,
    insertText: string,
    nextCursor?: number,
    recordUndo = true,
  ): boolean {
    const start = clampUtf16Offset(this._text, Math.min(from, to), 'left');
    const end = clampUtf16Offset(this._text, Math.max(from, to), 'right');
    const normalized = normalizeNewlines(insertText);
    const newText = this._text.slice(0, start) + normalized + this._text.slice(end);
    const targetCursor = clampUtf16Offset(
      newText,
      nextCursor ?? start + normalized.length,
      'left',
    );

    if (newText === this._text && targetCursor === this._cursor && this._anchor === undefined) {
      return false;
    }

    if (recordUndo && newText !== this._text) {
      this.pushSnapshot('other');
    }
    this._text = newText;
    this._cursor = targetCursor;
    this._anchor = undefined;
    this.breakTypingGroup();
    return true;
  }

  /**
   * Insert text at the current cursor (or replace active selection).
   */
  insertText(raw: string, options: { coalesce?: boolean; recordUndo?: boolean } = {}): boolean {
    const textToInsert = normalizeNewlines(raw);
    const sel = this.getSelectionRange();
    if (textToInsert.length === 0 && !sel) {
      return false;
    }

    const from = sel ? sel[0] : this._cursor;
    const to = sel ? sel[1] : this._cursor;
    const isSingleCharTyping =
      options.coalesce === true &&
      !sel &&
      !textToInsert.includes('\n') &&
      countCodePoints(textToInsert) === 1;

    if (options.recordUndo !== false) {
      this.pushSnapshot(isSingleCharTyping ? 'typing' : 'other');
    }

    this._text = this._text.slice(0, from) + textToInsert + this._text.slice(to);
    this._cursor = from + textToInsert.length;
    this._anchor = undefined;

    if (!isSingleCharTyping) {
      this.breakTypingGroup();
    }
    return true;
  }

  /**
   * Replace entire draft text (e.g. history navigation or external load).
   */
  setText(raw: string, cursor?: number, recordUndo = false): void {
    const normalized = normalizeNewlines(raw);
    if (recordUndo && normalized !== this._text) {
      this.pushSnapshot('other');
    }
    this._text = normalized;
    this._cursor = clampUtf16Offset(this._text, cursor ?? this._text.length, 'left');
    this._anchor = undefined;
    this.breakTypingGroup();
  }

  /**
   * Set cursor and optional selection anchor (useful for programmatic selection/testing).
   */
  setSelection(cursor: number, anchor?: number): void {
    this._cursor = clampUtf16Offset(this._text, cursor, 'left');
    this._anchor = anchor === undefined ? undefined : clampUtf16Offset(this._text, anchor, 'left');
    this.breakTypingGroup();
  }

  /**
   * Clear text, optionally recording an undo snapshot (e.g. Ctrl+C clear).
   */
  clear(recordUndo = true): boolean {
    if (this._text.length === 0 && this._cursor === 0 && this._anchor === undefined) {
      return false;
    }
    if (recordUndo && this._text.length > 0) {
      this.pushSnapshot('other');
    }
    this._text = '';
    this._cursor = 0;
    this._anchor = undefined;
    this.breakTypingGroup();
    return true;
  }

  /**
   * Reset draft and discard undo history (e.g. after sending a prompt).
   */
  reset(): void {
    this._text = '';
    this._cursor = 0;
    this._anchor = undefined;
    this._undoStack.length = 0;
    this.breakTypingGroup();
  }

  /**
   * Handle a Key-track event for the editor.
   *
   * Returns `{ handled: false, changed: false }` for keys owned by the outer
   * controller (such as plain `Enter` submission, `Escape`, `Tab`, `Ctrl+C`,
   * `Ctrl+V`, or `Up`/`Down` when already on the first/last logical line).
   */
  handleKey(key: DraftKeyEvent): KeyHandleResult {
    const name = normalizedKeyName(key);

    // Bracketed paste
    if (name === 'paste') {
      const pasted = key.text ?? key.paste ?? key.char ?? '';
      if (pasted.length === 0) {
        return { handled: true, changed: false };
      }
      const changed = this.insertText(pasted, { coalesce: false, recordUndo: true });
      return { handled: true, changed };
    }

    // Shift+Enter / Alt+Enter / Ctrl+J -> insert newline
    if (
      ((name === 'enter' || name === 'return') && (key.shift || key.alt)) ||
      (name === 'j' && key.ctrl && !key.alt && !key.meta)
    ) {
      const changed = this.insertText('\n', { coalesce: false, recordUndo: true });
      return { handled: true, changed };
    }

    // Plain Enter is submitted by controller, not inserted here
    if (name === 'enter' || name === 'return') {
      return { handled: false, changed: false };
    }

    // Ctrl+Z fallback (in case UndoEvent wasn't routed separately)
    if (name === 'z' && (key.ctrl || key.meta) && !key.alt && !key.shift) {
      const changed = this.undo();
      return { handled: true, changed };
    }

    // Ctrl+A -> line start (DESIGN.md 4.3.1)
    if (name === 'a' && key.ctrl && !key.alt && !key.meta) {
      return this.moveCursor(lineStartOffset(this._text, this._cursor));
    }

    // Ctrl+E -> line end (DESIGN.md 4.3.1)
    if (name === 'e' && key.ctrl && !key.alt && !key.meta) {
      return this.moveCursor(lineEndOffset(this._text, this._cursor));
    }

    // Ctrl+U -> kill to start of current line
    if (name === 'u' && key.ctrl && !key.alt && !key.meta) {
      const start = lineStartOffset(this._text, this._cursor);
      return this.deleteRange(start, this._cursor);
    }

    // Ctrl+K -> kill to end of current line
    if (name === 'k' && key.ctrl && !key.alt && !key.meta) {
      const end = lineEndOffset(this._text, this._cursor);
      return this.deleteRange(this._cursor, end);
    }

    // Ctrl+W -> delete previous word
    if (name === 'w' && key.ctrl && !key.alt && !key.meta) {
      return this.deleteBackwardWord();
    }

    // Home / End
    if (name === 'home') {
      const target = key.ctrl || key.meta ? 0 : lineStartOffset(this._text, this._cursor);
      return this.moveCursor(target);
    }
    if (name === 'end') {
      const target = key.ctrl || key.meta ? this._text.length : lineEndOffset(this._text, this._cursor);
      return this.moveCursor(target);
    }

    // Backspace / Ctrl+Backspace / Alt+Backspace
    if (name === 'backspace') {
      if (key.ctrl || key.alt || key.meta) {
        return this.deleteBackwardWord();
      }
      return this.deleteBackwardChar();
    }

    // Delete / Ctrl+Delete / Alt+Delete
    if (name === 'delete' || name === 'del') {
      if (key.ctrl || key.alt || key.meta) {
        return this.deleteForwardWord();
      }
      return this.deleteForwardChar();
    }

    // Left / Ctrl+Left / Alt+Left / Alt+B
    if (name === 'left' || (name === 'b' && key.alt && !key.ctrl && !key.meta)) {
      if (key.ctrl || key.alt || key.meta) {
        return this.moveCursor(prevWordOffset(this._text, this._cursor));
      }
      const sel = this.getSelectionRange();
      if (sel) {
        return this.moveCursor(sel[0]);
      }
      return this.moveCursor(prevCodePointOffset(this._text, this._cursor));
    }

    // Right / Ctrl+Right / Alt+Right / Alt+F
    if (name === 'right' || (name === 'f' && key.alt && !key.ctrl && !key.meta)) {
      if (key.ctrl || key.alt || key.meta) {
        return this.moveCursor(nextWordOffset(this._text, this._cursor));
      }
      const sel = this.getSelectionRange();
      if (sel) {
        return this.moveCursor(sel[1]);
      }
      return this.moveCursor(nextCodePointOffset(this._text, this._cursor));
    }

    // Up / Down across logical lines; pass through at first/last line for history navigation
    if (name === 'up' && !key.ctrl && !key.alt && !key.meta) {
      return this.moveLogicalLine(-1);
    }
    if (name === 'down' && !key.ctrl && !key.alt && !key.meta) {
      return this.moveLogicalLine(1);
    }

    // Regular printable character / CJK / Emoji / IME commit
    const printable = extractPrintableText(key);
    if (printable !== null) {
      const changed = this.insertText(printable, { coalesce: true, recordUndo: true });
      return { handled: true, changed };
    }

    return { handled: false, changed: false };
  }

  private moveCursor(target: number): KeyHandleResult {
    const clamped = clampUtf16Offset(this._text, target, 'left');
    const changed = clamped !== this._cursor || this._anchor !== undefined;
    this._cursor = clamped;
    this._anchor = undefined;
    this.breakTypingGroup();
    return { handled: true, changed };
  }

  private moveLogicalLine(delta: -1 | 1): KeyHandleResult {
    const currStart = lineStartOffset(this._text, this._cursor);
    const col = this._cursor - currStart;

    if (delta === -1) {
      if (currStart === 0) {
        // Already on first line -> let outer controller handle history navigation
        return { handled: false, changed: false };
      }
      const prevLineEnd = currStart - 1;
      const prevLineStart = lineStartOffset(this._text, prevLineEnd);
      const target = Math.min(prevLineStart + col, prevLineEnd);
      return this.moveCursor(target);
    }

    const currEnd = lineEndOffset(this._text, this._cursor);
    if (currEnd >= this._text.length) {
      // Already on last line -> let outer controller handle history navigation
      return { handled: false, changed: false };
    }
    const nextLineStart = currEnd + 1;
    const nextLineEnd = lineEndOffset(this._text, nextLineStart);
    const target = Math.min(nextLineStart + col, nextLineEnd);
    return this.moveCursor(target);
  }

  private deleteRange(from: number, to: number): KeyHandleResult {
    const start = clampUtf16Offset(this._text, Math.min(from, to), 'left');
    const end = clampUtf16Offset(this._text, Math.max(from, to), 'right');
    if (start === end) {
      const hadAnchor = this._anchor !== undefined;
      this._anchor = undefined;
      return { handled: true, changed: hadAnchor };
    }
    this.pushSnapshot('other');
    this._text = this._text.slice(0, start) + this._text.slice(end);
    this._cursor = start;
    this._anchor = undefined;
    this.breakTypingGroup();
    return { handled: true, changed: true };
  }

  private deleteBackwardChar(): KeyHandleResult {
    const sel = this.getSelectionRange();
    if (sel) {
      return this.deleteRange(sel[0], sel[1]);
    }
    if (this._cursor === 0) {
      return { handled: true, changed: false };
    }
    const prev = prevCodePointOffset(this._text, this._cursor);
    return this.deleteRange(prev, this._cursor);
  }

  private deleteForwardChar(): KeyHandleResult {
    const sel = this.getSelectionRange();
    if (sel) {
      return this.deleteRange(sel[0], sel[1]);
    }
    if (this._cursor >= this._text.length) {
      return { handled: true, changed: false };
    }
    const next = nextCodePointOffset(this._text, this._cursor);
    return this.deleteRange(this._cursor, next);
  }

  private deleteBackwardWord(): KeyHandleResult {
    const sel = this.getSelectionRange();
    if (sel) {
      return this.deleteRange(sel[0], sel[1]);
    }
    if (this._cursor === 0) {
      return { handled: true, changed: false };
    }
    const start = prevWordOffset(this._text, this._cursor);
    return this.deleteRange(start, this._cursor);
  }

  private deleteForwardWord(): KeyHandleResult {
    const sel = this.getSelectionRange();
    if (sel) {
      return this.deleteRange(sel[0], sel[1]);
    }
    if (this._cursor >= this._text.length) {
      return { handled: true, changed: false };
    }
    const end = nextWordOffset(this._text, this._cursor);
    return this.deleteRange(this._cursor, end);
  }
}
