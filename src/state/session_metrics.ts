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
  readonly summaryText: string;
  readonly createdAt?: string;
  readonly tokensBefore?: number;
  readonly summaryTokens?: number;
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

  if (!tokens && !explicitUserInput && !checkpoint) {
    return null;
  }

  return {
    tokens,
    ...(explicitUserInput ? { explicitUserInput } : {}),
    ...(checkpoint ? { checkpoint } : {}),
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
  private _checkpointSeq = 0;
  private _latestCheckpoint: TranscriptCompactionCheckpoint | null = null;

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
    this._checkpointSeq = 0;
    this._latestCheckpoint = null;

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

  getLatestCheckpoint(): TranscriptCompactionCheckpoint | null {
    return this._latestCheckpoint;
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
      this._checkpointSeq = 0;
      this._latestCheckpoint = null;
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
