/**
 * Top-level `AppStore` & `AppState`:
 * - Focus state machine (`editor | picker | questions | help | settings | info`)
 * - Interactive `/settings` `<prefs>` side panel state & aside coexistence
 * - Modal `<picker>` state (`/resume`, `/model` + inline thinking slider, `/thought`,
 *   `/mode`, `/log`, `/swarm`, `/mcp`, `/plugins`, `/skills`, `/agents`)
 * - Info overlays (`/status`, `/context`, `/usage`, `/logout` confirmation)
 * - Caret completion popup state (`/` commands with semantic icons, live status values,
 *   `skill:` collapse/expand & 10-row limit; `@` workspace files with folder/file icons)
 * - Pending attachments queue & monotonic toast queue
 * - Context usage (`used` / `size`) & formatting
 * - Authoritative ACP `configOptions` / `model` / `thought_level` / `mode` state
 */

import {
  clampThoughtLevelForChoices,
  extractSessionControlState,
  filterOrchestratorRoleModels,
  isOrchestratorModelId,
  ORCHESTRATOR_PICKER_ID,
  resolveThoughtLevelsForModel,
  type SessionControlState,
} from '../acp/model';
import { normalizeDisplayPath } from '../acp/path';
import type {
  AuthMethod,
  ConfigOption,
  ConfigOptionChoice,
  ElicitationCreateParams,
  ElicitationCreateResult,
  ImplementationInfo,
  JsonRpcId,
  PromptCapabilities,
  SessionModeState,
  SessionModelState,
  SessionUpdate,
  UnknownSessionUpdate,
} from '../acp/protocol';
import type { SettingsPageId } from '../commands/handlers';
import { CommandRegistry, fuzzyMatchText, type SlashCommandDef } from '../commands/registry';
import {
  parseOrchestratorModelSpec,
  type AgyOrchestratorSettings,
} from '../config/agy_settings';
import type { ToolDisplayMode } from '../config/config';
import { DraftEngine, type DraftEngineOptions } from '../editor/draft';
import { InputHistory, type InputHistoryOptions } from '../editor/history';
import {
  applyTriggerReplacement,
  detectCompletionTrigger,
  type CompletionTrigger,
} from '../editor/trigger';
import type { SwarmBoardMessage, SwarmBoardSnapshot } from '../swarm/board';
import { ApprovalQueue } from './approval';
import { areGitStatusEqual, type GitStatusSnapshot } from './git_status';
import {
  getAllVisibleGitFiles,
  gitFileKey,
  type GitDiffViewMode,
  type GitFileDiffResult,
  type GitFocusedField,
  type GitOverlayState,
  type GitOverlayStatusMessage,
  type GitRepoSnapshot,
  type GitSidebarStyle,
} from './git_tui';
import { areSessionMetricsEqual, type SessionMetricsSnapshot } from './session_metrics';
import { TrafficBuffer, type TrafficBufferOptions } from './traffic';
import {
  buildQuestionCardFromElicitation,
  TranscriptStore,
  type ActiveQuestionCard,
  type AttachmentItem,
  type ContextBreakdown,
  type PreviewMessageSummary,
  type TranscriptUpdateOutcome,
} from './transcript';

export type { SettingsPageId };

// ---------------------------------------------------------------------------
// Focus State Machine
// ---------------------------------------------------------------------------

export type FocusMode =
  | 'editor'
  | 'picker'
  | 'swarm'
  | 'git'
  | 'questions'
  | 'help'
  | 'settings'
  | 'info';

export const GIT_SUMMARY_NODE_ID = 'layer.git.app.side.commit.summary.input';
export const GIT_BODY_NODE_ID = 'layer.git.app.side.commit.body';

export interface BeeMemberBlobPair {
  readonly active: string;
  readonly sleep: string;
}

export interface BeeBlobsState {
  readonly hud?: string;
  readonly active?: string;
  readonly sleep?: string;
  readonly byMember?: Readonly<Record<string, BeeMemberBlobPair>>;
}

export const EDITOR_NODE_ID = 'dock.composer.line.input';
export const COMPLETION_LIST_PREFIX = 'layer.complete.select.list.';
export const SETTINGS_NODE_PREFIX = 'layer.settings';

// ---------------------------------------------------------------------------
// Model Provider Inference
// ---------------------------------------------------------------------------

export type ModelProviderId = 'google' | 'anthropic' | 'openai' | 'xai' | 'antigravity';

export interface ModelProviderMeta {
  readonly id: ModelProviderId;
  readonly label: string;
  readonly abbr: string;
  readonly icon: string;
}

export const MODEL_PROVIDER_META: Readonly<Record<ModelProviderId, ModelProviderMeta>> = {
  google: { id: 'google', label: 'Google', abbr: 'GO', icon: 'provider:google' },
  anthropic: { id: 'anthropic', label: 'Anthropic', abbr: 'AN', icon: 'provider:anthropic' },
  openai: { id: 'openai', label: 'OpenAI', abbr: 'OA', icon: 'provider:openai' },
  xai: { id: 'xai', label: 'xAI', abbr: 'XA', icon: 'provider:xai' },
  antigravity: { id: 'antigravity', label: 'Antigravity', abbr: 'AG', icon: 'provider:antigravity' },
};

/**
 * Infer a canonical model provider id from a model identifier for the
 * compact model picker's provider rail & badges.
 */
export function inferModelProvider(modelId: string): ModelProviderId {
  const lower = modelId.trim().toLowerCase();
  if (!lower) return 'antigravity';
  const slashIdx = lower.lastIndexOf('/');
  const prefix = slashIdx > 0 ? lower.slice(0, slashIdx) : '';
  const bare = slashIdx >= 0 ? lower.slice(slashIdx + 1) : lower;

  if (
    prefix === 'google' ||
    bare === 'gemini' ||
    bare.startsWith('gemini-') ||
    bare.startsWith('gemini_')
  ) {
    return 'google';
  }
  if (
    prefix === 'anthropic' ||
    bare === 'claude' ||
    bare.startsWith('claude-') ||
    bare.startsWith('claude_')
  ) {
    return 'anthropic';
  }
  if (
    prefix === 'openai' ||
    bare.startsWith('gpt-') ||
    bare.startsWith('gpt_') ||
    bare === 'o1' ||
    bare.startsWith('o1-') ||
    bare === 'o3' ||
    bare.startsWith('o3-') ||
    bare === 'o4' ||
    bare.startsWith('o4-')
  ) {
    return 'openai';
  }
  if (
    prefix === 'xai' ||
    prefix === 'x-ai' ||
    bare === 'grok' ||
    bare.startsWith('grok-') ||
    bare.startsWith('grok_')
  ) {
    return 'xai';
  }
  return 'antigravity';
}

// ---------------------------------------------------------------------------
// Settings Panel (`<prefs>`), Info Overlay, Ecosystem & Picker Models
// ---------------------------------------------------------------------------

export interface AgySafeSettingsSnapshot {
  readonly toolPermission?: string;
  readonly enableTerminalSandbox?: boolean;
  readonly allowNonWorkspaceAccess?: boolean;
  readonly artifactReviewPolicy?: string;
  readonly useG1Credits?: boolean;
  readonly showThinking?: boolean;
  readonly orchestrator?: AgyOrchestratorSettings;
}

export interface SettingsEditingState {
  readonly row: string;
  readonly draft?: string;
  readonly cursor?: number;
  readonly option?: string;
}

export interface SettingsPanelState {
  page: SettingsPageId;
  query: string;
  cursor: number;
  focus: string | null;
  editing: SettingsEditingState | null;
  agySettings: AgySafeSettingsSnapshot;
  dirtyCount: number;
}

export type InfoOverlayKind = 'status' | 'context' | 'usage' | 'logout_confirm' | 'jobs';

export interface InfoOverlayState {
  readonly kind: InfoOverlayKind;
  readonly configPath?: string;
  readonly agySettingsPath?: string;
  readonly contextBreakdown?: ContextBreakdown;
  readonly message?: string;
  readonly selectedJobId?: string;
}

export interface TierInfo {
  readonly name?: string;
  readonly id?: string;
  readonly upgradeUri?: string;
}

export interface McpServerItem {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport?: string;
  readonly command?: string;
  readonly url?: string;
  readonly status?: string;
  readonly detail?: string;
}

export interface PluginItem {
  readonly name: string;
  readonly enabled: boolean;
  readonly version?: string;
  readonly description?: string;
  readonly source?: string;
  readonly path?: string;
}

export interface SkillItem {
  readonly name: string;
  readonly description: string;
  readonly source: 'workspace' | 'user' | 'plugin' | 'acp';
  readonly path?: string;
  readonly content?: string;
}

export interface AgentItem {
  readonly id: string;
  readonly name: string;
  readonly kind: 'builtin' | 'custom' | 'subagent' | 'swarm';
  readonly description?: string;
  readonly model?: string;
  readonly status?: string;
  readonly path?: string;
}

export type ModalPickerKind =
  | 'resume'
  | 'model'
  | 'planner'
  | 'executor'
  | 'thought'
  | 'mode'
  | 'log'
  | 'swarm'
  | 'mcp'
  | 'plugins'
  | 'skills'
  | 'agents';

export type ResumePickerScope = 'this-folder' | 'all-folders';
export type LogPickerScope = 'all' | 'out' | 'in' | 'stderr' | 'tern-error';

export interface ResumeSessionEntry {
  readonly sessionId: string;
  readonly cwd: string;
  readonly displayCwd: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly model?: string;
  readonly thoughtLevel?: string;
  readonly mode?: string;
  readonly turnCount?: number;
  readonly preview?: readonly PreviewMessageSummary[];
}

export interface PickerModalState {
  readonly kind: ModalPickerKind;
  query: string;
  cursor: number;
  scope: string;
  selectedId: string | null;
  loading: boolean;
  error?: string;
  sessions: ResumeSessionEntry[];
  swarmSnapshot?: SwarmBoardSnapshot | null;
  swarmFollow?: boolean;
  /** Currently selected thought_level on the inline slider inside the compact model picker. */
  modelPickerThinking?: string;
  /** True once the user explicitly adjusts the inline thinking slider inside the model picker. */
  modelPickerThinkingDirty?: boolean;
  mcpServers?: McpServerItem[];
  plugins?: PluginItem[];
  skills?: SkillItem[];
  agents?: AgentItem[];
}

export interface CompletionPopupItem {
  /** Key passed to `<item key={item.key}>`. */
  readonly key: string;
  readonly kind: 'slash' | 'file';
  /** Raw replacement value (command name without '/' or file path without '@'). */
  readonly value: string;
  /** Display label: command name WITHOUT leading '/' (or file path). */
  readonly label: string;
  /** Semantic Tern `IconName` (e.g. `settings`, `model`, `skill`, `folder`, `file`). */
  readonly icon?: string;
  readonly detail?: string;
  /** Dynamic right-hand status string rendered in muted style (e.g. current model, `3 skills`). */
  readonly statusValue?: string;
  /** Absolute path when kind === 'file' and provided by indexer. */
  readonly absPath?: string;
  /** Alias of `statusValue` kept for compatibility with existing views/tests. */
  readonly badge?: string;
  readonly hits?: readonly (readonly [number, number])[];
  readonly autoExecuteOnEnter?: boolean;
  /** True for the collapsed `skill:` expansion row. */
  readonly isSkillGroup?: boolean;
  /** True for directory entries in `@` file completion. */
  readonly isDirectory?: boolean;
}

export interface CompletionPopupState {
  readonly open: boolean;
  readonly trigger: CompletionTrigger | null;
  readonly items: readonly CompletionPopupItem[];
  readonly selectedIndex: number;
  readonly selectedKey: string | null;
  /** Full TSP node ID: `layer.complete.select.list.<key>`. */
  readonly selectedNodeId: string | null;
  readonly dismissedTrigger?: {
    readonly start: number;
    readonly end: number;
    readonly raw: string;
  };
}

export type FileCompletionCandidate =
  | {
      readonly path: string;
      readonly absPath?: string;
      readonly isDirectory?: boolean;
      readonly score?: number;
      readonly hits?: readonly (readonly [number, number])[];
    }
  | {
      readonly file: {
        readonly relPath: string;
        readonly absPath?: string;
        readonly name?: string;
        readonly dir?: string;
        readonly isDirectory?: boolean;
      };
      readonly isDirectory?: boolean;
      readonly score?: number;
      readonly hits?: readonly (readonly [number, number])[];
    };

export type ToastTone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

export interface ToastItem {
  readonly seq: number;
  readonly text: string;
  readonly sub?: string;
  readonly tone: ToastTone;
  readonly ttl?: number;
  readonly createdAt: number;
}

export interface ContextUsageState {
  readonly used: number;
  readonly size: number;
  readonly percent: number;
  readonly cost?: { readonly amount: number; readonly currency: string };
}

export type ConnectionStatus =
  | 'initializing'
  | 'ready'
  | 'auth_required'
  | 'crashed'
  | 'closing';

export interface CrashBannerState {
  readonly message: string;
  readonly stderrTail: string;
  readonly exitCode?: number | null;
}

export interface AuthRequiredState {
  readonly message: string;
  readonly authMethods: readonly AuthMethod[];
}

export interface SessionSnapshotInput {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly title?: string | null;
  readonly configOptions?: ConfigOption[];
  readonly models?: SessionModelState;
  readonly modes?: SessionModeState;
  readonly tier?: TierInfo;
}

export interface AppState {
  readonly connectionStatus: ConnectionStatus;
  readonly isReady: boolean;
  readonly isStreaming: boolean;
  readonly isReplaying: boolean;
  /** True when transcript has any in-flight tool call or detached background task still running. */
  readonly hasActiveBackgroundTasks: boolean;
  /** Latest background-polled swarm board snapshot for the active session, if any. */
  readonly swarmSnapshot: SwarmBoardSnapshot | null;
  /** True once the active session has entered swarm mode (snapshot exists or swarm tool detected). */
  readonly hasSwarm: boolean;
  /** True when at least one non-killed, non-stopped swarm member is currently `working`. */
  readonly isSwarmWorking: boolean;
  /** Roster names of swarm members currently in `working` status. */
  readonly swarmWorkingNames: readonly string[];
  /** Composite activity flag: `isStreaming || hasActiveBackgroundTasks || isSwarmWorking`. */
  readonly isBusy: boolean;
  /** Whether the dedicated native `agy`-style Swarm Board overlay is open. */
  readonly swarmBoardOpen: boolean;
  /** Active member filter inside the Swarm Board overlay (`null` = all members). */
  readonly swarmBoardFilterAgent: string | null;
  /** Search filter query inside the Swarm Board overlay. */
  readonly swarmBoardQuery: string;
  /** Selected post `seq` in the Swarm Board overlay (`null` = auto-select latest visible post). */
  readonly swarmBoardSelectedSeq: number | null;
  /** Whether the Swarm Board auto-follows newly arriving posts. */
  readonly swarmBoardFollow: boolean;
  readonly focusMode: FocusMode;
  readonly desiredSurfaceFocus: string | null;
  readonly sessionId: string | null;
  readonly sessionTitle: string | null;
  readonly cwd: string;
  readonly displayCwd: string;
  readonly agentInfo?: ImplementationInfo;
  readonly agentVersion?: string;
  readonly tier?: TierInfo;
  readonly supportsLogout: boolean;
  readonly activeSwarmCount?: number;
  readonly recentModels: readonly string[];
  readonly hour12: boolean;
  readonly supportsAside: boolean;
  readonly supportsPrefs: boolean;
  readonly welcomeLogoBlobId?: string;
  /** Pixel bee SVG blob IDs for HUD pill, swarm animation, and member cards. */
  readonly beeHudBlobId?: string;
  readonly beeActiveBlobId?: string;
  readonly beeSleepBlobId?: string;
  readonly beeMemberBlobs?: Readonly<Record<string, BeeMemberBlobPair>>;
  readonly showThinking: boolean;
  readonly autoCollapseThought: boolean;
  readonly collapseCompacted: boolean;
  readonly expandAllTools: boolean;
  readonly toolDisplayMode: ToolDisplayMode;
  readonly expandedToolGroups: Readonly<Record<string, boolean>>;
  readonly promptCapabilities: Readonly<PromptCapabilities>;
  readonly configOptions: readonly ConfigOption[];
  readonly models?: SessionModelState;
  readonly modes?: SessionModeState;
  readonly controls: SessionControlState;
  /** Authoritative per-model thought_level options observed from ACP `configOptions` in this session. */
  readonly modelThoughtLevels: Readonly<Record<string, readonly ConfigOptionChoice[]>>;
  /** Persisted `agy` Orchestrator Planner / Executor configuration from `settings.json`. */
  readonly orchestratorSettings: AgyOrchestratorSettings;
  /** Current terminal viewport height in rows (used e.g. for Swarm Overview >= 28-row threshold). */
  readonly terminalRows: number;
  readonly usage: ContextUsageState | null;
  readonly sessionMetrics: SessionMetricsSnapshot | null;
  readonly gitStatus: GitStatusSnapshot | null;
  readonly picker: PickerModalState | null;
  readonly settings: SettingsPanelState | null;
  readonly settingsFocused: boolean;
  readonly infoOverlay: InfoOverlayState | null;
  readonly gitOverlay: GitOverlayState | null;
  readonly helpOpen: boolean;
  readonly activeQuestion: ActiveQuestionCard | null;
  readonly completion: CompletionPopupState;
  readonly pendingAttachments: readonly AttachmentItem[];
  readonly toasts: readonly ToastItem[];
  readonly activeToast: ToastItem | null;
  readonly crashError: CrashBannerState | null;
  readonly authRequired: AuthRequiredState | null;
  readonly ctrlCArmedUntil: number;
}

export interface AppStoreOptions {
  readonly cwd?: string;
  readonly autoAllowTools?: readonly string[];
  readonly autoCollapseThought?: boolean;
  readonly collapseCompacted?: boolean;
  readonly recentModels?: readonly string[];
  readonly hour12?: boolean;
  readonly supportsAside?: boolean;
  readonly supportsPrefs?: boolean;
  readonly welcomeLogoBlobId?: string;
  readonly showThinking?: boolean;
  readonly expandAllTools?: boolean;
  readonly toolDisplayMode?: ToolDisplayMode;
  readonly orchestratorSettings?: AgyOrchestratorSettings;
  readonly terminalRows?: number;
  readonly draft?: DraftEngineOptions;
  readonly history?: InputHistoryOptions;
  readonly traffic?: TrafficBufferOptions;
  readonly now?: () => number;
}

export interface AcceptCompletionResult {
  readonly item: CompletionPopupItem;
  readonly text: string;
  readonly cursor: number;
  readonly autoExecute: boolean;
}

export const MAX_COMPLETION_ITEMS = 10;
const MAX_TOAST_QUEUE = 10;
const MAX_RECENT_MODELS = 12;

const EMPTY_COMPLETION: CompletionPopupState = {
  open: false,
  trigger: null,
  items: [],
  selectedIndex: 0,
  selectedKey: null,
  selectedNodeId: null,
};

export function formatCompactTokens(n: number): string {
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
 * Format context window usage for the bottom `<status>` bar (e.g. `14k / 1M (1.4%)`).
 */
export function formatContextUsage(usage: ContextUsageState | null): string | null {
  if (!usage || usage.size <= 0) return null;
  const pct = usage.percent < 10 ? usage.percent.toFixed(1) : Math.round(usage.percent).toString();
  return `${formatCompactTokens(usage.used)} / ${formatCompactTokens(usage.size)} (${pct}%)`;
}

function sanitizeCompletionKey(raw: string, fallbackIndex: number): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : `item_${fallbackIndex}`;
}

function normalizeRecentModels(models: readonly string[] | undefined, max = MAX_RECENT_MODELS): string[] {
  if (!models || models.length === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of models) {
    const trimmed = raw.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= max) break;
  }
  return out;
}

export class AppStore {
  readonly draft: DraftEngine;
  readonly history: InputHistory;
  readonly transcript: TranscriptStore;
  readonly approvals: ApprovalQueue;
  readonly traffic: TrafficBuffer;
  readonly commands: CommandRegistry;

  private readonly _now: () => number;
  private readonly _listeners = new Set<() => void>();
  private _autoCollapseThought: boolean;
  private _collapseCompacted: boolean;

  private _connectionStatus: ConnectionStatus = 'initializing';
  private _isStreaming = false;
  private _isReplaying = false;
  private _sessionId: string | null = null;
  private _sessionTitle: string | null = null;
  private _cwd: string;
  private _agentInfo: ImplementationInfo | undefined;
  private _agentVersion: string | undefined;
  private _tier: TierInfo | undefined;
  private _supportsLogout = false;
  private _activeSwarmCount: number | undefined;
  private _swarmSnapshot: SwarmBoardSnapshot | null = null;
  private _hasSwarmHint = false;
  private _swarmBoardOpen = false;
  private _swarmBoardFilterAgent: string | null = null;
  private _swarmBoardQuery = '';
  private _swarmBoardSelectedSeq: number | null = null;
  private _swarmBoardFollow = true;
  private _recentModels: string[];
  private _hour12: boolean;
  private _supportsAside: boolean;
  private _supportsPrefs: boolean;
  private _welcomeLogoBlobId: string | undefined;
  private _beeHudBlobId: string | undefined;
  private _beeActiveBlobId: string | undefined;
  private _beeSleepBlobId: string | undefined;
  private _beeMemberBlobs: Readonly<Record<string, BeeMemberBlobPair>> | undefined;
  private _showThinking: boolean;
  private _expandAllTools: boolean;
  private _toolDisplayMode: ToolDisplayMode;
  private _lastVisibleToolDisplayMode: Exclude<ToolDisplayMode, 'hidden'>;
  private _expandedToolGroups: Record<string, boolean> = {};
  private _promptCapabilities: PromptCapabilities = {};

  private _configOptions: ConfigOption[] = [];
  private _models: SessionModelState | undefined;
  private _modes: SessionModeState | undefined;
  private _controls: SessionControlState;
  private _modelThoughtLevels: Record<string, readonly ConfigOptionChoice[]> = {};
  private _orchestratorSettings: AgyOrchestratorSettings;
  private _terminalRows: number;
  private _usage: ContextUsageState | null = null;
  private _sessionMetrics: SessionMetricsSnapshot | null = null;
  private _gitStatus: GitStatusSnapshot | null = null;

  private _picker: PickerModalState | null = null;
  private _settings: SettingsPanelState | null = null;
  private _settingsFocused = false;
  private _infoOverlay: InfoOverlayState | null = null;
  private _gitOverlay: GitOverlayState | null = null;
  private _helpOpen = false;
  private _activeQuestion: ActiveQuestionCard | null = null;
  private _completion: CompletionPopupState = EMPTY_COMPLETION;

  private _pendingAttachments: AttachmentItem[] = [];
  private _toasts: ToastItem[] = [];
  private _toastSeq = 0;

  private _crashError: CrashBannerState | null = null;
  private _authRequired: AuthRequiredState | null = null;
  private _ctrlCArmedUntil = 0;

  constructor(options: AppStoreOptions = {}) {
    this._now = options.now ?? (() => Date.now());
    this._cwd = options.cwd ?? process.cwd();
    this._autoCollapseThought = options.autoCollapseThought ?? true;
    this._collapseCompacted = options.collapseCompacted ?? true;
    this._recentModels = normalizeRecentModels(options.recentModels);
    this._hour12 = options.hour12 ?? false;
    this._supportsAside = options.supportsAside ?? false;
    this._supportsPrefs = options.supportsPrefs ?? true;
    this._welcomeLogoBlobId = options.welcomeLogoBlobId;
    this._showThinking = options.showThinking ?? true;
    this._expandAllTools = options.expandAllTools ?? false;
    this._toolDisplayMode = options.toolDisplayMode ?? 'all';
    this._lastVisibleToolDisplayMode =
      this._toolDisplayMode === 'hidden' ? 'compact' : this._toolDisplayMode;
    this._orchestratorSettings = options.orchestratorSettings ?? {};
    this._terminalRows =
      typeof options.terminalRows === 'number' &&
      Number.isFinite(options.terminalRows) &&
      options.terminalRows > 0
        ? Math.round(options.terminalRows)
        : typeof process.stdout?.rows === 'number' && process.stdout.rows > 0
          ? process.stdout.rows
          : 40;

    this.draft = new DraftEngine({
      now: this._now,
      ...options.draft,
    });
    this.history = new InputHistory(options.history);
    this.transcript = new TranscriptStore({ now: this._now });
    this.approvals = new ApprovalQueue({
      autoAllowTools: options.autoAllowTools,
      now: this._now,
    });
    this.traffic = new TrafficBuffer(options.traffic);
    this.commands = new CommandRegistry();
    this._controls = extractSessionControlState({});
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this._listeners) {
      listener();
    }
  }

  get autoCollapseThought(): boolean {
    return this._autoCollapseThought;
  }

  setAutoCollapseThought(enabled: boolean): void {
    if (this._autoCollapseThought === enabled) return;
    this._autoCollapseThought = enabled;
    this.emit();
  }

  get collapseCompacted(): boolean {
    return this._collapseCompacted;
  }

  setCollapseCompacted(enabled: boolean): void {
    if (this._collapseCompacted === enabled) return;
    this._collapseCompacted = enabled;
    this.emit();
  }

  setOrchestratorSettings(orchestrator: AgyOrchestratorSettings): void {
    const nextPlanner = orchestrator.planner?.trim() || undefined;
    const nextExecutor = orchestrator.executor?.trim() || undefined;
    if (
      this._orchestratorSettings.planner === nextPlanner &&
      this._orchestratorSettings.executor === nextExecutor
    ) {
      return;
    }
    this._orchestratorSettings = {
      ...(nextPlanner ? { planner: nextPlanner } : {}),
      ...(nextExecutor ? { executor: nextExecutor } : {}),
    };
    if (this._settings) {
      this._settings.agySettings = {
        ...this._settings.agySettings,
        orchestrator: this._orchestratorSettings,
      };
    }
    this.emit();
  }

  setTerminalRows(rows: number): void {
    if (!Number.isFinite(rows) || rows <= 0) return;
    const normalized = Math.round(rows);
    if (this._terminalRows === normalized) return;
    this._terminalRows = normalized;
    this.emit();
  }

  setHour12(hour12: boolean): void {
    if (this._hour12 === hour12) return;
    this._hour12 = hour12;
    this.emit();
  }

  setSupportsAside(supportsAside: boolean): void {
    if (this._supportsAside === supportsAside) return;
    this._supportsAside = supportsAside;
    if (!supportsAside && this._settings !== null) {
      this._settingsFocused = true;
    }
    this.emit();
  }

  setSupportsPrefs(supportsPrefs: boolean): void {
    if (this._supportsPrefs === supportsPrefs) return;
    this._supportsPrefs = supportsPrefs;
    if (!supportsPrefs && this._settings !== null) {
      this._settingsFocused = true;
    }
    this.emit();
  }

  setWelcomeLogoBlobId(blobId: string | undefined): void {
    if (this._welcomeLogoBlobId === blobId) return;
    this._welcomeLogoBlobId = blobId;
    this.emit();
  }

  setBeeBlobs(blobs: BeeBlobsState): void {
    if (blobs.hud !== undefined) this._beeHudBlobId = blobs.hud;
    if (blobs.active !== undefined) this._beeActiveBlobId = blobs.active;
    if (blobs.sleep !== undefined) this._beeSleepBlobId = blobs.sleep;
    if (blobs.byMember !== undefined) this._beeMemberBlobs = blobs.byMember;
    this.emit();
  }

  setBeeMemberBlob(name: string, pair: BeeMemberBlobPair): void {
    const existing = this._beeMemberBlobs?.[name];
    if (existing && existing.active === pair.active && existing.sleep === pair.sleep) {
      return;
    }
    this._beeMemberBlobs = {
      ...(this._beeMemberBlobs ?? {}),
      [name]: pair,
    };
    this.emit();
  }

  clearBeeBlobs(): void {
    this._beeHudBlobId = undefined;
    this._beeActiveBlobId = undefined;
    this._beeSleepBlobId = undefined;
    this._beeMemberBlobs = undefined;
    this.emit();
  }

  setShowThinking(show: boolean): void {
    if (this._showThinking === show) return;
    this._showThinking = show;
    this.emit();
  }

  toggleShowThinking(): boolean {
    this._showThinking = !this._showThinking;
    this.emit();
    return this._showThinking;
  }

  setExpandAllTools(expand: boolean): void {
    if (this._expandAllTools === expand) return;
    this._expandAllTools = expand;
    this.transcript.setAllToolsCollapsed(!expand);
    this.emit();
  }

  toggleExpandAllTools(): boolean {
    const next = !this._expandAllTools;
    this._expandAllTools = next;
    this.transcript.setAllToolsCollapsed(!next);
    this.emit();
    return next;
  }

  setToolDisplayMode(mode: ToolDisplayMode): void {
    if (this._toolDisplayMode === mode) return;
    if (mode !== 'hidden') {
      this._lastVisibleToolDisplayMode = mode;
    }
    this._toolDisplayMode = mode;
    this.emit();
  }

  cycleToolDisplayMode(): ToolDisplayMode {
    const order: readonly ToolDisplayMode[] = ['all', 'compact', 'hidden'];
    const idx = order.indexOf(this._toolDisplayMode);
    const next = order[(idx + 1) % order.length] ?? 'all';
    if (next !== 'hidden') {
      this._lastVisibleToolDisplayMode = next;
    }
    this._toolDisplayMode = next;
    this.emit();
    return next;
  }

  /**
   * Toggle tool activity visibility (`Ctrl+Shift+O`, aligned with `omp` `app.tools.toggleVisibility`):
   * flips between `'hidden'` and the last non-hidden display mode (`'all'` or `'compact'`).
   */
  toggleToolVisibility(): ToolDisplayMode {
    const next: ToolDisplayMode =
      this._toolDisplayMode === 'hidden' ? this._lastVisibleToolDisplayMode : 'hidden';
    this._toolDisplayMode = next;
    this.emit();
    return next;
  }

  toggleToolGroup(groupId: string, expanded?: boolean): boolean {
    const hasExplicit = Object.prototype.hasOwnProperty.call(this._expandedToolGroups, groupId);
    const cur = hasExplicit ? Boolean(this._expandedToolGroups[groupId]) : this._expandAllTools;
    const next = expanded !== undefined ? expanded : !cur;
    if (hasExplicit && cur === next) return next;
    this._expandedToolGroups = {
      ...this._expandedToolGroups,
      [groupId]: next,
    };
    this.emit();
    return next;
  }

  clearExpandedToolGroups(): void {
    if (Object.keys(this._expandedToolGroups).length === 0) return;
    this._expandedToolGroups = {};
    this.emit();
  }

  setTier(tier: TierInfo | undefined): void {
    this._tier = tier;
    this.emit();
  }

  setAgentVersion(version: string | undefined): void {
    this._agentVersion = version;
    this.emit();
  }

  setSupportsLogout(supported: boolean): void {
    if (this._supportsLogout === supported) return;
    this._supportsLogout = supported;
    this.emit();
  }

  setActiveSwarmCount(count: number | undefined): void {
    if (this._activeSwarmCount === count) return;
    this._activeSwarmCount = count;
    this.emit();
  }

  setHasSwarm(hasSwarm: boolean): void {
    if (this._hasSwarmHint === hasSwarm) return;
    this._hasSwarmHint = hasSwarm;
    this.emit();
  }

  hasActiveBackgroundTasks(): boolean {
    return this.transcript.hasActiveBackgroundTasks();
  }

  get hasSwarm(): boolean {
    return this._swarmSnapshot !== null || this._hasSwarmHint;
  }

  get isSwarmWorking(): boolean {
    return Boolean(this._swarmSnapshot?.isSwarmActive);
  }

  get swarmWorkingNames(): readonly string[] {
    return this._swarmSnapshot?.workingMembers ?? [];
  }

  get isBusy(): boolean {
    return this._isStreaming || this.hasActiveBackgroundTasks() || this.isSwarmWorking;
  }

  setRecentModels(models: readonly string[]): void {
    this._recentModels = normalizeRecentModels(models);
    this.emit();
  }

  recordRecentModel(modelId: string, max = MAX_RECENT_MODELS): readonly string[] {
    const trimmed = modelId.trim();
    if (!trimmed) return this._recentModels;
    this._recentModels = normalizeRecentModels([trimmed, ...this._recentModels], max);
    this.emit();
    return this._recentModels;
  }

  /**
   * Compute current logical focus mode:
   * priority: `picker` > `swarm` > `info` > `help` > `settings` (when modal or focused aside) > `questions` > `editor`.
   */
  getFocusMode(): FocusMode {
    if (this._picker !== null) return 'picker';
    if (this._swarmBoardOpen) return 'swarm';
    if (this._gitOverlay !== null) return 'git';
    if (this._infoOverlay !== null) return 'info';
    if (this._helpOpen) return 'help';
    if (this._settings !== null && (!this._supportsAside || this._settingsFocused)) {
      return 'settings';
    }
    if (this._activeQuestion !== null) return 'questions';
    return 'editor';
  }

  /**
   * Compute the target node ID for `surface.focus(...)` (DESIGN.md 4.3.2):
   * - `EDITOR_NODE_ID` (`'dock.composer.line.input'`) when editor owns focus
   * - `GIT_SUMMARY_NODE_ID` / `GIT_BODY_NODE_ID` when editing the commit form inside `/git`
   * - `null` while any modal overlay (`picker` / `swarm` / `git` / `info` / `help`) or focused `settings` owns focus
   * - `'<qId>.other'` input node id when focusing a `<questions>` Other input, else `null`
   */
  getDesiredSurfaceFocus(questionNodePrefix = 'main.questions'): string | null {
    const mode = this.getFocusMode();
    if (mode === 'editor') return EDITOR_NODE_ID;
    if (mode === 'git') {
      if (this._gitOverlay?.focusedField === 'summary') return GIT_SUMMARY_NODE_ID;
      if (this._gitOverlay?.focusedField === 'description') return GIT_BODY_NODE_ID;
      return null;
    }
    if (
      mode === 'picker' ||
      mode === 'swarm' ||
      mode === 'help' ||
      mode === 'info' ||
      mode === 'settings'
    ) {
      return null;
    }
    if (mode === 'questions' && this._activeQuestion?.focusedOtherId) {
      return `${questionNodePrefix}.${this._activeQuestion.focusedOtherId}.other`;
    }
    return null;
  }

  /**
   * Handle a Tern `FocusEvent` (user clicked an editable field or aside panel).
   * Ignored while a blocking modal overlay (`picker` / `swarm` / `info` / `help`) is active.
   * When `/settings` is docked as an aside (`supportsAside === true`), allows
   * seamlessly switching focus between the right-side `<prefs>` and the Composer.
   */
  handleSurfaceFocusEvent(nodeId: string): string | null {
    const mode = this.getFocusMode();
    if (mode === 'git') {
      if (nodeId === GIT_SUMMARY_NODE_ID) {
        this.setGitFocusedField('summary');
        return GIT_SUMMARY_NODE_ID;
      }
      if (nodeId === GIT_BODY_NODE_ID) {
        this.setGitFocusedField('description');
        return GIT_BODY_NODE_ID;
      }
      return null;
    }
    if (mode === 'picker' || mode === 'swarm' || mode === 'help' || mode === 'info') {
      return null;
    }

    if (this._settings !== null) {
      if (!this._supportsAside) {
        return null;
      }
      if (nodeId === SETTINGS_NODE_PREFIX || nodeId.startsWith(`${SETTINGS_NODE_PREFIX}.`)) {
        if (!this._settingsFocused) {
          this._settingsFocused = true;
          this.emit();
        }
        return null;
      }
      if (nodeId === EDITOR_NODE_ID) {
        if (this._settingsFocused) {
          this._settingsFocused = false;
          this.emit();
        }
        return EDITOR_NODE_ID;
      }
    }

    if (this._activeQuestion) {
      const otherMatch = /\.([^.]+)\.other$/.exec(nodeId);
      if (otherMatch && otherMatch[1]) {
        const qId = otherMatch[1];
        if (this._activeQuestion.items.some((i) => i.id === qId)) {
          this._activeQuestion.focusedOtherId = qId;
          this.emit();
          return nodeId;
        }
      }
      if (nodeId === EDITOR_NODE_ID) {
        this._activeQuestion.focusedOtherId = null;
        this.emit();
        return EDITOR_NODE_ID;
      }
    }

    return nodeId;
  }

  getState(): AppState {
    const focusMode = this.getFocusMode();
    const activeToast = this._toasts[this._toasts.length - 1] ?? null;
    const effectiveAgentVersion = this._agentVersion ?? this._agentInfo?.version;
    const hasActiveBackgroundTasks = this.transcript.hasActiveBackgroundTasks();
    const hasSwarm = this._swarmSnapshot !== null || this._hasSwarmHint;
    const isSwarmWorking = Boolean(this._swarmSnapshot?.isSwarmActive);
    const swarmWorkingNames = this._swarmSnapshot?.workingMembers ?? [];
    const isBusy = this._isStreaming || hasActiveBackgroundTasks || isSwarmWorking;
    return {
      connectionStatus: this._connectionStatus,
      isReady: this._connectionStatus === 'ready',
      isStreaming: this._isStreaming,
      isReplaying: this._isReplaying,
      hasActiveBackgroundTasks,
      swarmSnapshot: this._swarmSnapshot,
      hasSwarm,
      isSwarmWorking,
      swarmWorkingNames,
      isBusy,
      swarmBoardOpen: this._swarmBoardOpen,
      swarmBoardFilterAgent: this._swarmBoardFilterAgent,
      swarmBoardQuery: this._swarmBoardQuery,
      swarmBoardSelectedSeq: this._swarmBoardSelectedSeq,
      swarmBoardFollow: this._swarmBoardFollow,
      focusMode,
      desiredSurfaceFocus: this.getDesiredSurfaceFocus(),
      sessionId: this._sessionId,
      sessionTitle: this._sessionTitle,
      cwd: this._cwd,
      displayCwd: normalizeDisplayPath(this._cwd),
      ...(this._agentInfo ? { agentInfo: this._agentInfo } : {}),
      ...(effectiveAgentVersion ? { agentVersion: effectiveAgentVersion } : {}),
      ...(this._tier ? { tier: this._tier } : {}),
      supportsLogout: this._supportsLogout,
      ...(this._activeSwarmCount !== undefined ? { activeSwarmCount: this._activeSwarmCount } : {}),
      recentModels: this._recentModels,
      hour12: this._hour12,
      supportsAside: this._supportsAside,
      supportsPrefs: this._supportsPrefs,
      ...(this._welcomeLogoBlobId ? { welcomeLogoBlobId: this._welcomeLogoBlobId } : {}),
      ...(this._beeHudBlobId ? { beeHudBlobId: this._beeHudBlobId } : {}),
      ...(this._beeActiveBlobId ? { beeActiveBlobId: this._beeActiveBlobId } : {}),
      ...(this._beeSleepBlobId ? { beeSleepBlobId: this._beeSleepBlobId } : {}),
      ...(this._beeMemberBlobs ? { beeMemberBlobs: this._beeMemberBlobs } : {}),
      showThinking: this._showThinking,
      autoCollapseThought: this._autoCollapseThought,
      collapseCompacted: this._collapseCompacted,
      expandAllTools: this._expandAllTools,
      toolDisplayMode: this._toolDisplayMode,
      expandedToolGroups: this._expandedToolGroups,
      promptCapabilities: this._promptCapabilities,
      configOptions: this._configOptions,
      ...(this._models ? { models: this._models } : {}),
      ...(this._modes ? { modes: this._modes } : {}),
      controls: this._controls,
      modelThoughtLevels: this._modelThoughtLevels,
      orchestratorSettings: this._orchestratorSettings,
      terminalRows: this._terminalRows,
      usage: this._usage,
      sessionMetrics: this._sessionMetrics,
      gitStatus: this._gitStatus,
      picker: this._picker,
      settings: this._settings,
      settingsFocused: this._settingsFocused,
      infoOverlay: this._infoOverlay,
      gitOverlay: this._gitOverlay,
      helpOpen: this._helpOpen,
      activeQuestion: this._activeQuestion,
      completion: this._completion,
      pendingAttachments: this._pendingAttachments,
      toasts: this._toasts,
      activeToast,
      crashError: this._crashError,
      authRequired: this._authRequired,
      ctrlCArmedUntil: this._ctrlCArmedUntil,
    };
  }

  // -------------------------------------------------------------------------
  // Connection, Session & ACP Control State
  // -------------------------------------------------------------------------

  setConnectionStatus(status: ConnectionStatus): void {
    this._connectionStatus = status;
    if (status === 'ready') {
      this._crashError = null;
      this._authRequired = null;
    }
    this.emit();
  }

  setAgentInitializeInfo(
    info?: ImplementationInfo,
    promptCapabilities?: PromptCapabilities,
    options?: { readonly supportsLogout?: boolean },
  ): void {
    this._agentInfo = info;
    if (info?.version) {
      this._agentVersion = info.version;
    }
    this._promptCapabilities = promptCapabilities ?? {};
    if (options?.supportsLogout !== undefined) {
      this._supportsLogout = options.supportsLogout;
    }
    this.emit();
  }

  setStreaming(streaming: boolean): void {
    this._isStreaming = streaming;
    this.emit();
  }

  setReplaying(replaying: boolean): void {
    this._isReplaying = replaying;
    this.emit();
  }

  setCwd(cwd: string): void {
    this._cwd = cwd;
    this.emit();
  }

  setCrashError(err: CrashBannerState | null): void {
    this._crashError = err;
    if (err) {
      this._connectionStatus = 'crashed';
      this._isStreaming = false;
    }
    this.emit();
  }

  setAuthRequired(auth: AuthRequiredState | null): void {
    this._authRequired = auth;
    if (auth) {
      this._connectionStatus = 'auth_required';
      this._isStreaming = false;
    }
    this.emit();
  }

  armCtrlCExit(windowMs = 2000): number {
    this._ctrlCArmedUntil = this._now() + windowMs;
    this.emit();
    return this._ctrlCArmedUntil;
  }

  isCtrlCExitArmed(): boolean {
    return this._ctrlCArmedUntil > 0 && this._now() <= this._ctrlCArmedUntil;
  }

  clearCtrlCArm(): void {
    if (this._ctrlCArmedUntil !== 0) {
      this._ctrlCArmedUntil = 0;
      this.emit();
    }
  }

  applySessionSnapshot(snapshot: SessionSnapshotInput): void {
    this._sessionId = snapshot.sessionId;
    if (snapshot.cwd !== undefined) {
      this._cwd = snapshot.cwd;
    }
    if (snapshot.title !== undefined) {
      this._sessionTitle = snapshot.title;
    }
    if (snapshot.configOptions !== undefined) {
      this._configOptions = [...snapshot.configOptions];
    }
    if (snapshot.models !== undefined) {
      this._models = snapshot.models;
    }
    if (snapshot.modes !== undefined) {
      this._modes = snapshot.modes;
    }
    if (snapshot.tier !== undefined) {
      this._tier = snapshot.tier;
    }
    this.recomputeControls();
    this.emit();
  }

  updateConfigOptions(configOptions: readonly ConfigOption[]): void {
    this._configOptions = [...configOptions];
    this.recomputeControls();
    this.emit();
  }

  updateCurrentModelId(modelId: string): void {
    if (this._models) {
      this._models = { ...this._models, currentModelId: modelId };
    }
    this._configOptions = this._configOptions.map((opt) =>
      opt.id === 'model' || opt.category === 'model'
        ? { ...opt, currentValue: modelId }
        : opt,
    );
    this.recomputeControls();
    this.emit();
  }

  updateCurrentModeId(modeId: string): void {
    if (this._modes) {
      this._modes = { ...this._modes, currentModeId: modeId };
    }
    this._configOptions = this._configOptions.map((opt) =>
      opt.id === 'mode' || opt.category === 'mode'
        ? { ...opt, currentValue: modeId }
        : opt,
    );
    this.recomputeControls();
    this.emit();
  }

  updateUsage(used: number, size: number, cost?: { amount: number; currency: string }): void {
    const safeUsed = Math.max(0, used);
    const safeSize = Math.max(0, size);
    const percent = safeSize > 0 ? Math.min(100, (safeUsed / safeSize) * 100) : 0;
    this._usage = {
      used: safeUsed,
      size: safeSize,
      percent,
      ...(cost ? { cost } : {}),
    };
    this.emit();
  }

  setSessionMetrics(metrics: SessionMetricsSnapshot | null): void {
    if (areSessionMetricsEqual(this._sessionMetrics, metrics)) return;
    this._sessionMetrics = metrics ? { ...metrics } : null;
    this.emit();
  }

  setGitStatus(status: GitStatusSnapshot | null): void {
    if (areGitStatusEqual(this._gitStatus, status)) return;
    this._gitStatus = status ? { ...status } : null;
    this.emit();
  }

  /**
   * Apply an incoming ACP `session/update` across transcript, commands, usage,
   * configOptions, mode, and session info.
   */
  applySessionUpdate(update: SessionUpdate | UnknownSessionUpdate): TranscriptUpdateOutcome {
    const outcome = this.transcript.applySessionUpdate(update, {
      autoCollapseThought: this._autoCollapseThought,
      isReplaying: this._isReplaying,
      showThinking: this._showThinking,
      expandAllTools: this._expandAllTools,
    });

    if (outcome.availableCommands) {
      this.commands.setAcpCommands(outcome.availableCommands);
    }
    if (outcome.usage) {
      this.updateUsage(outcome.usage.used, outcome.usage.size, outcome.usage.cost);
    }
    if (outcome.currentModeId) {
      this.updateCurrentModeId(outcome.currentModeId);
    }
    if (outcome.configOptions) {
      this.updateConfigOptions(outcome.configOptions);
    }
    if (outcome.sessionInfo && outcome.sessionInfo.title !== undefined) {
      this._sessionTitle = outcome.sessionInfo.title;
    }

    // Automatically enter swarm mode hint if a `swarm` tool call is observed in live stream
    if (
      !this._isReplaying &&
      (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
    ) {
      const uName =
        typeof (update as { name?: unknown }).name === 'string'
          ? (update as { name: string }).name.toLowerCase()
          : '';
      const uTitle =
        typeof (update as { title?: unknown }).title === 'string'
          ? (update as { title: string }).title.trim().toLowerCase()
          : '';
      if (uName === 'swarm' || uTitle === 'swarm' || uTitle.startsWith('swarm ')) {
        this._hasSwarmHint = true;
      }
    }

    this.emit();
    return outcome;
  }

  /**
   * Reset session-scoped state for `/new` or switching to another session.
   */
  resetSessionState(options: { keepCommands?: boolean } = {}): void {
    this._sessionId = null;
    this.approvals.cancelAll();
    this.cancelActiveQuestion();
    this.transcript.clear();
    this._usage = null;
    this._sessionMetrics = null;
    this._sessionTitle = null;
    this._isStreaming = false;
    this._pendingAttachments = [];
    this._completion = EMPTY_COMPLETION;
    this._swarmSnapshot = null;
    this._hasSwarmHint = false;
    this._activeSwarmCount = undefined;
    this._swarmBoardOpen = false;
    this._swarmBoardFilterAgent = null;
    this._swarmBoardQuery = '';
    this._swarmBoardSelectedSeq = null;
    this._swarmBoardFollow = true;
    if (!options.keepCommands) {
      this.commands.setAcpCommands([]);
    }
    this.emit();
  }

  private recomputeControls(): void {
    this._controls = extractSessionControlState({
      configOptions: this._configOptions,
      models: this._models,
      modes: this._modes,
    });
    if (this._controls.useConfigOptions && this._controls.currentModelId) {
      this._modelThoughtLevels = {
        ...this._modelThoughtLevels,
        [this._controls.currentModelId]: this._controls.supportsThoughtLevel
          ? [...this._controls.availableThoughtLevels]
          : [],
      };
    }
  }

  // -------------------------------------------------------------------------
  // Settings Panel (`<prefs>`) & Info Overlays
  // -------------------------------------------------------------------------

  openSettings(options: {
    page?: SettingsPageId;
    agySettings?: AgySafeSettingsSnapshot;
    dirtyCount?: number;
  } = {}): SettingsPanelState {
    this._picker = null;
    this._swarmBoardOpen = false;
    this._gitOverlay = null;
    this._helpOpen = false;
    this._infoOverlay = null;
    this._completion = EMPTY_COMPLETION;

    const existing = this._settings;
    this._settings = {
      page: options.page ?? existing?.page ?? 'session',
      query: '',
      cursor: 0,
      focus: null,
      editing: null,
      agySettings: options.agySettings ?? existing?.agySettings ?? {},
      dirtyCount: options.dirtyCount ?? existing?.dirtyCount ?? 0,
    };
    this._settingsFocused = true;
    this.emit();
    return this._settings;
  }

  closeSettings(): boolean {
    if (!this._settings) return false;
    this._settings = null;
    this._settingsFocused = false;
    this.emit();
    return true;
  }

  setSettingsPage(page: SettingsPageId): void {
    if (!this._settings) return;
    this._settings.page = page;
    this._settings.focus = null;
    this._settings.editing = null;
    this.emit();
  }

  updateSettingsQuery(query: string, cursor?: number): void {
    if (!this._settings) return;
    this._settings.query = query;
    this._settings.cursor = Math.max(0, Math.min(query.length, cursor ?? query.length));
    this.emit();
  }

  setSettingsFocus(focus: string | null): void {
    if (!this._settings) return;
    this._settings.focus = focus;
    this.emit();
  }

  setSettingsEditing(editing: SettingsEditingState | null): void {
    if (!this._settings) return;
    this._settings.editing = editing;
    this.emit();
  }

  setSettingsAgySettings(agySettings: AgySafeSettingsSnapshot): void {
    if (!this._settings) return;
    this._settings.agySettings = agySettings;
    this.emit();
  }

  setSettingsDirtyCount(dirtyCount: number): void {
    if (!this._settings) return;
    this._settings.dirtyCount = Math.max(0, dirtyCount);
    this.emit();
  }

  setSettingsFocused(focused: boolean): void {
    if (!this._settings) return;
    const next = this._supportsAside ? focused : true;
    if (this._settingsFocused === next) return;
    this._settingsFocused = next;
    this.emit();
  }

  openInfoOverlay(
    kind: InfoOverlayKind,
    data: {
      configPath?: string;
      agySettingsPath?: string;
      contextBreakdown?: ContextBreakdown;
      message?: string;
      selectedJobId?: string;
    } = {},
  ): InfoOverlayState {
    this._picker = null;
    this._swarmBoardOpen = false;
    this._gitOverlay = null;
    this._helpOpen = false;
    this._completion = EMPTY_COMPLETION;
    const defaultJobId =
      kind === 'jobs'
        ? (data.selectedJobId ?? this.transcript.getBackgroundJobsSnapshot().all[0]?.id)
        : undefined;
    this._infoOverlay = {
      kind,
      ...(data.configPath !== undefined ? { configPath: data.configPath } : {}),
      ...(data.agySettingsPath !== undefined ? { agySettingsPath: data.agySettingsPath } : {}),
      ...(data.contextBreakdown !== undefined
        ? { contextBreakdown: data.contextBreakdown }
        : kind === 'context'
          ? { contextBreakdown: this.transcript.estimateContextBreakdown(this._usage) }
          : {}),
      ...(data.message !== undefined ? { message: data.message } : {}),
      ...(defaultJobId !== undefined ? { selectedJobId: defaultJobId } : {}),
    };
    this.emit();
    return this._infoOverlay;
  }

  setSelectedJobId(jobId: string | undefined): void {
    if (!this._infoOverlay || this._infoOverlay.kind !== 'jobs') return;
    if (this._infoOverlay.selectedJobId === jobId) return;
    this._infoOverlay = {
      ...this._infoOverlay,
      ...(jobId !== undefined ? { selectedJobId: jobId } : {}),
    };
    this.emit();
  }

  closeInfoOverlay(): boolean {
    if (!this._infoOverlay) return false;
    this._infoOverlay = null;
    this.emit();
    return true;
  }

  // -------------------------------------------------------------------------
  // Modal Picker & Help Overlay
  // -------------------------------------------------------------------------

  openPicker(
    kind: ModalPickerKind,
    options: {
      initialQuery?: string;
      scope?: string;
      loading?: boolean;
      selectedId?: string | null;
      sessions?: ResumeSessionEntry[];
      swarmSnapshot?: SwarmBoardSnapshot | null;
      swarmFollow?: boolean;
      modelPickerThinking?: string;
      mcpServers?: McpServerItem[];
      plugins?: PluginItem[];
      skills?: SkillItem[];
      agents?: AgentItem[];
    } = {},
  ): PickerModalState {
    const query = options.initialQuery ?? '';
    const isModelLikePicker =
      kind === 'model' || kind === 'planner' || kind === 'executor';
    const defaultScope =
      kind === 'resume'
        ? 'this-folder'
        : kind === 'log' ||
            kind === 'swarm' ||
            isModelLikePicker ||
            kind === 'mcp' ||
            kind === 'plugins' ||
            kind === 'skills' ||
            kind === 'agents'
          ? 'all'
          : 'default';

    const targetModelId =
      options.selectedId ?? (kind === 'model' ? this._controls.currentModelId : null);
    const targetThoughtChoices = isModelLikePicker
      ? resolveThoughtLevelsForModel(targetModelId, this._controls, this._modelThoughtLevels)
      : [];
    const currentEffectiveThought =
      kind === 'model' && !isOrchestratorModelId(targetModelId)
        ? this._controls.currentThoughtLevel
        : undefined;
    const defaultModelThinking = isModelLikePicker
      ? clampThoughtLevelForChoices(
          options.modelPickerThinking ?? currentEffectiveThought,
          targetThoughtChoices
        )
      : undefined;

    this._swarmBoardOpen = false;
    this._gitOverlay = null;
    this._helpOpen = false;
    this._infoOverlay = null;
    this._completion = EMPTY_COMPLETION;

    const defaultLoading =
      (kind === 'resume' && !options.sessions) ||
      (kind === 'swarm' && options.swarmSnapshot === undefined) ||
      (kind === 'mcp' && options.mcpServers === undefined) ||
      (kind === 'plugins' && options.plugins === undefined) ||
      (kind === 'skills' && options.skills === undefined) ||
      (kind === 'agents' && options.agents === undefined);

    this._picker = {
      kind,
      query,
      cursor: query.length,
      scope: options.scope ?? defaultScope,
      selectedId: options.selectedId ?? null,
      loading: options.loading ?? defaultLoading,
      sessions: options.sessions ?? [],
      ...(kind === 'swarm'
        ? {
            swarmSnapshot: options.swarmSnapshot,
            swarmFollow: options.swarmFollow ?? true,
          }
        : {}),
      ...(isModelLikePicker
        ? {
            ...(defaultModelThinking ? { modelPickerThinking: defaultModelThinking } : {}),
            modelPickerThinkingDirty: false,
          }
        : {}),
      ...(kind === 'mcp' ? { mcpServers: options.mcpServers ?? [] } : {}),
      ...(kind === 'plugins' ? { plugins: options.plugins ?? [] } : {}),
      ...(kind === 'skills' ? { skills: options.skills ?? [] } : {}),
      ...(kind === 'agents' ? { agents: options.agents ?? [] } : {}),
    };
    this.emit();
    return this._picker;
  }

  closePicker(): boolean {
    if (!this._picker) return false;
    this._picker = null;
    this.emit();
    return true;
  }

  updatePickerQuery(query: string, cursor?: number): void {
    if (!this._picker) return;
    this._picker.query = query;
    this._picker.cursor = Math.max(0, Math.min(query.length, cursor ?? query.length));
    this.emit();
  }

  setPickerScope(scope: string): void {
    if (!this._picker) return;
    this._picker.scope = scope;
    this.emit();
  }

  setModelPickerThinking(level: string | undefined): void {
    if (
      !this._picker ||
      (this._picker.kind !== 'model' &&
        this._picker.kind !== 'planner' &&
        this._picker.kind !== 'executor')
    ) {
      return;
    }
    if (level !== undefined) {
      const targetModelId =
        this._picker.selectedId ??
        (this._picker.kind === 'model' ? this._controls.currentModelId : null);
      const choices = resolveThoughtLevelsForModel(
        targetModelId,
        this._controls,
        this._modelThoughtLevels
      );
      if (choices.length === 0) return;
      this._picker.modelPickerThinking = clampThoughtLevelForChoices(level, choices);
    } else {
      this._picker.modelPickerThinking = undefined;
    }
    this._picker.modelPickerThinkingDirty = true;
    this.emit();
  }

  /**
   * Step the inline thinking effort slider inside the compact model / planner / executor picker
   * by `delta` (`-1` or `+1`), strictly bounded to the currently highlighted model's real levels.
   */
  stepModelPickerThinking(delta: number): string | null {
    if (
      !this._picker ||
      (this._picker.kind !== 'model' &&
        this._picker.kind !== 'planner' &&
        this._picker.kind !== 'executor')
    ) {
      return null;
    }
    const targetModelId =
      this._picker.selectedId ??
      (this._picker.kind === 'model' ? this._controls.currentModelId : null);
    const choices = resolveThoughtLevelsForModel(
      targetModelId,
      this._controls,
      this._modelThoughtLevels
    );
    if (choices.length === 0) return null;
    const defaultActive =
      this._picker.kind === 'model' && !isOrchestratorModelId(targetModelId)
        ? this._controls.currentThoughtLevel
        : undefined;
    const rawCurrent =
      this._picker.modelPickerThinking ?? defaultActive ?? choices[0]!.value;
    const current = clampThoughtLevelForChoices(rawCurrent, choices) ?? choices[0]!.value;
    const idx = Math.max(
      0,
      choices.findIndex((c) => c.value === current),
    );
    const nextIdx = Math.max(0, Math.min(choices.length - 1, idx + delta));
    const nextVal = choices[nextIdx]?.value ?? current;
    if (nextVal !== this._picker.modelPickerThinking) {
      this._picker.modelPickerThinking = nextVal;
      this._picker.modelPickerThinkingDirty = true;
      this.emit();
    }
    return nextVal;
  }

  togglePickerScope(): string | null {
    if (!this._picker) return null;
    if (this._picker.kind === 'resume') {
      this._picker.scope =
        this._picker.scope === 'this-folder' ? 'all-folders' : 'this-folder';
      this.emit();
      return this._picker.scope;
    }
    if (this._picker.kind === 'log') {
      const order: readonly LogPickerScope[] = ['all', 'out', 'in', 'stderr', 'tern-error'];
      const idx = order.indexOf(this._picker.scope as LogPickerScope);
      const next = order[(idx + 1) % order.length] ?? 'all';
      this._picker.scope = next;
      this.emit();
      return next;
    }
    if (
      this._picker.kind === 'model' ||
      this._picker.kind === 'planner' ||
      this._picker.kind === 'executor'
    ) {
      const seen = new Set<string>();
      const order: string[] = ['all'];
      const models =
        this._picker.kind === 'model'
          ? this._controls.availableModels.map((m) =>
              isOrchestratorModelId(m.value) ? { ...m, value: ORCHESTRATOR_PICKER_ID } : m
            )
          : filterOrchestratorRoleModels(this._picker.kind, this._controls.availableModels);
      for (const m of models) {
        const providerScope = `provider:${inferModelProvider(m.value)}`;
        if (!seen.has(providerScope)) {
          seen.add(providerScope);
          order.push(providerScope);
        }
      }
      const idx = order.indexOf(this._picker.scope);
      const next = order[(idx + 1) % order.length] ?? 'all';
      this._picker.scope = next;
      this.emit();
      return next;
    }
    if (this._picker.kind === 'swarm') {
      const snapshot = this._picker.swarmSnapshot;
      if (!snapshot) return this._picker.scope;
      const seen = new Set<string>();
      const order: string[] = ['all'];
      for (const m of snapshot.members) {
        if (!seen.has(m.name)) {
          seen.add(m.name);
          order.push(m.name);
        }
      }
      for (const agentName of Object.keys(snapshot.messageCounts).sort((a, b) => a.localeCompare(b))) {
        if (!seen.has(agentName)) {
          seen.add(agentName);
          order.push(agentName);
        }
      }
      const idx = order.indexOf(this._picker.scope);
      const next = order[(idx + 1) % order.length] ?? 'all';
      this._picker.scope = next;
      this.emit();
      return next;
    }
    return this._picker.scope;
  }

  // -------------------------------------------------------------------------
  // Persistent Swarm Snapshot & Native `agy`-Style Swarm Board Overlay
  // -------------------------------------------------------------------------

  /**
   * Return the filtered list of swarm board posts matching `swarmBoardFilterAgent`
   * and `swarmBoardQuery` in descending `seq` order (newest post first at index 0).
   */
  getFilteredSwarmPosts(
    snapshot: SwarmBoardSnapshot | null = this._swarmSnapshot,
    filterAgent: string | null = this._swarmBoardFilterAgent,
    query: string = this._swarmBoardQuery,
  ): readonly SwarmBoardMessage[] {
    if (!snapshot) return [];
    const normalizedAgent = filterAgent?.trim() || null;
    const normalizedQuery = query.trim().toLowerCase();

    const filtered = snapshot.messages.filter((msg) => {
      if (normalizedAgent && msg.agent !== normalizedAgent) {
        return false;
      }
      if (normalizedQuery.length === 0) return true;
      if (`#${msg.seq}`.includes(normalizedQuery)) return true;
      if (msg.agent.toLowerCase().includes(normalizedQuery)) return true;
      if (msg.summary.toLowerCase().includes(normalizedQuery)) return true;
      if (msg.text.toLowerCase().includes(normalizedQuery)) return true;
      if (msg.badges.some((b) => b.tag.toLowerCase().includes(normalizedQuery) || b.label.toLowerCase().includes(normalizedQuery))) {
        return true;
      }
      if (msg.mentions.some((m) => m.toLowerCase().includes(normalizedQuery))) {
        return true;
      }
      return false;
    });

    // Reverse into descending `seq` order so newest posts always appear at the top
    return filtered.slice().sort((a, b) => b.seq - a.seq);
  }

  /**
   * Update the session's persistent live swarm snapshot (driven by background `watchSwarmBoard`).
   * Automatically synchronizes `hasSwarm`, `isSwarmWorking`, `swarmWorkingNames`, `activeSwarmCount`,
   * auto-follow post selection in the Swarm Board overlay, and legacy `picker.kind === 'swarm'` state.
   */
  setSwarmSnapshot(
    snapshot: SwarmBoardSnapshot | null,
    options: { autoFollow?: boolean } = {},
  ): void {
    const prevLatestSeq = this._swarmSnapshot?.latestSeq ?? 0;
    this._swarmSnapshot = snapshot;
    if (snapshot) {
      this._hasSwarmHint = true;
      this._activeSwarmCount = snapshot.counts.activeMembers;
    } else {
      this._activeSwarmCount = undefined;
    }

    // Reconcile dedicated Swarm Board overlay selection & agent filter
    if (!snapshot) {
      this._swarmBoardFilterAgent = null;
      this._swarmBoardSelectedSeq = null;
    } else {
      if (
        this._swarmBoardFilterAgent !== null &&
        !snapshot.memberByName[this._swarmBoardFilterAgent] &&
        !snapshot.messageCounts[this._swarmBoardFilterAgent]
      ) {
        this._swarmBoardFilterAgent = null;
      }
      const filtered = this.getFilteredSwarmPosts(snapshot);
      const autoFollow = options.autoFollow ?? true;
      const hasNewMessages = snapshot.latestSeq > prevLatestSeq;
      if (filtered.length === 0) {
        this._swarmBoardSelectedSeq = null;
      } else if (
        (this._swarmBoardFollow && autoFollow && hasNewMessages) ||
        this._swarmBoardSelectedSeq === null ||
        !filtered.some((m) => m.seq === this._swarmBoardSelectedSeq)
      ) {
        this._swarmBoardSelectedSeq = filtered[0]!.seq;
      }
    }

    // Also keep legacy `picker.kind === 'swarm'` synchronized if open
    if (this._picker && this._picker.kind === 'swarm') {
      const pickerPrevSeq = this._picker.swarmSnapshot?.latestSeq ?? 0;
      this._picker.swarmSnapshot = snapshot;
      this._picker.loading = false;
      this._picker.error = undefined;

      if (!snapshot) {
        this._picker.scope = 'all';
        this._picker.selectedId = null;
      } else {
        if (
          this._picker.scope !== 'all' &&
          !snapshot.memberByName[this._picker.scope] &&
          !snapshot.messageCounts[this._picker.scope]
        ) {
          this._picker.scope = 'all';
        }
        const follow = this._picker.swarmFollow !== false;
        const autoFollow = options.autoFollow ?? true;
        const hasNewMessages = snapshot.latestSeq > pickerPrevSeq;
        if ((follow && autoFollow && hasNewMessages) || this._picker.selectedId === null) {
          this._picker.selectedId = null;
        }
      }
    }

    this.emit();
  }

  /**
   * Backward-compatible alias for {@link setSwarmSnapshot}.
   */
  setSwarmBoardSnapshot(
    snapshot: SwarmBoardSnapshot | null,
    options: { autoFollow?: boolean } = {},
  ): void {
    this.setSwarmSnapshot(snapshot, options);
  }

  openSwarmBoard(options: {
    query?: string;
    filterAgent?: string | null;
    follow?: boolean;
    snapshot?: SwarmBoardSnapshot | null;
  } = {}): void {
    this._picker = null;
    this._gitOverlay = null;
    this._helpOpen = false;
    this._infoOverlay = null;
    this._completion = EMPTY_COMPLETION;
    this._swarmBoardOpen = true;
    if (options.query !== undefined) {
      this._swarmBoardQuery = options.query;
    }
    if (options.filterAgent !== undefined) {
      this._swarmBoardFilterAgent = options.filterAgent;
    }
    if (options.follow !== undefined) {
      this._swarmBoardFollow = options.follow;
    }
    if (options.snapshot !== undefined) {
      this._swarmSnapshot = options.snapshot;
      if (options.snapshot) {
        this._hasSwarmHint = true;
        this._activeSwarmCount = options.snapshot.counts.activeMembers;
      }
    }

    const filtered = this.getFilteredSwarmPosts();
    if (filtered.length === 0) {
      this._swarmBoardSelectedSeq = null;
    } else if (
      this._swarmBoardFollow ||
      this._swarmBoardSelectedSeq === null ||
      !filtered.some((m) => m.seq === this._swarmBoardSelectedSeq)
    ) {
      this._swarmBoardSelectedSeq = filtered[0]!.seq;
    }

    this.emit();
  }

  closeSwarmBoard(): boolean {
    if (!this._swarmBoardOpen) return false;
    this._swarmBoardOpen = false;
    this.emit();
    return true;
  }

  selectSwarmPost(seq: number | null, options: { disableFollow?: boolean } = {}): void {
    const filtered = this.getFilteredSwarmPosts();
    const latestSeq = filtered[0]?.seq ?? null;
    this._swarmBoardSelectedSeq = seq;
    if (options.disableFollow !== false && seq !== null && latestSeq !== null && seq !== latestSeq) {
      this._swarmBoardFollow = false;
    }
    this.emit();
  }

  moveSwarmPostSelection(delta: number): number | null {
    const filtered = this.getFilteredSwarmPosts();
    if (filtered.length === 0) {
      if (this._swarmBoardSelectedSeq !== null) {
        this._swarmBoardSelectedSeq = null;
        this.emit();
      }
      return null;
    }
    const curIdx =
      this._swarmBoardSelectedSeq !== null
        ? filtered.findIndex((m) => m.seq === this._swarmBoardSelectedSeq)
        : 0;
    const baseIdx = curIdx >= 0 ? curIdx : 0;
    const nextIdx = Math.max(0, Math.min(filtered.length - 1, baseIdx + delta));
    const nextSeq = filtered[nextIdx]!.seq;
    const latestSeq = filtered[0]!.seq;
    this._swarmBoardSelectedSeq = nextSeq;
    if (nextSeq !== latestSeq) {
      this._swarmBoardFollow = false;
    }
    this.emit();
    return nextSeq;
  }

  toggleSwarmAgentFilter(agentName: string | null): string | null {
    const normalized = agentName?.trim() || null;
    const next =
      normalized === null || this._swarmBoardFilterAgent === normalized ? null : normalized;
    this._swarmBoardFilterAgent = next;

    const filtered = this.getFilteredSwarmPosts();
    if (filtered.length === 0) {
      this._swarmBoardSelectedSeq = null;
    } else if (
      this._swarmBoardSelectedSeq === null ||
      !filtered.some((m) => m.seq === this._swarmBoardSelectedSeq)
    ) {
      this._swarmBoardSelectedSeq = filtered[0]!.seq;
    }
    this.emit();
    return next;
  }

  setSwarmBoardQuery(query: string): void {
    if (this._swarmBoardQuery === query) return;
    this._swarmBoardQuery = query;
    const filtered = this.getFilteredSwarmPosts();
    if (filtered.length === 0) {
      this._swarmBoardSelectedSeq = null;
    } else if (
      this._swarmBoardSelectedSeq === null ||
      !filtered.some((m) => m.seq === this._swarmBoardSelectedSeq)
    ) {
      this._swarmBoardSelectedSeq = filtered[0]!.seq;
    }
    this.emit();
  }

  toggleSwarmBoardFollow(): boolean {
    const next = !this._swarmBoardFollow;
    this._swarmBoardFollow = next;
    if (next) {
      const filtered = this.getFilteredSwarmPosts();
      this._swarmBoardSelectedSeq = filtered[0]?.seq ?? null;
    }
    this.emit();
    return next;
  }

  setSwarmBoardFollow(follow: boolean): void {
    if (this._swarmBoardFollow === follow) return;
    this._swarmBoardFollow = follow;
    if (follow) {
      const filtered = this.getFilteredSwarmPosts();
      this._swarmBoardSelectedSeq = filtered[0]?.seq ?? null;
    }
    this.emit();
  }

  toggleSwarmFollow(): boolean {
    if (this._swarmBoardOpen) {
      return this.toggleSwarmBoardFollow();
    }
    if (!this._picker || this._picker.kind !== 'swarm') return false;
    const next = !(this._picker.swarmFollow ?? true);
    this._picker.swarmFollow = next;
    if (next) {
      this._picker.selectedId = null;
    }
    this.emit();
    return next;
  }

  setSwarmFollow(follow: boolean): void {
    if (this._swarmBoardOpen) {
      this.setSwarmBoardFollow(follow);
    }
    if (!this._picker || this._picker.kind !== 'swarm') return;
    this._picker.swarmFollow = follow;
    this.emit();
  }

  setPickerSelected(selectedId: string | null): void {
    if (!this._picker) return;
    this._picker.selectedId = selectedId;
    if (
      this._picker.kind === 'model' ||
      this._picker.kind === 'planner' ||
      this._picker.kind === 'executor'
    ) {
      const choices = resolveThoughtLevelsForModel(
        selectedId,
        this._controls,
        this._modelThoughtLevels
      );
      if (choices.length === 0) {
        this._picker.modelPickerThinking = undefined;
      } else {
        const currentThoughtForSelected =
          this._picker.kind === 'model' &&
          !isOrchestratorModelId(selectedId) &&
          selectedId === this._controls.currentModelId
            ? this._controls.currentThoughtLevel
            : undefined;
        const preferred =
          !this._picker.modelPickerThinkingDirty && currentThoughtForSelected !== undefined
            ? currentThoughtForSelected
            : (this._picker.modelPickerThinking ?? currentThoughtForSelected);
        this._picker.modelPickerThinking = clampThoughtLevelForChoices(preferred, choices);
      }
    }
    this.emit();
  }

  setPickerLoading(loading: boolean, error?: string): void {
    if (!this._picker) return;
    this._picker.loading = loading;
    this._picker.error = error;
    this.emit();
  }

  setResumeSessions(
    sessions: ResumeSessionEntry[],
    options: { readonly loading?: boolean } = {},
  ): void {
    if (!this._picker || this._picker.kind !== 'resume') return;
    this._picker.sessions = sessions;
    this._picker.loading = options.loading ?? false;
    this._picker.error = undefined;
    if (
      !this._picker.selectedId ||
      !sessions.some((s) => s.sessionId === this._picker?.selectedId)
    ) {
      this._picker.selectedId = sessions[0]?.sessionId ?? null;
    }
    this.emit();
  }

  setMcpServers(servers: McpServerItem[]): void {
    if (!this._picker || this._picker.kind !== 'mcp') return;
    this._picker.mcpServers = servers;
    this._picker.loading = false;
    this._picker.error = undefined;
    if (
      !this._picker.selectedId ||
      !servers.some((s) => s.name === this._picker?.selectedId)
    ) {
      this._picker.selectedId = servers[0]?.name ?? null;
    }
    this.emit();
  }

  setPlugins(plugins: PluginItem[]): void {
    if (!this._picker || this._picker.kind !== 'plugins') return;
    this._picker.plugins = plugins;
    this._picker.loading = false;
    this._picker.error = undefined;
    if (
      !this._picker.selectedId ||
      !plugins.some((p) => p.name === this._picker?.selectedId)
    ) {
      this._picker.selectedId = plugins[0]?.name ?? null;
    }
    this.emit();
  }

  setSkills(skills: SkillItem[]): void {
    if (!this._picker || this._picker.kind !== 'skills') return;
    this._picker.skills = skills;
    this._picker.loading = false;
    this._picker.error = undefined;
    if (
      !this._picker.selectedId ||
      !skills.some((s) => s.name === this._picker?.selectedId)
    ) {
      this._picker.selectedId = skills[0]?.name ?? null;
    }
    this.emit();
  }

  setAgents(agents: AgentItem[]): void {
    if (!this._picker || this._picker.kind !== 'agents') return;
    this._picker.agents = agents;
    this._picker.loading = false;
    this._picker.error = undefined;
    if (
      !this._picker.selectedId ||
      !agents.some((a) => a.id === this._picker?.selectedId)
    ) {
      this._picker.selectedId = agents[0]?.id ?? null;
    }
    this.emit();
  }

  openHelp(): void {
    this._picker = null;
    this._swarmBoardOpen = false;
    this._gitOverlay = null;
    this._infoOverlay = null;
    this._completion = EMPTY_COMPLETION;
    this._helpOpen = true;
    this.emit();
  }

  // -------------------------------------------------------------------------
  // Fullscreen Git UI Overlay (`omp.app.git`)
  // -------------------------------------------------------------------------

  openGitOverlay(): void {
    this._picker = null;
    this._swarmBoardOpen = false;
    this._infoOverlay = null;
    this._helpOpen = false;
    this._completion = EMPTY_COMPLETION;
    this._gitOverlay = {
      loading: true,
      busy: false,
      snapshot: null,
      selectedFileKey: null,
      diffLoading: false,
      diff: null,
      viewMode: 'split',
      wrap: false,
      sidebarStyle: 'path',
      foldedSections: { unstaged: false, staged: false },
      foldedDirs: {},
      commitSummary: '',
      commitBody: '',
      commitAmend: false,
      focusedField: null,
      statusMessage: null,
    };
    this.emit();
  }

  closeGitOverlay(): boolean {
    if (!this._gitOverlay) return false;
    this._gitOverlay = null;
    this.emit();
    return true;
  }

  setGitOverlayLoading(loading: boolean, error?: string): void {
    if (!this._gitOverlay) return;
    this._gitOverlay = {
      ...this._gitOverlay,
      loading,
      ...(error !== undefined ? { error } : { error: undefined }),
    };
    this.emit();
  }

  setGitOverlayBusy(busy: boolean): void {
    if (!this._gitOverlay || this._gitOverlay.busy === busy) return;
    this._gitOverlay = { ...this._gitOverlay, busy };
    this.emit();
  }

  setGitOverlaySnapshot(snapshot: GitRepoSnapshot): string | null {
    if (!this._gitOverlay) return null;
    const allFiles = getAllVisibleGitFiles(snapshot);
    const prevKey = this._gitOverlay.selectedFileKey;
    const keepKey =
      prevKey && allFiles.some(f => gitFileKey(f.area, f.path) === prevKey) ? prevKey : null;
    const nextKey =
      keepKey ?? (allFiles[0] ? gitFileKey(allFiles[0].area, allFiles[0].path) : null);
    this._gitOverlay = {
      ...this._gitOverlay,
      loading: false,
      error: undefined,
      snapshot,
      selectedFileKey: nextKey,
      ...(nextKey === null ? { diff: null, diffLoading: false } : {}),
    };
    this.emit();
    return nextKey;
  }

  selectGitFileKey(fileKey: string | null): void {
    if (!this._gitOverlay) return;
    this._gitOverlay = {
      ...this._gitOverlay,
      selectedFileKey: fileKey,
      diffLoading: fileKey !== null,
      ...(fileKey === null ? { diff: null } : {}),
    };
    this.emit();
  }

  setGitFileDiff(diff: GitFileDiffResult | null): void {
    if (!this._gitOverlay) return;
    if (diff && this._gitOverlay.selectedFileKey !== diff.fileKey) {
      return;
    }
    this._gitOverlay = {
      ...this._gitOverlay,
      diffLoading: false,
      diff,
    };
    this.emit();
  }

  setGitViewMode(viewMode: GitDiffViewMode): void {
    if (!this._gitOverlay || this._gitOverlay.viewMode === viewMode) return;
    this._gitOverlay = { ...this._gitOverlay, viewMode };
    this.emit();
  }

  toggleGitWrap(): void {
    if (!this._gitOverlay) return;
    this._gitOverlay = { ...this._gitOverlay, wrap: !this._gitOverlay.wrap };
    this.emit();
  }

  setGitSidebarStyle(sidebarStyle: GitSidebarStyle): void {
    if (!this._gitOverlay || this._gitOverlay.sidebarStyle === sidebarStyle) return;
    this._gitOverlay = { ...this._gitOverlay, sidebarStyle };
    this.emit();
  }

  toggleGitSectionFold(area: 'unstaged' | 'staged'): void {
    if (!this._gitOverlay) return;
    this._gitOverlay = {
      ...this._gitOverlay,
      foldedSections: {
        ...this._gitOverlay.foldedSections,
        [area]: !this._gitOverlay.foldedSections[area],
      },
    };
    this.emit();
  }

  toggleGitDirFold(dirKey: string): void {
    if (!this._gitOverlay) return;
    this._gitOverlay = {
      ...this._gitOverlay,
      foldedDirs: {
        ...this._gitOverlay.foldedDirs,
        [dirKey]: !this._gitOverlay.foldedDirs[dirKey],
      },
    };
    this.emit();
  }

  toggleGitAmend(): void {
    if (!this._gitOverlay) return;
    this._gitOverlay = { ...this._gitOverlay, commitAmend: !this._gitOverlay.commitAmend };
    this.emit();
  }

  setGitCommitSummary(summary: string): void {
    if (!this._gitOverlay || this._gitOverlay.commitSummary === summary) return;
    this._gitOverlay = { ...this._gitOverlay, commitSummary: summary };
    this.emit();
  }

  setGitCommitBody(body: string): void {
    if (!this._gitOverlay || this._gitOverlay.commitBody === body) return;
    this._gitOverlay = { ...this._gitOverlay, commitBody: body };
    this.emit();
  }

  clearGitCommitForm(): void {
    if (!this._gitOverlay) return;
    this._gitOverlay = {
      ...this._gitOverlay,
      commitSummary: '',
      commitBody: '',
      commitAmend: false,
      focusedField: null,
    };
    this.emit();
  }

  setGitFocusedField(field: GitFocusedField): void {
    if (!this._gitOverlay || this._gitOverlay.focusedField === field) return;
    this._gitOverlay = { ...this._gitOverlay, focusedField: field };
    this.emit();
  }

  setGitOverlayStatus(statusMessage: GitOverlayStatusMessage | null): void {
    if (!this._gitOverlay) return;
    this._gitOverlay = { ...this._gitOverlay, statusMessage };
    this.emit();
  }

  closeHelp(): boolean {
    if (!this._helpOpen) return false;
    this._helpOpen = false;
    this.emit();
    return true;
  }

  // -------------------------------------------------------------------------
  // Elicitation (`<questions>`)
  // -------------------------------------------------------------------------

  openQuestion(
    requestId: JsonRpcId,
    params: ElicitationCreateParams,
    resolve: (result: ElicitationCreateResult) => void,
  ): ActiveQuestionCard {
    if (this._activeQuestion) {
      this._activeQuestion.resolve({ action: 'cancel' });
    }
    this._completion = EMPTY_COMPLETION;
    this._activeQuestion = buildQuestionCardFromElicitation(
      requestId,
      params,
      resolve,
      this._now(),
    );
    this.emit();
    return this._activeQuestion;
  }

  setQuestionAnswer(questionId: string, answer: string | string[]): void {
    if (!this._activeQuestion) return;
    this._activeQuestion.answers[questionId] = answer;
    const item = this._activeQuestion.items.find((q) => q.id === questionId);
    if (item && !item.multi && typeof answer === 'string') {
      const isPresetChoice = Boolean(item.choices?.some((c) => c.value === answer));
      if (isPresetChoice) {
        delete this._activeQuestion.otherDrafts[questionId];
        if (this._activeQuestion.focusedOtherId === questionId) {
          this._activeQuestion.focusedOtherId = null;
        }
      }
    }
    this.emit();
  }

  clearQuestionAnswer(questionId: string): void {
    if (!this._activeQuestion) return;
    delete this._activeQuestion.answers[questionId];
    delete this._activeQuestion.otherDrafts[questionId];
    if (this._activeQuestion.focusedOtherId === questionId) {
      this._activeQuestion.focusedOtherId = null;
    }
    this.emit();
  }

  setQuestionOtherDraft(questionId: string, text: string): void {
    if (!this._activeQuestion) return;
    this._activeQuestion.otherDrafts[questionId] = text;
    const item = this._activeQuestion.items.find((q) => q.id === questionId);
    if (item?.multi) {
      // Preserve any preset multi-select choices; keep free-text in `otherDrafts`
      if (text.length === 0 && typeof this._activeQuestion.answers[questionId] === 'string') {
        delete this._activeQuestion.answers[questionId];
      }
    } else if (text.length > 0) {
      this._activeQuestion.answers[questionId] = text;
    } else if (
      typeof this._activeQuestion.answers[questionId] === 'string' &&
      !item?.choices?.some((c) => c.value === this._activeQuestion?.answers[questionId])
    ) {
      delete this._activeQuestion.answers[questionId];
    }
    this.emit();
  }

  setQuestionStep(step: number): void {
    if (!this._activeQuestion) return;
    const maxStep = Math.max(0, this._activeQuestion.items.length - 1);
    this._activeQuestion.step = Math.max(0, Math.min(maxStep, step));
    this.emit();
  }

  setQuestionFocusedOther(questionId: string | null): void {
    if (!this._activeQuestion) return;
    this._activeQuestion.focusedOtherId = questionId;
    this.emit();
  }

  resolveActiveQuestion(result: ElicitationCreateResult): boolean {
    const card = this._activeQuestion;
    if (!card) return false;
    this._activeQuestion = null;
    card.resolve(result);
    this.emit();
    return true;
  }

  cancelActiveQuestion(): boolean {
    return this.resolveActiveQuestion({ action: 'cancel' });
  }

  // -------------------------------------------------------------------------
  // Caret Completion Popup (`/` & `@`) — Aligned 1:1 with `omp` Figure 3
  // -------------------------------------------------------------------------

  private resolveCommandStatusValue(cmd: SlashCommandDef): string | undefined {
    switch (cmd.statusKey) {
      case 'model':
        return this._controls.currentModelName ?? this._controls.currentModelId ?? undefined;
      case 'thought':
        if (isOrchestratorModelId(this._controls.currentModelId)) {
          const lvl =
            parseOrchestratorModelSpec(this._orchestratorSettings.planner)?.thoughtLevel ?? 'high';
          return lvl === 'xhigh' ? 'Extra' : lvl.charAt(0).toUpperCase() + lvl.slice(1);
        }
        if (!this._controls.supportsThoughtLevel) return 'n/a';
        return (
          this._controls.currentThoughtLevelName ??
          this._controls.currentThoughtLevel ??
          undefined
        );
      case 'thinking':
        return this._showThinking && !this._autoCollapseThought ? 'on' : 'off';
      case 'mode':
        return this._controls.currentModeName ?? this._controls.currentModeId ?? undefined;
      case 'context':
        return formatContextUsage(this._usage) ?? undefined;
      case 'settings':
        return 'config.toml';
      case 'board': {
        const working = this._swarmSnapshot?.counts.workingMembers ?? 0;
        if (working > 0) return `${working} working`;
        const active = this._swarmSnapshot?.counts.activeMembers ?? this._activeSwarmCount;
        return active !== undefined && active > 0 ? `${active} active` : undefined;
      }
      case 'status': {
        if (this._tier?.name) return this._tier.name;
        const ver = this._agentVersion ?? this._agentInfo?.version;
        return ver ? `v${ver}` : undefined;
      }
      case 'usage':
        return this._tier?.name ?? undefined;
      case 'skills': {
        const count = this.commands.getAcpSkillCommands().length;
        if (count === 0) return undefined;
        return count === 1 ? '1 skill' : `${count} skills`;
      }
      case 'jobs': {
        const running = this.transcript.getBackgroundJobsSnapshot().runningJobCount;
        return running > 0 ? `${running} running` : undefined;
      }
      case 'git': {
        if (!this._gitStatus) return undefined;
        return this._gitStatus.isDirty ? `${this._gitStatus.branch}*` : this._gitStatus.branch;
      }
      default:
        return undefined;
    }
  }

  private buildSlashCompletionItems(rawQuery: string): CompletionPopupItem[] {
    const query = rawQuery.trim();
    const queryLower = query.toLowerCase();
    const acpSkills = this.commands.getAcpSkillCommands();

    // 1. Expanded `skill:` sub-list when user types `/skill:` (or accepts the collapsed `skill:` row)
    if (queryLower.startsWith('skill:')) {
      const subQuery = query.slice('skill:'.length).trim();
      const matchedSkills: Array<{
        cmd: SlashCommandDef;
        score: number;
        hits: readonly (readonly [number, number])[];
      }> = [];

      for (let i = 0; i < acpSkills.length; i++) {
        const cmd = acpSkills[i]!;
        if (subQuery.length === 0) {
          matchedSkills.push({
            cmd,
            score: 1000 - i,
            hits: [[0, 'skill:'.length]],
          });
          continue;
        }
        const m = fuzzyMatchText(cmd.name, subQuery);
        if (m) {
          const shifted: Array<readonly [number, number]> = [
            [0, 'skill:'.length],
            ...m.hits.map(([s, e]) => [s + 'skill:'.length, e + 'skill:'.length] as const),
          ];
          matchedSkills.push({ cmd, score: m.score + 100, hits: shifted });
        } else if (cmd.description.toLowerCase().includes(subQuery.toLowerCase())) {
          matchedSkills.push({
            cmd,
            score: 50,
            hits: [[0, 'skill:'.length]],
          });
        }
      }

      matchedSkills.sort((a, b) =>
        b.score !== a.score ? b.score - a.score : a.cmd.name.localeCompare(b.cmd.name),
      );

      return matchedSkills.slice(0, MAX_COMPLETION_ITEMS).map((entry, idx) => ({
        key: sanitizeCompletionKey(`skill_${entry.cmd.name}`, idx),
        kind: 'slash' as const,
        value: entry.cmd.name,
        label: `skill:${entry.cmd.name}`,
        icon: 'skill',
        detail: entry.cmd.description,
        hits: entry.hits,
        autoExecuteOnEnter: entry.cmd.autoExecuteOnEnter,
      }));
    }

    // 2. Normal `/` query (empty or not starting with `skill:`)
    const shouldCollapseSkills =
      acpSkills.length > 1 || (queryLower.length === 0 && acpSkills.length === 1);
    const skillGroupMatch =
      queryLower.length === 0
        ? { score: 1000, hits: [] as readonly (readonly [number, number])[] }
        : fuzzyMatchText('skill:', queryLower);

    const includeCollapsedSkillRow =
      shouldCollapseSkills && (queryLower.length === 0 || skillGroupMatch !== null);

    const items: CompletionPopupItem[] = [];

    if (includeCollapsedSkillRow) {
      const countLabel = acpSkills.length === 1 ? '1 skill' : `${acpSkills.length} skills`;
      items.push({
        key: 'cmd_skill_group',
        kind: 'slash',
        value: 'skill:',
        label: 'skill:',
        icon: 'skill',
        detail: 'Browse and invoke available skills',
        statusValue: countLabel,
        badge: countLabel,
        hits: skillGroupMatch ? skillGroupMatch.hits : [],
        autoExecuteOnEnter: false,
        isSkillGroup: true,
      });
    }

    const allMatches = this.commands.search(query);
    for (let idx = 0; idx < allMatches.length; idx++) {
      if (items.length >= MAX_COMPLETION_ITEMS) break;
      const m = allMatches[idx]!;
      // Hide individual ACP skill rows when collapsed under `skill:`
      if (includeCollapsedSkillRow && m.command.source === 'agy' && m.command.isSkill) {
        continue;
      }
      const statusValue = this.resolveCommandStatusValue(m.command);
      items.push({
        key: sanitizeCompletionKey(`cmd_${m.command.name}`, idx),
        kind: 'slash',
        value: m.command.name,
        // Never include a leading '/' in the completion label (Figure 3 / omp standard)
        label: m.command.name,
        icon: m.command.icon ?? 'action',
        detail: m.command.description,
        ...(statusValue !== undefined ? { statusValue, badge: statusValue } : {}),
        hits: m.nameHits,
        autoExecuteOnEnter: m.command.autoExecuteOnEnter,
      });
    }

    return items.slice(0, MAX_COMPLETION_ITEMS);
  }

  refreshCompletion(
    searchFiles?: (query: string, limit: number) => readonly FileCompletionCandidate[],
  ): CompletionPopupState {
    // Never show completion popup behind a modal picker, swarm board, git overlay, info overlay, help, or focused modal settings
    const mode = this.getFocusMode();
    if (
      mode === 'picker' ||
      mode === 'swarm' ||
      mode === 'git' ||
      mode === 'help' ||
      mode === 'info' ||
      mode === 'settings'
    ) {
      if (this._completion.open) {
        this._completion = EMPTY_COMPLETION;
        this.emit();
      }
      return this._completion;
    }

    const trigger = detectCompletionTrigger(this.draft.text, this.draft.cursor);
    if (!trigger) {
      if (this._completion.open || this._completion.dismissedTrigger) {
        this._completion = EMPTY_COMPLETION;
        this.emit();
      }
      return this._completion;
    }

    // Keep dismissed if user pressed Esc on this exact trigger text
    const dismissed = this._completion.dismissedTrigger;
    if (
      dismissed &&
      dismissed.start === trigger.start &&
      dismissed.end === trigger.end &&
      dismissed.raw === trigger.raw
    ) {
      return this._completion;
    }

    let items: CompletionPopupItem[] = [];
    if (trigger.kind === 'slash') {
      items = this.buildSlashCompletionItems(trigger.query);
    } else if (trigger.kind === 'file' && searchFiles) {
      const files = searchFiles(trigger.query, MAX_COMPLETION_ITEMS);
      items = files.slice(0, MAX_COMPLETION_ITEMS).map((f, idx) => {
        const relPath = 'file' in f ? f.file.relPath : f.path;
        const absPath = 'file' in f ? f.file.absPath : f.absPath;
        const explicitDir = 'file' in f ? (f.isDirectory ?? f.file.isDirectory) : f.isDirectory;
        const isDirectory = explicitDir === true || relPath.endsWith('/');
        return {
          key: sanitizeCompletionKey(`file_${idx}_${relPath}`, idx),
          kind: 'file' as const,
          value: relPath,
          label: relPath,
          icon: isDirectory ? 'folder' : 'file',
          isDirectory,
          ...(absPath !== undefined ? { absPath } : {}),
          ...(f.hits ? { hits: f.hits } : {}),
          autoExecuteOnEnter: false,
        };
      });
    }

    if (items.length === 0) {
      this._completion = EMPTY_COMPLETION;
      this.emit();
      return this._completion;
    }

    // Preserve previously highlighted item if still present
    const prevKey = this._completion.selectedKey;
    const keptIdx = prevKey ? items.findIndex((item) => item.key === prevKey) : -1;
    const selectedIndex = keptIdx >= 0 ? keptIdx : 0;
    const selectedKey = items[selectedIndex]?.key ?? null;

    this._completion = {
      open: true,
      trigger,
      items,
      selectedIndex,
      selectedKey,
      selectedNodeId: selectedKey ? `${COMPLETION_LIST_PREFIX}${selectedKey}` : null,
    };
    this.emit();
    return this._completion;
  }

  moveCompletionSelection(delta: number): void {
    if (!this._completion.open || this._completion.items.length === 0) return;
    const count = this._completion.items.length;
    const nextIdx = ((this._completion.selectedIndex + delta) % count + count) % count;
    const selectedKey = this._completion.items[nextIdx]?.key ?? null;
    this._completion = {
      ...this._completion,
      selectedIndex: nextIdx,
      selectedKey,
      selectedNodeId: selectedKey ? `${COMPLETION_LIST_PREFIX}${selectedKey}` : null,
    };
    this.emit();
  }

  selectCompletionByKey(keyOrNodeId: string): void {
    if (!this._completion.open) return;
    const key = keyOrNodeId.startsWith(COMPLETION_LIST_PREFIX)
      ? keyOrNodeId.slice(COMPLETION_LIST_PREFIX.length)
      : keyOrNodeId;
    const idx = this._completion.items.findIndex((i) => i.key === key);
    if (idx === -1) return;
    this._completion = {
      ...this._completion,
      selectedIndex: idx,
      selectedKey: key,
      selectedNodeId: `${COMPLETION_LIST_PREFIX}${key}`,
    };
    this.emit();
  }

  dismissCompletion(): boolean {
    if (!this._completion.open) return false;
    const trigger = this._completion.trigger;
    this._completion = {
      ...EMPTY_COMPLETION,
      ...(trigger
        ? {
            dismissedTrigger: {
              start: trigger.start,
              end: trigger.end,
              raw: trigger.raw,
            },
          }
        : {}),
    };
    this.emit();
    return true;
  }

  /**
   * Accept the currently highlighted (or specified) completion item into `draft`.
   * - Accepting the collapsed `skill:` row replaces the trigger with `/skill:` (no trailing space)
   *   and immediately re-opens completion showing the expanded skill list.
   * - Pass `viaKey: 'enter'` so built-in no-arg slash commands signal `autoExecute: true`
   *   per DESIGN.md 4.3.2 #4.
   */
  acceptCompletion(
    options: { keyOrNodeId?: string; viaKey?: 'tab' | 'enter' | 'click' } = {},
  ): AcceptCompletionResult | null {
    if (!this._completion.open || !this._completion.trigger) return null;

    if (options.keyOrNodeId) {
      this.selectCompletionByKey(options.keyOrNodeId);
    }

    const item = this._completion.items[this._completion.selectedIndex];
    const trigger = this._completion.trigger;
    if (!item) return null;

    // Expanding the collapsed `skill:` group row inserts `/skill:` and refreshes the popup immediately
    if (item.isSkillGroup) {
      const replaced = applyTriggerReplacement(this.draft.text, trigger, 'skill:', {
        appendSpace: false,
      });
      this.draft.replaceRange(replaced.from, replaced.to, replaced.inserted, replaced.cursor, true);
      this._completion = EMPTY_COMPLETION;
      this.refreshCompletion();
      return {
        item,
        text: this.draft.text,
        cursor: this.draft.cursor,
        autoExecute: false,
      };
    }

    const autoExecute =
      item.kind === 'slash' &&
      (options.viaKey === 'enter' || options.viaKey === 'click') &&
      item.autoExecuteOnEnter === true &&
      this.draft.text.slice(trigger.end).trim().length === 0;

    const replaced = applyTriggerReplacement(this.draft.text, trigger, item.value, {
      appendSpace: !autoExecute,
    });

    this.draft.replaceRange(replaced.from, replaced.to, replaced.inserted, replaced.cursor, true);
    this._completion = EMPTY_COMPLETION;
    this.emit();

    return {
      item,
      text: this.draft.text,
      cursor: this.draft.cursor,
      autoExecute,
    };
  }

  // -------------------------------------------------------------------------
  // Pending Attachments & Toast Queue
  // -------------------------------------------------------------------------

  addAttachment(attachment: AttachmentItem): void {
    const exists = this._pendingAttachments.some(
      (a) =>
        (attachment.blobId && a.blobId === attachment.blobId) ||
        (attachment.path && a.path === attachment.path && a.kind === attachment.kind),
    );
    if (exists) return;
    this._pendingAttachments = [...this._pendingAttachments, attachment];
    this.emit();
  }

  removeAttachment(id: string): boolean {
    const next = this._pendingAttachments.filter((a) => a.id !== id);
    if (next.length === this._pendingAttachments.length) return false;
    this._pendingAttachments = next;
    this.emit();
    return true;
  }

  clearAttachments(): AttachmentItem[] {
    const prev = this._pendingAttachments;
    if (prev.length === 0) return [];
    this._pendingAttachments = [];
    this.emit();
    return prev;
  }

  pushToast(
    text: string,
    tone: ToastTone = 'info',
    options: { sub?: string; ttl?: number } = {},
  ): ToastItem {
    const toast: ToastItem = {
      seq: ++this._toastSeq,
      text,
      tone,
      ...(options.sub !== undefined ? { sub: options.sub } : {}),
      ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
      createdAt: this._now(),
    };
    this._toasts = [...this._toasts, toast].slice(-MAX_TOAST_QUEUE);
    this.emit();
    return toast;
  }

  dismissToast(seq?: number): void {
    if (seq === undefined) {
      if (this._toasts.length === 0) return;
      this._toasts = [];
    } else {
      const next = this._toasts.filter((t) => t.seq !== seq);
      if (next.length === this._toasts.length) return;
      this._toasts = next;
    }
    this.emit();
  }
}
