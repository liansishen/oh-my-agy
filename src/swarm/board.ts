/**
 * Native Swarm Board data loader & lightweight file watcher for `oma`.
 *
 * Reads the real `agy` local swarm directory layout:
 *   `<brainDir>/<sessionId>/.system_generated/swarm/`
 *     - `swarm.json`:   `{ version, backend, swarm_id, created_at }`
 *     - `members.json`: `{ title, members: Record<name, RawSwarmMember> }`
 *     - `board.jsonl`:  NDJSON lines `{ seq, agent, text, time, kind?, request_id? }`
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export type SwarmMemberStatus = 'working' | 'waiting' | 'stopped' | 'killed';

export type SwarmMessageBadgeTone =
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'accent'
  | 'muted';

export interface SwarmMessageBadge {
  /** Normalized lowercase tag identifier, e.g. `done`, `stall`, `quota`, `blocked`. */
  readonly tag: string;
  /** Display label for UI badges. */
  readonly label: string;
  /** Semantic tone hint for TSP badge rendering. */
  readonly tone: SwarmMessageBadgeTone;
}

export interface SwarmMeta {
  readonly version: number;
  readonly backend: string;
  readonly swarmId: string;
  readonly createdAt: string;
}

export interface SwarmMember {
  readonly name: string;
  readonly conversationId?: string;
  readonly role: 'coordinator' | 'worker' | string;
  /** Normalized UI status derived from `killed`, `phase`, `desired_state`, and `wake_mode`. */
  readonly status: SwarmMemberStatus;
  readonly killed: boolean;
  /** Effective model name (`applied_model ?? model ?? desired_model`). */
  readonly model?: string;
  readonly desiredModel?: string;
  readonly appliedModel?: string;
  readonly workspaceMode?: string;
  readonly phase?: string;
  readonly desiredState?: string;
  readonly wakeMode?: string;
  readonly waitSince?: number;
  readonly lastReadSeq?: number;
  readonly lastNudgedSeq?: number;
  readonly lastParkBlockedSeq?: number;
  /** Number of messages posted by this member in `board.jsonl`. */
  readonly messageCount: number;
  /** Highest `seq` posted by this member, if any. */
  readonly lastMessageSeq?: number;
  /** Timestamp of the latest message posted by this member, if any. */
  readonly lastMessageTime?: string;
}

export interface SwarmBoardMessage {
  readonly seq: number;
  readonly agent: string;
  readonly text: string;
  /** Raw timestamp string recorded in `board.jsonl` (e.g. `"2026-11-20 23:22:55"`). */
  readonly time: string;
  readonly kind?: string;
  readonly requestId?: string;
  /** Semantic status badges extracted from the message body (e.g. `[done]`, `[stall]`). */
  readonly badges: readonly SwarmMessageBadge[];
  /** Unique `@mention` targets found in the message body (without leading `@`). */
  readonly mentions: readonly string[];
  /** Compact single-line summary for list rows. */
  readonly summary: string;
}

export interface SwarmBoardCounts {
  readonly totalMembers: number;
  readonly activeMembers: number;
  readonly workingMembers: number;
  readonly waitingMembers: number;
  readonly stoppedMembers: number;
  readonly killedMembers: number;
  readonly totalMessages: number;
  readonly skippedCorruptLines: number;
}

export interface SwarmPlanGoal {
  readonly title: string;
  readonly line: string;
}

export interface SwarmPlanThread {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly tasks: readonly string[];
}

export interface SwarmPlan {
  readonly goal?: SwarmPlanGoal;
  readonly tasks: Readonly<Record<string, string>>;
  readonly threads: readonly SwarmPlanThread[];
}

export type SwarmOverviewThreadStatus = 'done' | 'working' | 'blocked' | 'waiting';

export interface SwarmOverviewThread {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly tasks: readonly string[];
  readonly status: SwarmOverviewThreadStatus;
  readonly doneCount: number;
  readonly workingCount: number;
  readonly blockedCount: number;
  readonly totalCount: number;
}

export interface SwarmOverviewSummary {
  readonly goalTitle: string;
  readonly goalLine: string;
  readonly totalTasks: number;
  readonly doneCount: number;
  readonly workingCount: number;
  readonly blockedCount: number;
  readonly threads: readonly SwarmOverviewThread[];
}

export interface SwarmBoardSnapshot {
  readonly sessionId: string;
  readonly swarmDir: string;
  readonly title: string;
  readonly meta: SwarmMeta;
  /** Members sorted by coordinator first, then working -> waiting -> stopped -> killed, then name. */
  readonly members: readonly SwarmMember[];
  /** Lookup table by member roster name. */
  readonly memberByName: Readonly<Record<string, SwarmMember>>;
  /** Per-agent message counts (includes any agent appearing in `board.jsonl`). */
  readonly messageCounts: Readonly<Record<string, number>>;
  /** Board messages sorted in ascending `seq` order. */
  readonly messages: readonly SwarmBoardMessage[];
  /** Highest message `seq` present in `board.jsonl` (0 if empty). */
  readonly latestSeq: number;
  readonly counts: SwarmBoardCounts;
  /** Parsed `plan.json` written by the swarm coordinator for the Overview pane, if present. */
  readonly plan?: SwarmPlan | null;
  /** Aggregated real-time Overview (goal, task progress, up to 6 parallel workflow threads). */
  readonly overview?: SwarmOverviewSummary | null;
  /** True when the swarm has at least one non-killed, non-stopped member in `working` status. */
  readonly isSwarmActive: boolean;
  /** Roster names of members currently in `working` status (in sorted member order). */
  readonly workingMembers: readonly string[];
  /** Epoch milliseconds when this snapshot was loaded. */
  readonly loadedAt: number;
}

export interface SwarmPathOptions {
  /** Direct override of the swarm directory (highest precedence). */
  readonly swarmDir?: string;
  /** Override the `brain` root directory (default `~/.gemini/antigravity-cli/brain`). */
  readonly baseBrainDir?: string;
  /** Override the Antigravity CLI app-data dir (maps to `<appDataDir>/brain`). */
  readonly appDataDir?: string;
  /** Override the `.gemini` dir (maps to `<geminiDir>/antigravity-cli/brain`). */
  readonly geminiDir?: string;
}

export interface SwarmWatchOptions extends SwarmPathOptions {
  /** Polling interval in milliseconds. Default: 1000. */
  readonly intervalMs?: number;
  /** When true, immediately loads and invokes `onChange` once on startup. Default: false. */
  readonly emitInitial?: boolean;
  /** Optional error callback if `onChange` or file reading throws unexpectedly. */
  readonly onError?: (err: unknown) => void;
}

export interface SwarmBoardWatcher {
  /**
   * Immediately check the swarm files and reload if changed (or always emit when `forceEmit` is true).
   */
  refreshNow(forceEmit?: boolean): Promise<SwarmBoardSnapshot | null>;
  /** Idempotently stop polling and clear the internal timer. */
  stop(): void;
  /** Whether this watcher has been stopped. */
  readonly stopped: boolean;
}

// ---------------------------------------------------------------------------
// Constants & Raw Schema Helpers
// ---------------------------------------------------------------------------

const SWARM_FILE_NAME = 'swarm.json';
const MEMBERS_FILE_NAME = 'members.json';
const BOARD_FILE_NAME = 'board.jsonl';

const DEFAULT_POLL_INTERVAL_MS = 1000;
const MIN_POLL_INTERVAL_MS = 20;

const KNOWN_BADGE_MAP: Readonly<Record<string, SwarmMessageBadge>> = {
  done: { tag: 'done', label: 'done', tone: 'success' },
  stall: { tag: 'stall', label: 'stall', tone: 'warning' },
  stalled: { tag: 'stall', label: 'stall', tone: 'warning' },
  quota: { tag: 'quota', label: 'quota', tone: 'warning' },
  blocked: { tag: 'blocked', label: 'blocked', tone: 'danger' },
  error: { tag: 'error', label: 'error', tone: 'danger' },
  failed: { tag: 'error', label: 'error', tone: 'danger' },
  warn: { tag: 'warning', label: 'warning', tone: 'warning' },
  warning: { tag: 'warning', label: 'warning', tone: 'warning' },
  review: { tag: 'review', label: 'review', tone: 'accent' },
  wip: { tag: 'wip', label: 'wip', tone: 'info' },
  info: { tag: 'info', label: 'info', tone: 'info' },
};

const STATUS_SORT_ORDER: Readonly<Record<SwarmMemberStatus, number>> = {
  working: 0,
  waiting: 1,
  stopped: 2,
  killed: 3,
};

interface RawSwarmMeta {
  version?: unknown;
  backend?: unknown;
  swarm_id?: unknown;
  created_at?: unknown;
}

interface RawSwarmMember {
  conversation_id?: unknown;
  role?: unknown;
  desired_state?: unknown;
  desired_model?: unknown;
  applied_model?: unknown;
  workspace_mode?: unknown;
  phase?: unknown;
  wake_mode?: unknown;
  wait_since?: unknown;
  last_read_seq?: unknown;
  last_nudged_seq?: unknown;
  last_park_blocked_seq?: unknown;
  killed?: unknown;
  model?: unknown;
  status?: unknown;
}

interface RawMembersFile {
  title?: unknown;
  members?: unknown;
}

interface RawBoardLine {
  seq?: unknown;
  agent?: unknown;
  text?: unknown;
  time?: unknown;
  kind?: unknown;
  request_id?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Strip fenced code blocks and inline code spans so literal examples like `` `[done]` ``
 * in briefs/docs are not mistaken for actual status tags.
 */
function stripCodeSpans(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function truncateUtf16Safe(text: string, maxLen: number): string {
  if (maxLen <= 0) return '';
  if (text.length <= maxLen) return text;
  if (maxLen === 1) return '…';

  let cut = maxLen - 1;
  if (cut > 0 && isHighSurrogate(text.charCodeAt(cut - 1))) {
    cut -= 1;
  }
  return `${text.slice(0, cut).trimEnd()}…`;
}

// ---------------------------------------------------------------------------
// Path Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the local `agy` swarm directory for a given session ID.
 *
 * Default layout:
 *   `<homedir>/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/swarm`
 */
export function getSwarmDir(sessionId: string, opts?: SwarmPathOptions): string {
  if (opts?.swarmDir) {
    return path.resolve(opts.swarmDir);
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

  return path.join(baseBrainDir, sessionId, '.system_generated', 'swarm');
}

// ---------------------------------------------------------------------------
// Message Text Helpers
// ---------------------------------------------------------------------------

/**
 * Extract recognized semantic status badges (`[done]`, `[stall]`, `[quota]`, `[blocked]`, etc.)
 * from a swarm board message, ignoring tags inside inline/fenced code spans and markdown links.
 */
export function extractMessageBadges(text: string): SwarmMessageBadge[] {
  if (!text) return [];
  const cleaned = stripCodeSpans(text);
  const pattern = /\[([a-zA-Z][a-zA-Z0-9_-]{1,20})\](?!\()/g;
  const found: SwarmMessageBadge[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    const rawTag = match[1]?.toLowerCase();
    if (!rawTag) continue;
    const badge = KNOWN_BADGE_MAP[rawTag];
    if (!badge) continue;
    if (seen.has(badge.tag)) continue;
    seen.add(badge.tag);
    found.push(badge);
  }

  return found;
}

/**
 * Extract unique `@mention` targets from a message (excluding code spans and email addresses).
 */
export function extractMessageMentions(text: string): string[] {
  if (!text) return [];
  const cleaned = stripCodeSpans(text);
  const pattern = /(?:^|[\s([{"'`:;,])@([a-zA-Z0-9][a-zA-Z0-9_-]{0,31})/g;
  const mentions: string[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    const target = match[1];
    if (!target) continue;
    const key = target.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    mentions.push(target);
  }

  return mentions;
}

/**
 * Produce a clean, UTF-16 surrogate-safe single-line summary for a board message.
 */
export function summarizeMessageLine(text: string, maxLen = 100): string {
  if (!text || maxLen <= 0) return '';

  const nonEmptyLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (nonEmptyLines.length === 0) return '';

  let first = nonEmptyLines[0]!;
  // If the first line is solely `@mention` tokens, append the second line for context.
  if (
    nonEmptyLines.length > 1 &&
    /^(?:@[a-zA-Z0-9_-]+\s*)+$/.test(first)
  ) {
    first = `${first} ${nonEmptyLines[1]!}`;
  }

  const normalized = first
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return truncateUtf16Safe(normalized, maxLen);
}

// ---------------------------------------------------------------------------
// Member Status & Sorting
// ---------------------------------------------------------------------------

export function deriveMemberStatus(raw: RawSwarmMember): SwarmMemberStatus {
  const phase = asNonEmptyString(raw.phase)?.toUpperCase();
  const desired = asNonEmptyString(raw.desired_state)?.toUpperCase();
  const wake = asNonEmptyString(raw.wake_mode)?.toLowerCase();

  if (raw.killed === true || phase === 'KILLED' || desired === 'KILLED') {
    return 'killed';
  }
  if (phase === 'STOPPED' || desired === 'STOPPED') {
    return 'stopped';
  }
  if (
    wake === 'mentions' ||
    wake === 'anything' ||
    wake === 'all' ||
    wake === 'any' ||
    wake === 'waiting' ||
    wake === 'idle' ||
    wake === 'parked'
  ) {
    return 'waiting';
  }
  if (phase === 'RUNNING' || desired === 'RUNNING' || wake === 'working') {
    return 'working';
  }

  // Fallback for explicit status strings if encountered in synthetic/future schemas
  const direct = asNonEmptyString(raw.status)?.toLowerCase();
  if (direct === 'working' || direct === 'waiting' || direct === 'stopped' || direct === 'killed') {
    return direct;
  }

  return 'stopped';
}

function compareMembers(a: SwarmMember, b: SwarmMember): number {
  const aCoord = a.role === 'coordinator' || a.name === 'coordinator' ? 0 : 1;
  const bCoord = b.role === 'coordinator' || b.name === 'coordinator' ? 0 : 1;
  if (aCoord !== bCoord) return aCoord - bCoord;

  const aOrder = STATUS_SORT_ORDER[a.status];
  const bOrder = STATUS_SORT_ORDER[b.status];
  if (aOrder !== bOrder) return aOrder - bOrder;

  return a.name.localeCompare(b.name);
}

// ---------------------------------------------------------------------------
// File Parsing & Loading
// ---------------------------------------------------------------------------

async function readOptionalUtf8(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    return null;
  }
}

function parseJsonObject<T extends Record<string, unknown>>(text: string | null): T | null {
  if (text === null) return null;
  const cleaned = stripBom(text).trim();
  if (cleaned.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(cleaned);
    return isPlainObject(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

function parseBoardJsonl(rawText: string | null): {
  messages: SwarmBoardMessage[];
  skippedCorruptLines: number;
} {
  if (rawText === null) {
    return { messages: [], skippedCorruptLines: 0 };
  }

  const lines = stripBom(rawText).split(/\r?\n/);
  const parsedEntries: Array<{ msg: SwarmBoardMessage; lineIndex: number }> = [];
  let skippedCorruptLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    if (line.length === 0) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      skippedCorruptLines += 1;
      continue;
    }

    if (!isPlainObject(raw)) {
      skippedCorruptLines += 1;
      continue;
    }

    const obj = raw as RawBoardLine;
    const seq = asFiniteNumber(obj.seq);
    const agent = asNonEmptyString(obj.agent);
    const text = typeof obj.text === 'string' ? obj.text : undefined;

    if (seq === undefined || agent === undefined || text === undefined) {
      skippedCorruptLines += 1;
      continue;
    }

    const time = typeof obj.time === 'string' ? obj.time : '';
    const kind = asNonEmptyString(obj.kind);
    const requestId = asNonEmptyString(obj.request_id);

    parsedEntries.push({
      lineIndex: i,
      msg: {
        seq,
        agent,
        text,
        time,
        ...(kind !== undefined ? { kind } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
        badges: extractMessageBadges(text),
        mentions: extractMessageMentions(text),
        summary: summarizeMessageLine(text),
      },
    });
  }

  parsedEntries.sort((a, b) => {
    if (a.msg.seq !== b.msg.seq) return a.msg.seq - b.msg.seq;
    return a.lineIndex - b.lineIndex;
  });

  return {
    messages: parsedEntries.map((e) => e.msg),
    skippedCorruptLines,
  };
}

/**
 * Load a complete `SwarmBoardSnapshot` for `sessionId`.
 *
 * Returns `null` when the session has no swarm directory or lacks both valid
 * `swarm.json` and `members.json` metadata files.
 */
export async function loadSwarmBoard(
  sessionId: string,
  opts?: SwarmPathOptions,
): Promise<SwarmBoardSnapshot | null> {
  if (!opts?.swarmDir && sessionId.trim().length === 0) {
    return null;
  }

  const swarmDir = getSwarmDir(sessionId, opts);

  try {
    const dirStat = await fs.stat(swarmDir);
    if (!dirStat.isDirectory()) return null;
  } catch {
    return null;
  }

  const [swarmText, membersText, boardText, planText] = await Promise.all([
    readOptionalUtf8(path.join(swarmDir, SWARM_FILE_NAME)),
    readOptionalUtf8(path.join(swarmDir, MEMBERS_FILE_NAME)),
    readOptionalUtf8(path.join(swarmDir, BOARD_FILE_NAME)),
    readOptionalUtf8(path.join(swarmDir, 'plan.json')),
  ]);

  const rawSwarm = parseJsonObject<RawSwarmMeta & Record<string, unknown>>(swarmText);
  const rawMembersFile = parseJsonObject<RawMembersFile & Record<string, unknown>>(membersText);

  // If neither core metadata file is present and valid, treat as no active swarm.
  if (rawSwarm === null && rawMembersFile === null) {
    return null;
  }

  const meta: SwarmMeta = {
    version: asFiniteNumber(rawSwarm?.version) ?? 1,
    backend: asNonEmptyString(rawSwarm?.backend) ?? 'local',
    swarmId: asNonEmptyString(rawSwarm?.swarm_id) ?? sessionId,
    createdAt: typeof rawSwarm?.created_at === 'string' ? rawSwarm.created_at : '',
  };

  const title = typeof rawMembersFile?.title === 'string' ? rawMembersFile.title.trim() : '';

  const { messages, skippedCorruptLines } = parseBoardJsonl(boardText);

  // Per-agent message statistics
  const messageCounts: Record<string, number> = {};
  const lastSeqByAgent: Record<string, number> = {};
  const lastTimeByAgent: Record<string, string> = {};
  let latestSeq = 0;

  for (const msg of messages) {
    messageCounts[msg.agent] = (messageCounts[msg.agent] ?? 0) + 1;
    if (msg.seq >= (lastSeqByAgent[msg.agent] ?? -Infinity)) {
      lastSeqByAgent[msg.agent] = msg.seq;
      if (msg.time) {
        lastTimeByAgent[msg.agent] = msg.time;
      }
    }
    if (msg.seq > latestSeq) {
      latestSeq = msg.seq;
    }
  }

  // Parse members map
  const membersList: SwarmMember[] = [];
  const rawMembersObj = isPlainObject(rawMembersFile?.members)
    ? rawMembersFile.members
    : {};

  for (const [name, entry] of Object.entries(rawMembersObj)) {
    if (!isPlainObject(entry)) continue;
    const raw = entry as RawSwarmMember;

    const status = deriveMemberStatus(raw);
    const desiredModel = asNonEmptyString(raw.desired_model);
    const appliedModel = asNonEmptyString(raw.applied_model);
    const explicitModel = asNonEmptyString(raw.model);
    const effectiveModel = appliedModel ?? explicitModel ?? desiredModel;

    const conversationId = asNonEmptyString(raw.conversation_id);
    const role = asNonEmptyString(raw.role) ?? (name === 'coordinator' ? 'coordinator' : 'worker');
    const workspaceMode = asNonEmptyString(raw.workspace_mode);
    const phase = asNonEmptyString(raw.phase);
    const desiredState = asNonEmptyString(raw.desired_state);
    const wakeMode = asNonEmptyString(raw.wake_mode);
    const waitSince = asFiniteNumber(raw.wait_since);
    const lastReadSeq = asFiniteNumber(raw.last_read_seq);
    const lastNudgedSeq = asFiniteNumber(raw.last_nudged_seq);
    const lastParkBlockedSeq = asFiniteNumber(raw.last_park_blocked_seq);
    const lastMessageSeq = lastSeqByAgent[name];
    const lastMessageTime = lastTimeByAgent[name];

    membersList.push({
      name,
      ...(conversationId !== undefined ? { conversationId } : {}),
      role,
      status,
      killed: status === 'killed',
      ...(effectiveModel !== undefined ? { model: effectiveModel } : {}),
      ...(desiredModel !== undefined ? { desiredModel } : {}),
      ...(appliedModel !== undefined ? { appliedModel } : {}),
      ...(workspaceMode !== undefined ? { workspaceMode } : {}),
      ...(phase !== undefined ? { phase } : {}),
      ...(desiredState !== undefined ? { desiredState } : {}),
      ...(wakeMode !== undefined ? { wakeMode } : {}),
      ...(waitSince !== undefined ? { waitSince } : {}),
      ...(lastReadSeq !== undefined ? { lastReadSeq } : {}),
      ...(lastNudgedSeq !== undefined ? { lastNudgedSeq } : {}),
      ...(lastParkBlockedSeq !== undefined ? { lastParkBlockedSeq } : {}),
      messageCount: messageCounts[name] ?? 0,
      ...(lastMessageSeq !== undefined ? { lastMessageSeq } : {}),
      ...(lastMessageTime !== undefined ? { lastMessageTime } : {}),
    });
  }

  membersList.sort(compareMembers);

  const memberByName: Record<string, SwarmMember> = {};
  const workingMemberNames: string[] = [];
  let workingMembers = 0;
  let waitingMembers = 0;
  let stoppedMembers = 0;
  let killedMembers = 0;

  for (const m of membersList) {
    memberByName[m.name] = m;
    switch (m.status) {
      case 'working':
        workingMembers += 1;
        workingMemberNames.push(m.name);
        break;
      case 'waiting':
        waitingMembers += 1;
        break;
      case 'stopped':
        stoppedMembers += 1;
        break;
      case 'killed':
        killedMembers += 1;
        break;
    }
  }

  const counts: SwarmBoardCounts = {
    totalMembers: membersList.length,
    activeMembers: workingMembers + waitingMembers,
    workingMembers,
    waitingMembers,
    stoppedMembers,
    killedMembers,
    totalMessages: messages.length,
    skippedCorruptLines,
  };

  // A swarm is considered actively running when at least one non-coordinator worker
  // is in `working` status (so normal chat turns with the coordinator alone after all
  // workers have parked/retired do not trigger active swarm flight animations).
  const isSwarmActive = membersList.some(
    (m) => m.status === 'working' && m.role !== 'coordinator' && m.name !== 'coordinator',
  );

  const plan = parseSwarmPlan(planText);
  const overview = buildSwarmOverview(plan, title, membersList, memberByName, messages);

  return {
    sessionId,
    swarmDir,
    title,
    meta,
    members: membersList,
    memberByName,
    messageCounts,
    messages,
    latestSeq,
    counts,
    ...(plan ? { plan } : {}),
    ...(overview ? { overview } : {}),
    isSwarmActive,
    workingMembers: workingMemberNames,
    loadedAt: Date.now(),
  };
}

function parseSwarmPlan(planText: string | null): SwarmPlan | null {
  const raw = parseJsonObject<Record<string, unknown>>(planText);
  if (!raw) return null;

  let goal: SwarmPlanGoal | undefined;
  if (isPlainObject(raw['goal'])) {
    const gTitle = typeof raw['goal']['title'] === 'string' ? raw['goal']['title'].trim() : '';
    const gLine = typeof raw['goal']['line'] === 'string' ? raw['goal']['line'].trim() : '';
    if (gTitle || gLine) {
      goal = { title: gTitle, line: gLine };
    }
  }

  const tasks: Record<string, string> = {};
  if (isPlainObject(raw['tasks'])) {
    for (const [k, v] of Object.entries(raw['tasks'])) {
      if (typeof v === 'string' && v.trim().length > 0) {
        tasks[k] = v.trim();
      }
    }
  }

  const threads: SwarmPlanThread[] = [];
  if (Array.isArray(raw['threads'])) {
    for (let idx = 0; idx < raw['threads'].length && threads.length < 6; idx++) {
      const entry = raw['threads'][idx];
      if (!isPlainObject(entry)) continue;
      const id =
        typeof entry['id'] === 'string' && entry['id'].trim().length > 0
          ? entry['id'].trim()
          : `thread-${idx + 1}`;
      const title =
        typeof entry['title'] === 'string' && entry['title'].trim().length > 0
          ? entry['title'].trim()
          : id;
      const tGoal = typeof entry['goal'] === 'string' ? entry['goal'].trim() : '';
      const tTasks = Array.isArray(entry['tasks'])
        ? entry['tasks'].filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        : [];
      threads.push({ id, title, goal: tGoal, tasks: tTasks });
    }
  }

  if (!goal && Object.keys(tasks).length === 0 && threads.length === 0) {
    return null;
  }
  return { ...(goal ? { goal } : {}), tasks, threads };
}

function deriveWorkerOverviewState(
  workerName: string,
  memberByName: Readonly<Record<string, SwarmMember>>,
  latestBadgeByAgent: ReadonlyMap<string, string>,
): SwarmOverviewThreadStatus {
  const member = memberByName[workerName];
  const latestBadge = latestBadgeByAgent.get(workerName);
  if (latestBadge === 'blocked' || latestBadge === 'stall' || latestBadge === 'quota') {
    return 'blocked';
  }
  if (latestBadge === 'done') {
    return 'done';
  }
  if (member?.status === 'working') {
    return 'working';
  }
  if (member?.killed) {
    return 'done';
  }
  return 'waiting';
}

function buildSwarmOverview(
  plan: SwarmPlan | null,
  fallbackTitle: string,
  members: readonly SwarmMember[],
  memberByName: Readonly<Record<string, SwarmMember>>,
  messages: readonly SwarmBoardMessage[],
): SwarmOverviewSummary | null {
  if (!plan) return null;

  // Track latest status badge posted by each agent (messages are sorted ascending by seq)
  const latestBadgeByAgent = new Map<string, string>();
  for (const msg of messages) {
    for (const badge of msg.badges) {
      if (
        badge.tag === 'done' ||
        badge.tag === 'blocked' ||
        badge.tag === 'stall' ||
        badge.tag === 'quota'
      ) {
        latestBadgeByAgent.set(msg.agent, badge.tag);
      }
    }
  }

  const allTaskWorkers = new Set<string>();
  for (const name of Object.keys(plan.tasks)) {
    allTaskWorkers.add(name);
  }
  for (const th of plan.threads) {
    for (const w of th.tasks) {
      allTaskWorkers.add(w);
    }
  }
  if (allTaskWorkers.size === 0) {
    for (const m of members) {
      if (m.role !== 'coordinator' && m.name !== 'coordinator') {
        allTaskWorkers.add(m.name);
      }
    }
  }

  let doneCount = 0;
  let workingCount = 0;
  let blockedCount = 0;
  for (const w of allTaskWorkers) {
    const st = deriveWorkerOverviewState(w, memberByName, latestBadgeByAgent);
    if (st === 'done') doneCount += 1;
    else if (st === 'blocked') blockedCount += 1;
    else if (st === 'working') workingCount += 1;
  }

  const threads: SwarmOverviewThread[] = plan.threads.slice(0, 6).map((th) => {
    let tDone = 0;
    let tWorking = 0;
    let tBlocked = 0;
    for (const w of th.tasks) {
      const st = deriveWorkerOverviewState(w, memberByName, latestBadgeByAgent);
      if (st === 'done') tDone += 1;
      else if (st === 'blocked') tBlocked += 1;
      else if (st === 'working') tWorking += 1;
    }
    const total = th.tasks.length;
    const status: SwarmOverviewThreadStatus =
      tBlocked > 0
        ? 'blocked'
        : tWorking > 0
          ? 'working'
          : total > 0 && tDone === total
            ? 'done'
            : 'waiting';
    return {
      id: th.id,
      title: th.title,
      goal: th.goal,
      tasks: th.tasks,
      status,
      doneCount: tDone,
      workingCount: tWorking,
      blockedCount: tBlocked,
      totalCount: total,
    };
  });

  return {
    goalTitle: plan.goal?.title || fallbackTitle || 'Swarm Overview',
    goalLine: plan.goal?.line || '',
    totalTasks: allTaskWorkers.size,
    doneCount,
    workingCount,
    blockedCount,
    threads,
  };
}

// ---------------------------------------------------------------------------
// Lightweight Polling Watcher
// ---------------------------------------------------------------------------

async function statTokenAsync(filePath: string): Promise<string> {
  try {
    const st = await fs.stat(filePath);
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

function statTokenSync(filePath: string): string {
  try {
    const st = fsSync.statSync(filePath);
    return `${st.mtimeMs}:${st.ctimeMs}:${st.size}`;
  } catch {
    return 'missing';
  }
}

async function computeFingerprintAsync(swarmDir: string): Promise<string> {
  // Single cheap stat when the swarm directory does not exist yet (e.g. before `/swarm` spawns).
  try {
    const dirStat = await fs.stat(swarmDir);
    if (!dirStat.isDirectory()) return 'dir-missing';
  } catch {
    return 'dir-missing';
  }

  const [a, b, c, d] = await Promise.all([
    statTokenAsync(path.join(swarmDir, SWARM_FILE_NAME)),
    statTokenAsync(path.join(swarmDir, MEMBERS_FILE_NAME)),
    statTokenAsync(path.join(swarmDir, BOARD_FILE_NAME)),
    statTokenAsync(path.join(swarmDir, 'plan.json')),
  ]);
  return `${a}|${b}|${c}|${d}`;
}

function computeFingerprintSync(swarmDir: string): string {
  try {
    const dirStat = fsSync.statSync(swarmDir);
    if (!dirStat.isDirectory()) return 'dir-missing';
  } catch {
    return 'dir-missing';
  }

  const a = statTokenSync(path.join(swarmDir, SWARM_FILE_NAME));
  const b = statTokenSync(path.join(swarmDir, MEMBERS_FILE_NAME));
  const c = statTokenSync(path.join(swarmDir, BOARD_FILE_NAME));
  const d = statTokenSync(path.join(swarmDir, 'plan.json'));
  return `${a}|${b}|${c}|${d}`;
}

export interface SwarmWatchChangeMeta {
  /** True on the initial baseline check emitted when the watcher first mounts. */
  readonly isInitial: boolean;
  /** True when swarm files on disk changed after the watcher's initial baseline check. */
  readonly changed: boolean;
}

/**
 * Watch a session's swarm directory via lightweight stat polling (`mtimeMs + ctimeMs + size`
 * across `swarm.json`, `members.json`, and `board.jsonl`). When the directory has not been
 * created yet, performs a single `stat(swarmDir)` probe per interval so creation is detected
 * immediately as soon as `/swarm` or the `swarm` tool writes metadata.
 */
export function watchSwarmBoard(
  sessionId: string,
  onChange: (snapshot: SwarmBoardSnapshot | null, meta: SwarmWatchChangeMeta) => void,
  opts?: SwarmWatchOptions,
): SwarmBoardWatcher {
  const swarmDir = getSwarmDir(sessionId, opts);
  const rawInterval = opts?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const intervalMs = Math.max(
    MIN_POLL_INTERVAL_MS,
    Number.isFinite(rawInterval) ? Math.floor(rawInterval) : DEFAULT_POLL_INTERVAL_MS,
  );
  const emitInitial = opts?.emitInitial ?? false;

  let isStopped = false;
  let inFlight = false;
  let initialChecked = !emitInitial;
  let lastSnapshot: SwarmBoardSnapshot | null = null;
  let lastFingerprint: string | null = emitInitial ? null : computeFingerprintSync(swarmDir);
  let timer: ReturnType<typeof setInterval> | null = null;

  const checkOnce = async (forceEmit: boolean): Promise<SwarmBoardSnapshot | null> => {
    if (isStopped) return lastSnapshot;
    if (inFlight && !forceEmit) return lastSnapshot;

    inFlight = true;
    try {
      const nextFingerprint = await computeFingerprintAsync(swarmDir);
      if (isStopped) return lastSnapshot;

      const isInitial = !initialChecked;
      initialChecked = true;
      const prevFingerprint = lastFingerprint;

      if (!forceEmit && nextFingerprint === prevFingerprint) {
        return lastSnapshot;
      }

      const prevSnapshot = lastSnapshot;
      const snapshot =
        nextFingerprint === 'dir-missing' ? null : await loadSwarmBoard(sessionId, opts);
      if (isStopped) return lastSnapshot;

      // If files exist on disk yet failed to parse (e.g. mid-write race), retry on next tick
      // instead of locking in a stale fingerprint while still avoiding spurious duplicate null emits.
      const hasAnyCoreFile =
        nextFingerprint !== 'dir-missing' && nextFingerprint !== 'missing|missing|missing';
      if (snapshot === null && hasAnyCoreFile) {
        lastFingerprint = null;
      } else {
        lastFingerprint = nextFingerprint;
      }

      lastSnapshot = snapshot;
      const changed = !isInitial && nextFingerprint !== prevFingerprint;
      if (forceEmit || snapshot !== null || prevSnapshot !== null) {
        try {
          onChange(snapshot, { isInitial, changed });
        } catch (err) {
          opts?.onError?.(err);
        }
      }
      return snapshot;
    } catch (err) {
      opts?.onError?.(err);
      return lastSnapshot;
    } finally {
      inFlight = false;
    }
  };

  timer = setInterval(() => {
    void checkOnce(false);
  }, intervalMs);

  if (emitInitial) {
    void checkOnce(true);
  }

  return {
    async refreshNow(forceEmit = false): Promise<SwarmBoardSnapshot | null> {
      return checkOnce(forceEmit);
    },
    stop(): void {
      if (isStopped) return;
      isStopped = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    get stopped(): boolean {
      return isStopped;
    },
  };
}
