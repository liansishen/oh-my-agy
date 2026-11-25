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
  isToolRawOutputTimedOut,
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
import type { TodoServerUpdateEvent } from '../mcp/todo_server';
import type {
  TranscriptBackgroundTaskRecord,
  TranscriptCompactionCheckpoint,
} from './session_metrics';
import {
  applyTodoOperation,
  areAllTodosFinished,
  cloneTodoPhases,
  extractUserTodoSyncReminderFromText,
  isOmaTodoToolName,
  isTodoTaskFinished,
  mapTodoPhasesToChecklist,
  type TodoOp,
  type TodoPhase,
} from './todo';

export const LONG_RUNNING_TOOL_THRESHOLD_MS = 10_000;
const MAX_PENDING_TODO_SNAPSHOTS = 32;
const FALLBACK_FAILED_TODO_TEXT = 'Todo tool call failed.';
const MUTATING_TODO_OPS = new Set<string>(['init', 'start', 'done', 'rm', 'drop', 'append']);

function parseTodoInputRecord(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    try {
      return asRecord(JSON.parse(raw)) ?? undefined;
    } catch {
      return undefined;
    }
  }
  return asRecord(raw) ?? undefined;
}

function extractRawTodoOp(raw: unknown): string | undefined {
  const op = parseTodoInputRecord(raw)?.op;
  return typeof op === 'string' && op.trim().length > 0 ? op.trim().toLowerCase() : undefined;
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  const rec = asRecord(value);
  if (!rec) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(rec).sort()) {
    if (rec[key] !== undefined) out[key] = sortJsonKeys(rec[key]);
  }
  return out;
}

function canonicalTodoArgsKey(raw: unknown): string | undefined {
  const rec = parseTodoInputRecord(raw);
  return rec ? JSON.stringify(sortJsonKeys(rec)) : undefined;
}

function getEffectiveTodoToolRawInput(tool: ToolCallItem): unknown {
  const recRaw = parseTodoInputRecord(tool.rawInput);
  if (recRaw && Object.keys(recRaw).length > 0) return tool.rawInput;
  const recArgs = parseTodoInputRecord(tool.args);
  if (recArgs && Object.keys(recArgs).length > 0) return tool.args;
  return tool.rawInput ?? tool.args;
}

function scoreTodoSnapshotMatch(
  snap: { readonly rawOp?: string; readonly argsKey?: string; readonly isError: boolean },
  tool: ToolCallItem,
): number {
  if (!snap.isError && tool.acpStatus === 'failed') return 0;
  const toolRaw = getEffectiveTodoToolRawInput(tool);
  const toolArgsKey = canonicalTodoArgsKey(toolRaw);
  if (snap.argsKey !== undefined && toolArgsKey !== undefined) {
    return snap.argsKey === toolArgsKey ? 2 : 0;
  }
  const toolRawOp = extractRawTodoOp(toolRaw);
  if (snap.rawOp !== undefined && toolRawOp !== undefined) {
    return snap.rawOp === toolRawOp ? 1 : 0;
  }
  return 0;
}

function normalizeTodoOpName(rawArgs: unknown): TodoOp {
  const raw = extractRawTodoOp(rawArgs);
  return raw && (raw === 'view' || MUTATING_TODO_OPS.has(raw)) ? (raw as TodoOp) : 'view';
}

function mergeDistinctDiagnosticText(primary: string, secondary: string): string {
  const a = primary.trim();
  const b = secondary.trim();
  if (!b || a.includes(b)) return a;
  if (!a || b.includes(a)) return b;
  return `${a}\n${b}`;
}

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
  /** True when reconstructed during `session/load` replay where wall-clock duration is unknown. */
  readonly replayed?: boolean;
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
  /** Short human-readable intent label (e.g. `toolSummary` / `_intent`) shown in `<tool intent>`. */
  intent?: string;
  args?: Record<string, unknown>;
  rawInput?: unknown;
  rawOutput?: unknown;
  exitCode?: number;
  timedOut?: boolean;
  outputText: string;
  /** Accumulated output text strictly from `failed` status updates onward. */
  failureOutputText?: string;
  diffs: ToolDiffItem[];
  locations: ToolCallLocation[];
  readonly startedAt: number;
  endedAt?: number;
  tookMs?: number;
  /** True when reconstructed during `session/load` replay. */
  readonly replayed?: boolean;
  /** Monotonic event sequence assigned when this tool call is first created. */
  readonly eventSeq: number;
  collapsed: boolean;
  userToggled?: boolean;
  awaitingPermission: boolean;
  permissionRequestId?: JsonRpcId;
  ask?: MappedPermissionOptions['ask'];
  approved?: 'once' | 'always' | 'denied';
  cancelled: boolean;
  /** Authoritative task ID when promoted/handed off to a background task. */
  backgroundTaskId?: string;
  /** True while actively tracked as a running background task. */
  backgroundRunning?: boolean;
  /** True when the tool call targets oma's embedded `oma_todo` MCP tool. */
  isOmaTodo?: boolean;
  /** Authoritative structured snapshot captured from oma's embedded `todo` MCP tool. */
  todoSnapshot?: {
    readonly phases: readonly TodoPhase[];
    readonly op: TodoOp;
    readonly isError: boolean;
    readonly text: string;
  };
  /** True when the tool call targets agy's native `update_steps` tool. */
  isUpdateSteps?: boolean;
  /** Structured checklist entries captured from a native `update_steps` tool call. */
  updateStepsEntries?: readonly PlanItemState[];
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
  readonly startedAt?: number;
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
  checkpointStepIndex?: number;
}

export interface VisibleTranscriptSlice {
  readonly turns: readonly TranscriptTurn[];
  readonly hiddenCompactedTurnCount: number;
  readonly totalCompactedTurnCount: number;
  readonly hasCompactedHistory: boolean;
  readonly compactedHistoryExpanded: boolean;
}

export interface PlanItemState {
  readonly id: string;
  readonly text: string;
  readonly priority?: PlanEntryPriority;
  readonly note?: string;
  readonly status: TspChecklistStatus;
}

export interface PlanPhaseState {
  readonly id: string;
  readonly title: string;
  readonly items: readonly PlanItemState[];
  readonly collapsed?: boolean;
}

export interface PlanState {
  readonly entries: readonly PlanItemState[];
  readonly phases?: readonly PlanPhaseState[];
  readonly source?: 'acp' | 'todo_tool';
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
  /** True when reconstructed during `session/load` replay where original turn duration is unknown. */
  readonly replayed?: boolean;
  /** Replayed `<system-reminder>` todo phases checkpoint attached to this historical turn. */
  replayedUserTodoPhases?: TodoPhase[];
  /** Replay sequence of `replayedUserTodoPhases` for plan ownership comparison. */
  replayedUserTodoSeq?: number;
  /** Monotonic per-turn mutation counter used for reliable view-level memo invalidation. */
  revision: number;
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
  readonly scheduleKind?: 'timer' | 'cron';
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
  /** True when created from an ACP tool call still `in_progress` at `end_turn` (settles on `tool_call_update`). */
  readonly awaitingToolCompletion?: boolean;
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

type PlanTimelineEvent =
  | {
      readonly phaseRank: 0 | 2;
      readonly seq: number;
      readonly kind: 'direct_plan';
      readonly op: 'set' | 'clear' | 'remove';
      readonly entries: readonly PlanItemState[];
      readonly updatedAt: number;
    }
  | {
      readonly phaseRank: 0 | 1 | 2;
      readonly seq: number;
      readonly kind: 'todo_mutation';
      readonly source: 'todo_tool' | 'user';
      readonly phases: readonly TodoPhase[];
      readonly updatedAt: number;
      readonly isRestoredAnchor?: boolean;
    }
  | {
      readonly phaseRank: 0 | 2;
      readonly seq: number;
      readonly kind: 'update_steps';
      readonly entries: readonly PlanItemState[];
      readonly turn: TranscriptTurn;
      readonly updatedAt: number;
    };

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

function isUpdateStepsToolName(rawName?: string, title?: string): boolean {
  const n = rawName?.trim().toLowerCase() ?? '';
  if (n === 'update_steps' || n === 'default_api:update_steps') {
    return true;
  }
  const t = title?.trim().toLowerCase() ?? '';
  return (
    t === 'update_steps' ||
    t === 'run update_steps' ||
    t === 'default_api:update_steps' ||
    t === 'run default_api:update_steps'
  );
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
  if (isOmaTodoToolName(rawName) || isUpdateStepsToolName(rawName)) {
    return { displayName: 'todo', targetKind: 'text' };
  }

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

function extractToolIntent(
  fields: Pick<ToolCallFields, 'args' | 'rawInput'>,
  title?: string,
  target?: string,
): string | undefined {
  const inputRec = asRecord(fields.args) ?? asRecord(fields.rawInput);
  const raw = firstStringField(inputRec, [
    'toolSummary',
    'ToolSummary',
    '_intent',
    'intent',
    'Intent',
    'Description',
    'description',
  ]);
  if (!raw) return undefined;
  const cleaned = collapseSingleLine(raw, 72);
  if (!cleaned) return undefined;
  const lower = cleaned.toLowerCase();
  if (title && lower === title.trim().toLowerCase()) return undefined;
  if (target && lower === target.trim().toLowerCase()) return undefined;
  return cleaned;
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

const TOOL_TIMESTAMPS_RE =
  /^Created At:\s*([^\r\n]+)\r?\nCompleted At:\s*([^\r\n]+)(?:\r?\n|$)/;

/**
 * Extract real wall-clock tool execution duration from `agy` tool output headers
 * (`Created At: <ISO>\nCompleted At: <ISO>`), useful when replaying historical sessions.
 */
export function extractToolDurationFromOutput(outputText: string): number | undefined {
  if (!outputText || !outputText.startsWith('Created At:')) return undefined;
  const match = TOOL_TIMESTAMPS_RE.exec(outputText);
  if (!match?.[1] || !match[2]) return undefined;
  const createdMs = Date.parse(match[1].trim());
  const completedMs = Date.parse(match[2].trim());
  if (!Number.isFinite(createdMs) || !Number.isFinite(completedMs)) return undefined;
  const delta = completedMs - createdMs;
  if (delta < 0 || delta > 24 * 60 * 60 * 1000) return undefined;
  return delta;
}

/**
 * Extract leading `agy` shell summary status (`Command exited with code N` or
 * `Command timed out`) after optional `Created At:` / `Completed At:` headers.
 */
export function extractLeadingBashExitStatus(outputText: string): {
  readonly exitCode?: number;
  readonly timedOut?: boolean;
} {
  if (!outputText) return {};
  const lines = outputText.split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (/^(?:Created|Completed)\s+At:/i.test(trimmed)) continue;
    const exitMatch = /^Command\s+exited\s+with\s+code\s+(-?\d+)\b/i.exec(trimmed);
    if (exitMatch?.[1]) {
      const code = Number(exitMatch[1]);
      return Number.isFinite(code) ? { exitCode: code } : {};
    }
    if (/^Command\s+timed\s+out\b/i.test(trimmed)) {
      return { timedOut: true };
    }
    return {};
  }
  return {};
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

const MCP_COMMAND_TOOL_NAMES = new Set([
  'exec',
  'exec_many',
  'run_command',
  'bash',
  'shell',
  'command',
  'job_start',
  'command_status',
  'send_command_input',
]);

const COMPOUND_TOOL_NAME_RE =
  /^([A-Za-z0-9_-]+(?:(?::\s*|\/|\.|__)([A-Za-z0-9_-]+))+)(?:\s|$|\()/;

function classifyMcpCommandToken(token: string | undefined): BackgroundJobType | null {
  if (!token) return null;
  const lower = token.trim().toLowerCase();
  if (!lower || !MCP_COMMAND_TOOL_NAMES.has(lower)) return null;
  return lower === 'job_start' ? 'task' : 'bash';
}

function collapseSingleLine(text: string, maxLen = 96): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLen) return oneLine;
  return `${oneLine.slice(0, maxLen - 1).trimEnd()}…`;
}

function isSwarmOrSubagentTool(tool: ToolCallItem): boolean {
  const rawName = (tool.rawName ?? '').toLowerCase();
  const titleLower = tool.title.toLowerCase();
  return (
    rawName === 'swarm' ||
    titleLower.startsWith('swarm') ||
    rawName === 'invoke_subagent' ||
    rawName === 'subagent' ||
    titleLower.includes('invoke_subagent')
  );
}

function classifyNonAgentJobType(tool: ToolCallItem): BackgroundJobType | null {
  if (isSwarmOrSubagentTool(tool)) return null;

  const rawName = (tool.rawName ?? '').toLowerCase();
  const titleLower = tool.title.toLowerCase();
  const inputRec = asRecord(tool.args) ?? asRecord(tool.rawInput);

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

  if (
    inputRec &&
    (typeof inputRec.CommandLine === 'string' ||
      inputRec.WaitMsBeforeAsync !== undefined ||
      inputRec.IsDaemon !== undefined ||
      inputRec.isDaemon !== undefined)
  ) {
    return 'bash';
  }

  if (rawName === 'call_mcp_tool' || titleLower === 'call_mcp_tool' || titleLower.startsWith('call_mcp_tool')) {
    const mcpToolName = firstStringField(inputRec, ['ToolName', 'toolName', 'tool_name']);
    const mcpType = classifyMcpCommandToken(mcpToolName);
    if (mcpType) return mcpType;
  }

  if (/[:/._]/.test(rawName)) {
    const tokens = rawName.split(/[:/.\s]+|__/).filter(Boolean);
    const tailType = classifyMcpCommandToken(tokens[tokens.length - 1]);
    if (tailType) return tailType;
  }

  const compoundTitleMatch = COMPOUND_TOOL_NAME_RE.exec(tool.title.trim());
  if (compoundTitleMatch?.[2]) {
    const titleTailType = classifyMcpCommandToken(compoundTitleMatch[2]);
    if (titleTailType) return titleTailType;
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

const AUTHORITATIVE_BG_RUNNING_RE =
  /(?:^|\n)\s*(?:Tool\s+is\s+running\s+as\s+a\s+background\s+task|Command\s+is\s+running\s+in\s+the\s+background|Workflow\s+running\s+in\s+the\s+background)\b/i;

const HEADER_BODY_CUTOFF_RE = /(?:^|\r?\n)\s*(?:Command\s+output|Log\s+output)\s*:/i;
const LEADING_COMPLETED_HEADER_RE =
  /^(?:\s*Created\s+At:[^\r\n]*\r?\n\s*Completed\s+At:|\s*Command\s+exited\s+with\s+code\s+-?\d+)/i;
const HEADER_EXITED_LINE_RE = /(?:^|\r?\n)\s*Command\s+exited\s+with\s+code\s+-?\d+/i;

const SYNC_ONLY_TOOL_NAMES = new Set([
  'manage_task',
  'command_status',
  'send_command_input',
  'exit_plan_mode',
  'ask_question',
  'read_file',
  'view_file',
  'list_dir',
  'edit_file',
  'write_file',
  'replace_file_content',
  'define_subagent',
  'manage_subagents',
  'send_message',
  'todo',
  'mcp_oma_todo_todo',
]);

function isSynchronousMcpCommandTool(tool: ToolCallItem): boolean {
  const rawName = (tool.rawName ?? '').toLowerCase();
  const titleLower = tool.title.toLowerCase();
  const inputRec = asRecord(tool.args) ?? asRecord(tool.rawInput);

  if (
    rawName === 'call_mcp_tool' ||
    titleLower === 'call_mcp_tool' ||
    titleLower.startsWith('call_mcp_tool')
  ) {
    const mcpToolName = firstStringField(inputRec, ['ToolName', 'toolName', 'tool_name'])?.toLowerCase();
    return mcpToolName === 'exec' || mcpToolName === 'exec_many';
  }

  if (/[:/._]/.test(rawName)) {
    const tokens = rawName.split(/[:/.\s]+|__/).filter(Boolean);
    const tail = tokens[tokens.length - 1];
    if (tokens.length > 1 && (tail === 'exec' || tail === 'exec_many')) {
      return true;
    }
  }

  const compoundTitleMatch = COMPOUND_TOOL_NAME_RE.exec(tool.title.trim());
  if (compoundTitleMatch?.[2]) {
    const tail = compoundTitleMatch[2].toLowerCase();
    if (tail === 'exec' || tail === 'exec_many') {
      return true;
    }
  }

  return false;
}

/**
 * Strip `Task Description:` body and `Command output:` / `Log output:` tails before checking
 * status headers so command stdout or arguments never trigger terminal suppression or phantom
 * background-task promotion.
 */
function extractBackgroundHeaderText(outText: string): string {
  if (!outText) return '';
  const bodyIdx = outText.search(HEADER_BODY_CUTOFF_RE);
  const beforeBody = bodyIdx >= 0 ? outText.slice(0, bodyIdx) : outText;
  return beforeBody.replace(
    /(?:^|\r?\n)\s*Task\s+Description:\s*[\s\S]*?(?=(?:\r?\n\s*(?:Task\s+logs\s+are\s+available\s+at:|YOU\s+MUST\s+TAKE\s+ONE)|$))/gi,
    '',
  );
}

function extractTaskIdFromTool(tool: ToolCallItem, textOverride?: string): string | undefined {
  const outRec = asRecord(tool.rawOutput);
  const directOut = firstStringField(outRec, ['taskId', 'task_id', 'TaskId', 'jobId', 'job_id', 'workflowId', 'workflow_id']);
  if (directOut) return directOut;

  const text = textOverride ?? extractBackgroundHeaderText(tool.outputText || '');
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
  const headerText = extractBackgroundHeaderText(outText);
  const hasExplicitCompletedHeader =
    LEADING_COMPLETED_HEADER_RE.test(headerText) || HEADER_EXITED_LINE_RE.test(headerText);
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

  if (explicitlyFinishedInObj || hasExplicitCompletedHeader) return null;

  const hasAuthoritativeBgHeader = AUTHORITATIVE_BG_RUNNING_RE.test(headerText);
  const hasTerminalHeader = !hasAuthoritativeBgHeader && TERMINAL_BG_OUTPUT_RE.test(headerText);

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
      /running\s+(?:as\s+a\s+|in\s+the\s+)?background/i.test(headerText) ||
      /\bsubagent\b.*\b(?:launched|started|running)\b/i.test(headerText);
    if (!hasBgCue || hasTerminalHeader) {
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
    const taskId = extractTaskIdFromTool(tool, headerText);
    const hasScheduleCue =
      explicitlyBgInObj ||
      hasTimerSpec ||
      Boolean(taskId) ||
      /\b(?:scheduled|timer|cron|running\s+as\s+a\s+background)\b/i.test(outText);
    if (
      !hasScheduleCue ||
      (!hasAuthoritativeBgHeader &&
        /\b(?:cancelled|canceled|removed|deleted|stopped|failed)\b/i.test(headerText))
    ) {
      return null;
    }
    const hasCronSpec =
      typeof inputRec?.CronExpression === 'string' ||
      typeof inputRec?.cronExpression === 'string' ||
      /\bTask\s+Description:\s*Cron\s*:/i.test(outText);
    const hasOneShotTimerSpec =
      !hasCronSpec &&
      (inputRec?.DurationSeconds !== undefined ||
        inputRec?.durationSeconds !== undefined ||
        /\bTask\s+Description:\s*Timer\s*:/i.test(outText));
    const scheduleKind: 'timer' | 'cron' | undefined = hasCronSpec
      ? 'cron'
      : hasOneShotTimerSpec
        ? 'timer'
        : undefined;
    const command = firstStringField(inputRec, ['CronExpression', 'cronExpression']);
    const desc =
      firstStringField(inputRec, ['Prompt', 'prompt', 'Description', 'description']) ?? tool.title;
    return {
      id: tool.toolCallId,
      toolCallId: tool.toolCallId,
      ...(taskId ? { taskId } : {}),
      type: 'schedule',
      ...(scheduleKind ? { scheduleKind } : {}),
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
    const taskId = extractTaskIdFromTool(tool, headerText);
    const hasBgCue =
      explicitlyBgInObj ||
      Boolean(taskId) ||
      hasAuthoritativeBgHeader ||
      /running\s+(?:as\s+a\s+|in\s+the\s+)?background/i.test(headerText) ||
      /\bbackground\s+(?:task|workflow)\b/i.test(headerText);
    if (!hasBgCue || hasTerminalHeader) {
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

  // 4. run_command / bash / MCP command turned into background task (exceeded WaitMsBeforeAsync or IsDaemon)
  const classifiedType = classifyNonAgentJobType(tool);
  const isBash =
    classifiedType === 'bash' ||
    tool.kind?.toLowerCase() === 'execute' ||
    tool.displayName.toLowerCase() === 'bash' ||
    rawName === 'run_command' ||
    rawName === 'bash' ||
    rawName === 'shell' ||
    rawName === 'exec' ||
    titleLower === 'run_command' ||
    titleLower.startsWith('run_command');
  if (isBash) {
    const taskId = extractTaskIdFromTool(tool, headerText);
    if (isSynchronousMcpCommandTool(tool)) {
      if (!(explicitlyBgInObj || hasAuthoritativeBgHeader) || hasTerminalHeader) {
        return null;
      }
    } else {
      const isDaemon = inputRec?.IsDaemon === true || inputRec?.isDaemon === true;
      const hasOutputBgCue =
        hasAuthoritativeBgHeader ||
        /\b(?:is\s+running|running|started|launched|moved|continuing)\s+(?:as\s+a\s+|in\s+the\s+)?background\b/i.test(
          headerText,
        ) ||
        (Boolean(taskId) && /\b(?:running|background|async|detach)/i.test(headerText));
      // Do not treat zero/default exit_code as exited when explicitly marked background or carrying authoritative background header
      const hasExited = tool.exitCode !== undefined && !explicitlyBgInObj && !hasAuthoritativeBgHeader;
      const hasBgCue = isDaemon || explicitlyBgInObj || hasOutputBgCue;
      if (!hasBgCue || hasExited || hasTerminalHeader) {
        return null;
      }
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

  // 5. Generic fallback for any other tool explicitly handed off to background execution
  if (!isSwarmOrSubagentTool(tool) && (explicitlyBgInObj || hasAuthoritativeBgHeader) && !hasTerminalHeader) {
    const taskId = extractTaskIdFromTool(tool, headerText);
    const fallbackType = classifiedType ?? 'task';
    const command =
      tool.target ||
      firstStringField(inputRec, ['CommandLine', 'command', 'cmd', 'script']);
    const label = collapseSingleLine(command || tool.title || tool.rawName || fallbackType, 88);
    return {
      id: tool.toolCallId,
      toolCallId: tool.toolCallId,
      ...(taskId ? { taskId } : {}),
      type: fallbackType,
      label,
      ...(command ? { command } : {}),
      ...(tool.title && tool.title !== command ? { title: tool.title } : {}),
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

function findCompactionTimelineInsertIndex(
  turn: TranscriptTurn,
  checkpoint: TranscriptCompactionCheckpoint,
): number {
  const timeline = turn.timeline;
  if (timeline.length === 0) return 0;

  const toolsBefore = checkpoint.toolCallsBeforeInTurn;
  const assistantsBefore = checkpoint.assistantResponsesBeforeInTurn;

  if (checkpoint.precededByCompactCommand && toolsBefore === 0 && assistantsBefore === 0) {
    return 0;
  }

  if (toolsBefore > 0) {
    let seenTools = 0;
    for (let i = 0; i < timeline.length; i++) {
      if (timeline[i]!.kind === 'tool') {
        seenTools += 1;
        if (seenTools === toolsBefore) {
          return i + 1;
        }
      }
    }
    return timeline.length;
  }

  if (assistantsBefore > 0) {
    let seenAssistants = 0;
    for (let i = 0; i < timeline.length; i++) {
      if (timeline[i]!.kind === 'assistant') {
        seenAssistants += 1;
        if (seenAssistants === assistantsBefore) {
          return i + 1;
        }
      }
    }
    return timeline.length;
  }

  return 0;
}

export class TranscriptStore {
  private readonly _now: () => number;
  private _turns: TranscriptTurn[] = [];
  private _plan: PlanState | null = null;
  private _todoPhases: TodoPhase[] = [];
  private _replayedTodoPhases: TodoPhase[] = [];
  private _todoToolCallCount = 0;
  private readonly _countedTodoToolIds = new Set<string>();
  private _todoRevision = 0;
  private _eventSeq = 0;
  private _restoredAnchorMaxCount: number | null = null;
  private _userTodoAnchorFloor = 0;
  private _hasUserTodoOverride = false;
  private _hasLiveTodoMutation = false;
  private _replayedTodoEvents: PlanTimelineEvent[] = [];
  private _planEvents: PlanTimelineEvent[] = [];
  private readonly _pendingTodoSnapshots: Array<{
    readonly phases: TodoPhase[];
    readonly op: TodoOp;
    readonly isError: boolean;
    readonly text: string;
    readonly rawOp?: string;
    readonly argsKey?: string;
  }> = [];
  private _activeTurnIndex: number | null = null;

  private readonly _toolIndex = new Map<string, { turnIndex: number; tool: ToolCallItem }>();
  private readonly _detachedBgTasks = new Map<string, DetachedBackgroundTask>();
  private readonly _settledTranscriptTaskIds = new Set<string>();
  private readonly _settledIds = new Set<string>();
  private readonly _evictedIds = new Set<string>();
  private _compactedBeforeTurnIndex: number | null = null;
  private _showCompactedHistory = false;
  private _lastAppliedCheckpointStepIndex: number | null = null;
  private _preferNativeSteps: boolean;
  private _idSeq = 1;

  constructor(options: { now?: () => number; preferNativeSteps?: boolean } = {}) {
    this._now = options.now ?? (() => Date.now());
    this._preferNativeSteps = options.preferNativeSteps ?? false;
  }

  setPreferNativeSteps(prefer: boolean): void {
    this._preferNativeSteps = prefer;
  }

  get turns(): readonly TranscriptTurn[] {
    return this._turns;
  }

  get plan(): PlanState | null {
    return this._plan;
  }

  get todoPhases(): readonly TodoPhase[] {
    return this._todoPhases;
  }

  get todoToolCallCount(): number {
    return this._todoToolCallCount;
  }

  get persistedTodoToolCallCount(): number {
    return this._hasUserTodoOverride
      ? Math.max(this._todoToolCallCount, this._userTodoAnchorFloor)
      : this._todoToolCallCount;
  }

  get todoRevision(): number {
    return this._todoRevision;
  }

  get hasPersistedTodoState(): boolean {
    return (
      this._todoPhases.length > 0 ||
      this._todoToolCallCount > 0 ||
      this._hasUserTodoOverride
    );
  }

  get hasUserTodoOverride(): boolean {
    return this._hasUserTodoOverride;
  }

  get replayedTodoPhases(): readonly TodoPhase[] {
    return this._replayedTodoPhases;
  }

  setTodoPhases(
    phases: readonly TodoPhase[],
    options: {
      readonly source?: 'todo_tool' | 'user';
      readonly isRestoringSessionAnchor?: boolean;
      readonly restoredAnchorToolCallCount?: number;
    } = {},
  ): void {
    const source = options.source ?? 'todo_tool';
    const cleaned = cloneTodoPhases(phases).filter((phase) => phase.tasks.length > 0);
    const isRestoringAnchor =
      options.isRestoringSessionAnchor === true ||
      options.restoredAnchorToolCallCount !== undefined;

    if (isRestoringAnchor) {
      const maxCount = options.restoredAnchorToolCallCount ?? this._todoToolCallCount;
      this._planEvents = this._planEvents.filter(
        (e) => !(e.kind === 'todo_mutation' && e.isRestoredAnchor),
      );
      if (this._todoToolCallCount > maxCount) {
        this._restoredAnchorMaxCount = null;
        this.recomputeReplayedTodos();
        return;
      }
      this._restoredAnchorMaxCount = source === 'user' ? maxCount : null;
      this._hasUserTodoOverride = source === 'user';
      this._userTodoAnchorFloor =
        source === 'user'
          ? Math.max(this._userTodoAnchorFloor, maxCount, this._todoToolCallCount)
          : 0;
      this._todoPhases = cleaned;
      this._todoRevision += 1;
      this._planEvents.push({
        phaseRank: 1,
        seq: ++this._eventSeq,
        kind: 'todo_mutation',
        source,
        phases: cleaned,
        updatedAt: this._now(),
        isRestoredAnchor: true,
      });
      this.deriveEffectivePlan();
      return;
    }

    this._hasLiveTodoMutation = true;
    this._restoredAnchorMaxCount = null;
    this._hasUserTodoOverride = source === 'user';
    this._userTodoAnchorFloor =
      source === 'user' ? Math.max(this._userTodoAnchorFloor, this._todoToolCallCount) : 0;
    this._todoPhases = cleaned;
    this._todoRevision += 1;
    this._planEvents.push({
      phaseRank: 2,
      seq: ++this._eventSeq,
      kind: 'todo_mutation',
      source,
      phases: cleaned,
      updatedAt: this._now(),
    });
    this.deriveEffectivePlan();
  }

  applyLiveTodoToolResult(event: TodoServerUpdateEvent): void {
    const rawOp = extractRawTodoOp(event.rawArgs);
    const argsKey = canonicalTodoArgsKey(event.rawArgs);
    const snapshot = {
      phases: cloneTodoPhases(event.phases),
      op: event.op,
      isError: event.isError,
      text: event.text,
    };
    if (!event.isError && event.op !== 'view') {
      this.setTodoPhases(snapshot.phases, { source: 'todo_tool' });
    }

    const candidate = { rawOp, argsKey, isError: event.isError };
    let matchedTool: { turn: TranscriptTurn; tool: ToolCallItem } | undefined;
    let bestScore = 0;
    for (let i = 0; i < this._turns.length && bestScore < 2; i++) {
      const turn = this._turns[i]!;
      for (let j = 0; j < turn.toolCalls.length; j++) {
        const tool = turn.toolCalls[j]!;
        if (
          !tool.replayed &&
          (tool.isOmaTodo || isOmaTodoToolName(tool.rawName, tool.title)) &&
          !tool.todoSnapshot
        ) {
          const score = scoreTodoSnapshotMatch(candidate, tool);
          if (score > bestScore) {
            bestScore = score;
            matchedTool = { turn, tool };
            if (score === 2) {
              break;
            }
          }
        }
      }
    }

    if (matchedTool) {
      this.assignTodoSnapshotToTool(matchedTool.turn, matchedTool.tool, snapshot);
      return;
    }

    if (this._pendingTodoSnapshots.length >= MAX_PENDING_TODO_SNAPSHOTS) {
      this._pendingTodoSnapshots.shift();
    }
    this._pendingTodoSnapshots.push({ ...snapshot, rawOp, argsKey });
  }

  addInfoNotice(text: string, level: NoticeItem['level'] = 'info'): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const turn = this.ensureActiveTurn(false);
    const notice: NoticeItem = {
      id: `notice-${this._idSeq++}`,
      kind: 'notice',
      level,
      text: trimmed,
      summaryText: '',
      collapsed: false,
      timestamp: this._now(),
    };
    turn.notices.push(notice);
    turn.timeline.push({ kind: 'notice', id: notice.id });
    this.bumpTurn(turn);
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

  get compactedBeforeTurnIndex(): number | null {
    return this._compactedBeforeTurnIndex;
  }

  get showCompactedHistory(): boolean {
    return this._showCompactedHistory;
  }

  /**
   * Turns that have not been evicted by Tern (`GoneEvent`).
   * Views should render only these turns so no ops target dropped nodes.
   */
  getVisibleTurns(): readonly TranscriptTurn[] {
    return this._turns.filter((t) => !t.evicted);
  }

  /**
   * Mark all turns with index `< turnIndex` as pre-compaction history and collapse
   * them by default (`_showCompactedHistory = false`) monotonically per session.
   */
  markCompactedAtTurn(turnIndex: number): boolean {
    if (!Number.isInteger(turnIndex) || turnIndex < 0) {
      return false;
    }
    if (this._compactedBeforeTurnIndex !== null && turnIndex < this._compactedBeforeTurnIndex) {
      return false;
    }
    const changed =
      this._compactedBeforeTurnIndex !== turnIndex || this._showCompactedHistory !== false;
    this._compactedBeforeTurnIndex = turnIndex;
    this._showCompactedHistory = false;
    return changed;
  }

  setShowCompactedHistory(show: boolean): boolean {
    if (this._showCompactedHistory === show) {
      return false;
    }
    this._showCompactedHistory = show;
    return true;
  }

  markCompactionCompleted(
    turnIndex: number,
    options?: { readonly summaryText?: string; readonly text?: string },
  ): boolean {
    const turn = this._turns.find((t) => t.index === turnIndex);
    let addedNotice = false;
    if (turn && !turn.notices.some((n) => n.kind === 'compaction')) {
      const notice: NoticeItem = {
        id: `notice-${this._idSeq++}`,
        kind: 'compaction',
        level: 'info',
        status: 'done',
        text: options?.text || 'Context compacted',
        summaryText: options?.summaryText ?? '',
        collapsed: true,
        timestamp: this._now(),
      };
      turn.notices.push(notice);
      turn.timeline.push({ kind: 'notice', id: notice.id });
      this.bumpTurn(turn);
      addedNotice = true;
    }
    const boundaryChanged = this.markCompactedAtTurn(turnIndex);
    return addedNotice || boundaryChanged;
  }

  applyTranscriptCompactionCheckpoint(checkpoint: TranscriptCompactionCheckpoint): boolean {
    if (this._turns.length === 0) {
      return false;
    }
    if (
      this._lastAppliedCheckpointStepIndex !== null &&
      checkpoint.stepIndex <= this._lastAppliedCheckpointStepIndex
    ) {
      return false;
    }

    const userTurns = this._turns.filter((t) => t.user !== undefined);
    const isCompactUserTurn = (t: TranscriptTurn): boolean =>
      /^\/compact(?:\s|$)/i.test((t.user?.text ?? '').trim());

    let targetTurn: TranscriptTurn | undefined;
    if (checkpoint.userInputsBefore > 0 && checkpoint.userInputsBefore <= userTurns.length) {
      const candidate = userTurns[checkpoint.userInputsBefore - 1]!;
      targetTurn = candidate;
      if (checkpoint.precededByCompactCommand && !isCompactUserTurn(candidate)) {
        for (let i = checkpoint.userInputsBefore - 2; i >= 0; i--) {
          if (isCompactUserTurn(userTurns[i]!)) {
            targetTurn = userTurns[i];
            break;
          }
        }
        if (targetTurn === candidate) {
          for (let i = checkpoint.userInputsBefore; i < userTurns.length; i++) {
            if (isCompactUserTurn(userTurns[i]!)) {
              targetTurn = userTurns[i];
              break;
            }
          }
        }
      }
    } else if (checkpoint.userInputsBefore > userTurns.length && userTurns.length > 0) {
      if (checkpoint.precededByCompactCommand) {
        for (let i = userTurns.length - 1; i >= 0; i--) {
          if (isCompactUserTurn(userTurns[i]!)) {
            targetTurn = userTurns[i];
            break;
          }
        }
      }
      if (!targetTurn) {
        targetTurn = userTurns[userTurns.length - 1];
      }
    } else if (checkpoint.userInputsBefore === 0) {
      targetTurn = this._turns[0];
    } else {
      targetTurn = this._turns[this._turns.length - 1];
    }

    if (!targetTurn) {
      return false;
    }

    const existing = [...targetTurn.notices].reverse().find((n) => n.kind === 'compaction');
    if (
      existing &&
      (existing.checkpointStepIndex === undefined ||
        existing.checkpointStepIndex === checkpoint.stepIndex)
    ) {
      existing.status = 'done';
      existing.text = 'Context compacted';
      existing.checkpointStepIndex = checkpoint.stepIndex;
      if (
        checkpoint.summaryText.length > 0 &&
        (existing.summaryText.length === 0 ||
          checkpoint.summaryText.length > existing.summaryText.length)
      ) {
        existing.summaryText = checkpoint.summaryText;
      }
    } else {
      const notice: NoticeItem = {
        id: `notice-${this._idSeq++}`,
        kind: 'compaction',
        level: 'info',
        status: 'done',
        text: 'Context compacted',
        summaryText: checkpoint.summaryText,
        collapsed: true,
        timestamp: this._now(),
        checkpointStepIndex: checkpoint.stepIndex,
      };
      const insertIdx = findCompactionTimelineInsertIndex(targetTurn, checkpoint);
      targetTurn.notices.push(notice);
      targetTurn.timeline.splice(insertIdx, 0, { kind: 'notice', id: notice.id });
    }

    this.bumpTurn(targetTurn);
    this.markCompactedAtTurn(targetTurn.index);
    this._lastAppliedCheckpointStepIndex = checkpoint.stepIndex;
    return true;
  }

  getVisibleTranscriptSlice(collapseCompacted: boolean): VisibleTranscriptSlice {
    const allVisible = this.getVisibleTurns();
    const boundary = this._compactedBeforeTurnIndex;
    if (boundary === null) {
      return {
        turns: allVisible,
        hiddenCompactedTurnCount: 0,
        totalCompactedTurnCount: 0,
        hasCompactedHistory: false,
        compactedHistoryExpanded: false,
      };
    }

    let preCount = 0;
    for (const turn of allVisible) {
      if (turn.index < boundary) {
        preCount += 1;
      }
    }
    if (preCount === 0 || !collapseCompacted) {
      return {
        turns: allVisible,
        hiddenCompactedTurnCount: 0,
        totalCompactedTurnCount: 0,
        hasCompactedHistory: false,
        compactedHistoryExpanded: false,
      };
    }

    if (this._showCompactedHistory) {
      return {
        turns: allVisible,
        hiddenCompactedTurnCount: 0,
        totalCompactedTurnCount: preCount,
        hasCompactedHistory: true,
        compactedHistoryExpanded: true,
      };
    }

    return {
      turns: allVisible.filter((t) => t.index >= boundary),
      hiddenCompactedTurnCount: preCount,
      totalCompactedTurnCount: preCount,
      hasCompactedHistory: true,
      compactedHistoryExpanded: false,
    };
  }

  getToolById(toolCallId: string): ToolCallItem | undefined {
    return this._toolIndex.get(toolCallId)?.tool;
  }

  /**
   * Start a new interactive user turn (called when the local user submits a prompt).
   */
  beginUserTurn(
    text: string,
    attachments: readonly AttachmentItem[] = [],
    options: { readonly isReplaying?: boolean } = {},
  ): TranscriptTurn {
    const now = this._now();
    // Defensively close any lingering running thoughts / deferred background turn
    if (this.activeTurn) {
      const prevTurn = this.activeTurn;
      this.finalizeRunningThoughts(prevTurn, { now });
      if (!options.isReplaying) {
        for (const task of this._detachedBgTasks.values()) {
          if (
            task.status === 'running' &&
            task.turnIndex === prevTurn.index &&
            task.awaitingToolCompletion === true &&
            !task.taskId &&
            !task.conversationId
          ) {
            task.status = 'completed';
            task.endedAt = now;
            this.syncToolBackgroundState(task.toolCallId, false);
            const tool = prevTurn.toolCalls.find((t) => t.toolCallId === task.toolCallId);
            if (tool && (tool.status === 'pending' || tool.status === 'running' || tool.status === 'ask')) {
              tool.awaitingPermission = false;
              tool.status = 'done';
              tool.endedAt = tool.endedAt ?? now;
              if (!tool.replayed) {
                tool.tookMs = tool.tookMs ?? Math.max(0, tool.endedAt - tool.startedAt);
              }
              this.syncSubagentsForTool(prevTurn, tool);
            }
          }
        }
      }
      if (prevTurn.status === 'streaming') {
        prevTurn.status = 'done';
        prevTurn.endedAt = prevTurn.endedAt ?? now;
      }
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
      ...(options.isReplaying ? { replayed: true } : {}),
      revision: 0,
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
   *
   * When `session/prompt` ends normally (`done`) while one or more ACP tool calls are
   * still `in_progress`/`pending`/`ask` (e.g. a long-running background `run_command`
   * whose `tool_call_update(completed)` arrives after `end_turn`), keep those tools
   * running, register them as detached background tasks awaiting tool completion, and
   * keep the turn open for seamless continuation until `finalizeBackgroundTurn()`.
   */
  finishActiveTurn(
    stopReason?: StopReason,
    statusOverride?: 'done' | 'cancelled' | 'error',
    errorMessage?: string,
    options: {
      readonly autoCollapseThought?: boolean;
      readonly expandAllTools?: boolean;
      /**
       * When `true` (used by live `AppController`), keep still-running async-capable
       * tools (`run_command`, `invoke_subagent`, `schedule`, `run_workflow`) active
       * across `end_turn` so OSC `done` waits for their real `tool_call_update`.
       */
      readonly preserveInFlightBackgroundTools?: boolean;
    } = {},
  ): TranscriptTurn | undefined {
    const turn = this.activeTurn;
    if (!turn) return undefined;

    const now = this._now();
    if (stopReason !== undefined) {
      turn.stopReason = stopReason;
    }
    if (errorMessage !== undefined) {
      turn.errorMessage = errorMessage;
    }
    const resolvedStatus =
      statusOverride ?? (stopReason === 'cancelled' ? 'cancelled' : 'done');

    // Finalize all running/unclosed thought blocks
    this.finalizeRunningThoughts(turn, {
      autoCollapseThought: options.autoCollapseThought ?? false,
      expandAllTools: options.expandAllTools ?? false,
      now,
    });

    // If the turn ended normally while async-capable ACP tools (bash/subagent/schedule/workflow)
    // are still actively running in the background, preserve their live running state & register
    // them as tracked background tasks so OSC `done` and turn settlement wait for real completion.
    if (options.preserveInFlightBackgroundTools && resolvedStatus === 'done' && !turn.replayed) {
      const stillRunningTools = turn.toolCalls.filter(
        (tool) =>
          (tool.status === 'pending' || tool.status === 'running' || tool.status === 'ask') &&
          tool.endedAt === undefined &&
          this.isAsyncBackgroundCapableTool(tool),
      );
      if (stillRunningTools.length > 0) {
        for (const tool of stillRunningTools) {
          this.registerInFlightToolAsBackgroundTask(turn.index, tool);
        }
        return turn;
      }
    }

    turn.endedAt = now;
    turn.status = resolvedStatus;

    // Finalize any remaining non-terminal tools & subagents on cancelled/error/finished turns
    for (const tool of turn.toolCalls) {
      const hasDetachedRunning =
        turn.status === 'done' &&
        this._detachedBgTasks.get(tool.toolCallId)?.status === 'running';
      if (tool.backgroundRunning && !hasDetachedRunning) {
        tool.backgroundRunning = false;
      }
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
        if (!tool.replayed) {
          tool.tookMs = tool.tookMs ?? Math.max(0, tool.endedAt - tool.startedAt);
        }
        this.syncSubagentsForTool(turn, tool);
      }
    }

    if (turn.status === 'cancelled') {
      this.cancelActiveBackgroundTasks('cancelled');
    }

    this.bumpTurn(turn);
    this._activeTurnIndex = null;
    return turn;
  }

  /**
   * Finalize an active turn that stayed open waiting for background tool completion
   * and post-completion assistant summary chunks.
   */
  finalizeBackgroundTurn(
    options: {
      readonly autoCollapseThought?: boolean;
      readonly expandAllTools?: boolean;
      readonly terminalToolStatus?: 'done' | 'cancelled' | 'error';
      readonly terminalTurnStatus?: 'done' | 'cancelled' | 'error';
    } = {},
  ): TranscriptTurn | undefined {
    const turn = this.activeTurn;
    if (!turn) return undefined;

    const now = this._now();
    const terminalToolStatus = options.terminalToolStatus ?? 'done';
    const terminalTurnStatus = options.terminalTurnStatus ?? 'done';
    this.finalizeRunningThoughts(turn, {
      autoCollapseThought: options.autoCollapseThought ?? true,
      expandAllTools: options.expandAllTools ?? false,
      now,
    });
    for (const tool of turn.toolCalls) {
      const hasDetachedRunning =
        terminalTurnStatus === 'done' &&
        this._detachedBgTasks.get(tool.toolCallId)?.status === 'running';
      if (tool.backgroundRunning && !hasDetachedRunning) {
        tool.backgroundRunning = false;
      }
      if (tool.status === 'pending' || tool.status === 'running' || tool.status === 'ask') {
        tool.awaitingPermission = false;
        if (terminalToolStatus === 'cancelled') {
          tool.cancelled = true;
        }
        tool.status = terminalToolStatus;
        tool.endedAt = tool.endedAt ?? now;
        if (!tool.replayed) {
          tool.tookMs = tool.tookMs ?? Math.max(0, tool.endedAt - tool.startedAt);
        }
        this.syncSubagentsForTool(turn, tool);
      }
    }
    if (turn.status === 'streaming' || terminalTurnStatus !== 'done') {
      turn.status = terminalTurnStatus;
      turn.endedAt = turn.endedAt ?? now;
    }
    this.bumpTurn(turn);
    this._activeTurnIndex = null;
    return turn;
  }

  /**
   * Finalize all streaming turns (e.g. after `session/load` replay finishes).
   */
  finalizeReplayedTurns(): void {
    const now = this._now();
    this._detachedBgTasks.clear();
    this._settledTranscriptTaskIds.clear();
    let hasAnyReplayedTodoState = false;
    for (const turn of this._turns) {
      if (turn.replayedUserTodoPhases !== undefined) {
        hasAnyReplayedTodoState = true;
      }
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
        if (tool.backgroundRunning) {
          tool.backgroundRunning = false;
        }
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
          if (tool.tookMs === undefined) {
            const parsedDur = extractToolDurationFromOutput(tool.outputText);
            if (parsedDur !== undefined) {
              tool.tookMs = parsedDur;
            } else if (!tool.replayed) {
              tool.tookMs = Math.max(0, tool.endedAt - tool.startedAt);
            }
          }
          this.syncSubagentsForTool(turn, tool);
        }
        if (tool.replayed && (tool.isOmaTodo || isOmaTodoToolName(tool.rawName, tool.title))) {
          hasAnyReplayedTodoState = true;
          tool.isOmaTodo = true;
          tool.displayName = 'todo';
          tool.targetKind = 'text';
          tool.title = 'Todo';
          tool.intent = undefined;
        }
      }
      this.bumpTurn(turn);
    }
    this._hasLiveTodoMutation = false;
    this._restoredAnchorMaxCount = null;
    this._userTodoAnchorFloor = 0;
    this._planEvents = this._planEvents.filter((e) => e.phaseRank === 0);
    if (hasAnyReplayedTodoState) {
      this.recomputeReplayedTodos();
    } else {
      this.deriveEffectivePlan();
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
          const isAfterStandaloneCompact =
            current?.user !== undefined &&
            /^\/compact$/i.test(current.user.text.trim()) &&
            !/^\s/.test(chunkText);
          if (
            !current ||
            current.timeline.length > 0 ||
            current.status !== 'streaming' ||
            isAfterStandaloneCompact
          ) {
            if (current && current.status === 'streaming') {
              this.finishActiveTurn('end_turn', 'done');
            }
            this.beginUserTurn(chunkText, [], { isReplaying: true });
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
          const activeUser = this.activeTurn?.user;
          if (activeUser && activeUser.text.includes('</system-reminder>')) {
            const extracted = extractUserTodoSyncReminderFromText(activeUser.text);
            if (extracted.hasReminder) {
              activeUser.text = extracted.strippedText;
              if (extracted.phases !== undefined && this.activeTurn) {
                this.activeTurn.replayedUserTodoPhases = cloneTodoPhases(extracted.phases);
                this.activeTurn.replayedUserTodoSeq = ++this._eventSeq;
                this.recomputeReplayedTodos();
              }
            }
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
        const turn = this.ensureActiveTurn(isReplaying);
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
            ...(isReplaying ? { replayed: true } : {}),
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
        const turn = this.ensureActiveTurn(isReplaying);

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
            startedAt: this._now(),
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
        this._planEvents.push({
          phaseRank: isReplaying ? 0 : 2,
          seq: ++this._eventSeq,
          kind: 'direct_plan',
          op: entries.length === 0 ? 'clear' : 'set',
          entries: entries.map((e, idx) => ({
            id: `plan-${idx}`,
            text: e.content,
            ...(e.priority !== undefined ? { priority: e.priority } : {}),
            status: mapPlanStatusToChecklist(e.status),
          })),
          updatedAt: now,
        });
        this.deriveEffectivePlan();
        return { handled: true };
      }

      case 'plan_removed': {
        this._planEvents.push({
          phaseRank: isReplaying ? 0 : 2,
          seq: ++this._eventSeq,
          kind: 'direct_plan',
          op: 'remove',
          entries: [],
          updatedAt: this._now(),
        });
        this.deriveEffectivePlan();
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
        this.bumpTurn(turn);
        const st = (update.status ?? '').trim().toLowerCase();
        const isCompleted =
          st === 'done' ||
          st === 'completed' ||
          st === 'complete' ||
          st === 'finished' ||
          st === 'success' ||
          (st === '' && !/in progress|compacting|starting|pending/i.test(text));
        if (isCompleted) {
          this.markCompactedAtTurn(turn.index);
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
        this.bumpTurn(turn);
        this.markCompactedAtTurn(turn.index);
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
    tool.endedAt = undefined;
    tool.tookMs = undefined;
    tool.cancelled = false;
    tool.status = mapAcpToolStatusToTsp(tool.acpStatus, {
      awaitingPermission: true,
      cancelled: tool.cancelled,
      exitCode: tool.exitCode,
      timedOut: tool.timedOut,
      backgroundRunning: tool.backgroundRunning,
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
          exitCode: tool.exitCode,
          timedOut: tool.timedOut,
          backgroundRunning: tool.backgroundRunning,
        });
      }
    }

    const turn = this._turns[turnIndex];
    if (turn) {
      this.syncSubagentsForTool(turn, tool);
      this.bumpTurn(turn);
    }
    return tool;
  }

  toggleThought(thoughtId: string, open?: boolean): boolean {
    for (const turn of this._turns) {
      const thought = turn.thoughts.find((t) => t.id === thoughtId);
      if (thought) {
        thought.open = open !== undefined ? open : !thought.open;
        thought.userToggled = true;
        this.bumpTurn(turn);
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
    this.bumpTurn(this._turns[found.turnIndex]);
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
      this.bumpTurn(turn);
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
      this.bumpTurn(turn);
    }
  }

  /**
   * Resolve whether a thought block should be expanded under global `showThinking` toggle.
   * Aligned with `omp`: `expandAllTools` (`Ctrl+O`) is decoupled from thinking blocks.
   */
  isThoughtOpen(
    thought: ThoughtBlock,
    options: { readonly showThinking: boolean; readonly expandAllTools?: boolean },
  ): boolean {
    if (!options.showThinking && thought.status !== 'running') return false;
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
        this.bumpTurn(turn);
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
        this.bumpTurn(turn);
        return true;
      }
    }
    return false;
  }

  /**
   * Record that `surface.settle(...)` was issued for a completed turn or one of its flat top-level nodes.
   */
  markSettled(nodeIdOrTurnIndex: string | number): boolean {
    const nodeId =
      typeof nodeIdOrTurnIndex === 'number'
        ? `main.turn-${nodeIdOrTurnIndex}`
        : nodeIdOrTurnIndex;
    if (this._evictedIds.has(nodeId)) return false;
    this._settledIds.add(nodeId);
    const flatMatch = /^main\.t(\d+)-/.exec(nodeId);
    const turn = flatMatch
      ? this._turns[Number(flatMatch[1])]
      : this._turns.find((t) => t.nodeId === nodeId);
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
   * Returns `true` when the active turn currently has an in-flight tool call
   * (`pending` / `running` / `ask` with `endedAt === undefined`).
   */
  hasInFlightToolCall(): boolean {
    const turn = this.activeTurn;
    if (!turn) return false;
    for (const tool of turn.toolCalls) {
      if (
        (tool.status === 'pending' || tool.status === 'running' || tool.status === 'ask') &&
        tool.endedAt === undefined
      ) {
        return true;
      }
    }
    return false;
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
    endedAt?: number,
  ): boolean {
    const target = idOrTaskId.trim();
    if (!target) return false;
    this._settledTranscriptTaskIds.add(target);
    const endTs = endedAt ?? this._now();
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
        task.endedAt = endTs;
        if (task.taskId) {
          this._settledTranscriptTaskIds.add(task.taskId);
        }
        this.syncToolBackgroundState(task.toolCallId, false, task.taskId, status);
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
        if (task.taskId) {
          this._settledTranscriptTaskIds.add(task.taskId);
        }
        this.syncToolBackgroundState(task.toolCallId, false, task.taskId, status);
        count += 1;
      }
    }
    return count;
  }

  private findMatchingUnlabeledRunningTask(
    rec: TranscriptBackgroundTaskRecord,
    requireTimeAndTypeForTerminal = false,
  ): DetachedBackgroundTask | undefined {
    const unlabeledRunning = [...this._detachedBgTasks.values()].filter(
      (t) =>
        t.status === 'running' &&
        !t.taskId &&
        t.agentKind !== 'subagent' &&
        !t.id.startsWith('transcript:'),
    );
    if (unlabeledRunning.length === 0) return undefined;

    const preferred = rec.scheduleKind
      ? unlabeledRunning.filter((t) => t.type === 'schedule')
      : unlabeledRunning;
    const pool =
      preferred.length > 0
        ? preferred
        : requireTimeAndTypeForTerminal && rec.scheduleKind
          ? []
          : unlabeledRunning;
    if (pool.length === 0) return undefined;

    if (rec.description) {
      const normDesc = rec.description.replace(/\s+/g, ' ').trim().toLowerCase();
      const descMatch = pool.find((t) => {
        const fields = [t.command, t.title, t.label]
          .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          .map((v) => v.replace(/\s+/g, ' ').trim().toLowerCase());
        return fields.some((f) => f === normDesc || f.includes(normDesc) || normDesc.includes(f));
      });
      if (descMatch) return descMatch;
    }

    if (pool.length === 1) {
      const sole = pool[0]!;
      if (
        !requireTimeAndTypeForTerminal ||
        rec.startedAt === undefined ||
        Math.abs(sole.startedAt - rec.startedAt) <= 60_000
      ) {
        return sole;
      }
    }
    return undefined;
  }

  /**
   * Reconcile `transcript.jsonl` background task transitions (such as `agy 1.5.14 acp`
   * silently moving a >10s `run_command` to `status: "RUNNING"` without emitting an ACP
   * `tool_call_update`) against active tool calls and detached task records.
   */
  syncTranscriptBackgroundTasks(records: readonly TranscriptBackgroundTaskRecord[]): boolean {
    if (records.length === 0) return false;
    let changed = false;

    for (const rec of records) {
      if (rec.status !== 'running') {
        this._settledTranscriptTaskIds.add(rec.taskId);
        if (this.completeBackgroundTask(rec.taskId, rec.status, rec.endedAt)) {
          changed = true;
          continue;
        }
        const matchedUnlabeled = this.findMatchingUnlabeledRunningTask(rec, true);
        if (matchedUnlabeled) {
          this._detachedBgTasks.set(matchedUnlabeled.id, {
            ...matchedUnlabeled,
            taskId: rec.taskId,
            ...(rec.scheduleKind ? { scheduleKind: rec.scheduleKind } : {}),
            status: rec.status,
            endedAt: rec.endedAt ?? this._now(),
          });
          this.syncToolBackgroundState(
            matchedUnlabeled.toolCallId,
            false,
            rec.taskId,
            rec.status,
          );
          changed = true;
        }
      }
    }

    for (const rec of records) {
      if (rec.status !== 'running') continue;
      if (this._settledTranscriptTaskIds.has(rec.taskId)) continue;

      let alreadyTracked = false;
      for (const task of this._detachedBgTasks.values()) {
        if (task.taskId === rec.taskId) {
          alreadyTracked = true;
          break;
        }
      }
      if (alreadyTracked) continue;

      const matched = this.findMatchingInFlightToolForTranscriptTask(rec);
      if (matched) {
        const existing = this._detachedBgTasks.get(matched.tool.toolCallId);
        if (existing && existing.status !== 'running') {
          continue;
        }
        const jobType = rec.scheduleKind
          ? 'schedule'
          : (classifyNonAgentJobType(matched.tool) ?? 'bash');
        const inputRec = asRecord(matched.tool.args) ?? asRecord(matched.tool.rawInput);
        const command =
          rec.description ||
          matched.tool.target ||
          firstStringField(inputRec, ['CommandLine', 'command', 'cmd', 'script']) ||
          (matched.tool.title.toLowerCase() !== 'bash' ? matched.tool.title : undefined);
        const label = collapseSingleLine(command ?? matched.tool.title ?? rec.taskId, 88);
        this._detachedBgTasks.set(matched.tool.toolCallId, {
          id: matched.tool.toolCallId,
          toolCallId: matched.tool.toolCallId,
          taskId: rec.taskId,
          type: jobType,
          ...(rec.scheduleKind ? { scheduleKind: rec.scheduleKind } : {}),
          label,
          ...(command ? { command } : {}),
          ...(matched.tool.title && matched.tool.title !== command ? { title: matched.tool.title } : {}),
          startedAt: existing?.startedAt ?? rec.startedAt ?? matched.tool.startedAt,
          turnIndex: matched.turnIndex,
          status: 'running',
          outputText: matched.tool.outputText || (rec.logPath ? `Log: ${rec.logPath}` : ''),
          awaitingToolCompletion: true,
        });
        this.syncToolBackgroundState(matched.tool.toolCallId, true, rec.taskId);
        changed = true;
      } else {
        // 1. Bind rec.taskId to an unlabeled running non-subagent detached task if present
        const targetTask = this.findMatchingUnlabeledRunningTask(rec, false);
        if (targetTask) {
          this._detachedBgTasks.set(targetTask.id, {
            ...targetTask,
            taskId: rec.taskId,
            ...(rec.scheduleKind ? { scheduleKind: rec.scheduleKind } : {}),
          });
          this.syncToolBackgroundState(targetTask.toolCallId, true, rec.taskId);
          changed = true;
          continue;
        }

        // 2. Skip spawning a synthetic entry if the active/latest turn already completed a matching tool call
        const candidateTurns: TranscriptTurn[] = [];
        if (this.activeTurn) candidateTurns.push(this.activeTurn);
        const latestTurn = this._turns[this._turns.length - 1];
        if (latestTurn && latestTurn !== this.activeTurn) candidateTurns.push(latestTurn);
        const alreadyCompletedInTurn = candidateTurns.some((turn) =>
          turn.toolCalls.some((tool) => {
            if (tool.status !== 'done' && tool.status !== 'error' && tool.status !== 'cancelled') {
              return false;
            }
            if (tool.endedAt === undefined || tool.backgroundRunning || tool.backgroundTaskId) {
              return false;
            }
            if (this._detachedBgTasks.has(tool.toolCallId)) return false;
            if (!this.matchesToolCommandDescription(tool, rec.description)) return false;
            if (rec.startedAt !== undefined) {
              return (
                tool.endedAt >= rec.startedAt - 2_000 &&
                Math.abs(tool.startedAt - rec.startedAt) <= 60_000
              );
            }
            return tool.exitCode !== undefined;
          }),
        );
        if (alreadyCompletedInTurn) {
          this._settledTranscriptTaskIds.add(rec.taskId);
          continue;
        }

        const syntheticId = `transcript:${rec.taskId}`;
        if (this._detachedBgTasks.has(syntheticId)) continue;
        const label = collapseSingleLine(rec.description || rec.taskId, 88);
        this._detachedBgTasks.set(syntheticId, {
          id: syntheticId,
          toolCallId: syntheticId,
          taskId: rec.taskId,
          type: rec.scheduleKind ? 'schedule' : 'bash',
          ...(rec.scheduleKind ? { scheduleKind: rec.scheduleKind } : {}),
          label,
          ...(rec.description ? { command: rec.description } : {}),
          startedAt: rec.startedAt ?? this._now(),
          turnIndex: Math.max(0, this._turns.length - 1),
          status: 'running',
          outputText: rec.logPath ? `Log: ${rec.logPath}` : '',
        });
        changed = true;
      }
    }

    return changed;
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

        let jobType = classifyNonAgentJobType(tool);
        const isActive =
          (tool.status === 'pending' || tool.status === 'running' || tool.status === 'ask') &&
          tool.endedAt === undefined &&
          turnStreaming;
        if (
          !jobType &&
          isActive &&
          !isSwarmOrSubagentTool(tool) &&
          Math.max(0, this._now() - tool.startedAt) >= LONG_RUNNING_TOOL_THRESHOLD_MS
        ) {
          jobType = 'task';
        }
        if (!jobType) continue;
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
    this._todoPhases = [];
    this._replayedTodoPhases = [];
    this._todoToolCallCount = 0;
    this._countedTodoToolIds.clear();
    this._todoRevision = 0;
    this._eventSeq = 0;
    this._restoredAnchorMaxCount = null;
    this._userTodoAnchorFloor = 0;
    this._hasUserTodoOverride = false;
    this._hasLiveTodoMutation = false;
    this._replayedTodoEvents = [];
    this._planEvents = [];
    this._pendingTodoSnapshots.length = 0;
    this._activeTurnIndex = null;
    this._toolIndex.clear();
    this._detachedBgTasks.clear();
    this._settledTranscriptTaskIds.clear();
    this._settledIds.clear();
    this._evictedIds.clear();
    this._compactedBeforeTurnIndex = null;
    this._showCompactedHistory = false;
    this._lastAppliedCheckpointStepIndex = null;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private bumpTurn(turn: TranscriptTurn | undefined): void {
    if (turn) {
      turn.revision += 1;
    }
  }

  private ensureActiveTurn(isReplaying = false): TranscriptTurn {
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
      ...(isReplaying ? { replayed: true } : {}),
      revision: 0,
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
        if (!thought.replayed) {
          thought.tookMs = thought.tookMs ?? Math.max(0, end - thought.startedAt);
        }
        if (autoCollapseThought && !thought.userToggled) {
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
      this.bumpTurn(existingTurn);

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
      const nextIntent = extractToolIntent(
        { args: tool.args, rawInput: tool.rawInput },
        tool.title,
        tool.target,
      );
      if (nextIntent !== undefined) {
        tool.intent = nextIntent;
      }

      let deltaRawOutText = '';
      if (fields.rawOutput !== undefined) {
        tool.rawOutput = fields.rawOutput;
        const exitCode = extractToolExitCode(fields.rawOutput);
        if (exitCode !== undefined) {
          tool.exitCode = exitCode;
        }
        if (isToolRawOutputTimedOut(fields.rawOutput)) {
          tool.timedOut = true;
        }
        const rawOutText = extractToolOutputText(fields.rawOutput);
        if (rawOutText !== undefined && rawOutText.length > 0) {
          deltaRawOutText = rawOutText.trim();
          tool.outputText = rawOutText;
        }
      }

      let deltaContentText = '';
      if (fields.content !== undefined) {
        const diffs = extractDiffItems(fields.content);
        if (diffs.length > 0) {
          tool.diffs = diffs;
        }
        const contentText = extractToolContentText(fields.content);
        if (contentText.length > 0) {
          deltaContentText = contentText.trim();
          tool.outputText =
            tool.outputText.length > 0 && !tool.outputText.includes(contentText)
              ? `${tool.outputText}\n${contentText}`
              : contentText;
        }
      }
      const deltaOutputText = mergeDistinctDiagnosticText(deltaContentText, deltaRawOutText);

      if (tool.displayName === 'bash' && tool.outputText.length > 0) {
        const leadingStatus = extractLeadingBashExitStatus(tool.outputText);
        if (tool.exitCode === undefined && leadingStatus.exitCode !== undefined) {
          tool.exitCode = leadingStatus.exitCode;
        }
        if (leadingStatus.timedOut) {
          tool.timedOut = true;
        }
      }

      const prevAcpStatus = tool.acpStatus;
      if (fields.status !== undefined) {
        tool.acpStatus = fields.status;
        if (fields.status === 'completed' || fields.status === 'failed') {
          tool.awaitingPermission = false;
          tool.endedAt = now;
          if (tool.replayed) {
            const parsedDur = extractToolDurationFromOutput(tool.outputText);
            if (parsedDur !== undefined) {
              tool.tookMs = parsedDur;
            }
          } else {
            tool.tookMs = Math.max(0, now - tool.startedAt);
          }
        }
      }
      if (tool.acpStatus === 'failed') {
        if (prevAcpStatus !== 'failed') {
          tool.failureOutputText = deltaOutputText;
        } else if (deltaOutputText.length > 0) {
          tool.failureOutputText = mergeDistinctDiagnosticText(
            tool.failureOutputText ?? '',
            deltaOutputText,
          );
        }
      } else if (prevAcpStatus === 'failed') {
        tool.failureOutputText = undefined;
      }

      tool.status = mapAcpToolStatusToTsp(tool.acpStatus, {
        awaitingPermission: tool.awaitingPermission,
        cancelled: tool.cancelled,
        exitCode: tool.exitCode,
        timedOut: tool.timedOut,
        backgroundRunning: tool.backgroundRunning,
      });

      if (existingTurn) {
        this.syncSubagentsForTool(existingTurn, tool);
        if (!isReplaying) {
          this.syncBackgroundTaskForTool(existingTurn.index, tool);
        }
        this.syncTodoToolState(existingTurn, tool, isReplaying, { deltaOutputText });
        this.syncUpdateStepsToolState(tool);
      }
      return tool;
    }

    // Create a brand new ToolCallItem
    const turn = this.ensureActiveTurn(isReplaying);
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
    let exitCode = extractToolExitCode(fields.rawOutput);
    let timedOut = isToolRawOutputTimedOut(fields.rawOutput);
    const contentText = extractToolContentText(fields.content);
    const rawOutText = extractToolOutputText(fields.rawOutput) ?? '';
    const outputText = contentText || rawOutText;
    const initialFailureText =
      acpStatus === 'failed' ? mergeDistinctDiagnosticText(contentText, rawOutText) : '';
    if (meta.displayName === 'bash' && outputText.length > 0) {
      const leadingStatus = extractLeadingBashExitStatus(outputText);
      if (exitCode === undefined && leadingStatus.exitCode !== undefined) {
        exitCode = leadingStatus.exitCode;
      }
      if (leadingStatus.timedOut) {
        timedOut = true;
      }
    }
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
    const intent = extractToolIntent(
      { args: fields.args, rawInput: fields.rawInput },
      title,
      target,
    );

    const finished = acpStatus === 'completed' || acpStatus === 'failed';
    const parsedReplayDur = finished ? extractToolDurationFromOutput(outputText) : undefined;
    const tool: ToolCallItem = {
      toolCallId: fields.toolCallId,
      acpStatus,
      status: mapAcpToolStatusToTsp(acpStatus, { exitCode, timedOut }),
      ...(fields.kind !== undefined ? { kind: fields.kind } : {}),
      ...(fields.name !== undefined ? { rawName: fields.name } : {}),
      displayName: meta.displayName,
      targetKind: meta.targetKind,
      title,
      ...(target !== undefined ? { target } : {}),
      ...(intent !== undefined ? { intent } : {}),
      ...(fields.args !== undefined ? { args: fields.args } : {}),
      ...(fields.rawInput !== undefined ? { rawInput: fields.rawInput } : {}),
      ...(fields.rawOutput !== undefined ? { rawOutput: fields.rawOutput } : {}),
      ...(exitCode !== undefined ? { exitCode } : {}),
      ...(timedOut ? { timedOut: true } : {}),
      outputText,
      ...(initialFailureText.length > 0 ? { failureOutputText: initialFailureText } : {}),
      diffs,
      locations,
      startedAt: now,
      ...(finished
        ? {
            endedAt: now,
            ...(parsedReplayDur !== undefined
              ? { tookMs: parsedReplayDur }
              : !isReplaying
                ? { tookMs: 0 }
                : {}),
          }
        : {}),
      ...(isReplaying ? { replayed: true } : {}),
      eventSeq: ++this._eventSeq,
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
    this.syncTodoToolState(turn, tool, isReplaying, {
      deltaOutputText: initialFailureText || outputText.trim(),
    });
    this.syncUpdateStepsToolState(tool);

    return tool;
  }

  private recordTodoToolCall(toolCallId: string): void {
    if (!this._countedTodoToolIds.has(toolCallId)) {
      this._countedTodoToolIds.add(toolCallId);
      this._todoToolCallCount += 1;
    }
  }

  private unrecordTodoToolCall(toolCallId: string): void {
    if (this._countedTodoToolIds.delete(toolCallId)) {
      this._todoToolCallCount = Math.max(0, this._todoToolCallCount - 1);
    }
  }

  private assignTodoSnapshotToTool(
    turn: TranscriptTurn,
    tool: ToolCallItem,
    snapshot: {
      readonly phases: readonly TodoPhase[];
      readonly op: TodoOp;
      readonly isError: boolean;
      readonly text: string;
    },
  ): void {
    if (!snapshot.isError && MUTATING_TODO_OPS.has(snapshot.op) && tool.acpStatus !== 'failed') {
      this.recordTodoToolCall(tool.toolCallId);
    } else {
      this.unrecordTodoToolCall(tool.toolCallId);
    }
    tool.isOmaTodo = true;
    tool.displayName = 'todo';
    tool.targetKind = 'text';
    tool.title = 'Todo';
    tool.intent = undefined;
    tool.todoSnapshot = {
      phases: cloneTodoPhases(snapshot.phases),
      op: snapshot.op,
      isError: snapshot.isError,
      text: snapshot.text,
    };
    const total = snapshot.phases.reduce((sum, p) => sum + p.tasks.length, 0);
    const done = snapshot.phases.reduce(
      (sum, p) => sum + p.tasks.filter(isTodoTaskFinished).length,
      0,
    );
    tool.target = !snapshot.isError && total > 0 ? `${done}/${total}` : undefined;
    this.bumpTurn(turn);
  }

  private buildTodoPlanState(phases: readonly TodoPhase[], updatedAt: number): PlanState {
    const checklistPhases = mapTodoPhasesToChecklist(phases);
    const entries: PlanItemState[] = checklistPhases.flatMap((phase) =>
      phase.items.map((item) => ({
        id: item.id,
        text: item.text,
        ...(item.note !== undefined ? { note: item.note } : {}),
        status: item.status,
      })),
    );
    return {
      entries,
      phases: checklistPhases,
      source: 'todo_tool',
      updatedAt,
    };
  }

  private arePlansStructurallyEqual(a: PlanState | null, b: PlanState | null): boolean {
    if (a === b) return true;
    if (!a || !b || a.source !== b.source) return false;
    return (
      JSON.stringify(a.entries) === JSON.stringify(b.entries) &&
      JSON.stringify(a.phases ?? null) === JSON.stringify(b.phases ?? null)
    );
  }

  private deriveEffectivePlan(): void {
    const events: PlanTimelineEvent[] = [...this._replayedTodoEvents, ...this._planEvents];
    for (const turn of this._turns) {
      for (const tool of turn.toolCalls) {
        if (
          tool.isUpdateSteps &&
          tool.acpStatus === 'completed' &&
          tool.updateStepsEntries !== undefined
        ) {
          events.push({
            phaseRank: tool.replayed ? 0 : 2,
            seq: tool.eventSeq,
            kind: 'update_steps',
            entries: tool.updateStepsEntries,
            turn,
            updatedAt: tool.endedAt ?? tool.startedAt,
          });
        }
      }
    }
    events.sort((a, b) => (a.phaseRank !== b.phaseRank ? a.phaseRank - b.phaseRank : a.seq - b.seq));

    let nextPlan: PlanState | null = null;
    let runningTodoPhases: readonly TodoPhase[] = [];

    for (const ev of events) {
      if (ev.kind === 'todo_mutation') {
        runningTodoPhases = ev.phases;
        if (ev.phases.length > 0) {
          nextPlan = this.buildTodoPlanState(ev.phases, ev.updatedAt);
        } else if (ev.source === 'todo_tool' || nextPlan?.source === 'todo_tool') {
          nextPlan = null;
        }
      } else if (ev.kind === 'direct_plan') {
        if (ev.op === 'remove') {
          nextPlan = null;
        } else if (ev.op === 'clear') {
          if (nextPlan?.source === 'acp') {
            nextPlan = null;
          }
        } else {
          nextPlan = {
            entries: ev.entries.map((e) => ({ ...e })),
            source: 'acp',
            updatedAt: ev.updatedAt,
          };
        }
      } else if (ev.entries.length === 0) {
        if (nextPlan?.source === 'acp') {
          nextPlan = null;
        }
      } else {
        const turnHasActiveOmaTodo = ev.turn.toolCalls.some((t) => {
          if (!t.isOmaTodo || t.acpStatus === 'failed' || t.todoSnapshot?.isError) return false;
          const op = t.todoSnapshot?.op ?? extractRawTodoOp(getEffectiveTodoToolRawInput(t));
          return op !== 'view';
        });
        const canTakeOverPlan =
          nextPlan?.source !== 'todo_tool' ||
          (!turnHasActiveOmaTodo &&
            (this._preferNativeSteps || areAllTodosFinished(runningTodoPhases)));
        if (canTakeOverPlan) {
          nextPlan = {
            entries: ev.entries.map((e) => ({ ...e })),
            source: 'acp',
            updatedAt: ev.updatedAt,
          };
        }
      }
    }

    if (!this.arePlansStructurallyEqual(this._plan, nextPlan)) {
      this._plan = nextPlan;
    }
  }

  private recomputeReplayedTodos(): void {
    let phases: TodoPhase[] = [];
    const replayedEvents: PlanTimelineEvent[] = [];
    for (const id of [...this._countedTodoToolIds]) {
      const entry = this._toolIndex.get(id);
      if (!entry || entry.tool.replayed) {
        this.unrecordTodoToolCall(id);
      }
    }

    for (const turn of this._turns) {
      if (turn.replayedUserTodoPhases !== undefined) {
        phases = cloneTodoPhases(turn.replayedUserTodoPhases);
        const cleaned = cloneTodoPhases(phases).filter((p) => p.tasks.length > 0);
        replayedEvents.push({
          phaseRank: 0,
          seq: turn.replayedUserTodoSeq ?? 0,
          kind: 'todo_mutation',
          source: 'user',
          phases: cleaned,
          updatedAt: turn.createdAt,
        });
      }
      for (const tool of turn.toolCalls) {
        if (!tool.replayed) continue;
        if (!tool.isOmaTodo && !isOmaTodoToolName(tool.rawName, tool.title)) continue;
        tool.isOmaTodo = true;
        tool.displayName = 'todo';
        tool.targetKind = 'text';
        tool.title = 'Todo';
        tool.intent = undefined;
        if (!tool.userToggled) {
          tool.collapsed = false;
        }

        const rawArgs = getEffectiveTodoToolRawInput(tool);
        if (tool.acpStatus === 'failed') {
          this.assignTodoSnapshotToTool(turn, tool, {
            phases: [],
            op: normalizeTodoOpName(rawArgs),
            isError: true,
            text: tool.failureOutputText?.trim() || FALLBACK_FAILED_TODO_TEXT,
          });
        } else if (tool.acpStatus === 'completed') {
          if (rawArgs === undefined) {
            tool.todoSnapshot = undefined;
            tool.target = undefined;
            this.bumpTurn(turn);
          } else {
            const outcome = applyTodoOperation(phases, rawArgs);
            if (!outcome.isError && MUTATING_TODO_OPS.has(outcome.op)) {
              phases = cloneTodoPhases(outcome.phases);
              const cleaned = cloneTodoPhases(phases).filter((p) => p.tasks.length > 0);
              replayedEvents.push({
                phaseRank: 0,
                seq: tool.eventSeq,
                kind: 'todo_mutation',
                source: 'todo_tool',
                phases: cleaned,
                updatedAt: tool.endedAt ?? tool.startedAt,
              });
            }
            this.assignTodoSnapshotToTool(turn, tool, {
              phases: outcome.phases,
              op: outcome.op,
              isError: outcome.isError,
              text: outcome.text,
            });
          }
        } else {
          tool.todoSnapshot = undefined;
          tool.target = undefined;
        }
      }
    }

    this._replayedTodoEvents = replayedEvents;
    this._replayedTodoPhases = cloneTodoPhases(phases);

    if (this._hasLiveTodoMutation) {
      this.deriveEffectivePlan();
      return;
    }

    if (this._restoredAnchorMaxCount !== null) {
      if (this._todoToolCallCount <= this._restoredAnchorMaxCount) {
        this._userTodoAnchorFloor = Math.max(
          this._userTodoAnchorFloor,
          this._restoredAnchorMaxCount,
          this._todoToolCallCount,
        );
        this.deriveEffectivePlan();
        return;
      }
      this._restoredAnchorMaxCount = null;
      this._planEvents = this._planEvents.filter(
        (e) => !(e.kind === 'todo_mutation' && e.isRestoredAnchor),
      );
    }

    const nextCleaned = cloneTodoPhases(phases).filter((phase) => phase.tasks.length > 0);
    if (
      JSON.stringify(nextCleaned) !== JSON.stringify(this._todoPhases) ||
      this._hasUserTodoOverride
    ) {
      this._todoPhases = nextCleaned;
      this._todoRevision += 1;
    }
    this._hasUserTodoOverride = false;
    this._userTodoAnchorFloor = 0;
    this.deriveEffectivePlan();
  }

  private syncTodoToolState(
    turn: TranscriptTurn,
    tool: ToolCallItem,
    isReplaying: boolean,
    options: { readonly deltaOutputText?: string } = {},
  ): void {
    if (!tool.isOmaTodo && !isOmaTodoToolName(tool.rawName, tool.title)) return;
    tool.isOmaTodo = true;
    tool.displayName = 'todo';
    tool.targetKind = 'text';
    tool.title = 'Todo';
    tool.intent = undefined;
    if (!tool.userToggled) {
      tool.collapsed = false;
    }

    if (isReplaying || tool.replayed) {
      this.recomputeReplayedTodos();
      return;
    }

    if (tool.todoSnapshot) {
      if (tool.acpStatus === 'failed') {
        this.unrecordTodoToolCall(tool.toolCallId);
        const failedErrText =
          tool.failureOutputText?.trim() || options.deltaOutputText?.trim() || '';
        if (!tool.todoSnapshot.isError) {
          tool.todoSnapshot = {
            phases: [],
            op: tool.todoSnapshot.op,
            isError: true,
            text: failedErrText || FALLBACK_FAILED_TODO_TEXT,
          };
          this.bumpTurn(turn);
        } else {
          const nextOp =
            tool.todoSnapshot.op === 'view'
              ? normalizeTodoOpName(getEffectiveTodoToolRawInput(tool))
              : tool.todoSnapshot.op;
          const shouldUpgradeText =
            failedErrText.length > 0 && failedErrText !== tool.todoSnapshot.text;
          if (shouldUpgradeText || nextOp !== tool.todoSnapshot.op) {
            tool.todoSnapshot = {
              phases: [],
              op: nextOp,
              isError: true,
              text: shouldUpgradeText ? failedErrText : tool.todoSnapshot.text,
            };
            this.bumpTurn(turn);
          }
        }
        tool.target = undefined;
        return;
      }
      const total = tool.todoSnapshot.phases.reduce((sum, p) => sum + p.tasks.length, 0);
      const done = tool.todoSnapshot.phases.reduce(
        (sum, p) => sum + p.tasks.filter(isTodoTaskFinished).length,
        0,
      );
      tool.target = !tool.todoSnapshot.isError && total > 0 ? `${done}/${total}` : undefined;
      return;
    }

    if (!tool.replayed && this._pendingTodoSnapshots.length > 0) {
      let matchIdx = -1;
      let bestScore = 0;
      for (let i = 0; i < this._pendingTodoSnapshots.length; i++) {
        const snap = this._pendingTodoSnapshots[i]!;
        const score = scoreTodoSnapshotMatch(snap, tool);
        if (score > bestScore) {
          bestScore = score;
          matchIdx = i;
          if (score === 2) {
            break;
          }
        }
      }
      if (matchIdx >= 0) {
        const pending = this._pendingTodoSnapshots.splice(matchIdx, 1)[0];
        if (pending) {
          this.assignTodoSnapshotToTool(turn, tool, pending);
          return;
        }
      }
    }

    if (tool.acpStatus === 'failed') {
      this.unrecordTodoToolCall(tool.toolCallId);
      tool.target = undefined;
    }
  }

  private syncUpdateStepsToolState(tool: ToolCallItem): void {
    if (!tool.isUpdateSteps && !isUpdateStepsToolName(tool.rawName, tool.title)) {
      return;
    }
    tool.isUpdateSteps = true;
    tool.displayName = 'todo';
    tool.targetKind = 'text';
    tool.title = 'Todo';
    tool.intent = undefined;
    if (tool.acpStatus === 'failed') {
      tool.target = undefined;
      tool.updateStepsEntries = undefined;
      this.deriveEffectivePlan();
      return;
    }
    const parseRawSteps = (source: unknown): unknown[] | undefined => {
      let rec = asRecord(source);
      if (!rec && typeof source === 'string') {
        try {
          rec = asRecord(JSON.parse(source));
        } catch {
          return undefined;
        }
      }
      let candidate: unknown = rec?.steps;
      if (typeof candidate === 'string') {
        try {
          candidate = JSON.parse(candidate);
        } catch {
          return undefined;
        }
      }
      return Array.isArray(candidate) ? candidate : undefined;
    };
    const rawSteps = parseRawSteps(tool.rawInput) ?? parseRawSteps(tool.args);
    if (!rawSteps) {
      return;
    }
    if (rawSteps.length === 0) {
      tool.updateStepsEntries = [];
      tool.target = undefined;
      if (tool.acpStatus === 'completed') {
        this.deriveEffectivePlan();
      }
      return;
    }
    const entries: PlanItemState[] = [];
    for (let idx = 0; idx < rawSteps.length; idx++) {
      const step = asRecord(rawSteps[idx]);
      if (!step) continue;
      const title = typeof step.title === 'string' ? step.title.trim() : '';
      const status = typeof step.status === 'string' ? step.status.trim() : '';
      if (!title || !status) continue;
      entries.push({
        id: `plan-${idx}`,
        text: title,
        status: mapPlanStatusToChecklist(status),
      });
    }
    if (entries.length > 0) {
      tool.updateStepsEntries = entries;
      const doneCount = entries.filter((e) => e.status === 'done').length;
      const skippedCount = entries.filter((e) => e.status === 'dropped').length;
      const failedCount = entries.filter((e) => e.status === 'blocked').length;
      const extraParts = [
        skippedCount > 0 ? `${skippedCount} skipped` : '',
        failedCount > 0 ? `${failedCount} failed` : '',
      ].filter(Boolean);
      tool.target =
        extraParts.length > 0
          ? `${doneCount}/${entries.length} (${extraParts.join(', ')})`
          : `${doneCount}/${entries.length}`;
      if (tool.acpStatus === 'completed') {
        this.deriveEffectivePlan();
      }
    }
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

    const NO_RUNNING_BG_TASKS_RE =
      /\b(?:no\s+(?:running|active)\s+tasks?|no\s+background\s+tasks?(?:\s+are)?\s+(?:currently\s+)?running|no\s+tasks?\s+(?:are\s+)?(?:currently\s+)?running|0\s+running|none\s+running)\b/i;

    // 1. Handle `manage_task` / `command_status` settling existing detached background tasks
    if (
      (isManageTaskByNameOrTitle || isManageTaskByInputShape) &&
      (tool.status === 'done' || tool.status === 'error')
    ) {
      const outText = tool.outputText || '';
      const effectiveTaskId =
        targetTaskId ??
        /\bTask(?:\s+id)?\s+["'`]?([A-Za-z0-9._:/-]+)["'`]?\s+(?:(?:was|has|is)\s+)?(?:cancelled|canceled|killed|stopped|terminated|aborted|completed|finished|failed)\b/i.exec(
          outText,
        )?.[1] ??
        /\bTask:\s*([A-Za-z0-9._:/-]+)\b/i.exec(outText)?.[1];

      const settleAllRunningNonSubagent = (status: 'completed' | 'cancelled') => {
        const now = this._now();
        for (const task of this._detachedBgTasks.values()) {
          if (task.status === 'running' && task.agentKind !== 'subagent') {
            task.status = status;
            task.endedAt = now;
            if (task.taskId) {
              this._settledTranscriptTaskIds.add(task.taskId);
            }
            this.syncToolBackgroundState(task.toolCallId, false, task.taskId, status);
          }
        }
      };

      if (action === 'kill' || action === 'cancel' || action === 'stop') {
        if (effectiveTaskId) {
          this.completeBackgroundTask(effectiveTaskId, 'cancelled');
        } else {
          // If no explicit TaskId, cancel sole running non-subagent detached task
          const runningNonSub = [...this._detachedBgTasks.values()].filter(
            (t) => t.status === 'running' && t.agentKind !== 'subagent',
          );
          if (runningNonSub.length === 1) {
            const sole = runningNonSub[0]!;
            sole.status = 'cancelled';
            sole.endedAt = this._now();
            if (sole.taskId) {
              this._settledTranscriptTaskIds.add(sole.taskId);
            }
            this.syncToolBackgroundState(sole.toolCallId, false, sole.taskId, 'cancelled');
          }
        }
        return;
      }

      if (action === 'status' || isCommandStatus) {
        const terminal = inferTerminalBgStatusFromText(outText);
        if (terminal && effectiveTaskId) {
          this.completeBackgroundTask(effectiveTaskId, terminal);
        }
        return;
      }

      if (action === 'list') {
        if (NO_RUNNING_BG_TASKS_RE.test(outText)) {
          settleAllRunningNonSubagent('completed');
        }
        return;
      }

      if (action === '') {
        if (NO_RUNNING_BG_TASKS_RE.test(outText)) {
          settleAllRunningNonSubagent('completed');
        } else if (effectiveTaskId) {
          const terminal = inferTerminalBgStatusFromText(outText);
          if (terminal) {
            this.completeBackgroundTask(effectiveTaskId, terminal);
          }
        }
      }
      return;
    }

    // 2. If a previously tracked detached tool later gets updated to a terminal status,
    // first check whether a completed tool handed off a genuinely detached background task
    // (e.g., run_command/run_workflow/invoke_subagent returning a task/conversation ID) before
    // marking an in-flight placeholder as completed.
    const existingDetached = this._detachedBgTasks.get(tool.toolCallId);
    if (existingDetached) {
      // Never resurrect an already-terminal detached background task on late incremental updates.
      if (existingDetached.status !== 'running') {
        if (tool.outputText) {
          existingDetached.outputText = tool.outputText;
        }
        this.syncToolBackgroundState(tool.toolCallId, false, existingDetached.taskId);
        return;
      }
      if (tool.status === 'error' || tool.status === 'cancelled') {
        existingDetached.status = tool.status === 'error' ? 'failed' : 'cancelled';
        existingDetached.endedAt = this._now();
        existingDetached.outputText = tool.outputText;
        if (existingDetached.taskId) {
          this._settledTranscriptTaskIds.add(existingDetached.taskId);
        }
        this.syncToolBackgroundState(tool.toolCallId, false, existingDetached.taskId);
      } else if (tool.status === 'done' && existingDetached.awaitingToolCompletion) {
        const handoff = detectDetachedBackgroundTask(tool, turnIndex);
        if (handoff && !(handoff.taskId && this._settledTranscriptTaskIds.has(handoff.taskId))) {
          this._detachedBgTasks.set(tool.toolCallId, {
            ...handoff,
            startedAt: existingDetached.startedAt,
          });
          this.syncToolBackgroundState(tool.toolCallId, true, handoff.taskId);
        } else {
          existingDetached.status = 'completed';
          existingDetached.endedAt = this._now();
          existingDetached.outputText = tool.outputText;
          if (existingDetached.taskId) {
            this._settledTranscriptTaskIds.add(existingDetached.taskId);
          }
          this.syncToolBackgroundState(tool.toolCallId, false, existingDetached.taskId);
        }
      } else if (tool.outputText) {
        existingDetached.outputText = tool.outputText;
      }
      return;
    }

    // 3. Detect newly detached background tasks when tool call resolves as `done`,
    //    or settle any matching synthetic `transcript:*` entry if the ACP tool resolves after transcript sync.
    if (tool.status === 'done') {
      const detected = detectDetachedBackgroundTask(tool, turnIndex);
      if (detected && !(detected.taskId && this._settledTranscriptTaskIds.has(detected.taskId))) {
        this._detachedBgTasks.set(tool.toolCallId, detected);
        this.syncToolBackgroundState(tool.toolCallId, true, detected.taskId);
        return;
      }
    }

    if (tool.status === 'done' || tool.status === 'error' || tool.status === 'cancelled') {
      const now = this._now();
      const terminalStatus: 'completed' | 'failed' | 'cancelled' =
        tool.status === 'error'
          ? 'failed'
          : tool.status === 'cancelled'
            ? 'cancelled'
            : 'completed';
      for (const task of this._detachedBgTasks.values()) {
        if (task.status !== 'running' || !task.id.startsWith('transcript:')) continue;
        if (!this.matchesToolCommandDescription(tool, task.command ?? task.label)) continue;
        if (task.startedAt !== undefined && Math.abs(tool.startedAt - task.startedAt) > 60_000) {
          continue;
        }
        task.status = terminalStatus;
        task.endedAt = now;
        if (task.taskId) {
          this._settledTranscriptTaskIds.add(task.taskId);
        }
        this.syncToolBackgroundState(task.toolCallId, false, task.taskId);
      }
    }
  }

  private matchesToolCommandDescription(
    tool: ToolCallItem,
    description: string | undefined,
  ): boolean {
    if (!description) return false;
    const normDesc = description.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normDesc.length === 0) return false;
    const inputRec = asRecord(tool.args) ?? asRecord(tool.rawInput);
    const cmd = firstStringField(inputRec, [
      'CommandLine',
      'command',
      'cmd',
      'script',
      'CronExpression',
      'cronExpression',
    ]);
    const prompt = firstStringField(inputRec, ['Prompt', 'prompt', 'Description', 'description']);
    const fields = [tool.target, cmd, prompt, tool.title]
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => v.replace(/\s+/g, ' ').trim().toLowerCase());
    return fields.some((f) => f === normDesc || f.includes(normDesc) || normDesc.includes(f));
  }

  private isAsyncBackgroundCapableTool(tool: ToolCallItem): boolean {
    if (tool.backgroundRunning || tool.backgroundTaskId) {
      return true;
    }
    const rawName = (tool.rawName ?? '').toLowerCase();
    const titleLower = tool.title.toLowerCase();
    if (rawName === 'swarm' || titleLower.startsWith('swarm')) {
      return false;
    }
    if (
      rawName === 'invoke_subagent' ||
      rawName === 'subagent' ||
      titleLower.includes('invoke_subagent')
    ) {
      return true;
    }
    const kindLower = (tool.kind ?? '').toLowerCase();
    if (
      SYNC_ONLY_TOOL_NAMES.has(rawName) ||
      SYNC_ONLY_TOOL_NAMES.has(titleLower) ||
      kindLower === 'read' ||
      kindLower === 'edit' ||
      kindLower === 'delete' ||
      kindLower === 'move' ||
      isSynchronousMcpCommandTool(tool)
    ) {
      return false;
    }
    const jobType = classifyNonAgentJobType(tool);
    if (jobType === 'bash' || jobType === 'schedule' || jobType === 'workflow') {
      return true;
    }
    return Math.max(0, this._now() - tool.startedAt) >= LONG_RUNNING_TOOL_THRESHOLD_MS;
  }

  private syncToolBackgroundState(
    toolCallId: string,
    running: boolean,
    taskId?: string,
    terminalStatus?: 'completed' | 'failed' | 'cancelled',
  ): boolean {
    const entry = this._toolIndex.get(toolCallId);
    if (!entry) return false;
    const { tool, turnIndex } = entry;
    const nextTaskId = taskId ?? tool.backgroundTaskId;
    let changed = false;

    if (Boolean(tool.backgroundRunning) !== running) {
      tool.backgroundRunning = running;
      changed = true;
    }
    if (nextTaskId !== undefined && tool.backgroundTaskId !== nextTaskId) {
      tool.backgroundTaskId = nextTaskId;
      changed = true;
    }

    const turn = this._turns[turnIndex];
    if (
      !running &&
      terminalStatus !== undefined &&
      (tool.status === 'pending' || tool.status === 'running' || tool.status === 'ask') &&
      tool.endedAt === undefined
    ) {
      const now = this._now();
      tool.awaitingPermission = false;
      tool.permissionRequestId = undefined;
      if (terminalStatus === 'cancelled') {
        tool.cancelled = true;
        tool.status = 'cancelled';
      } else if (terminalStatus === 'failed') {
        tool.status = 'error';
      } else {
        tool.status = 'done';
      }
      tool.endedAt = now;
      if (!tool.replayed) {
        tool.tookMs = tool.tookMs ?? Math.max(0, now - tool.startedAt);
      }
      if (turn) {
        this.syncSubagentsForTool(turn, tool);
      }
      changed = true;
    }

    if (!changed) {
      return false;
    }
    this.bumpTurn(turn);
    return true;
  }

  private findMatchingInFlightToolForTranscriptTask(
    rec: TranscriptBackgroundTaskRecord,
  ): { readonly turnIndex: number; readonly tool: ToolCallItem } | null {
    const turn = this.activeTurn;
    if (!turn) return null;

    const candidates = turn.toolCalls.filter((t) => {
      if (t.status !== 'pending' && t.status !== 'running' && t.status !== 'ask') return false;
      if (t.endedAt !== undefined) return false;
      if (isSwarmOrSubagentTool(t)) return false;
      if (t.backgroundTaskId && t.backgroundTaskId !== rec.taskId) return false;
      const existing = this._detachedBgTasks.get(t.toolCallId);
      if (existing) {
        if (existing.status !== 'running') return false;
        if (existing.taskId && existing.taskId !== rec.taskId) return false;
      }
      return true;
    });
    if (candidates.length === 0) return null;

    if (rec.description) {
      const descMatches = candidates.filter((t) =>
        this.matchesToolCommandDescription(t, rec.description),
      );
      if (descMatches.length > 0) {
        return { turnIndex: turn.index, tool: descMatches[descMatches.length - 1]! };
      }
    }

    const commandCandidates = candidates.filter((t) => classifyNonAgentJobType(t) !== null);
    if (commandCandidates.length === 1) {
      return { turnIndex: turn.index, tool: commandCandidates[0]! };
    }
    if (candidates.length === 1) {
      return { turnIndex: turn.index, tool: candidates[0]! };
    }
    return null;
  }

  private registerInFlightToolAsBackgroundTask(turnIndex: number, tool: ToolCallItem): void {
    if (this._detachedBgTasks.has(tool.toolCallId)) return;
    const jobType = classifyNonAgentJobType(tool) ?? 'task';
    const inputRec = asRecord(tool.args) ?? asRecord(tool.rawInput);
    const command =
      jobType === 'bash'
        ? (tool.target ||
            firstStringField(inputRec, ['CommandLine', 'command', 'cmd', 'script']) ||
            (tool.title.toLowerCase() !== 'bash' ? tool.title : undefined))
        : firstStringField(inputRec, ['CommandLine', 'command', 'cmd', 'CronExpression', 'ScriptPath']);
    const labelSource =
      jobType === 'bash' ? (command ?? tool.title ?? 'bash') : (tool.title || tool.rawName || jobType);
    const rawName = (tool.rawName ?? '').toLowerCase();
    const isSubagent =
      rawName === 'invoke_subagent' ||
      rawName === 'subagent' ||
      tool.title.toLowerCase().includes('invoke_subagent');

    this._detachedBgTasks.set(tool.toolCallId, {
      id: tool.toolCallId,
      toolCallId: tool.toolCallId,
      type: jobType,
      label: collapseSingleLine(labelSource, 88),
      ...(command ? { command } : {}),
      ...(tool.title && tool.title !== command ? { title: tool.title } : {}),
      ...(isSubagent ? { agentKind: 'subagent' as const } : {}),
      startedAt: tool.startedAt,
      turnIndex,
      status: 'running',
      outputText: tool.outputText,
      awaitingToolCompletion: true,
    });
    this.syncToolBackgroundState(tool.toolCallId, true);
  }

  private reconcileBackgroundCompletionFromText(text: string): void {
    if (!text || this._detachedBgTasks.size === 0) return;
    const now = this._now();

    if (/\bAll\s+your\s+subagents\s+and\s+background\s+tasks\s+have\s+been\s+stopped\b/i.test(text)) {
      this.cancelActiveBackgroundTasks('cancelled');
      return;
    }

    // Explicit `Task id "<id>" [was|has|is] finished / exited / killed / canceled / failed / timed out` notification
    const explicitTaskRe =
      /\btask\s+id\s+["'`]?([A-Za-z0-9._:/-]+)["'`]?\s+(?:(?:was|has|is)\s+)?(finished|completed|exited|killed|cancelled|canceled|failed|stopped|terminated|aborted|errored|timed\s+out)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = explicitTaskRe.exec(text)) !== null) {
      const id = match[1];
      const verb = (match[2] ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
      if (!id) continue;
      const status: 'completed' | 'failed' | 'cancelled' =
        verb === 'failed' || verb === 'errored' || verb === 'timed out'
          ? 'failed'
          : verb === 'killed' ||
              verb === 'cancelled' ||
              verb === 'canceled' ||
              verb === 'stopped' ||
              verb === 'terminated' ||
              verb === 'aborted'
            ? 'cancelled'
            : 'completed';
      this.completeBackgroundTask(id, status);
    }

    const msgBlockRe =
      /\[Message\]\s+[^\r\n]*?\bsender=([^\s\]]+)[^\r\n]*?\bcontent=([\s\S]*?)(?=(?:\r?\n\[Message\]\s|\r?\n<\/SYSTEM_MESSAGE>|$))/gi;
    const schedTerminalRe =
      /^\s*(?:Cron(?:\s+schedule)?|Timer|Schedule)\s+(?:(?:was|has|is)\s+)?(completed|finished|expired|ended|cancelled|canceled|stopped|killed|terminated|aborted|failed|errored)\b/i;
    let msgMatch: RegExpExecArray | null;
    while ((msgMatch = msgBlockRe.exec(text)) !== null) {
      const senderId = msgMatch[1]?.replace(/[.,;)]+$/, '');
      const body = msgMatch[2] ?? '';
      if (!senderId || senderId.toLowerCase() === 'system') continue;
      const schedTerm = schedTerminalRe.exec(body);
      if (schedTerm?.[1]) {
        const lower = schedTerm[1].toLowerCase().replace(/[\s_]+/g, ' ').trim();
        const status: 'completed' | 'failed' | 'cancelled' =
          lower === 'failed' || lower === 'error' || lower === 'errored' || lower === 'timed out'
            ? 'failed'
            : lower === 'killed' ||
                lower === 'cancelled' ||
                lower === 'canceled' ||
                lower === 'stopped' ||
                lower === 'terminated' ||
                lower === 'aborted'
              ? 'cancelled'
              : 'completed';
        this.completeBackgroundTask(senderId, status);
        continue;
      }
      for (const task of this._detachedBgTasks.values()) {
        if (task.status === 'running' && task.taskId === senderId && task.scheduleKind === 'timer') {
          this.completeBackgroundTask(senderId, 'completed');
          break;
        }
      }
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
        if (task.taskId) {
          this._settledTranscriptTaskIds.add(task.taskId);
        }
        this.syncToolBackgroundState(task.toolCallId, false, task.taskId, terminal);
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
