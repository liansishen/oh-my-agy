/**
 * Conversation transcript state model & ACP `session/update` consumer.
 *
 * Covers:
 * - Turn, UserMessage, ThoughtBlock, ToolCallItem, Subagent/Swarm entries,
 *   PlanState, ActiveQuestionCard (`elicitation/create`), Notice/Compaction items
 * - ACP tool status -> TSP `<tool status>` mapping & `run_command` `rawOutput.exit_code`
 * - Windows path normalization via `src/acp/path`
 * - Semantic parsing for `swarm` & `invoke_subagent`
 * - Settled (`main.turn-<index>`) and `GoneEvent`-evicted turn tracking
 */

import { normalizeDisplayPath } from '../acp/path';
import {
  extractContentText,
  extractNoticeText,
  extractToolExitCode,
  extractToolOutputText,
  isKnownSessionUpdate,
  mapAcpToolStatusToTsp,
  mapPlanStatusToChecklist,
  type AvailableCommand,
  type ConfigOption,
  type ElicitationCreateParams,
  type ElicitationCreateResult,
  type JsonRpcId,
  type JsonSchemaProperty,
  type PermissionToolCallRef,
  type PlanEntryPriority,
  type SessionUpdate,
  type StopReason,
  type ToolCallContent,
  type ToolCallDiffContent,
  type ToolCallFields,
  type ToolCallKind,
  type ToolCallLocation,
  type ToolCallStatus,
  type TspChecklistStatus,
  type TspToolStatus,
  type UnknownSessionUpdate,
} from '../acp/protocol';
import type { ApprovalDecision, MappedPermissionOptions } from './approval';

// ---------------------------------------------------------------------------
// Data Models
// ---------------------------------------------------------------------------

export interface AttachmentItem {
  readonly id: string;
  readonly kind: 'image' | 'file';
  readonly name: string;
  readonly mime?: string;
  readonly ext?: string;
  readonly size?: number;
  /** TSP blob id returned by `session.blob(...)` for images. */
  readonly blobId?: string;
  /** Base64 payload for ACP image content block. */
  readonly base64Data?: string;
  /** Workspace-relative or absolute path for `@file` attachments. */
  readonly path?: string;
  /** RFC 8089 `file:///` URI for ACP `resource` / `resource_link`. */
  readonly uri?: string;
}

export interface UserMessageItem {
  readonly id: string;
  text: string;
  readonly timestamp: number;
  /** Full epoch millisecond timestamp for `hour12` formatting & hover tooltips. */
  readonly createdAt: number;
  readonly timeLabel: string;
  attachments: AttachmentItem[];
}

export interface ThoughtBlock {
  readonly id: string;
  text: string;
  status: 'running' | 'done';
  readonly startedAt: number;
  endedAt?: number;
  /** Total elapsed reasoning duration in milliseconds (`endedAt - startedAt`). */
  tookMs?: number;
  open: boolean;
  userToggled: boolean;
}

export interface ToolDiffItem {
  readonly path: string;
  readonly oldText?: string | null;
  readonly newText?: string;
  readonly patchText?: string;
}

export type TspToolTargetKind = 'command' | 'path' | 'pattern' | 'query' | 'text';

export interface ToolCallItem {
  readonly toolCallId: string;
  acpStatus: ToolCallStatus;
  status: TspToolStatus;
  kind?: ToolCallKind | (string & {});
  rawName?: string;
  /** Mapped TSP `<tool name>` (e.g. bash, read, edit, search, web). */
  displayName: string;
  /** Mapped TSP `<tool targetKind>`. */
  targetKind: TspToolTargetKind;
  title: string;
  target?: string;
  args?: Record<string, unknown>;
  rawInput?: unknown;
  rawOutput?: unknown;
  exitCode?: number;
  outputText: string;
  diffs: ToolDiffItem[];
  locations: ToolCallLocation[];
  readonly startedAt: number;
  endedAt?: number;
  tookMs?: number;
  collapsed: boolean;
  userToggled?: boolean;
  awaitingPermission: boolean;
  permissionRequestId?: JsonRpcId;
  ask?: MappedPermissionOptions['ask'];
  approved?: 'once' | 'always' | 'denied';
  cancelled: boolean;
}

export type SubagentTspStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'idle'
  | 'parked';

export interface SubagentEntry {
  readonly id: string;
  readonly toolCallId: string;
  readonly kind: 'swarm' | 'subagent';
  name: string;
  action?: string;
  task?: string;
  model?: string;
  workspace?: string;
  status: SubagentTspStatus;
  readonly startedAt: number;
  endedAt?: number;
  outputPreview?: string;
  collapsed?: boolean;
}

export interface AssistantSegment {
  readonly id: string;
  text: string;
}

export interface NoticeItem {
  readonly id: string;
  readonly kind: 'compaction' | 'notice';
  level: 'info' | 'warning' | 'error';
  status?: string;
  text: string;
  summaryText: string;
  collapsed: boolean;
  readonly timestamp: number;
}

export interface PlanItemState {
  readonly id: string;
  readonly text: string;
  readonly priority?: PlanEntryPriority;
  readonly status: TspChecklistStatus;
}

export interface PlanState {
  readonly entries: readonly PlanItemState[];
  readonly updatedAt: number;
}

export interface QuestionChoiceItem {
  readonly value: string;
  readonly label?: string;
  readonly detail?: string;
}

export interface QuestionItem {
  readonly id: string;
  readonly prompt: string;
  readonly description?: string;
  readonly fieldType: 'single' | 'multi' | 'boolean' | 'text' | 'number';
  readonly choices?: readonly QuestionChoiceItem[];
  readonly multi: boolean;
  readonly other: boolean | { readonly placeholder?: string };
  /** Paired free-text schema property key (e.g. `q1_other` from `agy acp`) merged into this choice question's Other input. */
  readonly writeInFieldId?: string;
  readonly required: boolean;
  readonly rawSchema?: JsonSchemaProperty;
}

export interface ActiveQuestionCard {
  readonly requestId: JsonRpcId;
  readonly mode: 'form' | 'url';
  readonly message?: string;
  readonly url?: string;
  readonly items: readonly QuestionItem[];
  step: number;
  answers: Record<string, string | string[]>;
  otherDrafts: Record<string, string>;
  /** Question id whose `<id>.other` input currently holds focus, or null. */
  focusedOtherId: string | null;
  readonly createdAt: number;
  readonly resolve: (result: ElicitationCreateResult) => void;
}

export type TurnTimelineRef =
  | { readonly kind: 'thought'; readonly id: string }
  | { readonly kind: 'tool'; readonly id: string }
  | { readonly kind: 'assistant'; readonly id: string }
  | { readonly kind: 'notice'; readonly id: string };

export interface TranscriptTurn {
  readonly index: number;
  /** Full TSP node ID: `main.turn-<index>`. */
  readonly nodeId: string;
  user?: UserMessageItem;
  readonly timeline: TurnTimelineRef[];
  readonly thoughts: ThoughtBlock[];
  readonly toolCalls: ToolCallItem[];
  readonly agents: SubagentEntry[];
  readonly assistantSegments: AssistantSegment[];
  readonly notices: NoticeItem[];
  /** Concatenated assistant reply text for `/copy` and session preview summaries. */
  assistantText: string;
  status: 'streaming' | 'done' | 'cancelled' | 'error';
  stopReason?: StopReason;
  errorMessage?: string;
  readonly startedAt: number;
  /** Full epoch millisecond timestamp when this turn was created. */
  readonly createdAt: number;
  endedAt?: number;
  /** Marked via `surface.settle('main.turn-<index>')`. */
  settled: boolean;
  /** Marked when Tern drops this node via `GoneEvent`. */
  evicted: boolean;
}

export interface PreviewMessageSummary {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export type BackgroundJobType = 'bash' | 'schedule' | 'workflow' | 'task';

export type BackgroundJobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundJobItem {
  readonly id: string;
  readonly toolCallId: string;
  readonly type: BackgroundJobType;
  readonly status: BackgroundJobStatus;
  readonly label: string;
  readonly command?: string;
  readonly title?: string;
  readonly outputText: string;
  readonly exitCode?: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly tookMs?: number;
  readonly turnIndex: number;
  /** Defined for subagent/swarm jobs so HUD `jobs` pill excludes them (`agentId === undefined`) per `omp`. */
  readonly agentId?: string;
  readonly agentKind?: 'swarm' | 'subagent';
  readonly model?: string;
  readonly workspace?: string;
}

export interface BackgroundJobsSnapshot {
  /** Currently running jobs (both non-agent jobs and subagent/swarm jobs), newest first. */
  readonly running: readonly BackgroundJobItem[];
  /** Recently settled jobs (capped to 30 most recent), newest first. */
  readonly recent: readonly BackgroundJobItem[];
  /** Combined list (`[...running, ...recent]`) for `/jobs` master list. */
  readonly all: readonly BackgroundJobItem[];
  /** Running non-agent jobs (`agentId === undefined`) counted by HUD `jobs` segment. */
  readonly runningJobCount: number;
  /** Running non-swarm subagent count (`invoke_subagent`) tracked in transcript. */
  readonly runningSubagentCount: number;
  /** Running swarm entries tracked in transcript. */
  readonly runningSwarmAgentCount: number;
  /** Total running subagent + swarm entries tracked in transcript. */
  readonly runningAgentCount: number;
  /** Total inspectable subagent + swarm entries tracked in transcript. */
  readonly inspectableAgentCount: number;
  /** Running detached background tasks that continue after `end_turn` (async bash, subagent, schedule, workflow). */
  readonly detachedTaskCount: number;
  /** True when any running tool call, subagent, or detached background task is still active. */
  readonly hasActiveBackgroundTasks: boolean;
  /** Concise single-line summaries for running non-agent jobs (used in HUD `jobs` tooltip). */
  readonly runningJobSummaries: readonly string[];
}

export interface DetachedBackgroundTask {
  readonly id: string;
  readonly toolCallId: string;
  readonly taskId?: string;
  readonly conversationId?: string;
  readonly type: BackgroundJobType;
  readonly label: string;
  readonly command?: string;
  readonly title?: string;
  readonly agentKind?: 'subagent';
  readonly model?: string;
  readonly startedAt: number;
  readonly turnIndex: number;
  status: BackgroundJobStatus;
  endedAt?: number;
  outputText: string;
}

export type ContextBreakdownCategory = 'user' | 'assistant' | 'thought' | 'tool';

export interface ContextCategoryEstimate {
  readonly category: ContextBreakdownCategory;
  readonly chars: number;
  readonly estimatedTokens: number;
  /** Share of total estimated tokens (`0..100`). */
  readonly sharePercent: number;
}

export interface ContextBreakdown {
  readonly categories: readonly ContextCategoryEstimate[];
  readonly totalChars: number;
  readonly totalEstimatedTokens: number;
  readonly turnCount: number;
  readonly userChars: number;
  readonly assistantChars: number;
  readonly thoughtChars: number;
  readonly toolChars: number;
  readonly reportedUsedTokens?: number;
  readonly contextWindowSize?: number;
  readonly usedPercent?: number;
}

export interface ApplySessionUpdateOptions {
  readonly autoCollapseThought?: boolean;
  readonly isReplaying?: boolean;
  readonly showThinking?: boolean;
  readonly expandAllTools?: boolean;
}

export interface TranscriptUpdateOutcome {
  readonly handled: boolean;
  readonly unknownUpdateType?: string;
  readonly availableCommands?: readonly AvailableCommand[];
  readonly usage?: {
    readonly used: number;
    readonly size: number;
    readonly cost?: { readonly amount: number; readonly currency: string };
  };
  readonly currentModeId?: string;
  readonly configOptions?: readonly ConfigOption[];
  readonly sessionInfo?: {
    readonly title?: string | null;
    readonly updatedAt?: string | null;
  };
}

// ---------------------------------------------------------------------------
// Helpers: Tool Mapping, Diff Extraction, Subagent/Swarm Parsing, Questions
// ---------------------------------------------------------------------------

export function formatTurnTime(timestamp: number, hour12 = false): string {
  const d = new Date(timestamp);
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (hour12) {
    const rawHours = d.getHours();
    const suffix = rawHours >= 12 ? 'PM' : 'AM';
    const h12 = rawHours % 12 || 12;
    return `${h12}:${mm} ${suffix}`;
  }
  const hh = String(d.getHours()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatFullLocalTime(timestamp: number, hour12 = false): string {
  const d = new Date(timestamp);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (hour12) {
    const rawHours = d.getHours();
    const suffix = rawHours >= 12 ? 'PM' : 'AM';
    const h12 = rawHours % 12 || 12;
    return `${year}-${month}-${day} ${h12}:${mm}:${ss} ${suffix}`;
  }
  const hh = String(d.getHours()).padStart(2, '0');
  return `${year}-${month}-${day} ${hh}:${mm}:${ss}`;
}

function formatTimeLabel(timestamp: number): string {
  return formatTurnTime(timestamp, false);
}

/**
 * Estimate token count from raw text using a lightweight CJK-aware heuristic
 * (~4 chars/token for ASCII, ~1.5 chars/token for non-ASCII / CJK).
 */
export function estimateTokensFromText(text: string): number {
  if (!text || text.length === 0) return 0;
  let ascii = 0;
  let nonAscii = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) {
      ascii++;
    } else {
      nonAscii++;
    }
  }
  return Math.max(1, Math.ceil(ascii / 4 + nonAscii / 1.5));
}

export function mapToolDisplayMeta(
  kind?: string,
  rawName?: string,
): { displayName: string; targetKind: TspToolTargetKind } {
  const k = kind?.toLowerCase();
  const n = rawName?.toLowerCase();

  // Priority 1: ACP standard `kind` (DESIGN.md 4.5.1)
  if (k === 'execute') return { displayName: 'bash', targetKind: 'command' };
  if (k === 'read') return { displayName: 'read', targetKind: 'path' };
  if (k === 'edit' || k === 'delete' || k === 'move') {
    return { displayName: 'edit', targetKind: 'path' };
  }
  if (k === 'search') return { displayName: 'search', targetKind: 'query' };
  if (k === 'fetch') return { displayName: 'web', targetKind: 'text' };

  // Priority 2: tool `name` fallback
  if (n) {
    if (n === 'run_command' || n === 'bash' || n === 'shell' || n === 'exec') {
      return { displayName: 'bash', targetKind: 'command' };
    }
    if (n === 'read_file' || n === 'view_file' || n === 'list_dir') {
      return { displayName: 'read', targetKind: 'path' };
    }
    if (n === 'edit_file' || n === 'write_file' || n === 'replace_file_content') {
      return { displayName: 'edit', targetKind: 'path' };
    }
    if (n.includes('search') || n.includes('grep') || n.includes('find')) {
      return { displayName: 'search', targetKind: 'query' };
    }
    if (n.includes('fetch') || n.includes('web') || n.includes('url')) {
      return { displayName: 'web', targetKind: 'text' };
    }
    return { displayName: rawName ?? 'tool', targetKind: 'text' };
  }

  return { displayName: kind || 'tool', targetKind: 'text' };
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function firstStringField(obj: Record<string, unknown> | null, keys: readonly string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) {
      return v.trim();
    }
  }
  return undefined;
}

function extractToolTarget(
  fields: Pick<ToolCallFields, 'title' | 'args' | 'rawInput' | 'locations'>,
  targetKind: TspToolTargetKind,
): string | undefined {
  const inputRec = asRecord(fields.args) ?? asRecord(fields.rawInput);

  if (targetKind === 'command') {
    const cmd = firstStringField(inputRec, ['CommandLine', 'command', 'cmd', 'script']);
    if (cmd) return cmd;
  }

  if (targetKind === 'path') {
    const locPath = fields.locations?.[0]?.path;
    if (locPath) return normalizeDisplayPath(locPath);
    const p = firstStringField(inputRec, ['Path', 'path', 'file', 'filePath', 'AbsolutePath', 'TargetFile']);
    if (p) return normalizeDisplayPath(p);
  }

  if (targetKind === 'query') {
    const q = firstStringField(inputRec, ['query', 'Query', 'pattern', 'Pattern', 'regex']);
    if (q) return q;
  }

  if (targetKind === 'text') {
    const u = firstStringField(inputRec, ['url', 'Url', 'uri', 'query', 'prompt']);
    if (u) return u;
  }

  if (fields.locations?.[0]?.path) {
    return normalizeDisplayPath(fields.locations[0].path);
  }

  return undefined;
}

function extractDiffItems(content: readonly ToolCallContent[] | undefined): ToolDiffItem[] {
  if (!content || content.length === 0) return [];
  const diffs: ToolDiffItem[] = [];
  for (const item of content) {
    if (item.type === 'diff') {
      const diffItem = item as ToolCallDiffContent;
      diffs.push({
        path: normalizeDisplayPath(diffItem.path),
        ...(diffItem.oldText !== undefined ? { oldText: diffItem.oldText } : {}),
        ...(diffItem.newText !== undefined ? { newText: diffItem.newText } : {}),
        ...(diffItem.patch?.text !== undefined ? { patchText: diffItem.patch.text } : {}),
      });
    }
  }
  return diffs;
}

function extractToolContentText(content: readonly ToolCallContent[] | undefined): string {
  if (!content || content.length === 0) return '';
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === 'content') {
      const txt = extractContentText(item.content);
      if (txt.length > 0) parts.push(txt);
    }
  }
  return parts.join('\n');
}

function mapToolStatusToAgentStatus(status: TspToolStatus): SubagentTspStatus {
  switch (status) {
    case 'pending':
    case 'ask':
      return 'pending';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'aborted';
  }
}

const MAX_RECENT_BACKGROUND_JOBS = 30;

const BASH_TOOL_NAMES = new Set([
  'run_command',
  'bash',
  'shell',
  'exec',
  'command_status',
  'send_command_input',
]);

function collapseSingleLine(text: string, maxLen = 96): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1).trimEnd()}…`;
}

function classifyNonAgentJobType(tool: ToolCallItem): BackgroundJobType | null {
  const rawName = (tool.rawName ?? '').toLowerCase();
  const titleLower = tool.title.toLowerCase();
  const isSwarm = rawName === 'swarm' || titleLower.startsWith('swarm');
  const isSubagent =
    rawName === 'invoke_subagent' ||
    rawName === 'subagent' ||
    titleLower.includes('invoke_subagent');
  if (isSwarm || isSubagent) return null;

  if (
    tool.kind?.toLowerCase() === 'execute' ||
    tool.displayName.toLowerCase() === 'bash' ||
    BASH_TOOL_NAMES.has(rawName) ||
    titleLower === 'run_command' ||
    titleLower.startsWith('run_command') ||
    titleLower.includes('command_status')
  ) {
    return 'bash';
  }
  if (rawName === 'schedule' || rawName.includes('schedule') || titleLower === 'schedule' || titleLower.startsWith('schedule')) {
    return 'schedule';
  }
  if (rawName === 'run_workflow' || rawName.includes('workflow') || titleLower.includes('run_workflow') || titleLower.startsWith('workflow')) {
    return 'workflow';
  }
  if (
    rawName === 'manage_task' ||
    rawName === 'background_task' ||
    rawName === 'task' ||
    titleLower === 'manage_task' ||
    titleLower.includes('manage_task')
  ) {
    return 'task';
  }
  return null;
}

function mapToolStatusToJobStatus(
  status: TspToolStatus,
  isActive: boolean,
): BackgroundJobStatus {
  if (isActive) return 'running';
  if (status === 'error') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  return 'completed';
}

function mapAgentStatusToJobStatus(
  status: SubagentTspStatus,
  isActive: boolean,
): BackgroundJobStatus {
  if (isActive) return 'running';
  if (status === 'failed') return 'failed';
  if (status === 'aborted') return 'cancelled';
  return 'completed';
}

const TERMINAL_BG_OUTPUT_RE =
  /\b(?:finished|completed|exited\s+with\s+code|killed|cancelled|canceled|stopped|terminated|not\s+running|no\s+longer\s+running)\b/i;

function extractTaskIdFromTool(tool: ToolCallItem): string | undefined {
  const outRec = asRecord(tool.rawOutput);
  const directOut = firstStringField(outRec, ['taskId', 'task_id', 'TaskId', 'jobId', 'job_id', 'workflowId', 'workflow_id']);
  if (directOut) return directOut;

  const text = tool.outputText || '';
  const taskMatch =
    /\b(?:task[_\s-]?id|TaskId|job[_\s-]?id|workflow[_\s-]?id)\b\s*(?:is|=|:)\s*["'`]?([A-Za-z0-9._:/-]+)["'`]?/i.exec(
      text,
    );
  if (taskMatch?.[1]) return taskMatch[1].replace(/[.,;)]+$/, '');
  return undefined;
}

function extractConversationIdFromTool(tool: ToolCallItem): string | undefined {
  const outRec = asRecord(tool.rawOutput);
  const directOut = firstStringField(outRec, [
    'conversationId',
    'conversation_id',
    'subagentConversationId',
    'subagent_conversation_id',
    'agentConversationId',
  ]);
  if (directOut) return directOut;

  const text = tool.outputText || '';
  const match =
    /\b(?:conversation[_\s-]?id|conversationId)\b\s*(?:is|=|:)\s*["'`]?([A-Za-z0-9._:-]+)["'`]?/i.exec(
      text,
    );
  if (match?.[1]) return match[1].replace(/[.,;)]+$/, '');
  return undefined;
}

function detectDetachedBackgroundTask(
  tool: ToolCallItem,
  turnIndex: number,
): DetachedBackgroundTask | null {
  if (tool.status !== 'done') return null;

  const rawName = (tool.rawName ?? '').toLowerCase();
  const titleLower = tool.title.toLowerCase();
  const inputRec = asRecord(tool.args) ?? asRecord(tool.rawInput);
  const outRec = asRecord(tool.rawOutput);
  const outText = tool.outputText || '';
  const outStatus = firstStringField(outRec, ['status', 'state'])?.toLowerCase();

  const explicitlyFinishedInObj =
    outStatus === 'done' ||
    outStatus === 'completed' ||
    outStatus === 'finished' ||
    outStatus === 'exited' ||
    outStatus === 'failed' ||
    outStatus === 'killed' ||
    outStatus === 'cancelled' ||
    outStatus === 'stopped';

  if (explicitlyFinishedInObj) return null;

  const explicitlyBgInObj =
    outRec?.background === true ||
    outRec?.isBackground === true ||
    outRec?.is_background === true ||
    outStatus === 'running' ||
    outStatus === 'background' ||
    outStatus === 'scheduled';

  // 1. invoke_subagent launched asynchronously
  const isSubagent =
    rawName === 'invoke_subagent' ||
    rawName === 'subagent' ||
    titleLower.includes('invoke_subagent');
  if (isSubagent) {
    const conversationId = extractConversationIdFromTool(tool);
    const hasBgCue =
      explicitlyBgInObj ||
      Boolean(conversationId) ||
      /running\s+(?:as\s+a\s+|in\s+the\s+)?background/i.test(outText) ||
      /\bsubagent\b.*\b(?:launched|started|running)\b/i.test(outText);
    if (!hasBgCue || TERMINAL_BG_OUTPUT_RE.test(outText)) {
      return null;
    }
    const subName =
      firstStringField(inputRec, ['name', 'agent', 'subagent', 'subagent_type', 'role']) ??
      'subagent';
    const taskDesc = firstStringField(inputRec, ['task', 'prompt', 'description', 'instruction', 'goal']);
    const model = firstStringField(inputRec, ['model']);
    const label = taskDesc ? `${subName}: ${collapseSingleLine(taskDesc, 72)}` : subName;
    return {
      id: `${tool.toolCallId}:${subName}`,
      toolCallId: tool.toolCallId,
      ...(conversationId ? { conversationId, taskId: conversationId } : {}),
      type: 'task',
      label,
      ...(taskDesc ? { title: taskDesc } : {}),
      agentKind: 'subagent',
      ...(model ? { model } : {}),
      startedAt: tool.startedAt,
      turnIndex,
      status: 'running',
      outputText: outText,
    };
  }

  // 2. schedule (one-shot timer or recurring cron)
  if (
    rawName === 'schedule' ||
    rawName.includes('schedule') ||
    titleLower === 'schedule' ||
    titleLower.startsWith('schedule')
  ) {
    const hasTimerSpec =
      inputRec?.DurationSeconds !== undefined ||
      inputRec?.durationSeconds !== undefined ||
      typeof inputRec?.CronExpression === 'string' ||
      typeof inputRec?.cronExpression === 'string';
    const taskId = extractTaskIdFromTool(tool);
    const hasScheduleCue =
      explicitlyBgInObj ||
      hasTimerSpec ||
      Boolean(taskId) ||
      /\b(?:scheduled|timer|cron|running\s+as\s+a\s+background)\b/i.test(outText);
    if (!hasScheduleCue || /\b(?:cancelled|canceled|removed|deleted|stopped|failed)\b/i.test(outText)) {
      return null;
    }
    const command = firstStringField(inputRec, ['CronExpression', 'cronExpression']);
    const desc =
      firstStringField(inputRec, ['Prompt', 'prompt', 'Description', 'description']) ?? tool.title;
    return {
      id: tool.toolCallId,
      toolCallId: tool.toolCallId,
      ...(taskId ? { taskId } : {}),
      type: 'schedule',
      label: collapseSingleLine(desc || 'schedule', 88),
      ...(command ? { command } : {}),
      ...(desc ? { title: desc } : {}),
      startedAt: tool.startedAt,
      turnIndex,
      status: 'running',
      outputText: outText,
    };
  }

  // 3. run_workflow backgrounded
  if (
    rawName === 'run_workflow' ||
    rawName.includes('workflow') ||
    titleLower.includes('run_workflow') ||
    titleLower.startsWith('workflow')
  ) {
    const taskId = extractTaskIdFromTool(tool);
    const hasBgCue =
      explicitlyBgInObj ||
      Boolean(taskId) ||
      /running\s+(?:as\s+a\s+|in\s+the\s+)?background/i.test(outText) ||
      /\bbackground\s+(?:task|workflow)\b/i.test(outText);
    if (!hasBgCue || TERMINAL_BG_OUTPUT_RE.test(outText)) {
      return null;
    }
    const command = firstStringField(inputRec, ['ScriptPath', 'scriptPath']);
    const desc = firstStringField(inputRec, ['Description', 'description']) ?? tool.title;
    return {
      id: tool.toolCallId,
      toolCallId: tool.toolCallId,
      ...(taskId ? { taskId } : {}),
      type: 'workflow',
      label: collapseSingleLine(desc || 'workflow', 88),
      ...(command ? { command } : {}),
      ...(desc ? { title: desc } : {}),
      startedAt: tool.startedAt,
      turnIndex,
      status: 'running',
      outputText: outText,
    };
  }

  // 4. run_command / bash turned into background task (exceeded WaitMsBeforeAsync or IsDaemon)
  const isBash =
    tool.kind?.toLowerCase() === 'execute' ||
    tool.displayName.toLowerCase() === 'bash' ||
    rawName === 'run_command' ||
    rawName === 'bash' ||
    rawName === 'shell' ||
    rawName === 'exec' ||
    titleLower === 'run_command' ||
    titleLower.startsWith('run_command');
  if (isBash) {
    const isDaemon = inputRec?.IsDaemon === true || inputRec?.isDaemon === true;
    const taskId = extractTaskIdFromTool(tool);
    const hasOutputBgCue =
      /running\s+(?:as\s+a\s+|in\s+the\s+)?background/i.test(outText) ||
      /\bbackground\s+(?:task|command|process|job)\b/i.test(outText) ||
      /\bTaskId\b\s*[:=]/i.test(outText) ||
      /\btask[_\s-]?id\b\s*[:=]/i.test(outText);
    // If exitCode is explicitly present and not explicitly marked as still running, command already exited
    const hasExited = tool.exitCode !== undefined && !explicitlyBgInObj;
    const hasBgCue = isDaemon || explicitlyBgInObj || hasOutputBgCue || Boolean(taskId);
    if (!hasBgCue || hasExited || TERMINAL_BG_OUTPUT_RE.test(outText)) {
      return null;
    }
    const command =
      tool.target ||
      firstStringField(inputRec, ['CommandLine', 'command', 'cmd', 'script']) ||
      (tool.title.toLowerCase() !== 'bash' ? tool.title : undefined);
    const desc = tool.title && tool.title !== command ? tool.title : undefined;
    return {
      id: tool.toolCallId,
      toolCallId: tool.toolCallId,
      ...(taskId ? { taskId } : {}),
      type: 'bash',
      label: collapseSingleLine(command ?? tool.title ?? 'bash', 88),
      ...(command ? { command } : {}),
      ...(desc ? { title: desc } : {}),
      startedAt: tool.startedAt,
      turnIndex,
      status: 'running',
      outputText: outText,
    };
  }

  return null;
}

function inferTerminalBgStatusFromText(text: string): 'completed' | 'failed' | 'cancelled' | null {
  if (/\b(?:Status:\s*(?:KILLED|CANCELLED|CANCELED|STOPPED)|killed|cancelled|canceled|terminated)\b/i.test(text)) {
    return 'cancelled';
  }
  if (/\b(?:Status:\s*(?:FAILED|ERROR)|failed\s+with|exited\s+with\s+code\s+[1-9]\d*)\b/i.test(text)) {
    return 'failed';
  }
  if (
    /\b(?:Status:\s*(?:DONE|EXITED|COMPLETED|FINISHED)|finished|completed|exited\s+with\s+code\s+0|not\s+running|no\s+longer\s+running|not\s+found)\b/i.test(
      text,
    )
  ) {
    return 'completed';
  }
  return null;
}

/**
 * Parse `swarm` and `invoke_subagent` tool calls into structured `SubagentEntry` rows
 * for rendering with `<agent>` components (DESIGN.md 4.5.1).
 */
export function parseSubagentEntries(tool: ToolCallItem): SubagentEntry[] {
  const rawName = (tool.rawName ?? '').toLowerCase();
  const titleLower = tool.title.toLowerCase();
  const isSwarm = rawName === 'swarm' || titleLower.startsWith('swarm');
  const isSubagent =
    rawName === 'invoke_subagent' ||
    rawName === 'subagent' ||
    titleLower.includes('invoke_subagent');

  if (!isSwarm && !isSubagent) return [];

  const inputRec = asRecord(tool.args) ?? asRecord(tool.rawInput);
  const agentStatus = mapToolStatusToAgentStatus(tool.status);
  const preview =
    tool.outputText.length > 0
      ? tool.outputText.slice(0, 240)
      : undefined;

  if (isSwarm) {
    const action = firstStringField(inputRec, ['action']) ?? 'run';
    const baseName = firstStringField(inputRec, ['name']) ?? 'swarm';
    const brief = firstStringField(inputRec, ['brief', 'title']);
    const model = firstStringField(inputRec, ['model']);
    const workspace = firstStringField(inputRec, ['workspace']);
    const tasksRaw = inputRec?.tasks;
    const countRaw = typeof inputRec?.n === 'number' ? Math.trunc(inputRec.n) : 1;

    // Multi-worker sharded `swarm` add (`tasks` array)
    if (action === 'add' && Array.isArray(tasksRaw) && tasksRaw.length > 0) {
      return tasksRaw.map((t, idx) => {
        const workerName = `${baseName}-${idx + 1}`;
        const taskSummary = typeof t === 'string' ? t : brief;
        return {
          id: `${tool.toolCallId}:${workerName}`,
          toolCallId: tool.toolCallId,
          kind: 'swarm' as const,
          name: workerName,
          action,
          ...(taskSummary ? { task: taskSummary } : {}),
          ...(model ? { model } : {}),
          ...(workspace ? { workspace } : {}),
          status: agentStatus,
          startedAt: tool.startedAt,
          ...(tool.endedAt !== undefined ? { endedAt: tool.endedAt } : {}),
          ...(preview ? { outputPreview: preview } : {}),
        };
      });
    }

    // Homogeneous copies `n > 1`
    if (action === 'add' && countRaw > 1) {
      const entries: SubagentEntry[] = [];
      for (let i = 1; i <= countRaw; i++) {
        const workerName = `${baseName}-${i}`;
        entries.push({
          id: `${tool.toolCallId}:${workerName}`,
          toolCallId: tool.toolCallId,
          kind: 'swarm',
          name: workerName,
          action,
          ...(brief ? { task: brief } : {}),
          ...(model ? { model } : {}),
          ...(workspace ? { workspace } : {}),
          status: agentStatus,
          startedAt: tool.startedAt,
          ...(tool.endedAt !== undefined ? { endedAt: tool.endedAt } : {}),
          ...(preview ? { outputPreview: preview } : {}),
        });
      }
      return entries;
    }

    // Single worker / status / kill / model / title
    const taskText = brief ?? (action === 'status' ? 'Check swarm roster status' : `swarm ${action}`);
    return [
      {
        id: `${tool.toolCallId}:${baseName}`,
        toolCallId: tool.toolCallId,
        kind: 'swarm',
        name: baseName,
        action,
        task: taskText,
        ...(model ? { model } : {}),
        ...(workspace ? { workspace } : {}),
        status: action === 'kill' && agentStatus === 'done' ? 'aborted' : agentStatus,
        startedAt: tool.startedAt,
        ...(tool.endedAt !== undefined ? { endedAt: tool.endedAt } : {}),
        ...(preview ? { outputPreview: preview } : {}),
      },
    ];
  }

  // `invoke_subagent`
  const subName =
    firstStringField(inputRec, ['name', 'agent', 'subagent', 'subagent_type', 'role']) ??
    'subagent';
  const task = firstStringField(inputRec, ['task', 'prompt', 'description', 'instruction', 'goal']);
  const model = firstStringField(inputRec, ['model']);

  return [
    {
      id: `${tool.toolCallId}:${subName}`,
      toolCallId: tool.toolCallId,
      kind: 'subagent',
      name: subName,
      ...(task ? { task } : {}),
      ...(model ? { model } : {}),
      status: agentStatus,
      startedAt: tool.startedAt,
      ...(tool.endedAt !== undefined ? { endedAt: tool.endedAt } : {}),
      ...(preview ? { outputPreview: preview } : {}),
    },
  ];
}

/**
 * Convert an ACP `elicitation/create` request into an interactive `ActiveQuestionCard`
 * ready for Tern's `<questions>` component (DESIGN.md 4.2.3 #4).
 */
export function buildQuestionCardFromElicitation(
  requestId: JsonRpcId,
  params: ElicitationCreateParams,
  resolve: (result: ElicitationCreateResult) => void,
  now = Date.now(),
): ActiveQuestionCard {
  const mode = params.mode === 'url' ? 'url' : 'form';
  const schema = params.requestedSchema;
  const requiredSet = new Set(schema?.required ?? []);
  const items: QuestionItem[] = [];

  if (mode === 'form' && schema?.properties) {
    const entries = Object.entries(schema.properties);
    const propsMap = schema.properties;
    const mergedWriteInKeys = new Set<string>();

    const isFreeTextProp = (prop: JsonSchemaProperty | undefined): prop is JsonSchemaProperty => {
      if (!prop) return false;
      if (prop.enum && prop.enum.length > 0) return false;
      if (prop.oneOf && prop.oneOf.length > 0) return false;
      return prop.type === undefined || prop.type === 'string';
    };

    const findPairedWriteInKey = (baseKey: string): string | undefined => {
      for (const suffix of ['_other', '_write_in']) {
        const candidate = `${baseKey}${suffix}`;
        if (isFreeTextProp(propsMap[candidate])) {
          return candidate;
        }
      }
      return undefined;
    };

    for (const [key, prop] of entries) {
      if (mergedWriteInKeys.has(key)) continue;

      const prompt = prop.title?.trim() || key;
      const description = prop.description?.trim();
      const required = requiredSet.has(key);

      if (prop.type === 'array' && (prop.items?.enum || prop.items?.oneOf)) {
        const choices: QuestionChoiceItem[] = prop.items.oneOf
          ? prop.items.oneOf.map((o, idx) => ({
              value: String(o.const ?? o.title ?? idx),
              ...(o.title ? { label: o.title } : {}),
              ...(o.description ? { detail: o.description } : {}),
            }))
          : (prop.items.enum ?? []).map((v, idx) => ({
              value: String(v),
              ...(prop.items?.enumNames?.[idx] ? { label: prop.items.enumNames[idx] } : {}),
            }));

        const pairedWriteIn = findPairedWriteInKey(key);
        let other: QuestionItem['other'] = false;
        if (pairedWriteIn) {
          mergedWriteInKeys.add(pairedWriteIn);
          const otherProp = propsMap[pairedWriteIn];
          other = {
            placeholder:
              otherProp?.description?.trim() ||
              otherProp?.title?.trim() ||
              'Other (type your own answer)...',
          };
        }

        items.push({
          id: key,
          prompt,
          ...(description ? { description } : {}),
          fieldType: 'multi',
          choices,
          multi: true,
          other,
          ...(pairedWriteIn ? { writeInFieldId: pairedWriteIn } : {}),
          required,
          rawSchema: prop,
        });
        continue;
      }

      if (prop.oneOf && prop.oneOf.length > 0) {
        const choices: QuestionChoiceItem[] = prop.oneOf.map((o, idx) => ({
          value: String(o.const ?? o.title ?? idx),
          ...(o.title ? { label: o.title } : {}),
          ...(o.description ? { detail: o.description } : {}),
        }));
        const pairedWriteIn = findPairedWriteInKey(key);
        let other: QuestionItem['other'] = false;
        if (pairedWriteIn) {
          mergedWriteInKeys.add(pairedWriteIn);
          const otherProp = propsMap[pairedWriteIn];
          other = {
            placeholder:
              otherProp?.description?.trim() ||
              otherProp?.title?.trim() ||
              'Other (type your own answer)...',
          };
        }
        items.push({
          id: key,
          prompt,
          ...(description ? { description } : {}),
          fieldType: 'single',
          choices,
          multi: false,
          other,
          ...(pairedWriteIn ? { writeInFieldId: pairedWriteIn } : {}),
          required,
          rawSchema: prop,
        });
        continue;
      }

      if (prop.enum && prop.enum.length > 0) {
        const choices: QuestionChoiceItem[] = prop.enum.map((v, idx) => ({
          value: String(v),
          ...(prop.enumNames?.[idx] ? { label: prop.enumNames[idx] } : {}),
        }));
        const pairedWriteIn = findPairedWriteInKey(key);
        let other: QuestionItem['other'] = false;
        if (pairedWriteIn) {
          mergedWriteInKeys.add(pairedWriteIn);
          const otherProp = propsMap[pairedWriteIn];
          other = {
            placeholder:
              otherProp?.description?.trim() ||
              otherProp?.title?.trim() ||
              'Other (type your own answer)...',
          };
        }
        items.push({
          id: key,
          prompt,
          ...(description ? { description } : {}),
          fieldType: 'single',
          choices,
          multi: false,
          other,
          ...(pairedWriteIn ? { writeInFieldId: pairedWriteIn } : {}),
          required,
          rawSchema: prop,
        });
        continue;
      }

      if (prop.type === 'boolean') {
        items.push({
          id: key,
          prompt,
          ...(description ? { description } : {}),
          fieldType: 'boolean',
          choices: [
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ],
          multi: false,
          other: false,
          required,
          rawSchema: prop,
        });
        continue;
      }

      const isNumeric = prop.type === 'number' || prop.type === 'integer';
      items.push({
        id: key,
        prompt,
        ...(description ? { description } : {}),
        fieldType: isNumeric ? 'number' : 'text',
        multi: false,
        other: {
          placeholder: description || (isNumeric ? 'Enter a number...' : 'Type your answer...'),
        },
        required,
        rawSchema: prop,
      });
    }
  }

  return {
    requestId,
    mode,
    ...(params.message ? { message: params.message } : {}),
    ...(params.url ? { url: params.url } : {}),
    items,
    step: 0,
    answers: {},
    otherDrafts: {},
    focusedOtherId: null,
    createdAt: now,
    resolve,
  };
}

/**
 * Coerce UI string/string[] answers back into typed JSON Schema values for
 * `elicitation/create` `{ action: 'accept', content }`.
 */
export function buildElicitationContent(card: ActiveQuestionCard): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const item of card.items) {
    const raw = card.answers[item.id];
    const otherDraft = (card.otherDrafts[item.id] ?? '').trim();

    if (item.writeInFieldId) {
      const choiceValues = new Set((item.choices ?? []).map(c => c.value));
      if (item.fieldType === 'multi') {
        const rawList = Array.isArray(raw)
          ? raw
          : typeof raw === 'string' && raw.length > 0
            ? [raw]
            : [];
        const selected = rawList.filter(v => choiceValues.has(v));
        const extraCustom = rawList
          .filter(v => !choiceValues.has(v) && v.trim().length > 0)
          .map(v => v.trim());
        const writeIn = otherDraft || extraCustom.join(', ');
        if (selected.length > 0) {
          out[item.id] = selected;
        }
        if (writeIn.length > 0) {
          out[item.writeInFieldId] = writeIn;
        }
      } else {
        const strVal = Array.isArray(raw) ? raw[0] : raw;
        if (strVal !== undefined && choiceValues.has(strVal) && otherDraft.length === 0) {
          out[item.id] = strVal;
        } else if (otherDraft.length > 0) {
          out[item.writeInFieldId] = otherDraft;
        } else if (typeof strVal === 'string' && strVal.trim().length > 0) {
          if (choiceValues.has(strVal)) {
            out[item.id] = strVal;
          } else {
            out[item.writeInFieldId] = strVal.trim();
          }
        }
      }
      continue;
    }

    const effective = raw ?? (otherDraft.length > 0 ? otherDraft : undefined);
    if (effective === undefined) continue;

    if (item.fieldType === 'boolean') {
      const strVal = Array.isArray(effective) ? effective[0] : effective;
      out[item.id] = strVal === 'true';
    } else if (item.fieldType === 'number') {
      const strVal = Array.isArray(effective) ? effective[0] : effective;
      const parsed = Number(strVal);
      out[item.id] = Number.isFinite(parsed) ? parsed : strVal;
    } else if (item.fieldType === 'multi') {
      out[item.id] = Array.isArray(effective) ? [...effective] : [effective];
    } else {
      out[item.id] = Array.isArray(effective) ? (effective[0] ?? '') : effective;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// TranscriptStore
// ---------------------------------------------------------------------------

export class TranscriptStore {
  private readonly _now: () => number;
  private _turns: TranscriptTurn[] = [];
  private _plan: PlanState | null = null;
  private _activeTurnIndex: number | null = null;

  private readonly _toolIndex = new Map<string, { turnIndex: number; tool: ToolCallItem }>();
  private readonly _detachedBgTasks = new Map<string, DetachedBackgroundTask>();
  private readonly _settledIds = new Set<string>();
  private readonly _evictedIds = new Set<string>();
  private _idSeq = 1;

  constructor(options: { now?: () => number } = {}) {
    this._now = options.now ?? (() => Date.now());
  }

  get turns(): readonly TranscriptTurn[] {
    return this._turns;
  }

  get plan(): PlanState | null {
    return this._plan;
  }

  get activeTurn(): TranscriptTurn | undefined {
    if (this._activeTurnIndex === null) return undefined;
    return this._turns[this._activeTurnIndex];
  }

  get settledTurnIds(): ReadonlySet<string> {
    return this._settledIds;
  }

  get evictedTurnIds(): ReadonlySet<string> {
    return this._evictedIds;
  }

  /**
   * Turns that have not been evicted by Tern (`GoneEvent`).
   * Views should render only these turns so no ops target dropped nodes.
   */
  getVisibleTurns(): readonly TranscriptTurn[] {
    return this._turns.filter((t) => !t.evicted);
  }

  getToolById(toolCallId: string): ToolCallItem | undefined {
    return this._toolIndex.get(toolCallId)?.tool;
  }

  /**
   * Start a new interactive user turn (called when the local user submits a prompt).
   */
  beginUserTurn(text: string, attachments: readonly AttachmentItem[] = []): TranscriptTurn {
    const now = this._now();
    // Defensively close any lingering running thoughts from a previous active turn
    if (this.activeTurn) {
      this.finalizeRunningThoughts(this.activeTurn, { now });
    }
    const index = this._turns.length;
    const turn: TranscriptTurn = {
      index,
      nodeId: `main.turn-${index}`,
      user: {
        id: `u-${this._idSeq++}`,
        text,
        timestamp: now,
        createdAt: now,
        timeLabel: formatTimeLabel(now),
        attachments: [...attachments],
      },
      timeline: [],
      thoughts: [],
      toolCalls: [],
      agents: [],
      assistantSegments: [],
      notices: [],
      assistantText: '',
      status: 'streaming',
      startedAt: now,
      createdAt: now,
      settled: false,
      evicted: false,
    };
    this._turns.push(turn);
    this._activeTurnIndex = index;
    return turn;
  }

  /**
   * Finalize all running (or unclosed) thought blocks in the active turn
   * (e.g. when a tool call, assistant message, permission prompt, question,
   * plan/compaction/notice, or user cancellation interrupts thinking).
   */
  finalizeActiveThoughts(
    options: {
      readonly autoCollapseThought?: boolean;
      readonly expandAllTools?: boolean;
      readonly now?: number;
    } = {},
  ): number {
    const turn = this.activeTurn;
    if (!turn) return 0;
    return this.finalizeRunningThoughts(turn, options);
  }

  /**
   * Finalize the currently active turn (when `session/prompt` resolves or is cancelled).
   */
  finishActiveTurn(
    stopReason?: StopReason,
    statusOverride?: 'done' | 'cancelled' | 'error',
    errorMessage?: string,
    options: {
      readonly autoCollapseThought?: boolean;
      readonly expandAllTools?: boolean;
    } = {},
  ): TranscriptTurn | undefined {
    const turn = this.activeTurn;
    if (!turn) return undefined;

    const now = this._now();
    turn.endedAt = now;
    if (stopReason !== undefined) {
      turn.stopReason = stopReason;
    }
    if (errorMessage !== undefined) {
      turn.errorMessage = errorMessage;
    }
    turn.status =
      statusOverride ?? (stopReason === 'cancelled' ? 'cancelled' : 'done');

    // Finalize all running/unclosed thought blocks
    this.finalizeRunningThoughts(turn, {
      autoCollapseThought: options.autoCollapseThought ?? false,
      expandAllTools: options.expandAllTools ?? false,
      now,
    });

    // Finalize any remaining non-terminal tools & subagents so no timer keeps ticking after turn end
    for (const tool of turn.toolCalls) {
      if (tool.status === 'pending' || tool.status === 'running' || tool.status === 'ask') {
        tool.awaitingPermission = false;
        if (turn.status === 'cancelled') {
          tool.cancelled = true;
          tool.status = 'cancelled';
        } else if (turn.status === 'error') {
          tool.status = 'error';
        } else {
          tool.status = 'done';
        }
        tool.endedAt = tool.endedAt ?? now;
        tool.tookMs = tool.tookMs ?? Math.max(0, tool.endedAt - tool.startedAt);
        this.syncSubagentsForTool(turn, tool);
      }
    }

    if (turn.status === 'cancelled') {
      this.cancelActiveBackgroundTasks('cancelled');
    }

    this._activeTurnIndex = null;
    return turn;
  }

  /**
   * Finalize all streaming turns (e.g. after `session/load` replay finishes).
   */
  finalizeReplayedTurns(): void {
    const now = this._now();
    this._detachedBgTasks.clear();
    for (const turn of this._turns) {
      if (turn.status === 'streaming') {
        turn.status = 'done';
        turn.endedAt = turn.endedAt ?? now;
      }
      this.finalizeRunningThoughts(turn, {
        autoCollapseThought: true,
        expandAllTools: false,
        now,
      });
      for (const tool of turn.toolCalls) {
        if (
          tool.status === 'pending' ||
          tool.status === 'running' ||
          tool.status === 'ask' ||
          tool.endedAt === undefined
        ) {
          tool.awaitingPermission = false;
          if (tool.status === 'pending' || tool.status === 'running' || tool.status === 'ask') {
            tool.status = 'done';
          }
          tool.endedAt = tool.endedAt ?? now;
          tool.tookMs = tool.tookMs ?? Math.max(0, tool.endedAt - tool.startedAt);
          this.syncSubagentsForTool(turn, tool);
        }
      }
    }
    this._activeTurnIndex = null;
  }

  /**
   * Consume an incoming ACP `session/update` notification.
   */
  applySessionUpdate(
    update: SessionUpdate | UnknownSessionUpdate,
    options: ApplySessionUpdateOptions = {},
  ): TranscriptUpdateOutcome {
    const autoCollapseThought = options.autoCollapseThought ?? true;
    const isReplaying = options.isReplaying ?? false;
    const showThinking = options.showThinking ?? true;
    const expandAllTools = options.expandAllTools ?? false;

    if (!isKnownSessionUpdate(update)) {
      return {
        handled: false,
        unknownUpdateType: String(update.sessionUpdate),
      };
    }

    switch (update.sessionUpdate) {
      case 'user_message_chunk': {
        const chunkText = extractContentText(update.content);
        if (!chunkText) return { handled: true };
        const current = this.activeTurn;
        // During replay, or if there is no local user message yet, create/append a user message
        if (isReplaying) {
          if (
            !current ||
            current.timeline.length > 0 ||
            current.status !== 'streaming'
          ) {
            if (current && current.status === 'streaming') {
              this.finishActiveTurn('end_turn', 'done');
            }
            this.beginUserTurn(chunkText);
          } else if (current.user) {
            current.user.text += chunkText;
          } else {
            const now = this._now();
            current.user = {
              id: `u-${this._idSeq++}`,
              text: chunkText,
              timestamp: now,
              createdAt: now,
              timeLabel: formatTimeLabel(now),
              attachments: [],
            };
          }
        } else if (!current) {
          this.reconcileBackgroundCompletionFromText(chunkText);
          this.beginUserTurn(chunkText);
        } else if (!current.user) {
          this.reconcileBackgroundCompletionFromText(chunkText);
          const now = this._now();
          current.user = {
            id: `u-${this._idSeq++}`,
            text: chunkText,
            timestamp: now,
            createdAt: now,
            timeLabel: formatTimeLabel(now),
            attachments: [],
          };
        } else {
          this.reconcileBackgroundCompletionFromText(chunkText);
        }
        return { handled: true };
      }

      case 'agent_thought_chunk': {
        const chunkText = extractContentText(update.content);
        if (!chunkText) return { handled: true };
        const turn = this.ensureActiveTurn();
        const lastRef = turn.timeline[turn.timeline.length - 1];
        const lastThought =
          lastRef?.kind === 'thought'
            ? turn.thoughts.find((t) => t.id === lastRef.id)
            : undefined;

        if (lastThought && lastThought.status === 'running') {
          // Defensively ensure no earlier thought block remains running
          this.finalizeRunningThoughts(turn, {
            autoCollapseThought,
            expandAllTools,
            excludeThoughtId: lastThought.id,
          });
          lastThought.text += chunkText;
        } else {
          // Close any earlier running thought blocks before starting a new one
          this.finalizeRunningThoughts(turn, { autoCollapseThought, expandAllTools });
          const thought: ThoughtBlock = {
            id: `th-${this._idSeq++}`,
            text: chunkText,
            status: 'running',
            startedAt: this._now(),
            open: showThinking && (!isReplaying || expandAllTools),
            userToggled: false,
          };
          turn.thoughts.push(thought);
          turn.timeline.push({ kind: 'thought', id: thought.id });
        }
        return { handled: true };
      }

      case 'agent_message_chunk': {
        const chunkText = extractContentText(update.content);
        if (!chunkText) {
          if (this.activeTurn) {
            this.finalizeRunningThoughts(this.activeTurn, {
              autoCollapseThought,
              expandAllTools,
            });
          }
          return { handled: true };
        }
        const turn = this.ensureActiveTurn();

        // Complete any running thoughts; auto-collapse when configured & not manually toggled
        this.finalizeRunningThoughts(turn, { autoCollapseThought, expandAllTools });

        const lastRef = turn.timeline[turn.timeline.length - 1];
        const lastSeg =
          lastRef?.kind === 'assistant'
            ? turn.assistantSegments.find((s) => s.id === lastRef.id)
            : undefined;

        if (lastSeg) {
          lastSeg.text += chunkText;
        } else {
          const seg: AssistantSegment = {
            id: `msg-${this._idSeq++}`,
            text: chunkText,
          };
          turn.assistantSegments.push(seg);
          turn.timeline.push({ kind: 'assistant', id: seg.id });
        }
        turn.assistantText += chunkText;
        return { handled: true };
      }

      case 'tool_call':
      case 'tool_call_update': {
        this.upsertToolCall(update, {
          defaultCollapsed: !expandAllTools,
          autoCollapseThought,
          expandAllTools,
          isReplaying,
        });
        return { handled: true };
      }

      case 'plan':
      case 'plan_update': {
        const now = this._now();
        if (this.activeTurn) {
          this.finalizeRunningThoughts(this.activeTurn, {
            autoCollapseThought,
            expandAllTools,
            now,
          });
        }
        const entries = update.entries ?? [];
        this._plan = {
          entries: entries.map((e, idx) => ({
            id: `plan-${idx}`,
            text: e.content,
            ...(e.priority !== undefined ? { priority: e.priority } : {}),
            status: mapPlanStatusToChecklist(e.status),
          })),
          updatedAt: now,
        };
        return { handled: true };
      }

      case 'plan_removed': {
        this._plan = null;
        return { handled: true };
      }

      case 'usage_update': {
        return {
          handled: true,
          usage: {
            used: update.used,
            size: update.size,
            ...(update.cost ? { cost: update.cost } : {}),
          },
        };
      }

      case 'available_commands_update': {
        return {
          handled: true,
          availableCommands: update.availableCommands ?? [],
        };
      }

      case 'current_mode_update': {
        return {
          handled: true,
          currentModeId: update.currentModeId,
        };
      }

      case 'config_option_update': {
        return {
          handled: true,
          configOptions: update.configOptions,
        };
      }

      case 'session_info_update': {
        return {
          handled: true,
          sessionInfo: {
            ...(update.title !== undefined ? { title: update.title } : {}),
            ...(update.updatedAt !== undefined ? { updatedAt: update.updatedAt } : {}),
          },
        };
      }

      case 'compaction_update': {
        const text = extractNoticeText(update);
        const turn = this.ensureActiveTurn();
        const now = this._now();
        this.finalizeRunningThoughts(turn, { autoCollapseThought, expandAllTools, now });
        const existing = [...turn.notices].reverse().find((n) => n.kind === 'compaction');
        if (existing) {
          existing.status = update.status ?? existing.status;
          if (text) existing.text = text;
        } else {
          const notice: NoticeItem = {
            id: `notice-${this._idSeq++}`,
            kind: 'compaction',
            level: 'info',
            ...(update.status !== undefined ? { status: update.status } : {}),
            text: text || 'Context compaction in progress...',
            summaryText: '',
            collapsed: true,
            timestamp: now,
          };
          turn.notices.push(notice);
          turn.timeline.push({ kind: 'notice', id: notice.id });
        }
        return { handled: true };
      }

      case 'compaction_summary_chunk': {
        const chunk = extractNoticeText(update);
        if (!chunk) return { handled: true };
        const turn = this.ensureActiveTurn();
        const now = this._now();
        this.finalizeRunningThoughts(turn, { autoCollapseThought, expandAllTools, now });
        const existing = [...turn.notices].reverse().find((n) => n.kind === 'compaction');
        if (existing) {
          existing.summaryText += chunk;
        } else {
          const notice: NoticeItem = {
            id: `notice-${this._idSeq++}`,
            kind: 'compaction',
            level: 'info',
            text: 'Context compacted',
            summaryText: chunk,
            collapsed: true,
            timestamp: now,
          };
          turn.notices.push(notice);
          turn.timeline.push({ kind: 'notice', id: notice.id });
        }
        return { handled: true };
      }

      case 'notice': {
        const text = extractNoticeText(update);
        if (!text) return { handled: true };
        const turn = this.ensureActiveTurn();
        const now = this._now();
        this.finalizeRunningThoughts(turn, { autoCollapseThought, expandAllTools, now });
        const rawLevel = (update.level ?? 'info').toLowerCase();
        const level: NoticeItem['level'] =
          rawLevel === 'error'
            ? 'error'
            : rawLevel === 'warn' || rawLevel === 'warning'
              ? 'warning'
              : 'info';
        const notice: NoticeItem = {
          id: `notice-${this._idSeq++}`,
          kind: 'notice',
          level,
          ...(update.status !== undefined ? { status: update.status } : {}),
          text,
          summaryText: '',
          collapsed: false,
          timestamp: now,
        };
        turn.notices.push(notice);
        turn.timeline.push({ kind: 'notice', id: notice.id });
        if (!isReplaying) {
          this.reconcileBackgroundCompletionFromText(text);
        }
        return { handled: true };
      }
    }
  }

  /**
   * Bind an incoming `session/request_permission` to its tool card (creating a
   * placeholder tool card if the `tool_call` update hasn't arrived yet, per DESIGN.md 4.2.3 #3).
   */
  attachPermissionRequest(
    requestId: JsonRpcId,
    toolCall: PermissionToolCallRef,
    mapped: MappedPermissionOptions,
    options: {
      readonly autoCollapseThought?: boolean;
      readonly expandAllTools?: boolean;
    } = {},
  ): ToolCallItem {
    const tool = this.upsertToolCall(
      {
        toolCallId: toolCall.toolCallId,
        status: toolCall.status ?? 'pending',
        kind: toolCall.kind,
        name: toolCall.name,
        title: toolCall.title,
        rawInput: toolCall.rawInput,
        locations: toolCall.locations,
        content: toolCall.content,
      },
      {
        autoCollapseThought: options.autoCollapseThought ?? true,
        expandAllTools: options.expandAllTools ?? false,
      },
    );

    tool.awaitingPermission = true;
    tool.permissionRequestId = requestId;
    tool.ask = mapped.ask;
    tool.status = mapAcpToolStatusToTsp(tool.acpStatus, {
      awaitingPermission: true,
      cancelled: tool.cancelled,
    });

    const entry = this._toolIndex.get(tool.toolCallId);
    const turn = entry ? this._turns[entry.turnIndex] : undefined;
    if (turn) {
      this.syncSubagentsForTool(turn, tool);
    }

    return tool;
  }

  /**
   * Update tool card after a permission decision (`once` | `always` | `denied` | `cancelled`).
   */
  resolvePermissionOnTool(toolCallId: string, decision: ApprovalDecision): ToolCallItem | undefined {
    const found = this._toolIndex.get(toolCallId);
    if (!found) return undefined;
    const { tool, turnIndex } = found;

    tool.awaitingPermission = false;
    tool.permissionRequestId = undefined;

    if (decision === 'cancelled') {
      const now = this._now();
      tool.cancelled = true;
      tool.status = 'cancelled';
      tool.endedAt = tool.endedAt ?? now;
      tool.tookMs = tool.tookMs ?? Math.max(0, tool.endedAt - tool.startedAt);
    } else {
      tool.approved = decision;
      if (decision === 'denied') {
        const now = this._now();
        tool.status = 'cancelled';
        tool.endedAt = tool.endedAt ?? now;
        tool.tookMs = tool.tookMs ?? Math.max(0, tool.endedAt - tool.startedAt);
      } else {
        tool.status = mapAcpToolStatusToTsp(tool.acpStatus, {
          awaitingPermission: false,
          cancelled: tool.cancelled,
        });
      }
    }

    const turn = this._turns[turnIndex];
    if (turn) {
      this.syncSubagentsForTool(turn, tool);
    }
    return tool;
  }

  toggleThought(thoughtId: string, open?: boolean): boolean {
    for (const turn of this._turns) {
      const thought = turn.thoughts.find((t) => t.id === thoughtId);
      if (thought) {
        thought.open = open !== undefined ? open : !thought.open;
        thought.userToggled = true;
        return true;
      }
    }
    return false;
  }

  toggleTool(toolCallId: string, collapsed?: boolean): boolean {
    const found = this._toolIndex.get(toolCallId);
    if (!found) return false;
    found.tool.collapsed = collapsed !== undefined ? collapsed : !found.tool.collapsed;
    found.tool.userToggled = true;
    return true;
  }

  /**
   * Apply a global collapse/expand policy across all tools (e.g. `Ctrl+O`).
   */
  setAllToolsCollapsed(collapsed: boolean): void {
    for (const turn of this._turns) {
      for (const tool of turn.toolCalls) {
        tool.collapsed = collapsed;
        tool.userToggled = false;
      }
    }
  }

  /**
   * Apply a global open/collapse policy across all thought blocks (e.g. `Ctrl+O`).
   */
  setAllThoughtsOpen(open: boolean): void {
    for (const turn of this._turns) {
      for (const thought of turn.thoughts) {
        thought.open = open;
        thought.userToggled = false;
      }
    }
  }

  /**
   * Resolve whether a thought block should be expanded under global `showThinking` / `expandAllTools` toggles.
   */
  isThoughtOpen(
    thought: ThoughtBlock,
    options: { readonly showThinking: boolean; readonly expandAllTools: boolean },
  ): boolean {
    if (!options.showThinking) return false;
    if (thought.userToggled) return thought.open;
    if (options.expandAllTools) return true;
    return thought.open;
  }

  /**
   * Resolve whether a tool card should be collapsed under global `expandAllTools` toggle.
   */
  isToolCollapsed(tool: ToolCallItem, expandAllTools: boolean): boolean {
    if (tool.userToggled) return tool.collapsed;
    return expandAllTools ? false : tool.collapsed;
  }

  toggleNotice(noticeId: string, collapsed?: boolean): boolean {
    for (const turn of this._turns) {
      const notice = turn.notices.find((n) => n.id === noticeId);
      if (notice) {
        notice.collapsed = collapsed !== undefined ? collapsed : !notice.collapsed;
        return true;
      }
    }
    return false;
  }

  toggleAgent(agentId: string, collapsed?: boolean): boolean {
    for (const turn of this._turns) {
      const agent = turn.agents.find((a) => a.id === agentId);
      if (agent) {
        agent.collapsed = collapsed !== undefined ? collapsed : !(agent.collapsed ?? true);
        return true;
      }
    }
    return false;
  }

  /**
   * Record that `surface.settle('main.turn-<index>')` was issued for a completed turn.
   */
  markSettled(nodeIdOrTurnIndex: string | number): boolean {
    const nodeId =
      typeof nodeIdOrTurnIndex === 'number'
        ? `main.turn-${nodeIdOrTurnIndex}`
        : nodeIdOrTurnIndex;
    if (this._evictedIds.has(nodeId)) return false;
    this._settledIds.add(nodeId);
    const turn = this._turns.find((t) => t.nodeId === nodeId);
    if (turn) {
      turn.settled = true;
    }
    return true;
  }

  /**
   * Record Tern `GoneEvent` evicted turn node IDs so future frames do not target dropped nodes.
   */
  markEvicted(ids: readonly string[]): string[] {
    const newlyEvicted: string[] = [];
    for (const id of ids) {
      if (!this._evictedIds.has(id)) {
        this._evictedIds.add(id);
        this._settledIds.delete(id);
        newlyEvicted.push(id);
      }
      const turn = this._turns.find((t) => t.nodeId === id);
      if (turn) {
        turn.evicted = true;
        turn.settled = false;
      }
    }
    return newlyEvicted;
  }

  /**
   * Return the N-th most recent non-empty assistant Markdown reply (`1` = latest, for `/copy [n]`).
   */
  getAssistantMarkdownByReverseIndex(reverseIndex = 1): string | null {
    if (!Number.isInteger(reverseIndex) || reverseIndex < 1) {
      return null;
    }
    let seen = 0;
    for (let i = this._turns.length - 1; i >= 0; i--) {
      const turn = this._turns[i];
      if (turn && turn.assistantText.trim().length > 0) {
        seen++;
        if (seen === reverseIndex) {
          return turn.assistantText;
        }
      }
    }
    return null;
  }

  /**
   * Return the latest non-empty assistant Markdown reply (for `/copy`).
   */
  getLastAssistantMarkdown(): string | null {
    return this.getAssistantMarkdownByReverseIndex(1);
  }

  /**
   * Estimate context window token breakdown across user, assistant, thought, and tool content
   * for the `/context` info overlay.
   */
  estimateContextBreakdown(
    usage?: { readonly used: number; readonly size: number } | null,
  ): ContextBreakdown {
    let userChars = 0;
    let assistantChars = 0;
    let thoughtChars = 0;
    let toolChars = 0;

    let userTokens = 0;
    let assistantTokens = 0;
    let thoughtTokens = 0;
    let toolTokens = 0;

    for (const turn of this._turns) {
      if (turn.user) {
        const userText = turn.user.text;
        userChars += userText.length;
        userTokens += estimateTokensFromText(userText);
        for (const att of turn.user.attachments) {
          const attLabel = att.path ?? att.name;
          userChars += attLabel.length;
          userTokens += estimateTokensFromText(attLabel);
        }
      }

      if (turn.assistantText.length > 0) {
        assistantChars += turn.assistantText.length;
        assistantTokens += estimateTokensFromText(turn.assistantText);
      }

      for (const thought of turn.thoughts) {
        if (thought.text.length > 0) {
          thoughtChars += thought.text.length;
          thoughtTokens += estimateTokensFromText(thought.text);
        }
      }

      for (const tool of turn.toolCalls) {
        const pieces: string[] = [tool.title];
        if (tool.target) pieces.push(tool.target);
        if (tool.outputText) pieces.push(tool.outputText);
        for (const diff of tool.diffs) {
          pieces.push(diff.path);
          if (diff.oldText) pieces.push(diff.oldText);
          if (diff.newText) pieces.push(diff.newText);
          if (diff.patchText) pieces.push(diff.patchText);
        }
        const joined = pieces.join('\n');
        toolChars += joined.length;
        toolTokens += estimateTokensFromText(joined);
      }
    }

    const totalChars = userChars + assistantChars + thoughtChars + toolChars;
    const totalEstimatedTokens = userTokens + assistantTokens + thoughtTokens + toolTokens;
    const pct = (tokens: number): number =>
      totalEstimatedTokens > 0
        ? Math.round((tokens / totalEstimatedTokens) * 1000) / 10
        : 0;

    const categories: readonly ContextCategoryEstimate[] = [
      { category: 'user', chars: userChars, estimatedTokens: userTokens, sharePercent: pct(userTokens) },
      { category: 'assistant', chars: assistantChars, estimatedTokens: assistantTokens, sharePercent: pct(assistantTokens) },
      { category: 'thought', chars: thoughtChars, estimatedTokens: thoughtTokens, sharePercent: pct(thoughtTokens) },
      { category: 'tool', chars: toolChars, estimatedTokens: toolTokens, sharePercent: pct(toolTokens) },
    ];

    const hasUsage = Boolean(usage && usage.size > 0);
    const usedPercent =
      hasUsage && usage
        ? Math.min(100, Math.round((usage.used / usage.size) * 1000) / 10)
        : undefined;

    return {
      categories,
      totalChars,
      totalEstimatedTokens,
      turnCount: this._turns.length,
      userChars,
      assistantChars,
      thoughtChars,
      toolChars,
      ...(hasUsage && usage
        ? {
            reportedUsedTokens: usage.used,
            contextWindowSize: usage.size,
            usedPercent,
          }
        : {}),
    };
  }

  /**
   * Returns `true` when there is any active in-flight tool call (`pending`/`running`/`ask`)
   * in a streaming turn OR any detached background task (`run_command`, `invoke_subagent`,
   * `schedule`, `run_workflow`) still running after `end_turn`.
   */
  hasActiveBackgroundTasks(): boolean {
    for (const task of this._detachedBgTasks.values()) {
      if (task.status === 'running') return true;
    }
    const turn = this.activeTurn;
    if (turn && turn.status === 'streaming') {
      for (const tool of turn.toolCalls) {
        if (
          (tool.status === 'pending' || tool.status === 'running' || tool.status === 'ask') &&
          tool.endedAt === undefined
        ) {
          return true;
        }
      }
      for (const ag of turn.agents) {
        if ((ag.status === 'pending' || ag.status === 'running') && ag.endedAt === undefined) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * List all detached background tasks tracked in this session (running and settled).
   */
  getDetachedBackgroundTasks(): readonly DetachedBackgroundTask[] {
    return [...this._detachedBgTasks.values()];
  }

  /**
   * Mark a specific detached background task (matched by `id`, `toolCallId`, `taskId`,
   * or `conversationId`) as settled.
   */
  completeBackgroundTask(
    idOrTaskId: string,
    status: 'completed' | 'failed' | 'cancelled' = 'completed',
  ): boolean {
    const target = idOrTaskId.trim();
    if (!target) return false;
    const now = this._now();
    let updated = false;
    for (const task of this._detachedBgTasks.values()) {
      if (task.status !== 'running') continue;
      if (
        task.id === target ||
        task.toolCallId === target ||
        task.taskId === target ||
        task.conversationId === target
      ) {
        task.status = status;
        task.endedAt = now;
        updated = true;
      }
    }
    return updated;
  }

  /**
   * Cancel or settle all currently running detached background tasks (e.g. when the user
   * presses Stop / `Esc` / `Ctrl+C` during background execution).
   */
  cancelActiveBackgroundTasks(status: 'cancelled' | 'completed' = 'cancelled'): number {
    const now = this._now();
    let count = 0;
    for (const task of this._detachedBgTasks.values()) {
      if (task.status === 'running') {
        task.status = status;
        task.endedAt = now;
        count += 1;
      }
    }
    return count;
  }

  /**
   * Aggregate running & recent background commands, scheduled/workflow/managed tasks,
   * detached background tasks (surviving `end_turn`), and subagent/swarm jobs for
   * the dock HUD (`omp.hud`) and `/jobs` (`omp.overlay.jobs`).
   *
   * Strict invariants (aligned 1:1 with `omp` + stopwatch rule):
   * - In-flight tool calls require `endedAt === undefined && turn.status === 'streaming'` so
   *   `finishActiveTurn` / `finalizeReplayedTurns` / cancellation zeroes non-detached running counts.
   * - Detached background tasks (async `run_command`, `invoke_subagent`, `schedule`, `run_workflow`)
   *   remain `running` across `end_turn` until completed by `manage_task`, a completion notice,
   *   or explicit user cancellation.
   * - `runningJobCount` counts ONLY non-agent jobs (`agentId === undefined`) matching `omp`.
   */
  getBackgroundJobsSnapshot(): BackgroundJobsSnapshot {
    const running: BackgroundJobItem[] = [];
    const recent: BackgroundJobItem[] = [];
    let runningJobCount = 0;
    let runningSubagentCount = 0;
    let runningSwarmAgentCount = 0;
    let inspectableAgentCount = 0;
    let detachedTaskCount = 0;

    // 1. Emit detached background tasks first and index their toolCallIds to avoid duplicates
    const detachedToolCallIds = new Set<string>();
    for (const task of this._detachedBgTasks.values()) {
      detachedToolCallIds.add(task.toolCallId);
      const isRunning = task.status === 'running';
      if (isRunning) {
        detachedTaskCount += 1;
        if (task.agentKind === 'subagent') {
          runningSubagentCount += 1;
        } else {
          runningJobCount += 1;
        }
      }
      if (task.agentKind === 'subagent') {
        inspectableAgentCount += 1;
      }
      const tookMs =
        !isRunning && task.endedAt !== undefined
          ? Math.max(0, task.endedAt - task.startedAt)
          : undefined;
      const item: BackgroundJobItem = {
        id: task.id,
        toolCallId: task.toolCallId,
        type: task.type,
        status: task.status,
        label: task.label,
        ...(task.command ? { command: task.command } : {}),
        ...(task.title ? { title: task.title } : {}),
        outputText: task.outputText,
        startedAt: task.startedAt,
        ...(task.endedAt !== undefined ? { endedAt: task.endedAt } : {}),
        ...(tookMs !== undefined ? { tookMs } : {}),
        turnIndex: task.turnIndex,
        ...(task.agentKind === 'subagent'
          ? { agentId: task.id, agentKind: 'subagent' as const }
          : {}),
        ...(task.model ? { model: task.model } : {}),
      };
      if (isRunning) running.push(item);
      else recent.push(item);
    }

    for (const turn of this._turns) {
      const turnStreaming = turn.status === 'streaming';
      const agentsByToolId = new Map<string, SubagentEntry[]>();
      for (const ag of turn.agents) {
        const list = agentsByToolId.get(ag.toolCallId);
        if (list) list.push(ag);
        else agentsByToolId.set(ag.toolCallId, [ag]);
      }

      for (const tool of turn.toolCalls) {
        if (detachedToolCallIds.has(tool.toolCallId)) {
          continue;
        }

        const linkedAgents = agentsByToolId.get(tool.toolCallId);
        if (linkedAgents && linkedAgents.length > 0) {
          for (const ag of linkedAgents) {
            inspectableAgentCount += 1;
            const isAgentActive =
              (ag.status === 'pending' || ag.status === 'running') &&
              ag.endedAt === undefined &&
              turnStreaming;
            if (isAgentActive) {
              if (ag.kind === 'swarm') runningSwarmAgentCount += 1;
              else runningSubagentCount += 1;
            }
            const jobStatus = mapAgentStatusToJobStatus(ag.status, isAgentActive);
            const outputText = tool.outputText || ag.outputPreview || '';
            const endedAt = ag.endedAt ?? (!isAgentActive ? tool.endedAt : undefined);
            const tookMs =
              !isAgentActive
                ? (tool.tookMs ??
                  (endedAt !== undefined ? Math.max(0, endedAt - ag.startedAt) : 0))
                : undefined;
            const label = ag.task
              ? `${ag.name}: ${collapseSingleLine(ag.task, 72)}`
              : ag.name;

            const item: BackgroundJobItem = {
              id: ag.id,
              toolCallId: tool.toolCallId,
              type: 'task',
              status: jobStatus,
              label,
              ...(ag.task ? { title: ag.task } : {}),
              outputText,
              startedAt: ag.startedAt,
              ...(endedAt !== undefined ? { endedAt } : {}),
              ...(tookMs !== undefined ? { tookMs } : {}),
              turnIndex: turn.index,
              agentId: ag.id,
              agentKind: ag.kind,
              ...(ag.model ? { model: ag.model } : {}),
              ...(ag.workspace ? { workspace: ag.workspace } : {}),
            };
            if (isAgentActive) running.push(item);
            else recent.push(item);
          }
          continue;
        }

        const jobType = classifyNonAgentJobType(tool);
        if (!jobType) continue;

        const isActive =
          (tool.status === 'pending' || tool.status === 'running' || tool.status === 'ask') &&
          tool.endedAt === undefined &&
          turnStreaming;
        if (isActive) {
          runningJobCount += 1;
        }

        const inputRec = asRecord(tool.args) ?? asRecord(tool.rawInput);
        const command =
          jobType === 'bash'
            ? (tool.target ||
                firstStringField(inputRec, ['CommandLine', 'command', 'cmd', 'script']) ||
                (tool.title.toLowerCase() !== 'bash' ? tool.title : undefined))
            : firstStringField(inputRec, ['CommandLine', 'command', 'cmd', 'CronExpression', 'ScriptPath']);

        const rawDesc =
          jobType === 'bash'
            ? (tool.title && tool.title !== command ? tool.title : undefined)
            : (firstStringField(inputRec, ['Description', 'Prompt', 'Action', 'TaskId']) ??
                tool.title);

        const labelSource =
          jobType === 'bash'
            ? (command ?? tool.title ?? 'bash')
            : (rawDesc ?? tool.rawName ?? jobType);

        const endedAt = tool.endedAt;
        const tookMs = !isActive
          ? (tool.tookMs ?? (endedAt !== undefined ? Math.max(0, endedAt - tool.startedAt) : 0))
          : undefined;

        const item: BackgroundJobItem = {
          id: tool.toolCallId,
          toolCallId: tool.toolCallId,
          type: jobType,
          status: mapToolStatusToJobStatus(tool.status, isActive),
          label: collapseSingleLine(labelSource, 88),
          ...(command ? { command } : {}),
          ...(rawDesc ? { title: rawDesc } : {}),
          outputText: tool.outputText,
          ...(tool.exitCode !== undefined ? { exitCode: tool.exitCode } : {}),
          startedAt: tool.startedAt,
          ...(endedAt !== undefined ? { endedAt } : {}),
          ...(tookMs !== undefined ? { tookMs } : {}),
          turnIndex: turn.index,
        };

        if (isActive) running.push(item);
        else recent.push(item);
      }
    }

    running.sort((a, b) => b.startedAt - a.startedAt);
    recent.sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
    const cappedRecent = recent.slice(0, MAX_RECENT_BACKGROUND_JOBS);

    const runningJobSummaries = running
      .filter((j) => j.agentId === undefined)
      .map((j) => `${j.type}: ${collapseSingleLine(j.label, 64)}`);

    return {
      running,
      recent: cappedRecent,
      all: [...running, ...cappedRecent],
      runningJobCount,
      runningSubagentCount,
      runningSwarmAgentCount,
      runningAgentCount: runningSubagentCount + runningSwarmAgentCount,
      inspectableAgentCount,
      detachedTaskCount,
      hasActiveBackgroundTasks: detachedTaskCount > 0 || running.length > 0 || this.hasActiveBackgroundTasks(),
      runningJobSummaries,
    };
  }

  /**
   * Extract the most recent user/assistant message pairs for `/resume` right-side preview cache.
   */
  getPreviewMessages(maxTurns = 3, maxCharsPerMessage = 400): PreviewMessageSummary[] {
    const recent = this._turns.slice(-Math.max(1, maxTurns));
    const messages: PreviewMessageSummary[] = [];

    const clip = (s: string): string => {
      const trimmed = s.trim();
      return trimmed.length > maxCharsPerMessage
        ? `${trimmed.slice(0, maxCharsPerMessage)}...`
        : trimmed;
    };

    for (const turn of recent) {
      if (turn.user && turn.user.text.trim().length > 0) {
        messages.push({ role: 'user', text: clip(turn.user.text) });
      }
      if (turn.assistantText.trim().length > 0) {
        messages.push({ role: 'assistant', text: clip(turn.assistantText) });
      }
    }
    return messages;
  }

  clear(): void {
    this._turns = [];
    this._plan = null;
    this._activeTurnIndex = null;
    this._toolIndex.clear();
    this._detachedBgTasks.clear();
    this._settledIds.clear();
    this._evictedIds.clear();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private ensureActiveTurn(): TranscriptTurn {
    if (this._activeTurnIndex !== null) {
      const existing = this._turns[this._activeTurnIndex];
      if (existing) return existing;
    }
    const now = this._now();
    const index = this._turns.length;
    const turn: TranscriptTurn = {
      index,
      nodeId: `main.turn-${index}`,
      timeline: [],
      thoughts: [],
      toolCalls: [],
      agents: [],
      assistantSegments: [],
      notices: [],
      assistantText: '',
      status: 'streaming',
      startedAt: now,
      createdAt: now,
      settled: false,
      evicted: false,
    };
    this._turns.push(turn);
    this._activeTurnIndex = index;
    return turn;
  }

  private finalizeRunningThoughts(
    turn: TranscriptTurn,
    options: {
      readonly autoCollapseThought?: boolean;
      readonly expandAllTools?: boolean;
      readonly now?: number;
      readonly excludeThoughtId?: string;
    } = {},
  ): number {
    let now = options.now;
    const autoCollapseThought = options.autoCollapseThought ?? false;
    const expandAllTools = options.expandAllTools ?? false;
    let closedCount = 0;

    for (const thought of turn.thoughts) {
      if (options.excludeThoughtId && thought.id === options.excludeThoughtId) {
        continue;
      }
      if (thought.status === 'running' || thought.endedAt === undefined) {
        if (now === undefined) {
          now = this._now();
        }
        const end = thought.endedAt ?? now;
        thought.status = 'done';
        thought.endedAt = end;
        thought.tookMs = thought.tookMs ?? Math.max(0, end - thought.startedAt);
        if (autoCollapseThought && !expandAllTools && !thought.userToggled) {
          thought.open = false;
        }
        closedCount++;
      }
    }
    return closedCount;
  }

  private upsertToolCall(
    fields: ToolCallFields,
    options: {
      readonly defaultCollapsed?: boolean;
      readonly autoCollapseThought?: boolean;
      readonly expandAllTools?: boolean;
      readonly isReplaying?: boolean;
    } = {},
  ): ToolCallItem {
    const existing = this._toolIndex.get(fields.toolCallId);
    const now = this._now();
    const autoCollapseThought = options.autoCollapseThought ?? true;
    const expandAllTools = options.expandAllTools ?? false;
    const isReplaying = options.isReplaying ?? false;

    if (existing) {
      const { tool, turnIndex } = existing;
      const existingTurn = this._turns[turnIndex];
      if (existingTurn) {
        this.finalizeRunningThoughts(existingTurn, {
          autoCollapseThought,
          expandAllTools,
          now,
        });
      }
      if (this.activeTurn && this.activeTurn !== existingTurn) {
        this.finalizeRunningThoughts(this.activeTurn, {
          autoCollapseThought,
          expandAllTools,
          now,
        });
      }

      if (fields.kind !== undefined) tool.kind = fields.kind;
      if (fields.name !== undefined) tool.rawName = fields.name;

      const meta = mapToolDisplayMeta(tool.kind, tool.rawName);
      tool.displayName = meta.displayName;
      tool.targetKind = meta.targetKind;

      if (fields.title !== undefined) {
        tool.title = normalizeDisplayPath(fields.title);
      }
      if (fields.args !== undefined) {
        tool.args = fields.args;
      }
      if (fields.rawInput !== undefined) {
        tool.rawInput = fields.rawInput;
      }
      if (fields.locations !== undefined) {
        tool.locations = fields.locations.map((loc) => ({
          ...loc,
          path: normalizeDisplayPath(loc.path),
        }));
      }

      const nextTarget = extractToolTarget(
        {
          title: tool.title,
          args: tool.args,
          rawInput: tool.rawInput,
          locations: tool.locations,
        },
        tool.targetKind,
      );
      if (nextTarget !== undefined) {
        tool.target = nextTarget;
      }

      if (fields.rawOutput !== undefined) {
        tool.rawOutput = fields.rawOutput;
        const exitCode = extractToolExitCode(fields.rawOutput);
        if (exitCode !== undefined) {
          tool.exitCode = exitCode;
        }
        const rawOutText = extractToolOutputText(fields.rawOutput);
        if (rawOutText !== undefined && rawOutText.length > 0) {
          tool.outputText = rawOutText;
        }
      }

      if (fields.content !== undefined) {
        const diffs = extractDiffItems(fields.content);
        if (diffs.length > 0) {
          tool.diffs = diffs;
        }
        const contentText = extractToolContentText(fields.content);
        if (contentText.length > 0) {
          tool.outputText =
            tool.outputText.length > 0 && !tool.outputText.includes(contentText)
              ? `${tool.outputText}\n${contentText}`
              : contentText;
        }
      }

      if (fields.status !== undefined) {
        tool.acpStatus = fields.status;
        if (fields.status === 'completed' || fields.status === 'failed') {
          tool.awaitingPermission = false;
          tool.endedAt = now;
          tool.tookMs = Math.max(0, now - tool.startedAt);
        }
      }

      tool.status = mapAcpToolStatusToTsp(tool.acpStatus, {
        awaitingPermission: tool.awaitingPermission,
        cancelled: tool.cancelled,
      });

      if (existingTurn) {
        this.syncSubagentsForTool(existingTurn, tool);
        if (!isReplaying) {
          this.syncBackgroundTaskForTool(existingTurn.index, tool);
        }
      }
      return tool;
    }

    // Create a brand new ToolCallItem
    const turn = this.ensureActiveTurn();
    // A tool call always terminates any preceding running thought blocks in the turn
    this.finalizeRunningThoughts(turn, {
      autoCollapseThought,
      expandAllTools,
      now,
    });
    const meta = mapToolDisplayMeta(fields.kind, fields.name);
    const locations = (fields.locations ?? []).map((loc) => ({
      ...loc,
      path: normalizeDisplayPath(loc.path),
    }));
    const acpStatus: ToolCallStatus = fields.status ?? 'pending';
    const exitCode = extractToolExitCode(fields.rawOutput);
    const contentText = extractToolContentText(fields.content);
    const rawOutText = extractToolOutputText(fields.rawOutput) ?? '';
    const outputText = contentText || rawOutText;
    const diffs = extractDiffItems(fields.content);
    const title = normalizeDisplayPath(fields.title || fields.name || meta.displayName);
    const target = extractToolTarget(
      {
        title,
        args: fields.args,
        rawInput: fields.rawInput,
        locations,
      },
      meta.targetKind,
    );

    const finished = acpStatus === 'completed' || acpStatus === 'failed';
    const tool: ToolCallItem = {
      toolCallId: fields.toolCallId,
      acpStatus,
      status: mapAcpToolStatusToTsp(acpStatus),
      ...(fields.kind !== undefined ? { kind: fields.kind } : {}),
      ...(fields.name !== undefined ? { rawName: fields.name } : {}),
      displayName: meta.displayName,
      targetKind: meta.targetKind,
      title,
      ...(target !== undefined ? { target } : {}),
      ...(fields.args !== undefined ? { args: fields.args } : {}),
      ...(fields.rawInput !== undefined ? { rawInput: fields.rawInput } : {}),
      ...(fields.rawOutput !== undefined ? { rawOutput: fields.rawOutput } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      outputText,
      diffs,
      locations,
      startedAt: now,
      ...(finished ? { endedAt: now, tookMs: 0 } : {}),
      collapsed: options.defaultCollapsed ?? true,
      awaitingPermission: false,
      cancelled: false,
    };

    turn.toolCalls.push(tool);
    turn.timeline.push({ kind: 'tool', id: tool.toolCallId });
    this._toolIndex.set(tool.toolCallId, { turnIndex: turn.index, tool });
    this.syncSubagentsForTool(turn, tool);
    if (!isReplaying) {
      this.syncBackgroundTaskForTool(turn.index, tool);
    }

    return tool;
  }

  private syncBackgroundTaskForTool(turnIndex: number, tool: ToolCallItem): void {
    const rawName = (tool.rawName ?? '').toLowerCase();
    const titleLower = tool.title.toLowerCase();
    const inputRec = asRecord(tool.args) ?? asRecord(tool.rawInput);
    const action = firstStringField(inputRec, ['Action', 'action'])?.toLowerCase() ?? '';
    const targetTaskId = firstStringField(inputRec, ['TaskId', 'taskId', 'task_id', 'CommandId']);

    const isManageTaskByNameOrTitle =
      rawName === 'manage_task' ||
      rawName === 'command_status' ||
      titleLower === 'manage_task' ||
      titleLower.includes('manage_task') ||
      titleLower === 'command_status' ||
      titleLower.includes('command_status');
    const isManageTaskByInputShape =
      (action === 'kill' ||
        action === 'cancel' ||
        action === 'stop' ||
        action === 'status' ||
        action === 'list') &&
      (Boolean(targetTaskId) || action === 'list');
    const isCommandStatus =
      rawName === 'command_status' ||
      titleLower === 'command_status' ||
      titleLower.includes('command_status');

    // 1. Handle `manage_task` / `command_status` settling existing detached background tasks
    if (
      (isManageTaskByNameOrTitle || isManageTaskByInputShape) &&
      (tool.status === 'done' || tool.status === 'error')
    ) {
      const outText = tool.outputText || '';

      if (action === 'kill' || action === 'cancel' || action === 'stop') {
        if (targetTaskId) {
          this.completeBackgroundTask(targetTaskId, 'cancelled');
        } else {
          // If no explicit TaskId, cancel sole running non-subagent detached task
          const runningNonSub = [...this._detachedBgTasks.values()].filter(
            (t) => t.status === 'running' && t.agentKind !== 'subagent',
          );
          if (runningNonSub.length === 1) {
            runningNonSub[0]!.status = 'cancelled';
            runningNonSub[0]!.endedAt = this._now();
          }
        }
        return;
      }

      if (action === 'status' || isCommandStatus) {
        const terminal = inferTerminalBgStatusFromText(outText);
        if (terminal && targetTaskId) {
          this.completeBackgroundTask(targetTaskId, terminal);
        }
        return;
      }

      if (action === 'list') {
        if (/\b(?:no\s+(?:running|active)\s+tasks?|0\s+running|none\s+running)\b/i.test(outText)) {
          const now = this._now();
          for (const task of this._detachedBgTasks.values()) {
            if (task.status === 'running' && task.agentKind !== 'subagent') {
              task.status = 'completed';
              task.endedAt = now;
            }
          }
        }
        return;
      }
      return;
    }

    // 2. If a previously tracked detached tool later gets updated to error/cancelled, settle it
    const existingDetached = this._detachedBgTasks.get(tool.toolCallId);
    if (existingDetached) {
      if (tool.status === 'error' || tool.status === 'cancelled') {
        existingDetached.status = tool.status === 'error' ? 'failed' : 'cancelled';
        existingDetached.endedAt = this._now();
        existingDetached.outputText = tool.outputText;
      } else if (tool.outputText) {
        existingDetached.outputText = tool.outputText;
      }
      return;
    }

    // 3. Detect newly detached background tasks when tool call resolves as `done`
    if (tool.status === 'done') {
      const detected = detectDetachedBackgroundTask(tool, turnIndex);
      if (detected) {
        this._detachedBgTasks.set(tool.toolCallId, detected);
      }
    }
  }

  private reconcileBackgroundCompletionFromText(text: string): void {
    if (!text || this._detachedBgTasks.size === 0) return;
    const now = this._now();

    // Explicit `Task id "<id>" finished / exited / killed / failed` notification
    const explicitTaskRe =
      /\btask\s+id\s+["'`]?([A-Za-z0-9._:/-]+)["'`]?\s+(finished|completed|exited|killed|cancelled|canceled|failed|stopped)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = explicitTaskRe.exec(text)) !== null) {
      const id = match[1];
      const verb = (match[2] ?? '').toLowerCase();
      if (!id) continue;
      const status: 'completed' | 'failed' | 'cancelled' =
        verb === 'failed'
          ? 'failed'
          : verb === 'killed' || verb === 'cancelled' || verb === 'canceled' || verb === 'stopped'
            ? 'cancelled'
            : 'completed';
      this.completeBackgroundTask(id, status);
    }

    // Match any running detached task's taskId / conversationId when accompanied by a terminal cue
    const terminal = inferTerminalBgStatusFromText(text);
    if (!terminal) return;
    for (const task of this._detachedBgTasks.values()) {
      if (task.status !== 'running') continue;
      const needle = task.taskId ?? task.conversationId;
      if (needle && text.includes(needle)) {
        task.status = terminal;
        task.endedAt = now;
      }
    }
  }

  private syncSubagentsForTool(turn: TranscriptTurn, tool: ToolCallItem): void {
    const parsed = parseSubagentEntries(tool);
    if (parsed.length === 0) return;

    // Replace existing entries belonging to this toolCallId in place
    for (const next of parsed) {
      const idx = turn.agents.findIndex((a) => a.id === next.id);
      if (idx >= 0) {
        const prevCollapsed = turn.agents[idx]?.collapsed;
        turn.agents[idx] = prevCollapsed !== undefined ? { ...next, collapsed: prevCollapsed } : next;
      } else {
        turn.agents.push(next);
      }
    }
  }
}
