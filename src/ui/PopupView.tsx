import type { IconName, JSX, SpanData } from '@stencil-hq/tern';
import {
  EDITOR_NODE_ID,
  MAX_COMPLETION_ITEMS,
  type CompletionPopupItem,
  type CompletionPopupState,
} from '../state/store';

export interface PopupCallbacks {
  readonly onSelect: (itemId: string) => void;
  readonly onActivate: (itemId: string) => void;
}

export interface PopupViewProps {
  readonly completion: CompletionPopupState;
  readonly callbacks: PopupCallbacks;
}

function buildHighlightedLabel(
  label: string,
  hits?: readonly (readonly [number, number])[]
): string | readonly (string | SpanData)[] {
  if (!hits || hits.length === 0) return label;
  const spans: Array<string | SpanData> = [];
  let cursor = 0;

  for (const [rawStart, rawEnd] of hits) {
    const start = Math.max(cursor, Math.min(label.length, rawStart));
    const end = Math.max(start, Math.min(label.length, rawEnd));
    if (start > cursor) {
      spans.push(label.slice(cursor, start));
    }
    if (end > start) {
      spans.push({ t: label.slice(start, end), s: 'mark' });
    }
    cursor = end;
  }

  if (cursor < label.length) {
    spans.push(label.slice(cursor));
  }

  return spans.length > 0 ? spans : label;
}

function resolveCompletionIcon(entry: CompletionPopupItem): IconName {
  if (entry.icon && entry.icon.trim().length > 0) {
    return entry.icon as IconName;
  }
  if (entry.kind === 'file') {
    return entry.isDirectory ? 'folder' : 'file';
  }
  return entry.isPluginGroup ? 'package' : entry.isSkillGroup ? 'skill' : 'action';
}

function formatCompletionLabel(entry: CompletionPopupItem): string | readonly (string | SpanData)[] {
  if (entry.kind === 'slash' && entry.label.startsWith('/')) {
    const stripped = entry.label.slice(1);
    const shiftedHits = entry.hits
      ?.map(([s, e]) => [Math.max(0, s - 1), Math.max(0, e - 1)] as const)
      .filter(([s, e]) => e > s);
    return buildHighlightedLabel(stripped, shiftedHits);
  }
  return buildHighlightedLabel(entry.label, entry.hits);
}

/**
 * Caret-anchored completion popup for `/` slash commands and `@` workspace files,
 * aligned 1:1 with `omp`'s `omp.autocomplete` + `omp.select` node hierarchy (Figure 3):
 * - `<overlay key="complete" anchor={{ caret: EDITOR_NODE_ID }} role="omp.autocomplete">`
 * - `<col key="select" role="omp.select">` -> `<list key="list" max={{ lines: 10 }}>`
 * - Semantic per-command icons (`folder`/`file` for `@` paths, never hardcoded `'slash'`)
 * - Pure command names without leading `/` with `mark` highlight on matched prefix
 * - `detail` and live right-side status `value` wrapped in `muted` spans
 */
export function PopupView(props: PopupViewProps): JSX.Element | null {
  const { completion, callbacks } = props;
  if (!completion.open || completion.items.length === 0) {
    return null;
  }

  const visibleItems = completion.items.slice(0, MAX_COMPLETION_ITEMS);

  return (
    <overlay key="complete" anchor={{ caret: EDITOR_NODE_ID }} role="omp.autocomplete">
      <col key="select" role="omp.select">
        <list
          key="list"
          selected={completion.selectedNodeId ?? undefined}
          max={{ lines: MAX_COMPLETION_ITEMS }}
          empty="No matches"
          onSelect={ev => callbacks.onSelect(ev.item)}
          onActivate={ev => callbacks.onActivate(ev.item)}
        >
          {visibleItems.map(entry => {
            const rightText = entry.statusValue ?? entry.badge;
            return (
              <item
                key={entry.key}
                icon={resolveCompletionIcon(entry)}
                label={formatCompletionLabel(entry)}
                detail={entry.detail ? [{ t: entry.detail, s: 'muted' }] : undefined}
                value={rightText ? [{ t: rightText, s: 'muted' }] : undefined}
              />
            );
          })}
        </list>
      </col>
    </overlay>
  );
}
