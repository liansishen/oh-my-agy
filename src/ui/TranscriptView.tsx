import { node, type EditEvent, type JSX, type SpanData } from '@stencil-hq/tern';
import { toFileUri } from '../acp/path';
import type { ToolDisplayMode } from '../config/config';
import type { ApprovalAction } from '../state/approval';
import type { AppState } from '../state/store';
import { WELCOME_LOGO_HEIGHT, WELCOME_LOGO_WIDTH } from './assets';
import {
  formatFullLocalTime,
  formatTurnTime,
  type ActiveQuestionCard,
  type NoticeItem,
  type PlanState,
  type SubagentEntry,
  type ToolCallItem,
  type ToolDiffItem,
  type TranscriptTurn,
  type TurnTimelineRef,
} from '../state/transcript';

export interface TranscriptCallbacks {
  readonly onToggleThought: (thoughtId: string, open: boolean) => void;
  readonly onToggleTool: (toolCallId: string, collapsed: boolean) => void;
  readonly onToggleToolGroup?: (groupId: string, expanded: boolean) => void;
  readonly onToggleNotice: (noticeId: string, collapsed: boolean) => void;
  readonly onToggleAgent: (agentId: string, collapsed: boolean) => void;
  readonly onApproveTool: (toolCallId: string, action: ApprovalAction) => void;
  readonly onCopyMessage: (text: string) => void;
  readonly onCopyAnswer: (text: string) => void;
  readonly onQuestionChange: (questionId: string, value: string | string[]) => void;
  readonly onQuestionOtherEdit: (questionId: string, event: EditEvent) => void;
  readonly onQuestionOtherFocus: (questionId: string) => void;
  readonly onQuestionBack?: () => void;
  readonly onQuestionNext?: () => void;
  readonly onQuestionSkip?: () => void;
  readonly onQuestionSubmit: (answers: Record<string, unknown>) => void;
  readonly onQuestionDecline: () => void;
  readonly onQuestionCancel: () => void;
  readonly onRetryCrash: () => void;
  readonly onLoginAuth: () => void;
  readonly onDismissAuth: () => void;
  /** Retry a turn from the `omp.error` action bar or user message context menu. */
  readonly onRetryTurn?: (turnIndex: number) => void;
  /** Load a previous user message back into the editor for edit & resend. */
  readonly onEditAndResend?: (text: string) => void;
  /** Copy error text from an `omp.error` card. */
  readonly onCopyError?: (message: string) => void;
  /** Open the compact model switcher from an `omp.error` card. */
  readonly onSwitchModel?: () => void;
}

export interface TranscriptViewProps {
  readonly state: AppState;
  readonly turns: readonly TranscriptTurn[];
  readonly plan: PlanState | null;
  readonly version: string;
  readonly toolPreviewLines: number;
  readonly now?: number;
  readonly callbacks: TranscriptCallbacks;
}

function formatShortDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  const secs = safe / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs % 60);
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function formatTurnUsageLabel(turn: TranscriptTurn): string {
  const parts: string[] = [];
  if (!turn.replayed && turn.endedAt !== undefined) {
    parts.push(formatShortDuration(Math.max(0, turn.endedAt - turn.startedAt)));
  }
  const toolCount = turn.toolCalls.length;
  if (toolCount > 0) {
    parts.push(toolCount === 1 ? '1 tool' : `${toolCount} tools`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'done';
}

const formattedDiffCache = new WeakMap<ToolDiffItem, string>();
const diffLineStatsCache = new WeakMap<
  ToolDiffItem,
  { readonly added: number; readonly removed: number }
>();

function formatUnifiedDiff(diff: ToolDiffItem): string {
  const cached = formattedDiffCache.get(diff);
  if (cached !== undefined) return cached;

  let result: string;
  if (diff.patchText && diff.patchText.trim().length > 0) {
    result = diff.patchText;
  } else {
    const oldLines = diff.oldText ? diff.oldText.split(/\r?\n/) : [];
    const newLines = diff.newText ? diff.newText.split(/\r?\n/) : [];

    const header = [
      `--- a/${diff.path}`,
      `+++ b/${diff.path}`,
      `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ];

    let prefix = 0;
    const maxPrefix = Math.min(oldLines.length, newLines.length);
    while (prefix < maxPrefix && oldLines[prefix] === newLines[prefix]) {
      prefix++;
    }

    let suffix = 0;
    while (
      suffix < oldLines.length - prefix &&
      suffix < newLines.length - prefix &&
      oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
      suffix++;
    }

    const body: string[] = [];
    const ctxBefore = Math.max(0, prefix - 3);
    for (let i = ctxBefore; i < prefix; i++) {
      body.push(` ${oldLines[i] ?? ''}`);
    }
    for (let i = prefix; i < oldLines.length - suffix; i++) {
      body.push(`-${oldLines[i] ?? ''}`);
    }
    for (let i = prefix; i < newLines.length - suffix; i++) {
      body.push(`+${newLines[i] ?? ''}`);
    }
    const ctxAfterEnd = Math.min(oldLines.length, oldLines.length - suffix + 3);
    for (let i = oldLines.length - suffix; i < ctxAfterEnd; i++) {
      body.push(` ${oldLines[i] ?? ''}`);
    }

    result = [...header, ...body].join('\n');
  }

  formattedDiffCache.set(diff, result);
  return result;
}

function getDiffLineStats(diff: ToolDiffItem): { readonly added: number; readonly removed: number } {
  const cached = diffLineStatsCache.get(diff);
  if (cached !== undefined) return cached;
  let added = 0;
  let removed = 0;
  const patch = formatUnifiedDiff(diff);
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  const stats = { added, removed };
  diffLineStatsCache.set(diff, stats);
  return stats;
}

function safeFormatInput(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

const TOOL_VERBS: Readonly<Record<string, string>> = {
  bash: 'Bash',
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  search: 'Search',
  web: 'Web',
  todo: 'Todo',
  task: 'Task',
};

function resolveToolVerbTitle(tool: ToolCallItem): string {
  const rawTitle = tool.title.trim();
  const rawTarget = tool.target?.trim();
  if (!rawTarget) return rawTitle;

  const lowerTitle = rawTitle.toLowerCase();
  const lowerTarget = rawTarget.toLowerCase();
  const duplicatesTarget =
    lowerTitle === lowerTarget ||
    lowerTitle === `file ${lowerTarget}` ||
    lowerTitle.endsWith(` ${lowerTarget}`);

  if (!duplicatesTarget) return rawTitle;

  const key = tool.displayName.trim().toLowerCase();
  const mapped = TOOL_VERBS[key];
  if (mapped) return mapped;
  return key.length > 0 ? `${key[0]!.toUpperCase()}${key.slice(1)}` : rawTitle;
}

function resolveToolFrame(tool: ToolCallItem): 'inline' | 'card' {
  if (tool.status === 'ask') return 'card';
  const name = tool.displayName.toLowerCase();
  if (name === 'edit' || name === 'write' || name === 'todo' || name === 'task') {
    return 'card';
  }
  return 'inline';
}

function splitPathDirAndName(filePath: string): { dir: string; name: string } {
  const cleaned = filePath.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  if (idx < 0) return { dir: '', name: cleaned || filePath };
  return { dir: cleaned.slice(0, idx + 1), name: cleaned.slice(idx + 1) };
}

function resolveToolFileHref(tool: ToolCallItem): string | undefined {
  if (tool.targetKind !== 'path' || !tool.target) return undefined;
  const trimmed = tool.target.trim();
  if (!trimmed) return undefined;
  try {
    return toFileUri(trimmed);
  } catch {
    return undefined;
  }
}

function computeToolMeta(tool: ToolCallItem): readonly (readonly SpanData[])[] | undefined {
  const meta: Array<readonly SpanData[]> = [];
  if (tool.diffs.length > 0) {
    let added = 0;
    let removed = 0;
    for (const d of tool.diffs) {
      const stats = getDiffLineStats(d);
      added += stats.added;
      removed += stats.removed;
    }
    const spans: SpanData[] = [];
    if (added > 0) spans.push({ t: `+${added}`, s: 'ins mono' });
    if (added > 0 && removed > 0) spans.push({ t: ' ' });
    if (removed > 0) spans.push({ t: `−${removed}`, s: 'del mono' });
    if (spans.length > 0) meta.push(spans);
  } else if (tool.displayName === 'read' && tool.outputText.length > 0) {
    const lineCount = tool.outputText.split(/\r?\n/).length;
    meta.push([{ t: `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`, s: 'muted mono' }]);
  }
  return meta.length > 0 ? meta : undefined;
}

function renderToolFileRow(tool: ToolCallItem): JSX.Element | null {
  const filePath = tool.target?.trim();
  if (!filePath) return null;
  const { dir, name } = splitPathDirAndName(filePath);
  const lineCount =
    tool.outputText.length > 0 ? tool.outputText.split(/\r?\n/).length : undefined;
  const locLine = tool.locations[0]?.line;
  const href = resolveToolFileHref(tool);

  const pathSpans: SpanData[] = [
    ...(dir ? [{ t: dir, s: 'path dim' as const }] : []),
    { t: name, s: 'path strong' as const },
    ...(locLine !== undefined ? [{ t: `:${locLine}`, s: 'dim mono' as const }] : []),
  ];

  return (
    <row key="file" role="omp.tool.file" gap="xs" align="center" href={href}>
      <icon key="icon" name="file" />
      <text key="path" spans={pathSpans} wrap="none" truncate="middle" grow={1} />
      {lineCount !== undefined ? (
        <badge
          key="lines"
          text={`${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`}
          tone="muted"
        />
      ) : null}
    </row>
  );
}

function renderBashRunBody(
  tool: ToolCallItem,
  toolPreviewLines: number,
  turnStatus: TranscriptTurn['status'],
  now: number
): JSX.Element {
  const runTone =
    tool.status === 'error'
      ? 'error'
      : tool.status === 'cancelled'
        ? 'warning'
        : tool.status === 'done'
          ? 'success'
          : undefined;
  const cmdText = tool.target || tool.title;
  const isRunning =
    tool.status === 'running' && tool.endedAt === undefined && turnStatus === 'streaming';
  const liveAgeMs = Math.max(0, now - tool.startedAt);
  const stoppedMs =
    tool.tookMs !== undefined
      ? tool.tookMs
      : !tool.replayed && tool.endedAt !== undefined
        ? Math.max(0, tool.endedAt - tool.startedAt)
        : undefined;
  const stateLabel =
    isRunning
      ? 'running'
      : tool.status === 'ask'
        ? 'awaiting approval'
        : tool.status === 'cancelled'
          ? 'cancelled'
          : tool.exitCode !== undefined
            ? `exit ${tool.exitCode}`
            : tool.status;
  const stateStyle =
    tool.status === 'error' || (tool.exitCode !== undefined && tool.exitCode !== 0)
      ? 'error mono'
      : tool.status === 'done'
        ? 'success mono'
        : 'muted mono';

  // Use `node('code', ...)` so `preview: { lines: 6 }` passes cleanly over the wire
  // matching `omp`'s native bash command truncation without altering vendor props.ts.
  const cmdNode = cmdText
    ? node('code', {
        key: 'cmd',
        role: 'omp.tool.bash.command',
        lang: 'bash',
        text: cmdText,
        wrap: true,
        preview: { lines: 6 },
      })
    : null;

  return (
    <col key="run" role="omp.run" gap="none" tone={runTone}>
      {cmdNode}
      {tool.outputText.length > 0 ? (
        <ansi
          key="out"
          role="omp.tool.bash.output"
          text={tool.outputText}
          preview={{ lines: toolPreviewLines }}
          follow={isRunning}
        />
      ) : null}
      {tool.status !== 'pending' ? (
        <row key="foot" role="omp.run.foot" gap="sm" align="center">
          <text
            key="state"
            role="omp.run.state"
            spans={[{ t: stateLabel, s: stateStyle }]}
          />
          {isRunning ? (
            <elapsed key="time-live" role="omp.run.time" age={liveAgeMs} format="short" />
          ) : stoppedMs !== undefined ? (
            <elapsed key="time" role="omp.run.time" stopped={stoppedMs} format="short" />
          ) : null}
        </row>
      ) : null}
    </col>
  );
}

function renderToolBody(
  tool: ToolCallItem,
  toolPreviewLines: number,
  turnStatus: TranscriptTurn['status'],
  now: number
): JSX.Element[] {
  if (tool.displayName === 'bash') {
    const hasRunContent =
      Boolean(tool.target || tool.title) ||
      tool.outputText.length > 0 ||
      tool.status !== 'pending';
    return hasRunContent ? [renderBashRunBody(tool, toolPreviewLines, turnStatus, now)] : [];
  }

  const children: JSX.Element[] = [];

  if (tool.diffs.length > 0) {
    tool.diffs.forEach((d, idx) => {
      children.push(
        <diff
          key={`diff-${idx}`}
          role="omp.tool.edit.file"
          path={d.path}
          text={formatUnifiedDiff(d)}
          mode="auto"
        />
      );
    });
  }

  if (tool.outputText.length > 0) {
    if (tool.displayName === 'read') {
      const fileRow = renderToolFileRow(tool);
      if (fileRow) children.push(fileRow);
      children.push(
        <code
          key="out"
          text={tool.outputText}
          path={tool.target}
          numbers
        />
      );
    } else {
      children.push(
        <ansi
          key="out"
          text={tool.outputText}
          preview={{ lines: toolPreviewLines }}
          follow={
            tool.status === 'running' &&
            tool.endedAt === undefined &&
            turnStatus === 'streaming'
          }
        />
      );
    }
  } else if (tool.status === 'ask' && tool.rawInput !== undefined) {
    children.push(
      <code
        key="input"
        lang="json"
        text={safeFormatInput(tool.rawInput)}
      />
    );
  }

  return children;
}

function renderAgentRow(
  agent: SubagentEntry,
  turnStatus: TranscriptTurn['status'],
  now: number,
  onToggleAgent: (agentId: string, collapsed: boolean) => void
): JSX.Element {
  const isRunning =
    agent.status === 'running' && agent.endedAt === undefined && turnStatus === 'streaming';
  const stats = isRunning
    ? { age: Math.max(0, now - agent.startedAt) }
    : agent.endedAt !== undefined
      ? { took: Math.max(0, agent.endedAt - agent.startedAt) }
      : undefined;
  const hasDetails = Boolean(agent.outputPreview || agent.task);
  const collapsed = agent.collapsed ?? true;

  return (
    <agent
      key={agent.id}
      name={agent.name}
      agent={agent.kind}
      task={agent.task}
      status={agent.status}
      model={agent.model}
      stats={stats}
      badges={agent.workspace ? [{ text: agent.workspace, tone: 'muted' }] : undefined}
      collapsible={hasDetails}
      collapsed={collapsed}
      onToggle={ev => onToggleAgent(agent.id, ev.collapsed ?? !collapsed)}
    >
      {agent.task ? (
        <text
          key="assignment"
          role="omp.task.assignment"
          text={agent.task}
          wrap="word"
        />
      ) : null}
      {agent.outputPreview ? (
        <md key="output" role="omp.task.output" text={agent.outputPreview} />
      ) : null}
    </agent>
  );
}

function renderToolItem(
  tool: ToolCallItem,
  relatedAgents: readonly SubagentEntry[],
  toolPreviewLines: number,
  expandAllTools: boolean,
  turnStatus: TranscriptTurn['status'],
  now: number,
  callbacks: TranscriptCallbacks
): JSX.Element {
  const isAsk = tool.status === 'ask';
  const isToolRunning =
    tool.status === 'running' && tool.endedAt === undefined && turnStatus === 'streaming';
  const toolAge = isToolRunning ? Math.max(0, now - tool.startedAt) : undefined;
  const toolTook = isToolRunning
    ? undefined
    : tool.tookMs !== undefined
      ? tool.tookMs
      : !tool.replayed && tool.endedAt !== undefined
        ? Math.max(0, tool.endedAt - tool.startedAt)
        : undefined;
  const approvalHandlers = isAsk
    ? {
        allow: () => callbacks.onApproveTool(tool.toolCallId, 'allow'),
        always: () => callbacks.onApproveTool(tool.toolCallId, 'always'),
        deny: () => callbacks.onApproveTool(tool.toolCallId, 'deny'),
      }
    : undefined;

  if (relatedAgents.length > 0) {
    return (
      <tool
        key={tool.toolCallId}
        role="omp.tool.task"
        name="task"
        title="Task"
        target={tool.title}
        targetKind="text"
        status={tool.status}
        age={toolAge}
        took={toolTook}
        frame="card"
        confirm={isAsk ? 'card' : undefined}
        ask={isAsk ? tool.ask : undefined}
        approved={tool.approved}
        onAction={approvalHandlers}
      >
        {relatedAgents.map(ag => renderAgentRow(ag, turnStatus, now, callbacks.onToggleAgent))}
      </tool>
    );
  }

  const bodyNodes = renderToolBody(tool, toolPreviewLines, turnStatus, now);
  const hasBody = bodyNodes.length > 0;
  const frame = resolveToolFrame(tool);
  const toolRole = `omp.tool.${tool.displayName}`;
  const effectiveCollapsed = isAsk
    ? false
    : tool.userToggled
      ? tool.collapsed
      : expandAllTools
        ? false
        : tool.collapsed;
  const href = resolveToolFileHref(tool);
  const meta = computeToolMeta(tool);
  const previewProp =
    frame === 'inline'
      ? ('none' as const)
      : tool.displayName !== 'bash' && hasBody
        ? { lines: toolPreviewLines }
        : undefined;

  return (
    <tool
      key={tool.toolCallId}
      role={toolRole}
      name={tool.displayName}
      title={resolveToolVerbTitle(tool)}
      target={tool.target}
      targetKind={tool.targetKind}
      href={href}
      meta={meta}
      exit={tool.exitCode}
      status={tool.status}
      age={toolAge}
      took={toolTook}
      frame={frame}
      collapsible={hasBody && !isAsk}
      collapsed={effectiveCollapsed}
      preview={previewProp}
      confirm={isAsk ? 'card' : undefined}
      ask={isAsk ? tool.ask : undefined}
      approved={tool.approved}
      onToggle={ev =>
        callbacks.onToggleTool(tool.toolCallId, ev.collapsed ?? !effectiveCollapsed)
      }
      onAction={approvalHandlers}
    >
      {bodyNodes}
    </tool>
  );
}

function renderNotice(
  notice: NoticeItem,
  onToggleNotice: (noticeId: string, collapsed: boolean) => void
): JSX.Element {
  if (notice.kind === 'compaction') {
    return (
      <section
        key={notice.id}
        role="omp.compaction"
        head={notice.text}
        collapsible
        collapsed={notice.collapsed}
        onToggle={ev => onToggleNotice(notice.id, ev.collapsed ?? !notice.collapsed)}
      >
        <text
          key="caption"
          role="omp.compaction.caption"
          spans={[
            {
              t: notice.status
                ? `Compaction · ${notice.status}`
                : 'Compacted context summary',
              s: 'muted',
            },
          ]}
        />
        {notice.summaryText.length > 0 ? (
          <md key="summary" text={notice.summaryText} />
        ) : null}
      </section>
    );
  }

  return (
    <row
      key={notice.id}
      role={`omp.notice.${notice.level}`}
      tone={notice.level}
      gap="sm"
      align="start"
    >
      <icon
        key="icon"
        name={notice.level === 'info' ? 'info' : 'warn'}
        tone={notice.level}
      />
      <text key="text" text={notice.text} wrap="word" grow={1} shrink={1} />
    </row>
  );
}

function renderQuestionCard(
  card: ActiveQuestionCard,
  callbacks: TranscriptCallbacks
): JSX.Element {
  if (card.mode === 'url') {
    return (
      <card
        key="questions"
        head={card.message || 'External Action Required'}
        icon="globe"
        tone="warning"
      >
        <col key="body" gap="sm">
          {card.url ? (
            <text
              key="url"
              spans={[
                { t: 'Open link: ', s: 'muted' },
                { t: card.url, s: 'link', href: card.url },
              ]}
            />
          ) : null}
          <row key="actions" gap="sm">
            <button
              key="accept"
              text="Done"
              variant="primary"
              size="sm"
              onClick={() => callbacks.onQuestionSubmit({})}
            />
            <button
              key="decline"
              text="Decline"
              size="sm"
              onClick={() => callbacks.onQuestionDecline()}
            />
            <button
              key="cancel"
              text="Cancel"
              keys={['esc']}
              size="sm"
              variant="quiet"
              onClick={() => callbacks.onQuestionCancel()}
            />
          </row>
        </col>
      </card>
    );
  }

  const otherInputs = card.items
    .filter(q => Boolean(q.other))
    .map(q => {
      const draftVal = card.otherDrafts[q.id] ?? '';
      const placeholder =
        typeof q.other === 'object' && q.other.placeholder
          ? q.other.placeholder
          : 'Type your answer...';
      return (
        <input
          key={`${q.id}.other`}
          text={draftVal}
          cursor={draftVal.length}
          placeholder={placeholder}
          onEdit={ev => callbacks.onQuestionOtherEdit(q.id, ev)}
          onFocus={() => callbacks.onQuestionOtherFocus(q.id)}
        />
      );
    });

  return (
    <questions
      key="questions"
      variant="steps"
      step={card.step}
      answers={card.answers}
      items={card.items.map(q => ({
        id: q.id,
        prompt: q.prompt,
        description: q.description,
        choices: q.choices,
        multi: q.multi,
        other: q.other,
        required: q.required,
      }))}
      onChange={ev => {
        if (ev.item === undefined) return;
        const val = ev.value;
        if (typeof val === 'string') {
          callbacks.onQuestionChange(ev.item, val);
        } else if (Array.isArray(val)) {
          callbacks.onQuestionChange(
            ev.item,
            val.filter((item): item is string => typeof item === 'string')
          );
        }
      }}
      onAction={{
        submit: ev => {
          const val =
            typeof ev.value === 'object' && ev.value !== null && !Array.isArray(ev.value)
              ? (ev.value as Record<string, unknown>)
              : typeof ev.values === 'object' && ev.values !== null && !Array.isArray(ev.values)
                ? (ev.values as Record<string, unknown>)
                : {};
          callbacks.onQuestionSubmit(val);
        },
        back: () => callbacks.onQuestionBack?.(),
        next: () => callbacks.onQuestionNext?.(),
        skip: () => callbacks.onQuestionSkip?.(),
        decline: () => callbacks.onQuestionDecline(),
        cancel: () => callbacks.onQuestionCancel(),
      }}
    >
      {otherInputs}
    </questions>
  );
}

type TimelineGroup =
  | { readonly kind: 'assistant'; readonly key: string; readonly refs: TurnTimelineRef[] }
  | { readonly kind: 'compact-tools'; readonly key: string; readonly tools: ToolCallItem[] }
  | { readonly kind: 'folded-tools'; readonly key: string; readonly tools: ToolCallItem[] }
  | { readonly kind: 'tool'; readonly tool: ToolCallItem }
  | { readonly kind: 'notice'; readonly notice: NoticeItem };

function isRoutineCollapsibleTool(
  tool: ToolCallItem,
  relatedAgents: readonly SubagentEntry[],
  turnStatus: TranscriptTurn['status'],
): boolean {
  if (relatedAgents.length > 0) return false;
  if (tool.status === 'ask') return false;
  if (tool.status === 'running' && tool.endedAt === undefined && turnStatus === 'streaming') {
    return false;
  }
  return true;
}

function formatToolGroupCategory(tool: ToolCallItem): string {
  switch (tool.displayName) {
    case 'bash':
      return 'Bash';
    case 'read':
      return 'Read';
    case 'edit':
      return 'Edit';
    case 'write':
      return 'Write';
    case 'find':
      return 'Find';
    case 'grep':
      return 'Grep';
    case 'web':
      return 'Web';
    default: {
      const label = tool.rawName?.trim() || tool.displayName?.trim() || tool.title?.trim() || 'Tool';
      return label.replace(/^Run\s+/i, '').trim() || 'Tool';
    }
  }
}

function summarizeFoldedTools(tools: readonly ToolCallItem[]): {
  readonly summary: string;
  readonly totalTookMs: number;
  readonly errorCount: number;
} {
  const counts = new Map<string, number>();
  let totalTookMs = 0;
  let errorCount = 0;

  for (const tool of tools) {
    const cat = formatToolGroupCategory(tool);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
    const ms =
      tool.tookMs !== undefined
        ? tool.tookMs
        : tool.endedAt !== undefined
          ? Math.max(0, tool.endedAt - tool.startedAt)
          : 0;
    totalTookMs += ms;
    if (tool.status === 'error' || (tool.exitCode !== undefined && tool.exitCode !== 0)) {
      errorCount += 1;
    }
  }

  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const topParts = ordered.slice(0, 4).map(([cat, n]) => `${n} ${cat}`);
  if (ordered.length > 4) {
    const rest = ordered.slice(4).reduce((sum, [, n]) => sum + n, 0);
    topParts.push(`+${rest} more`);
  }

  return {
    summary: `${tools.length} tool calls (${topParts.join(' · ')})`,
    totalTookMs,
    errorCount,
  };
}

function groupTurnTimeline(
  turn: TranscriptTurn,
  options: { readonly showThinking: boolean; readonly toolDisplayMode: ToolDisplayMode } = {
    showThinking: true,
    toolDisplayMode: 'all',
  },
): TimelineGroup[] {
  const groups: TimelineGroup[] = [];

  for (const ref of turn.timeline) {
    if (ref.kind === 'thought') {
      if (!options.showThinking) continue;
      const prev = groups[groups.length - 1];
      if (prev && prev.kind === 'assistant') {
        prev.refs.push(ref);
      } else {
        groups.push({ kind: 'assistant', key: `assistant-${ref.id}`, refs: [ref] });
      }
      continue;
    }

    if (ref.kind === 'assistant') {
      const prev = groups[groups.length - 1];
      if (prev && prev.kind === 'assistant') {
        prev.refs.push(ref);
      } else {
        groups.push({ kind: 'assistant', key: `assistant-${ref.id}`, refs: [ref] });
      }
      continue;
    }

    if (ref.kind === 'tool') {
      const tool = turn.toolCalls.find(t => t.toolCallId === ref.id);
      if (!tool) continue;
      const relatedAgents = turn.agents.filter(a => a.toolCallId === tool.toolCallId);
      const isRoutine = isRoutineCollapsibleTool(tool, relatedAgents, turn.status);

      if (options.toolDisplayMode === 'hidden' && isRoutine) {
        continue;
      }

      if (options.toolDisplayMode === 'compact' && isRoutine) {
        const prev = groups[groups.length - 1];
        if (prev && prev.kind === 'folded-tools') {
          prev.tools.push(tool);
        } else if (
          prev &&
          prev.kind === 'tool' &&
          isRoutineCollapsibleTool(
            prev.tool,
            turn.agents.filter(a => a.toolCallId === prev.tool.toolCallId),
            turn.status,
          )
        ) {
          groups[groups.length - 1] = {
            kind: 'folded-tools',
            key: `folded-${prev.tool.toolCallId}`,
            tools: [prev.tool, tool],
          };
        } else {
          groups.push({ kind: 'tool', tool });
        }
        continue;
      }

      const isCompact =
        relatedAgents.length === 0 &&
        tool.status !== 'ask' &&
        resolveToolFrame(tool) === 'inline';

      if (isCompact) {
        const prev = groups[groups.length - 1];
        if (prev && prev.kind === 'compact-tools') {
          prev.tools.push(tool);
        } else if (
          prev &&
          prev.kind === 'tool' &&
          turn.agents.every(a => a.toolCallId !== prev.tool.toolCallId) &&
          prev.tool.status !== 'ask' &&
          resolveToolFrame(prev.tool) === 'inline'
        ) {
          groups[groups.length - 1] = {
            kind: 'compact-tools',
            key: `compact-${prev.tool.toolCallId}`,
            tools: [prev.tool, tool],
          };
        } else {
          groups.push({ kind: 'tool', tool });
        }
      } else {
        groups.push({ kind: 'tool', tool });
      }
      continue;
    }

    if (ref.kind === 'notice') {
      const notice = turn.notices.find(n => n.id === ref.id);
      if (!notice) continue;
      groups.push({ kind: 'notice', notice });
    }
  }

  return groups;
}

function renderTurnFooterNodes(
  turn: TranscriptTurn,
  callbacks: TranscriptCallbacks
): JSX.Element[] {
  if (turn.status === 'streaming') return [];
  const nodes: JSX.Element[] = [];

  if (turn.status === 'cancelled') {
    nodes.push(
      <text
        key="abort"
        role="omp.assistant.abort"
        wrap="word"
        spans={[{ t: 'Aborted', s: 'error' }]}
      />
    );
  }

  if (turn.status === 'error' && turn.errorMessage) {
    const errMsg = turn.errorMessage;
    nodes.push(
      <card
        key="error"
        role="omp.error"
        tone="error"
        icon="warn"
        head="Request failed"
      >
        <col key="body" gap="sm">
          <text
            key="msg"
            role="omp.error.message"
            spans={[{ t: errMsg, s: 'mono' }]}
            lines={8}
            wrap="word"
          />
          <row key="actions" role="omp.error.actions" gap="sm" align="center">
            <button
              key="retry"
              role="omp.error.action"
              text="Retry"
              keys={['f5']}
              icon="restart"
              variant="primary"
              size="sm"
              actions={{ click: 'error.retry' }}
              onClick={() => callbacks.onRetryTurn?.(turn.index)}
            />
            <button
              key="copy"
              role="omp.error.action"
              text="Copy error"
              icon="copy"
              size="sm"
              actions={{ click: 'error.copy' }}
              onClick={() =>
                callbacks.onCopyError
                  ? callbacks.onCopyError(errMsg)
                  : callbacks.onCopyMessage(errMsg)
              }
            />
            <button
              key="model"
              role="omp.error.action"
              text="Switch model"
              keys={['alt+p']}
              icon="model"
              size="sm"
              actions={{ click: 'error.switch-model' }}
              onClick={() => callbacks.onSwitchModel?.()}
            />
          </row>
        </col>
      </card>
    );
  }

  if (turn.status === 'done' && turn.assistantText.trim().length > 0) {
    nodes.push(
      <row key="turn-usage" role="omp.turn.usage" gap="xs" align="center">
        <icon
          key="copy"
          name="copy"
          role="omp.turn.copy"
          title="Copy answer"
          aria="Copy answer"
          actions={{ click: 'copy-answer' }}
          onClick={() => callbacks.onCopyAnswer(turn.assistantText)}
        />
        <text key="dot" text="·" />
        <text key="text" text={formatTurnUsageLabel(turn)} />
      </row>
    );
  }

  return nodes;
}

/**
 * Main transcript region aligned 1:1 with `omp`'s native TSP layout:
 * - Root `<col role="omp.transcript">` (direct child `<col key="turn-N">` keeps ID `main.turn-N`
 *   for `surface.settle()` and `GoneEvent` eviction!)
 * - Welcome card: `<card key="welcome" role="omp.welcome">`
 * - User message: `<card key="user" role="omp.user" tone="user">` with `hour12` timestamp,
 *   full-time hover tooltip, and context menu (`Copy message` / `Edit & resend` / `Retry turn`)
 * - Assistant container: `<col role="omp.assistant">` with `<section role="omp.thinking|omp.thinking.live" took={...}>`
 *   controlled by `showThinking` / `expandAllTools`, direct `<md>`, `omp.error` with action bar, and `omp.turn.usage`
 * - Tools: `<tool role="omp.tool.<name>" frame="inline|card">` with `preview="none"` & `href` on inline tools,
 *   `omp.tool.file` path rows, live `<elapsed role="omp.run.time">` & truncated bash commands, and `omp.tool.task`
 */
export function TranscriptView(props: TranscriptViewProps): JSX.Element {
  const { state, turns, plan, version, toolPreviewLines, callbacks } = props;
  const now = props.now ?? Date.now();
  const lastTurn = turns[turns.length - 1];

  const welcomeTipSpans: readonly (string | SpanData)[] = [
    { t: 'Type ', s: 'muted' },
    { t: '/resume', s: 'code' },
    { t: ' to restore sessions, ', s: 'muted' },
    { t: '/model', s: 'code' },
    { t: ' to switch models, ', s: 'muted' },
    { t: '/settings', s: 'code' },
    { t: ' for preferences, or ', s: 'muted' },
    { t: '/help', s: 'code' },
    { t: ' for shortcuts', s: 'muted' },
  ];

  return (
    <col role="omp.transcript">
      {turns.length === 0 ? (
        <card key="welcome" role="omp.welcome">
          <row key="lockup" align="center" gap="md" role="omp.welcome.lockup">
            {state.welcomeLogoBlobId ? (
              <image
                key="logo"
                blob={state.welcomeLogoBlobId}
                alt="oma"
                w={WELCOME_LOGO_WIDTH}
                h={WELCOME_LOGO_HEIGHT}
                role="omp.welcome.logo"
              />
            ) : (
              <image
                key="logo"
                builtin="omp"
                alt="oma"
                w={128}
                role="omp.welcome.logo"
              />
            )}
            <col key="mark" role="omp.welcome.mark">
              <text
                key="omp.welcome.wordmark"
                wrap="none"
                role="omp.welcome.wordmark"
                spans={[{ t: 'oma', s: 'strong' }]}
              />
              <text
                key="omp.welcome.version"
                wrap="none"
                role="omp.welcome.version"
                spans={[{ t: `v${version}`, s: 'dim mono' }]}
              />
            </col>
          </row>
          <row key="tip" gap="sm" align="start" role="omp.welcome.tip">
            <icon key="icon" name="lightbulb" role="omp.welcome.tip-icon" />
            <text
              key="text"
              wrap="word"
              role="omp.welcome.tip-text"
              spans={welcomeTipSpans}
            />
          </row>
        </card>
      ) : null}

      {turns.map(turn => {
        const isLastTurn = lastTurn?.index === turn.index;
        const lastTimelineRef = turn.timeline[turn.timeline.length - 1];
        const groups = groupTurnTimeline(turn, {
          showThinking: state.showThinking,
          toolDisplayMode: state.toolDisplayMode,
        });
        const footerNodes = renderTurnFooterNodes(turn, callbacks);

        let lastAssistantGroupIdx = -1;
        for (let i = groups.length - 1; i >= 0; i--) {
          if (groups[i]?.kind === 'assistant') {
            lastAssistantGroupIdx = i;
            break;
          }
        }

        const userImageAttachments =
          turn.user?.attachments.filter(att => att.kind === 'image' && Boolean(att.blobId)) ?? [];
        const userBadgeAttachments =
          turn.user?.attachments.filter(att => !(att.kind === 'image' && Boolean(att.blobId))) ?? [];

        const userTs = turn.user ? (turn.user.createdAt || turn.user.timestamp) : 0;
        const userTimeDisplay = turn.user
          ? formatTurnTime(userTs, state.hour12)
          : '';
        const userTimeFull = turn.user
          ? formatFullLocalTime(userTs, state.hour12)
          : '';

        return (
          <col key={`turn-${turn.index}`}>
            {turn.user ? (
              <card
                key="user"
                role="omp.user"
                tone="user"
                actions={{
                  menu: [
                    { id: 'copy-message', label: 'Copy message', icon: 'copy' },
                    { id: 'edit-resend', label: 'Edit & resend', icon: 'pencil' },
                    { id: 'retry-turn', label: 'Retry turn', icon: 'restart' },
                  ],
                }}
                onMenu={{
                  'copy-message': () => callbacks.onCopyMessage(turn.user!.text),
                  'edit-resend': () => callbacks.onEditAndResend?.(turn.user!.text),
                  'retry-turn': () => callbacks.onRetryTurn?.(turn.index),
                }}
              >
                <row key="tools" gap="xs" align="center" role="omp.user.tools">
                  <icon
                    key="copy"
                    name="copy"
                    role="omp.user.tool"
                    title="Copy message"
                    aria="Copy message"
                    actions={{ click: 'copy-message' }}
                    onClick={() => callbacks.onCopyMessage(turn.user!.text)}
                  />
                  <text key="dot" text="·" />
                  <text
                    key="time"
                    role="omp.user.time"
                    title={userTimeFull}
                    spans={[{ t: userTimeDisplay, s: 'dim mono' }]}
                  />
                </row>

                {userImageAttachments.length > 0 ? (
                  <row key="images" gap="sm" wrap align="start" role="omp.user.images">
                    {userImageAttachments.map(img => (
                      <image key={img.id} blob={img.blobId} alt={img.name} />
                    ))}
                  </row>
                ) : null}

                {turn.user.text.length > 0 ? (
                  <md key="body" text={turn.user.text} cwd={state.displayCwd} icons />
                ) : null}

                {userBadgeAttachments.length > 0 ? (
                  <row key="badges" gap="xs" justify="end" role="omp.user.badges">
                    {userBadgeAttachments.map(att => (
                      <attachment
                        key={att.id}
                        name={att.name}
                        ext={att.ext}
                        mime={att.mime}
                        size={att.size}
                        blob={att.blobId}
                        path={att.path}
                        variant="chip"
                      />
                    ))}
                  </row>
                ) : null}
              </card>
            ) : null}

            {groups.map((group, groupIdx) => {
              if (group.kind === 'assistant') {
                const isFinalAssistantGroup = groupIdx === lastAssistantGroupIdx;
                return (
                  <col key={group.key} role="omp.assistant">
                    {group.refs.map(ref => {
                      if (ref.kind === 'thought') {
                        if (!state.showThinking) return null;
                        const thought = turn.thoughts.find(t => t.id === ref.id);
                        if (!thought) return null;
                        const isLive =
                          thought.status === 'running' &&
                          thought.endedAt === undefined &&
                          turn.status === 'streaming';
                        const elapsedMs = isLive
                          ? Math.max(0, now - thought.startedAt)
                          : thought.tookMs !== undefined
                            ? thought.tookMs
                            : thought.replayed
                              ? undefined
                              : thought.endedAt !== undefined
                                ? Math.max(0, thought.endedAt - thought.startedAt)
                                : turn.endedAt !== undefined
                                  ? Math.max(0, turn.endedAt - thought.startedAt)
                                  : undefined;
                        const durText =
                          elapsedMs !== undefined ? formatShortDuration(elapsedMs) : undefined;
                        const effectiveOpen = thought.userToggled
                          ? thought.open
                          : state.expandAllTools
                            ? true
                            : thought.open;

                        return (
                          <section
                            key={thought.id}
                            role={isLive ? 'omp.thinking.live' : 'omp.thinking'}
                            took={isLive ? undefined : elapsedMs}
                            collapsible
                            collapsed={!effectiveOpen}
                            head={
                              isLive ? (
                                <row gap="sm" align="center">
                                  <spinner
                                    key="spin"
                                    style="starburst"
                                    role="omp.thinking.spin"
                                  />
                                  <text key="lbl" spans={[{ t: 'Thinking…', s: 'muted' }]} />
                                  <elapsed key="age" age={elapsedMs ?? 0} format="short" />
                                </row>
                              ) : (
                                [
                                  {
                                    t: durText ? `Thought for ${durText}` : 'Thought',
                                    s: 'muted',
                                  },
                                ]
                              )
                            }
                            onToggle={ev => {
                              const nextOpen =
                                ev.collapsed !== undefined
                                  ? !ev.collapsed
                                  : (ev.open ?? !effectiveOpen);
                              callbacks.onToggleThought(thought.id, nextOpen);
                            }}
                          >
                            <md key="body" text={thought.text} stream={isLive} />
                          </section>
                        );
                      }

                      if (ref.kind === 'assistant') {
                        const seg = turn.assistantSegments.find(s => s.id === ref.id);
                        if (!seg) return null;
                        const isActiveTrailingAssistant =
                          lastTimelineRef?.kind === 'assistant' && lastTimelineRef.id === seg.id;
                        const isStreamingSeg =
                          turn.status === 'streaming' && isLastTurn && isActiveTrailingAssistant;

                        return (
                          <md
                            key={seg.id}
                            text={seg.text}
                            stream={isStreamingSeg}
                            cwd={state.displayCwd}
                            icons
                          />
                        );
                      }

                      return null;
                    })}
                    {isFinalAssistantGroup ? footerNodes : null}
                  </col>
                );
              }

              if (group.kind === 'folded-tools') {
                const groupId = `turn-${turn.index}:${group.key}`;
                const expanded = Boolean(state.expandedToolGroups[groupId]);
                const { summary, totalTookMs, errorCount } = summarizeFoldedTools(group.tools);
                const durText = totalTookMs > 0 ? formatShortDuration(totalTookMs) : undefined;
                return (
                  <section
                    key={group.key}
                    role="oma.tool.group"
                    collapsible
                    collapsed={!expanded}
                    took={totalTookMs > 0 ? totalTookMs : undefined}
                    head={
                      <row key="head" gap="xs" align="center">
                        <icon key="ic" name="tools" tone={errorCount > 0 ? 'warning' : 'muted'} />
                        <text
                          key="lbl"
                          spans={[
                            { t: summary, s: 'muted' },
                            ...(durText ? [{ t: ` · ${durText}`, s: 'dim mono' as const }] : []),
                          ]}
                          wrap="none"
                          truncate="end"
                        />
                        {errorCount > 0 ? (
                          <badge
                            key="err"
                            text={`${errorCount} ${errorCount === 1 ? 'error' : 'errors'}`}
                            tone="error"
                          />
                        ) : null}
                      </row>
                    }
                    onToggle={ev => {
                      const nextExpanded =
                        ev.collapsed !== undefined
                          ? !ev.collapsed
                          : (ev.open ?? !expanded);
                      callbacks.onToggleToolGroup?.(groupId, nextExpanded);
                    }}
                  >
                    <col key="items" gap="none">
                      {group.tools.map(tool =>
                        renderToolItem(
                          tool,
                          [],
                          toolPreviewLines,
                          state.expandAllTools,
                          turn.status,
                          now,
                          callbacks
                        )
                      )}
                    </col>
                  </section>
                );
              }

              if (group.kind === 'compact-tools') {
                return (
                  <col key={group.key} role="omp.compact" gap="none">
                    {group.tools.map(tool =>
                      renderToolItem(
                        tool,
                        [],
                        toolPreviewLines,
                        state.expandAllTools,
                        turn.status,
                        now,
                        callbacks
                      )
                    )}
                  </col>
                );
              }

              if (group.kind === 'tool') {
                const relatedAgents = turn.agents.filter(
                  a => a.toolCallId === group.tool.toolCallId
                );
                return renderToolItem(
                  group.tool,
                  relatedAgents,
                  toolPreviewLines,
                  state.expandAllTools,
                  turn.status,
                  now,
                  callbacks
                );
              }

              return renderNotice(group.notice, callbacks.onToggleNotice);
            })}

            {lastAssistantGroupIdx === -1 && footerNodes.length > 0 ? (
              <col key="assistant-end" role="omp.assistant">
                {footerNodes}
              </col>
            ) : null}
          </col>
        );
      })}

      {plan && plan.entries.length > 0 ? (
        <tool
          key="plan"
          role="omp.tool.todo"
          name="todo"
          title="Todo"
          target={`${plan.entries.filter(e => e.status === 'done').length}/${plan.entries.length}`}
          targetKind="text"
          status={plan.entries.every(e => e.status === 'done') ? 'done' : 'running'}
          frame="card"
        >
          <checklist
            key="checklist"
            mode="full"
            phases={[
              {
                id: 'plan',
                title: 'Plan',
                items: plan.entries.map(e => ({
                  id: e.id,
                  text: e.text,
                  status: e.status,
                  note: e.priority ? `[${e.priority}]` : undefined,
                })),
              },
            ]}
          />
        </tool>
      ) : null}

      {state.activeQuestion ? renderQuestionCard(state.activeQuestion, callbacks) : null}

      {state.authRequired ? (
        <card
          key="auth-required"
          head="Authentication Required"
          icon="lock"
          tone="warning"
        >
          <col key="body" gap="sm">
            <text key="msg" text={state.authRequired.message} />
            {state.authRequired.authMethods.length > 0 ? (
              <kv
                key="methods"
                layout="grid"
                items={state.authRequired.authMethods.map(m => ({
                  k: m.name,
                  v: m.description || m.id,
                }))}
              />
            ) : null}
            <row key="actions" gap="sm">
              <button
                key="login"
                text="Login (agy acp --login)"
                icon="log-in"
                variant="primary"
                size="sm"
                onClick={() => callbacks.onLoginAuth()}
              />
              <button
                key="dismiss"
                text="Dismiss"
                size="sm"
                variant="quiet"
                onClick={() => callbacks.onDismissAuth()}
              />
            </row>
          </col>
        </card>
      ) : null}

      {state.crashError ? (
        <card
          key="crash-banner"
          role="omp.error"
          head="agy acp process exited unexpectedly"
          icon="warn"
          tone="error"
          end={
            <button
              key="retry"
              role="omp.error.action"
              text="Retry"
              icon="restart"
              variant="primary"
              size="sm"
              onClick={() => callbacks.onRetryCrash()}
            />
          }
        >
          <col key="body" gap="xs">
            <text
              key="msg"
              role="omp.error.message"
              text={state.crashError.message}
              lines={8}
              wrap="word"
            />
            {state.crashError.stderrTail.trim().length > 0 ? (
              <code key="stderr" text={state.crashError.stderrTail} />
            ) : null}
          </col>
        </card>
      ) : null}
    </col>
  );
}
