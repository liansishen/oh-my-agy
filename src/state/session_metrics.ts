/**
 * Session telemetry tracker & transcript.jsonl incremental reader for `oma`.
 *
 * Tracks:
 * - Cumulative input tokens (uncached + cache read), cache hit rate, and output tokens
 *   by incrementally tailing the active session's local `agy` `transcript.jsonl`
 *   using byte offsets + `stat(size, mtimeMs)`.
 * - Real-time streaming output speed (TPS) via a 3-second sliding window token estimator
 *   (ASCII ~4 chars/tok, non-ASCII/CJK ~1.5 chars/tok), calibrated after turn completion
 *   using authoritative `output_tokens` deltas from `transcript.jsonl`.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export interface SessionMetricsSnapshot {
  /** Total input tokens (`totalUncachedInputTokens + totalCacheReadTokens`). */
  readonly totalInputTokens: number;
  /** Cumulative uncached input tokens (`input_tokens` in `agy` transcript logs). */
  readonly totalUncachedInputTokens: number;
  /** Cumulative cache-read input tokens (`cache_read_tokens` in `agy` transcript logs). */
  readonly totalCacheReadTokens: number;
  /** Cumulative output tokens (`output_tokens` in `agy` transcript logs). */
  readonly totalOutputTokens: number;
  /** Prompt cache hit ratio in `[0, 100]`, or `null` when `totalInputTokens === 0`. */
  readonly cacheHitPercent: number | null;
  /** Number of transcript records carrying model token usage fields. */
  readonly responseCount: number;
  /** Current effective TPS (live sliding window while streaming, or calibrated/idle value). */
  readonly currentTps: number | null;
  /** `true` when `currentTps` reflects live streaming output; `false` when idle/historical. */
  readonly isStreamingTps: boolean;
}

export interface TranscriptPathOptions {
  /** Direct override of the `transcript.jsonl` file path (highest precedence). */
  readonly transcriptPath?: string;
  /** Override the `brain` root directory (default `~/.gemini/antigravity-cli/brain`). */
  readonly baseBrainDir?: string;
  /** Override the Antigravity CLI app-data dir (maps to `<appDataDir>/brain`). */
  readonly appDataDir?: string;
  /** Override the `.gemini` dir (maps to `<geminiDir>/antigravity-cli/brain`). */
  readonly geminiDir?: string;
}

export interface SessionMetricsTrackerOptions extends TranscriptPathOptions {
  /** Clock provider for deterministic testing (default `Date.now`). */
  readonly now?: () => number;
  /** Optional initial session ID to bind on construction. */
  readonly sessionId?: string | null;
}

export interface TranscriptCompactionCheckpoint {
  readonly stepIndex: number;
  readonly userInputsBefore: number;
  readonly precededByCompactCommand: boolean;
  /** Count of tool calls (`GENERIC` steps) in the same turn before this `CHECKPOINT`. */
  readonly toolCallsBeforeInTurn: number;
  /** Count of non-empty assistant replies (`PLANNER_RESPONSE` steps) in the same turn before this `CHECKPOINT`. */
  readonly assistantResponsesBeforeInTurn: number;
  readonly summaryText: string;
  readonly createdAt?: string;
  readonly tokensBefore?: number;
  readonly summaryTokens?: number;
}

export type TranscriptScheduleKind = 'timer' | 'cron';

export interface TranscriptBackgroundTaskRecord {
  readonly taskId: string;
  readonly stepIndex: number;
  readonly description?: string;
  readonly logPath?: string;
  readonly scheduleKind?: TranscriptScheduleKind;
  readonly isDaemon?: boolean;
  readonly startedAt?: number;
  readonly status: 'running' | 'completed' | 'failed' | 'cancelled';
  readonly endedAt?: number;
}

export type TranscriptStepKind =
  | 'user_input'
  | 'planner_final'
  | 'planner_tool_call'
  | 'planner_empty'
  | 'tool_running'
  | 'tool_done'
  | 'system_message'
  | 'checkpoint'
  | 'other';

export interface TranscriptTurnActivity {
  readonly latestStepSeq: number;
  readonly latestKind: TranscriptStepKind;
  readonly resetAll?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TPS_WINDOW_MS = 3_000;
const MIN_STREAM_DURATION_MS = 100;
const MIN_IMPLICIT_STREAM_DURATION_MS = 500;
const BURST_GUARD_WINDOW_MS = 500;
const BURST_GUARD_MAX_TPS = 400;
const MAX_REASONABLE_TPS = 1_000;
const CALIBRATION_EXPIRY_MS = 15_000;
const READ_CHUNK_BYTES = 256 * 1024;
const ASCII_CHARS_PER_TOKEN = 4;
const NON_ASCII_CHARS_PER_TOKEN = 1.5;

export interface EndStreamTurnOptions {
  /** Authoritative single-turn output tokens reported by ACP `session/prompt` result. */
  readonly authoritativeOutputTokens?: number;
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the local `agy` `transcript.jsonl` path for a given session ID.
 *
 * Default layout:
 *   `<homedir>/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/logs/transcript.jsonl`
 */
export function getTranscriptPath(sessionId: string, opts?: TranscriptPathOptions): string {
  if (opts?.transcriptPath) {
    return path.resolve(opts.transcriptPath);
  }

  let baseBrainDir: string;
  if (opts?.baseBrainDir) {
    baseBrainDir = path.resolve(opts.baseBrainDir);
  } else if (opts?.appDataDir) {
    baseBrainDir = path.join(path.resolve(opts.appDataDir), 'brain');
  } else if (opts?.geminiDir) {
    baseBrainDir = path.join(path.resolve(opts.geminiDir), 'antigravity-cli', 'brain');
  } else {
    baseBrainDir = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
  }

  return path.join(baseBrainDir, sessionId, '.system_generated', 'logs', 'transcript.jsonl');
}

// ---------------------------------------------------------------------------
// Token Estimation & Formatting Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate token count for streamed text chunks:
 * - ASCII code points (`<= 0x7F`): ~4 chars per token
 * - Non-ASCII / CJK / emoji code points (`> 0x7F`): ~1.5 code points per token
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code === undefined) break;
    if (code > 0xffff) {
      // Advance past trailing surrogate so emoji/astral code points count once
      i += 1;
    }
    if (code <= 0x7f) {
      asciiCount += 1;
    } else {
      nonAsciiCount += 1;
    }
  }
  return asciiCount / ASCII_CHARS_PER_TOKEN + nonAsciiCount / NON_ASCII_CHARS_PER_TOKEN;
}

function formatCompactCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n >= 1_000_000) {
    const val = n / 1_000_000;
    return Number.isInteger(val) ? `${val}M` : `${val.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 1_000) {
    const val = n / 1_000;
    return val >= 100 ? `${Math.round(val)}k` : `${val.toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(Math.round(n));
}

/**
 * Format TPS value for compact status bar display (e.g. `24.5 tok/s`, `331 tok/s`).
 * Returns `null` when `tps` is null, non-finite, or `<= 0`.
 */
export function formatTpsText(tps: number | null | undefined): string | null {
  if (tps === null || tps === undefined || !Number.isFinite(tps) || tps <= 0) {
    return null;
  }
  const value = tps >= 100 ? Math.round(tps).toString() : tps.toFixed(1);
  return `${value} tok/s`;
}

/**
 * Format cumulative token & cache hit telemetry for compact status bar display:
 * `↑总输入(命中率%) ↓总输出` (e.g. `↑1.2M(89%) ↓45k`).
 * Returns `null` when both total input and output tokens are zero.
 */
export function formatTokenMetricsText(
  metrics: SessionMetricsSnapshot | null | undefined,
): string | null {
  if (!metrics) return null;
  if (metrics.totalInputTokens <= 0 && metrics.totalOutputTokens <= 0) {
    return null;
  }
  const inputPart = formatCompactCount(metrics.totalInputTokens);
  const hitPart =
    metrics.cacheHitPercent !== null && Number.isFinite(metrics.cacheHitPercent)
      ? `(${Math.round(metrics.cacheHitPercent)}%)`
      : '';
  const outputPart = formatCompactCount(metrics.totalOutputTokens);
  return `↑${inputPart}${hitPart} ↓${outputPart}`;
}

/**
 * Deep value equality helper for `SessionMetricsSnapshot` so `AppStore` can skip
 * redundant `emit()` calls when nothing changed.
 */
export function areSessionMetricsEqual(
  a: SessionMetricsSnapshot | null,
  b: SessionMetricsSnapshot | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.totalInputTokens === b.totalInputTokens &&
    a.totalUncachedInputTokens === b.totalUncachedInputTokens &&
    a.totalCacheReadTokens === b.totalCacheReadTokens &&
    a.totalOutputTokens === b.totalOutputTokens &&
    a.cacheHitPercent === b.cacheHitPercent &&
    a.responseCount === b.responseCount &&
    a.currentTps === b.currentTps &&
    a.isStreamingTps === b.isStreamingTps
  );
}

// ---------------------------------------------------------------------------
// JSONL Token Record Extraction
// ---------------------------------------------------------------------------

interface ParsedTokenRecord {
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly outputTokens: number;
  readonly isCheckpoint: boolean;
}

interface ParsedTranscriptLine {
  readonly tokens: ParsedTokenRecord | null;
  readonly explicitUserInput?: {
    readonly isCompactCommand: boolean;
  };
  readonly checkpoint?: {
    readonly stepIndex?: number;
    readonly summaryText: string;
    readonly createdAt?: string;
    readonly tokensBefore?: number;
    readonly summaryTokens?: number;
  };
  readonly backgroundTaskStarted?: {
    readonly taskId: string;
    readonly stepIndex?: number;
    readonly description?: string;
    readonly logPath?: string;
    readonly scheduleKind?: TranscriptScheduleKind;
    readonly startedAt?: number;
  };
  readonly plannerDaemonToolCalls?: readonly {
    readonly stepIndex?: number;
    readonly toolName: 'run_command' | 'schedule';
    readonly hints: readonly string[];
  }[];
  readonly backgroundTasksListed?: {
    readonly tasks: readonly {
      readonly taskId: string;
      readonly isDaemon?: boolean;
      readonly description?: string;
    }[];
    readonly endedAt?: number;
  };
  readonly backgroundTaskTerminals?: readonly {
    readonly taskId: string;
    readonly status: 'completed' | 'failed' | 'cancelled';
    readonly endedAt?: number;
  }[];
  readonly backgroundTaskMessageSenders?: readonly {
    readonly taskId: string;
    readonly endedAt?: number;
  }[];
  readonly backgroundTasksNoneRunning?: {
    readonly endedAt?: number;
  };
  readonly backgroundTasksResetAll?: {
    readonly endedAt?: number;
  };
  readonly isToolStep?: boolean;
  readonly isAssistantResponseStep?: boolean;
  readonly stepActivity?: {
    readonly kind: TranscriptStepKind;
  };
}

const TRANSCRIPT_BG_RUNNING_ID_RE =
  /\bTool\s+is\s+running\s+as\s+a\s+background\s+task\s+with\s+task\s+id:\s*["'`]?([A-Za-z0-9._:/-]+)["'`]?/i;
const TRANSCRIPT_BG_TASK_DESC_RE =
  /\bTask\s+Description:\s*([\s\S]*?)(?=(?:\r?\n\s*(?:Task\s+logs\s+are\s+available\s+at:|Log\s+output:|YOU\s+MUST\s+TAKE\s+ONE)|$))/i;
const TRANSCRIPT_BG_TASK_LOG_RE = /\bTask\s+logs\s+are\s+available\s+at:\s*([^\r\n]+)/i;
const TRANSCRIPT_BG_TERMINAL_RE =
  /\bTask\s+id\s+["'`]?([A-Za-z0-9._:/-]+)["'`]?\s+(?:(?:was|has|is)\s+)?(finished|completed|exited|killed|cancelled|canceled|failed|stopped|terminated|aborted|errored|timed\s+out)\b/gi;
const TRANSCRIPT_BG_STILL_RUNNING_RE =
  /\b(?:still\s+running|continues?\s+to\s+run|notification\s+timeout)\b/i;

function isLineNonTerminalRunningNotice(
  text: string,
  matchStart: number,
  matchLen: number,
): boolean {
  const lineStart = text.lastIndexOf('\n', matchStart) + 1;
  const rawLineEnd = text.indexOf('\n', matchStart + matchLen);
  const lineEnd = rawLineEnd === -1 ? text.length : rawLineEnd;
  const line = text.slice(lineStart, lineEnd);
  return TRANSCRIPT_BG_STILL_RUNNING_RE.test(line);
}
const TRANSCRIPT_BG_SERVER_RESET_RE =
  /\bAll\s+your\s+subagents\s+and\s+background\s+tasks\s+have\s+been\s+stopped\b/i;
const TRANSCRIPT_SYSTEM_MESSAGE_BLOCK_RE =
  /\[Message\]\s+[^\r\n]*?\bsender=([^\s\]]+)[^\r\n]*?\bcontent=([\s\S]*?)(?=(?:\r?\n\[Message\]\s|\r?\n<\/SYSTEM_MESSAGE>|$))/gi;
const TRANSCRIPT_BG_SCHEDULE_TERMINAL_RE =
  /^\s*(?:Cron(?:\s+schedule)?|Timer|Schedule)\s+(?:(?:was|has|is)\s+)?(completed|finished|expired|ended|cancelled|canceled|stopped|killed|terminated|aborted|failed|errored)\b/i;
const TRANSCRIPT_GENERIC_HEADER_LINE_RE = /^(?:Created|Completed)\s+At:[^\r\n]*$/i;
const TRANSCRIPT_GENERIC_TASK_TERMINAL_RE =
  /^Task\s+["'`]?([A-Za-z0-9._:/-]+)["'`]?\s+(?:(?:was|has|is)\s+)?(cancelled|canceled|killed|stopped|terminated|aborted|completed|finished|failed)\.?\s*$/i;
const TRANSCRIPT_GENERIC_NO_BG_TASKS_RE =
  /^No\s+(?:(?:running|active|background)\s+)*tasks?(?:\s+are)?\s+(?:currently\s+)?running\.?\s*$/i;
const TRANSCRIPT_GENERIC_TASK_STATUS_LINE_RE =
  /^Task:\s*([A-Za-z0-9._:/-]+)\s*\|\s*Status:\s*([A-Z_]+)\b/i;
const TRANSCRIPT_MANAGE_TASK_LIST_RE =
  /You\s+have\s+\d+\s+background\s+task\(s\)\s+currently\s+running:\s*(\[[\s\S]*\])/i;

function parseDaemonFlag(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  const cleaned = value.trim().replace(/^["']|["']$/g, '').trim().toLowerCase();
  return cleaned === 'true';
}

function stripQuotedArgString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    const inner = trimmed.slice(1, -1).trim();
    return inner.length > 0 ? inner : undefined;
  }
  return trimmed;
}

function parseManageTaskListJson(
  body: string,
): ReadonlyArray<{ readonly taskId: string; readonly isDaemon?: boolean; readonly description?: string }> | null {
  const match = TRANSCRIPT_MANAGE_TASK_LIST_RE.exec(body);
  if (!match?.[1]) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: Array<{ readonly taskId: string; readonly isDaemon?: boolean; readonly description?: string }> = [];
  for (const item of parsed) {
    if (!isPlainObject(item)) continue;
    const rawId = item['taskId'] ?? item['task_id'] ?? item['TaskId'];
    const taskId = typeof rawId === 'string' ? rawId.trim() : '';
    if (!taskId) continue;
    const isDaemon = parseDaemonFlag(item['isDaemon'] ?? item['IsDaemon'] ?? item['is_daemon']);
    const rawDesc = item['description'] ?? item['Description'] ?? item['toolSummary'];
    const description = typeof rawDesc === 'string' && rawDesc.trim().length > 0 ? rawDesc.trim() : undefined;
    out.push({
      taskId,
      ...(isDaemon ? { isDaemon: true } : {}),
      ...(description ? { description } : {}),
    });
  }
  return out;
}
const TRANSCRIPT_TERMINAL_STATUS_TOKENS = new Set([
  'COMPLETED',
  'FINISHED',
  'DONE',
  'EXITED',
  'FAILED',
  'ERROR',
  'ERRORED',
  'TIMED_OUT',
  'CANCELLED',
  'CANCELED',
  'KILLED',
  'STOPPED',
  'TERMINATED',
  'ABORTED',
]);

function inferScheduleKindFromDescription(description?: string): TranscriptScheduleKind | undefined {
  if (!description) return undefined;
  if (/^Timer\s*:/i.test(description)) return 'timer';
  if (/^Cron\s*:/i.test(description)) return 'cron';
  return undefined;
}

function stripLeadingTranscriptTimestamps(content: string): string {
  const lines = content.split(/\r?\n/);
  let idx = 0;
  while (idx < lines.length) {
    const trimmed = lines[idx]!.trim();
    if (trimmed.length === 0 || TRANSCRIPT_GENERIC_HEADER_LINE_RE.test(trimmed)) {
      idx += 1;
      continue;
    }
    break;
  }
  return lines.slice(idx).join('\n').trim();
}

function parseTranscriptTimestampMs(raw: Record<string, unknown>): number | undefined {
  const iso =
    typeof raw.created_at === 'string'
      ? raw.created_at
      : typeof raw.createdAt === 'string'
        ? raw.createdAt
        : undefined;
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
}

function mapTranscriptTerminalVerb(verb: string): 'completed' | 'failed' | 'cancelled' {
  const lower = verb.toLowerCase().replace(/[\s_]+/g, ' ').trim();
  if (lower === 'failed' || lower === 'error' || lower === 'errored' || lower === 'timed out') {
    return 'failed';
  }
  if (
    lower === 'killed' ||
    lower === 'cancelled' ||
    lower === 'canceled' ||
    lower === 'stopped' ||
    lower === 'terminated' ||
    lower === 'aborted'
  ) {
    return 'cancelled';
  }
  return 'completed';
}

const SKIPPED_CHECKPOINT_STATUSES = new Set([
  'IN_PROGRESS',
  'RUNNING',
  'PENDING',
  'FAILED',
  'ERROR',
]);

function extractUserInputCommandText(content: string): string {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  return (match ? match[1]! : content).trim();
}

function extractCheckpointSummaryText(content: string): string {
  const match = /<summary>\s*([\s\S]*?)\s*<\/summary>/i.exec(content);
  const extracted = match?.[1]?.trim();
  return extracted && extracted.length > 0 ? extracted : content.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonNegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readFirstNumber(
  obj: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const val = asNonNegativeFiniteNumber(obj[key]);
    if (val !== undefined) return val;
  }
  return undefined;
}

const INPUT_TOKEN_KEYS = ['input_tokens', 'inputTokens'] as const;
const CACHE_READ_TOKEN_KEYS = [
  'cache_read_tokens',
  'cacheReadTokens',
  'cache_read_input_tokens',
  'cached_input_tokens',
] as const;
const OUTPUT_TOKEN_KEYS = ['output_tokens', 'outputTokens'] as const;

function extractTokenFields(obj: Record<string, unknown>): {
  input?: number;
  cacheRead?: number;
  output?: number;
} {
  const input = readFirstNumber(obj, INPUT_TOKEN_KEYS);
  const cacheRead = readFirstNumber(obj, CACHE_READ_TOKEN_KEYS);
  const output = readFirstNumber(obj, OUTPUT_TOKEN_KEYS);
  if (input !== undefined || cacheRead !== undefined || output !== undefined) {
    return { input, cacheRead, output };
  }

  // Fallback for nested usage objects if ever emitted by future agy versions
  for (const nestedKey of ['usage', 'token_usage', 'tokenUsage'] as const) {
    const nested = obj[nestedKey];
    if (!isPlainObject(nested)) continue;
    const nIn = readFirstNumber(nested, INPUT_TOKEN_KEYS);
    const nCache = readFirstNumber(nested, CACHE_READ_TOKEN_KEYS);
    const nOut = readFirstNumber(nested, OUTPUT_TOKEN_KEYS);
    if (nIn !== undefined || nCache !== undefined || nOut !== undefined) {
      return { input: nIn, cacheRead: nCache, output: nOut };
    }
  }

  return {};
}

function parseTranscriptLine(line: string): ParsedTranscriptLine | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isPlainObject(raw)) return null;

  const fields = extractTokenFields(raw);
  const recordType = typeof raw.type === 'string' ? raw.type.toUpperCase() : '';
  const hasTokens =
    fields.input !== undefined ||
    fields.cacheRead !== undefined ||
    fields.output !== undefined;

  const tokens: ParsedTokenRecord | null = hasTokens
    ? {
        uncachedInputTokens: fields.input ?? 0,
        cacheReadTokens: fields.cacheRead ?? 0,
        outputTokens: fields.output ?? 0,
        isCheckpoint: recordType === 'CHECKPOINT',
      }
    : null;

  let explicitUserInput: ParsedTranscriptLine['explicitUserInput'];
  if (recordType === 'USER_INPUT') {
    const source = typeof raw.source === 'string' ? raw.source.trim().toUpperCase() : '';
    if (source === '' || source === 'USER_EXPLICIT') {
      const content = typeof raw.content === 'string' ? extractUserInputCommandText(raw.content) : '';
      explicitUserInput = {
        isCompactCommand: /^\/compact(?:\s|$)/i.test(content),
      };
    }
  }

  let checkpoint: ParsedTranscriptLine['checkpoint'];
  if (recordType === 'CHECKPOINT') {
    const status = typeof raw.status === 'string' ? raw.status.trim().toUpperCase() : '';
    if (!SKIPPED_CHECKPOINT_STATUSES.has(status)) {
      const content = typeof raw.content === 'string' ? raw.content : '';
      const summaryText = content ? extractCheckpointSummaryText(content) : '';
      const stepIndex = asNonNegativeFiniteNumber(raw.step_index ?? raw.stepIndex);
      const createdAt =
        typeof raw.created_at === 'string'
          ? raw.created_at
          : typeof raw.createdAt === 'string'
            ? raw.createdAt
            : undefined;
      const tokensBefore =
        fields.input !== undefined || fields.cacheRead !== undefined
          ? (fields.input ?? 0) + (fields.cacheRead ?? 0)
          : undefined;
      const summaryTokens = fields.output;
      checkpoint = {
        ...(stepIndex !== undefined ? { stepIndex } : {}),
        summaryText,
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(tokensBefore !== undefined ? { tokensBefore } : {}),
        ...(summaryTokens !== undefined ? { summaryTokens } : {}),
      };
    }
  }

  let backgroundTaskStarted: ParsedTranscriptLine['backgroundTaskStarted'];
  const rawStatus = typeof raw.status === 'string' ? raw.status.trim().toUpperCase() : '';
  const rawSource = typeof raw.source === 'string' ? raw.source.trim().toUpperCase() : '';
  if (rawStatus === 'RUNNING' && typeof raw.content === 'string') {
    const logIdx = raw.content.search(/(?:^|\r?\n)\s*Log\s+output\s*:/i);
    const header = logIdx >= 0 ? raw.content.slice(0, logIdx) : raw.content;
    const idMatch = TRANSCRIPT_BG_RUNNING_ID_RE.exec(header);
    if (idMatch?.[1]) {
      const taskId = idMatch[1].replace(/[.,;)]+$/, '');
      const descMatch = TRANSCRIPT_BG_TASK_DESC_RE.exec(header);
      const description = descMatch?.[1]?.trim();
      const scheduleKind = inferScheduleKindFromDescription(description);
      const logMatch = TRANSCRIPT_BG_TASK_LOG_RE.exec(header);
      const logPath = logMatch?.[1]?.trim();
      const stepIndex = asNonNegativeFiniteNumber(raw.step_index ?? raw.stepIndex);
      const startedAt = parseTranscriptTimestampMs(raw);
      backgroundTaskStarted = {
        taskId,
        ...(stepIndex !== undefined ? { stepIndex } : {}),
        ...(description ? { description } : {}),
        ...(logPath ? { logPath } : {}),
        ...(scheduleKind ? { scheduleKind } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
      };
    }
  }

  let backgroundTaskTerminals: Array<{
    readonly taskId: string;
    readonly status: 'completed' | 'failed' | 'cancelled';
    readonly endedAt?: number;
  }> | undefined;
  let backgroundTaskMessageSenders: Array<{
    readonly taskId: string;
    readonly endedAt?: number;
  }> | undefined;
  let backgroundTasksNoneRunning: ParsedTranscriptLine['backgroundTasksNoneRunning'];
  let backgroundTasksResetAll: ParsedTranscriptLine['backgroundTasksResetAll'];
  let backgroundTasksListed: ParsedTranscriptLine['backgroundTasksListed'];
  let plannerDaemonToolCalls:
    | Array<{
        readonly stepIndex?: number;
        readonly toolName: 'run_command' | 'schedule';
        readonly hints: readonly string[];
      }>
    | undefined;
  if ((recordType === 'SYSTEM_MESSAGE' || rawSource === 'SYSTEM') && typeof raw.content === 'string') {
    TRANSCRIPT_BG_TERMINAL_RE.lastIndex = 0;
    const endedAt = parseTranscriptTimestampMs(raw);
    let termMatch: RegExpExecArray | null;
    while ((termMatch = TRANSCRIPT_BG_TERMINAL_RE.exec(raw.content)) !== null) {
      if (isLineNonTerminalRunningNotice(raw.content, termMatch.index, termMatch[0].length)) {
        continue;
      }
      const taskId = termMatch[1]?.replace(/[.,;)]+$/, '');
      const verb = termMatch[2];
      if (!taskId || !verb) continue;
      if (!backgroundTaskTerminals) {
        backgroundTaskTerminals = [];
      }
      backgroundTaskTerminals.push({
        taskId,
        status: mapTranscriptTerminalVerb(verb),
        ...(endedAt !== undefined ? { endedAt } : {}),
      });
    }
    TRANSCRIPT_SYSTEM_MESSAGE_BLOCK_RE.lastIndex = 0;
    let msgMatch: RegExpExecArray | null;
    while ((msgMatch = TRANSCRIPT_SYSTEM_MESSAGE_BLOCK_RE.exec(raw.content)) !== null) {
      const senderId = msgMatch[1]?.replace(/[.,;)]+$/, '');
      const body = msgMatch[2] ?? '';
      if (!senderId || senderId.toLowerCase() === 'system') continue;
      const schedTerm = TRANSCRIPT_BG_SCHEDULE_TERMINAL_RE.exec(body);
      if (schedTerm?.[1]) {
        if (!backgroundTaskTerminals) {
          backgroundTaskTerminals = [];
        }
        backgroundTaskTerminals.push({
          taskId: senderId,
          status: mapTranscriptTerminalVerb(schedTerm[1]),
          ...(endedAt !== undefined ? { endedAt } : {}),
        });
      }
      if (!backgroundTaskMessageSenders) {
        backgroundTaskMessageSenders = [];
      }
      backgroundTaskMessageSenders.push({
        taskId: senderId,
        ...(endedAt !== undefined ? { endedAt } : {}),
      });
    }
    if (TRANSCRIPT_BG_SERVER_RESET_RE.test(raw.content)) {
      backgroundTasksResetAll = endedAt !== undefined ? { endedAt } : {};
    }
  }

  if (recordType === 'GENERIC' && rawStatus === 'DONE' && typeof raw.content === 'string') {
    const body = stripLeadingTranscriptTimestamps(raw.content);
    if (body.length > 0 && !/^Command\s+exited\s+with\s+code\b/i.test(body)) {
      const endedAt = parseTranscriptTimestampMs(raw);
      const termMatch = TRANSCRIPT_GENERIC_TASK_TERMINAL_RE.exec(body);
      if (termMatch?.[1] && termMatch[2]) {
        if (!backgroundTaskTerminals) {
          backgroundTaskTerminals = [];
        }
        backgroundTaskTerminals.push({
          taskId: termMatch[1].replace(/[.,;)]+$/, ''),
          status: mapTranscriptTerminalVerb(termMatch[2]),
          ...(endedAt !== undefined ? { endedAt } : {}),
        });
      } else if (TRANSCRIPT_GENERIC_NO_BG_TASKS_RE.test(body)) {
        backgroundTasksNoneRunning = endedAt !== undefined ? { endedAt } : {};
      } else {
        const listedTasks = parseManageTaskListJson(body);
        if (listedTasks !== null) {
          backgroundTasksListed = {
            tasks: listedTasks,
            ...(endedAt !== undefined ? { endedAt } : {}),
          };
        } else {
          const bodyLines = body
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          if (
            bodyLines.length > 0 &&
            bodyLines.every((line) => TRANSCRIPT_GENERIC_TASK_STATUS_LINE_RE.test(line))
          ) {
            for (const line of bodyLines) {
              const statusMatch = TRANSCRIPT_GENERIC_TASK_STATUS_LINE_RE.exec(line);
              const taskId = statusMatch?.[1]?.replace(/[.,;)]+$/, '');
              const statusToken = statusMatch?.[2]?.toUpperCase();
              if (!taskId || !statusToken) continue;
              if (!TRANSCRIPT_TERMINAL_STATUS_TOKENS.has(statusToken)) continue;
              if (!backgroundTaskTerminals) {
                backgroundTaskTerminals = [];
              }
              backgroundTaskTerminals.push({
                taskId,
                status: mapTranscriptTerminalVerb(statusToken),
                ...(endedAt !== undefined ? { endedAt } : {}),
              });
            }
          }
        }
      }
    }
  }

  const isToolStep = recordType === 'GENERIC';
  const isAssistantResponseStep =
    recordType === 'PLANNER_RESPONSE' &&
    typeof raw.content === 'string' &&
    raw.content.trim().length > 0;

  let stepActivity: ParsedTranscriptLine['stepActivity'];
  if (recordType.length > 0) {
    let kind: TranscriptStepKind = 'other';
    if (recordType === 'USER_INPUT') {
      kind = 'user_input';
    } else if (recordType === 'CHECKPOINT') {
      kind = 'checkpoint';
    } else if (recordType === 'SYSTEM_MESSAGE' || recordType === 'ERROR_MESSAGE') {
      kind = 'system_message';
    } else if (recordType === 'GENERIC') {
      kind = rawStatus === 'RUNNING' ? 'tool_running' : 'tool_done';
    } else if (recordType === 'PLANNER_RESPONSE') {
      const rawToolCalls = Array.isArray(raw.tool_calls)
        ? raw.tool_calls
        : Array.isArray(raw.toolCalls)
          ? raw.toolCalls
          : [];
      const plannerStepIdx = asNonNegativeFiniteNumber(raw.step_index ?? raw.stepIndex);
      for (const tc of rawToolCalls) {
        if (!isPlainObject(tc)) continue;
        const toolNameRaw = typeof tc['name'] === 'string' ? tc['name'].trim().toLowerCase() : '';
        if (toolNameRaw !== 'run_command' && toolNameRaw !== 'schedule') continue;
        const argsRec = isPlainObject(tc['args']) ? tc['args'] : null;
        if (!argsRec) continue;
        if (!parseDaemonFlag(argsRec['IsDaemon'] ?? argsRec['isDaemon'] ?? argsRec['is_daemon'])) {
          continue;
        }
        const hints = [
          stripQuotedArgString(argsRec['CommandLine']),
          stripQuotedArgString(argsRec['command']),
          stripQuotedArgString(argsRec['toolSummary']),
          stripQuotedArgString(argsRec['CronExpression']),
          stripQuotedArgString(argsRec['Prompt']),
          stripQuotedArgString(argsRec['Description']),
        ].filter((v): v is string => v !== undefined);
        if (!plannerDaemonToolCalls) {
          plannerDaemonToolCalls = [];
        }
        plannerDaemonToolCalls.push({
          ...(plannerStepIdx !== undefined ? { stepIndex: plannerStepIdx } : {}),
          toolName: toolNameRaw,
          hints,
        });
      }
      const hasText = typeof raw.content === 'string' && raw.content.trim().length > 0;
      kind =
        rawToolCalls.length > 0
          ? 'planner_tool_call'
          : hasText
            ? 'planner_final'
            : 'planner_empty';
    }
    stepActivity = { kind };
  }

  if (
    !tokens &&
    !explicitUserInput &&
    !checkpoint &&
    !backgroundTaskStarted &&
    !plannerDaemonToolCalls &&
    !backgroundTasksListed &&
    (!backgroundTaskTerminals || backgroundTaskTerminals.length === 0) &&
    (!backgroundTaskMessageSenders || backgroundTaskMessageSenders.length === 0) &&
    !backgroundTasksNoneRunning &&
    !backgroundTasksResetAll &&
    !isToolStep &&
    !isAssistantResponseStep &&
    !stepActivity
  ) {
    return null;
  }

  return {
    tokens,
    ...(explicitUserInput ? { explicitUserInput } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(backgroundTaskStarted ? { backgroundTaskStarted } : {}),
    ...(plannerDaemonToolCalls ? { plannerDaemonToolCalls } : {}),
    ...(backgroundTasksListed ? { backgroundTasksListed } : {}),
    ...(backgroundTaskTerminals && backgroundTaskTerminals.length > 0
      ? { backgroundTaskTerminals }
      : {}),
    ...(backgroundTaskMessageSenders && backgroundTaskMessageSenders.length > 0
      ? { backgroundTaskMessageSenders }
      : {}),
    ...(backgroundTasksNoneRunning ? { backgroundTasksNoneRunning } : {}),
    ...(backgroundTasksResetAll ? { backgroundTasksResetAll } : {}),
    ...(isToolStep ? { isToolStep } : {}),
    ...(isAssistantResponseStep ? { isAssistantResponseStep } : {}),
    ...(stepActivity ? { stepActivity } : {}),
  };
}

// ---------------------------------------------------------------------------
// SessionMetricsTracker
// ---------------------------------------------------------------------------

interface StreamSample {
  readonly ts: number;
  readonly tokens: number;
}

interface PendingTpsCalibration {
  readonly durationMs: number;
  readonly baselineOutputTokens: number;
  readonly endedAt: number;
}

export class SessionMetricsTracker {
  private readonly _now: () => number;
  private readonly _pathOpts: TranscriptPathOptions;

  private _sessionId: string | null = null;
  private _transcriptPath: string | null = null;

  // Incremental file tail state
  private _byteOffset = 0;
  private _lastMtimeMs: number | null = null;
  private _pendingBytes: Buffer = Buffer.alloc(0);
  private _syncChain: Promise<SessionMetricsSnapshot> = Promise.resolve(this.createEmptySnapshot());

  // Cumulative transcript stats
  private _totalUncachedInputTokens = 0;
  private _totalCacheReadTokens = 0;
  private _totalOutputTokens = 0;
  private _responseCount = 0;

  // Incremental compaction checkpoint tracking
  private _explicitUserInputCount = 0;
  private _lastExplicitUserInputWasCompact = false;
  private _turnToolCallsSinceUserInput = 0;
  private _turnAssistantResponsesSinceUserInput = 0;
  private _checkpointSeq = 0;
  private _latestCheckpoint: TranscriptCompactionCheckpoint | null = null;

  // Incremental background task & step activity tracking from transcript.jsonl
  private _bgTaskSeq = 0;
  private readonly _transcriptBgTasks = new Map<string, TranscriptBackgroundTaskRecord>();
  private _pendingPlannerDaemons: Array<{
    readonly stepIndex?: number;
    readonly toolName: 'run_command' | 'schedule';
    readonly hints: readonly string[];
  }> = [];
  private _bgBaselineMaxStepIndex: number | null = null;
  private _hasTranscriptData = false;
  private _activityStepSeq = 0;
  private _latestTurnActivity: TranscriptTurnActivity | null = null;

  // Streaming sliding window & post-turn calibration
  private _streaming = false;
  private _implicitStream = false;
  private _turnStartTime: number | null = null;
  private _segmentStartTime: number | null = null;
  private _toolWaitPausedAt: number | null = null;
  private _accumulatedToolWaitMs = 0;
  private _turnStartOutputTokens = 0;
  private _turnEstimatedTokens = 0;
  private _samples: StreamSample[] = [];
  private _pendingCalibration: PendingTpsCalibration | null = null;
  private _currentTps: number | null = null;
  private _isStreamingTps = false;

  constructor(options: SessionMetricsTrackerOptions = {}) {
    this._now = options.now ?? (() => Date.now());
    this._pathOpts = {
      ...(options.transcriptPath !== undefined ? { transcriptPath: options.transcriptPath } : {}),
      ...(options.baseBrainDir !== undefined ? { baseBrainDir: options.baseBrainDir } : {}),
      ...(options.appDataDir !== undefined ? { appDataDir: options.appDataDir } : {}),
      ...(options.geminiDir !== undefined ? { geminiDir: options.geminiDir } : {}),
    };

    if (options.sessionId !== undefined) {
      this.setSession(options.sessionId);
    } else if (options.transcriptPath) {
      this._transcriptPath = path.resolve(options.transcriptPath);
    }
  }

  private createEmptySnapshot(): SessionMetricsSnapshot {
    return {
      totalInputTokens: 0,
      totalUncachedInputTokens: 0,
      totalCacheReadTokens: 0,
      totalOutputTokens: 0,
      cacheHitPercent: null,
      responseCount: 0,
      currentTps: null,
      isStreamingTps: false,
    };
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get transcriptPath(): string | null {
    return this._transcriptPath;
  }

  /**
   * Bind the tracker to a new session (or `null` to detach) and reset all
   * incremental read offsets, remainder buffers, cumulative counters, and TPS state.
   */
  setSession(sessionId: string | null): void {
    const normalized = sessionId?.trim() || null;
    this._sessionId = normalized;
    this.resetCountersAndWindow();

    if (normalized === null) {
      this._transcriptPath = null;
    } else {
      this._transcriptPath = getTranscriptPath(normalized, this._pathOpts);
    }
  }

  /**
   * Reset all cumulative metrics, incremental byte offset/remainder, and TPS window
   * while preserving the currently bound session path.
   */
  reset(): void {
    this.resetCountersAndWindow();
  }

  private resetCountersAndWindow(): void {
    this._byteOffset = 0;
    this._lastMtimeMs = null;
    this._pendingBytes = Buffer.alloc(0);

    this._totalUncachedInputTokens = 0;
    this._totalCacheReadTokens = 0;
    this._totalOutputTokens = 0;
    this._responseCount = 0;

    this._explicitUserInputCount = 0;
    this._lastExplicitUserInputWasCompact = false;
    this._turnToolCallsSinceUserInput = 0;
    this._turnAssistantResponsesSinceUserInput = 0;
    this._checkpointSeq = 0;
    this._latestCheckpoint = null;

    this._bgTaskSeq = 0;
    this._transcriptBgTasks.clear();
    this._pendingPlannerDaemons = [];
    this._bgBaselineMaxStepIndex = null;
    this._hasTranscriptData = false;
    this._activityStepSeq = 0;
    this._latestTurnActivity = null;

    this._streaming = false;
    this._implicitStream = false;
    this._turnStartTime = null;
    this._segmentStartTime = null;
    this._toolWaitPausedAt = null;
    this._accumulatedToolWaitMs = 0;
    this._turnStartOutputTokens = 0;
    this._turnEstimatedTokens = 0;
    this._samples = [];
    this._pendingCalibration = null;
    this._currentTps = null;
    this._isStreamingTps = false;
  }

  get isStreaming(): boolean {
    return this._streaming;
  }

  get hasTranscriptData(): boolean {
    return this._hasTranscriptData;
  }

  getLatestCheckpoint(): TranscriptCompactionCheckpoint | null {
    return this._latestCheckpoint;
  }

  getLatestTurnActivity(): TranscriptTurnActivity | null {
    return this._latestTurnActivity;
  }

  /**
   * Pin the current highest transcript background task step index as historical baseline
   * (used after `/resume` replay so orphaned `RUNNING` entries from earlier runs are ignored).
   */
  markTranscriptBackgroundBaseline(): void {
    let maxStep = this._bgTaskSeq;
    for (const rec of this._transcriptBgTasks.values()) {
      if (rec.stepIndex > maxStep) {
        maxStep = rec.stepIndex;
      }
    }
    this._bgBaselineMaxStepIndex = maxStep;
  }

  /**
   * Return transcript-detected background tasks after any resumed baseline, plus terminal updates.
   */
  getTranscriptBackgroundTasks(): readonly TranscriptBackgroundTaskRecord[] {
    const baseline = this._bgBaselineMaxStepIndex ?? -1;
    const out: TranscriptBackgroundTaskRecord[] = [];
    for (const rec of this._transcriptBgTasks.values()) {
      if (rec.status !== 'running' || rec.stepIndex > baseline) {
        out.push(rec);
      }
    }
    return out;
  }

  getSnapshot(): SessionMetricsSnapshot {
    const totalInputTokens = this._totalUncachedInputTokens + this._totalCacheReadTokens;
    const cacheHitPercent =
      totalInputTokens > 0 ? (this._totalCacheReadTokens / totalInputTokens) * 100 : null;

    return {
      totalInputTokens,
      totalUncachedInputTokens: this._totalUncachedInputTokens,
      totalCacheReadTokens: this._totalCacheReadTokens,
      totalOutputTokens: this._totalOutputTokens,
      cacheHitPercent,
      responseCount: this._responseCount,
      currentTps: this._currentTps,
      isStreamingTps: this._isStreamingTps,
    };
  }

  /**
   * Mark the beginning of a streaming assistant turn.
   */
  beginStreamTurn(): void {
    const now = this._now();
    this._streaming = true;
    this._implicitStream = false;
    this._turnStartTime = now;
    this._segmentStartTime = now;
    this._toolWaitPausedAt = null;
    this._accumulatedToolWaitMs = 0;
    this._turnStartOutputTokens = this._totalOutputTokens;
    this._turnEstimatedTokens = 0;
    this._samples = [];
    this._pendingCalibration = null;
    this._isStreamingTps = false;
  }

  /**
   * Pause active generation timing while tool calls are executing so tool wait
   * latency neither drags down turn TPS nor distorts the sliding window.
   */
  pauseForTools(): void {
    if (!this._streaming) return;
    if (this._toolWaitPausedAt === null) {
      this._toolWaitPausedAt = this._now();
    }
    this._samples = [];
  }

  /**
   * Resume active generation timing once all in-flight tools finish (or new
   * model output arrives).
   */
  resumeAfterTools(): void {
    if (!this._streaming || this._toolWaitPausedAt === null) return;
    const now = this._now();
    this._accumulatedToolWaitMs += Math.max(0, now - this._toolWaitPausedAt);
    this._toolWaitPausedAt = null;
    this._segmentStartTime = now;
    this._samples = [];
  }

  /**
   * Feed an incoming streamed text/thought delta into the 3-second sliding window
   * token estimator and update live TPS.
   */
  recordStreamText(deltaText: string): SessionMetricsSnapshot {
    if (!deltaText) return this.getSnapshot();

    const now = this._now();
    if (!this._streaming) {
      this._streaming = true;
      this._implicitStream = true;
      this._turnStartTime = now;
      this._segmentStartTime = now;
      this._toolWaitPausedAt = null;
      this._accumulatedToolWaitMs = 0;
      this._turnStartOutputTokens = this._totalOutputTokens;
      this._turnEstimatedTokens = 0;
      this._samples = [];
      this._pendingCalibration = null;
    } else if (this._toolWaitPausedAt !== null) {
      this.resumeAfterTools();
    }

    const estTokens = estimateTextTokens(deltaText);
    if (estTokens <= 0) return this.getSnapshot();

    this._turnEstimatedTokens += estTokens;
    this._samples.push({ ts: now, tokens: estTokens });

    // Prune samples older than the 3-second sliding window
    const cutoff = now - TPS_WINDOW_MS;
    let firstValidIdx = 0;
    while (firstValidIdx < this._samples.length && this._samples[firstValidIdx]!.ts < cutoff) {
      firstValidIdx += 1;
    }
    if (firstValidIdx > 0) {
      this._samples.splice(0, firstValidIdx);
    }

    const startTime = this._segmentStartTime ?? this._turnStartTime ?? now;
    const windowStart = Math.max(startTime, cutoff);
    const elapsedMs = now - windowStart;
    const minDurationMs = this._implicitStream
      ? MIN_IMPLICIT_STREAM_DURATION_MS
      : MIN_STREAM_DURATION_MS;

    if (elapsedMs >= minDurationMs) {
      let windowTokens = 0;
      for (const s of this._samples) {
        windowTokens += s.tokens;
      }
      if (windowTokens > 0) {
        const candidateTps = windowTokens / (elapsedMs / 1000);
        const isShortBurstSpike =
          elapsedMs < BURST_GUARD_WINDOW_MS && candidateTps > BURST_GUARD_MAX_TPS;
        if (
          !isShortBurstSpike &&
          Number.isFinite(candidateTps) &&
          candidateTps > 0 &&
          candidateTps <= MAX_REASONABLE_TPS
        ) {
          this._currentTps = candidateTps;
          this._isStreamingTps = true;
        }
      }
    }

    return this.getSnapshot();
  }

  /**
   * Mark the end of a streaming assistant turn. Marks TPS as idle (non-streaming)
   * and either applies authoritative single-turn `outputTokens` directly or arms
   * one-shot post-turn calibration from `transcript.jsonl`.
   */
  endStreamTurn(options?: EndStreamTurnOptions): SessionMetricsSnapshot {
    if (!this._streaming) {
      this._isStreamingTps = false;
      return this.getSnapshot();
    }

    const now = this._now();
    if (this._toolWaitPausedAt !== null) {
      this._accumulatedToolWaitMs += Math.max(0, now - this._toolWaitPausedAt);
      this._toolWaitPausedAt = null;
    }

    const startTime = this._turnStartTime ?? now;
    const totalElapsedMs = Math.max(0, now - startTime);
    const activeGenMs = Math.max(0, totalElapsedMs - this._accumulatedToolWaitMs);
    const durationMs = activeGenMs >= MIN_STREAM_DURATION_MS ? activeGenMs : totalElapsedMs;

    this._streaming = false;
    this._implicitStream = false;
    this._isStreamingTps = false;

    const authOut = options?.authoritativeOutputTokens;
    const hasAuthoritativeOut =
      typeof authOut === 'number' && Number.isFinite(authOut) && authOut > 0;

    if (durationMs >= MIN_STREAM_DURATION_MS) {
      if (hasAuthoritativeOut) {
        const authTps = authOut / (durationMs / 1000);
        if (Number.isFinite(authTps) && authTps > 0 && authTps <= MAX_REASONABLE_TPS) {
          this._currentTps = authTps;
        }
        // Authoritative per-turn outputTokens already applied; do not arm transcript delta calibration
        this._pendingCalibration = null;
      } else {
        const deltaAlreadySynced = this._totalOutputTokens - this._turnStartOutputTokens;
        if (deltaAlreadySynced > 0) {
          const syncedTps = deltaAlreadySynced / (durationMs / 1000);
          if (Number.isFinite(syncedTps) && syncedTps > 0 && syncedTps <= MAX_REASONABLE_TPS) {
            this._currentTps = syncedTps;
          }
        } else if (this._currentTps === null && this._turnEstimatedTokens > 0) {
          const estTps = this._turnEstimatedTokens / (durationMs / 1000);
          if (Number.isFinite(estTps) && estTps > 0 && estTps <= MAX_REASONABLE_TPS) {
            this._currentTps = estTps;
          }
        }

        this._pendingCalibration = {
          durationMs,
          baselineOutputTokens: this._turnStartOutputTokens,
          endedAt: now,
        };
      }
    } else {
      this._pendingCalibration = null;
    }

    this._turnStartTime = null;
    this._segmentStartTime = null;
    this._accumulatedToolWaitMs = 0;
    this._samples = [];
    return this.getSnapshot();
  }

  /**
   * Incrementally read newly appended bytes from the bound `transcript.jsonl`
   * using byte offsets and `stat(size, mtimeMs)`. Serialized internally to prevent
   * concurrent reads from double-counting bytes.
   */
  syncFromTranscript(): Promise<SessionMetricsSnapshot> {
    const next = this._syncChain.then(() => this.syncFromTranscriptInternal());
    // Keep chain healthy even if a caller inspects an error (internal never throws)
    this._syncChain = next.catch(() => this.getSnapshot());
    return next;
  }

  private async syncFromTranscriptInternal(): Promise<SessionMetricsSnapshot> {
    const filePath = this._transcriptPath;
    if (!filePath) {
      return this.getSnapshot();
    }

    // Expire stale post-turn calibration window before reading
    if (
      this._pendingCalibration !== null &&
      this._now() - this._pendingCalibration.endedAt > CALIBRATION_EXPIRY_MS
    ) {
      this._pendingCalibration = null;
    }

    let st: { size: number; mtimeMs: number };
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) return this.getSnapshot();
      st = { size: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return this.getSnapshot();
    }

    // Fast path: unchanged size and mtime
    if (st.size === this._byteOffset && this._lastMtimeMs === st.mtimeMs) {
      return this.getSnapshot();
    }

    // Handle file truncation or replacement: reset offset & cumulative counters and re-read from 0
    if (st.size < this._byteOffset) {
      this._byteOffset = 0;
      this._lastMtimeMs = null;
      this._pendingBytes = Buffer.alloc(0);
      this._totalUncachedInputTokens = 0;
      this._totalCacheReadTokens = 0;
      this._totalOutputTokens = 0;
      this._responseCount = 0;
      this._explicitUserInputCount = 0;
      this._lastExplicitUserInputWasCompact = false;
      this._turnToolCallsSinceUserInput = 0;
      this._turnAssistantResponsesSinceUserInput = 0;
      this._checkpointSeq = 0;
      this._latestCheckpoint = null;
      this._bgTaskSeq = 0;
      this._transcriptBgTasks.clear();
      this._pendingPlannerDaemons = [];
      this._bgBaselineMaxStepIndex = null;
      this._hasTranscriptData = false;
      this._activityStepSeq = 0;
      this._latestTurnActivity = null;
      this._pendingCalibration = null;
    }

    // Capture path & session identity in case `setSession` / `reset` is invoked while awaiting I/O
    const boundPath = this._transcriptPath;
    const readFromOffset = this._byteOffset;
    const bytesToRead = st.size - readFromOffset;

    if (bytesToRead <= 0) {
      this._lastMtimeMs = st.mtimeMs;
      return this.getSnapshot();
    }

    let newBytes: Buffer;
    try {
      newBytes = await readFileSlice(filePath, readFromOffset, bytesToRead);
    } catch {
      return this.getSnapshot();
    }

    // Abort applying results if session switched/reset during async I/O
    if (this._transcriptPath !== boundPath || this._byteOffset !== readFromOffset) {
      return this.getSnapshot();
    }

    const { hadNonCheckpointOutputDelta, addedResponses } = this.consumeAppendedBytes(
      newBytes,
      readFromOffset === 0,
    );

    this._byteOffset = readFromOffset + newBytes.length;
    this._lastMtimeMs = st.mtimeMs;

    // One-shot post-turn TPS calibration using authoritative output_tokens delta.
    // Guard against polluting calibration with historical multi-response backfills
    // (when reading from byte offset 0 on an existing resumed session) and consume
    // `_pendingCalibration` immediately once applied so subsequent steps never
    // accumulate against a stale short duration.
    if (!this._streaming && this._pendingCalibration !== null) {
      const cal = this._pendingCalibration;
      if (this._now() - cal.endedAt > CALIBRATION_EXPIRY_MS) {
        this._pendingCalibration = null;
      } else if (readFromOffset === 0 && cal.baselineOutputTokens === 0 && addedResponses > 1) {
        this._pendingCalibration = null;
      } else if (hadNonCheckpointOutputDelta) {
        const deltaOutput = this._totalOutputTokens - cal.baselineOutputTokens;
        if (deltaOutput > 0 && cal.durationMs >= MIN_STREAM_DURATION_MS) {
          const calibratedTps = deltaOutput / (cal.durationMs / 1000);
          if (
            Number.isFinite(calibratedTps) &&
            calibratedTps > 0 &&
            calibratedTps <= MAX_REASONABLE_TPS
          ) {
            this._currentTps = calibratedTps;
            this._isStreamingTps = false;
          }
        }
        this._pendingCalibration = null;
      }
    }

    return this.getSnapshot();
  }

  private consumeAppendedBytes(
    chunk: Buffer,
    isStartOfFile: boolean,
  ): { readonly hadNonCheckpointOutputDelta: boolean; readonly addedResponses: number } {
    if (chunk.length === 0) {
      return { hadNonCheckpointOutputDelta: false, addedResponses: 0 };
    }

    const combined =
      this._pendingBytes.length > 0 ? Buffer.concat([this._pendingBytes, chunk]) : chunk;

    const lastNewlineIdx = combined.lastIndexOf(0x0a);
    if (lastNewlineIdx === -1) {
      // Incomplete line without newline yet; retain raw bytes to avoid splitting UTF-8 sequences
      this._pendingBytes = Buffer.from(combined);
      return { hadNonCheckpointOutputDelta: false, addedResponses: 0 };
    }

    const completeSlice = combined.subarray(0, lastNewlineIdx + 1);
    const tailSlice = combined.subarray(lastNewlineIdx + 1);
    this._pendingBytes = tailSlice.length > 0 ? Buffer.from(tailSlice) : Buffer.alloc(0);

    let text = completeSlice.toString('utf8');
    if (isStartOfFile && text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }

    let sawNonCheckpointOutputDelta = false;
    let addedResponses = 0;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const parsed = parseTranscriptLine(line);
      if (!parsed) continue;
      this._hasTranscriptData = true;
      if (parsed.tokens) {
        this._totalUncachedInputTokens += parsed.tokens.uncachedInputTokens;
        this._totalCacheReadTokens += parsed.tokens.cacheReadTokens;
        this._totalOutputTokens += parsed.tokens.outputTokens;
        this._responseCount += 1;
        addedResponses += 1;
        if (!parsed.tokens.isCheckpoint && parsed.tokens.outputTokens > 0) {
          sawNonCheckpointOutputDelta = true;
        }
      }
      if (parsed.explicitUserInput) {
        this._explicitUserInputCount += 1;
        this._lastExplicitUserInputWasCompact = parsed.explicitUserInput.isCompactCommand;
        this._turnToolCallsSinceUserInput = 0;
        this._turnAssistantResponsesSinceUserInput = 0;
      }
      if (parsed.isToolStep) {
        this._turnToolCallsSinceUserInput += 1;
      }
      if (parsed.isAssistantResponseStep) {
        this._turnAssistantResponsesSinceUserInput += 1;
      }
      if (parsed.checkpoint) {
        const stepIndex = parsed.checkpoint.stepIndex ?? ++this._checkpointSeq;
        if (parsed.checkpoint.stepIndex !== undefined) {
          this._checkpointSeq = Math.max(this._checkpointSeq, stepIndex);
        }
        this._latestCheckpoint = {
          stepIndex,
          userInputsBefore: this._explicitUserInputCount,
          precededByCompactCommand: this._lastExplicitUserInputWasCompact,
          toolCallsBeforeInTurn: this._turnToolCallsSinceUserInput,
          assistantResponsesBeforeInTurn: this._turnAssistantResponsesSinceUserInput,
          summaryText: parsed.checkpoint.summaryText,
          ...(parsed.checkpoint.createdAt !== undefined
            ? { createdAt: parsed.checkpoint.createdAt }
            : {}),
          ...(parsed.checkpoint.tokensBefore !== undefined
            ? { tokensBefore: parsed.checkpoint.tokensBefore }
            : {}),
          ...(parsed.checkpoint.summaryTokens !== undefined
            ? { summaryTokens: parsed.checkpoint.summaryTokens }
            : {}),
        };
      }
      if (parsed.plannerDaemonToolCalls && parsed.plannerDaemonToolCalls.length > 0) {
        this._pendingPlannerDaemons = [...parsed.plannerDaemonToolCalls];
      }
      if (parsed.backgroundTaskStarted) {
        const started = parsed.backgroundTaskStarted;
        const stepIndex = started.stepIndex ?? ++this._bgTaskSeq;
        if (started.stepIndex !== undefined) {
          this._bgTaskSeq = Math.max(this._bgTaskSeq, stepIndex);
        }
        let matchedDaemonIdx = -1;
        const normDesc = started.description
          ? started.description.replace(/\s+/g, ' ').trim().toLowerCase()
          : '';
        if (normDesc) {
          matchedDaemonIdx = this._pendingPlannerDaemons.findIndex((entry) => {
            if (started.scheduleKind !== undefined && entry.toolName !== 'schedule') {
              return false;
            }
            return entry.hints.some((h) => {
              const nh = h.replace(/\s+/g, ' ').trim().toLowerCase();
              return nh.length > 0 && (nh === normDesc || normDesc.includes(nh) || nh.includes(normDesc));
            });
          });
        }
        if (matchedDaemonIdx === -1 && this._pendingPlannerDaemons.length === 1) {
          const sole = this._pendingPlannerDaemons[0]!;
          const compatibleTool =
            started.scheduleKind !== undefined ? sole.toolName === 'schedule' : sole.toolName === 'run_command';
          const withinStepWindow =
            sole.stepIndex === undefined ||
            started.stepIndex === undefined ||
            (started.stepIndex >= sole.stepIndex && started.stepIndex - sole.stepIndex <= 8);
          if (compatibleTool && withinStepWindow) {
            matchedDaemonIdx = 0;
          }
        }
        const matchedDaemon = matchedDaemonIdx >= 0;
        if (matchedDaemon) {
          this._pendingPlannerDaemons.splice(matchedDaemonIdx, 1);
        }

        const existing = this._transcriptBgTasks.get(started.taskId);
        // Never resurrect a task already observed in terminal state
        if (!existing || existing.status === 'running') {
          const scheduleKind = started.scheduleKind ?? existing?.scheduleKind;
          const isDaemon = matchedDaemon || existing?.isDaemon;
          this._transcriptBgTasks.set(started.taskId, {
            taskId: started.taskId,
            stepIndex,
            ...(started.description !== undefined
              ? { description: started.description }
              : existing?.description !== undefined
                ? { description: existing.description }
                : {}),
            ...(started.logPath !== undefined
              ? { logPath: started.logPath }
              : existing?.logPath !== undefined
                ? { logPath: existing.logPath }
                : {}),
            ...(scheduleKind !== undefined ? { scheduleKind } : {}),
            ...(isDaemon ? { isDaemon: true } : {}),
            ...(started.startedAt !== undefined
              ? { startedAt: started.startedAt }
              : existing?.startedAt !== undefined
                ? { startedAt: existing.startedAt }
                : {}),
            status: 'running',
          });
        }
      }
      if (parsed.backgroundTasksListed) {
        const listedIds = new Set<string>();
        for (const item of parsed.backgroundTasksListed.tasks) {
          listedIds.add(item.taskId);
          if (item.isDaemon) {
            const existing = this._transcriptBgTasks.get(item.taskId);
            if (existing && existing.status === 'running' && !existing.isDaemon) {
              this._transcriptBgTasks.set(item.taskId, {
                ...existing,
                isDaemon: true,
              });
            }
          }
        }
        const listEndedAt = parsed.backgroundTasksListed.endedAt;
        for (const [taskId, rec] of this._transcriptBgTasks.entries()) {
          if (rec.status !== 'running' || listedIds.has(taskId)) continue;
          const nextEndedAt = listEndedAt ?? rec.endedAt;
          this._transcriptBgTasks.set(taskId, {
            ...rec,
            status: 'completed',
            ...(nextEndedAt !== undefined ? { endedAt: nextEndedAt } : {}),
          });
        }
      }
      if (parsed.backgroundTaskTerminals) {
        for (const term of parsed.backgroundTaskTerminals) {
          const existing = this._transcriptBgTasks.get(term.taskId);
          if (existing) {
            this._transcriptBgTasks.set(term.taskId, {
              ...existing,
              status: term.status,
              ...(term.endedAt !== undefined
                ? { endedAt: term.endedAt }
                : existing.endedAt !== undefined
                  ? { endedAt: existing.endedAt }
                  : {}),
            });
          } else {
            const stepIndex = ++this._bgTaskSeq;
            this._transcriptBgTasks.set(term.taskId, {
              taskId: term.taskId,
              stepIndex,
              status: term.status,
              ...(term.endedAt !== undefined ? { endedAt: term.endedAt } : {}),
            });
          }
        }
      }
      if (parsed.backgroundTaskMessageSenders) {
        for (const msg of parsed.backgroundTaskMessageSenders) {
          const existing = this._transcriptBgTasks.get(msg.taskId);
          if (!existing || existing.status !== 'running' || existing.scheduleKind !== 'timer') {
            continue;
          }
          this._transcriptBgTasks.set(msg.taskId, {
            ...existing,
            status: 'completed',
            ...(msg.endedAt !== undefined
              ? { endedAt: msg.endedAt }
              : existing.endedAt !== undefined
                ? { endedAt: existing.endedAt }
                : {}),
          });
        }
      }
      if (parsed.backgroundTasksNoneRunning) {
        const sweepEndedAt = parsed.backgroundTasksNoneRunning.endedAt;
        for (const [taskId, rec] of this._transcriptBgTasks.entries()) {
          if (rec.status !== 'running') continue;
          const nextEndedAt = sweepEndedAt ?? rec.endedAt;
          this._transcriptBgTasks.set(taskId, {
            ...rec,
            status: 'completed',
            ...(nextEndedAt !== undefined ? { endedAt: nextEndedAt } : {}),
          });
        }
      }
      if (parsed.backgroundTasksResetAll) {
        const resetEndedAt = parsed.backgroundTasksResetAll.endedAt;
        for (const [taskId, rec] of this._transcriptBgTasks.entries()) {
          if (rec.status !== 'running') continue;
          const nextEndedAt = resetEndedAt ?? rec.endedAt;
          this._transcriptBgTasks.set(taskId, {
            ...rec,
            status: 'cancelled',
            ...(nextEndedAt !== undefined ? { endedAt: nextEndedAt } : {}),
          });
        }
      }
      if (parsed.stepActivity) {
        this._activityStepSeq += 1;
        this._latestTurnActivity = {
          latestStepSeq: this._activityStepSeq,
          latestKind: parsed.stepActivity.kind,
          ...(parsed.backgroundTasksResetAll ? { resetAll: true } : {}),
        };
      }
    }

    return { hadNonCheckpointOutputDelta: sawNonCheckpointOutputDelta, addedResponses };
  }
}

async function readFileSlice(filePath: string, offset: number, length: number): Promise<Buffer> {
  const fh = await fs.open(filePath, 'r');
  try {
    const out = Buffer.allocUnsafe(length);
    let totalRead = 0;
    while (totalRead < length) {
      const toRead = Math.min(READ_CHUNK_BYTES, length - totalRead);
      const res = await fh.read(out, totalRead, toRead, offset + totalRead);
      if (res.bytesRead <= 0) break;
      totalRead += res.bytesRead;
    }
    return totalRead === length ? out : out.subarray(0, totalRead);
  } finally {
    await fh.close();
  }
}

const MAX_MODEL_SCAN_BYTES = 512 * 1024;

/**
 * Scan the tail of local `agy` `transcript.jsonl` from newest to oldest and
 * return deduplicated candidate model IDs recorded on transcript entries.
 */
export async function readTranscriptModelCandidates(
  sessionId: string,
  opts?: TranscriptPathOptions,
): Promise<string[]> {
  const trimmedId = sessionId.trim();
  if (!trimmedId) return [];

  const filePath = getTranscriptPath(trimmedId, opts);
  let size: number;
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile() || st.size <= 0) return [];
    size = st.size;
  } catch {
    return [];
  }

  const startOffset = Math.max(0, size - MAX_MODEL_SCAN_BYTES);
  const length = size - startOffset;
  let buf: Buffer;
  try {
    buf = await readFileSlice(filePath, startOffset, length);
  } catch {
    return [];
  }

  let text = buf.toString('utf8');
  if (startOffset === 0 && text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  if (startOffset > 0) {
    const firstNl = text.indexOf('\n');
    if (firstNl === -1) return [];
    text = text.slice(firstNl + 1);
  }

  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line || !line.includes('"model"')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(raw)) continue;
    const model = typeof raw['model'] === 'string' ? raw['model'].trim() : '';
    if (model && !seen.has(model)) {
      seen.add(model);
      candidates.push(model);
    }
  }
  return candidates;
}
