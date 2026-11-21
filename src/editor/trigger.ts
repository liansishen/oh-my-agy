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

  // 2. Check `@` file completion trigger at current token before caret:
  //    Scan backward from `end` until whitespace or start of text.
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
  const prefix = trigger.kind === 'slash' ? '/' : '@';
  const normalizedValue = value.startsWith(prefix) ? value : `${prefix}${value}`;

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
