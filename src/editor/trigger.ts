/**
 * Caret completion trigger detector for `/` slash commands and `@` file mentions,
 * plus replacement helper for applying an accepted suggestion.
 */

import { clampUtf16Offset } from './draft';

export type TriggerKind = 'slash' | 'file';

export interface CompletionTrigger {
  readonly kind: TriggerKind;
  /** UTF-16 start offset of the trigger prefix ('/' or '@'). */
  readonly start: number;
  /** UTF-16 end offset (typically the caret position). */
  readonly end: number;
  /** Filter query without the leading '/' or '@'. */
  readonly query: string;
  /** Full slice text[start..end] including leading '/' or '@'. */
  readonly raw: string;
}

export interface TriggerReplacementOptions {
  /** Append a trailing space when not already followed by whitespace. Defaults to true. */
  readonly appendSpace?: boolean;
}

export interface TriggerReplacementResult {
  readonly text: string;
  readonly cursor: number;
  readonly from: number;
  readonly to: number;
  readonly inserted: string;
}

export interface ExtractedFileMention {
  /** Decoded file path (without leading `@` or surrounding quotes). */
  readonly path: string;
  /** Raw token slice in the draft text (including leading `@` and quotes if present). */
  readonly raw: string;
  /** UTF-16 start offset of `@`. */
  readonly start: number;
  /** UTF-16 end offset (exclusive). */
  readonly end: number;
  /** Whether the mention used `@"..."` quoted syntax. */
  readonly quoted: boolean;
}

function isWhitespace(ch: string): boolean {
  return /\s/.test(ch);
}

/**
 * Characters allowed immediately before `@` for a file mention trigger.
 * Prevents triggering inside email addresses (e.g. `user@example.com`).
 */
function isValidAtBoundary(prevChar: string | undefined): boolean {
  if (prevChar === undefined) return true;
  if (isWhitespace(prevChar)) return true;
  // Common opening delimiters / punctuation
  return /[([{"'`,;:<>|]/.test(prevChar);
}

/**
 * Characters that terminate an unquoted `@path` mention. Shared between
 * `formatFileMention` and `extractFileMentions` so any path containing one of
 * these delimiters (e.g. spaces, commas like `a,b.txt`, semicolons, quotes,
 * brackets) is always formatted with `@"..."` and round-trips to the exact path.
 */
const UNQUOTED_MENTION_STOP_RE = /[\s)\]}"'`,;<>|]/;

/**
 * Format a file path as a canonical `@` mention token. Paths containing whitespace,
 * mention delimiters (such as `,` in `a,b.txt`), quotes, or backslashes use `@"..."`
 * quoting (shared with `extractFileMentions` so completion, history recall, and
 * submission always reconstruct the exact same path).
 */
export function formatFileMention(relPath: string): string {
  // Never strip a leading `@` from the original file path: filenames such as `@draft.md`
  // must keep their leading `@` and use `@"..."` quoting so `@"@draft.md"` round-trips to
  // `@draft.md` instead of colliding with `draft.md`.
  if (
    UNQUOTED_MENTION_STOP_RE.test(relPath) ||
    relPath.includes('\\') ||
    relPath.startsWith('"') ||
    relPath.startsWith('@')
  ) {
    const escaped = relPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `@"${escaped}"`;
  }
  return `@${relPath}`;
}

/**
 * Shared parser for `@path` and `@"path with spaces"` file mentions in prompt text.
 */
export function extractFileMentions(text: string): ExtractedFileMention[] {
  const results: ExtractedFileMention[] = [];
  const len = text.length;
  let i = 0;

  while (i < len) {
    if (text[i] !== '@') {
      i += 1;
      continue;
    }
    const prevChar = i > 0 ? text[i - 1] : undefined;
    if (!isValidAtBoundary(prevChar)) {
      i += 1;
      continue;
    }

    const start = i;
    if (i + 1 < len && text[i + 1] === '"') {
      let j = i + 2;
      let decoded = '';
      let closed = false;
      while (j < len) {
        const ch = text[j]!;
        if (ch === '\\' && j + 1 < len && (text[j + 1] === '"' || text[j + 1] === '\\')) {
          decoded += text[j + 1]!;
          j += 2;
          continue;
        }
        if (ch === '"') {
          j += 1;
          closed = true;
          break;
        }
        if (ch === '\n' || ch === '\r') {
          break;
        }
        decoded += ch;
        j += 1;
      }
      if (closed && decoded.length > 0) {
        results.push({
          path: decoded,
          raw: text.slice(start, j),
          start,
          end: j,
          quoted: true,
        });
        i = j;
        continue;
      }
    }

    let j = i + 1;
    while (j < len && !UNQUOTED_MENTION_STOP_RE.test(text[j]!)) {
      j += 1;
    }
    if (j > i + 1) {
      const decoded = text.slice(i + 1, j);
      results.push({
        path: decoded,
        raw: text.slice(start, j),
        start,
        end: j,
        quoted: false,
      });
      i = j;
      continue;
    }
    i += 1;
  }

  return results;
}

/**
 * Detect whether the caret sits inside an active `/` command or `@` file trigger.
 */
export function detectCompletionTrigger(text: string, cursor: number): CompletionTrigger | null {
  const end = clampUtf16Offset(text, cursor, 'left');
  const before = text.slice(0, end);

  // 1. Check leading `/` slash command trigger:
  //    Valid only on the first line, optional leading spaces/tabs, and no whitespace after `/`.
  if (!before.includes('\n')) {
    const slashMatch = /^([ \t]*)(\/[^\s]*)$/.exec(before);
    if (slashMatch) {
      const leading = slashMatch[1] ?? '';
      const raw = slashMatch[2] ?? '/';
      const start = leading.length;
      return {
        kind: 'slash',
        start,
        end,
        query: raw.slice(1),
        raw,
      };
    }
  }

  // 2a. Check open quoted `@"path with spaces` trigger on current line
  const lineStart = before.lastIndexOf('\n') + 1;
  const lineSlice = before.slice(lineStart);
  const lastQuotedAt = lineSlice.lastIndexOf('@"');
  if (lastQuotedAt >= 0) {
    const absStart = lineStart + lastQuotedAt;
    const prevChar = absStart > 0 ? before[absStart - 1] : undefined;
    if (isValidAtBoundary(prevChar)) {
      const afterQuote = before.slice(absStart + 2, end);
      let hasUnescapedCloseQuote = false;
      for (let k = 0; k < afterQuote.length; k++) {
        if (afterQuote[k] === '\\' && k + 1 < afterQuote.length) {
          k += 1;
          continue;
        }
        if (afterQuote[k] === '"') {
          hasUnescapedCloseQuote = true;
          break;
        }
      }
      if (!hasUnescapedCloseQuote) {
        const unescapedQuery = afterQuote.replace(/\\(["\\])/g, '$1');
        return {
          kind: 'file',
          start: absStart,
          end,
          query: unescapedQuery,
          raw: before.slice(absStart, end),
        };
      }
    }
  }

  // 2b. Check unquoted `@` file completion trigger at current token before caret:
  //     Scan backward from `end` until whitespace or start of text.
  let tokenStart = end;
  while (tokenStart > 0) {
    const ch = before[tokenStart - 1];
    if (ch === undefined || isWhitespace(ch)) break;
    tokenStart--;
  }

  const token = before.slice(tokenStart, end);
  if (token.startsWith('@')) {
    const prevChar = tokenStart > 0 ? before[tokenStart - 1] : undefined;
    if (isValidAtBoundary(prevChar)) {
      return {
        kind: 'file',
        start: tokenStart,
        end,
        query: token.slice(1),
        raw: token,
      };
    }
  } else if (token.length > 1) {
    // Also support `@path` directly after opening punctuation such as `(@src/a` or `"@README`
    const lastAt = token.lastIndexOf('@');
    if (lastAt > 0) {
      const boundaryChar = token[lastAt - 1];
      if (isValidAtBoundary(boundaryChar)) {
        const start = tokenStart + lastAt;
        const raw = before.slice(start, end);
        return {
          kind: 'file',
          start,
          end,
          query: raw.slice(1),
          raw,
        };
      }
    }
  }

  return null;
}

/**
 * Compute the replacement text and caret position when accepting a completion item.
 */
export function applyTriggerReplacement(
  text: string,
  trigger: CompletionTrigger,
  value: string,
  options: TriggerReplacementOptions = {},
): TriggerReplacementResult {
  const appendSpace = options.appendSpace ?? true;
  const normalizedValue =
    trigger.kind === 'slash'
      ? value.startsWith('/')
        ? value
        : `/${value}`
      : formatFileMention(value);

  const afterChar = text[trigger.end];
  const needsSpace = appendSpace && (afterChar === undefined || !isWhitespace(afterChar));
  const inserted = needsSpace ? `${normalizedValue} ` : normalizedValue;

  const nextText = text.slice(0, trigger.start) + inserted + text.slice(trigger.end);
  const nextCursor = trigger.start + inserted.length;

  return {
    text: nextText,
    cursor: nextCursor,
    from: trigger.start,
    to: trigger.end,
    inserted,
  };
}
