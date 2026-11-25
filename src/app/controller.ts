import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  connect,
  type EditEvent,
  type ErrorEvent,
  type FocusEvent,
  type GoneEvent,
  type Key,
  type SendEvent,
  type Session,
  type Surface,
  type TspEvent,
  type UndoEvent,
} from '@stencil-hq/tern';
import {
  AcpClient,
  type AcpExitInfo,
  type AcpSpawnFn,
  type AcpTrafficEvent,
} from '../acp/client';
import {
  applyModelSelection,
  clampThoughtLevelForChoices,
  filterOrchestratorRoleModels,
  getNextModeSelection,
  inferOrchestratorDefaultExecutorModel,
  inferOrchestratorDefaultPlannerModel,
  isOrchestratorModelId,
  ORCHESTRATOR_PICKER_ID,
  resolveAcpOrchestratorModelIdForPlanner,
  resolveModeSelection,
  resolveModelSelection,
  resolveOrchestratorRoleThoughtLevels,
  resolveThoughtLevel,
  resolveThoughtLevelsForModel,
} from '../acp/model';
import { normalizeDisplayPath, sameDir, toFileUri } from '../acp/path';
import {
  AcpRpcError,
  extractNoticeText,
  extractSessionTier,
  isElicitationCreateRequest,
  isRequestPermissionRequest,
  type AcpIncomingRequest,
  type AuthMethod,
  type ContentBlock,
  type McpServerConfig,
  type SessionSummary,
  type SessionUpdateParams,
} from '../acp/protocol';
import {
  dispatchSlashCommand,
  executeCommandAction,
  type CommandActionExecutor,
  type PickerCommandKind,
  type SettingsPageId,
} from '../commands/handlers';
import {
  formatOrchestratorModelSpec,
  getAgySettingsPath,
  isAgySafeSettingKey,
  loadAgySettings,
  parseOrchestratorModelSpec,
  saveAgySettings,
} from '../config/agy_settings';
import {
  DEFAULT_CONFIG,
  getConfigPath,
  isSemverAtLeast,
  loadConfig,
  normalizeTodoProvider,
  normalizeToolDisplayMode,
  resolveEffectiveTodoProvider,
  saveConfig,
  supportsNativeUpdateSteps,
  type OmaConfig,
  type TodoProvider,
  type ToolDisplayMode,
} from '../config/config';
import {
  exportTranscriptMarkdown,
  listAgents,
  listMcpServers,
  listPlugins,
  removeMcpServer,
  scanLocalSkills,
  setMcpServerEnabled,
  setPluginEnabled,
  type ExecCommandFn,
} from '../ecosystem/cli';
import { nextCodePointOffset, prevCodePointOffset } from '../editor/draft';
import { extractFileMentions } from '../editor/trigger';
import { WorkspaceFileIndexer } from '../filesearch/indexer';
import { EmbeddedTodoMcpServer, type TodoServerUpdateEvent } from '../mcp/todo_server';
import {
  getDataDir,
  PreviewStore,
  type PersistedSessionTodoState,
  type SessionAnchorRecord,
} from '../preview/store';
import type { ApprovalAction } from '../state/approval';
import {
  areGitStatusEqual,
  probeGitStatus,
  type GitExecFn,
} from '../state/git_status';
import {
  commitGitChanges,
  getAllVisibleGitFiles,
  gitFileKey,
  loadGitFileDiff,
  loadGitRepoSnapshot,
  resolveGitStageActionPaths,
  stageGitFiles,
  unstageGitFiles,
  type GitChangedFile,
  type GitDiffViewMode,
} from '../state/git_tui';
import {
  areSessionMetricsEqual,
  readTranscriptModelCandidates,
  SessionMetricsTracker,
  type SessionMetricsSnapshot,
} from '../state/session_metrics';
import {
  AppStore,
  EDITOR_NODE_ID,
  normalizeSessionTitle,
  type AgentItem,
  type BeeMemberBlobPair,
  type McpServerItem,
  type ModalPickerKind,
  type PluginItem,
  type ResumeSessionEntry,
  type SessionTitleSource,
  type SkillItem,
} from '../state/store';
import {
  applyTodoOperation,
  areAllTodosFinished,
  cloneTodoPhases,
  findTodoPhaseFuzzy,
  findTodoTaskFuzzy,
  formatPhaseDisplayTitle,
  formatTodoMarkdown,
  formatUserTodoSyncReminder,
  isChecklistStatusFinished,
  isOmaTodoToolName,
  normalizeSingleInProgress,
  OMA_TODO_SYSTEM_PROMPT_APPEND,
  parseTodoMarkdown,
  TODO_AUTO_CLEAR_DELAY_MS,
  TODO_HELP_TEXT,
  type TodoPhase,
} from '../state/todo';
import {
  buildElicitationContent,
  type AttachmentItem,
  type PlanState,
} from '../state/transcript';
import {
  loadSwarmBoard,
  watchSwarmBoard,
  type SwarmBoardSnapshot,
  type SwarmBoardWatcher,
  type SwarmPathOptions,
} from '../swarm/board';
import {
  isRemoteSshWithoutDisplay,
  readClipboardImage,
  readClipboardText,
  writeClipboardText,
  type ClipboardImage,
} from '../termio/clipboard';
import { createOscWriter, type OscWriter } from '../termio/osc';
import { SafeTermOutput } from '../termio/output';
import { buildAppView } from '../ui/AppView';
import {
  buildSwarmBeeEffectCss,
  getAntigravityLogoAsset,
  getMemberBeeAssetPair,
  getSwarmBeeAssets,
  WELCOME_LOGO_STYLESHEET,
} from '../ui/assets';
import { resolveOrbitSwarmBees } from '../ui/ComposerView';
import { computePickerData } from '../ui/PickerView';
import { RenderScheduler } from '../ui/scheduler';
import { computeSettingsData, SETTINGS_PAGES } from '../ui/SettingsView';
import {
  OMA_VERSION,
  resolveResumeTarget,
  type CliOptions,
} from './fallback';

const MAX_EMBEDDED_FILE_BYTES = 256 * 1024;
const DONE_TO_IDLE_DELAY_MS = 1500;
const DEFAULT_BACKGROUND_DONE_GRACE_MS = 2000;
const DEFAULT_BACKGROUND_WAKEUP_GRACE_MS = 10_000;
const DEFAULT_BACKGROUND_TRANSCRIPT_STALL_MS = 180_000;
const DEFAULT_REPLAY_DRAIN_INITIAL_QUIET_MS = 120;
const AGY_1_5_15_REPLAY_DRAIN_INITIAL_QUIET_MS = 20;
const DEFAULT_REPLAY_DRAIN_ACTIVE_QUIET_MS = 250;
const DEFAULT_REPLAY_DRAIN_MAX_MS = 10_000;
const GIT_PROBE_MIN_INTERVAL_MS = 1500;
const TPS_FLUSH_MIN_INTERVAL_MS = 120;

export { isSemverAtLeast } from '../config/config';

export interface ClipboardService {
  readImage(): Promise<ClipboardImage | null>;
  readText(): Promise<string | null>;
  writeText(text: string): Promise<boolean>;
  isRemoteSshWithoutDisplay(): boolean;
}

const DEFAULT_CLIPBOARD: ClipboardService = {
  readImage: () => readClipboardImage(),
  readText: () => readClipboardText(),
  writeText: text => writeClipboardText(text),
  isRemoteSshWithoutDisplay: () => isRemoteSshWithoutDisplay(),
};

export interface ConnectTernOptions {
  readonly output?: SafeTermOutput;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeout?: number;
}

/**
 * Connects to Tern with `features: ['edit', 'undo', 'send']`, custom
 * `SafeTermOutput`, and explicit `exitHooks: false` so signal cleanup
 * always runs `session/close` before `session.close()`.
 */
export async function connectTernSession(
  options: ConnectTernOptions = {}
): Promise<{ session: Session; output: SafeTermOutput } | null> {
  const output = options.output ?? new SafeTermOutput(process.stdout);
  const session = await connect({
    app: 'oma',
    version: OMA_VERSION,
    features: ['edit', 'undo', 'send'],
    output,
    exitHooks: false,
    env: options.env,
    timeout: options.timeout,
  });
  if (!session) return null;
  return { session, output };
}

export interface AppControllerOptions {
  readonly cli: CliOptions;
  readonly config: OmaConfig;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly session: Session;
  readonly output: SafeTermOutput;
  readonly acpSpawn?: AcpSpawnFn;
  readonly previewStore?: PreviewStore;
  readonly fileIndexer?: WorkspaceFileIndexer;
  readonly clipboard?: ClipboardService;
  readonly runLogin?: () => Promise<number>;
  readonly installSignals?: boolean;
  readonly throttleMs?: number;
  readonly now?: () => number;
  readonly onExit?: (code: number) => void;
  /** Optional direct override of the swarm board directory (for deterministic tests). */
  readonly swarmDir?: string;
  /** Optional override of the `brain` root directory (for deterministic tests / custom app-data-dir). */
  readonly baseBrainDir?: string;
  /** Optional polling interval override (ms) for `watchSwarmBoard`. */
  readonly swarmPollIntervalMs?: number;
  /** Optional polling interval override (ms) for in-flight tool background promotion & transcript sync. Default: 1000. */
  readonly toolWatchIntervalMs?: number;
  /** Optional subprocess runner injected into `src/ecosystem/cli.ts` for offline deterministic tests. */
  readonly ecosystemRunner?: ExecCommandFn;
  /** Optional override path to `oma` `config.toml` (for offline deterministic tests). */
  readonly configPath?: string;
  /** Optional parse error from initial `loadConfig()` to avoid overwriting broken `config.toml`. */
  readonly configParseError?: string;
  /** Optional override path to `~/.gemini/antigravity-cli/settings.json` (for offline deterministic tests). */
  readonly agySettingsPath?: string;
  /** Optional override for local workspace skills dir (for offline deterministic tests). */
  readonly workspaceSkillsDir?: string;
  /** Optional override for global skills dir (for offline deterministic tests). */
  readonly globalSkillsDir?: string;
  /** Optional override for `~/.agents/skills` global skills dir (for offline deterministic tests). */
  readonly agentsGlobalSkillsDir?: string;
  /** Optional override for data dir used by default `/export` & `/log` paths. */
  readonly dataDir?: string;
  /** Optional git subprocess executor override for offline deterministic tests. */
  readonly gitExec?: GitExecFn;
  /** Quiet grace period (ms) before emitting deferred background/swarm `state=done`. Default: 2000. */
  readonly backgroundDoneGraceMs?: number;
  /** Quiet drain window (ms) after `session/load` resolves to capture trailing async replay updates. */
  readonly replayDrainQuietMs?: number;
  /** Optional initial terminal row count override (for deterministic Swarm Overview height tests). */
  readonly terminalRows?: number;
  /** Optional delay override (ms) before auto-hiding completed HUD todos (< 0 disables auto-hide). Default: 60000. */
  readonly todoAutoClearDelayMs?: number;
  /** Enable embedded HTTP MCP `todo` tool server injection (default: true). */
  readonly enableTodoMcp?: boolean;
  /** Optional external editor hook override for `/todo edit` in offline tests. */
  readonly editTodoExternal?: (initialMarkdown: string) => Promise<string | null>;
}

function cloneConfig(config: OmaConfig): OmaConfig {
  return {
    agy_bin: config.agy_bin,
    default_model: config.default_model,
    default_thought: config.default_thought,
    default_mode: config.default_mode,
    recent_models: [...(config.recent_models ?? [])],
    ui: {
      auto_collapse_thought: config.ui.auto_collapse_thought,
      collapse_compacted: config.ui.collapse_compacted,
      tool_display: normalizeToolDisplayMode(config.ui.tool_display),
      tool_preview_lines: config.ui.tool_preview_lines,
      todo_provider: normalizeTodoProvider(config.ui.todo_provider),
      osc_7501: config.ui.osc_7501,
      reopen_anchor: config.ui.reopen_anchor,
    },
    approval: {
      auto_allow_tools: [...(config.approval.auto_allow_tools ?? [])],
    },
  };
}

/** Converts an active ACP / `update_steps` plan into read-only display phases for `/todo`. */
function buildDisplayPhasesFromAcpPlan(plan: PlanState | null): TodoPhase[] {
  if (!plan || plan.source !== 'acp') return [];
  const toTodoStatus = (status: string) =>
    status === 'done'
      ? 'completed'
      : status === 'active'
        ? 'in_progress'
        : status === 'dropped' || status === 'blocked'
          ? 'abandoned'
          : 'pending';
  if (plan.phases && plan.phases.length > 0) {
    return plan.phases
      .filter(p => p.items.length > 0)
      .map(phase => ({
        name: phase.title,
        tasks: phase.items.map(item => ({
          content: item.text,
          status: toTodoStatus(item.status),
          ...(item.note
            ? { note: item.note }
            : item.status === 'dropped'
              ? { note: 'skipped' }
              : item.status === 'blocked'
                ? { note: 'failed' }
                : {}),
        })),
      }));
  }
  if (plan.entries.length === 0) return [];
  return [
    {
      name: 'Plan',
      tasks: plan.entries.map(entry => ({
        content: entry.text,
        status: toTodoStatus(entry.status),
        ...(entry.priority
          ? { note: `[${entry.priority}]` }
          : entry.status === 'dropped'
            ? { note: 'skipped' }
            : entry.status === 'blocked'
              ? { note: 'failed' }
              : {}),
      })),
    },
  ];
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'text/typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'text/javascript';
    case '.json':
      return 'application/json';
    case '.md':
    case '.markdown':
      return 'text/markdown';
    case '.toml':
      return 'application/toml';
    case '.yaml':
    case '.yml':
      return 'text/yaml';
    case '.html':
    case '.htm':
      return 'text/html';
    case '.css':
      return 'text/css';
    case '.py':
      return 'text/x-python';
    case '.rs':
      return 'text/x-rust';
    case '.go':
      return 'text/x-go';
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'text/x-shellscript';
    case '.ps1':
      return 'text/plain';
    case '.lua':
    case '.luau':
      return 'text/x-lua';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'text/plain';
  }
}

interface TodoShellToken {
  readonly value: string;
  readonly quoted: boolean;
}

function tokenizeTodoShellArgs(raw: string): TodoShellToken[] {
  const tokens: TodoShellToken[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let hadQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (quote === "'") {
      if (ch === "'") {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (quote === '"') {
      if (ch === '\\' && i + 1 < raw.length) {
        const next = raw[i + 1]!;
        if (next === '"' || next === '\\') {
          cur += next;
          i++;
          continue;
        }
      }
      if (ch === '"') {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === '\\' && i + 1 < raw.length) {
      cur += raw[++i]!;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hadQuotes = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0 || hadQuotes) {
        if (cur.length > 0) {
          tokens.push({ value: cur, quoted: hadQuotes });
        }
        cur = '';
        hadQuotes = false;
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) {
    tokens.push({ value: cur, quoted: hadQuotes });
  }
  return tokens;
}

function splitTodoShellArgs(raw: string): string[] {
  return tokenizeTodoShellArgs(raw).map(t => t.value);
}

function looksBinary(bytes: Uint8Array): boolean {
  const checkLen = Math.min(bytes.byteLength, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function extractMentionedPaths(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const mention of extractFileMentions(text)) {
    if (mention.path && !seen.has(mention.path)) {
      seen.add(mention.path);
      found.push(mention.path);
    }
  }
  return found;
}

const DEFAULT_TERMINAL_TITLE = 'oma · Antigravity';

function formatTerminalTitle(sessionTitle: string | null): string {
  return normalizeSessionTitle(sessionTitle) ?? DEFAULT_TERMINAL_TITLE;
}

interface SessionControlCarryOver {
  readonly modelId: string | null;
  readonly thoughtLevel: string | null;
  readonly modeId: string | null;
}

interface ResumeAnchorHint {
  readonly title?: string;
  readonly titleSource?: SessionTitleSource;
  readonly model?: string;
  readonly thoughtLevel?: string;
  readonly mode?: string;
  readonly todoState?: PersistedSessionTodoState;
}

interface InitialSessionOutcome {
  readonly kind: 'new' | 'resumed';
  readonly epoch: number;
  readonly todoProvider: TodoProvider;
  readonly anchorHint?: ResumeAnchorHint;
}

interface CommittedSessionSnapshot {
  readonly sessionId: string;
  readonly cwd: string;
  readonly title?: string;
  readonly todoProvider: TodoProvider;
}

interface BufferedServerRequest {
  readonly epoch: number;
  readonly sessionId: string;
  readonly req: AcpIncomingRequest;
}

type SessionLifecycle =
  | { readonly phase: 'idle'; readonly epoch: number }
  | {
      readonly phase: 'creating';
      readonly epoch: number;
      provider: TodoProvider | null;
      readonly bufferedUpdates: SessionUpdateParams[];
      readonly carryOver: SessionControlCarryOver | null;
      snapshotApplied: boolean;
    }
  | {
      readonly phase: 'replaying';
      readonly epoch: number;
      readonly targetSessionId: string;
      provider: TodoProvider | null;
      readonly bufferedRequests: BufferedServerRequest[];
    }
  | {
      readonly phase: 'ready';
      readonly epoch: number;
      readonly sessionId: string;
      readonly provider: TodoProvider;
    };

export class AppController {
  readonly store: AppStore;
  readonly session: Session;
  readonly surface: Surface;
  readonly scheduler: RenderScheduler;
  osc: OscWriter;

  readonly #cli: CliOptions;
  #config: OmaConfig;
  readonly #env?: Readonly<Record<string, string | undefined>>;
  readonly #output: SafeTermOutput;
  readonly #acpSpawn?: AcpSpawnFn;
  readonly #previewStore: PreviewStore;
  readonly #fileIndexer: WorkspaceFileIndexer;
  readonly #clipboard: ClipboardService;
  readonly #runLogin?: () => Promise<number>;
  readonly #installSignals: boolean;
  readonly #now: () => number;
  readonly #onExit?: (code: number) => void;
  readonly #swarmDir?: string;
  readonly #baseBrainDir?: string;
  readonly #swarmPollIntervalMs?: number;
  readonly #toolWatchIntervalMs: number;
  readonly #ecosystemRunner?: ExecCommandFn;
  readonly #configPath: string;
  readonly #agySettingsPath: string;
  readonly #workspaceSkillsDir?: string;
  readonly #globalSkillsDir?: string;
  readonly #agentsGlobalSkillsDir?: string;
  readonly #dataDir?: string;
  readonly #gitExec?: GitExecFn;
  readonly #backgroundDoneGraceMs: number;
  readonly #backgroundWakeupGraceMs: number;
  readonly #replayDrainInitialQuietMs: number;
  readonly #replayDrainActiveQuietMs: number;
  readonly #hasExplicitReplayDrainQuietMs: boolean;
  readonly #todoAutoClearDelayMs: number;
  readonly #enableTodoMcpOverride?: boolean;
  readonly #editTodoExternal?: (initialMarkdown: string) => Promise<string | null>;
  readonly #metricsTracker: SessionMetricsTracker;

  #acpClient: AcpClient | null = null;
  #todoServer: EmbeddedTodoMcpServer | null = null;
  #todoExpanded = false;
  #todoHudDismissed = false;
  #todoAutoClearTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  #pendingTodoSyncReminder: string | null = null;
  #hasRestoredUserAnchor = false;
  #preservedAnchorTodoState: {
    readonly sessionId: string;
    readonly todoState: PersistedSessionTodoState;
  } | null = null;
  #swarmWatcher: SwarmBoardWatcher | null = null;
  #swarmWatcherSessionId: string | null = null;
  #lastTpsStoreFlushAt = 0;
  #gitProbeInFlight = false;
  #gitProbePendingForce = false;
  #gitLastProbedAt = 0;
  #gitLastProbedCwd = '';
  #gitOverlayLoadSeq = 0;
  #gitOverlayDiffSeq = 0;
  #authMethods: AuthMethod[] = [];
  #lastFocusedId: string | null | undefined = undefined;
  #workingStartedAt: number | undefined = undefined;
  #pendingBackgroundDone = false;
  #awaitingPostToolWakeup = false;
  #backgroundResumeAnchorStepSeq = 0;
  #backgroundWaitLastProgressAt = 0;
  #awaitingSwarmCoordinatorReply = false;
  #swarmCoordinatorReplied = false;
  #deferredSettleTurnIndex: number | null = null;
  #activePromptTask: Promise<void> | null = null;
  #promptSubmitting = false;
  #acpClientAlive = false;
  #logoutInFlightClient: AcpClient | null = null;
  #reconnectInFlight: Promise<void> | null = null;
  #reconnectSeq = 0;
  #bootstrapSeq = 0;
  #lifecycle: SessionLifecycle = { phase: 'idle', epoch: 0 };
  #lastCommittedSession: CommittedSessionSnapshot | null = null;
  #suppressedMentionPaths = new Set<string>();
  #configWriteBlockedReason: string | null = null;
  #configVerifiedWritable = false;
  #configSaveChain: Promise<void> = Promise.resolve();
  #anchorSaveChains = new Map<string, Promise<void>>();
  #pickerLoadToken = 0;
  #attachmentSeq = 0;
  #shutdownPromise: Promise<void> | null = null;
  #shuttingDown = false;
  #exitCode = 0;
  #welcomeLogoStyleInstalled = false;
  #swarmFxStyleInstalled = false;
  #swarmFxStyleSig = '';
  #lastEmittedTerminalTitle: string = DEFAULT_TERMINAL_TITLE;
  #lastAutoSessionTitle: { readonly sessionId: string; readonly title: string } | null = null;
  #memberBeeBlobDark: boolean | null = null;
  #memberBeeBlobCache: Record<string, BeeMemberBlobPair> = {};
  #doneIdleTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  #backgroundDoneTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  #toolWatchTimer: ReturnType<typeof setInterval> | undefined = undefined;
  #lastWatchedRunningJobs = -1;
  #replayDrainActive = false;
  #replayDrainResolve: (() => void) | null = null;
  #replayDrainReject: ((err: Error) => void) | null = null;
  #replayDrainTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  #replayDrainMaxTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  #signalHandlers:
    | { sigint: () => void; sigterm: () => void; sighup: () => void }
    | undefined = undefined;
  #readyResolve!: () => void;
  readonly readyPromise: Promise<void>;

  constructor(options: AppControllerOptions) {
    this.#cli = options.cli;
    this.#config = cloneConfig(options.config);
    this.#env = options.env;
    this.#output = options.output;
    this.#acpSpawn = options.acpSpawn;
    this.#previewStore = options.previewStore ?? new PreviewStore();
    this.#clipboard = options.clipboard ?? DEFAULT_CLIPBOARD;
    this.#runLogin = options.runLogin;
    this.#installSignals = options.installSignals ?? true;
    this.#now = options.now ?? (() => Date.now());
    this.#onExit = options.onExit;
    this.#swarmDir = options.swarmDir;
    this.#baseBrainDir = options.baseBrainDir;
    this.#swarmPollIntervalMs = options.swarmPollIntervalMs;
    this.#toolWatchIntervalMs = Math.max(10, options.toolWatchIntervalMs ?? 1000);
    this.#ecosystemRunner = options.ecosystemRunner;
    this.#configPath = options.configPath ?? getConfigPath();
    this.#configWriteBlockedReason = options.configParseError ?? null;
    this.#agySettingsPath = options.agySettingsPath ?? getAgySettingsPath();
    this.#workspaceSkillsDir = options.workspaceSkillsDir;
    this.#globalSkillsDir = options.globalSkillsDir;
    this.#agentsGlobalSkillsDir = options.agentsGlobalSkillsDir;
    this.#dataDir = options.dataDir;
    this.#gitExec = options.gitExec;
    this.#backgroundDoneGraceMs = Math.max(
      0,
      options.backgroundDoneGraceMs ?? DEFAULT_BACKGROUND_DONE_GRACE_MS
    );
    this.#backgroundWakeupGraceMs =
      options.backgroundDoneGraceMs !== undefined
        ? this.#backgroundDoneGraceMs
        : Math.max(this.#backgroundDoneGraceMs, DEFAULT_BACKGROUND_WAKEUP_GRACE_MS);
    this.#replayDrainInitialQuietMs =
      options.replayDrainQuietMs !== undefined
        ? Math.max(0, options.replayDrainQuietMs)
        : DEFAULT_REPLAY_DRAIN_INITIAL_QUIET_MS;
    this.#replayDrainActiveQuietMs =
      options.replayDrainQuietMs !== undefined
        ? Math.max(0, options.replayDrainQuietMs)
        : DEFAULT_REPLAY_DRAIN_ACTIVE_QUIET_MS;
    this.#hasExplicitReplayDrainQuietMs = options.replayDrainQuietMs !== undefined;
    this.#todoAutoClearDelayMs =
      options.todoAutoClearDelayMs !== undefined
        ? options.todoAutoClearDelayMs
        : TODO_AUTO_CLEAR_DELAY_MS;
    this.#enableTodoMcpOverride = options.enableTodoMcp;
    this.#editTodoExternal = options.editTodoExternal;
    this.#metricsTracker = new SessionMetricsTracker({
      ...(this.#baseBrainDir ? { baseBrainDir: this.#baseBrainDir } : {}),
      now: this.#now,
    });

    const initialCwd = options.cwd ?? process.cwd();
    this.#fileIndexer = options.fileIndexer ?? new WorkspaceFileIndexer(initialCwd);

    this.session = options.session;
    this.osc = this.#createOscWriter();

    const initialWelcomeLogoBlobId = this.#uploadWelcomeLogo(
      this.session.caps.dark,
      this.session.caps.features
    );
    const initialBeeBlobs = this.#uploadCoreBeeBlobs(
      this.session.caps.dark,
      this.session.caps.features
    );

    const envSource = options.env ?? process.env;
    const autoCompactOverrideRaw =
      envSource['AGY_CLI_AUTO_COMPACT_OVERRIDE']?.trim() || undefined;

    this.store = new AppStore({
      cwd: initialCwd,
      autoAllowTools: this.#config.approval.auto_allow_tools,
      autoCollapseThought: this.#config.ui.auto_collapse_thought,
      collapseCompacted: this.#config.ui.collapse_compacted,
      toolDisplayMode: normalizeToolDisplayMode(this.#config.ui.tool_display),
      recentModels: this.#config.recent_models,
      hour12: this.session.caps.hour12,
      supportsAside: this.session.caps.features.includes('aside'),
      supportsPrefs:
        this.session.caps.kinds.length === 0 || this.session.caps.kinds.includes('prefs'),
      welcomeLogoBlobId: initialWelcomeLogoBlobId,
      ...(options.terminalRows !== undefined ? { terminalRows: options.terminalRows } : {}),
      ...(autoCompactOverrideRaw ? { autoCompactOverrideRaw } : {}),
      now: this.#now,
    });
    if (initialBeeBlobs) {
      this.store.setBeeBlobs(initialBeeBlobs);
    }
    this.store.transcript.setPreferNativeSteps(this.#getEffectiveTodoProvider() === 'native');

    const ready = Promise.withResolvers<void>();
    this.readyPromise = ready.promise;
    this.#readyResolve = ready.resolve;

    // Double-lock native terminal cursor suppression (DECTCEM):
    // 1. Emit `\x1b[?25l` before `session.open()`, AND
    // 2. Immediately after `session.open()`, atomically emit OSC 2 + `\x1b[?25l`
    //    matching native `omp`'s startup sequence so Windows ConPTY never reveals
    //    an orphan vertical bar cursor (`|`).
    this.osc.hideCursor();

    this.surface = this.session.open({
      id: 'oma',
      mode: 'inline',
      chat: true,
      role: 'omp.session',
      title: DEFAULT_TERMINAL_TITLE,
    });

    this.#syncWelcomeLogoStylesheet(this.session.caps.features);

    // Emit OSC 2 pane title + DECTCEM hide cursor immediately after opening the surface.
    this.osc.setTitleAndHideCursor(DEFAULT_TERMINAL_TITLE);

    this.scheduler = new RenderScheduler(
      this.surface,
      () => this.#buildView(),
      {
        throttleMs: options.throttleMs ?? 33,
        onSettled: nodeId => {
          this.store.transcript.markSettled(nodeId);
        },
        onEvicted: nodeIds => {
          this.store.transcript.markEvicted(nodeIds);
        },
      }
    );
  }

  #createOscWriter(): OscWriter {
    return createOscWriter(this.#output, {
      osc7501: this.#config.ui.osc_7501,
      reopenAnchor: this.#config.ui.reopen_anchor,
      osc7: true,
      now: this.#now,
    });
  }

  #recreateOscWriter(): void {
    const wasCursorHidden = this.osc.cursorHidden;
    this.osc = this.#createOscWriter();
    if (wasCursorHidden) {
      this.osc.hideCursor();
    }
  }

  #uploadWelcomeLogo(
    dark: boolean,
    features: readonly string[] = this.session.caps.features
  ): string | undefined {
    if (!features.includes('blobs')) return undefined;
    const asset = getAntigravityLogoAsset(dark);
    return this.session.blob(asset.bytes, asset.mime);
  }

  #uploadCoreBeeBlobs(
    dark: boolean,
    features: readonly string[] = this.session.caps.features
  ): { hud: string; active: string; sleep: string } | undefined {
    if (!features.includes('blobs')) return undefined;
    const assets = getSwarmBeeAssets(dark);
    return {
      hud: this.session.blob(assets.hud.bytes, assets.hud.mime),
      active: this.session.blob(assets.active.bytes, assets.active.mime),
      sleep: this.session.blob(assets.sleep.bytes, assets.sleep.mime),
    };
  }

  #syncAllBeeBlobs(
    dark: boolean = this.session.caps.dark,
    features: readonly string[] = this.session.caps.features,
    snapshot: SwarmBoardSnapshot | null = this.store.getState().swarmSnapshot
  ): void {
    if (!features.includes('blobs')) {
      this.store.clearBeeBlobs();
      return;
    }
    const core = this.#uploadCoreBeeBlobs(dark, features);
    const byMember = this.#buildMemberBeeBlobs(snapshot, dark, features);
    this.store.setBeeBlobs({
      ...(core ?? {}),
      ...(byMember ? { byMember } : {}),
    });
  }

  #buildMemberBeeBlobs(
    snapshot: SwarmBoardSnapshot | null,
    dark: boolean = this.session.caps.dark,
    features: readonly string[] = this.session.caps.features
  ): Record<string, BeeMemberBlobPair> | undefined {
    if (!snapshot || !features.includes('blobs')) return undefined;
    if (this.#memberBeeBlobDark !== dark) {
      this.#memberBeeBlobDark = dark;
      this.#memberBeeBlobCache = {};
    }
    let changed = false;
    for (const member of snapshot.members) {
      if (this.#memberBeeBlobCache[member.name]) continue;
      const pair = getMemberBeeAssetPair(member.name, dark, member.role);
      this.#memberBeeBlobCache[member.name] = {
        active: this.session.blob(pair.active.bytes, pair.active.mime),
        sleep: this.session.blob(pair.sleep.bytes, pair.sleep.mime),
      };
      changed = true;
    }
    if (!changed && this.store.getState().beeMemberBlobs !== undefined) {
      return undefined;
    }
    return { ...this.#memberBeeBlobCache };
  }

  #syncWelcomeLogoStylesheet(features: readonly string[] = this.session.caps.features): void {
    const supportsStyles = features.includes('styles');
    if (supportsStyles && !this.#welcomeLogoStyleInstalled) {
      this.surface.stylesheet('oma-welcome-logo', WELCOME_LOGO_STYLESHEET);
      this.#welcomeLogoStyleInstalled = true;
    } else if (!supportsStyles && this.#welcomeLogoStyleInstalled) {
      this.surface.stylesheet('oma-welcome-logo', null);
      this.#welcomeLogoStyleInstalled = false;
    }
  }

  #syncSwarmFxStylesheet(features: readonly string[] = this.session.caps.features): void {
    const supportsStyles = features.includes('styles');
    const state = this.store.getState();
    const orbitBees = supportsStyles ? resolveOrbitSwarmBees(state) : [];

    if (orbitBees.length > 0) {
      const nextSig = orbitBees.map(b => (b.isWorking ? 'W' : 'S')).join(',');
      if (!this.#swarmFxStyleInstalled || nextSig !== this.#swarmFxStyleSig) {
        this.surface.stylesheet('oma-swarm-fx', buildSwarmBeeEffectCss(orbitBees));
        this.#swarmFxStyleInstalled = true;
        this.#swarmFxStyleSig = nextSig;
      }
    } else if (this.#swarmFxStyleInstalled) {
      this.surface.stylesheet('oma-swarm-fx', null);
      this.#swarmFxStyleInstalled = false;
      this.#swarmFxStyleSig = '';
    }
  }

  get config(): OmaConfig {
    return this.#config;
  }

  get acpClient(): AcpClient | null {
    return this.#acpClient;
  }

  get exitCode(): number {
    return this.#exitCode;
  }

  get activeTodoRouteSessionId(): string | null {
    return this.#todoServer?.committedSessionId ?? null;
  }

  get committedSessionTodoProvider(): TodoProvider | null {
    return this.#lifecycle.phase === 'ready' ? this.#lifecycle.provider : null;
  }

  /**
   * Starts initial render, focuses `EDITOR_NODE_ID`, connects `agy acp`, and runs
   * the main TSP event loop until clean exit or signal shutdown.
   */
  async run(): Promise<number> {
    if (this.#installSignals) {
      this.#registerSignals();
    }

    // Initial render while ACP is initializing: editor has sendable=false, typeahead=true
    this.scheduler.renderNow();
    this.syncFocus(true);
    this.osc.reassertCursorHidden({ force: true });

    // Background warm-ups
    void this.store.history.load().catch(() => {});
    void this.#fileIndexer.start().catch(() => {});
    void this.#refreshGitStatus({ force: true });
    void this.#loadInitialAgySettings();

    // Bootstrap ACP asynchronously so input events & Ctrl+C remain responsive during startup
    const bootstrapTask = this.#bootstrapAcp().finally(() => {
      this.#readyResolve();
    });

    try {
      for await (const input of this.session) {
        if (this.#shuttingDown) break;
        if (input.type === 'key') {
          await this.handleKey(input.key);
        } else {
          await this.handleTspEvent(input.event);
        }
      }
    } finally {
      await bootstrapTask.catch(() => {});
      await this.shutdown({ cleanExit: false, exitCode: this.#exitCode });
    }

    return this.#exitCode;
  }

  /**
   * Synchronizes Tern surface caret focus with the logical focus state machine:
   * - Editor mode -> `surface.focus(EDITOR_NODE_ID)` (`'dock.composer.line.input'`)
   * - Modal `<picker>`, `/help`, `/status`/`/context`/`/usage`/`/logout`, or focused `/settings` -> `surface.focus(null)`
   * - `<questions>` Other input -> `surface.focus('main.questions.<qId>.other')`
   */
  syncFocus(force = false): void {
    const desired = this.store.getDesiredSurfaceFocus('main.questions');
    if (force || desired !== this.#lastFocusedId) {
      this.#lastFocusedId = desired;
      this.surface.focus(desired);
    }
  }

  /**
   * Unified idempotent shutdown sequence (DESIGN.md 4.1, 4.6, 5.1):
   * 1. Cancel any pending permission/elicitation requests
   * 2. On clean exit, clear OSC 1337 reopen anchor & send OSC 7501 state=clear
   * 3. Send `session/close` to `agy acp` (500ms timeout -> proc.kill())
   * 4. Close TSP session (restores raw mode / kitty keyboard / bracketed paste)
   * 5. Restore native terminal cursor (`\x1b[?25h`) before closing SafeTermOutput
   * 6. Arm SafeTermOutput close guard
   */
  async shutdown(options: { cleanExit: boolean; exitCode?: number }): Promise<void> {
    if (this.#shutdownPromise) {
      return this.#shutdownPromise;
    }

    this.#shuttingDown = true;
    if (options.exitCode !== undefined) {
      this.#exitCode = options.exitCode;
    }
    this.#clearDoneIdleTimer();
    this.#clearBackgroundDoneTimer();
    this.#clearToolWatchTimer();
    this.#clearTodoAutoClearTimer();
    this.#todoServer?.dispose();
    this.#todoServer = null;
    this.#cancelReplayDrain();
    this.#cancelPendingReplayedServerRequests();
    this.#stopSwarmWatcher();
    this.#gitProbePendingForce = false;
    this.#metricsTracker.setSession(null);
    this.#lastTpsStoreFlushAt = 0;
    this.#removeSignals();

    this.#shutdownPromise = (async () => {
      try {
        this.store.setConnectionStatus('closing');

        // 1. Reply cancelled to any pending permissions/questions first
        const cancelledPerms = this.store.approvals.cancelAll();
        for (const perm of cancelledPerms) {
          this.store.transcript.resolvePermissionOnTool(perm.toolCallId, 'cancelled');
        }
        this.store.cancelAllQuestions();

        // 2. Clean user-initiated exit clears reopen anchor and OSC 7501 status
        if (options.cleanExit) {
          this.osc.clearReopenAnchor();
          this.osc.setStatusClear();
        }

        // 3. Gracefully close ACP session (500ms timeout -> kill fallback)
        const client = this.#acpClient;
        if (client) {
          const sid = this.store.getState().sessionId ?? undefined;
          if (this.store.getState().isStreaming && sid) {
            await client.cancel(sid).catch(() => {});
          }
          await client.close({ sessionId: sid, timeoutMs: 500 }).catch(() => {});
        }
        if (this.#activePromptTask) {
          await this.#activePromptTask.catch(() => {});
        }
        // Wait for any accepted serialized config and session anchor writes before exiting
        await this.#configSaveChain.catch(() => {});
        await Promise.all([...this.#anchorSaveChains.values()]);

        // 4. Stop background schedulers/indexers
        this.scheduler.dispose();
        this.#fileIndexer.dispose();

        // 5. Close TSP session (flushes final frame, restores raw mode & terminal modes)
        await this.session.close().catch(() => {});
      } finally {
        // 6. Always restore native terminal cursor before guarding output against late writes
        this.osc.showCursor();
        this.#output.close();
        this.#onExit?.(this.#exitCode);
      }
    })();

    return this.#shutdownPromise;
  }

  // -------------------------------------------------------------------------
  // ACP Lifecycle & Bootstrap
  // -------------------------------------------------------------------------

  #resolveAgyBin(): string {
    return this.#cli.agyBin?.trim() || this.#config.agy_bin?.trim() || 'agy';
  }

  #createAcpClient(): AcpClient {
    const extraArgs: string[] = [];
    for (const dir of this.#cli.addDirs) {
      if (dir.trim().length > 0) {
        extraArgs.push('--add-dir', dir);
      }
    }

    const client = new AcpClient({
      agyBin: this.#resolveAgyBin(),
      extraArgs,
      cwd: this.store.getState().cwd,
      ...(this.#env ? { env: this.#env } : {}),
      spawn: this.#acpSpawn,
      closeTimeoutMs: 500,
      onUpdate: params => {
        if (this.#acpClient !== client) return;
        this.#handleAcpUpdate(params);
      },
      onServerRequest: req => {
        if (this.#acpClient !== client) return;
        this.#handleAcpServerRequest(req);
      },
      onTraffic: ev => {
        if (this.#acpClient !== client) return;
        this.#handleAcpTraffic(ev);
      },
      onStderr: line => {
        if (this.#acpClient !== client) return;
        this.store.traffic.recordStderr(line);
      },
      onExit: info => this.#handleAcpExit(info, client),
    });
    return client;
  }

  #isAcpClientLive(client: AcpClient): boolean {
    const status = this.store.getState().connectionStatus;
    return (
      this.#acpClient === client &&
      this.#acpClientAlive &&
      this.#logoutInFlightClient !== client &&
      status !== 'crashed' &&
      status !== 'auth_required' &&
      status !== 'closing'
    );
  }

  #normalizeMentionPathKey(rawPath: string, cwd = this.store.getState().cwd): string {
    const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
    return process.platform === 'win32' ? absPath.toLowerCase() : absPath;
  }

  #removeMentionTokenFromDraft(rawPath: string): void {
    const draftText = this.store.draft.text;
    if (!draftText.includes('@')) return;
    const targetKey = this.#normalizeMentionPathKey(rawPath);
    const ranges: Array<[number, number]> = [];
    for (const mention of extractFileMentions(draftText)) {
      if (
        mention.path !== rawPath &&
        this.#normalizeMentionPathKey(mention.path) !== targetKey
      ) {
        continue;
      }
      let start = mention.start;
      let end = mention.end;
      // Consume at most ONE single space adjacent to the `@path` token so completion's
      // trailing space is cleaned up without ever touching indentation or unrelated spaces.
      if (draftText[end] === ' ') {
        end += 1;
      } else if (
        start > 0 &&
        draftText[start - 1] === ' ' &&
        (end === draftText.length || /[\n\r)\]}"'`,;<>|]/.test(draftText[end]!))
      ) {
        start -= 1;
      }
      ranges.push([start, end]);
    }
    if (ranges.length > 0) {
      this.store.draft.removeRangesPreservingSelection(ranges);
    }
  }

  #resetLifecycleToIdle(
    options: {
      readonly advanceEpoch?: boolean;
      readonly abortError?: Error;
      readonly resetStore?: boolean;
    } = {}
  ): number {
    this.#cancelReplayDrain(options.abortError);
    this.#cancelPendingReplayedServerRequests();
    const nextEpoch = options.advanceEpoch ? this.#lifecycle.epoch + 1 : this.#lifecycle.epoch;
    this.#lifecycle = { phase: 'idle', epoch: nextEpoch };
    this.#todoServer?.revokeSessionRoute();
    if (options.resetStore) {
      this.store.resetSessionState({ keepCommands: true });
      this.#lastAutoSessionTitle = null;
      this.#syncTerminalTitle();
    }
    this.store.setSessionPhase('none');
    if (this.scheduler.suspended) {
      this.scheduler.resumeAfterReplay(false);
    }
    return nextEpoch;
  }

  /**
   * Atomically begin a single-epoch session transition (`creating` for `/new` or
   * initial `session/new`, `replaying` for `/resume` or `session/load`).
   * Cancels any in-flight replay drain, clears stale creation/replay state, and
   * resets session UI state under one unified epoch.
   */
  #beginSessionTransition(
    mode: 'creating' | 'replaying',
    replaySessionId?: string,
    carryOver: SessionControlCarryOver | null = null
  ): number {
    const epoch = this.#lifecycle.epoch + 1;
    this.#cancelReplayDrain(new Error('Superseded by session switch'));
    this.#cancelPendingReplayedServerRequests();
    this.#stopSwarmWatcher();
    this.#clearBackgroundDoneTimer();
    this.#clearToolWatchTimer();
    this.#clearDoneIdleTimer();
    this.#clearTodoAutoClearTimer();
    this.#todoExpanded = false;
    this.#todoHudDismissed = false;
    this.#pendingTodoSyncReminder = null;
    this.#hasRestoredUserAnchor = false;
    this.#preservedAnchorTodoState = null;
    this.#todoServer?.revokeSessionRoute();
    this.#metricsTracker.setSession(null);
    this.#lastTpsStoreFlushAt = 0;
    this.#pendingBackgroundDone = false;
    this.#awaitingPostToolWakeup = false;
    this.#backgroundResumeAnchorStepSeq = 0;
    this.#backgroundWaitLastProgressAt = 0;
    this.#awaitingSwarmCoordinatorReply = false;
    this.#swarmCoordinatorReplied = false;
    this.#deferredSettleTurnIndex = null;
    this.#workingStartedAt = undefined;
    this.#activePromptTask = null;

    this.#lifecycle =
      mode === 'replaying'
        ? {
            phase: 'replaying',
            epoch,
            targetSessionId: replaySessionId ?? '',
            provider: null,
            bufferedRequests: [],
          }
        : {
            phase: 'creating',
            epoch,
            provider: null,
            bufferedUpdates: [],
            carryOver,
            snapshotApplied: false,
          };

    this.store.resetSessionState({ keepCommands: true });
    this.#syncSwarmFxStylesheet();
    this.scheduler.resetSession();

    if (mode === 'replaying') {
      this.scheduler.suspendForReplay();
      this.store.setSessionPhase('replaying');
    } else {
      this.store.setSessionPhase('creating');
      if (this.scheduler.suspended) {
        this.scheduler.resumeAfterReplay(false);
      }
    }

    return epoch;
  }

  #drainPendingNewSessionUpdates(sessionId: string, epoch: number): void {
    if (this.#lifecycle.phase !== 'creating' || this.#lifecycle.epoch !== epoch) {
      return;
    }
    this.#lifecycle.snapshotApplied = true;
    const queued = this.#lifecycle.bufferedUpdates.splice(0);
    for (const params of queued) {
      if (this.#shuttingDown || epoch !== this.#lifecycle.epoch) return;
      const sid =
        typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
          ? params.sessionId.trim()
          : undefined;
      if (sid && sid === sessionId) {
        this.#handleAcpUpdate(params);
      } else {
        this.store.traffic.recordSystem(
          `ignored stale buffered session/update for ${sid ?? 'unknown'} (active: ${sessionId})`,
          params
        );
      }
    }
  }

  async #bootstrapAcp(retrySessionId?: string): Promise<void> {
    if (this.#shuttingDown) return;

    this.store.setConnectionStatus('initializing');
    this.scheduler.renderNow();

    const client = this.#createAcpClient();
    this.#acpClient = client;
    this.#acpClientAlive = true;
    const bootstrapSeq = ++this.#bootstrapSeq;
    const isBootstrapActive = (): boolean =>
      !this.#shuttingDown &&
      bootstrapSeq === this.#bootstrapSeq &&
      this.#isAcpClientLive(client) &&
      this.store.getState().connectionStatus === 'initializing';

    try {
      client.start();
      const initRes = await client.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'oma', version: OMA_VERSION },
        clientCapabilities: {
          elicitation: {
            form: {},
            url: {},
          },
        },
      });
      if (!isBootstrapActive()) return;
      this.#authMethods = initRes.authMethods ?? [];
      this.store.setAgentInitializeInfo(
        initRes.agentInfo,
        initRes.agentCapabilities?.promptCapabilities,
        { supportsLogout: client.supportsLogout }
      );
      this.store.transcript.setPreferNativeSteps(this.#getEffectiveTodoProvider() === 'native');

      const initialOutcome = await this.#openInitialSession(
        client,
        retrySessionId,
        isBootstrapActive
      );
      if (
        !initialOutcome ||
        !isBootstrapActive() ||
        initialOutcome.epoch !== this.#lifecycle.epoch
      ) {
        return;
      }

      if (initialOutcome.kind === 'new') {
        await this.#applyInitialPreferences(client, initialOutcome, Boolean(retrySessionId));
        if (!isBootstrapActive() || initialOutcome.epoch !== this.#lifecycle.epoch) {
          return;
        }
        const readySessionId = this.store.getState().sessionId;
        if (!readySessionId) return;
        this.#commitActiveTodoSessionRoute(
          initialOutcome.epoch,
          readySessionId,
          client,
          initialOutcome.todoProvider
        );
      } else if (!this.store.getState().sessionId) {
        return;
      }

      this.store.markSessionReady();
      this.#restoreOscAfterBlock();
      this.osc.setWorkingDirectory(this.store.getState().cwd);
      await this.#persistSessionAnchorAndOsc();
      if (
        this.#shuttingDown ||
        bootstrapSeq !== this.#bootstrapSeq ||
        !this.#isAcpClientLive(client) ||
        initialOutcome.epoch !== this.#lifecycle.epoch
      ) {
        return;
      }

      // Flush ready frame (`sendable={true} typeahead={false}`)
      this.scheduler.renderNow();
      this.syncFocus();

      if (!retrySessionId) {
        if (this.#cli.sessions) {
          await this.#openPicker('resume', '');
        } else if (this.#cli.initialPrompt) {
          await this.submitInput(this.#cli.initialPrompt);
        }
      }
    } catch (err) {
      const curStatus = this.store.getState().connectionStatus;
      if (
        this.#shuttingDown ||
        bootstrapSeq !== this.#bootstrapSeq ||
        this.#acpClient !== client ||
        this.#logoutInFlightClient === client ||
        curStatus === 'auth_required' ||
        curStatus === 'closing' ||
        (!this.#acpClientAlive && curStatus === 'crashed')
      ) {
        return;
      }
      this.#resetLifecycleToIdle();
      if (err instanceof AcpRpcError && err.isAuthRequired()) {
        this.osc.setStatusBlocked('auth');
        this.store.setAuthRequired({
          message: err.message || 'Please log in to Antigravity before starting a session.',
          authMethods: this.#authMethods,
        });
        this.scheduler.renderNow();
        return;
      }

      const msg = err instanceof Error ? err.message : String(err);
      this.osc.setStatusError();
      this.store.setCrashError({
        message: msg,
        stderrTail: client.getStderrTail(),
      });
      this.scheduler.renderNow();
    }
  }

  async #openInitialSession(
    client: AcpClient,
    retrySessionId: string | undefined,
    isBootstrapActive: () => boolean
  ): Promise<InitialSessionOutcome | null> {
    const cwd = this.store.getState().cwd;

    if (retrySessionId) {
      try {
        const loadedProvider = await this.#loadSessionWithReplay(
          client,
          retrySessionId,
          cwd,
          undefined,
          undefined,
          { startupPreferences: { preferSavedOverCli: true, isBootstrapActive } }
        );
        if (!isBootstrapActive() || !loadedProvider) {
          return null;
        }
        return { kind: 'resumed', epoch: this.#lifecycle.epoch, todoProvider: loadedProvider };
      } catch (err) {
        if (!isBootstrapActive()) return null;
        if (err instanceof AcpRpcError && err.isAuthRequired()) {
          throw err;
        }
        if (err instanceof AcpRpcError && err.isSessionNotFound()) {
          void this.#deleteSessionAnchor(retrySessionId).catch(() => {});
        }
        // Fallback to new session if previous session cannot be reloaded
      }
    }

    if (this.#cli.resume) {
      const target = resolveResumeTarget(this.#cli.resume);
      if (this.#cli.resumeKind === 'fork') {
        this.store.pushToast(
          'agy acp does not support independent fork; safely loading original session.',
          'info'
        );
      }

      if (target.sessionId) {
        const targetCwd = target.cwd || cwd;
        const anchorHint: ResumeAnchorHint = {
          ...(target.title !== undefined ? { title: target.title } : {}),
          ...(target.titleSource !== undefined ? { titleSource: target.titleSource } : {}),
          ...(target.model ? { model: target.model } : {}),
          ...(target.thoughtLevel ? { thoughtLevel: target.thoughtLevel } : {}),
          ...(target.mode ? { mode: target.mode } : {}),
          ...(target.todoState ? { todoState: target.todoState } : {}),
        };
        try {
          const loadedProvider = await this.#loadSessionWithReplay(
            client,
            target.sessionId,
            targetCwd,
            target.title,
            undefined,
            {
              ...(Object.keys(anchorHint).length > 0 ? { anchorHint } : {}),
              startupPreferences: { preferSavedOverCli: false, isBootstrapActive },
            }
          );
          if (!isBootstrapActive() || !loadedProvider) {
            return null;
          }
          return {
            kind: 'resumed',
            epoch: this.#lifecycle.epoch,
            todoProvider: loadedProvider,
            ...(Object.keys(anchorHint).length > 0 ? { anchorHint } : {}),
          };
        } catch (err) {
          if (!isBootstrapActive()) return null;
          if (err instanceof AcpRpcError && err.isAuthRequired()) {
            throw err;
          }
          const isNotFound = err instanceof AcpRpcError && err.isSessionNotFound();
          if (isNotFound) {
            void this.#deleteSessionAnchor(target.sessionId).catch(() => {});
          }
          this.store.pushToast(
            isNotFound
              ? `Session ${target.sessionId} not found (may have been deleted); starting a new session.`
              : `Failed to load session ${target.sessionId}; starting a new session.`,
            'warning'
          );
        }
      } else {
        this.store.pushToast(
          target.error ?? `Unable to read anchor file; starting a new session.`,
          'warning'
        );
      }
    } else if (this.#cli.continue) {
      try {
        const sessions = await client.listAllSessions({ cwd });
        if (!isBootstrapActive()) return null;
        sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
        const latest = sessions[0];
        if (latest) {
          const loadedProvider = await this.#loadSessionWithReplay(
            client,
            latest.sessionId,
            cwd,
            latest.title ?? undefined,
            undefined,
            { startupPreferences: { preferSavedOverCli: false, isBootstrapActive } }
          );
          if (!isBootstrapActive() || !loadedProvider) {
            return null;
          }
          return { kind: 'resumed', epoch: this.#lifecycle.epoch, todoProvider: loadedProvider };
        }
      } catch (err) {
        if (!isBootstrapActive()) return null;
        if (err instanceof AcpRpcError && err.isAuthRequired()) {
          throw err;
        }
        // Fallback to creating a new session
      }
    }

    if (!isBootstrapActive()) return null;
    const createEpoch = this.#beginSessionTransition('creating');
    const { todoProvider: sessionTodoProvider, ...bootstrapOptions } =
      this.#buildSessionBootstrapOptions(createEpoch, client);
    if (this.#lifecycle.phase === 'creating' && this.#lifecycle.epoch === createEpoch) {
      this.#lifecycle.provider = sessionTodoProvider;
    }
    this.store.transcript.setPreferNativeSteps(sessionTodoProvider === 'native');
    try {
      this.#lastAutoSessionTitle = null;
      const created = await client.newSession({
        cwd,
        ...bootstrapOptions,
      });
      if (!isBootstrapActive() || createEpoch !== this.#lifecycle.epoch) {
        return null;
      }
      const createdTier = client.currentTier ?? extractSessionTier(created._meta);
      this.store.applySessionSnapshot({
        sessionId: created.sessionId,
        cwd,
        configOptions: created.configOptions,
        models: created.models,
        modes: created.modes,
        ...(createdTier ? { tier: createdTier } : {}),
      });
      this.#drainPendingNewSessionUpdates(created.sessionId, createEpoch);
      this.#syncTerminalTitle();
      this.#bindSessionMetrics(created.sessionId);
      this.#ensureSwarmWatcher(created.sessionId, { forceRestart: true });
      void this.#refreshGitStatus();
      return { kind: 'new', epoch: createEpoch, todoProvider: sessionTodoProvider };
    } catch (err) {
      if (createEpoch === this.#lifecycle.epoch) {
        this.#resetLifecycleToIdle();
      }
      if (!isBootstrapActive() || createEpoch !== this.#lifecycle.epoch) {
        return null;
      }
      throw err;
    }
  }

  #cancelReplayDrain(abortError?: Error): void {
    this.#replayDrainActive = false;
    if (this.#replayDrainTimer !== undefined) {
      clearTimeout(this.#replayDrainTimer);
      this.#replayDrainTimer = undefined;
    }
    if (this.#replayDrainMaxTimer !== undefined) {
      clearTimeout(this.#replayDrainMaxTimer);
      this.#replayDrainMaxTimer = undefined;
    }
    const resolve = this.#replayDrainResolve;
    const reject = this.#replayDrainReject;
    this.#replayDrainResolve = null;
    this.#replayDrainReject = null;
    if (abortError) {
      reject?.(abortError);
    } else {
      resolve?.();
    }
  }

  #noteReplayDrainActivity(): void {
    if (!this.#replayDrainActive) return;
    if (this.#replayDrainTimer !== undefined) {
      clearTimeout(this.#replayDrainTimer);
      this.#replayDrainTimer = undefined;
    }
    this.#replayDrainTimer = setTimeout(() => {
      this.#cancelReplayDrain();
    }, this.#replayDrainActiveQuietMs);
  }

  /**
   * `agy acp` may resolve the `session/load` JSON-RPC response before its async
   * replay stream finishes pushing all historical `session/update` notifications
   * (especially on long sessions with large `edit_file` diff payloads). Keep
   * `isReplaying = true` and `scheduler` suspended until the trailing burst goes
   * quiet so stdout is drained at full speed without render backpressure or
   * prematurely fusing trailing history into a live streaming turn.
   */
  async #waitForReplayDrain(): Promise<void> {
    if (this.#shuttingDown) {
      return;
    }
    const backendVersion =
      this.store.getState().agentVersion ?? this.store.getState().agentInfo?.version;
    const initialQuietMs =
      !this.#hasExplicitReplayDrainQuietMs && isSemverAtLeast(backendVersion, 1, 5, 15)
        ? Math.min(this.#replayDrainInitialQuietMs, AGY_1_5_15_REPLAY_DRAIN_INITIAL_QUIET_MS)
        : this.#replayDrainInitialQuietMs;
    if (initialQuietMs <= 0) {
      return;
    }
    this.#cancelReplayDrain();
    this.#replayDrainActive = true;
    await new Promise<void>((resolve, reject) => {
      this.#replayDrainResolve = resolve;
      this.#replayDrainReject = reject;
      this.#replayDrainTimer = setTimeout(() => {
        this.#cancelReplayDrain();
      }, initialQuietMs);
      this.#replayDrainMaxTimer = setTimeout(() => {
        this.#cancelReplayDrain();
      }, DEFAULT_REPLAY_DRAIN_MAX_MS);
    });
  }

  async #loadSessionWithReplay(
    client: AcpClient,
    sessionId: string,
    cwd: string,
    knownTitle?: string,
    existingEpoch?: number,
    options?: {
      readonly restoreSavedControls?: boolean;
      readonly anchorHint?: ResumeAnchorHint;
      readonly startupPreferences?: {
        readonly preferSavedOverCli: boolean;
        readonly isBootstrapActive: () => boolean;
      };
      readonly todoProviderOverride?: TodoProvider;
    }
  ): Promise<TodoProvider | null> {
    const loadEpoch =
      existingEpoch !== undefined
        ? existingEpoch
        : this.#beginSessionTransition('replaying', sessionId);
    const { todoProvider: sessionTodoProvider, ...bootstrapOptions } =
      this.#buildSessionBootstrapOptions(loadEpoch, client, options?.todoProviderOverride);
    if (this.#lifecycle.phase === 'replaying' && this.#lifecycle.epoch === loadEpoch) {
      this.#lifecycle.provider = sessionTodoProvider;
    }
    this.store.transcript.setPreferNativeSteps(sessionTodoProvider === 'native');
    const isLoadAborted = (): boolean =>
      this.#shuttingDown ||
      loadEpoch !== this.#lifecycle.epoch ||
      (options?.startupPreferences !== undefined &&
        !options.startupPreferences.isBootstrapActive());
    const abortLoadIfNeeded = (): boolean => {
      if (!isLoadAborted()) return false;
      if (loadEpoch === this.#lifecycle.epoch) {
        this.#resetLifecycleToIdle();
      }
      return true;
    };

    try {
      this.#lastAutoSessionTitle = null;
      const loaded = await client.loadSession({
        sessionId,
        cwd,
        ...bootstrapOptions,
      });

      if (abortLoadIfNeeded()) {
        return null;
      }
      if (!this.#isAcpClientLive(client)) {
        throw new Error('ACP connection closed during session load');
      }

      await this.#waitForReplayDrain();
      if (abortLoadIfNeeded()) {
        return null;
      }
      if (!this.#isAcpClientLive(client)) {
        throw new Error('ACP connection closed during session replay');
      }

      const loadedTier = client.currentTier ?? extractSessionTier(loaded._meta);
      this.store.applySessionSnapshot({
        sessionId: loaded.sessionId,
        cwd,
        ...(knownTitle !== undefined ? { title: knownTitle } : {}),
        configOptions: loaded.configOptions,
        models: loaded.models,
        modes: loaded.modes,
        ...(loadedTier ? { tier: loadedTier } : {}),
      });

      this.#bindSessionMetrics(loaded.sessionId, false);
      await this.#syncSessionMetricsFromTranscript();
      if (abortLoadIfNeeded()) return null;
      if (!this.#isAcpClientLive(client)) {
        throw new Error('ACP connection closed during session restore');
      }

      if (options?.startupPreferences) {
        await this.#applyInitialPreferences(
          client,
          {
            kind: 'resumed',
            epoch: loadEpoch,
            todoProvider: sessionTodoProvider,
            ...(options.anchorHint ? { anchorHint: options.anchorHint } : {}),
          },
          options.startupPreferences.preferSavedOverCli
        );
        if (abortLoadIfNeeded()) return null;
        if (!this.#isAcpClientLive(client)) {
          throw new Error('ACP connection closed during session restore');
        }
      } else if (options?.restoreSavedControls) {
        const savedControls = await this.#resolveResumedSessionControls(
          loaded.sessionId,
          options.anchorHint
        );
        if (abortLoadIfNeeded()) return null;
        if (!this.#isAcpClientLive(client)) {
          throw new Error('ACP connection closed during session restore');
        }
        if (savedControls) {
          await this.#applySessionControls(client, loaded.sessionId, savedControls, loadEpoch, {
            clampInvalidThought: true,
            toastFailurePrefix: 'Failed to carry over',
          });
          if (abortLoadIfNeeded()) return null;
          if (!this.#isAcpClientLive(client)) {
            throw new Error('ACP connection closed during session restore');
          }
        }
      }

      const pendingAnchorSave = this.#anchorSaveChains.get(loaded.sessionId);
      if (pendingAnchorSave) {
        await pendingAnchorSave;
        if (abortLoadIfNeeded()) {
          return null;
        }
        if (!this.#isAcpClientLive(client)) {
          throw new Error('ACP connection closed during session restore');
        }
      }
      const storedAnchorResult = await this.#previewStore
        .loadDetailed(loaded.sessionId)
        .catch(() => ({ status: 'error' as const }));
      if (abortLoadIfNeeded()) {
        return null;
      }
      if (!this.#isAcpClientLive(client)) {
        throw new Error('ACP connection closed during session restore');
      }

      this.store.transcript.finalizeReplayedTurns();
      this.#metricsTracker.markTranscriptBackgroundBaseline();
      const terminalBgRecords = this.#metricsTracker
        .getTranscriptBackgroundTasks()
        .filter(rec => rec.status !== 'running');
      if (terminalBgRecords.length > 0) {
        this.store.transcript.syncTranscriptBackgroundTasks(terminalBgRecords);
      }

      const effectiveAnchor =
        storedAnchorResult.status === 'found'
          ? storedAnchorResult.record
          : storedAnchorResult.status === 'missing'
            ? options?.anchorHint
            : undefined;
      if (effectiveAnchor?.titleSource === 'user' && normalizeSessionTitle(effectiveAnchor.title)) {
        this.store.setSessionTitle(effectiveAnchor.title ?? null, 'user');
      } else if (
        !this.store.getState().sessionTitle &&
        effectiveAnchor?.titleSource === 'auto' &&
        normalizeSessionTitle(effectiveAnchor.title)
      ) {
        this.store.setSessionTitle(effectiveAnchor.title ?? null, 'auto');
      }
      const storedTodoState = effectiveAnchor?.todoState;
      const candidateUserAnchor =
        storedTodoState?.source === 'user' &&
        storedTodoState.toolCallCount >= this.store.transcript.todoToolCallCount
          ? storedTodoState
          : undefined;
      this.#preservedAnchorTodoState = null;
      this.#hasRestoredUserAnchor = false;
      if (candidateUserAnchor !== undefined) {
        if (sessionTodoProvider === 'mcp') {
          const phasesDiffer =
            JSON.stringify(candidateUserAnchor.phases) !==
            JSON.stringify(this.store.transcript.todoPhases);
          this.store.transcript.setTodoPhases(candidateUserAnchor.phases, {
            source: 'user',
            isRestoringSessionAnchor: true,
            restoredAnchorToolCallCount: candidateUserAnchor.toolCallCount,
          });
          this.#hasRestoredUserAnchor = true;
          if (phasesDiffer) {
            this.#pendingTodoSyncReminder = formatUserTodoSyncReminder(
              'resumed session todo state',
              candidateUserAnchor.phases,
              candidateUserAnchor.phases.length === 0
            );
          }
        } else {
          this.#preservedAnchorTodoState = {
            sessionId: loaded.sessionId,
            todoState: {
              phases: cloneTodoPhases(candidateUserAnchor.phases),
              toolCallCount: candidateUserAnchor.toolCallCount,
              source: 'user',
            },
          };
        }
      }
      this.#scheduleTodoAutoClearIfDone();
      void this.#refreshGitStatus({ force: true });

      const bufferedRequests =
        this.#lifecycle.phase === 'replaying' && this.#lifecycle.epoch === loadEpoch
          ? this.#lifecycle.bufferedRequests.splice(0)
          : [];
      this.#commitActiveTodoSessionRoute(
        loadEpoch,
        loaded.sessionId,
        client,
        sessionTodoProvider
      );

      this.store.setReplaying(false);
      this.scheduler.resumeAfterReplay(true);

      // Settle historical completed turns (keep the last turn unsettled so reveal/copy stays crisp)
      const turns = this.store.transcript.getVisibleTranscriptSlice(
        this.store.collapseCompacted
      ).turns;
      let settledAny = false;
      for (let i = 0; i < turns.length - 1; i++) {
        const turn = turns[i];
        if (turn && turn.status !== 'streaming') {
          this.scheduler.settleTurn(turn.index);
          settledAny = true;
        }
      }
      if (settledAny) {
        this.osc.reassertCursorHidden({ force: true });
      }
      this.#drainPendingReplayedServerRequests(bufferedRequests, loaded.sessionId, loadEpoch);
      this.#ensureSwarmWatcher(loaded.sessionId, { forceRestart: true });
      this.#syncTerminalTitle();
      return sessionTodoProvider;
    } catch (err) {
      if (loadEpoch !== this.#lifecycle.epoch) {
        return null;
      }
      this.#resetLifecycleToIdle();
      throw err;
    }
  }

  async #applyInitialPreferences(
    client: AcpClient,
    outcome: InitialSessionOutcome,
    preferSavedOverCli = false
  ): Promise<void> {
    const sessionId = this.store.getState().sessionId;
    if (!sessionId) return;

    if (outcome.kind === 'new') {
      await this.#applySessionControls(
        client,
        sessionId,
        {
          modelId: this.#cli.model?.trim() || this.#config.default_model?.trim() || null,
          thoughtLevel: this.#cli.thought?.trim() || this.#config.default_thought?.trim() || null,
          modeId: this.#cli.mode?.trim() || this.#config.default_mode?.trim() || null,
        },
        outcome.epoch,
        { allowFuzzyModel: true, toastFailurePrefix: 'Failed to apply initial' }
      );
      return;
    }

    const saved = await this.#resolveResumedSessionControls(sessionId, outcome.anchorHint);
    if (
      this.#shuttingDown ||
      !this.#isAcpClientLive(client) ||
      outcome.epoch !== this.#lifecycle.epoch
    ) {
      return;
    }

    const cliModel = preferSavedOverCli ? '' : (this.#cli.model?.trim() || '');
    const cliThought = preferSavedOverCli ? '' : (this.#cli.thought?.trim() || '');
    const cliMode = preferSavedOverCli ? '' : (this.#cli.mode?.trim() || '');

    if (cliModel) {
      await this.#applySessionControls(
        client,
        sessionId,
        {
          modelId: cliModel,
          thoughtLevel: cliThought || this.#config.default_thought?.trim() || null,
        },
        outcome.epoch,
        { allowFuzzyModel: true, toastFailurePrefix: 'Failed to apply initial' }
      );
    } else if (saved?.modelId || saved?.thoughtLevel) {
      await this.#applySessionControls(
        client,
        sessionId,
        { modelId: saved.modelId, thoughtLevel: cliThought || saved.thoughtLevel },
        outcome.epoch,
        { clampInvalidThought: true, toastFailurePrefix: 'Failed to carry over' }
      );
    } else {
      await this.#applySessionControls(
        client,
        sessionId,
        {
          modelId: this.#config.default_model?.trim() || null,
          thoughtLevel: cliThought || this.#config.default_thought?.trim() || null,
        },
        outcome.epoch,
        { allowFuzzyModel: true, toastFailurePrefix: 'Failed to apply initial' }
      );
    }

    if (
      this.#shuttingDown ||
      !this.#isAcpClientLive(client) ||
      outcome.epoch !== this.#lifecycle.epoch
    ) {
      return;
    }

    if (cliMode) {
      await this.#applyMode(cliMode, true);
    } else if (saved?.modeId) {
      await this.#applySessionControls(
        client,
        sessionId,
        { modeId: saved.modeId },
        outcome.epoch,
        { clampInvalidThought: true, toastFailurePrefix: 'Failed to carry over' }
      );
    } else if (this.#config.default_mode?.trim()) {
      await this.#applyMode(this.#config.default_mode.trim(), true);
    }
  }

  #handleAcpTraffic(ev: AcpTrafficEvent): void {
    // AcpClient emits stderr to both onTraffic(direction='stderr') and onStderr(line);
    // skip stderr here and record exclusively via onStderr to avoid duplicates in /log.
    if (ev.direction === 'stderr') return;
    const dir =
      ev.direction === 'out'
        ? 'out'
        : ev.direction === 'in'
          ? 'in'
          : 'system';
    this.store.traffic.push({
      direction: dir,
      summary: ev.summary,
      ...(ev.method !== undefined ? { method: ev.method } : {}),
      ...(ev.id !== undefined && ev.id !== null ? { rpcId: ev.id } : {}),
      ...(ev.raw !== undefined ? { payload: ev.raw } : {}),
    });
  }

  #handleAcpUpdate(params: SessionUpdateParams): void {
    const incomingSessionId =
      typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
        ? params.sessionId.trim()
        : undefined;

    // While `session/new` RPC is still in flight, buffer incoming notifications and replay ONLY
    // those whose `sessionId` matches the newly created session.
    if (this.#lifecycle.phase === 'creating' && !this.#lifecycle.snapshotApplied) {
      if (incomingSessionId && this.#lifecycle.bufferedUpdates.length < 256) {
        this.#lifecycle.bufferedUpdates.push(params);
      } else {
        this.store.traffic.recordSystem(
          `ignored session/update without sessionId during session creation`,
          params
        );
      }
      return;
    }

    const expectedSessionId =
      this.#lifecycle.phase === 'replaying'
        ? this.#lifecycle.targetSessionId
        : this.store.getState().sessionId;
    if (incomingSessionId && (!expectedSessionId || incomingSessionId !== expectedSessionId)) {
      this.store.traffic.recordSystem(
        `ignored stale session/update for ${incomingSessionId} (active: ${expectedSessionId ?? 'none'})`,
        params
      );
      return;
    }

    if (this.#replayDrainActive) {
      this.#noteReplayDrainActivity();
    }
    const prevBusy = this.store.isBusy;
    const isReplayingBefore = this.store.getState().isReplaying;
    const prevSessionTitle = this.store.getState().sessionTitle;
    if (
      params.update.sessionUpdate === 'session_info_update' &&
      typeof params.update.title === 'string'
    ) {
      const normalizedAuto = normalizeSessionTitle(params.update.title);
      const sidForAuto = incomingSessionId || expectedSessionId;
      if (normalizedAuto && sidForAuto) {
        this.#lastAutoSessionTitle = { sessionId: sidForAuto, title: normalizedAuto };
      }
    }
    const prevUsageUsed =
      !isReplayingBefore && params.update.sessionUpdate === 'usage_update'
        ? (this.store.getState().usage?.used ?? 0)
        : 0;
    const prevPlanRef = !isReplayingBefore ? this.store.transcript.plan : null;
    const prevTodoRevision = !isReplayingBefore ? this.store.transcript.todoRevision : 0;
    const prevTodoToolCallCount = !isReplayingBefore
      ? this.store.transcript.todoToolCallCount
      : 0;
    const outcome = this.store.applySessionUpdate(params.update);
    if (!outcome.handled && outcome.unknownUpdateType) {
      this.store.traffic.recordSystem(
        `ignored unknown sessionUpdate: ${outcome.unknownUpdateType}`,
        params.update
      );
      return;
    }

    const isReplaying = this.store.getState().isReplaying;
    const update = params.update;

    if (!isReplaying) {
      if (this.store.getState().sessionTitle !== prevSessionTitle) {
        this.#syncTerminalTitle();
        void this.#persistSessionAnchorAndOsc().catch(() => {});
      }
      const todoRevisionChanged = this.store.transcript.todoRevision !== prevTodoRevision;
      const todoCountChanged =
        this.store.transcript.todoToolCallCount !== prevTodoToolCallCount;
      const nextPlan = this.store.transcript.plan;
      const planChanged = nextPlan !== prevPlanRef;
      if (todoRevisionChanged || todoCountChanged) {
        const activeSessionId = this.store.getState().sessionId;
        if (!this.store.transcript.hasUserTodoOverride) {
          this.#hasRestoredUserAnchor = false;
          if (todoRevisionChanged) {
            this.#pendingTodoSyncReminder = null;
          }
        } else if (this.#hasRestoredUserAnchor) {
          const restoredPhases = this.store.transcript.todoPhases;
          const replayedCleaned = this.store.transcript.replayedTodoPhases.filter(
            phase => phase.tasks.length > 0
          );
          this.#pendingTodoSyncReminder =
            JSON.stringify(restoredPhases) !== JSON.stringify(replayedCleaned)
              ? formatUserTodoSyncReminder(
                  'resumed session todo state',
                  restoredPhases,
                  restoredPhases.length === 0
                )
              : null;
        }
        if (todoRevisionChanged) {
          if (activeSessionId && this.committedSessionTodoProvider === 'mcp') {
            this.#todoServer?.seedSession(activeSessionId, this.store.transcript.todoPhases);
          }
          if (!planChanged) {
            if (this.store.transcript.todoPhases.length === 0) {
              this.#clearTodoAutoClearTimer();
            } else {
              this.#scheduleTodoAutoClearIfDone();
            }
          }
        }
        void this.#persistSessionAnchorAndOsc().catch(() => {});
      }
      if (
        (update.sessionUpdate === 'plan' ||
          update.sessionUpdate === 'plan_update' ||
          update.sessionUpdate === 'tool_call' ||
          update.sessionUpdate === 'tool_call_update') &&
        planChanged
      ) {
        this.#todoHudDismissed = false;
        if (nextPlan === null) {
          this.#clearTodoAutoClearTimer();
        } else {
          this.#scheduleTodoAutoClearIfDone();
        }
      } else if (update.sessionUpdate === 'plan_removed') {
        this.#clearTodoAutoClearTimer();
        this.#todoHudDismissed = false;
      }
      if (update.sessionUpdate === 'usage_update') {
        const nextUsageUsed = this.store.getState().usage?.used ?? 0;
        if (prevUsageUsed >= 1_000 && nextUsageUsed > 0 && nextUsageUsed <= prevUsageUsed * 0.7) {
          void this.#syncSessionMetricsFromTranscript();
        }
      }
      // Live streaming TPS tracking from assistant text & thought deltas
      if (
        update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk'
      ) {
        const content = update.content;
        const deltaText =
          content && content.type === 'text' && typeof content.text === 'string'
            ? content.text
            : '';
        if (deltaText.length > 0) {
          const snap = this.#metricsTracker.recordStreamText(deltaText);
          const now = this.#now();
          const prevMetrics = this.store.getState().sessionMetrics;
          const becameLive =
            snap.currentTps !== null &&
            (!prevMetrics || prevMetrics.currentTps === null || !prevMetrics.isStreamingTps);
          if (becameLive || now - this.#lastTpsStoreFlushAt >= TPS_FLUSH_MIN_INTERVAL_MS) {
            this.#lastTpsStoreFlushAt = now;
            this.#applySessionMetricsSnapshot(snap);
          }
        }
      }

      // Tool call lifecycle hooks: mount swarm watcher, track tool-wait TPS pauses,
      // incrementally tail transcript, and refresh git
      let toolFinishedInThisUpdate = false;
      if (
        update.sessionUpdate === 'tool_call' ||
        update.sessionUpdate === 'tool_call_update'
      ) {
        const upd = update as { name?: unknown; title?: unknown; status?: unknown; args?: unknown; rawInput?: unknown };
        const rawName = typeof upd.name === 'string' ? upd.name.trim().toLowerCase() : '';
        const rawTitle = typeof upd.title === 'string' ? upd.title.trim().toLowerCase() : '';
        const isSwarmWait =
          rawName === 'swarm_wait' ||
          rawTitle === 'swarm_wait' ||
          rawTitle.includes('swarm_wait');
        const isSwarmTool =
          rawName === 'swarm' || rawTitle === 'swarm' || /^swarm[\s:(]/.test(rawTitle);
        const isPostMessage = rawName === 'post_message' || rawTitle === 'post_message';
        if (isSwarmTool || isSwarmWait || isPostMessage) {
          this.#syncSwarmFxStylesheet();
          this.#ensureSwarmWatcher(undefined, { refreshNow: true });
        }
        if (isSwarmWait) {
          this.#awaitingSwarmCoordinatorReply = true;
        }
        if (upd.status === 'completed' || upd.status === 'failed') {
          toolFinishedInThisUpdate = true;
          void this.#syncSessionMetricsFromTranscript();
          void this.#refreshGitStatus();
        }
        if (
          this.store.hasActiveBackgroundTasks() ||
          this.store.isSwarmWorking ||
          this.#isSwarmCoordinatorWorking() ||
          toolFinishedInThisUpdate
        ) {
          this.#metricsTracker.pauseForTools();
        }
        this.#syncToolWatchTimer();
      } else if (update.sessionUpdate === 'notice') {
        const noticeText = extractNoticeText(update);
        if (
          /\bAll\s+your\s+subagents\s+and\s+background\s+tasks\s+have\s+been\s+stopped\b/i.test(
            noticeText
          ) &&
          !this.store.getState().isStreaming &&
          !this.store.hasActiveBackgroundTasks() &&
          !this.store.isSwarmWorking &&
          !this.#isSwarmCoordinatorWorking() &&
          !this.#awaitingSwarmCoordinatorReply
        ) {
          this.#pendingBackgroundDone = false;
          this.#awaitingPostToolWakeup = false;
          this.#backgroundResumeAnchorStepSeq = 0;
          this.#backgroundWaitLastProgressAt = 0;
          this.#clearBackgroundDoneTimer();
          if (!this.store.approvals.hasPending() && !this.store.getState().activeQuestion) {
            this.osc.setStatusIdle();
          }
        }
        this.#syncToolWatchTimer();
      }

      const isThoughtChunk = update.sessionUpdate === 'agent_thought_chunk';
      const isMessageChunk = update.sessionUpdate === 'agent_message_chunk';
      const messageDeltaText =
        isMessageChunk &&
        update.content &&
        update.content.type === 'text' &&
        typeof update.content.text === 'string'
          ? update.content.text
          : '';
      const hasVisibleMessageDelta = isMessageChunk && messageDeltaText.trim().length > 0;
      const isToolRunningUpdate =
        (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
        ((update as { status?: unknown }).status === 'in_progress' ||
          (update as { status?: unknown }).status === 'pending');

      // Only a non-empty, visible `agent_message_chunk` counts as the coordinator's
      // user-facing reply (ignoring empty/whitespace-only keepalive chunks). Track
      // `#swarmCoordinatorReplied` separately from worker idle state so `end_turn` never
      // re-arms `#awaitingSwarmCoordinatorReply` when workers lag behind the reply.
      if (hasVisibleMessageDelta) {
        if (this.#awaitingSwarmCoordinatorReply) {
          this.#awaitingSwarmCoordinatorReply = false;
          this.#swarmCoordinatorReplied = true;
          if (!this.store.getState().isStreaming) {
            this.#pendingBackgroundDone = true;
          }
        } else if (this.store.getState().hasSwarm || this.store.isSwarmWorking) {
          this.#swarmCoordinatorReplied = true;
          if (!this.store.getState().isStreaming) {
            this.#pendingBackgroundDone = true;
          }
        }
      }

      if (
        toolFinishedInThisUpdate &&
        prevBusy &&
        !this.store.getState().isStreaming &&
        !this.store.hasActiveBackgroundTasks() &&
        !this.store.isSwarmWorking &&
        !this.#isSwarmCoordinatorWorking() &&
        !this.#awaitingSwarmCoordinatorReply
      ) {
        // The last background tool just finished; give the model a generous wakeup
        // window (TTFT) before emitting OSC 7501 `state=done`.
        this.#awaitingPostToolWakeup = true;
        this.#backgroundResumeAnchorStepSeq = Math.max(
          this.#backgroundResumeAnchorStepSeq,
          this.#metricsTracker.getLatestTurnActivity()?.latestStepSeq ?? 0
        );
        this.#backgroundWaitLastProgressAt = this.#now();
      }

      this.#reconcileBackgroundActivity(prevBusy);

      // If we are in deferred background/swarm quiet-grace state and live activity arrives
      // (late assistant text/thought, usage_update, or in-progress tool), keep `working`
      // and pick the appropriate grace timer.
      const isUsageAfterReply =
        update.sessionUpdate === 'usage_update' && !this.#awaitingPostToolWakeup;
      const isLiveActivityUpdate =
        isThoughtChunk || isMessageChunk || isToolRunningUpdate || isUsageAfterReply;

      if (this.#pendingBackgroundDone && isLiveActivityUpdate) {
        this.#backgroundWaitLastProgressAt = this.#now();
        if (isMessageChunk && !this.#metricsTracker.hasTranscriptData) {
          this.#awaitingPostToolWakeup = false;
        } else if (isThoughtChunk) {
          this.#awaitingPostToolWakeup = true;
        }
        if (this.#metricsTracker.hasTranscriptData) {
          this.#syncToolWatchTimer();
        }
        const stateAfter = this.store.getState();
        this.#clearDoneIdleTimer();
        if (
          !stateAfter.isStreaming &&
          !this.store.approvals.hasPending() &&
          !stateAfter.activeQuestion
        ) {
          this.osc.setStatusWorking();
        }
        if (
          stateAfter.isStreaming ||
          stateAfter.hasActiveBackgroundTasks ||
          stateAfter.isSwarmWorking ||
          this.#isSwarmCoordinatorWorking() ||
          this.#awaitingSwarmCoordinatorReply
        ) {
          this.#clearBackgroundDoneTimer();
        } else {
          const delayMs = this.#awaitingPostToolWakeup
            ? this.#backgroundWakeupGraceMs
            : this.#backgroundDoneGraceMs;
          this.#scheduleBackgroundDone(delayMs);
        }
      }
    }

    // Coalesce streaming renders via 33ms scheduler (suspended automatically during session/load replay)
    this.scheduler.markDirty();
  }

  #cancelPendingReplayedServerRequests(): void {
    const queued =
      this.#lifecycle.phase === 'replaying' ? this.#lifecycle.bufferedRequests.splice(0) : [];
    if (queued.length === 0) return;
    const client = this.#acpClient;
    if (!client?.isRunning) return;
    for (const item of queued) {
      if (isRequestPermissionRequest(item.req)) {
        void client
          .respondToServerRequest(item.req.id, { outcome: { outcome: 'cancelled' } })
          .catch(() => {});
      } else if (isElicitationCreateRequest(item.req)) {
        void client
          .respondToServerRequest(item.req.id, { action: 'cancel' })
          .catch(() => {});
      }
    }
  }

  #drainPendingReplayedServerRequests(
    queued: readonly BufferedServerRequest[],
    sessionId: string,
    epoch: number
  ): void {
    if (queued.length === 0) return;
    const client = this.#acpClient;
    for (const item of queued) {
      const canMount =
        !this.#shuttingDown &&
        item.epoch === epoch &&
        epoch === this.#lifecycle.epoch &&
        item.sessionId === sessionId &&
        this.store.getState().sessionId === sessionId;
      if (canMount) {
        this.#handleAcpServerRequest(item.req);
      } else if (client?.isRunning) {
        if (isRequestPermissionRequest(item.req)) {
          void client
            .respondToServerRequest(item.req.id, { outcome: { outcome: 'cancelled' } })
            .catch(() => {});
        } else if (isElicitationCreateRequest(item.req)) {
          void client
            .respondToServerRequest(item.req.id, { action: 'cancel' })
            .catch(() => {});
        }
      }
    }
  }

  #handleAcpServerRequest(req: AcpIncomingRequest): void {
    const client = this.#acpClient;
    if (!client) return;

    const reqSessionId =
      req.params && typeof (req.params as { sessionId?: unknown }).sessionId === 'string'
        ? ((req.params as { sessionId: string }).sessionId.trim() || undefined)
        : undefined;
    if (
      reqSessionId &&
      this.#lifecycle.phase === 'replaying' &&
      reqSessionId === this.#lifecycle.targetSessionId &&
      (isRequestPermissionRequest(req) || isElicitationCreateRequest(req))
    ) {
      this.#lifecycle.bufferedRequests.push({
        epoch: this.#lifecycle.epoch,
        sessionId: reqSessionId,
        req,
      });
      this.store.traffic.recordSystem(
        `buffered ${req.method} during session/load replay for ${reqSessionId}`,
        req.params
      );
      return;
    }

    const activeSessionId = this.store.getState().sessionId;
    const isStaleRequestSession = Boolean(
      reqSessionId &&
        (this.#lifecycle.phase === 'creating' ||
          this.#lifecycle.phase === 'replaying' ||
          !activeSessionId ||
          reqSessionId !== activeSessionId)
    );

    if (isRequestPermissionRequest(req)) {
      if (isStaleRequestSession) {
        this.store.traffic.recordSystem(
          `cancelled stale session/request_permission for ${reqSessionId} (active: ${activeSessionId ?? 'none'})`,
          req.params
        );
        void client
          .respondToServerRequest(req.id, { outcome: { outcome: 'cancelled' } })
          .catch(() => {});
        return;
      }
      if (isOmaTodoToolName(req.params.toolCall.name, req.params.toolCall.title)) {
        const options = req.params.options ?? [];
        const allowOpt =
          options.find(o => o.kind === 'allow_once') ??
          options.find(o => o.kind === 'allow_always') ??
          options[0];
        if (allowOpt) {
          void client
            .respondToServerRequest(req.id, {
              outcome: { outcome: 'selected', optionId: allowOpt.optionId },
            })
            .catch(() => {});
          return;
        }
      }
      const thoughtOpts = {
        autoCollapseThought: this.store.autoCollapseThought,
        expandAllTools: this.store.getState().expandAllTools,
      };
      const result = this.store.approvals.enqueue(req.id, req.params, response => {
        void client.respondToServerRequest(req.id, response).catch(() => {});
      });

      if (result.autoAllowed) {
        const tool = this.store.transcript.attachPermissionRequest(
          req.id,
          req.params.toolCall,
          {
            ask: { text: '', allow: 'Allow', deny: 'Deny', always: false },
          },
          thoughtOpts
        );
        this.store.transcript.resolvePermissionOnTool(tool.toolCallId, result.decision);
        this.scheduler.markDirty();
        return;
      }

      this.store.transcript.attachPermissionRequest(
        req.id,
        req.params.toolCall,
        result.item.mapped,
        thoughtOpts
      );
      this.osc.setStatusBlocked('permission');
      this.scheduler.renderNow();
      return;
    }

    if (isElicitationCreateRequest(req)) {
      if (isStaleRequestSession) {
        this.store.traffic.recordSystem(
          `cancelled stale elicitation/create for ${reqSessionId} (active: ${activeSessionId ?? 'none'})`,
          req.params
        );
        void client.respondToServerRequest(req.id, { action: 'cancel' }).catch(() => {});
        return;
      }
      const hadActiveQuestion = this.store.getState().activeQuestion !== null;
      if (!hadActiveQuestion) {
        this.store.transcript.finalizeActiveThoughts({
          autoCollapseThought: this.store.autoCollapseThought,
          expandAllTools: this.store.getState().expandAllTools,
        });
      }
      const card = this.store.openQuestion(req.id, req.params, response => {
        void client.respondToServerRequest(req.id, response).catch(() => {});
      });
      if (!hadActiveQuestion) {
        const firstQ = card.items[0];
        if (firstQ && (!firstQ.choices || firstQ.choices.length === 0) && firstQ.other) {
          this.store.setQuestionFocusedOther(firstQ.id);
        }
        this.osc.setStatusBlocked('question');
        this.scheduler.renderNow();
        if (this.surface && this.session.caps.features.includes('scroll')) {
          this.surface.reveal('main.questions', 'end');
        }
        this.syncFocus();
      } else {
        this.scheduler.renderNow();
      }
      return;
    }

    // Unsupported server request -> JSON-RPC Method Not Found
    void client
      .respondErrorToServerRequest(req.id, -32601, `Unsupported server request: ${req.method}`)
      .catch(() => {});
  }

  #handleAcpExit(info: AcpExitInfo, client?: AcpClient): void {
    if (this.#shuttingDown || info.expected) return;
    if (client && this.#acpClient !== client) return;
    const curStatus = this.store.getState().connectionStatus;
    if (curStatus === 'auth_required' || curStatus === 'closing') {
      this.#acpClientAlive = false;
      return;
    }

    this.#acpClientAlive = false;
    const crashMessage =
      info.error?.message ||
      `agy acp exited unexpectedly${info.code !== null ? ` (exit code ${info.code})` : ''}.`;

    this.#resetLifecycleToIdle({ abortError: new Error(crashMessage) });
    this.#stopSwarmWatcher();
    this.#clearBackgroundDoneTimer();
    this.#pendingBackgroundDone = false;
    this.#awaitingPostToolWakeup = false;
    this.#backgroundResumeAnchorStepSeq = 0;
    this.#backgroundWaitLastProgressAt = 0;
    this.#awaitingSwarmCoordinatorReply = false;
    this.#swarmCoordinatorReplied = false;
    this.#deferredSettleTurnIndex = null;
    this.#workingStartedAt = undefined;
    this.store.transcript.cancelActiveBackgroundTasks('cancelled');

    const cancelledPerms = this.store.approvals.cancelAll();
    for (const perm of cancelledPerms) {
      this.store.transcript.resolvePermissionOnTool(perm.toolCallId, 'cancelled');
    }
    const wasStreaming = this.store.getState().isStreaming;
    if (wasStreaming || this.store.transcript.activeTurn !== undefined) {
      this.store.transcript.finishActiveTurn(undefined, 'error', undefined, {
        autoCollapseThought: this.store.autoCollapseThought,
        expandAllTools: this.store.getState().expandAllTools,
      });
    }

    this.osc.setStatusError();
    this.store.setCrashError({
      message: crashMessage,
      stderrTail: info.stderrTail,
      exitCode: info.code,
    });
    this.store.cancelAllQuestions();
    if (this.#metricsTracker.isStreaming) {
      const endedSnap = this.#metricsTracker.endStreamTurn();
      this.#applySessionMetricsSnapshot(endedSnap);
    }

    this.#syncSwarmFxStylesheet();
    if (this.scheduler.suspended) {
      this.scheduler.resumeAfterReplay(false);
    } else {
      this.scheduler.renderNow(true);
    }
    this.syncFocus();
  }

  // -------------------------------------------------------------------------
  // TSP Event & Keyboard Routing (DESIGN.md 4.3.2)
  // -------------------------------------------------------------------------

  async handleTspEvent(event: TspEvent): Promise<void> {
    if (event.ev === 'gone') {
      this.#handleGoneEvent(event);
      return;
    }
    if (event.ev === 'error') {
      this.#handleErrorEvent(event);
      return;
    }
    if (event.ev === 'focus') {
      this.#handleFocusEvent(event);
      return;
    }
    if (event.ev === 'features') {
      this.store.setSupportsAside(event.features.includes('aside'));
      this.store.setWelcomeLogoBlobId(
        this.#uploadWelcomeLogo(this.session.caps.dark, event.features)
      );
      this.#syncAllBeeBlobs(this.session.caps.dark, event.features);
      this.#syncWelcomeLogoStylesheet(event.features);
      this.#syncSwarmFxStylesheet(event.features);
      this.scheduler.renderNow();
      this.syncFocus();
      this.osc.reassertCursorHidden();
      return;
    }
    if (event.ev === 'theme') {
      this.store.setWelcomeLogoBlobId(this.#uploadWelcomeLogo(event.dark));
      this.#syncAllBeeBlobs(event.dark, this.session.caps.features);
      this.scheduler.renderNow();
      this.osc.reassertCursorHidden();
      return;
    }
    if (event.ev === 'resize') {
      const eventRows = (event as { rows?: unknown }).rows;
      if (typeof eventRows === 'number' && Number.isFinite(eventRows) && eventRows > 0) {
        this.store.setTerminalRows(eventRows);
      } else if (typeof process.stdout?.rows === 'number' && process.stdout.rows > 0) {
        this.store.setTerminalRows(process.stdout.rows);
      }
      this.scheduler.renderNow();
      this.osc.reassertCursorHidden();
      return;
    }
    if (event.ev === 'motion') {
      this.scheduler.renderNow();
      return;
    }
  }

  #handleGoneEvent(event: GoneEvent): void {
    if (event.sf !== undefined && event.sf !== this.surface.id) {
      return;
    }
    const evicted = this.scheduler.handleGone(event);
    if (evicted.length > 0) {
      this.store.traffic.recordSystem(`Tern evicted nodes: ${evicted.join(', ')}`);
    }
  }

  #handleErrorEvent(event: ErrorEvent): void {
    this.store.traffic.recordTernError({
      message: event.msg,
      id: event.id,
      detail: event.raw,
    });
    if (process.env['OMA_DEV'] === '1') {
      this.store.pushToast(`TSP error: ${event.msg}`, 'warning');
      this.scheduler.markDirty();
    }
  }

  #handleFocusEvent(event: FocusEvent): void {
    const prevMode = this.store.getFocusMode();
    const allowed = this.store.handleSurfaceFocusEvent(event.id);
    if (allowed !== null) {
      this.#lastFocusedId = allowed;
      this.surface.focus(allowed);
      if (this.store.getFocusMode() !== prevMode) {
        this.scheduler.renderNow();
      }
      this.osc.reassertCursorHidden();
      return;
    }
    if (this.store.getFocusMode() !== prevMode) {
      this.scheduler.renderNow();
      this.syncFocus();
    }
    this.osc.reassertCursorHidden();
  }

  /**
   * Key priority routing strictly matching DESIGN.md 4.3.2:
   * 1. Global Ctrl+C (cancel turn / clear draft / 2s double-press exit)
   * 2. Modal `<picker>`, `/status`/`/context`/`/usage`/`/logout` info overlay, `/help`, or focused `/settings` `<prefs>`
   * 3. Active `<questions>` card
   * 4. Caret completion popup (`/` or `@`)
   * 5. Pending tool permission shortcuts (`y`/`a`/`n` ONLY when draft is empty)
   * 6. Normal editor interaction (Enter, Alt+P, Ctrl+T, Ctrl+O, F5, Shift+Tab, Alt+S, Esc, Ctrl+V, DraftEngine, Up/Down history)
   */
  async handleKey(key: Key): Promise<void> {
    const name = key.name.toLowerCase();

    // Priority 1: Global Ctrl+C
    if (name === 'c' && key.ctrl && !key.alt && !key.meta) {
      await this.#handleCtrlC();
      return;
    }

    const state = this.store.getState();

    // Clean exit on Ctrl+D when idle, no modal, and draft is empty (DESIGN.md 4.6 #3)
    if (
      name === 'd' &&
      key.ctrl &&
      !key.alt &&
      !key.meta &&
      !state.isBusy &&
      !state.picker &&
      !state.swarmBoardOpen &&
      !state.gitOverlay &&
      !state.infoOverlay &&
      !state.helpOpen &&
      !(state.settings && state.focusMode === 'settings') &&
      !state.activeQuestion &&
      this.store.draft.isEmpty()
    ) {
      await this.shutdown({ cleanExit: true, exitCode: 0 });
      return;
    }

    // Priority 2a: Modal <picker>
    if (state.picker) {
      await this.#handlePickerKey(key);
      return;
    }

    // Priority 2b: Dedicated native `agy`-style Swarm Board overlay
    if (state.swarmBoardOpen) {
      await this.#handleSwarmBoardKey(key);
      return;
    }

    // Priority 2b+: Fullscreen Git UI (`omp.app.git`)
    if (state.gitOverlay) {
      await this.#handleGitOverlayKey(key);
      return;
    }

    // Priority 2c: Modal info overlay (`/status`, `/context`, `/usage`, `/jobs`, `/logout`)
    if (state.infoOverlay) {
      if (name === 'escape' || name === 'q') {
        this.#closeInfoOverlay();
        return;
      }
      if (state.infoOverlay.kind === 'jobs') {
        const snapshot = this.store.transcript.getBackgroundJobsSnapshot();
        const items = snapshot.all;
        if (name === 'up' || (name === 'p' && key.ctrl) || (name === 'k' && !key.ctrl && !key.alt && !key.meta)) {
          if (items.length > 0) {
            const curIdx = items.findIndex(j => j.id === state.infoOverlay?.selectedJobId);
            const nextIdx = ((curIdx < 0 ? 0 : curIdx) - 1 + items.length) % items.length;
            this.store.setSelectedJobId(items[nextIdx]?.id);
            this.scheduler.renderNow();
          }
          return;
        }
        if (name === 'down' || (name === 'n' && key.ctrl) || (name === 'j' && !key.ctrl && !key.alt && !key.meta)) {
          if (items.length > 0) {
            const curIdx = items.findIndex(j => j.id === state.infoOverlay?.selectedJobId);
            const nextIdx = ((curIdx < 0 ? -1 : curIdx) + 1) % items.length;
            this.store.setSelectedJobId(items[nextIdx]?.id);
            this.scheduler.renderNow();
          }
          return;
        }
        if (name === 'd' && !key.ctrl && !key.alt && !key.meta) {
          const selected =
            items.find(j => j.id === state.infoOverlay?.selectedJobId) ?? items[0];
          if (
            selected &&
            selected.status === 'running' &&
            selected.endedAt === undefined &&
            !selected.isDaemon &&
            !state.isStreaming
          ) {
            this.#detachBackgroundJob(selected.id);
          }
          return;
        }
        if (name === 'x' && !key.ctrl && !key.alt && !key.meta) {
          const selected =
            items.find(j => j.id === state.infoOverlay?.selectedJobId) ?? items[0];
          if (
            selected &&
            selected.status === 'running' &&
            selected.endedAt === undefined &&
            (state.isStreaming || (!selected.isDaemon && state.isBusy))
          ) {
            await this.cancelPendingAndTurn();
          }
          return;
        }
        return;
      }
      if (name === 'enter') {
        if (state.infoOverlay.kind === 'logout_confirm') {
          if (state.supportsLogout) {
            await this.#performLogout();
          } else {
            this.#closeInfoOverlay();
          }
        } else {
          this.#closeInfoOverlay();
        }
        return;
      }
      return;
    }

    // Priority 2d: Modal /help overlay
    if (state.helpOpen) {
      if (name === 'escape' || name === 'enter' || name === 'q') {
        this.store.closeHelp();
        this.scheduler.renderNow();
        this.syncFocus();
      }
      return;
    }

    // Priority 2e: Focused `/settings` `<prefs>` panel (modal or focused aside)
    if (state.settings && state.focusMode === 'settings') {
      await this.#handleSettingsKey(key);
      return;
    }

    // Priority 3: Active <questions>
    if (state.activeQuestion) {
      const consumed = await this.#handleQuestionKey(key);
      if (consumed) return;
    }

    // Priority 4: Caret completion popup (`/` or `@`)
    if (state.completion.open) {
      if (name === 'up' && !key.ctrl && !key.alt && !key.meta) {
        this.store.moveCompletionSelection(-1);
        this.scheduler.renderNow();
        return;
      }
      if (name === 'down' && !key.ctrl && !key.alt && !key.meta) {
        this.store.moveCompletionSelection(1);
        this.scheduler.renderNow();
        return;
      }
      if (name === 'escape') {
        this.store.dismissCompletion();
        this.scheduler.renderNow();
        return;
      }
      if (name === 'tab' && !key.shift && !key.ctrl && !key.alt && !key.meta) {
        await this.#acceptCompletion('tab');
        return;
      }
      if (name === 'enter' && !key.shift && !key.alt && !key.ctrl && !key.meta) {
        await this.#acceptCompletion('enter');
        return;
      }
    }

    // Priority 5: Permission approval shortcuts ONLY when draft is empty (DESIGN.md 4.3.2 #5)
    if (
      this.store.approvals.hasPending() &&
      this.store.draft.isEmpty() &&
      !key.ctrl &&
      !key.alt &&
      !key.meta
    ) {
      if (name === 'y') {
        this.handleApprovalDecision('allow');
        return;
      }
      if (name === 'a') {
        const head = this.store.approvals.peek();
        if (head?.mapped.allowAlways) {
          this.handleApprovalDecision('always');
          return;
        }
      }
      if (name === 'n') {
        this.handleApprovalDecision('deny');
        return;
      }
    }

    // Priority 6: Regular editor & controller shortcuts
    if (name === 'enter' && !key.shift && !key.alt && !key.ctrl && !key.meta) {
      const text = this.store.draft.text;
      if (text.trim().length > 0 || state.pendingAttachments.length > 0) {
        await this.submitInput(text);
      }
      return;
    }

    if (name === 'p' && key.alt && !key.ctrl && !key.meta) {
      await this.#openPicker('model', '');
      return;
    }

    if (name === 't' && key.ctrl && !key.alt && !key.meta) {
      const shown = this.store.toggleShowThinking();
      this.store.pushToast(
        shown ? 'Thinking blocks shown' : 'Thinking blocks hidden',
        'info',
        { ttl: 1800 }
      );
      this.scheduler.renderNow();
      return;
    }

    if (name === 'o' && key.ctrl && key.shift && !key.alt && !key.meta) {
      const nextMode = this.store.toggleToolVisibility();
      this.#config = {
        ...this.#config,
        ui: { ...this.#config.ui, tool_display: nextMode },
      };
      const label =
        nextMode === 'hidden'
          ? 'Tool activity hidden (Ctrl+Shift+O to show)'
          : nextMode === 'compact'
            ? 'Tool activity shown (Compact)'
            : 'Tool activity shown (All)';
      this.store.pushToast(label, 'info', { ttl: 2000 });
      this.scheduler.renderNow();
      void this.#saveConfigSafe();
      return;
    }

    if (name === 'o' && key.ctrl && !key.shift && !key.alt && !key.meta) {
      const expanded = this.store.toggleExpandAllTools();
      this.store.pushToast(
        expanded ? 'Expanded all tool outputs' : 'Collapsed tool outputs',
        'info',
        { ttl: 1800 }
      );
      this.scheduler.renderNow();
      return;
    }

    if (name === 'o' && key.alt && !key.ctrl && !key.meta) {
      const nextMode = this.store.cycleToolDisplayMode();
      this.#config = {
        ...this.#config,
        ui: { ...this.#config.ui, tool_display: nextMode },
      };
      const label =
        nextMode === 'all'
          ? 'Tool calls: All (full previews)'
          : nextMode === 'compact'
            ? 'Tool calls: Compact (inline rows)'
            : 'Tool calls: Hidden (completed runs hidden)';
      this.store.pushToast(label, 'info', { ttl: 2000 });
      this.scheduler.renderNow();
      void this.#saveConfigSafe();
      return;
    }

    if (name === 'f5' && !key.ctrl && !key.alt && !key.meta) {
      await this.#handleRetryShortcut();
      return;
    }

    if (name === 'tab' && key.shift && !key.ctrl && !key.alt && !key.meta) {
      await this.cycleMode();
      return;
    }

    if (name === 's' && key.alt && !key.ctrl && !key.meta) {
      await this.#openSwarmBoard('');
      return;
    }

    if (name === 'escape') {
      if (state.settings && state.supportsAside && !state.isBusy && !this.store.approvals.hasPending()) {
        this.#closeSettings();
        return;
      }
      await this.cancelPendingAndTurn();
      return;
    }

    if (name === 'v' && key.ctrl && !key.alt && !key.meta) {
      await this.#handleCtrlV();
      return;
    }

    const res = this.store.draft.handleKey(key);
    if (res.handled) {
      if (res.changed) {
        this.store.clearCtrlCArm();
        this.store.history.resetNavigation();
        this.#refreshCompletion();
        this.scheduler.renderNow();
      }
      return;
    }

    // Up/Down boundary pass-through -> input history navigation
    if (name === 'up' && !key.ctrl && !key.alt && !key.meta) {
      const prev = this.store.history.previous(this.store.draft.text);
      if (prev !== null) {
        this.store.draft.setText(prev);
        this.#refreshCompletion();
        this.scheduler.renderNow();
      }
      return;
    }

    if (name === 'down' && !key.ctrl && !key.alt && !key.meta) {
      const next = this.store.history.next();
      if (next !== null) {
        this.store.draft.setText(next);
        this.#refreshCompletion();
        this.scheduler.renderNow();
      }
    }
  }

  async #handleCtrlC(): Promise<void> {
    const state = this.store.getState();

    if (state.isBusy || this.store.approvals.hasPending() || state.activeQuestion) {
      this.store.clearCtrlCArm();
      await this.cancelPendingAndTurn();
      return;
    }

    if (state.picker) {
      await this.#closePicker({ commitModelThinking: true });
      return;
    }

    if (state.swarmBoardOpen) {
      this.#closeSwarmBoard();
      return;
    }

    if (state.infoOverlay) {
      this.#closeInfoOverlay();
      return;
    }

    if (state.helpOpen) {
      this.store.closeHelp();
      this.scheduler.renderNow();
      this.syncFocus();
      return;
    }

    if (state.settings && state.focusMode === 'settings') {
      this.#closeSettings();
      return;
    }

    if (!this.store.draft.isEmpty()) {
      this.store.clearCtrlCArm();
      this.store.draft.clear(true);
      this.#refreshCompletion();
      this.scheduler.renderNow();
      return;
    }

    if (this.store.isCtrlCExitArmed()) {
      await this.shutdown({ cleanExit: true, exitCode: 0 });
      return;
    }

    this.store.armCtrlCExit(2000);
    this.store.pushToast('Press Ctrl+C again within 2s to exit', 'info', { ttl: 2000 });
    this.scheduler.renderNow();
  }

  async #handleSwarmBoardKey(key: Key): Promise<void> {
    const state = this.store.getState();
    if (!state.swarmBoardOpen) return;

    const name = key.name.toLowerCase();

    if (name === 'escape' || (name === 's' && key.alt && !key.ctrl && !key.meta)) {
      this.#closeSwarmBoard();
      return;
    }

    if (name === 'r' && key.ctrl && !key.alt && !key.meta) {
      void this.#refreshSwarmBoard();
      return;
    }

    if (name === 'up' || (name === 'p' && key.ctrl)) {
      this.store.moveSwarmPostSelection(-1);
      this.scheduler.renderNow();
      return;
    }

    if (name === 'down' || (name === 'n' && key.ctrl)) {
      this.store.moveSwarmPostSelection(1);
      this.scheduler.renderNow();
      return;
    }

    if (name === 'tab' && !key.ctrl && !key.alt && !key.meta) {
      const snapshot = state.swarmSnapshot;
      if (!snapshot) return;
      const activeNames = snapshot.members.filter(m => !m.killed).map(m => m.name);
      const order: Array<string | null> = [null, ...activeNames];
      const curIdx = order.indexOf(state.swarmBoardFilterAgent);
      const delta = key.shift ? -1 : 1;
      const next = order[(curIdx + delta + order.length) % order.length] ?? null;
      this.store.toggleSwarmAgentFilter(next);
      this.scheduler.renderNow();
      return;
    }

    if (name === 'backspace') {
      const cur = state.swarmBoardQuery;
      if (cur.length > 0) {
        const prev = prevCodePointOffset(cur, cur.length);
        this.store.setSwarmBoardQuery(cur.slice(0, prev));
        this.scheduler.renderNow();
      }
      return;
    }

    if (name === 'u' && key.ctrl) {
      if (state.swarmBoardQuery.length > 0) {
        this.store.setSwarmBoardQuery('');
        this.scheduler.renderNow();
      }
      return;
    }

    if (name === 'paste' && key.text) {
      const clean = key.text.replace(/[\r\n]+/g, ' ');
      if (clean.length > 0) {
        this.store.setSwarmBoardQuery(state.swarmBoardQuery + clean);
        this.scheduler.renderNow();
      }
      return;
    }

    if (!key.ctrl && !key.alt && !key.meta && key.text && key.text.length > 0) {
      this.store.setSwarmBoardQuery(state.swarmBoardQuery + key.text);
      this.scheduler.renderNow();
    }
  }

  async #handlePickerKey(key: Key): Promise<void> {
    const state = this.store.getState();
    const picker = state.picker;
    if (!picker) return;

    const name = key.name.toLowerCase();
    const computed = computePickerData(state, picker, this.store.traffic.list(), this.#now());

    if (name === 'escape') {
      await this.#closePicker({ commitModelThinking: true });
      return;
    }

    if (picker.kind === 'model' && name === 'p' && key.alt && !key.ctrl && !key.meta) {
      await this.#closePicker({ commitModelThinking: true });
      return;
    }

    if (picker.kind === 'swarm' && name === 's' && key.alt && !key.ctrl && !key.meta) {
      await this.#closePicker();
      return;
    }

    if (name === 'r' && key.ctrl && !key.alt && !key.meta) {
      if (picker.kind === 'swarm') {
        void this.#refreshSwarmBoard();
      } else if (picker.kind === 'mcp') {
        void this.#loadMcpPickerItems(++this.#pickerLoadToken);
      } else if (picker.kind === 'plugins') {
        void this.#loadPluginsPickerItems(++this.#pickerLoadToken);
      } else if (picker.kind === 'skills') {
        void this.#loadSkillsPickerItems(++this.#pickerLoadToken);
      } else if (picker.kind === 'agents') {
        void this.#loadAgentsPickerItems(++this.#pickerLoadToken);
      }
      return;
    }

    if (name === 'tab') {
      this.store.togglePickerScope();
      const updated = computePickerData(
        this.store.getState(),
        this.store.getState().picker!,
        this.store.traffic.list(),
        this.#now()
      );
      this.store.setPickerSelected(updated.selectedId ?? null);
      this.scheduler.renderNow();
      return;
    }

    if (name === 'up' || (name === 'p' && key.ctrl)) {
      const ids = computed.visibleIds;
      if (ids.length > 0) {
        const curIdx = computed.selectedId ? ids.indexOf(computed.selectedId) : 0;
        const nextIdx = (curIdx - 1 + ids.length) % ids.length;
        this.store.setPickerSelected(ids[nextIdx] ?? null);
        this.scheduler.renderNow();
      }
      return;
    }

    if (name === 'down' || (name === 'n' && key.ctrl)) {
      const ids = computed.visibleIds;
      if (ids.length > 0) {
        const curIdx = computed.selectedId ? ids.indexOf(computed.selectedId) : -1;
        const nextIdx = (curIdx + 1) % ids.length;
        this.store.setPickerSelected(ids[nextIdx] ?? null);
        this.scheduler.renderNow();
      }
      return;
    }

    if (name === 'enter') {
      if (computed.selectedId) {
        await this.#activatePickerItem(picker.kind, computed.selectedId);
      }
      return;
    }

    // In compact `/model` (and Orchestrator `planner` / `executor`) picker:
    // - Unmodified Left/Right steps the inline Thinking effort `level` slider
    // - Alt/Ctrl + Left/Right moves the search query cursor
    if (
      (picker.kind === 'model' || picker.kind === 'planner' || picker.kind === 'executor') &&
      (name === 'left' || name === 'right')
    ) {
      if (!key.ctrl && !key.alt && !key.meta) {
        this.store.stepModelPickerThinking(name === 'left' ? -1 : 1);
        this.scheduler.renderNow();
        return;
      }
      const nextCursor =
        name === 'left'
          ? prevCodePointOffset(picker.query, picker.cursor)
          : nextCodePointOffset(picker.query, picker.cursor);
      this.store.updatePickerQuery(picker.query, nextCursor);
      this.scheduler.renderNow();
      return;
    }

    // Query editing inside modal picker (surrogate-pair safe via prevCodePointOffset/nextCodePointOffset)
    if (name === 'backspace') {
      if (picker.cursor > 0) {
        const prev = prevCodePointOffset(picker.query, picker.cursor);
        const nextQ = picker.query.slice(0, prev) + picker.query.slice(picker.cursor);
        this.#updatePickerQueryAndSelection(nextQ, prev);
      }
      return;
    }

    if (name === 'delete') {
      if (picker.cursor < picker.query.length) {
        const next = nextCodePointOffset(picker.query, picker.cursor);
        const nextQ = picker.query.slice(0, picker.cursor) + picker.query.slice(next);
        this.#updatePickerQueryAndSelection(nextQ, picker.cursor);
      }
      return;
    }

    if (name === 'left') {
      this.store.updatePickerQuery(
        picker.query,
        prevCodePointOffset(picker.query, picker.cursor)
      );
      this.scheduler.renderNow();
      return;
    }

    if (name === 'right') {
      this.store.updatePickerQuery(
        picker.query,
        nextCodePointOffset(picker.query, picker.cursor)
      );
      this.scheduler.renderNow();
      return;
    }

    if (name === 'home' || (name === 'a' && key.ctrl)) {
      this.store.updatePickerQuery(picker.query, 0);
      this.scheduler.renderNow();
      return;
    }

    if (name === 'end' || (name === 'e' && key.ctrl)) {
      this.store.updatePickerQuery(picker.query, picker.query.length);
      this.scheduler.renderNow();
      return;
    }

    if (name === 'u' && key.ctrl) {
      this.#updatePickerQueryAndSelection('', 0);
      return;
    }

    if (name === 'paste' && key.text) {
      const clean = key.text.replace(/[\r\n]+/g, ' ');
      const nextQ =
        picker.query.slice(0, picker.cursor) + clean + picker.query.slice(picker.cursor);
      this.#updatePickerQueryAndSelection(nextQ, picker.cursor + clean.length);
      return;
    }

    if (!key.ctrl && !key.alt && !key.meta && key.text && key.text.length > 0) {
      const nextQ =
        picker.query.slice(0, picker.cursor) + key.text + picker.query.slice(picker.cursor);
      this.#updatePickerQueryAndSelection(nextQ, picker.cursor + key.text.length);
    }
  }

  async #handleSettingsKey(key: Key): Promise<void> {
    const state = this.store.getState();
    const settings = state.settings;
    if (!settings) return;

    const name = key.name.toLowerCase();

    // 1. Inline text editing inside `<prefs>`
    if (settings.editing) {
      const editing = settings.editing;
      const draft = editing.draft ?? '';
      const cursor = Math.max(0, Math.min(draft.length, editing.cursor ?? draft.length));

      if (name === 'escape') {
        this.store.setSettingsEditing(null);
        this.scheduler.renderNow();
        return;
      }
      if (name === 'enter') {
        const rowId = editing.row;
        this.store.setSettingsEditing(null);
        await this.#handleSettingsChange(rowId, draft);
        return;
      }
      if (name === 'backspace') {
        if (cursor > 0) {
          const prev = prevCodePointOffset(draft, cursor);
          this.store.setSettingsEditing({
            ...editing,
            draft: draft.slice(0, prev) + draft.slice(cursor),
            cursor: prev,
          });
          this.scheduler.renderNow();
        }
        return;
      }
      if (name === 'delete') {
        if (cursor < draft.length) {
          const next = nextCodePointOffset(draft, cursor);
          this.store.setSettingsEditing({
            ...editing,
            draft: draft.slice(0, cursor) + draft.slice(next),
            cursor,
          });
          this.scheduler.renderNow();
        }
        return;
      }
      if (name === 'left') {
        this.store.setSettingsEditing({
          ...editing,
          cursor: prevCodePointOffset(draft, cursor),
        });
        this.scheduler.renderNow();
        return;
      }
      if (name === 'right') {
        this.store.setSettingsEditing({
          ...editing,
          cursor: nextCodePointOffset(draft, cursor),
        });
        this.scheduler.renderNow();
        return;
      }
      if (name === 'home' || (name === 'a' && key.ctrl)) {
        this.store.setSettingsEditing({ ...editing, cursor: 0 });
        this.scheduler.renderNow();
        return;
      }
      if (name === 'end' || (name === 'e' && key.ctrl)) {
        this.store.setSettingsEditing({ ...editing, cursor: draft.length });
        this.scheduler.renderNow();
        return;
      }
      if (name === 'u' && key.ctrl) {
        this.store.setSettingsEditing({ ...editing, draft: '', cursor: 0 });
        this.scheduler.renderNow();
        return;
      }
      if (name === 'paste' && key.text) {
        const clean = key.text.replace(/[\r\n]+/g, '');
        this.store.setSettingsEditing({
          ...editing,
          draft: draft.slice(0, cursor) + clean + draft.slice(cursor),
          cursor: cursor + clean.length,
        });
        this.scheduler.renderNow();
        return;
      }
      if (!key.ctrl && !key.alt && !key.meta && key.text && key.text.length > 0) {
        this.store.setSettingsEditing({
          ...editing,
          draft: draft.slice(0, cursor) + key.text + draft.slice(cursor),
          cursor: cursor + key.text.length,
        });
        this.scheduler.renderNow();
      }
      return;
    }

    // 2. Normal `<prefs>` navigation, control adjustment & search
    const computed = computeSettingsData(
      state,
      settings,
      this.#config,
      this.#configPath,
      this.#agySettingsPath
    );
    const visible = computed.visibleRowIds;
    const focusedRowId =
      settings.focus && visible.includes(settings.focus) ? settings.focus : visible[0] ?? null;
    const focusedRow = focusedRowId ? computed.rowById.get(focusedRowId) : undefined;

    if (name === 'escape') {
      if (settings.query.length > 0) {
        this.#updateSettingsQueryAndFocus('', 0);
      } else {
        this.#closeSettings();
      }
      return;
    }

    if (name === 'tab' && !key.ctrl && !key.alt && !key.meta) {
      const idx = SETTINGS_PAGES.findIndex(p => p.id === settings.page);
      const delta = key.shift ? -1 : 1;
      const nextPage =
        SETTINGS_PAGES[(idx + delta + SETTINGS_PAGES.length) % SETTINGS_PAGES.length]?.id ??
        'session';
      this.#setSettingsPageWithFocus(nextPage);
      return;
    }

    if (name === 'up' || (name === 'p' && key.ctrl)) {
      if (visible.length > 0) {
        const curIdx = focusedRowId ? visible.indexOf(focusedRowId) : 0;
        const nextIdx = (curIdx - 1 + visible.length) % visible.length;
        this.store.setSettingsFocus(visible[nextIdx] ?? null);
        this.scheduler.renderNow();
      }
      return;
    }

    if (name === 'down' || (name === 'n' && key.ctrl)) {
      if (visible.length > 0) {
        const curIdx = focusedRowId ? visible.indexOf(focusedRowId) : -1;
        const nextIdx = (curIdx + 1) % visible.length;
        this.store.setSettingsFocus(visible[nextIdx] ?? null);
        this.scheduler.renderNow();
      }
      return;
    }

    if ((name === 'left' || name === 'right') && !key.ctrl && !key.alt && !key.meta) {
      if (focusedRow && !focusedRow.disabled && focusedRow.control) {
        const ctrl = focusedRow.control;
        if (ctrl.k === 'choice' && ctrl.options && ctrl.options.length > 0) {
          const opts = ctrl.options;
          const curIdx = Math.max(
            0,
            opts.findIndex(o => o.value === ctrl.value)
          );
          const delta = name === 'left' ? -1 : 1;
          const nextOpt = opts[(curIdx + delta + opts.length) % opts.length];
          if (nextOpt) {
            await this.#handleSettingsChange(focusedRow.id, nextOpt.value);
          }
          return;
        }
        if (ctrl.k === 'number') {
          const step = ctrl.step ?? 1;
          const min = ctrl.min ?? 1;
          const max = ctrl.max ?? 200;
          const curVal = typeof ctrl.value === 'number' ? ctrl.value : min;
          const nextVal = Math.min(
            max,
            Math.max(min, curVal + (name === 'left' ? -step : step))
          );
          await this.#handleSettingsChange(focusedRow.id, nextVal);
          return;
        }
        if (ctrl.k === 'switch' && settings.query.length === 0) {
          const nextOn = name === 'right';
          if (nextOn !== Boolean(ctrl.on)) {
            await this.#handleSettingsChange(focusedRow.id, nextOn);
          }
          return;
        }
      }

      if (settings.query.length > 0) {
        const nextCursor =
          name === 'left'
            ? prevCodePointOffset(settings.query, settings.cursor)
            : nextCodePointOffset(settings.query, settings.cursor);
        this.store.updateSettingsQuery(settings.query, nextCursor);
        this.scheduler.renderNow();
      }
      return;
    }

    if (
      (name === 'enter' || (name === 'space' && settings.query.length === 0)) &&
      !key.ctrl &&
      !key.alt &&
      !key.meta
    ) {
      if (focusedRow) {
        await this.#handleSettingsActivate(focusedRow.id);
      }
      return;
    }

    // Search typing inside `<prefs>`
    if (name === 'backspace') {
      if (settings.cursor > 0) {
        const prev = prevCodePointOffset(settings.query, settings.cursor);
        const nextQ = settings.query.slice(0, prev) + settings.query.slice(settings.cursor);
        this.#updateSettingsQueryAndFocus(nextQ, prev);
      }
      return;
    }

    if (name === 'delete') {
      if (settings.cursor < settings.query.length) {
        const next = nextCodePointOffset(settings.query, settings.cursor);
        const nextQ = settings.query.slice(0, settings.cursor) + settings.query.slice(next);
        this.#updateSettingsQueryAndFocus(nextQ, settings.cursor);
      }
      return;
    }

    if (name === 'u' && key.ctrl) {
      this.#updateSettingsQueryAndFocus('', 0);
      return;
    }

    if (name === 'paste' && key.text) {
      const clean = key.text.replace(/[\r\n]+/g, ' ');
      const nextQ =
        settings.query.slice(0, settings.cursor) + clean + settings.query.slice(settings.cursor);
      this.#updateSettingsQueryAndFocus(nextQ, settings.cursor + clean.length);
      return;
    }

    if (!key.ctrl && !key.alt && !key.meta && key.text && key.text.length > 0) {
      const nextQ =
        settings.query.slice(0, settings.cursor) + key.text + settings.query.slice(settings.cursor);
      this.#updateSettingsQueryAndFocus(nextQ, settings.cursor + key.text.length);
    }
  }

  #updatePickerQueryAndSelection(query: string, cursor: number): void {
    this.store.updatePickerQuery(query, cursor);
    const nextState = this.store.getState();
    if (nextState.picker) {
      const computed = computePickerData(
        nextState,
        nextState.picker,
        this.store.traffic.list(),
        this.#now()
      );
      this.store.setPickerSelected(computed.selectedId ?? null);
    }
    this.scheduler.renderNow();
  }

  async #handleQuestionKey(key: Key): Promise<boolean> {
    const card = this.store.getState().activeQuestion;
    if (!card) return false;

    const name = key.name.toLowerCase();

    if (card.mode === 'url') {
      if (name === 'escape') {
        this.#resolveQuestion({ action: 'cancel' });
        return true;
      }
      if (name === 'enter') {
        this.#resolveQuestion({ action: 'accept', content: {} });
        return true;
      }
      return true;
    }

    const currentQ = card.items[card.step];
    if (!currentQ) {
      if (name === 'escape') {
        this.#resolveQuestion({ action: 'cancel' });
      }
      return true;
    }

    // If focused on `<qId>.other`, route typing/backspace/enter to the other draft
    if (card.focusedOtherId === currentQ.id) {
      const curText = card.otherDrafts[currentQ.id] ?? '';
      if (name === 'escape') {
        if (currentQ.choices && currentQ.choices.length > 0) {
          this.store.setQuestionFocusedOther(null);
          this.scheduler.renderNow();
          this.syncFocus();
        } else {
          this.#resolveQuestion({ action: 'cancel' });
        }
        return true;
      }
      if (name === 'up' && currentQ.choices && currentQ.choices.length > 0) {
        this.store.setQuestionFocusedOther(null);
        if (!currentQ.multi) {
          const lastChoice = currentQ.choices[currentQ.choices.length - 1];
          if (lastChoice) {
            this.store.setQuestionAnswer(currentQ.id, lastChoice.value);
          }
        }
        this.scheduler.renderNow();
        this.syncFocus();
        return true;
      }
      if (name === 'enter') {
        if (card.step < card.items.length - 1) {
          this.store.setQuestionStep(card.step + 1);
          this.#syncQuestionAutoFocus();
          this.scheduler.renderNow();
        } else {
          this.#submitCurrentQuestion();
        }
        return true;
      }
      if (name === 'backspace') {
        if (curText.length > 0) {
          const prev = prevCodePointOffset(curText, curText.length);
          this.store.setQuestionOtherDraft(currentQ.id, curText.slice(0, prev));
          this.scheduler.renderNow();
        }
        return true;
      }
      if (name === 'paste' && key.text) {
        this.store.setQuestionOtherDraft(currentQ.id, curText + key.text);
        this.scheduler.renderNow();
        return true;
      }
      if (!key.ctrl && !key.alt && !key.meta && key.text && key.text.length > 0) {
        this.store.setQuestionOtherDraft(currentQ.id, curText + key.text);
        this.scheduler.renderNow();
        return true;
      }
      return true;
    }

    if (name === 'escape') {
      this.#resolveQuestion({ action: 'cancel' });
      return true;
    }

    // Number keys 1-9 select choice on current question; N+1 focuses Other input if available
    if (!key.ctrl && !key.alt && !key.meta && /^[1-9]$/.test(name)) {
      const idx = Number(name) - 1;
      const choices = currentQ.choices ?? [];
      const choice = choices[idx];
      if (choice) {
        if (currentQ.multi) {
          const prev = card.answers[currentQ.id];
          const arr = Array.isArray(prev) ? [...prev] : [];
          const existingIdx = arr.indexOf(choice.value);
          if (existingIdx >= 0) arr.splice(existingIdx, 1);
          else arr.push(choice.value);
          this.store.setQuestionAnswer(currentQ.id, arr);
        } else {
          this.store.setQuestionAnswer(currentQ.id, choice.value);
        }
        this.scheduler.renderNow();
        this.syncFocus();
        return true;
      }
      if (idx === choices.length && currentQ.other) {
        this.store.setQuestionFocusedOther(currentQ.id);
        this.scheduler.renderNow();
        this.syncFocus();
        return true;
      }
    }

    // Up/Down cycles choices on single-select questions (and enters Other input after last choice)
    if (
      (name === 'up' || name === 'down') &&
      !key.ctrl &&
      !key.alt &&
      !key.meta &&
      currentQ.choices &&
      currentQ.choices.length > 0
    ) {
      const choices = currentQ.choices;
      if (!currentQ.multi) {
        const curAns = card.answers[currentQ.id];
        const curIdx =
          typeof curAns === 'string' ? choices.findIndex(c => c.value === curAns) : -1;
        if (name === 'down') {
          if (curIdx === choices.length - 1 && currentQ.other) {
            this.store.setQuestionFocusedOther(currentQ.id);
            this.scheduler.renderNow();
            this.syncFocus();
            return true;
          }
          const nextIdx = curIdx < 0 ? 0 : (curIdx + 1) % choices.length;
          const nextChoice = choices[nextIdx];
          if (nextChoice) {
            this.store.setQuestionAnswer(currentQ.id, nextChoice.value);
            this.scheduler.renderNow();
          }
        } else {
          const prevIdx =
            curIdx <= 0 ? choices.length - 1 : curIdx - 1;
          const prevChoice = choices[prevIdx];
          if (prevChoice) {
            this.store.setQuestionAnswer(currentQ.id, prevChoice.value);
            this.scheduler.renderNow();
          }
        }
        return true;
      }
    }

    // Left / Shift+Tab moves to previous question step
    if ((name === 'left' || (name === 'tab' && key.shift)) && !key.ctrl && !key.alt && !key.meta) {
      this.#stepQuestion(-1);
      return true;
    }

    // Right / Tab moves to next question step; Enter advances or submits on last step
    if ((name === 'right' || name === 'tab' || name === 'enter') && !key.ctrl && !key.alt && !key.meta) {
      if (card.step < card.items.length - 1) {
        this.#stepQuestion(1);
      } else if (name === 'enter') {
        this.#submitCurrentQuestion();
      }
      return true;
    }

    return true;
  }

  #stepQuestion(delta: -1 | 1): void {
    const card = this.store.getState().activeQuestion;
    if (!card) return;
    const nextStep = Math.max(0, Math.min(card.items.length - 1, card.step + delta));
    if (nextStep === card.step) return;
    this.store.setQuestionStep(nextStep);
    this.#syncQuestionAutoFocus();
    this.scheduler.renderNow();
  }

  #skipCurrentQuestion(): void {
    const card = this.store.getState().activeQuestion;
    if (!card) return;
    const currentQ = card.items[card.step];
    if (currentQ && !currentQ.required) {
      this.store.clearQuestionAnswer(currentQ.id);
    }
    if (card.step < card.items.length - 1) {
      this.store.setQuestionStep(card.step + 1);
      this.#syncQuestionAutoFocus();
      this.scheduler.renderNow();
    } else {
      this.#submitCurrentQuestion();
    }
  }

  #syncQuestionAutoFocus(): void {
    const card = this.store.getState().activeQuestion;
    if (!card) {
      this.syncFocus();
      return;
    }
    const q = card.items[card.step];
    if (q && (!q.choices || q.choices.length === 0) && q.other) {
      this.store.setQuestionFocusedOther(q.id);
    } else {
      this.store.setQuestionFocusedOther(null);
    }
    this.syncFocus();
  }

  #submitCurrentQuestion(overrideAnswers?: Record<string, unknown>): void {
    const card = this.store.getState().activeQuestion;
    if (!card) return;
    if (overrideAnswers) {
      for (const [k, v] of Object.entries(overrideAnswers)) {
        const item = card.items.find(q => q.id === k);
        if (typeof v === 'string') {
          if (v.length === 0 && (card.otherDrafts[k]?.trim() || card.answers[k])) {
            continue;
          }
          const isPreset = Boolean(item?.choices?.some(c => c.value === v));
          if (item && item.writeInFieldId && !isPreset && v.trim().length > 0) {
            this.store.setQuestionOtherDraft(k, v);
          } else {
            this.store.setQuestionAnswer(k, v);
          }
        } else if (Array.isArray(v)) {
          this.store.setQuestionAnswer(
            k,
            v.filter((x): x is string => typeof x === 'string')
          );
        }
      }
    }
    const latestCard = this.store.getState().activeQuestion ?? card;
    const content = buildElicitationContent(latestCard);
    this.#resolveQuestion({ action: 'accept', content });
  }

  #resolveQuestion(
    result:
      | { action: 'accept'; content: Record<string, unknown> }
      | { action: 'decline' }
      | { action: 'cancel' }
  ): void {
    const resolved = this.store.resolveActiveQuestion(result);
    if (!resolved) return;
    if (this.store.getState().activeQuestion) {
      this.#syncQuestionAutoFocus();
      this.#restoreOscAfterBlock();
      this.scheduler.renderNow();
      if (this.surface && this.session.caps.features.includes('scroll')) {
        this.surface.reveal('main.questions', 'end');
      }
      this.syncFocus();
      return;
    }
    this.#restoreOscAfterBlock();
    this.scheduler.renderNow();
    this.syncFocus();
  }

  // -------------------------------------------------------------------------
  // Editor EditEvent / UndoEvent / SendEvent / Clipboard / Completion
  // -------------------------------------------------------------------------

  #handleEditorEdit(event: EditEvent): void {
    const accepted = this.store.draft.applyEdit(event);
    if (!accepted) return;
    this.store.clearCtrlCArm();
    this.store.history.resetNavigation();
    this.#refreshCompletion();
    this.scheduler.renderNow();
  }

  #handleEditorUndo(_event: UndoEvent): void {
    const changed = this.store.draft.undo();
    if (!changed) return;
    this.#refreshCompletion();
    this.scheduler.renderNow();
  }

  async #handleEditorSend(event: SendEvent): Promise<void> {
    const trimmed = event.text.trim();
    // Reject blank native `send` events without consuming existing draft text or attachments.
    if (trimmed.length === 0) {
      return;
    }
    // Isolate standalone `send` events whose payload differs from the current composer draft so
    // pending draft attachments are never leaked and the user's draft + attachments stay intact.
    const matchesCurrentDraft = event.text === this.store.draft.text;
    await this.submitInput(event.text, { isolated: !matchesCurrentDraft });
  }

  async #handleCtrlV(): Promise<void> {
    if (this.#clipboard.isRemoteSshWithoutDisplay()) {
      this.store.pushToast(
        'Remote SSH session: local clipboard image is unavailable. Use @path/to/image.png instead.',
        'warning'
      );
      this.scheduler.renderNow();
      return;
    }

    const img = await this.#clipboard.readImage();
    if (img) {
      const blobId = this.session.blob(img.data, img.mimeType);
      const id = `img-${++this.#attachmentSeq}`;
      const att: AttachmentItem = {
        id,
        kind: 'image',
        name: `clipboard-${this.#attachmentSeq}.png`,
        mime: img.mimeType,
        ext: 'png',
        size: img.data.byteLength,
        blobId,
        base64Data: Buffer.from(img.data).toString('base64'),
      };
      this.store.addAttachment(att);
      this.store.pushToast(`Attached ${att.name}`, 'info', { ttl: 2000 });
      this.scheduler.renderNow();
      return;
    }

    const text = await this.#clipboard.readText();
    if (text && text.length > 0) {
      this.store.draft.insertText(text, { coalesce: false, recordUndo: true });
      this.#refreshCompletion();
      this.scheduler.renderNow();
    } else {
      this.store.pushToast('Clipboard is empty or unavailable', 'info', { ttl: 2000 });
      this.scheduler.renderNow();
    }
  }

  #refreshCompletion(): void {
    this.store.refreshCompletion((query, limit) =>
      this.#fileIndexer.search(query, limit).map(m => ({
        path: m.file.relPath,
        score: m.score,
        hits: m.hits,
      }))
    );
  }

  async #acceptCompletion(viaKey: 'tab' | 'enter' | 'click', keyOrNodeId?: string): Promise<void> {
    const accepted = this.store.acceptCompletion({ viaKey, keyOrNodeId });
    if (!accepted) return;

    if (accepted.item.kind === 'file') {
      const relPath = accepted.item.value;
      const absPath = path.resolve(this.store.getState().cwd, relPath);
      this.#suppressedMentionPaths.delete(this.#normalizeMentionPathKey(relPath));
      const ext = path.extname(relPath).replace(/^\./, '') || undefined;
      this.store.addAttachment({
        id: `file-${++this.#attachmentSeq}`,
        kind: 'file',
        name: path.basename(relPath),
        ext,
        mime: guessMimeType(absPath),
        path: relPath,
        uri: toFileUri(absPath),
      });
    }

    this.scheduler.renderNow();

    if (accepted.autoExecute) {
      await this.submitInput(accepted.text);
    }
  }

  // -------------------------------------------------------------------------
  // Prompt Submission & Slash Command Execution
  // -------------------------------------------------------------------------

  async submitInput(
    rawText: string,
    options: { readonly isolated?: boolean } = {},
  ): Promise<void> {
    const isolated = options.isolated === true;
    const text = rawText.trim();
    const pendingAttachments = isolated
      ? []
      : [...this.store.getState().pendingAttachments];

    if (text.length === 0 && pendingAttachments.length === 0) {
      return;
    }

    this.store.clearCtrlCArm();
    this.store.dismissCompletion();

    // Check slash commands; passthrough commands retain pending attachments (agy >= 1.5.15)
    const dispatched = dispatchSlashCommand(text, this.store.commands);
    if (
      dispatched.isCommand &&
      (pendingAttachments.length === 0 || dispatched.action.type === 'passthrough_prompt')
    ) {
      if (!isolated) {
        this.store.draft.reset();
        if (dispatched.action.type === 'passthrough_prompt' && pendingAttachments.length > 0) {
          this.store.clearAttachments();
          this.#suppressedMentionPaths.clear();
        }
      }
      void this.store.history.push(text, this.store.getState().cwd);
      this.scheduler.renderNow();
      await executeCommandAction(
        dispatched.action,
        this.#commandExecutor({
          preserveDraft: isolated,
          attachments: pendingAttachments,
        })
      );
      return;
    }

    await this.#sendPromptToAcp(text, pendingAttachments, { preserveDraft: isolated });
  }

  #commandExecutor(
    options: {
      readonly preserveDraft?: boolean;
      readonly attachments?: readonly AttachmentItem[];
    } = {},
  ): CommandActionExecutor {
    const preserveDraft = options.preserveDraft === true;
    const passthroughAttachments = options.attachments ?? [];
    const copyByIndex = async (index?: number) => {
      const idx = index && index >= 1 ? index : 1;
      const md = this.store.transcript.getAssistantMarkdownByReverseIndex(idx);
      if (!md) {
        this.store.pushToast(
          idx === 1
            ? 'No assistant reply to copy yet'
            : `No assistant reply found at index #${idx}`,
          'info'
        );
        this.scheduler.renderNow();
        return;
      }
      const ok = await this.#clipboard.writeText(md);
      this.store.pushToast(
        ok
          ? idx === 1
            ? 'Copied last assistant reply to clipboard'
            : `Copied assistant reply #${idx} to clipboard`
          : 'Clipboard copy unavailable',
        ok ? 'success' : 'warning'
      );
      this.scheduler.renderNow();
    };

    return {
      openPicker: async (picker: PickerCommandKind, initialQuery: string) => {
        await this.#openPicker(picker, initialQuery);
      },
      openSwarmBoard: async (query: string) => {
        await this.#openSwarmBoard(query);
      },
      openSettings: async (page?: SettingsPageId) => {
        await this.#openSettings(page);
      },
      openStatus: () => {
        this.#openInfoOverlay('status');
      },
      openContext: () => {
        this.#openInfoOverlay('context');
      },
      openUsage: () => {
        this.#openInfoOverlay('usage');
      },
      openJobs: () => {
        this.#openInfoOverlay('jobs');
      },
      openGit: async () => {
        await this.#openGitOverlay();
      },
      openMcp: async (args?: string) => {
        await this.#handleMcpCommand(args);
      },
      openPlugins: async (args?: string) => {
        await this.#handlePluginsCommand(args);
      },
      openSkills: async (query?: string) => {
        await this.#openPicker('skills', query ?? '');
      },
      openAgents: async (query?: string) => {
        await this.#openPicker('agents', query ?? '');
      },
      login: async () => {
        await this.#handleAuthLogin();
      },
      logout: () => {
        this.#openInfoOverlay('logout_confirm');
      },
      exportTranscript: async (targetPath?: string) => {
        await this.#exportTranscript(targetPath);
      },
      copyLastAssistant: copyByIndex,
      copyLastReply: copyByIndex,
      newSession: async () => {
        await this.#startNewSession();
      },
      setModel: async (query: string) => {
        await this.#applyModelQuery(query);
      },
      setThought: async (level: string) => {
        await this.#applyThoughtLevel(level, false);
      },
      setThinkingDisplay: async (mode: 'on' | 'off' | 'toggle') => {
        await this.#handleThinkingDisplay(mode);
      },
      setMode: async (mode: string) => {
        await this.#applyMode(mode, false);
      },
      handleTodo: async (argsText: string) => {
        await this.#handleTodoCommand(argsText);
      },
      renameSession: async (title: string) => {
        await this.#handleRenameSession(title);
      },
      openHelp: () => {
        this.#pickerLoadToken += 1;
        this.store.openHelp();
        this.scheduler.renderNow();
        this.syncFocus();
      },
      quit: async () => {
        await this.shutdown({ cleanExit: true, exitCode: 0 });
      },
      passthroughPrompt: async (text: string) => {
        if (/^\/swarm(?:\s|$)/i.test(text.trim())) {
          this.store.setHasSwarm(true);
          this.#syncSwarmFxStylesheet();
          this.#ensureSwarmWatcher(undefined, { refreshNow: true });
        }
        await this.#sendPromptToAcp(text, passthroughAttachments, { preserveDraft });
      },
      unknownCommand: (commandName, _rawText, suggestions) => {
        const hint =
          suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
        this.store.pushToast(`Unknown command /${commandName}.${hint}`, 'warning');
        this.scheduler.renderNow();
      },
    };
  }

  #abortStreamingTurn(status: 'cancelled' | 'error', message: string): void {
    const state = this.store.getState();
    this.store.transcript.finishActiveTurn(undefined, status, message, {
      autoCollapseThought: this.store.autoCollapseThought,
      expandAllTools: state.expandAllTools,
    });
    const endedSnap = this.#metricsTracker.endStreamTurn();
    this.#applySessionMetricsSnapshot(endedSnap);
    this.store.setStreaming(false);
    this.#syncToolWatchTimer();
    if (!this.store.isBusy) {
      this.#pendingBackgroundDone = false;
      this.#awaitingPostToolWakeup = false;
      this.#backgroundResumeAnchorStepSeq = 0;
      this.#backgroundWaitLastProgressAt = 0;
      this.#deferredSettleTurnIndex = null;
      this.#workingStartedAt = undefined;
      this.#clearBackgroundDoneTimer();
      if (status === 'cancelled' && state.connectionStatus === 'ready') {
        this.osc.setStatusIdle();
      }
    }
  }

  async #sendPromptToAcp(
    text: string,
    attachments: readonly AttachmentItem[],
    options: { readonly preserveDraft?: boolean } = {},
  ): Promise<void> {
    const preserveDraft = options.preserveDraft === true;
    const client = this.#acpClient;
    const state = this.store.getState();

    if (!client || !this.#isAcpClientLive(client) || !state.isReady || !state.sessionId) {
      this.store.pushToast(
        state.connectionStatus === 'ready' &&
          !state.sessionId &&
          !state.isReplaying &&
          !state.isCreatingSession
          ? 'No active session — use /new or /resume'
          : 'Session is not ready yet',
        'warning'
      );
      this.scheduler.renderNow();
      return;
    }

    if (state.isStreaming || this.#activePromptTask !== null || this.#promptSubmitting) {
      this.store.pushToast('Wait for current turn to finish or press Esc to stop', 'info');
      this.scheduler.renderNow();
      return;
    }

    // Claim the submission slot synchronously BEFORE the first `await` so concurrent
    // submit triggers cannot race into two overlapping `session/prompt` RPCs.
    this.#promptSubmitting = true;
    const sessionId = state.sessionId;
    const promptEpoch = this.#lifecycle.epoch;
    const isCompactPrompt = /^\/compact(?:\s|$)/i.test(text.trim());
    const isLeadingSlashPrompt = /^\/[^\s]+/.test(text.trim());
    const suppressedMentions = preserveDraft
      ? new Set<string>()
      : new Set(this.#suppressedMentionPaths);

    try {
      this.#clearDoneIdleTimer();
      this.#clearBackgroundDoneTimer();
      this.#awaitingPostToolWakeup = false;
      this.#awaitingSwarmCoordinatorReply = false;
      this.#swarmCoordinatorReplied = false;
      if (this.#deferredSettleTurnIndex !== null) {
        this.scheduler.settleTurn(this.#deferredSettleTurnIndex);
        this.#deferredSettleTurnIndex = null;
      }
      if (!preserveDraft) {
        this.store.draft.reset();
        this.store.clearAttachments();
        this.#suppressedMentionPaths.clear();
      }
      if (text.length > 0) {
        void this.store.history.push(text, state.cwd);
      }

      // Ensure historical transcript token baseline is synced before starting TPS tracking
      await this.#syncSessionMetricsFromTranscript();
      const postSyncState = this.store.getState();
      if (
        this.#shuttingDown ||
        promptEpoch !== this.#lifecycle.epoch ||
        !this.#isAcpClientLive(client) ||
        !postSyncState.isReady ||
        postSyncState.sessionId !== sessionId
      ) {
        return;
      }

      // Mark streaming & render user turn synchronously before detaching the long-lived
      // `client.prompt(...)` RPC so the main session input loop stays responsive for
      // `y`/`a`/`n` approvals, `<questions>`, `Esc` cancel, and `Ctrl+C`.
      this.store.transcript.beginUserTurn(text, attachments);
      this.#metricsTracker.beginStreamTurn();
      this.#lastTpsStoreFlushAt = 0;
      this.store.setStreaming(true);
      if (this.#workingStartedAt === undefined) {
        this.#workingStartedAt = this.#now();
      }
      this.osc.setStatusWorking();
      this.scheduler.renderNow();

      const runPrompt = async (): Promise<void> => {
        try {
          const promptBlocks = await this.#buildPromptBlocks(
            text,
            attachments,
            suppressedMentions
          );
          const preSendState = this.store.getState();
          if (
            this.#shuttingDown ||
            promptEpoch !== this.#lifecycle.epoch ||
            !this.#isAcpClientLive(client) ||
            !preSendState.isReady ||
            preSendState.sessionId !== sessionId
          ) {
            if (
              !this.#shuttingDown &&
              promptEpoch === this.#lifecycle.epoch &&
              preSendState.sessionId === sessionId
            ) {
              const reason =
                this.#logoutInFlightClient === client
                  ? 'Prompt cancelled because sign-out is in progress'
                  : 'Prompt cancelled before dispatch';
              this.#abortStreamingTurn('cancelled', reason);
              this.scheduler.renderNow();
            }
            return;
          }

          const reminderToSend = !isCompactPrompt ? this.#pendingTodoSyncReminder : null;
          const outboundPrompt = reminderToSend
            ? isLeadingSlashPrompt
              ? [...promptBlocks, { type: 'text' as const, text: `\n\n${reminderToSend}` }]
              : [{ type: 'text' as const, text: `${reminderToSend}\n\n` }, ...promptBlocks]
            : promptBlocks;

          const result = await client.prompt({
            sessionId,
            prompt: outboundPrompt,
          });

          if (
            this.#shuttingDown ||
            promptEpoch !== this.#lifecycle.epoch ||
            this.store.getState().sessionId !== sessionId
          ) {
            return;
          }
          if (!isCompactPrompt) {
            this.#hasRestoredUserAnchor = false;
            if (reminderToSend && this.#pendingTodoSyncReminder === reminderToSend) {
              this.#pendingTodoSyncReminder = null;
            }
          }
          if (result.stopReason === 'end_turn') {
            await this.#syncSessionMetricsFromTranscript({ reconcileBackground: false });
            if (
              this.#shuttingDown ||
              promptEpoch !== this.#lifecycle.epoch ||
              this.store.getState().sessionId !== sessionId
            ) {
              return;
            }
          }
          const finishedTurn = this.store.transcript.finishActiveTurn(
            result.stopReason,
            undefined,
            undefined,
            {
              autoCollapseThought: this.store.autoCollapseThought,
              expandAllTools: this.store.getState().expandAllTools,
              preserveInFlightBackgroundTools: true,
            }
          );
          if (
            result.stopReason === 'end_turn' &&
            isCompactPrompt &&
            finishedTurn &&
            !finishedTurn.notices.some(n => n.kind === 'compaction')
          ) {
            this.store.transcript.markCompactionCompleted(finishedTurn.index);
          }
          this.store.setStreaming(false);

          const hasBgTools = this.store.hasActiveBackgroundTasks();
          const swarmActive = this.store.isSwarmWorking;
          const needSwarmReply =
            this.#awaitingSwarmCoordinatorReply ||
            (swarmActive && !this.#swarmCoordinatorReplied);
          const stillBusy =
            hasBgTools ||
            swarmActive ||
            needSwarmReply ||
            (this.#pendingBackgroundDone && this.#isSwarmCoordinatorWorking());

          const promptOutputTokens =
            typeof result.usage?.outputTokens === 'number' &&
            Number.isFinite(result.usage.outputTokens) &&
            result.usage.outputTokens > 0
              ? result.usage.outputTokens
              : undefined;

          if (!stillBusy) {
            const endedSnap = this.#metricsTracker.endStreamTurn(
              promptOutputTokens !== undefined
                ? { authoritativeOutputTokens: promptOutputTokens }
                : undefined
            );
            this.#applySessionMetricsSnapshot(endedSnap);
            this.#pendingBackgroundDone = false;
            this.#awaitingPostToolWakeup = false;
            this.#backgroundResumeAnchorStepSeq = 0;
            this.#backgroundWaitLastProgressAt = 0;
            this.#awaitingSwarmCoordinatorReply = false;
            this.#swarmCoordinatorReplied = false;
            this.#deferredSettleTurnIndex = null;
            this.#workingStartedAt = undefined;
            this.#clearBackgroundDoneTimer();
          } else {
            // Keep OSC 7501 `working`, continuous elapsed timer & unsettled turn while
            // detached/in-flight background tools or swarm workers remain active; defer
            // `done` and turn settlement until the actual user-facing completion.
            this.#metricsTracker.pauseForTools();
            this.#awaitingSwarmCoordinatorReply = needSwarmReply;
            this.#pendingBackgroundDone =
              hasBgTools || (!needSwarmReply && this.#swarmCoordinatorReplied);
            this.#awaitingPostToolWakeup = false;
            if (this.#pendingBackgroundDone) {
              this.#backgroundResumeAnchorStepSeq =
                this.#metricsTracker.getLatestTurnActivity()?.latestStepSeq ?? 0;
              this.#backgroundWaitLastProgressAt = this.#now();
            }
            if (finishedTurn) {
              this.#deferredSettleTurnIndex = finishedTurn.index;
            }
            this.#clearDoneIdleTimer();
            this.#clearBackgroundDoneTimer();
          }

          // Flush final non-streaming frame & settle turn BEFORE emitting OSC 7501 `state=done`
          this.scheduler.renderNow();
          if (!stillBusy && finishedTurn) {
            this.scheduler.settleTurn(finishedTurn.index);
            this.osc.reassertCursorHidden({ force: true });
          }

          if (stillBusy) {
            this.osc.setStatusWorking();
          } else {
            this.osc.setStatusDone();
            this.#scheduleDoneToIdle();
          }

          this.#syncToolWatchTimer();
          void this.#syncSessionMetricsFromTranscript();
          void this.#refreshGitStatus();
          void this.#persistSessionAnchorAndOsc().catch(() => {});
        } catch (err) {
          if (
            this.#shuttingDown ||
            promptEpoch !== this.#lifecycle.epoch ||
            this.store.getState().sessionId !== sessionId
          ) {
            return;
          }
          const msg = err instanceof Error ? err.message : String(err);
          this.#abortStreamingTurn('error', msg);
          this.store.pushToast(`Prompt failed: ${msg}`, 'error');
          this.osc.setStatusError();
          this.scheduler.renderNow();
          void this.#syncSessionMetricsFromTranscript();
          void this.#refreshGitStatus();
        }
      };

      const task = runPrompt().finally(() => {
        if (this.#activePromptTask === task) {
          this.#activePromptTask = null;
        }
      });
      this.#activePromptTask = task;
    } finally {
      this.#promptSubmitting = false;
    }
  }

  async #buildPromptBlocks(
    text: string,
    attachments: readonly AttachmentItem[],
    suppressedMentions?: ReadonlySet<string>
  ): Promise<ContentBlock[]> {
    const state = this.store.getState();
    const caps = state.promptCapabilities;
    const blocks: ContentBlock[] = [];
    const includedFiles = new Set<string>();

    const appendFilePath = async (rawPath: string): Promise<void> => {
      const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(state.cwd, rawPath);
      const normKey = process.platform === 'win32' ? absPath.toLowerCase() : absPath;
      if (includedFiles.has(normKey)) return;

      let fileStat;
      try {
        fileStat = await stat(absPath);
      } catch {
        return;
      }
      if (!fileStat.isFile()) return;
      includedFiles.add(normKey);

      const uri = toFileUri(absPath);
      const mimeType = guessMimeType(absPath);
      const name = path.basename(absPath);

      if (caps.embeddedContext === false || fileStat.size > MAX_EMBEDDED_FILE_BYTES) {
        blocks.push({
          type: 'resource_link',
          uri,
          name,
          mimeType,
          size: fileStat.size,
        });
        if (fileStat.size > MAX_EMBEDDED_FILE_BYTES) {
          this.store.pushToast(
            `${name} exceeds 256 KiB; attached as resource_link`,
            'info',
            { ttl: 3000 }
          );
        }
        return;
      }

      try {
        const bytes = new Uint8Array(await readFile(absPath));
        if (looksBinary(bytes)) {
          blocks.push({
            type: 'resource_link',
            uri,
            name,
            mimeType,
            size: bytes.byteLength,
          });
          this.store.pushToast(
            `${name} is binary; attached as resource_link`,
            'info',
            { ttl: 3000 }
          );
          return;
        }
        const contentText = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        blocks.push({
          type: 'resource',
          resource: {
            uri,
            mimeType,
            text: contentText,
          },
        });
      } catch {
        blocks.push({
          type: 'resource_link',
          uri,
          name,
          mimeType,
        });
      }
    };

    for (const att of attachments) {
      if (att.kind === 'image') {
        if (caps.image === false) {
          this.store.pushToast('Current backend does not support image attachments', 'warning');
          continue;
        }
        if (att.base64Data) {
          blocks.push({
            type: 'image',
            mimeType: att.mime ?? 'image/png',
            data: att.base64Data,
          });
        }
      } else if (att.kind === 'file' && att.path) {
        await appendFilePath(att.path);
      }
    }

    for (const mentioned of extractMentionedPaths(text)) {
      if (suppressedMentions?.has(this.#normalizeMentionPathKey(mentioned, state.cwd))) {
        continue;
      }
      await appendFilePath(mentioned);
    }

    if (text.length > 0) {
      blocks.push({ type: 'text', text });
    }

    return blocks;
  }

  // -------------------------------------------------------------------------
  // Approval, Cancellation, Pickers & Session Switching
  // -------------------------------------------------------------------------

  handleApprovalDecision(action: ApprovalAction, toolCallId?: string): void {
    const decided = this.store.approvals.decide(
      action,
      toolCallId ? { toolCallId } : undefined
    );
    if (!decided) return;

    this.store.transcript.resolvePermissionOnTool(
      decided.item.toolCallId,
      decided.decision
    );
    this.#restoreOscAfterBlock();
    this.scheduler.renderNow();
  }

  async cancelPendingAndTurn(): Promise<void> {
    // 1. Always reply cancelled to pending permissions & questions BEFORE session/cancel (DESIGN.md 5.3)
    const cancelledPerms = this.store.approvals.cancelAll();
    for (const perm of cancelledPerms) {
      this.store.transcript.resolvePermissionOnTool(perm.toolCallId, 'cancelled');
    }
    const cancelledQ = this.store.cancelAllQuestions() > 0;

    const state = this.store.getState();
    const hadBackgroundBusy = state.hasActiveBackgroundTasks || state.isSwarmWorking;

    // Immediately freeze any live thinking timer and clear locally tracked detached background tasks
    this.store.transcript.finalizeActiveThoughts({
      autoCollapseThought: this.store.autoCollapseThought,
      expandAllTools: state.expandAllTools,
    });
    const cancelledBg = this.store.transcript.cancelActiveBackgroundTasks('cancelled');

    if ((state.isStreaming || hadBackgroundBusy) && state.sessionId && this.#acpClient) {
      await this.#acpClient.cancel(state.sessionId).catch(() => {});
      if (state.isStreaming) {
        this.store.pushToast('Cancelling turn…', 'info', { ttl: 1500 });
      } else {
        this.#pendingBackgroundDone = false;
        this.#awaitingPostToolWakeup = false;
        this.#backgroundResumeAnchorStepSeq = 0;
        this.#backgroundWaitLastProgressAt = 0;
        this.#awaitingSwarmCoordinatorReply = false;
        this.#deferredSettleTurnIndex = null;
        this.#workingStartedAt = undefined;
        this.#clearDoneIdleTimer();
        this.#clearBackgroundDoneTimer();
        this.store.transcript.finalizeBackgroundTurn({
          autoCollapseThought: this.store.autoCollapseThought,
          expandAllTools: state.expandAllTools,
          terminalToolStatus: 'cancelled',
          terminalTurnStatus: 'cancelled',
        });
        if (this.#metricsTracker.isStreaming) {
          const endedSnap = this.#metricsTracker.endStreamTurn();
          this.#applySessionMetricsSnapshot(endedSnap);
        }
        if (!this.store.isBusy) {
          this.osc.setStatusIdle();
        }
        this.store.pushToast('Cancelling background activity…', 'info', { ttl: 1500 });
      }
    } else if (cancelledBg > 0) {
      this.#pendingBackgroundDone = false;
      this.#awaitingPostToolWakeup = false;
      this.#backgroundResumeAnchorStepSeq = 0;
      this.#backgroundWaitLastProgressAt = 0;
      this.#awaitingSwarmCoordinatorReply = false;
      this.#deferredSettleTurnIndex = null;
      this.#workingStartedAt = undefined;
      this.#clearDoneIdleTimer();
      this.#clearBackgroundDoneTimer();
      this.store.transcript.finalizeBackgroundTurn({
        autoCollapseThought: this.store.autoCollapseThought,
        expandAllTools: state.expandAllTools,
        terminalToolStatus: 'cancelled',
        terminalTurnStatus: 'cancelled',
      });
      if (this.#metricsTracker.isStreaming) {
        const endedSnap = this.#metricsTracker.endStreamTurn();
        this.#applySessionMetricsSnapshot(endedSnap);
      }
      if (!this.store.isBusy) {
        this.osc.setStatusIdle();
      }
    } else if (cancelledPerms.length > 0 || cancelledQ) {
      this.#restoreOscAfterBlock();
    }

    this.#clearToolWatchTimer();
    this.scheduler.renderNow();
    this.syncFocus();
  }

  #detachBackgroundJob(jobId: string): void {
    const detached = this.store.transcript.markBackgroundTaskAsDaemon(jobId);
    if (!detached) return;

    if (!this.store.isBusy && !this.store.getState().isStreaming) {
      this.#pendingBackgroundDone = false;
      this.#awaitingPostToolWakeup = false;
      this.#backgroundResumeAnchorStepSeq = 0;
      this.#backgroundWaitLastProgressAt = 0;
      this.#workingStartedAt = undefined;
      this.#clearBackgroundDoneTimer();

      const finalizedTurn = this.store.transcript.finalizeBackgroundTurn({
        autoCollapseThought: this.store.autoCollapseThought,
        expandAllTools: this.store.getState().expandAllTools,
        terminalToolStatus: 'done',
        terminalTurnStatus: 'done',
      });
      if (this.#metricsTracker.isStreaming) {
        const endedSnap = this.#metricsTracker.endStreamTurn();
        this.#applySessionMetricsSnapshot(endedSnap);
      }
      const settleIdx = finalizedTurn?.index ?? this.#deferredSettleTurnIndex;
      this.#deferredSettleTurnIndex = null;
      this.scheduler.renderNow();
      if (settleIdx !== null) {
        this.scheduler.settleTurn(settleIdx);
        this.osc.reassertCursorHidden({ force: true });
      }
      if (!this.store.approvals.hasPending() && !this.store.getState().activeQuestion) {
        this.osc.setStatusIdle();
      }
    }

    this.#syncToolWatchTimer();
    this.store.pushToast(`Detached "${detached.label}" as background daemon`, 'info', {
      ttl: 2500,
    });
    this.scheduler.renderNow();
  }

  #getSwarmPathOptions(): SwarmPathOptions {
    return {
      ...(this.#swarmDir ? { swarmDir: this.#swarmDir } : {}),
      ...(this.#baseBrainDir ? { baseBrainDir: this.#baseBrainDir } : {}),
    };
  }

  #stopSwarmWatcher(): void {
    const watcher = this.#swarmWatcher;
    this.#swarmWatcherSessionId = null;
    if (!watcher) return;
    this.#swarmWatcher = null;
    watcher.stop();
  }

  #ensureSwarmWatcher(
    sessionId?: string | null,
    options: { forceRestart?: boolean; refreshNow?: boolean } = {}
  ): void {
    if (this.#shuttingDown) return;
    const sid = (sessionId ?? this.store.getState().sessionId ?? '').trim();
    if (!sid && !this.#swarmDir) return;

    if (
      !options.forceRestart &&
      this.#swarmWatcher &&
      !this.#swarmWatcher.stopped &&
      this.#swarmWatcherSessionId === sid
    ) {
      if (options.refreshNow) {
        void this.#swarmWatcher.refreshNow(false);
      }
      return;
    }

    this.#stopSwarmWatcher();
    this.#swarmWatcherSessionId = sid;

    const pathOpts = this.#getSwarmPathOptions();
    const watcher = watchSwarmBoard(
      sid,
      (snapshot, meta) => {
        if (this.#shuttingDown || this.#swarmWatcher !== watcher) {
          watcher.stop();
          return;
        }
        this.#applySwarmSnapshot(snapshot, { fromInitialLoad: !meta.changed });
      },
      {
        ...pathOpts,
        ...(this.#swarmPollIntervalMs !== undefined
          ? { intervalMs: this.#swarmPollIntervalMs }
          : {}),
        emitInitial: true,
      }
    );

    if (this.#shuttingDown) {
      watcher.stop();
      this.#swarmWatcherSessionId = null;
      return;
    }
    this.#swarmWatcher = watcher;
  }

  #reconcileBackgroundActivity(prevBusy: boolean): void {
    if (this.#shuttingDown) return;
    this.#reconcileBackgroundActivityCore(prevBusy);
    this.#syncToolWatchTimer();
  }

  #reconcileBackgroundActivityCore(prevBusy: boolean): void {
    const state = this.store.getState();

    if (state.isStreaming) {
      this.#clearBackgroundDoneTimer();
      return;
    }

    const coordinatorWorking =
      (this.#pendingBackgroundDone || this.#awaitingSwarmCoordinatorReply) &&
      this.#isSwarmCoordinatorWorking();

    if (state.hasActiveBackgroundTasks) {
      this.#clearBackgroundDoneTimer();
      if (this.#workingStartedAt === undefined) {
        this.#workingStartedAt = this.#now();
      }
      if (!prevBusy || !this.#pendingBackgroundDone) {
        this.#clearDoneIdleTimer();
        this.#pendingBackgroundDone = true;
        if (!this.store.approvals.hasPending() && !state.activeQuestion) {
          this.osc.setStatusWorking();
        }
      }
      return;
    }

    if (state.isSwarmWorking || coordinatorWorking) {
      this.#clearBackgroundDoneTimer();
      if (this.#workingStartedAt === undefined) {
        this.#workingStartedAt = this.#now();
      }
      if (!prevBusy) {
        this.#clearDoneIdleTimer();
        if (!this.store.approvals.hasPending() && !state.activeQuestion) {
          this.osc.setStatusWorking();
        }
      }
      return;
    }

    // Only emit deferred OSC 7501 `state=done` when `#pendingBackgroundDone` was armed by
    // a non-swarm background task or an actual coordinator `agent_message_chunk` reply —
    // NEVER merely because swarm workers transitioned from `working` to `waiting`.
    if (this.#pendingBackgroundDone && !this.#awaitingSwarmCoordinatorReply) {
      if (prevBusy || this.#backgroundDoneTimer === undefined) {
        const delayMs = this.#awaitingPostToolWakeup
          ? this.#backgroundWakeupGraceMs
          : this.#backgroundDoneGraceMs;
        this.#scheduleBackgroundDone(delayMs);
      }
      return;
    }

    // Swarm workers went idle/waiting while no user-facing coordinator reply has completed:
    // clear working timer and return quietly to `idle` without firing a spurious `finish`.
    if (prevBusy) {
      this.#clearBackgroundDoneTimer();
      this.#workingStartedAt = undefined;
      if (!this.store.approvals.hasPending() && !state.activeQuestion) {
        this.osc.setStatusIdle();
      }
    }
  }

  async #closePicker(options: { commitModelThinking?: boolean } = {}): Promise<void> {
    const prevState = this.store.getState();
    const prevPicker = prevState.picker;
    // Align with omp's model picker: pressing Esc only commits a thinking-level change when
    // the highlighted row is still the currently active model; adjusting thinking while
    // previewing a different candidate model and cancelling via Esc must not mutate the
    // currently active model.
    const highlightedIsCurrentModel =
      Boolean(prevState.controls.currentModelId) &&
      !isOrchestratorModelId(prevState.controls.currentModelId) &&
      prevPicker?.selectedId === prevState.controls.currentModelId;
    const pendingThinking =
      options.commitModelThinking &&
      prevPicker?.kind === 'model' &&
      highlightedIsCurrentModel &&
      prevPicker.modelPickerThinkingDirty &&
      prevPicker.modelPickerThinking &&
      prevPicker.modelPickerThinking !== prevState.controls.currentThoughtLevel
        ? prevPicker.modelPickerThinking
        : undefined;

    this.#pickerLoadToken += 1;
    this.store.closePicker();
    this.scheduler.renderNow();
    this.syncFocus();

    if (pendingThinking) {
      await this.#applyThoughtLevel(pendingThinking, false);
    }
  }

  #applySwarmSnapshot(
    snapshot: SwarmBoardSnapshot | null,
    options: { fromInitialLoad?: boolean } = {}
  ): void {
    const prevState = this.store.getState();
    const prevBusy = prevState.isBusy;

    // Avoid redundant re-renders when background polling finds no swarm yet and UI isn't showing one
    if (
      snapshot === null &&
      prevState.swarmSnapshot === null &&
      !prevState.swarmBoardOpen &&
      prevState.picker?.kind !== 'swarm'
    ) {
      return;
    }

    if (snapshot) {
      const byMember = this.#buildMemberBeeBlobs(snapshot);
      if (byMember) {
        this.store.setBeeBlobs({ byMember });
      }
    }

    this.store.setSwarmSnapshot(snapshot, { fromInitialLoad: options.fromInitialLoad });
    this.#syncSwarmFxStylesheet();
    this.#reconcileBackgroundActivity(prevBusy);

    const state = this.store.getState();
    if (state.picker && state.picker.kind === 'swarm') {
      const computed = computePickerData(
        state,
        state.picker,
        this.store.traffic.list(),
        this.#now()
      );
      this.store.setPickerSelected(computed.selectedId ?? null);
    }
    this.scheduler.renderNow();
  }

  async #openSwarmBoard(initialQuery: string): Promise<void> {
    this.#pickerLoadToken += 1;

    this.store.openSwarmBoard({
      query: initialQuery,
      follow: true,
    });

    // Mount modal overlay first, then release editor focus to null (`renderNow()` -> `syncFocus()`)
    this.scheduler.renderNow();
    this.syncFocus();

    // Ensure background watcher is mounted & immediately check for latest snapshot
    this.#ensureSwarmWatcher(undefined, { refreshNow: true });
    if (this.store.getState().swarmSnapshot === null) {
      const sessionId = this.store.getState().sessionId ?? '';
      const snapshot = await loadSwarmBoard(sessionId, this.#getSwarmPathOptions());
      if (!this.#shuttingDown && snapshot !== null) {
        this.#applySwarmSnapshot(snapshot, { fromInitialLoad: true });
      }
    }
  }

  #closeSwarmBoard(): void {
    if (!this.store.closeSwarmBoard()) return;
    this.scheduler.renderNow();
    this.syncFocus();
  }

  async #refreshSwarmBoard(): Promise<void> {
    const state = this.store.getState();
    if (!state.swarmBoardOpen && state.picker?.kind !== 'swarm') return;
    if (this.#swarmWatcher && !this.#swarmWatcher.stopped) {
      await this.#swarmWatcher.refreshNow(true);
      return;
    }
    const sessionId = state.sessionId ?? '';
    const snapshot = await loadSwarmBoard(sessionId, this.#getSwarmPathOptions());
    if (this.#shuttingDown) return;
    this.#applySwarmSnapshot(snapshot, { fromInitialLoad: true });
  }

  #toggleSwarmFollow(): void {
    const state = this.store.getState();
    if (state.swarmBoardOpen) {
      this.store.toggleSwarmBoardFollow();
      this.scheduler.renderNow();
      return;
    }
    if (state.picker?.kind !== 'swarm') return;
    this.store.toggleSwarmFollow();
    const updated = this.store.getState();
    if (updated.picker && updated.picker.kind === 'swarm') {
      const computed = computePickerData(
        updated,
        updated.picker,
        this.store.traffic.list(),
        this.#now()
      );
      this.store.setPickerSelected(computed.selectedId ?? null);
    }
    this.scheduler.renderNow();
  }

  async #openPicker(kind: ModalPickerKind, initialQuery: string): Promise<void> {
    if (kind === 'swarm') {
      await this.#openSwarmBoard(initialQuery);
      return;
    }
    if (
      kind === 'thought' &&
      !this.store.getState().controls.supportsThoughtLevel &&
      !isOrchestratorModelId(this.store.getState().controls.currentModelId)
    ) {
      this.store.pushToast(
        'Current model does not support thought_level adjustment',
        'info'
      );
      this.scheduler.renderNow();
      return;
    }

    const loadToken = ++this.#pickerLoadToken;
    const isAsyncKind =
      kind === 'resume' ||
      kind === 'mcp' ||
      kind === 'plugins' ||
      kind === 'skills' ||
      kind === 'agents';

    let initialSelectedId: string | null | undefined;
    let initialModelThinking: string | undefined;
    if (kind === 'model') {
      const curId = this.store.getState().controls.currentModelId;
      if (isOrchestratorModelId(curId)) {
        initialSelectedId = ORCHESTRATOR_PICKER_ID;
      }
    } else if (kind === 'planner' || kind === 'executor') {
      const curState = this.store.getState();
      const candidates = filterOrchestratorRoleModels(kind, curState.controls.availableModels);
      const parsedRole = parseOrchestratorModelSpec(curState.orchestratorSettings[kind]);
      const fallbackRole =
        kind === 'planner'
          ? inferOrchestratorDefaultPlannerModel(curState.controls.currentModelId)
          : inferOrchestratorDefaultExecutorModel(curState.controls.currentModelId);
      const targetName = parsedRole?.modelName ?? fallbackRole?.modelName;
      if (targetName) {
        const matched = candidates.find(
          c =>
            c.name.toLowerCase() === targetName.toLowerCase() ||
            c.value.toLowerCase() === targetName.toLowerCase()
        );
        if (matched) {
          initialSelectedId = matched.value;
        }
      }
      initialModelThinking = parsedRole?.thoughtLevel ?? 'high';
    }

    this.store.openPicker(kind, {
      initialQuery,
      loading: isAsyncKind,
      ...(initialSelectedId !== undefined ? { selectedId: initialSelectedId } : {}),
      ...(initialModelThinking !== undefined ? { modelPickerThinking: initialModelThinking } : {}),
    });

    // Render modal picker first, then release editor focus to null (consistent with openHelp)
    this.scheduler.renderNow();
    this.syncFocus();

    if (kind === 'resume') {
      // Load sessions in background so Esc remains responsive while loading
      void this.#loadResumePickerSessions(loadToken);
    } else if (kind === 'mcp') {
      void this.#loadMcpPickerItems(loadToken);
    } else if (kind === 'plugins') {
      void this.#loadPluginsPickerItems(loadToken);
    } else if (kind === 'skills') {
      void this.#loadSkillsPickerItems(loadToken);
    } else if (kind === 'agents') {
      void this.#loadAgentsPickerItems(loadToken);
    } else {
      const state = this.store.getState();
      if (state.picker) {
        const computed = computePickerData(
          state,
          state.picker,
          this.store.traffic.list(),
          this.#now()
        );
        this.store.setPickerSelected(computed.selectedId ?? null);
        this.scheduler.renderNow();
      }
    }
  }

  async #loadResumePickerSessions(loadToken: number): Promise<void> {
    const isStale = (): boolean =>
      this.#shuttingDown ||
      loadToken !== this.#pickerLoadToken ||
      this.store.getState().picker?.kind !== 'resume';

    const client = this.#acpClient;
    if (!client || !client.isRunning) {
      if (isStale()) return;
      this.store.setPickerLoading(false, 'ACP client is not connected');
      this.scheduler.renderNow();
      return;
    }

    try {
      const mergeWithPreviews = (
        remote: readonly SessionSummary[],
        previewMap: ReadonlyMap<string, SessionAnchorRecord>,
      ): ResumeSessionEntry[] =>
        remote.map(s => {
          const cached: SessionAnchorRecord | undefined = previewMap.get(s.sessionId);
          const rawCwd = s.cwd || cached?.cwd || '';
          return {
            sessionId: s.sessionId,
            cwd: rawCwd,
            displayCwd: normalizeDisplayPath(rawCwd),
            title:
              cached?.titleSource === 'user' && cached.title.trim().length > 0
                ? cached.title.trim()
                : (s.title ?? '').trim() || cached?.title || '',
            updatedAt: s.updatedAt || cached?.updatedAt || '',
            ...(cached?.model ? { model: cached.model } : {}),
            ...(cached?.thoughtLevel ? { thoughtLevel: cached.thoughtLevel } : {}),
            ...(cached?.mode ? { mode: cached.mode } : {}),
            ...(cached?.turnCount !== undefined ? { turnCount: cached.turnCount } : {}),
            ...(cached?.preview && cached.preview.length > 0 ? { preview: cached.preview } : {}),
          };
        });

      let previewMapReady: Map<string, SessionAnchorRecord> | null = null;

      // Immediately capture rejection on the concurrent remote list request so a fast failure
      // while local previews are still reading — or after the picker closes — never produces
      // an `unhandledRejection`.
      const remoteResultPromise = client
        .listAllSessions({
          onPage: partialRemote => {
            if (isStale() || !previewMapReady) return;
            const partialMerged = mergeWithPreviews(partialRemote, previewMapReady);
            this.store.setResumeSessions(partialMerged, { loading: true });
            const partialState = this.store.getState();
            if (partialState.picker) {
              const computed = computePickerData(
                partialState,
                partialState.picker,
                this.store.traffic.list(),
                this.#now()
              );
              this.store.setPickerSelected(computed.selectedId ?? null);
            }
            this.scheduler.markDirty();
          },
        })
        .then(
          sessions => ({ ok: true as const, sessions }),
          error => ({ ok: false as const, error })
        );
      const previewMap = await this.#previewStore.loadMap();
      if (isStale()) return;
      previewMapReady = previewMap;

      // Render locally cached sessions immediately as progressive first paint while ACP pages load
      if (previewMap.size > 0) {
        const cachedEntries: ResumeSessionEntry[] = [];
        for (const cached of previewMap.values()) {
          const rawCwd = cached.cwd || '';
          cachedEntries.push({
            sessionId: cached.sessionId,
            cwd: rawCwd,
            displayCwd: normalizeDisplayPath(rawCwd),
            title: (cached.title ?? '').trim(),
            updatedAt: cached.updatedAt || '',
            ...(cached.model ? { model: cached.model } : {}),
            ...(cached.thoughtLevel ? { thoughtLevel: cached.thoughtLevel } : {}),
            ...(cached.mode ? { mode: cached.mode } : {}),
            ...(cached.turnCount !== undefined ? { turnCount: cached.turnCount } : {}),
            ...(cached.preview && cached.preview.length > 0 ? { preview: cached.preview } : {}),
          });
        }
        this.store.setResumeSessions(cachedEntries, { loading: true });
        const partialState = this.store.getState();
        if (partialState.picker) {
          const computed = computePickerData(
            partialState,
            partialState.picker,
            this.store.traffic.list(),
            this.#now()
          );
          this.store.setPickerSelected(computed.selectedId ?? null);
        }
        this.scheduler.renderNow();
      }

      const remoteResult = await remoteResultPromise;
      if (isStale()) return;
      if (!remoteResult.ok) {
        throw remoteResult.error;
      }
      const remoteSessions = remoteResult.sessions;
      const merged = mergeWithPreviews(remoteSessions, previewMap);

      this.store.setResumeSessions(merged);
      const state = this.store.getState();
      if (state.picker) {
        const computed = computePickerData(
          state,
          state.picker,
          this.store.traffic.list(),
          this.#now()
        );
        this.store.setPickerSelected(computed.selectedId ?? null);
      }
      this.scheduler.renderNow();
    } catch (err) {
      if (isStale()) return;
      this.store.setPickerLoading(
        false,
        `Failed to load sessions: ${err instanceof Error ? err.message : String(err)}`
      );
      this.scheduler.renderNow();
    }
  }

  async #loadMcpPickerItems(loadToken: number): Promise<void> {
    const isStale = (): boolean =>
      this.#shuttingDown ||
      loadToken !== this.#pickerLoadToken ||
      this.store.getState().picker?.kind !== 'mcp';

    try {
      const res = await listMcpServers(this.#resolveAgyBin(), {
        execCommand: this.#ecosystemRunner,
        cwd: this.store.getState().cwd,
      });
      if (isStale()) return;
      if (!res.ok) {
        this.store.setPickerLoading(false, res.error ?? 'Failed to list MCP servers');
        this.scheduler.renderNow();
        return;
      }
      const mapped: McpServerItem[] = res.servers.map(s => ({
        name: s.name,
        enabled: s.enabled,
        ...(s.transport ? { transport: s.transport } : {}),
        ...(s.target && /^https?:\/\//i.test(s.target)
          ? { url: s.target }
          : s.target
            ? { command: s.target }
            : {}),
        ...(s.status ? { status: s.status } : {}),
        ...(s.detail ? { detail: s.detail } : {}),
      }));
      this.store.setMcpServers(mapped);
      this.#syncPickerSelectionAfterLoad();
    } catch (err) {
      if (isStale()) return;
      this.store.setPickerLoading(
        false,
        `Failed to list MCP servers: ${err instanceof Error ? err.message : String(err)}`
      );
      this.scheduler.renderNow();
    }
  }

  async #loadPluginsPickerItems(loadToken: number): Promise<void> {
    const isStale = (): boolean =>
      this.#shuttingDown ||
      loadToken !== this.#pickerLoadToken ||
      this.store.getState().picker?.kind !== 'plugins';

    try {
      const res = await listPlugins(this.#resolveAgyBin(), {
        execCommand: this.#ecosystemRunner,
        cwd: this.store.getState().cwd,
      });
      if (isStale()) return;
      if (!res.ok) {
        this.store.setPickerLoading(false, res.error ?? 'Failed to list plugins');
        this.scheduler.renderNow();
        return;
      }
      const mapped: PluginItem[] = res.plugins.map(p => ({
        name: p.name,
        enabled: p.enabled,
        ...(p.version ? { version: p.version } : {}),
        ...(p.description ? { description: p.description } : {}),
        ...(p.source ? { source: p.source } : {}),
        ...(p.path ? { path: p.path } : {}),
      }));
      this.store.setPlugins(mapped);
      this.#syncPickerSelectionAfterLoad();
    } catch (err) {
      if (isStale()) return;
      this.store.setPickerLoading(
        false,
        `Failed to list plugins: ${err instanceof Error ? err.message : String(err)}`
      );
      this.scheduler.renderNow();
    }
  }

  async #loadSkillsPickerItems(loadToken: number): Promise<void> {
    const isStale = (): boolean =>
      this.#shuttingDown ||
      loadToken !== this.#pickerLoadToken ||
      this.store.getState().picker?.kind !== 'skills';

    try {
      const acpCmds = this.store.commands.getAcpSkillCommands().map(cmd => ({
        name: cmd.name,
        description: cmd.description,
        ...(cmd.argHint ? { input: { hint: cmd.argHint } } : {}),
      }));
      const scanned = await scanLocalSkills(this.store.getState().cwd, acpCmds, {
        ...(this.#workspaceSkillsDir ? { workspaceSkillsDir: this.#workspaceSkillsDir } : {}),
        ...(this.#globalSkillsDir ? { globalSkillsDir: this.#globalSkillsDir } : {}),
        ...(this.#agentsGlobalSkillsDir
          ? { agentsGlobalSkillsDir: this.#agentsGlobalSkillsDir }
          : {}),
      });
      if (isStale()) return;
      const mapped: SkillItem[] = scanned.map(s => ({
        name: s.name,
        description: s.description,
        source: s.source === 'global' ? 'user' : s.source,
        ...(s.filePath ? { path: s.filePath } : {}),
        ...(s.content || s.preview ? { content: s.content ?? s.preview } : {}),
      }));
      this.store.setSkills(mapped);
      this.#syncPickerSelectionAfterLoad();
    } catch (err) {
      if (isStale()) return;
      this.store.setPickerLoading(
        false,
        `Failed to scan skills: ${err instanceof Error ? err.message : String(err)}`
      );
      this.scheduler.renderNow();
    }
  }

  async #loadAgentsPickerItems(loadToken: number): Promise<void> {
    const isStale = (): boolean =>
      this.#shuttingDown ||
      loadToken !== this.#pickerLoadToken ||
      this.store.getState().picker?.kind !== 'agents';

    try {
      const res = await listAgents(this.#resolveAgyBin(), {
        execCommand: this.#ecosystemRunner,
        cwd: this.store.getState().cwd,
      });
      if (isStale()) return;

      const items: AgentItem[] = [];
      const seen = new Set<string>();

      if (res.ok) {
        for (const a of res.agents) {
          const id = `cli:${a.name}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const isCustom = a.source ? /custom|workspace|user/i.test(a.source) : false;
          items.push({
            id,
            name: a.name,
            kind: isCustom ? 'custom' : 'builtin',
            ...(a.description ? { description: a.description } : {}),
            ...(a.detail ? { path: a.detail } : {}),
          });
        }
      }

      // Include subagents observed in current session transcript
      for (const turn of this.store.transcript.turns) {
        for (const sub of turn.agents) {
          const id = `sub:${sub.id}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const desc = sub.task ?? sub.outputPreview;
          items.push({
            id,
            name: sub.name,
            kind: sub.kind === 'swarm' ? 'swarm' : 'subagent',
            status: sub.status,
            ...(sub.model ? { model: sub.model } : {}),
            ...(desc ? { description: desc } : {}),
          });
        }
      }

      if (!res.ok && items.length === 0) {
        this.store.setPickerLoading(false, res.error ?? 'Failed to list agents');
        this.scheduler.renderNow();
        return;
      }

      this.store.setAgents(items);
      this.#syncPickerSelectionAfterLoad();
    } catch (err) {
      if (isStale()) return;
      this.store.setPickerLoading(
        false,
        `Failed to list agents: ${err instanceof Error ? err.message : String(err)}`
      );
      this.scheduler.renderNow();
    }
  }

  #syncPickerSelectionAfterLoad(): void {
    const state = this.store.getState();
    if (state.picker) {
      const computed = computePickerData(
        state,
        state.picker,
        this.store.traffic.list(),
        this.#now()
      );
      this.store.setPickerSelected(computed.selectedId ?? null);
    }
    this.scheduler.renderNow();
  }

  async #handleMcpCommand(args?: string): Promise<void> {
    const trimmed = args?.trim() ?? '';
    const subMatch = /^(enable|disable|remove)\s+(\S+)$/i.exec(trimmed);
    if (subMatch) {
      const verb = subMatch[1]!.toLowerCase();
      const name = subMatch[2]!;
      const opts = { execCommand: this.#ecosystemRunner, cwd: this.store.getState().cwd };
      const res =
        verb === 'remove'
          ? await removeMcpServer(this.#resolveAgyBin(), name, opts)
          : await setMcpServerEnabled(this.#resolveAgyBin(), name, verb === 'enable', opts);
      this.store.pushToast(
        res.ok
          ? `MCP server "${name}" ${verb === 'remove' ? 'removed' : verb === 'enable' ? 'enabled' : 'disabled'}`
          : res.error ?? `Failed to ${verb} MCP server "${name}"`,
        res.ok ? 'success' : 'error'
      );
      this.scheduler.renderNow();
      return;
    }
    await this.#openPicker('mcp', trimmed);
  }

  async #handlePluginsCommand(args?: string): Promise<void> {
    const trimmed = args?.trim() ?? '';
    const subMatch = /^(enable|disable)\s+(\S+)$/i.exec(trimmed);
    if (subMatch) {
      const enable = subMatch[1]!.toLowerCase() === 'enable';
      const name = subMatch[2]!;
      const res = await setPluginEnabled(this.#resolveAgyBin(), name, enable, {
        execCommand: this.#ecosystemRunner,
        cwd: this.store.getState().cwd,
      });
      this.store.pushToast(
        res.ok
          ? `Plugin "${name}" ${enable ? 'enabled' : 'disabled'}`
          : res.error ?? `Failed to ${enable ? 'enable' : 'disable'} plugin "${name}"`,
        res.ok ? 'success' : 'error'
      );
      this.scheduler.renderNow();
      return;
    }
    await this.#openPicker('plugins', trimmed);
  }

  async #toggleMcpServer(serverName: string): Promise<void> {
    const picker = this.store.getState().picker;
    if (!picker || picker.kind !== 'mcp') return;
    const target = picker.mcpServers?.find(s => s.name === serverName);
    if (!target) return;
    const nextEnabled = !target.enabled;
    const res = await setMcpServerEnabled(this.#resolveAgyBin(), serverName, nextEnabled, {
      execCommand: this.#ecosystemRunner,
      cwd: this.store.getState().cwd,
    });
    this.store.pushToast(
      res.ok
        ? `MCP "${serverName}" ${nextEnabled ? 'enabled' : 'disabled'} — reconnect to apply`
        : res.error ?? `Failed to toggle MCP "${serverName}"`,
      res.ok ? 'success' : 'error'
    );
    if (res.ok && this.store.getState().picker?.kind === 'mcp') {
      await this.#loadMcpPickerItems(++this.#pickerLoadToken);
    } else {
      this.scheduler.renderNow();
    }
  }

  async #togglePlugin(pluginName: string): Promise<void> {
    const picker = this.store.getState().picker;
    if (!picker || picker.kind !== 'plugins') return;
    const target = picker.plugins?.find(p => p.name === pluginName);
    if (!target) return;
    const nextEnabled = !target.enabled;
    const res = await setPluginEnabled(this.#resolveAgyBin(), pluginName, nextEnabled, {
      execCommand: this.#ecosystemRunner,
      cwd: this.store.getState().cwd,
    });
    this.store.pushToast(
      res.ok
        ? `Plugin "${pluginName}" ${nextEnabled ? 'enabled' : 'disabled'} — reconnect to apply`
        : res.error ?? `Failed to toggle plugin "${pluginName}"`,
      res.ok ? 'success' : 'error'
    );
    if (res.ok && this.store.getState().picker?.kind === 'plugins') {
      await this.#loadPluginsPickerItems(++this.#pickerLoadToken);
    } else {
      this.scheduler.renderNow();
    }
  }

  async #activatePickerItem(kind: ModalPickerKind, itemId: string): Promise<void> {
    if (kind === 'log') {
      await this.#exportTrafficLog();
      return;
    }
    if (kind === 'swarm' || kind === 'agents') {
      // Interactive inspector: selecting/pressing Enter keeps the picker open
      this.store.setPickerSelected(itemId);
      this.scheduler.renderNow();
      return;
    }
    if (kind === 'mcp') {
      await this.#toggleMcpServer(itemId);
      return;
    }
    if (kind === 'plugins') {
      await this.#togglePlugin(itemId);
      return;
    }
    if (kind === 'skills') {
      await this.#closePicker();
      this.store.draft.setText(`/${itemId} `);
      this.#refreshCompletion();
      this.scheduler.renderNow();
      this.syncFocus(true);
      return;
    }

    const picker = this.store.getState().picker;
    const selectedSession =
      kind === 'resume'
        ? picker?.sessions.find(s => s.sessionId === itemId)
        : undefined;
    const desiredModelThinking =
      kind === 'model' && picker?.modelPickerThinkingDirty
        ? picker.modelPickerThinking
        : undefined;
    const selectedRoleThinking =
      kind === 'planner' || kind === 'executor' ? picker?.modelPickerThinking : undefined;

    await this.#closePicker({ commitModelThinking: false });

    if (kind === 'resume') {
      await this.#switchToSession(itemId, selectedSession);
    } else if (kind === 'model') {
      if (itemId === ORCHESTRATOR_PICKER_ID) {
        const curState = this.store.getState();
        const parsedPlan = parseOrchestratorModelSpec(curState.orchestratorSettings.planner);
        const targetOrchId = resolveAcpOrchestratorModelIdForPlanner(
          parsedPlan?.modelName,
          curState.controls.availableModels,
          curState.controls.currentModelId
        );
        if (targetOrchId) {
          await this.#applyModelQuery(targetOrchId);
        }
      } else {
        await this.#applyModelQuery(itemId, desiredModelThinking);
      }
    } else if (kind === 'planner' || kind === 'executor') {
      await this.#applyOrchestratorRoleModel(kind, itemId, selectedRoleThinking);
    } else if (kind === 'thought') {
      await this.#applyThoughtLevel(itemId, false);
    } else if (kind === 'mode') {
      await this.#applyMode(itemId, false);
    }
  }

  async #recoverPreviousSessionAfterFailure(
    client: AcpClient,
    previous: {
      readonly sessionId: string | null;
      readonly cwd: string;
      readonly title?: string;
      readonly todoProvider?: TodoProvider;
    },
    failedSessionId: string | null,
    expectedEpoch: number
  ): Promise<'restored' | 'failed' | 'superseded'> {
    if (
      this.#shuttingDown ||
      expectedEpoch !== this.#lifecycle.epoch ||
      !this.#isAcpClientLive(client)
    ) {
      return 'superseded';
    }
    if (!previous.sessionId || previous.sessionId === failedSessionId) {
      this.#lastCommittedSession = null;
      this.#resetLifecycleToIdle({ resetStore: true });
      return 'failed';
    }
    const recoveryEpoch = this.#beginSessionTransition('replaying', previous.sessionId);
    try {
      const restored = await this.#loadSessionWithReplay(
        client,
        previous.sessionId,
        previous.cwd,
        previous.title,
        recoveryEpoch,
        {
          restoreSavedControls: true,
          ...(previous.todoProvider ? { todoProviderOverride: previous.todoProvider } : {}),
        }
      );
      if (
        !restored ||
        this.#shuttingDown ||
        recoveryEpoch !== this.#lifecycle.epoch ||
        !this.#isAcpClientLive(client)
      ) {
        return 'superseded';
      }
      this.#restoreOscAfterBlock();
      this.osc.setWorkingDirectory(this.store.getState().cwd);
      await this.#persistSessionAnchorAndOsc();
      if (this.#shuttingDown || recoveryEpoch !== this.#lifecycle.epoch) {
        return 'superseded';
      }
      return 'restored';
    } catch {
      if (
        this.#shuttingDown ||
        recoveryEpoch !== this.#lifecycle.epoch ||
        !this.#isAcpClientLive(client)
      ) {
        return 'superseded';
      }
      this.#lastCommittedSession = null;
      this.#resetLifecycleToIdle({ resetStore: true });
      return 'failed';
    }
  }

  async #switchToSession(
    sessionId: string,
    meta?: ResumeSessionEntry
  ): Promise<void> {
    const client = this.#acpClient;
    const state = this.store.getState();
    if (state.connectionStatus === 'initializing') {
      this.store.pushToast('Session is still initializing; please wait a moment.', 'info', {
        ttl: 2000,
      });
      this.scheduler.renderNow();
      this.syncFocus();
      return;
    }
    if (!client || !this.#isAcpClientLive(client)) return;

    const oldSessionId = state.sessionId;
    const desiredTodoProvider: TodoProvider = this.#isTodoMcpEnabled()
      ? 'mcp'
      : this.#getEffectiveTodoProvider();
    if (
      oldSessionId &&
      oldSessionId === sessionId &&
      this.#lifecycle.phase === 'ready' &&
      this.#lifecycle.provider === desiredTodoProvider &&
      this.#isAcpClientLive(client)
    ) {
      this.store.pushToast(
        `Already in session ${meta?.title || state.sessionTitle || sessionId.slice(0, 8)}`,
        'info',
        { ttl: 2000 }
      );
      this.scheduler.renderNow();
      this.syncFocus();
      return;
    }
    const wasStreaming = state.isStreaming;
    const isSameSessionReload = Boolean(oldSessionId && oldSessionId === sessionId);
    const previous =
      oldSessionId && this.#lifecycle.phase === 'ready'
        ? {
            sessionId: oldSessionId,
            cwd: state.cwd,
            ...(state.sessionTitle ? { title: state.sessionTitle } : {}),
            todoProvider: this.#lifecycle.provider,
          }
        : (this.#lastCommittedSession ?? { sessionId: null, cwd: state.cwd });
    const targetCwd =
      meta?.cwd && !sameDir(meta.cwd, state.cwd) ? normalizeDisplayPath(meta.cwd) : state.cwd;

    const switchEpoch = this.#beginSessionTransition('replaying', sessionId);
    try {
      if (oldSessionId) {
        if (wasStreaming) {
          await client.cancel(oldSessionId).catch(() => {});
        }
        if (oldSessionId !== sessionId) {
          await client.closeSession(oldSessionId).catch(() => {});
        }
      }

      if (this.#shuttingDown || switchEpoch !== this.#lifecycle.epoch) {
        return;
      }
      if (oldSessionId && oldSessionId !== sessionId) {
        this.#todoServer?.clearSession(oldSessionId);
      }
      if (!this.#isAcpClientLive(client)) {
        this.#resetLifecycleToIdle();
        this.scheduler.renderNow(true);
        return;
      }

      const applied = await this.#loadSessionWithReplay(
        client,
        sessionId,
        targetCwd,
        meta?.title,
        switchEpoch,
        { restoreSavedControls: true }
      );
      if (
        !applied ||
        this.#shuttingDown ||
        switchEpoch !== this.#lifecycle.epoch ||
        !this.#isAcpClientLive(client)
      ) {
        return;
      }
      this.#restoreOscAfterBlock();
      this.osc.setWorkingDirectory(this.store.getState().cwd);
      await this.#persistSessionAnchorAndOsc();
      if (this.#shuttingDown || switchEpoch !== this.#lifecycle.epoch) return;
      this.store.pushToast(
        `Loaded session ${meta?.title || sessionId.slice(0, 8)}`,
        'success',
        { ttl: 2500 }
      );
      this.scheduler.renderNow();
      this.syncFocus();
    } catch (err) {
      if (this.#shuttingDown || switchEpoch !== this.#lifecycle.epoch) {
        return;
      }
      this.#resetLifecycleToIdle();
      if (!this.#acpClientAlive && this.store.getState().connectionStatus === 'crashed') {
        this.scheduler.renderNow(true);
        return;
      }
      const isNotFound = err instanceof AcpRpcError && err.isSessionNotFound();
      if (isNotFound) {
        void this.#deleteSessionAnchor(sessionId).catch(() => {});
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      const recovery = await this.#recoverPreviousSessionAfterFailure(
        client,
        previous,
        isSameSessionReload && !isNotFound ? null : sessionId,
        switchEpoch
      );
      if (recovery === 'superseded') {
        return;
      }
      const label = meta?.title || sessionId.slice(0, 8);
      this.store.pushToast(
        recovery === 'restored'
          ? isNotFound
            ? `Session ${label} not found (may have been deleted); restored previous session.`
            : `Failed to load session: ${errMsg}; restored previous session.`
          : isNotFound
            ? `Session ${label} not found (may have been deleted). Use /new or /resume to continue.`
            : `Failed to load session: ${errMsg}. Use /new or /resume to continue.`,
        'error'
      );
      this.scheduler.renderNow();
      this.syncFocus();
    }
  }

  async #resolveResumedSessionControls(
    sessionId: string,
    anchorHint?: ResumeAnchorHint
  ): Promise<SessionControlCarryOver | null> {
    const storedAnchor = await this.#previewStore.load(sessionId).catch(() => null);
    let modelId = anchorHint?.model?.trim() || storedAnchor?.model?.trim() || null;
    let thoughtLevel = anchorHint?.model?.trim()
      ? (anchorHint.thoughtLevel?.trim() || null)
      : (anchorHint?.thoughtLevel?.trim() || storedAnchor?.thoughtLevel?.trim() || null);
    const modeId = anchorHint?.mode?.trim() || storedAnchor?.mode?.trim() || null;

    const curState = this.store.getState();
    if (modelId && curState.controls.availableModels.length > 0) {
      const resolved = resolveModelSelection(modelId, {
        configOptions: [...curState.configOptions],
        models: curState.models,
        modes: curState.modes,
      });
      if (
        resolved &&
        resolved.matchKind !== 'fuzzy_config_model' &&
        resolved.matchKind !== 'legacy_fuzzy'
      ) {
        modelId = resolved.modelId;
        if (!thoughtLevel && resolved.thoughtLevel) {
          thoughtLevel = resolved.thoughtLevel;
        }
      }
    } else if (!modelId && curState.controls.availableModels.length > 0) {
      const candidates = await readTranscriptModelCandidates(sessionId, {
        ...(this.#baseBrainDir ? { baseBrainDir: this.#baseBrainDir } : {}),
      });
      for (const candidate of candidates) {
        const resolved = resolveModelSelection(candidate, {
          configOptions: [...curState.configOptions],
          models: curState.models,
          modes: curState.modes,
        });
        if (
          resolved &&
          resolved.matchKind !== 'fuzzy_config_model' &&
          resolved.matchKind !== 'legacy_fuzzy'
        ) {
          modelId = resolved.modelId;
          if (!thoughtLevel && resolved.thoughtLevel) {
            thoughtLevel = resolved.thoughtLevel;
          }
          break;
        }
      }
    }

    return modelId || thoughtLevel || modeId
      ? { modelId, thoughtLevel, modeId }
      : null;
  }

  async #applySessionControls(
    client: AcpClient,
    sessionId: string,
    desired: {
      readonly modelId?: string | null;
      readonly thoughtLevel?: string | null;
      readonly modeId?: string | null;
    },
    epoch: number,
    options: {
      readonly allowFuzzyModel?: boolean;
      readonly clampInvalidThought?: boolean;
      readonly toastFailurePrefix?: string;
    } = {}
  ): Promise<void> {
    const isStale = (): boolean =>
      this.#shuttingDown || epoch !== this.#lifecycle.epoch || !this.#isAcpClientLive(client);

    const warnFailure = (label: string, value: string, err: unknown): void => {
      if (!options.toastFailurePrefix || isStale()) return;
      this.store.pushToast(
        `${options.toastFailurePrefix} ${label} "${value}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        'warning',
        { ttl: 3000 }
      );
    };

    let modelRestoreFailed = false;
    const desiredModel = desired.modelId?.trim() || '';
    const desiredThought = desired.thoughtLevel?.trim() || '';
    const desiredMode = desired.modeId?.trim() || '';

    if (desiredModel) {
      const curState = this.store.getState();
      const shouldApplyModel = options.allowFuzzyModel
        ? true
        : desiredModel !== curState.controls.currentModelId &&
          curState.controls.availableModels.length > 0;
      if (shouldApplyModel) {
        const resolved = resolveModelSelection(desiredModel, {
          configOptions: [...curState.configOptions],
          models: curState.models,
          modes: curState.modes,
        });
        const matchAllowed =
          resolved !== null &&
          (options.allowFuzzyModel ||
            (resolved.matchKind !== 'fuzzy_config_model' &&
              resolved.matchKind !== 'legacy_fuzzy'));
        if (matchAllowed && resolved) {
          try {
            const applied = await applyModelSelection(
              client,
              sessionId,
              resolved,
              options.allowFuzzyModel ? desiredThought || undefined : undefined
            );
            if (isStale()) return;
            if (applied.configOptions) {
              this.store.updateConfigOptions(applied.configOptions);
            } else {
              this.store.updateCurrentModelId(applied.appliedModelId);
            }
          } catch (err) {
            modelRestoreFailed = true;
            warnFailure('model', desiredModel, err);
          }
        }
      }
    }

    if (!modelRestoreFailed && desiredThought && !(options.allowFuzzyModel && desiredModel)) {
      if (options.clampInvalidThought) {
        const curState = this.store.getState();
        if (
          curState.controls.supportsThoughtLevel &&
          curState.controls.currentThoughtLevel !== desiredThought
        ) {
          const resolvedThought = resolveThoughtLevel(desiredThought, [
            ...curState.configOptions,
          ]);
          const targetThought = resolvedThought.ok
            ? resolvedThought.value
            : resolvedThought.reason === 'invalid'
              ? clampThoughtLevelForChoices(
                  desiredThought,
                  curState.controls.availableThoughtLevels
                )
              : undefined;
          if (targetThought && targetThought !== curState.controls.currentThoughtLevel) {
            try {
              const res = await client.setConfigOption({
                sessionId,
                configId: 'thought_level',
                value: targetThought,
              });
              if (isStale()) return;
              this.store.updateConfigOptions(res.configOptions);
            } catch (err) {
              warnFailure('thought level', targetThought, err);
            }
          }
        }
      } else {
        await this.#applyThoughtLevel(desiredThought, true);
        if (isStale()) return;
      }
    }

    if (desiredMode) {
      if (options.clampInvalidThought) {
        const curState = this.store.getState();
        if (
          desiredMode !== curState.controls.currentModeId &&
          curState.controls.availableModes.some(
            m => m.value.toLowerCase() === desiredMode.toLowerCase()
          )
        ) {
          const resolvedMode = resolveModeSelection(desiredMode, {
            configOptions: [...curState.configOptions],
            models: curState.models,
            modes: curState.modes,
          });
          if (resolvedMode) {
            try {
              if (resolvedMode.strategy === 'config_option') {
                const res = await client.setConfigOption({
                  sessionId,
                  configId: 'mode',
                  value: resolvedMode.modeId,
                });
                if (isStale()) return;
                this.store.updateConfigOptions(res.configOptions);
              } else {
                await client.setMode({ sessionId, modeId: resolvedMode.modeId });
                if (isStale()) return;
                this.store.updateCurrentModeId(resolvedMode.modeId);
              }
            } catch (err) {
              warnFailure('mode', desiredMode, err);
            }
          }
        }
      } else {
        await this.#applyMode(desiredMode, true);
      }
    }
  }

  async #startNewSession(): Promise<void> {
    const client = this.#acpClient;
    const state = this.store.getState();
    if (state.connectionStatus === 'initializing') {
      this.store.pushToast('Session is still initializing; please wait a moment.', 'info', {
        ttl: 2000,
      });
      this.scheduler.renderNow();
      this.syncFocus();
      return;
    }
    if (!client || !this.#isAcpClientLive(client)) return;
    const oldId = state.sessionId;
    const wasStreaming = state.isStreaming;
    const previous =
      oldId && this.#lifecycle.phase === 'ready'
        ? {
            sessionId: oldId,
            cwd: state.cwd,
            ...(state.sessionTitle ? { title: state.sessionTitle } : {}),
            todoProvider: this.#lifecycle.provider,
          }
        : (this.#lastCommittedSession ?? { sessionId: null, cwd: state.cwd });
    const pendingCarryOver =
      this.#lifecycle.phase === 'creating' ? this.#lifecycle.carryOver : null;
    const carryOver: SessionControlCarryOver = pendingCarryOver ?? {
      modelId: state.controls.currentModelId,
      thoughtLevel: state.controls.supportsThoughtLevel ? state.controls.currentThoughtLevel : null,
      modeId: state.controls.currentModeId,
    };
    const hasCarryOver = Boolean(carryOver.modelId || carryOver.thoughtLevel || carryOver.modeId);
    const createEpoch = this.#beginSessionTransition(
      'creating',
      undefined,
      hasCarryOver ? carryOver : null
    );
    this.#lastAutoSessionTitle = null;
    this.#syncTerminalTitle();
    this.scheduler.renderNow();

    if (oldId) {
      if (wasStreaming) {
        await client.cancel(oldId).catch(() => {});
      }
      await client.closeSession(oldId).catch(() => {});
    }

    if (
      this.#shuttingDown ||
      createEpoch !== this.#lifecycle.epoch ||
      !this.#isAcpClientLive(client)
    ) {
      if (createEpoch === this.#lifecycle.epoch) {
        this.#resetLifecycleToIdle();
      }
      return;
    }
    if (oldId) {
      this.#todoServer?.clearSession(oldId);
    }

    try {
      const { todoProvider: sessionTodoProvider, ...bootstrapOptions } =
        this.#buildSessionBootstrapOptions(createEpoch, client);
      if (this.#lifecycle.phase === 'creating' && this.#lifecycle.epoch === createEpoch) {
        this.#lifecycle.provider = sessionTodoProvider;
      }
      this.store.transcript.setPreferNativeSteps(sessionTodoProvider === 'native');
      const created = await client.newSession({
        cwd: state.cwd,
        ...bootstrapOptions,
      });
      if (
        this.#shuttingDown ||
        !this.#isAcpClientLive(client) ||
        createEpoch !== this.#lifecycle.epoch
      ) {
        return;
      }
      const createdTier = client.currentTier ?? extractSessionTier(created._meta);
      this.store.applySessionSnapshot({
        sessionId: created.sessionId,
        cwd: state.cwd,
        configOptions: created.configOptions,
        models: created.models,
        modes: created.modes,
        ...(createdTier ? { tier: createdTier } : {}),
      });
      this.#drainPendingNewSessionUpdates(created.sessionId, createEpoch);
      this.#syncTerminalTitle();
      if (hasCarryOver) {
        await this.#applySessionControls(client, created.sessionId, carryOver, createEpoch, {
          clampInvalidThought: true,
          toastFailurePrefix: 'Failed to carry over',
        });
        if (
          this.#shuttingDown ||
          !this.#isAcpClientLive(client) ||
          createEpoch !== this.#lifecycle.epoch
        ) {
          return;
        }
      }
      this.#bindSessionMetrics(created.sessionId);
      this.#ensureSwarmWatcher(created.sessionId, { forceRestart: true });
      this.#commitActiveTodoSessionRoute(
        createEpoch,
        created.sessionId,
        client,
        sessionTodoProvider
      );
      this.store.setCreatingSession(false);
      void this.#refreshGitStatus();
      this.osc.setStatusIdle();
      await this.#persistSessionAnchorAndOsc();
      if (this.#shuttingDown || createEpoch !== this.#lifecycle.epoch) return;
      this.store.pushToast('Started a new session', 'info', { ttl: 2000 });
      this.scheduler.renderNow();
      this.syncFocus();
    } catch (err) {
      if (
        this.#shuttingDown ||
        createEpoch !== this.#lifecycle.epoch ||
        (!this.#acpClientAlive && this.store.getState().connectionStatus === 'crashed')
      ) {
        return;
      }
      this.#resetLifecycleToIdle();
      const recovery = await this.#recoverPreviousSessionAfterFailure(
        client,
        previous,
        null,
        createEpoch
      );
      if (recovery === 'superseded') {
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      this.store.pushToast(
        recovery === 'restored'
          ? `Failed to create session: ${errMsg}; restored previous session.`
          : `Failed to create session: ${errMsg}. Use /new or /resume to continue.`,
        'error'
      );
      this.scheduler.renderNow();
      this.syncFocus();
    }
  }

  async #saveConfigSafe(): Promise<boolean> {
    if (this.#configWriteBlockedReason) {
      this.store.pushToast(
        `config.toml has syntax errors; change kept in memory only until fixed`,
        'warning',
        { ttl: 3200 }
      );
      this.scheduler.renderNow();
      return false;
    }

    let ok = false;
    const writeStep = async (): Promise<void> => {
      if (this.#configWriteBlockedReason) {
        ok = false;
        return;
      }
      // Guard against overwriting an existing malformed config.toml even if the
      // controller was instantiated without forwarding `configParseError`.
      if (!this.#configVerifiedWritable) {
        const probe = await loadConfig({ path: this.#configPath });
        if (probe.exists && probe.parseError) {
          this.#configWriteBlockedReason = probe.parseError;
          this.store.pushToast(
            `config.toml has syntax errors; change kept in memory only until fixed`,
            'warning',
            { ttl: 3200 }
          );
          this.scheduler.renderNow();
          ok = false;
          return;
        }
        this.#configVerifiedWritable = true;
      }

      try {
        // Always persist the latest in-memory config snapshot so rapid serialized
        // toggles never clobber a newer change with an older snapshot.
        await saveConfig(cloneConfig(this.#config), this.#configPath);
        ok = true;
      } catch (err) {
        this.store.pushToast(
          `Failed to save config.toml: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        );
        this.scheduler.renderNow();
        ok = false;
      }
    };

    const next = this.#configSaveChain.then(writeStep, writeStep);
    this.#configSaveChain = next.catch(() => {});
    await next;
    return ok;
  }

  async #applyModelQuery(query: string, overrideThoughtLevel?: string): Promise<void> {
    const client = this.#acpClient;
    const state = this.store.getState();
    if (!client || !state.sessionId) return;

    const resolved = resolveModelSelection(query, {
      configOptions: [...state.configOptions],
      models: state.models,
      modes: state.modes,
    });

    if (!resolved) {
      this.store.pushToast(`No model matching "${query}"`, 'warning');
      this.scheduler.renderNow();
      return;
    }

    try {
      const applied = await applyModelSelection(
        client,
        state.sessionId,
        resolved,
        overrideThoughtLevel
      );
      if (applied.configOptions) {
        this.store.updateConfigOptions(applied.configOptions);
      } else {
        this.store.updateCurrentModelId(applied.appliedModelId);
      }

      // Record & persist `recent_models` to `config.toml`
      const updatedRecent = this.store.recordRecentModel(applied.appliedModelId);
      this.#config = {
        ...this.#config,
        recent_models: [...updatedRecent],
      };
      void this.#saveConfigSafe();

      const label = applied.appliedThoughtLevel
        ? `${applied.appliedModelId} (${applied.appliedThoughtLevel})`
        : isOrchestratorModelId(applied.appliedModelId)
          ? 'Orchestrator'
          : applied.appliedModelId;
      this.store.pushToast(`Switched model to ${label}`, 'success', { ttl: 2500 });
      await this.#persistSessionAnchorAndOsc();
      this.scheduler.renderNow();
    } catch (err) {
      this.store.pushToast(
        `Failed to switch model: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
      this.scheduler.renderNow();
    }
  }

  async #loadInitialAgySettings(): Promise<void> {
    try {
      const loaded = await loadAgySettings({ path: this.#agySettingsPath });
      if (this.#shuttingDown) return;
      this.store.setOrchestratorSettings(loaded.settings.orchestrator);
      if (loaded.presentKeys.includes('showThinking')) {
        const show = loaded.settings.showThinking;
        this.store.setShowThinking(show);
        if (show) {
          this.store.setAutoCollapseThought(false);
        }
      }
      this.scheduler.markDirty();
    } catch {
      // Non-fatal: keep defaults if settings.json is unreadable
    }
  }

  async #handleThinkingDisplay(mode: 'on' | 'off' | 'toggle'): Promise<void> {
    const state = this.store.getState();
    const currentlyLiveExpanded = state.showThinking && !state.autoCollapseThought;
    const enabled = mode === 'on' ? true : mode === 'off' ? false : !currentlyLiveExpanded;

    this.store.setShowThinking(enabled);
    this.store.setAutoCollapseThought(enabled ? false : this.#config.ui.auto_collapse_thought);
    this.store.transcript.setAllThoughtsOpen(enabled);

    try {
      const saved = await saveAgySettings(
        { showThinking: enabled },
        { path: this.#agySettingsPath }
      );
      if (this.store.getState().settings) {
        this.store.setSettingsAgySettings(saved.settings);
      }
    } catch (err) {
      this.store.pushToast(
        `Thinking ${enabled ? 'enabled' : 'disabled'} in session (failed to save settings.json: ${
          err instanceof Error ? err.message : String(err)
        })`,
        'warning',
        { ttl: 2800 }
      );
      this.scheduler.renderNow();
      return;
    }

    this.store.pushToast(
      enabled
        ? 'Live thinking stream enabled (stays expanded)'
        : 'Live thinking stream disabled',
      'info',
      { ttl: 2200 }
    );
    this.scheduler.renderNow();
  }

  async #applyOrchestratorRoleModel(
    role: 'planner' | 'executor',
    modelId: string,
    selectedThought?: string
  ): Promise<void> {
    const state = this.store.getState();
    const choice = state.controls.availableModels.find(c => c.value === modelId);
    const modelName = choice?.name || modelId;
    const thoughtChoices = resolveThoughtLevelsForModel(
      modelId,
      state.controls,
      state.modelThoughtLevels
    );
    const clampedThought =
      thoughtChoices.length > 0
        ? clampThoughtLevelForChoices(selectedThought ?? 'high', thoughtChoices)
        : undefined;
    const spec = formatOrchestratorModelSpec(modelName, clampedThought);
    if (!spec) return;

    const nextOrchestrator = {
      ...state.orchestratorSettings,
      [role]: spec,
    };

    try {
      const saved = await saveAgySettings(
        { orchestrator: nextOrchestrator },
        { path: this.#agySettingsPath }
      );
      this.store.setOrchestratorSettings(saved.settings.orchestrator);
      if (this.store.getState().settings) {
        this.store.setSettingsAgySettings(saved.settings);
      }

      // When updating Planner while currently in Orchestrator mode, keep the active ACP
      // Orchestrator variant aligned (Neon / Carbon / Argon) whenever a matching variant exists.
      if (
        role === 'planner' &&
        isOrchestratorModelId(state.controls.currentModelId) &&
        this.#acpClient &&
        state.sessionId
      ) {
        const targetOrchId = resolveAcpOrchestratorModelIdForPlanner(
          modelId,
          state.controls.availableModels,
          state.controls.currentModelId
        );
        if (targetOrchId && targetOrchId !== state.controls.currentModelId) {
          try {
            const res = await this.#acpClient.setConfigOption({
              sessionId: state.sessionId,
              configId: 'model',
              value: targetOrchId,
            });
            this.store.updateConfigOptions(res.configOptions);
            await this.#persistSessionAnchorAndOsc();
          } catch {
            // Non-fatal: settings.json is already updated
          }
        }
      }

      const roleLabel = role === 'planner' ? 'Planner' : 'Executor';
      this.store.pushToast(
        `Orchestrator ${roleLabel} set to ${spec}`,
        'success',
        { ttl: 2500 }
      );
    } catch (err) {
      this.store.pushToast(
        `Failed to save Orchestrator ${role}: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    }
    this.scheduler.renderNow();
  }

  async #applyOrchestratorRoleThoughtLevel(
    role: 'planner' | 'executor',
    level: string,
    silent: boolean
  ): Promise<string | null> {
    const state = this.store.getState();
    if (!isOrchestratorModelId(state.controls.currentModelId)) return null;

    const parsedRole = parseOrchestratorModelSpec(state.orchestratorSettings[role]);
    const fallbackRole =
      role === 'planner'
        ? inferOrchestratorDefaultPlannerModel(state.controls.currentModelId)
        : inferOrchestratorDefaultExecutorModel(state.controls.currentModelId);
    const modelName =
      parsedRole?.modelName ??
      fallbackRole?.modelName ??
      (role === 'planner' ? 'Gemini 4 Carbon' : 'Gemini 4 Hydrogen');
    const choices = resolveOrchestratorRoleThoughtLevels(
      role,
      state.controls,
      state.modelThoughtLevels,
      parsedRole?.modelName
    );
    if (choices.length === 0) return null;

    const trimmed = level.trim().toLowerCase();
    const normalizedInput = trimmed === 'extra' ? 'xhigh' : trimmed;
    const matched =
      choices.find(
        c =>
          c.value.toLowerCase() === normalizedInput ||
          c.name.toLowerCase() === trimmed
      ) ??
      choices.find(c => c.value.toLowerCase().startsWith(normalizedInput));

    const targetChoice =
      matched ??
      (silent
        ? choices.find(c => c.value === clampThoughtLevelForChoices(normalizedInput, choices))
        : undefined);
    if (!targetChoice) {
      if (!silent) {
        this.store.pushToast(
          `Invalid thought level "${level}". Available: ${choices.map(c => c.value).join(', ')}`,
          'warning'
        );
        this.scheduler.renderNow();
      }
      return null;
    }

    const spec = formatOrchestratorModelSpec(modelName, targetChoice.value);
    const nextOrchestrator = {
      ...state.orchestratorSettings,
      [role]: spec,
    };

    try {
      const saved = await saveAgySettings(
        { orchestrator: nextOrchestrator },
        { path: this.#agySettingsPath }
      );
      this.store.setOrchestratorSettings(saved.settings.orchestrator);
      if (this.store.getState().settings) {
        this.store.setSettingsAgySettings(saved.settings);
      }
      if (!silent) {
        const roleLabel = role === 'planner' ? 'Planner' : 'Executor';
        this.store.pushToast(
          `${roleLabel} thinking set to ${targetChoice.name} (${modelName})`,
          'success',
          { ttl: 2200 }
        );
      }
      this.scheduler.renderNow();
      return targetChoice.value;
    } catch (err) {
      if (!silent) {
        this.store.pushToast(
          `Failed to save Orchestrator ${role} thinking level: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        );
        this.scheduler.renderNow();
      }
      return null;
    }
  }

  async #cycleOrchestratorRoleThinking(role: 'planner' | 'executor'): Promise<void> {
    const state = this.store.getState();
    const { controls } = state;
    if (!isOrchestratorModelId(controls.currentModelId)) return;
    const parsedRole = parseOrchestratorModelSpec(state.orchestratorSettings[role]);
    const choices = resolveOrchestratorRoleThoughtLevels(
      role,
      controls,
      state.modelThoughtLevels,
      parsedRole?.modelName
    );
    if (choices.length === 0) return;
    const curVal = clampThoughtLevelForChoices(parsedRole?.thoughtLevel ?? 'high', choices);
    const curIdx = choices.findIndex(c => c.value === curVal);
    const next = choices[(curIdx + 1 + choices.length) % choices.length];
    if (!next) return;
    await this.#applyOrchestratorRoleThoughtLevel(role, next.value, false);
  }

  async #applyThoughtLevel(level: string, silent: boolean): Promise<void> {
    const client = this.#acpClient;
    const state = this.store.getState();
    if (!client || !state.sessionId) return;

    if (
      !state.controls.supportsThoughtLevel &&
      isOrchestratorModelId(state.controls.currentModelId)
    ) {
      await this.#applyOrchestratorRoleThoughtLevel('planner', level, silent);
      return;
    }

    const resolved = resolveThoughtLevel(level, [...state.configOptions]);
    if (!resolved.ok) {
      if (!silent) {
        const msg =
          resolved.reason === 'unsupported'
            ? 'Current model does not support thought_level'
            : `Invalid thought level "${level}". Available: ${resolved.available.join(', ')}`;
        this.store.pushToast(msg, 'warning');
        this.scheduler.renderNow();
      }
      return;
    }

    try {
      const res = await client.setConfigOption({
        sessionId: state.sessionId,
        configId: 'thought_level',
        value: resolved.value,
      });
      this.store.updateConfigOptions(res.configOptions);
      if (!silent) {
        this.store.pushToast(
          `Thought level set to ${resolved.name ?? resolved.value}`,
          'success',
          { ttl: 2000 }
        );
        await this.#persistSessionAnchorAndOsc();
      }
      this.scheduler.renderNow();
    } catch (err) {
      if (!silent) {
        this.store.pushToast(
          `Failed to set thought level: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        );
        this.scheduler.renderNow();
      }
    }
  }

  async cycleThinkingLevel(): Promise<void> {
    const state = this.store.getState();
    const { controls } = state;
    if (!controls.supportsThoughtLevel && isOrchestratorModelId(controls.currentModelId)) {
      await this.#cycleOrchestratorRoleThinking('planner');
      return;
    }
    if (!controls.supportsThoughtLevel || controls.availableThoughtLevels.length === 0) {
      return;
    }
    const choices = controls.availableThoughtLevels;
    const curIdx = choices.findIndex(c => c.value === controls.currentThoughtLevel);
    const next = choices[(curIdx + 1 + choices.length) % choices.length];
    if (!next) return;
    await this.#applyThoughtLevel(next.value, false);
  }

  async #applyMode(modeInput: string, silent: boolean): Promise<void> {
    const client = this.#acpClient;
    const state = this.store.getState();
    if (!client || !state.sessionId) return;

    const resolved = resolveModeSelection(modeInput, {
      configOptions: [...state.configOptions],
      models: state.models,
      modes: state.modes,
    });
    if (!resolved) {
      if (!silent) {
        this.store.pushToast(`Unknown mode "${modeInput}"`, 'warning');
        this.scheduler.renderNow();
      }
      return;
    }

    try {
      if (resolved.strategy === 'config_option') {
        const res = await client.setConfigOption({
          sessionId: state.sessionId,
          configId: 'mode',
          value: resolved.modeId,
        });
        this.store.updateConfigOptions(res.configOptions);
      } else {
        await client.setMode({ sessionId: state.sessionId, modeId: resolved.modeId });
        this.store.updateCurrentModeId(resolved.modeId);
      }
      if (!silent) {
        this.store.pushToast(`Mode: ${resolved.modeName ?? resolved.modeId}`, 'info', {
          ttl: 2000,
        });
        await this.#persistSessionAnchorAndOsc();
      }
      this.scheduler.renderNow();
    } catch (err) {
      if (!silent) {
        this.store.pushToast(
          `Failed to switch mode: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        );
        this.scheduler.renderNow();
      }
    }
  }

  async cycleMode(): Promise<void> {
    const state = this.store.getState();
    const next = getNextModeSelection({
      configOptions: [...state.configOptions],
      models: state.models,
      modes: state.modes,
    });
    if (!next) return;
    await this.#applyMode(next.modeId, false);
  }

  // -------------------------------------------------------------------------
  // `/settings` (`<prefs>`), Info Overlays, `/export`, `/logout`, Turn Retry
  // -------------------------------------------------------------------------

  async #openSettings(page?: SettingsPageId): Promise<void> {
    this.#pickerLoadToken += 1;

    let agySnapshot = {};
    try {
      const loaded = await loadAgySettings({ path: this.#agySettingsPath });
      agySnapshot = loaded.settings;
      this.store.setOrchestratorSettings(loaded.settings.orchestrator);
    } catch {
      agySnapshot = {};
    }

    const panel = this.store.openSettings({
      page,
      agySettings: agySnapshot,
    });
    const computed = computeSettingsData(
      this.store.getState(),
      panel,
      this.#config,
      this.#configPath,
      this.#agySettingsPath
    );
    this.store.setSettingsFocus(computed.visibleRowIds[0] ?? null);
    this.scheduler.renderNow();
    this.syncFocus();
  }

  #closeSettings(): void {
    if (!this.store.closeSettings()) return;
    this.scheduler.renderNow();
    this.syncFocus(true);
  }

  #setSettingsPageWithFocus(page: SettingsPageId): void {
    this.store.setSettingsPage(page);
    const state = this.store.getState();
    if (state.settings) {
      const computed = computeSettingsData(
        state,
        state.settings,
        this.#config,
        this.#configPath,
        this.#agySettingsPath
      );
      this.store.setSettingsFocus(computed.visibleRowIds[0] ?? null);
    }
    this.scheduler.renderNow();
  }

  #updateSettingsQueryAndFocus(query: string, cursor: number): void {
    this.store.updateSettingsQuery(query, cursor);
    const state = this.store.getState();
    if (state.settings) {
      const computed = computeSettingsData(
        state,
        state.settings,
        this.#config,
        this.#configPath,
        this.#agySettingsPath
      );
      const keep =
        state.settings.focus && computed.visibleRowIds.includes(state.settings.focus)
          ? state.settings.focus
          : computed.visibleRowIds[0] ?? null;
      this.store.setSettingsFocus(keep);
    }
    this.scheduler.renderNow();
  }

  async #handleSettingsActivate(rowId: string): Promise<void> {
    const state = this.store.getState();
    if (!state.settings) return;
    const computed = computeSettingsData(
      state,
      state.settings,
      this.#config,
      this.#configPath,
      this.#agySettingsPath
    );
    const row = computed.rowById.get(rowId);
    if (!row || row.disabled || !row.control) return;

    const ctrl = row.control;
    if (ctrl.k === 'switch') {
      await this.#handleSettingsChange(row.id, !ctrl.on);
    } else if (ctrl.k === 'choice' && ctrl.options && ctrl.options.length > 0) {
      const opts = ctrl.options;
      const curIdx = Math.max(
        0,
        opts.findIndex(o => o.value === ctrl.value)
      );
      const nextOpt = opts[(curIdx + 1) % opts.length];
      if (nextOpt) {
        await this.#handleSettingsChange(row.id, nextOpt.value);
      }
    } else if (ctrl.k === 'number') {
      const step = ctrl.step ?? 1;
      const min = ctrl.min ?? 1;
      const max = ctrl.max ?? 200;
      const curVal = typeof ctrl.value === 'number' ? ctrl.value : min;
      const nextVal = curVal + step > max ? min : curVal + step;
      await this.#handleSettingsChange(row.id, nextVal);
    } else if (ctrl.k === 'text') {
      const curText = ctrl.value ?? '';
      this.store.setSettingsEditing({
        row: row.id,
        draft: curText,
        cursor: curText.length,
      });
      this.scheduler.renderNow();
    } else if (ctrl.k === 'action' && ctrl.act) {
      await this.#handleSettingsAction(ctrl.act, row.id);
    }
  }

  async #handleSettingsChange(rowId: string, value: unknown): Promise<void> {
    // 1. Live ACP Session controls
    if (rowId === 'session.model') {
      if (typeof value === 'string' && value.trim()) {
        await this.#applyModelQuery(value);
      }
      return;
    }
    if (rowId === 'session.thought') {
      if (typeof value === 'string' && value.trim()) {
        await this.#applyThoughtLevel(value, false);
      }
      return;
    }
    if (rowId === 'session.mode') {
      if (typeof value === 'string' && value.trim()) {
        await this.#applyMode(value, false);
      }
      return;
    }

    // 2. Session-only UI toggles
    if (rowId === 'ui.show_thinking') {
      this.store.setShowThinking(Boolean(value));
      this.scheduler.renderNow();
      return;
    }
    if (rowId === 'ui.expand_all_tools') {
      this.store.setExpandAllTools(Boolean(value));
      this.scheduler.renderNow();
      return;
    }

    // 3. `oma` persisted settings (`config.toml`)
    let omaUpdated = false;
    let omaSavedToast: string | null = null;
    if (rowId === 'ui.auto_collapse_thought') {
      const next = Boolean(value);
      this.#config = {
        ...this.#config,
        ui: { ...this.#config.ui, auto_collapse_thought: next },
      };
      this.store.setAutoCollapseThought(next);
      omaUpdated = true;
    } else if (rowId === 'ui.collapse_compacted') {
      const next = Boolean(value);
      this.#config = {
        ...this.#config,
        ui: { ...this.#config.ui, collapse_compacted: next },
      };
      this.store.setCollapseCompacted(next);
      omaUpdated = true;
    } else if (rowId === 'ui.tool_display') {
      const next: ToolDisplayMode = normalizeToolDisplayMode(value);
      this.#config = {
        ...this.#config,
        ui: { ...this.#config.ui, tool_display: next },
      };
      this.store.setToolDisplayMode(next);
      omaUpdated = true;
    } else if (rowId === 'ui.tool_preview_lines') {
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(num)) {
        const clamped = Math.min(200, Math.max(1, Math.round(num)));
        this.#config = {
          ...this.#config,
          ui: { ...this.#config.ui, tool_preview_lines: clamped },
        };
        omaUpdated = true;
      }
    } else if (rowId === 'ui.todo_provider') {
      const next: TodoProvider = normalizeTodoProvider(value);
      if (next === 'native' && !this.#supportsNativeTodo()) {
        const ver = this.#getAgentVersion();
        this.store.pushToast(
          `Native update_steps requires agy >= 1.5.16${ver ? ` (detected ${ver})` : ''}.`,
          'warning'
        );
        this.scheduler.renderNow();
        return;
      }
      this.#config = {
        ...this.#config,
        ui: { ...this.#config.ui, todo_provider: next },
      };
      this.store.transcript.setPreferNativeSteps(
        this.#getActiveOrPendingTodoProvider() === 'native'
      );
      if (next === 'off') {
        this.#clearTodoAutoClearTimer();
      } else {
        this.#scheduleTodoAutoClearIfDone();
      }
      omaUpdated = true;
      omaSavedToast =
        next === 'off'
          ? 'Saved todo_provider = off — todo HUD hidden; start a new session (/new) or reconnect to stop MCP todo'
          : `Saved todo_provider = ${next} — start a new session (/new) or reconnect to apply`;
    } else if (rowId === 'ui.osc_7501') {
      const next = Boolean(value);
      this.#config = {
        ...this.#config,
        ui: { ...this.#config.ui, osc_7501: next },
      };
      this.#recreateOscWriter();
      omaUpdated = true;
    } else if (rowId === 'ui.reopen_anchor') {
      const next = Boolean(value);
      this.#config = {
        ...this.#config,
        ui: { ...this.#config.ui, reopen_anchor: next },
      };
      this.#recreateOscWriter();
      omaUpdated = true;
    } else if (rowId === 'defaults.model') {
      this.#config = {
        ...this.#config,
        default_model: typeof value === 'string' ? value.trim() : '',
      };
      omaUpdated = true;
    } else if (rowId === 'defaults.thought') {
      this.#config = {
        ...this.#config,
        default_thought: typeof value === 'string' ? value.trim() : '',
      };
      omaUpdated = true;
    } else if (rowId === 'defaults.mode') {
      this.#config = {
        ...this.#config,
        default_mode: typeof value === 'string' ? value.trim() : '',
      };
      omaUpdated = true;
    } else if (rowId === 'defaults.agy_bin') {
      this.#config = {
        ...this.#config,
        agy_bin: typeof value === 'string' ? value.trim() : '',
      };
      omaUpdated = true;
    } else if (rowId === 'approval.auto_allow_tools') {
      let nextList: string[];
      if (Array.isArray(value)) {
        nextList = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
      } else if (typeof value === 'string' && value.trim().length > 0) {
        const cur = new Set(this.#config.approval.auto_allow_tools);
        if (cur.has(value)) cur.delete(value);
        else cur.add(value);
        nextList = [...cur];
      } else {
        nextList = [];
      }
      this.#config = {
        ...this.#config,
        approval: { auto_allow_tools: nextList },
      };
      this.store.approvals.setAutoAllowTools(nextList);
      omaUpdated = true;
    }

    if (omaUpdated) {
      const ok = await this.#saveConfigSafe();
      if (ok) {
        this.store.pushToast(
          omaSavedToast ?? 'Saved setting to config.toml',
          omaSavedToast ? 'info' : 'success',
          { ttl: omaSavedToast ? 3000 : 1800 }
        );
      }
      this.scheduler.renderNow();
      return;
    }

    // 4. `agy` strict safe allowlist settings (`~/.gemini/antigravity-cli/settings.json`)
    if (rowId.startsWith('agy.')) {
      const key = rowId.slice('agy.'.length);
      if (!isAgySafeSettingKey(key)) return;
      try {
        const saved = await saveAgySettings(
          { [key]: value },
          { path: this.#agySettingsPath }
        );
        this.store.setSettingsAgySettings(saved.settings);
        this.store.pushToast(
          `Saved agy "${key}" — reconnect or start a new session to apply`,
          'info',
          { ttl: 3000 }
        );
      } catch (err) {
        this.store.pushToast(
          `Failed to save agy settings.json: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        );
      }
      this.scheduler.renderNow();
    }
  }

  async #handleSettingsAction(act: string, value?: unknown): Promise<void> {
    if (act === 'close-edit') {
      this.store.setSettingsEditing(null);
      this.scheduler.renderNow();
      return;
    }
    if (act === 'edit') {
      const rowId = typeof value === 'string' ? value : this.store.getState().settings?.focus;
      if (!rowId) return;
      const state = this.store.getState();
      if (!state.settings) return;
      const computed = computeSettingsData(
        state,
        state.settings,
        this.#config,
        this.#configPath,
        this.#agySettingsPath
      );
      const row = computed.rowById.get(rowId);
      if (row && !row.disabled && row.control && row.control.k === 'text') {
        const curText = row.control.value ?? '';
        this.store.setSettingsEditing({
          row: row.id,
          draft: curText,
          cursor: curText.length,
        });
        this.scheduler.renderNow();
      }
      return;
    }
    if (act === 'pick-planner') {
      await this.#openPicker('planner', '');
      return;
    }
    if (act === 'pick-executor') {
      await this.#openPicker('executor', '');
      return;
    }
    if (act === 'save-defaults') {
      const { controls } = this.store.getState();
      this.#config = {
        ...this.#config,
        default_model: controls.currentModelId ?? this.#config.default_model,
        default_thought: controls.supportsThoughtLevel
          ? (controls.currentThoughtLevel ?? this.#config.default_thought)
          : '',
        default_mode: controls.currentModeId ?? this.#config.default_mode,
      };
      const ok = await this.#saveConfigSafe();
      if (ok) {
        this.store.pushToast('Saved current session controls as defaults', 'success', {
          ttl: 2200,
        });
      }
      this.scheduler.renderNow();
      return;
    }
    if (act === 'reset-defaults') {
      this.#config = cloneConfig({
        ...DEFAULT_CONFIG,
        recent_models: [...this.#config.recent_models],
      });
      this.store.setAutoCollapseThought(this.#config.ui.auto_collapse_thought);
      this.store.setCollapseCompacted(this.#config.ui.collapse_compacted);
      this.store.setToolDisplayMode(this.#config.ui.tool_display);
      this.store.transcript.setPreferNativeSteps(
        this.#getActiveOrPendingTodoProvider() === 'native'
      );
      this.store.approvals.setAutoAllowTools(this.#config.approval.auto_allow_tools);
      this.#recreateOscWriter();
      const ok = await this.#saveConfigSafe();
      if (ok) {
        this.store.pushToast('Reset oma settings to defaults', 'info', { ttl: 2200 });
      }
      this.scheduler.renderNow();
      return;
    }
    if (act === 'reconnect') {
      await this.#retryAfterCrash();
      return;
    }
    if (act === 'open-mcp') {
      await this.#openPicker('mcp', '');
      return;
    }
    if (act === 'open-plugins') {
      await this.#openPicker('plugins', '');
      return;
    }
    if (act === 'open-skills') {
      await this.#openPicker('skills', '');
      return;
    }
    if (act === 'open-agents') {
      await this.#openPicker('agents', '');
      return;
    }
    if (act === 'login') {
      this.#closeSettings();
      await this.#handleAuthLogin();
      return;
    }
    if (act === 'logout') {
      this.#openInfoOverlay('logout_confirm');
    }
  }

  #openInfoOverlay(kind: 'status' | 'context' | 'usage' | 'logout_confirm' | 'jobs'): void {
    this.#pickerLoadToken += 1;
    this.store.openInfoOverlay(kind, {
      configPath: this.#configPath,
      agySettingsPath: this.#agySettingsPath,
    });
    this.scheduler.renderNow();
    this.syncFocus();
  }

  #closeInfoOverlay(): void {
    if (!this.store.closeInfoOverlay()) return;
    this.scheduler.renderNow();
    this.syncFocus();
  }

  async #performLogout(): Promise<void> {
    const client = this.#acpClient;
    this.store.closeInfoOverlay();
    if (!client || !client.supportsLogout) {
      this.store.pushToast('Current agy acp backend does not support auth/logout', 'warning');
      this.scheduler.renderNow();
      this.syncFocus();
      return;
    }
    if (this.#logoutInFlightClient === client) {
      return;
    }

    const wasInTransition =
      this.#lifecycle.phase === 'creating' || this.#lifecycle.phase === 'replaying';
    if (wasInTransition) {
      this.#resetLifecycleToIdle({
        advanceEpoch: true,
        abortError: new Error('Signed out'),
        resetStore: true,
      });
    }

    this.#logoutInFlightClient = client;
    try {
      await client.logout();
      if (this.#shuttingDown || this.#acpClient !== client) {
        return;
      }
      this.#bootstrapSeq += 1;
      this.#lastCommittedSession = null;
      this.#stopSwarmWatcher();
      this.#preservedAnchorTodoState = null;
      this.#hasRestoredUserAnchor = false;
      this.#resetLifecycleToIdle({
        advanceEpoch: true,
        abortError: new Error('Signed out'),
        resetStore: true,
      });
      this.osc.setStatusBlocked('auth');
      this.store.setAuthRequired({
        message: 'Signed out of Antigravity. Run /login or click Sign in to reconnect.',
        authMethods: this.#authMethods,
      });
      this.store.pushToast('Signed out of Antigravity', 'success', { ttl: 2500 });
    } catch (err) {
      const isSameClient = !this.#shuttingDown && this.#acpClient === client;
      const curState = this.store.getState();
      const shouldRecoverStartup = isSameClient && curState.connectionStatus === 'initializing';
      const shouldRecoverSwitch =
        isSameClient && curState.connectionStatus === 'ready' && wasInTransition;
      this.store.pushToast(
        `Failed to sign out: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
      this.#logoutInFlightClient = null;
      if (shouldRecoverStartup) {
        await this.#retryAfterCrash({ forceRestart: true });
        return;
      }
      if (shouldRecoverSwitch) {
        let recovered = false;
        if (this.#lastCommittedSession) {
          const recovery = await this.#recoverPreviousSessionAfterFailure(
            client,
            this.#lastCommittedSession,
            null,
            this.#lifecycle.epoch
          );
          if (recovery === 'superseded') {
            return;
          }
          recovered = recovery === 'restored';
        }
        if (
          !recovered &&
          !this.#shuttingDown &&
          this.#isAcpClientLive(client) &&
          this.store.getState().sessionId === null
        ) {
          await this.#startNewSession();
          return;
        }
      }
    } finally {
      if (this.#logoutInFlightClient === client) {
        this.#logoutInFlightClient = null;
      }
    }
    this.scheduler.renderNow();
    this.syncFocus();
  }

  #getAgentVersion(): string | undefined {
    const state = this.store.getState();
    return state.agentVersion ?? state.agentInfo?.version;
  }

  #supportsNativeTodo(): boolean {
    return supportsNativeUpdateSteps(this.#getAgentVersion());
  }

  #getEffectiveTodoProvider(): TodoProvider {
    return resolveEffectiveTodoProvider(this.#config.ui.todo_provider, this.#getAgentVersion());
  }

  #getActiveOrPendingTodoProvider(): TodoProvider {
    if (this.#lifecycle.phase === 'ready') return this.#lifecycle.provider;
    if (this.#lifecycle.phase === 'creating' || this.#lifecycle.phase === 'replaying') {
      if (this.#lifecycle.provider) return this.#lifecycle.provider;
    }
    return this.#getEffectiveTodoProvider();
  }

  #isTodoMcpEnabled(): boolean {
    if (this.#enableTodoMcpOverride !== undefined) {
      return this.#enableTodoMcpOverride;
    }
    return this.#getEffectiveTodoProvider() === 'mcp';
  }

  #isTodoDisabled(): boolean {
    return this.#enableTodoMcpOverride === undefined && this.#getEffectiveTodoProvider() === 'off';
  }

  #ensureTodoServer(forceEnable = false): EmbeddedTodoMcpServer | null {
    if ((!forceEnable && !this.#isTodoMcpEnabled()) || this.#shuttingDown) {
      this.#todoServer?.dispose();
      this.#todoServer = null;
      return null;
    }
    if (this.#todoServer) {
      return this.#todoServer;
    }
    try {
      this.#todoServer = new EmbeddedTodoMcpServer({
        version: OMA_VERSION,
        requireSessionRoute: true,
        onTodoChanged: event => {
          this.#handleLiveTodoServerUpdate(event);
        },
      });
      return this.#todoServer;
    } catch {
      return null;
    }
  }

  #commitActiveTodoSessionRoute(
    epoch: number,
    sessionId: string,
    client: AcpClient,
    todoProvider: TodoProvider
  ): void {
    const state = this.store.getState();
    if (
      this.#shuttingDown ||
      epoch !== this.#lifecycle.epoch ||
      !this.#isAcpClientLive(client) ||
      state.authRequired !== null ||
      state.sessionId !== sessionId
    ) {
      return;
    }
    this.#lifecycle = {
      phase: 'ready',
      epoch,
      sessionId,
      provider: todoProvider,
    };
    this.#lastCommittedSession = {
      sessionId,
      cwd: state.cwd,
      ...(state.sessionTitle ? { title: state.sessionTitle } : {}),
      todoProvider,
    };
    this.store.transcript.setPreferNativeSteps(todoProvider === 'native');
    if (todoProvider === 'mcp') {
      this.#todoServer?.seedSession(sessionId, this.store.transcript.todoPhases);
      this.#todoServer?.commitSessionRoute(epoch, sessionId);
    } else {
      this.#todoServer?.revokeSessionRoute();
    }
  }

  #buildSessionBootstrapOptions(
    epoch: number,
    client: AcpClient,
    todoProviderOverride?: TodoProvider
  ): {
    mcpServers: McpServerConfig[];
    _meta?: Record<string, unknown>;
    todoProvider: TodoProvider;
  } {
    const nonMcpProvider: TodoProvider =
      todoProviderOverride && todoProviderOverride !== 'mcp'
        ? todoProviderOverride
        : this.#isTodoDisabled()
          ? 'off'
          : this.#getEffectiveTodoProvider() === 'native'
            ? 'native'
            : 'off';
    if (todoProviderOverride && todoProviderOverride !== 'mcp') {
      return { mcpServers: [], todoProvider: todoProviderOverride };
    }
    if (this.#shuttingDown || epoch !== this.#lifecycle.epoch || !this.#isAcpClientLive(client)) {
      return { mcpServers: [], todoProvider: nonMcpProvider };
    }
    const server = this.#ensureTodoServer(todoProviderOverride === 'mcp');
    if (!server) {
      return { mcpServers: [], todoProvider: nonMcpProvider };
    }
    return {
      mcpServers: [server.openSessionRoute(epoch)],
      _meta: {
        antigravity: {
          systemPrompt: {
            append: OMA_TODO_SYSTEM_PROMPT_APPEND,
          },
        },
      },
      todoProvider: 'mcp',
    };
  }

  #clearTodoAutoClearTimer(): void {
    if (this.#todoAutoClearTimer !== undefined) {
      clearTimeout(this.#todoAutoClearTimer);
      this.#todoAutoClearTimer = undefined;
    }
  }

  #scheduleTodoAutoClearIfDone(): void {
    this.#clearTodoAutoClearTimer();
    const delayMs = this.#todoAutoClearDelayMs;
    if (
      this.#isTodoDisabled() ||
      this.#todoHudDismissed ||
      !Number.isFinite(delayMs) ||
      delayMs < 0
    ) {
      return;
    }

    const plan = this.store.transcript.plan;
    if (!plan) {
      return;
    }
    const expectedEpoch = this.#lifecycle.epoch;

    if (plan.source === 'acp') {
      if (
        plan.entries.length === 0 ||
        !plan.entries.every(entry => isChecklistStatusFinished(entry.status))
      ) {
        return;
      }
      const snapshotJson = JSON.stringify(plan);
      this.#todoAutoClearTimer = setTimeout(() => {
        this.#todoAutoClearTimer = undefined;
        if (this.#shuttingDown || expectedEpoch !== this.#lifecycle.epoch) return;
        if (JSON.stringify(this.store.transcript.plan) !== snapshotJson) return;
        this.#todoHudDismissed = true;
        this.scheduler.renderNow();
      }, delayMs);
      this.#todoAutoClearTimer.unref?.();
      return;
    }

    const phases = this.store.transcript.todoPhases;
    if (!areAllTodosFinished(phases)) {
      return;
    }
    const snapshotJson = JSON.stringify(phases);
    this.#todoAutoClearTimer = setTimeout(() => {
      this.#todoAutoClearTimer = undefined;
      if (this.#shuttingDown || expectedEpoch !== this.#lifecycle.epoch) return;
      if (
        this.store.transcript.plan?.source !== 'todo_tool' ||
        JSON.stringify(this.store.transcript.todoPhases) !== snapshotJson
      ) {
        return;
      }
      this.#todoHudDismissed = true;
      this.scheduler.renderNow();
    }, delayMs);
    this.#todoAutoClearTimer.unref?.();
  }

  #handleLiveTodoServerUpdate(event: TodoServerUpdateEvent): void {
    if (this.#shuttingDown) return;
    const state = this.store.getState();
    if (
      !this.#acpClientAlive ||
      state.authRequired !== null ||
      !state.isReady ||
      this.#lifecycle.phase !== 'ready' ||
      event.sessionId !== state.sessionId
    ) {
      return;
    }
    this.store.transcript.applyLiveTodoToolResult(event);
    if (!event.isError && event.op !== 'view') {
      this.#pendingTodoSyncReminder = null;
      this.#hasRestoredUserAnchor = false;
      this.#preservedAnchorTodoState = null;
      this.#todoHudDismissed = false;
      this.#scheduleTodoAutoClearIfDone();
      void this.#persistSessionAnchorAndOsc().catch(() => {});
    }
    this.scheduler.markDirty();
  }

  #commitUserTodoEdit(
    nextPhases: readonly TodoPhase[],
    reason: string,
    options: { readonly removed?: boolean } = {}
  ): void {
    const cleaned = cloneTodoPhases(nextPhases).filter(phase => phase.tasks.length > 0);
    this.store.transcript.setTodoPhases(cleaned, { source: 'user' });
    this.#hasRestoredUserAnchor = false;
    this.#preservedAnchorTodoState = null;
    const activeSessionId = this.store.getState().sessionId;
    if (activeSessionId && this.#todoServer) {
      this.#todoServer.seedSession(activeSessionId, cleaned);
    }
    this.#todoHudDismissed = false;
    this.#scheduleTodoAutoClearIfDone();
    this.#pendingTodoSyncReminder = formatUserTodoSyncReminder(
      reason,
      cleaned,
      options.removed === true
    );
    this.scheduler.renderNow();
    void this.#persistSessionAnchorAndOsc().catch(() => {});
  }

  async #editTodoInExternalEditor(editorCmd: string, initialMd: string): Promise<string | null> {
    const dir = await mkdtemp(path.join(tmpdir(), 'oma-todo-'));
    const filePath = path.join(dir, 'todos.todo.md');
    await writeFile(filePath, initialMd, 'utf8');
    const wasRaw = Boolean((process.stdin as { isRaw?: boolean }).isRaw);
    this.osc.showCursor();
    this.surface.suspend();
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(false);
      }
      const editorArgs = splitTodoShellArgs(editorCmd);
      if (editorArgs.length === 0) return null;
      const proc = Bun.spawn([...editorArgs, filePath], {
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) return null;
      const edited = await readFile(filePath, 'utf8');
      return edited === initialMd ? null : edited;
    } finally {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(wasRaw);
      }
      this.surface.resume();
      this.#syncTerminalTitle({ hideCursor: true });
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  #canEditSessionTodos():
    | { readonly ok: true; readonly sessionId: string; readonly epoch: number }
    | { readonly ok: false; readonly reason: string } {
    if (this.#shuttingDown) {
      return { ok: false, reason: '' };
    }
    if (this.#isTodoDisabled()) {
      return {
        ok: false,
        reason: 'Todo tracking is Off. Enable MCP or Native in /settings.',
      };
    }
    const state = this.store.getState();
    if (
      !this.#acpClientAlive ||
      state.authRequired !== null ||
      !state.isReady ||
      !state.sessionId ||
      this.#lifecycle.phase !== 'ready'
    ) {
      return {
        ok: false,
        reason:
          state.connectionStatus === 'ready' &&
          !state.sessionId &&
          !state.isReplaying &&
          !state.isCreatingSession
            ? 'No active session — use /new or /resume before editing todos.'
            : 'Session is not ready yet',
      };
    }
    if (this.#lifecycle.provider !== 'mcp' || !this.#todoServer) {
      return {
        ok: false,
        reason: this.#isTodoMcpEnabled()
          ? 'MCP todo is not active in this session yet; start a new session (/new) or /resume to enable manual /todo editing.'
          : 'Todo engine is set to Native (update_steps); manual /todo editing requires MCP (oma_todo) in /settings.',
      };
    }
    return { ok: true, sessionId: state.sessionId, epoch: this.#lifecycle.epoch };
  }

  async #handleTodoCommand(argsText: string): Promise<void> {
    const trimmed = argsText.trim();
    const sepIdx = trimmed.search(/\s/);
    const verb = (sepIdx === -1 ? trimmed : trimmed.slice(0, sepIdx)).toLowerCase();
    const rest = sepIdx === -1 ? '' : trimmed.slice(sepIdx + 1).trim();

    if (this.#isTodoDisabled() && verb !== 'help' && verb !== '?') {
      this.store.pushToast(
        'Todo tracking is Off. Enable MCP or Native in /settings.',
        'warning'
      );
      this.scheduler.renderNow();
      return;
    }

    const state = this.store.getState();
    const current = cloneTodoPhases(this.store.transcript.todoPhases);
    const activePlan = this.store.transcript.plan;
    const isAcpPlanActive = activePlan?.source === 'acp' && activePlan.entries.length > 0;
    const displayPhases = isAcpPlanActive
      ? buildDisplayPhasesFromAcpPlan(activePlan)
      : current.length > 0
        ? current
        : buildDisplayPhasesFromAcpPlan(activePlan);

    if (!trimmed) {
      if (displayPhases.length === 0) {
        this.store.pushToast(
          this.#isTodoMcpEnabled()
            ? 'No todos. Use /todo append <task> to start one.'
            : 'No active steps. Native update_steps is managed by the agent.',
          'info'
        );
      } else {
        this.store.transcript.addInfoNotice(formatTodoMarkdown(displayPhases).trimEnd(), 'info');
      }
      this.scheduler.renderNow();
      return;
    }

    const isMutatingVerb =
      verb === 'import' ||
      verb === 'edit' ||
      verb === 'append' ||
      verb === 'start' ||
      verb === 'done' ||
      verb === 'drop' ||
      verb === 'clear' ||
      verb === 'rm';

    let expectedSessionId: string | null = state.sessionId;
    const expectedEpoch = this.#lifecycle.epoch;
    if (isMutatingVerb) {
      const editGate = this.#canEditSessionTodos();
      if (!editGate.ok) {
        if (editGate.reason) {
          this.store.pushToast(editGate.reason, 'warning');
          this.scheduler.renderNow();
        }
        return;
      }
      expectedSessionId = editGate.sessionId;
    }

    switch (verb) {
      case 'expand': {
        if (displayPhases.length === 0) {
          this.store.pushToast('No todos to expand.', 'info');
          this.scheduler.renderNow();
          return;
        }
        this.#todoExpanded = true;
        this.#todoHudDismissed = false;
        this.#clearTodoAutoClearTimer();
        this.scheduler.renderNow();
        this.store.pushToast('Expanded all todo phases in HUD', 'info', { ttl: 2000 });
        return;
      }
      case 'collapse': {
        this.#todoExpanded = false;
        this.#scheduleTodoAutoClearIfDone();
        this.scheduler.renderNow();
        return;
      }
      case 'help':
      case '?': {
        this.store.transcript.addInfoNotice(TODO_HELP_TEXT, 'info');
        this.scheduler.renderNow();
        return;
      }
      case 'copy': {
        if (displayPhases.length === 0) {
          this.store.pushToast('No todos to copy.', 'warning');
          this.scheduler.renderNow();
          return;
        }
        await this.#copyTextWithToast(
          formatTodoMarkdown(displayPhases),
          'Copied todos as Markdown to clipboard'
        );
        return;
      }
      case 'export': {
        if (displayPhases.length === 0) {
          this.store.pushToast('No todos to export.', 'warning');
          this.scheduler.renderNow();
          return;
        }
        const targetFile = rest ? path.resolve(state.cwd, rest) : path.join(state.cwd, 'TODO.md');
        try {
          await mkdir(path.dirname(targetFile), { recursive: true });
          await writeFile(targetFile, formatTodoMarkdown(displayPhases), 'utf8');
          this.store.pushToast(`Wrote todos to ${targetFile}`, 'success', { ttl: 3000 });
        } catch (err) {
          this.store.pushToast(
            `Failed to write todos: ${err instanceof Error ? err.message : String(err)}`,
            'error'
          );
        }
        this.scheduler.renderNow();
        return;
      }
      case 'import': {
        const targetFile = rest ? path.resolve(state.cwd, rest) : path.join(state.cwd, 'TODO.md');
        let raw = '';
        try {
          raw = await readFile(targetFile, 'utf8');
        } catch (err) {
          this.store.pushToast(
            `Failed to read todos: ${err instanceof Error ? err.message : String(err)}`,
            'error'
          );
          this.scheduler.renderNow();
          return;
        }
        const postImportGate = this.#canEditSessionTodos();
        if (
          !postImportGate.ok ||
          postImportGate.epoch !== expectedEpoch ||
          postImportGate.sessionId !== expectedSessionId
        ) {
          if (
            !postImportGate.ok &&
            postImportGate.reason &&
            !this.#shuttingDown &&
            expectedEpoch === this.#lifecycle.epoch
          ) {
            this.store.pushToast(postImportGate.reason, 'warning');
            this.scheduler.renderNow();
          }
          return;
        }
        const parsed = parseTodoMarkdown(raw);
        if (parsed.errors.length > 0) {
          this.store.pushToast(`Could not parse ${targetFile}: ${parsed.errors[0]}`, 'error');
          this.scheduler.renderNow();
          return;
        }
        this.#commitUserTodoEdit(parsed.phases, `/todo import ${targetFile}`, { removed: true });
        const total = parsed.phases.reduce((sum, p) => sum + p.tasks.length, 0);
        this.store.pushToast(
          `Imported ${parsed.phases.length} phase(s), ${total} task(s) from ${targetFile}.`,
          'success'
        );
        return;
      }
      case 'edit': {
        const expectedTodoRevision = this.store.transcript.todoRevision;
        const initialMd =
          current.length > 0
            ? formatTodoMarkdown(current)
            : '# Todos\n- [ ] (replace this with your tasks)\n';
        let editedMd: string | null = null;
        try {
          if (this.#editTodoExternal) {
            editedMd = await this.#editTodoExternal(initialMd);
          } else {
            const editorCmd = (process.env.VISUAL || process.env.EDITOR || '').trim();
            if (!editorCmd) {
              this.store.pushToast(
                'No editor configured. Set $VISUAL or $EDITOR environment variable.',
                'warning'
              );
              this.scheduler.renderNow();
              return;
            }
            editedMd = await this.#editTodoInExternalEditor(editorCmd, initialMd);
          }
        } catch (err) {
          this.store.pushToast(
            `Failed to open editor: ${err instanceof Error ? err.message : String(err)}`,
            'error'
          );
          this.scheduler.renderNow();
          return;
        }
        const postEditGate = this.#canEditSessionTodos();
        if (
          !postEditGate.ok ||
          postEditGate.epoch !== expectedEpoch ||
          postEditGate.sessionId !== expectedSessionId
        ) {
          if (
            !postEditGate.ok &&
            postEditGate.reason &&
            !this.#shuttingDown &&
            expectedEpoch === this.#lifecycle.epoch
          ) {
            this.store.pushToast(postEditGate.reason, 'warning');
            this.scheduler.renderNow();
          }
          return;
        }
        if (this.store.transcript.todoRevision !== expectedTodoRevision) {
          this.store.pushToast(
            'Todos changed while editor was open; kept latest list.',
            'warning'
          );
          this.scheduler.renderNow();
          return;
        }
        if (editedMd === null) {
          this.store.pushToast('Editor exited without saving; todos unchanged.', 'info');
          this.scheduler.renderNow();
          return;
        }
        const parsed = parseTodoMarkdown(editedMd);
        if (parsed.errors.length > 0) {
          this.store.pushToast(`Could not parse Markdown: ${parsed.errors[0]}`, 'error');
          this.scheduler.renderNow();
          return;
        }
        this.#commitUserTodoEdit(parsed.phases, '/todo edit', { removed: true });
        const total = parsed.phases.reduce((sum, p) => sum + p.tasks.length, 0);
        this.store.pushToast(`Updated todos (${total} task(s)).`, 'success');
        return;
      }
      case 'append': {
        const tokens = tokenizeTodoShellArgs(rest);
        if (tokens.length === 0) {
          this.store.pushToast('Usage: /todo append [<phase>] <task...>', 'warning');
          this.scheduler.renderNow();
          return;
        }
        let targetPhase: TodoPhase | undefined;
        let taskText = '';
        if (tokens.length === 1) {
          taskText = tokens[0]!.value.trim();
          targetPhase = current[current.length - 1];
        } else {
          const first = tokens[0]!;
          const matchedPhase = findTodoPhaseFuzzy(current, first.value);
          if (matchedPhase) {
            targetPhase = matchedPhase;
            taskText = tokens
              .slice(1)
              .map(t => t.value)
              .join(' ')
              .trim();
          } else if (first.quoted) {
            targetPhase = { name: formatPhaseDisplayTitle(first.value), tasks: [] };
            current.push(targetPhase);
            taskText = tokens
              .slice(1)
              .map(t => t.value)
              .join(' ')
              .trim();
          } else {
            taskText = tokens.map(t => t.value).join(' ').trim();
            targetPhase = current[current.length - 1];
          }
        }
        if (!targetPhase) {
          targetPhase = { name: 'Todos', tasks: [] };
          current.push(targetPhase);
        }
        if (!taskText) {
          this.store.pushToast('Usage: /todo append [<phase>] <task...>', 'warning');
          this.scheduler.renderNow();
          return;
        }
        if (current.some(p => p.tasks.some(t => t.content === taskText))) {
          this.store.pushToast(`Duplicate task "${taskText}".`, 'warning');
          this.scheduler.renderNow();
          return;
        }
        targetPhase.tasks.push({ content: taskText, status: 'pending' });
        normalizeSingleInProgress(current);
        this.#commitUserTodoEdit(current, `/todo append -> ${targetPhase.name}`);
        this.store.pushToast(`Appended to ${targetPhase.name}: ${taskText}`, 'success');
        return;
      }
      case 'start': {
        if (!rest) {
          this.store.pushToast('Usage: /todo start <task>', 'warning');
          this.scheduler.renderNow();
          return;
        }
        const match = findTodoTaskFuzzy(current, rest);
        if (!match) {
          this.store.pushToast(`No task matched "${rest}".`, 'warning');
          this.scheduler.renderNow();
          return;
        }
        const outcome = applyTodoOperation(current, { op: 'start', task: match.task.content });
        if (outcome.isError) {
          this.store.pushToast(outcome.errors.join('; '), 'error');
          this.scheduler.renderNow();
          return;
        }
        this.#commitUserTodoEdit(outcome.phases, `/todo start ${match.task.content}`);
        this.store.pushToast(`Started: ${match.task.content}`, 'success');
        return;
      }
      case 'done':
      case 'drop': {
        const op = verb === 'done' ? 'done' : 'drop';
        const label = verb === 'done' ? 'completed' : 'abandoned';
        if (!rest) {
          const allContents = current.flatMap(p => p.tasks.map(t => t.content));
          const outcome =
            allContents.length > 0
              ? applyTodoOperation(current, { op, task: allContents })
              : { phases: current, errors: [], isError: false };
          if (outcome.isError) {
            this.store.pushToast(outcome.errors.join('; '), 'error');
            this.scheduler.renderNow();
            return;
          }
          this.#commitUserTodoEdit(outcome.phases, `/todo ${op} (all)`);
          this.store.pushToast(`Marked all tasks ${label}.`, 'success');
          return;
        }
        const taskMatch = findTodoTaskFuzzy(current, rest);
        if (taskMatch) {
          const outcome = applyTodoOperation(current, { op, task: taskMatch.task.content });
          if (outcome.isError) {
            this.store.pushToast(outcome.errors.join('; '), 'error');
            this.scheduler.renderNow();
            return;
          }
          this.#commitUserTodoEdit(outcome.phases, `/todo ${op} ${taskMatch.task.content}`);
          this.store.pushToast(`Marked ${label}: ${taskMatch.task.content}`, 'success');
          return;
        }
        const phaseMatch = findTodoPhaseFuzzy(current, rest);
        if (phaseMatch) {
          const outcome = applyTodoOperation(current, { op, phase: phaseMatch.name });
          if (outcome.isError) {
            this.store.pushToast(outcome.errors.join('; '), 'error');
            this.scheduler.renderNow();
            return;
          }
          this.#commitUserTodoEdit(outcome.phases, `/todo ${op} ${phaseMatch.name}`);
          this.store.pushToast(`Marked phase ${phaseMatch.name} ${label}.`, 'success');
          return;
        }
        this.store.pushToast(`No task or phase matched "${rest}".`, 'warning');
        this.scheduler.renderNow();
        return;
      }
      case 'clear':
      case 'rm': {
        if (verb === 'clear' || !rest) {
          this.#commitUserTodoEdit([], '/todo rm (all)', { removed: true });
          this.store.pushToast('Cleared all todos.', 'success');
          return;
        }
        const taskMatch = findTodoTaskFuzzy(current, rest);
        if (taskMatch) {
          const outcome = applyTodoOperation(current, { op: 'rm', task: taskMatch.task.content });
          if (outcome.isError) {
            this.store.pushToast(outcome.errors.join('; '), 'error');
            this.scheduler.renderNow();
            return;
          }
          this.#commitUserTodoEdit(outcome.phases, `/todo rm ${taskMatch.task.content}`, {
            removed: true,
          });
          this.store.pushToast(`Removed: ${taskMatch.task.content}`, 'success');
          return;
        }
        const phaseMatch = findTodoPhaseFuzzy(current, rest);
        if (phaseMatch) {
          const outcome = applyTodoOperation(current, { op: 'rm', phase: phaseMatch.name });
          if (outcome.isError) {
            this.store.pushToast(outcome.errors.join('; '), 'error');
            this.scheduler.renderNow();
            return;
          }
          this.#commitUserTodoEdit(outcome.phases, `/todo rm ${phaseMatch.name}`, { removed: true });
          this.store.pushToast(`Removed phase: ${phaseMatch.name}`, 'success');
          return;
        }
        this.store.pushToast(`No task or phase matched "${rest}".`, 'warning');
        this.scheduler.renderNow();
        return;
      }
      default: {
        this.store.pushToast(
          `Unknown /todo verb "${verb}". Run /todo help for usage.`,
          'warning'
        );
        this.scheduler.renderNow();
      }
    }
  }

  async #exportTranscript(targetPath?: string): Promise<void> {
    const state = this.store.getState();
    try {
      const res = await exportTranscriptMarkdown(
        this.store.transcript.turns,
        {
          sessionId: state.sessionId,
          title: state.sessionTitle,
          cwd: state.cwd,
          model: state.controls.currentModelId,
          thoughtLevel: state.controls.currentThoughtLevel,
          mode: state.controls.currentModeId,
          exportedAt: this.#now(),
          ...(this.#dataDir ? { dataDir: this.#dataDir } : {}),
        },
        targetPath
      );
      this.store.pushToast(`Exported transcript (${res.turnCount} turns)`, 'success', {
        sub: res.path,
        ttl: 3500,
      });
    } catch (err) {
      this.store.pushToast(
        `Failed to export transcript: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    }
    this.scheduler.renderNow();
  }

  async #handleRenameSession(rawTitle: string): Promise<void> {
    const state = this.store.getState();
    if (!state.sessionId || state.isReplaying || state.isCreatingSession) {
      this.store.pushToast('No active session to rename.', 'warning');
      this.scheduler.renderNow();
      return;
    }

    const trimmed = rawTitle.trim();
    if (!trimmed) {
      const currentTitle = normalizeSessionTitle(state.sessionTitle);
      const sourceLabel = state.sessionTitleSource === 'user' ? 'custom' : 'auto';
      this.store.pushToast(
        currentTitle
          ? `Current title: "${currentTitle}" (${sourceLabel}) — use /rename <title> or /rename --reset`
          : 'Usage: /rename <title> (or /rename --reset to restore auto title)',
        'info',
        { ttl: 3500 }
      );
      this.scheduler.renderNow();
      return;
    }

    if (trimmed === '--reset' || trimmed === '--auto') {
      const restored =
        this.#lastAutoSessionTitle?.sessionId === state.sessionId
          ? this.#lastAutoSessionTitle.title
          : null;
      this.store.setSessionTitle(restored, restored ? 'auto' : null, { force: true });
      this.#syncTerminalTitle();
      await this.#persistSessionAnchorAndOsc();
      this.store.pushToast(
        restored
          ? `Restored auto title "${restored}"`
          : 'Cleared custom title; waiting for auto title',
        'success',
        { ttl: 2500 }
      );
      this.scheduler.renderNow();
      return;
    }

    const normalized = normalizeSessionTitle(trimmed);
    if (!normalized) {
      this.store.pushToast('Session title cannot be empty.', 'warning');
      this.scheduler.renderNow();
      return;
    }

    this.store.setSessionTitle(normalized, 'user');
    this.#syncTerminalTitle();
    await this.#persistSessionAnchorAndOsc();
    this.store.pushToast(`Session renamed to "${normalized}"`, 'success', {
      sub: 'Saved locally in oma',
      ttl: 2500,
    });
    this.scheduler.renderNow();
  }

  async #retryTurn(turnIndex: number): Promise<void> {
    const turn = this.store.transcript.turns.find(t => t.index === turnIndex);
    if (!turn?.user) return;
    await this.#sendPromptToAcp(turn.user.text, turn.user.attachments);
  }

  async #handleRetryShortcut(): Promise<void> {
    const state = this.store.getState();
    if (state.crashError) {
      await this.#retryAfterCrash();
      return;
    }
    if (state.isStreaming) return;
    const turns = this.store.transcript.turns;
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i];
      if (t && t.status === 'error' && t.user) {
        await this.#sendPromptToAcp(t.user.text, t.user.attachments);
        return;
      }
    }
  }

  async #exportTrafficLog(): Promise<void> {
    const baseDir = this.#dataDir ?? getDataDir();
    const file = path.join(baseDir, 'logs', `traffic-${Date.now()}.jsonl`);
    try {
      const count = await this.store.traffic.exportToFile(file);
      this.store.pushToast(`Exported ${count} log entries`, 'success', { sub: file });
    } catch (err) {
      this.store.pushToast(
        `Failed to export log: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    }
    this.scheduler.renderNow();
  }

  async #retryAfterCrash(options?: { readonly forceRestart?: boolean }): Promise<void> {
    if (this.#reconnectInFlight && !options?.forceRestart) {
      return this.#reconnectInFlight;
    }
    const reconnectSeq = ++this.#reconnectSeq;
    const task = (async () => {
      const state = this.store.getState();
      const previousSessionId = this.#lastCommittedSession?.sessionId;
      if (this.#lastCommittedSession?.cwd && !sameDir(state.cwd, this.#lastCommittedSession.cwd)) {
        this.store.setCwd(this.#lastCommittedSession.cwd);
      }
      const oldClient = this.#acpClient;
      this.#bootstrapSeq += 1;
      this.#acpClient = null;
      this.#acpClientAlive = false;
      this.#logoutInFlightClient = null;
      this.#resetLifecycleToIdle({ advanceEpoch: true });
      if (oldClient) {
        await oldClient.close({ timeoutMs: 200 }).catch(() => {});
      }
      if (this.#shuttingDown || reconnectSeq !== this.#reconnectSeq) return;
      this.store.setCrashError(null);
      this.store.setAuthRequired(null);
      if (previousSessionId === undefined) {
        this.store.resetSessionState({ keepCommands: true });
      }
      await this.#bootstrapAcp(previousSessionId);
    })();
    this.#reconnectInFlight = task;
    try {
      await task;
    } finally {
      if (this.#reconnectInFlight === task) {
        this.#reconnectInFlight = null;
      }
    }
  }

  async #handleAuthLogin(): Promise<void> {
    const wasRaw = Boolean((process.stdin as { isRaw?: boolean }).isRaw);
    this.osc.showCursor();
    this.surface.suspend();
    try {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(false);
      }
      let exitCode = 0;
      if (this.#runLogin) {
        exitCode = await this.#runLogin();
      } else {
        const proc = Bun.spawn([this.#resolveAgyBin(), 'acp', '--login'], {
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        });
        exitCode = await proc.exited;
      }
      if (exitCode !== 0) {
        this.store.pushToast(`Login exited with code ${exitCode}`, 'warning');
      }
    } finally {
      if (process.stdin.isTTY && typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(wasRaw || true);
      }
      this.surface.resume();
      this.#syncTerminalTitle({ hideCursor: true });
    }

    this.store.setAuthRequired(null);
    await this.#retryAfterCrash();
  }

  // -------------------------------------------------------------------------
  // Anchor Persistence, OSC & Signal Helpers
  // -------------------------------------------------------------------------

  #syncTerminalTitle(options?: { readonly force?: boolean; readonly hideCursor?: boolean }): void {
    const nextTitle = formatTerminalTitle(this.store.getState().sessionTitle);
    if (options?.hideCursor) {
      this.osc.setTitleAndHideCursor(nextTitle);
      this.#lastEmittedTerminalTitle = nextTitle;
      return;
    }
    if (!options?.force && nextTitle === this.#lastEmittedTerminalTitle) {
      return;
    }
    if (this.osc.cursorHidden) {
      this.osc.setTitleAndHideCursor(nextTitle);
    } else {
      this.osc.setTitle(nextTitle);
    }
    this.#lastEmittedTerminalTitle = nextTitle;
  }

  async #persistSessionAnchorAndOsc(): Promise<void> {
    if (this.#shuttingDown) return;
    const state = this.store.getState();
    if (state.isReplaying) return;
    const expectedSid = state.sessionId;
    if (!expectedSid) return;
    const expectedEpoch = this.#lifecycle.epoch;

    const firstUserText = this.store.transcript.turns.find(t => t.user?.text)?.user?.text;
    const title =
      state.sessionTitle ||
      (firstUserText ? firstUserText.trim().split(/\r?\n/)[0]?.slice(0, 80) : '') ||
      'New Session';
    const preservedTodoState =
      this.#preservedAnchorTodoState?.sessionId === expectedSid &&
      this.#preservedAnchorTodoState.todoState.toolCallCount >=
        this.store.transcript.todoToolCallCount
        ? this.#preservedAnchorTodoState.todoState
        : null;
    if (!preservedTodoState && this.#preservedAnchorTodoState?.sessionId === expectedSid) {
      this.#preservedAnchorTodoState = null;
    }
    const snapshotTodoState: PersistedSessionTodoState | undefined = preservedTodoState
      ? {
          phases: cloneTodoPhases(preservedTodoState.phases),
          toolCallCount: preservedTodoState.toolCallCount,
          source: 'user',
        }
      : this.store.transcript.hasPersistedTodoState
        ? {
            phases: cloneTodoPhases(this.store.transcript.todoPhases),
            toolCallCount: this.store.transcript.persistedTodoToolCallCount,
            source: this.store.transcript.hasUserTodoOverride ? 'user' : 'auto',
          }
        : undefined;
    const snapshot = {
      sessionId: expectedSid,
      cwd: state.cwd,
      title,
      ...(state.sessionTitle && state.sessionTitleSource
        ? { titleSource: state.sessionTitleSource }
        : {}),
      ...(state.controls.currentModelId ? { model: state.controls.currentModelId } : {}),
      ...(state.controls.currentThoughtLevel
        ? { thoughtLevel: state.controls.currentThoughtLevel }
        : {}),
      ...(state.controls.currentModeId ? { mode: state.controls.currentModeId } : {}),
      turnCount: this.store.transcript.turns.length,
      preview: this.store.transcript.getPreviewMessages(3, 400),
      ...(snapshotTodoState ? { todoState: snapshotTodoState } : {}),
    };

    const writeStep = async (): Promise<void> => {
      try {
        const anchorFile = await this.#previewStore.save(snapshot);
        if (
          this.#shuttingDown ||
          expectedEpoch !== this.#lifecycle.epoch ||
          this.store.getState().sessionId !== expectedSid
        ) {
          return;
        }
        this.osc.setReopenAnchor(anchorFile);
      } catch {
        // Anchor persistence errors must not interrupt interactive conversation
      }
    };

    const prev = this.#anchorSaveChains.get(expectedSid) ?? Promise.resolve();
    const next = prev.then(writeStep, writeStep);
    const settled = next.catch(() => {}).finally(() => {
      if (this.#anchorSaveChains.get(expectedSid) === settled) {
        this.#anchorSaveChains.delete(expectedSid);
      }
    });
    this.#anchorSaveChains.set(expectedSid, settled);
    await next;
  }

  async #deleteSessionAnchor(sessionId: string): Promise<void> {
    if (!sessionId) return;
    const deleteStep = async (): Promise<void> => {
      try {
        await this.#previewStore.delete(sessionId);
      } catch {
        // Best-effort anchor cleanup must not interrupt session flows
      }
    };
    const prev = this.#anchorSaveChains.get(sessionId) ?? Promise.resolve();
    const next = prev.then(deleteStep, deleteStep);
    const settled = next.catch(() => {}).finally(() => {
      if (this.#anchorSaveChains.get(sessionId) === settled) {
        this.#anchorSaveChains.delete(sessionId);
      }
    });
    this.#anchorSaveChains.set(sessionId, settled);
    await next;
  }

  #restoreOscAfterBlock(): void {
    const state = this.store.getState();
    if (this.store.approvals.hasPending()) {
      this.osc.setStatusBlocked('permission');
    } else if (state.activeQuestion) {
      this.osc.setStatusBlocked('question');
    } else if (state.isBusy) {
      this.osc.setStatusWorking();
    } else {
      this.osc.setStatusIdle();
    }
  }

  #scheduleDoneToIdle(): void {
    this.#clearDoneIdleTimer();
    this.#doneIdleTimer = setTimeout(() => {
      this.#doneIdleTimer = undefined;
      const state = this.store.getState();
      if (
        !this.#shuttingDown &&
        !state.isBusy &&
        !this.store.approvals.hasPending() &&
        !state.activeQuestion
      ) {
        this.osc.setStatusIdle();
      }
    }, DONE_TO_IDLE_DELAY_MS);
  }

  #clearDoneIdleTimer(): void {
    if (this.#doneIdleTimer !== undefined) {
      clearTimeout(this.#doneIdleTimer);
      this.#doneIdleTimer = undefined;
    }
  }

  #isSwarmCoordinatorWorking(): boolean {
    const snap = this.store.getState().swarmSnapshot;
    return snap?.memberByName['coordinator']?.status === 'working';
  }

  #scheduleBackgroundDone(delayMs?: number): void {
    this.#clearBackgroundDoneTimer();
    if (this.#shuttingDown) return;
    const waitMs = delayMs ?? this.#backgroundDoneGraceMs;
    const expectedEpoch = this.#lifecycle.epoch;
    this.#backgroundDoneTimer = setTimeout(() => {
      this.#backgroundDoneTimer = undefined;
      void (async () => {
        if (
          this.#shuttingDown ||
          expectedEpoch !== this.#lifecycle.epoch ||
          !this.#pendingBackgroundDone
        ) {
          return;
        }
        if (this.#metricsTracker.hasTranscriptData) {
          await this.#syncSessionMetricsFromTranscript({ reconcileBackground: false });
          if (
            this.#shuttingDown ||
            expectedEpoch !== this.#lifecycle.epoch ||
            !this.#pendingBackgroundDone
          ) {
            return;
          }
        }
        const state = this.store.getState();
        if (
          state.isStreaming ||
          state.hasActiveBackgroundTasks ||
          state.isSwarmWorking ||
          this.#isSwarmCoordinatorWorking() ||
          this.#awaitingSwarmCoordinatorReply
        ) {
          return;
        }
        if (this.#metricsTracker.hasTranscriptData) {
          const activity = this.#metricsTracker.getLatestTurnActivity();
          const transcriptAuthoritativelyFinal =
            !activity ||
            activity.resetAll === true ||
            (activity.latestKind === 'planner_final' &&
              activity.latestStepSeq > this.#backgroundResumeAnchorStepSeq);
          const stalledTooLong =
            this.#backgroundWaitLastProgressAt > 0 &&
            this.#now() - this.#backgroundWaitLastProgressAt >=
              DEFAULT_BACKGROUND_TRANSCRIPT_STALL_MS;
          if (!transcriptAuthoritativelyFinal && !stalledTooLong) {
            const recheckMs = Math.min(this.#backgroundDoneGraceMs, this.#toolWatchIntervalMs);
            this.#scheduleBackgroundDone(recheckMs);
            return;
          }
        }
        this.#pendingBackgroundDone = false;
        this.#awaitingPostToolWakeup = false;
        this.#backgroundResumeAnchorStepSeq = 0;
        this.#backgroundWaitLastProgressAt = 0;
        this.#awaitingSwarmCoordinatorReply = false;
        this.#workingStartedAt = undefined;
        const finalizedTurn = this.store.transcript.finalizeBackgroundTurn({
          autoCollapseThought: this.store.autoCollapseThought,
          expandAllTools: state.expandAllTools,
        });
        if (this.#metricsTracker.isStreaming) {
          const endedSnap = this.#metricsTracker.endStreamTurn();
          this.#applySessionMetricsSnapshot(endedSnap);
        }
        const settleIdx = finalizedTurn?.index ?? this.#deferredSettleTurnIndex;
        this.#deferredSettleTurnIndex = null;
        // Ensure any late chunks or tool updates are flushed to the screen before notifying done
        this.scheduler.renderNow();
        if (settleIdx !== null) {
          this.scheduler.settleTurn(settleIdx);
          this.osc.reassertCursorHidden({ force: true });
        }
        if (!this.store.approvals.hasPending() && !state.activeQuestion) {
          this.osc.setStatusDone();
          this.#scheduleDoneToIdle();
        }
        this.#syncToolWatchTimer();
        void this.#syncSessionMetricsFromTranscript();
        void this.#persistSessionAnchorAndOsc();
      })();
    }, waitMs);
  }

  #clearBackgroundDoneTimer(): void {
    if (this.#backgroundDoneTimer !== undefined) {
      clearTimeout(this.#backgroundDoneTimer);
      this.#backgroundDoneTimer = undefined;
    }
  }

  #syncToolWatchTimer(): void {
    const shouldWatch =
      !this.#shuttingDown &&
      !this.store.getState().isReplaying &&
      (this.store.transcript.hasInFlightToolCall() ||
        this.store.hasActiveBackgroundTasks() ||
        this.store.transcript.hasRunningDaemonTasks() ||
        this.#pendingBackgroundDone);
    if (!shouldWatch) {
      this.#clearToolWatchTimer();
      return;
    }
    if (this.#toolWatchTimer !== undefined) {
      return;
    }
    this.#lastWatchedRunningJobs =
      this.store.transcript.getBackgroundJobsSnapshot().runningJobCount;
    this.#toolWatchTimer = setInterval(() => {
      if (
        this.#shuttingDown ||
        this.store.getState().isReplaying ||
        (!this.store.transcript.hasInFlightToolCall() &&
          !this.store.hasActiveBackgroundTasks() &&
          !this.store.transcript.hasRunningDaemonTasks() &&
          !this.#pendingBackgroundDone)
      ) {
        this.#clearToolWatchTimer();
        return;
      }
      void this.#syncSessionMetricsFromTranscript();
      const runningJobs =
        this.store.transcript.getBackgroundJobsSnapshot().runningJobCount;
      if (runningJobs !== this.#lastWatchedRunningJobs) {
        this.#lastWatchedRunningJobs = runningJobs;
        this.scheduler.markDirty();
      }
    }, this.#toolWatchIntervalMs);
  }

  #clearToolWatchTimer(): void {
    if (this.#toolWatchTimer !== undefined) {
      clearInterval(this.#toolWatchTimer);
      this.#toolWatchTimer = undefined;
    }
    this.#lastWatchedRunningJobs = -1;
  }

  #bindSessionMetrics(sessionId: string | null, autoSync = true): void {
    this.#metricsTracker.setSession(sessionId);
    this.#lastTpsStoreFlushAt = 0;
    this.store.setSessionMetrics(null);
    if (sessionId && autoSync) {
      void this.#syncSessionMetricsFromTranscript();
    }
  }

  #applySessionMetricsSnapshot(snap: SessionMetricsSnapshot): boolean {
    const isEmpty =
      snap.totalInputTokens === 0 &&
      snap.totalOutputTokens === 0 &&
      snap.responseCount === 0 &&
      snap.currentTps === null;
    const next = isEmpty ? null : snap;
    const prev = this.store.getState().sessionMetrics;
    if (areSessionMetricsEqual(prev, next)) return false;
    this.store.setSessionMetrics(next);
    return true;
  }

  async #syncSessionMetricsFromTranscript(
    options: { readonly reconcileBackground?: boolean } = {}
  ): Promise<void> {
    if (this.#shuttingDown) return;
    const expectedSessionId = this.#metricsTracker.sessionId;
    if (!expectedSessionId) return;
    const prevActivitySeq = this.#metricsTracker.getLatestTurnActivity()?.latestStepSeq ?? 0;
    const snap = await this.#metricsTracker.syncFromTranscript();
    if (this.#shuttingDown || this.#metricsTracker.sessionId !== expectedSessionId) return;
    const nextActivity = this.#metricsTracker.getLatestTurnActivity();
    if (nextActivity && nextActivity.latestStepSeq > prevActivitySeq) {
      this.#backgroundWaitLastProgressAt = this.#now();
    }
    let dirty = this.#applySessionMetricsSnapshot(snap);
    const checkpoint = this.#metricsTracker.getLatestCheckpoint();
    if (checkpoint && this.store.transcript.applyTranscriptCompactionCheckpoint(checkpoint)) {
      dirty = true;
    }
    if (!this.store.getState().isReplaying) {
      const prevBusy = this.store.isBusy;
      const bgRecords = this.#metricsTracker.getTranscriptBackgroundTasks();
      const bgSynced =
        bgRecords.length > 0 && this.store.transcript.syncTranscriptBackgroundTasks(bgRecords);
      if (bgSynced) {
        dirty = true;
        this.#lastWatchedRunningJobs =
          this.store.transcript.getBackgroundJobsSnapshot().runningJobCount;
      }
      if (options.reconcileBackground !== false) {
        const shouldWakeupAfterTranscriptTerminal =
          bgSynced &&
          prevBusy &&
          !this.store.getState().isStreaming &&
          !this.store.hasActiveBackgroundTasks() &&
          !this.store.isSwarmWorking &&
          !this.#isSwarmCoordinatorWorking() &&
          !this.#awaitingSwarmCoordinatorReply;

        if (shouldWakeupAfterTranscriptTerminal) {
          if (nextActivity?.resetAll === true) {
            this.#pendingBackgroundDone = false;
            this.#awaitingPostToolWakeup = false;
            this.#backgroundResumeAnchorStepSeq = 0;
            this.#backgroundWaitLastProgressAt = 0;
            this.#clearBackgroundDoneTimer();
            if (!this.store.approvals.hasPending() && !this.store.getState().activeQuestion) {
              this.osc.setStatusIdle();
            }
            this.#syncToolWatchTimer();
          } else {
            this.#awaitingPostToolWakeup = true;
            this.#backgroundResumeAnchorStepSeq = Math.max(
              this.#backgroundResumeAnchorStepSeq,
              nextActivity?.latestKind === 'planner_final'
                ? prevActivitySeq
                : (nextActivity?.latestStepSeq ?? 0)
            );
            this.#backgroundWaitLastProgressAt = this.#now();
            this.#reconcileBackgroundActivity(prevBusy);
          }
        } else if (bgSynced) {
          this.#reconcileBackgroundActivity(prevBusy);
        }

        if (
          this.#pendingBackgroundDone &&
          !this.store.getState().isStreaming &&
          nextActivity &&
          nextActivity.latestStepSeq > prevActivitySeq &&
          nextActivity.latestKind === 'planner_final' &&
          nextActivity.latestStepSeq > this.#backgroundResumeAnchorStepSeq &&
          !this.store.hasActiveBackgroundTasks() &&
          !this.store.isSwarmWorking &&
          !this.#isSwarmCoordinatorWorking() &&
          !this.#awaitingSwarmCoordinatorReply
        ) {
          this.#awaitingPostToolWakeup = false;
          this.#scheduleBackgroundDone(this.#backgroundDoneGraceMs);
        }
      }
    }
    if (dirty) {
      this.scheduler.markDirty();
    }
  }

  async #refreshGitStatus(options: { force?: boolean } = {}): Promise<void> {
    if (this.#shuttingDown) return;
    const cwd = this.store.getState().cwd;
    if (!cwd) return;

    const now = this.#now();
    const cwdChanged = cwd !== this.#gitLastProbedCwd;
    if (
      !options.force &&
      !cwdChanged &&
      this.#gitLastProbedAt > 0 &&
      now - this.#gitLastProbedAt < GIT_PROBE_MIN_INTERVAL_MS
    ) {
      return;
    }

    if (this.#gitProbeInFlight) {
      if (options.force || cwdChanged) {
        this.#gitProbePendingForce = true;
      }
      return;
    }

    this.#gitProbeInFlight = true;
    this.#gitLastProbedAt = now;
    this.#gitLastProbedCwd = cwd;

    try {
      const status = await probeGitStatus(cwd, {
        ...(this.#gitExec ? { exec: this.#gitExec } : {}),
      });
      if (this.#shuttingDown) return;
      if (this.store.getState().cwd === cwd) {
        const prev = this.store.getState().gitStatus;
        if (!areGitStatusEqual(prev, status)) {
          this.store.setGitStatus(status);
          this.scheduler.markDirty();
        }
      }
    } finally {
      this.#gitProbeInFlight = false;
      if (this.#gitProbePendingForce && !this.#shuttingDown) {
        this.#gitProbePendingForce = false;
        void this.#refreshGitStatus({ force: true });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fullscreen Git UI (`omp.app.git`) Lifecycle & Actions
  // -------------------------------------------------------------------------

  async #openGitOverlay(): Promise<void> {
    if (this.#shuttingDown) return;
    this.store.openGitOverlay();
    this.scheduler.renderNow();
    this.syncFocus();
    await this.#refreshGitOverlay();
  }

  #closeGitOverlay(): void {
    this.#gitOverlayLoadSeq += 1;
    this.#gitOverlayDiffSeq += 1;
    if (!this.store.closeGitOverlay()) return;
    this.scheduler.renderNow();
    this.syncFocus();
  }

  async #refreshGitOverlay(): Promise<void> {
    if (this.#shuttingDown) return;
    const state = this.store.getState();
    if (!state.gitOverlay) return;
    const seq = ++this.#gitOverlayLoadSeq;
    const cwd = state.cwd;

    try {
      const snapshot = await loadGitRepoSnapshot(cwd, {
        ...(this.#gitExec ? { exec: this.#gitExec } : {}),
      });
      if (this.#shuttingDown || seq !== this.#gitOverlayLoadSeq || !this.store.getState().gitOverlay) {
        return;
      }
      const selectedKey = this.store.setGitOverlaySnapshot(snapshot);
      const prevGitStatus = this.store.getState().gitStatus;
      const syncBranch = snapshot.branch ?? snapshot.headCommit?.shortSha ?? prevGitStatus?.branch;
      if (syncBranch) {
        const untrackedCount = snapshot.unstaged.filter(f => f.kind === 'untracked').length;
        const unstagedTrackedCount = snapshot.unstaged.length - untrackedCount;
        this.store.setGitStatus({
          branch: syncBranch,
          isDirty: !snapshot.clean,
          staged: snapshot.staged.length,
          unstaged: unstagedTrackedCount,
          untracked: untrackedCount,
          ahead: prevGitStatus?.ahead ?? 0,
          behind: prevGitStatus?.behind ?? 0,
          detached: snapshot.branch === null || snapshot.branch === 'HEAD' || prevGitStatus?.detached === true,
        });
      }
      this.scheduler.renderNow();
      if (selectedKey) {
        const all = getAllVisibleGitFiles(snapshot);
        const file = all.find(f => gitFileKey(f.area, f.path) === selectedKey);
        if (file) {
          await this.#loadGitOverlayDiff(file);
        }
      }
    } catch (err) {
      if (this.#shuttingDown || seq !== this.#gitOverlayLoadSeq || !this.store.getState().gitOverlay) {
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.store.setGitOverlayLoading(false, msg);
      this.scheduler.renderNow();
    }
  }

  async #loadGitOverlayDiff(file: GitChangedFile): Promise<void> {
    const state = this.store.getState();
    const git = state.gitOverlay;
    if (!git) return;
    const seq = ++this.#gitOverlayDiffSeq;
    const key = gitFileKey(file.area, file.path);
    this.store.selectGitFileKey(key);
    this.scheduler.renderNow();

    const repoRoot = git.snapshot?.cwd ?? state.cwd;
    const gitEnv = git.snapshot?.gitEnv;
    const diff = await loadGitFileDiff(repoRoot, file, {
      wholeFile: git.viewMode === 'file',
      headSha: git.snapshot?.headCommit?.sha,
      parentSha: git.snapshot?.headCommit?.parents[0],
      ...(gitEnv ? { gitEnv } : {}),
      ...(this.#gitExec ? { exec: this.#gitExec } : {}),
    });
    if (this.#shuttingDown || seq !== this.#gitOverlayDiffSeq || !this.store.getState().gitOverlay) {
      return;
    }
    this.store.setGitFileDiff(diff);
    this.scheduler.renderNow();
  }

  async #selectGitOverlayFile(file: GitChangedFile): Promise<void> {
    const git = this.store.getState().gitOverlay;
    if (!git) return;
    if (git.focusedField !== null) {
      this.store.setGitFocusedField(null);
      this.syncFocus();
    }
    await this.#loadGitOverlayDiff(file);
  }

  async #stepGitOverlayFile(delta: -1 | 1): Promise<void> {
    const git = this.store.getState().gitOverlay;
    const files = getAllVisibleGitFiles(git?.snapshot ?? null);
    if (!git || files.length === 0) return;
    const curIdx = git.selectedFileKey
      ? files.findIndex(f => gitFileKey(f.area, f.path) === git.selectedFileKey)
      : -1;
    const baseIdx = curIdx >= 0 ? curIdx : delta > 0 ? -1 : 0;
    const nextIdx = (baseIdx + delta + files.length) % files.length;
    const nextFile = files[nextIdx];
    if (nextFile) {
      await this.#loadGitOverlayDiff(nextFile);
    }
  }

  async #setGitOverlayViewMode(mode: GitDiffViewMode): Promise<void> {
    const git = this.store.getState().gitOverlay;
    if (!git || git.viewMode === mode) return;
    const needReload = (git.viewMode === 'file') !== (mode === 'file');
    this.store.setGitViewMode(mode);
    this.scheduler.renderNow();
    if (needReload && git.selectedFileKey) {
      const files = getAllVisibleGitFiles(git.snapshot);
      const cur = files.find(f => gitFileKey(f.area, f.path) === git.selectedFileKey);
      if (cur) {
        await this.#loadGitOverlayDiff(cur);
      }
    }
  }

  async #runGitOverlayStage(file: GitChangedFile, op: 'stage' | 'unstage'): Promise<void> {
    const state = this.store.getState();
    const git = state.gitOverlay;
    if (!git || git.busy) return;
    this.store.setGitOverlayBusy(true);
    this.scheduler.renderNow();
    try {
      const repoRoot = git.snapshot?.cwd ?? state.cwd;
      const gitEnv = git.snapshot?.gitEnv;
      const opts = {
        ...(this.#gitExec ? { exec: this.#gitExec } : {}),
        ...(gitEnv ? { gitEnv } : {}),
      };
      const targetPaths = resolveGitStageActionPaths(file, op);
      const res =
        op === 'stage'
          ? await stageGitFiles(repoRoot, targetPaths, opts)
          : await unstageGitFiles(repoRoot, targetPaths, opts);
      this.store.setGitOverlayStatus({
        text: res.message,
        tone: res.ok ? 'success' : 'error',
      });
      await this.#refreshGitOverlay();
      void this.#refreshGitStatus({ force: true });
    } finally {
      this.store.setGitOverlayBusy(false);
      this.scheduler.renderNow();
    }
  }

  async #runGitOverlayStageAll(op: 'stage' | 'unstage'): Promise<void> {
    const state = this.store.getState();
    const git = state.gitOverlay;
    if (!git || git.busy) return;
    this.store.setGitOverlayBusy(true);
    this.scheduler.renderNow();
    try {
      const repoRoot = git.snapshot?.cwd ?? state.cwd;
      const gitEnv = git.snapshot?.gitEnv;
      const opts = {
        ...(this.#gitExec ? { exec: this.#gitExec } : {}),
        ...(gitEnv ? { gitEnv } : {}),
      };
      const res =
        op === 'stage'
          ? await stageGitFiles(repoRoot, 'all', opts)
          : await unstageGitFiles(repoRoot, 'all', opts);
      this.store.setGitOverlayStatus({
        text: res.message,
        tone: res.ok ? 'success' : 'error',
      });
      await this.#refreshGitOverlay();
      void this.#refreshGitStatus({ force: true });
    } finally {
      this.store.setGitOverlayBusy(false);
      this.scheduler.renderNow();
    }
  }

  async #runGitOverlayCommit(): Promise<void> {
    const state = this.store.getState();
    const git = state.gitOverlay;
    if (!git || git.busy) return;
    const stagedCount = git.snapshot?.staged.length ?? 0;
    const unstagedCount = git.snapshot?.unstaged.length ?? 0;
    const stageAllIfEmpty = stagedCount === 0 && unstagedCount > 0;

    this.store.setGitOverlayBusy(true);
    this.scheduler.renderNow();
    try {
      const repoRoot = git.snapshot?.cwd ?? state.cwd;
      const gitEnv = git.snapshot?.gitEnv;
      const res = await commitGitChanges(
        repoRoot,
        {
          summary: git.commitSummary,
          body: git.commitBody,
          amend: git.commitAmend,
          stageAllIfEmpty,
        },
        {
          ...(this.#gitExec ? { exec: this.#gitExec } : {}),
          ...(gitEnv ? { gitEnv } : {}),
        },
      );
      if (res.ok) {
        this.store.clearGitCommitForm();
        this.store.setGitOverlayStatus({ text: res.message, tone: 'success' });
        await this.#refreshGitOverlay();
        void this.#refreshGitStatus({ force: true });
        this.syncFocus();
      } else {
        this.store.setGitOverlayStatus({ text: res.message, tone: 'error' });
      }
    } finally {
      this.store.setGitOverlayBusy(false);
      this.scheduler.renderNow();
    }
  }

  async #handleGitOverlayKey(key: Key): Promise<void> {
    const state = this.store.getState();
    const git = state.gitOverlay;
    if (!git) return;
    const name = key.name.toLowerCase();

    // When editing commit Summary / Description field
    if (git.focusedField !== null) {
      if (name === 'escape') {
        this.store.setGitFocusedField(null);
        this.scheduler.renderNow();
        this.syncFocus();
        return;
      }
      if (name === 'tab') {
        this.store.setGitFocusedField(git.focusedField === 'summary' ? 'description' : 'summary');
        this.scheduler.renderNow();
        this.syncFocus();
        return;
      }
      if (name === 'enter' && (git.focusedField === 'summary' || key.ctrl || key.meta)) {
        await this.#runGitOverlayCommit();
        return;
      }
      if (git.focusedField === 'summary') {
        if (name === 'backspace') {
          if (git.commitSummary.length > 0) {
            const prev = prevCodePointOffset(git.commitSummary, git.commitSummary.length);
            this.store.setGitCommitSummary(git.commitSummary.slice(0, prev));
            this.scheduler.renderNow();
          }
          return;
        }
        if (key.text && !key.ctrl && !key.alt && !key.meta) {
          this.store.setGitCommitSummary(git.commitSummary + key.text.replace(/\r?\n/g, ' '));
          this.scheduler.renderNow();
        }
        return;
      }
      if (git.focusedField === 'description') {
        if (name === 'backspace') {
          if (git.commitBody.length > 0) {
            const prev = prevCodePointOffset(git.commitBody, git.commitBody.length);
            this.store.setGitCommitBody(git.commitBody.slice(0, prev));
            this.scheduler.renderNow();
          }
          return;
        }
        if (name === 'enter') {
          this.store.setGitCommitBody(`${git.commitBody}\n`);
          this.scheduler.renderNow();
          return;
        }
        if (key.text && !key.ctrl && !key.alt && !key.meta) {
          this.store.setGitCommitBody(git.commitBody + key.text);
          this.scheduler.renderNow();
        }
        return;
      }
    }

    // Navigation mode inside Git UI
    if (name === 'escape' || (name === 'q' && !key.ctrl && !key.alt && !key.meta)) {
      this.#closeGitOverlay();
      return;
    }
    if (name === 'up' || name === 'k' || key.text === '[') {
      await this.#stepGitOverlayFile(-1);
      return;
    }
    if (name === 'down' || name === 'j' || key.text === ']') {
      await this.#stepGitOverlayFile(1);
      return;
    }
    if ((name === 'space' || name === 's') && !key.ctrl && !key.alt && !key.meta) {
      const files = getAllVisibleGitFiles(git.snapshot);
      const cur = git.selectedFileKey
        ? files.find(f => gitFileKey(f.area, f.path) === git.selectedFileKey)
        : undefined;
      if (cur?.area === 'unstaged') {
        await this.#runGitOverlayStage(cur, 'stage');
      } else if (cur?.area === 'staged') {
        await this.#runGitOverlayStage(cur, 'unstage');
      }
      return;
    }
    if (name === 'r' && !key.alt && !key.meta) {
      await this.#refreshGitOverlay();
      return;
    }
    if (name === 'w' && !key.ctrl && !key.alt && !key.meta) {
      this.store.toggleGitWrap();
      this.scheduler.renderNow();
      return;
    }
    if (name === 't' && !key.ctrl && !key.alt && !key.meta) {
      this.store.setGitSidebarStyle(git.sidebarStyle === 'path' ? 'tree' : 'path');
      this.scheduler.renderNow();
      return;
    }
    if (name === 'v' && !key.ctrl && !key.alt && !key.meta) {
      const order: readonly GitDiffViewMode[] = ['split', 'inline', 'file'];
      const next = order[(order.indexOf(git.viewMode) + 1) % order.length]!;
      await this.#setGitOverlayViewMode(next);
      return;
    }
    if (key.text === '1' && !key.ctrl && !key.alt && !key.meta) {
      await this.#setGitOverlayViewMode('split');
      return;
    }
    if (key.text === '2' && !key.ctrl && !key.alt && !key.meta) {
      await this.#setGitOverlayViewMode('inline');
      return;
    }
    if (key.text === '3' && !key.ctrl && !key.alt && !key.meta) {
      await this.#setGitOverlayViewMode('file');
      return;
    }
    if (name === 'c' && !key.ctrl && !key.alt && !key.meta && git.snapshot && !git.snapshot.clean) {
      this.store.setGitFocusedField('summary');
      this.scheduler.renderNow();
      this.syncFocus();
      return;
    }
  }

  #registerSignals(): void {
    const onSignal = (code: number) => () => {
      void this.shutdown({ cleanExit: false, exitCode: code }).finally(() => {
        process.exit(code);
      });
    };
    const sigint = onSignal(130);
    const sigterm = onSignal(143);
    const sighup = onSignal(129);
    this.#signalHandlers = { sigint, sigterm, sighup };
    process.once('SIGINT', sigint);
    process.once('SIGTERM', sigterm);
    process.once('SIGHUP', sighup);
  }

  #removeSignals(): void {
    const h = this.#signalHandlers;
    if (!h) return;
    this.#signalHandlers = undefined;
    process.off('SIGINT', h.sigint);
    process.off('SIGTERM', h.sigterm);
    process.off('SIGHUP', h.sighup);
  }

  async #copyTextWithToast(text: string, successLabel: string): Promise<void> {
    if (!text) return;
    const ok = await this.#clipboard.writeText(text);
    this.store.pushToast(
      ok ? successLabel : 'Clipboard copy unavailable',
      ok ? 'success' : 'warning',
      { ttl: 2000 }
    );
    this.scheduler.renderNow();
  }

  // -------------------------------------------------------------------------
  // View Builder Bridge
  // -------------------------------------------------------------------------

  #buildView() {
    const state = this.store.getState();
    const jobs = this.store.transcript.getBackgroundJobsSnapshot();
    const allVisibleTurns = this.store.transcript.getVisibleTurns();
    const transcriptSlice = this.store.transcript.getVisibleTranscriptSlice(
      state.collapseCompacted
    );
    return buildAppView({
      state,
      draft: this.store.draft.getState(),
      turns: allVisibleTurns,
      transcriptTurns: transcriptSlice.turns,
      plan: this.#isTodoDisabled() ? null : this.store.transcript.plan,
      todoExpanded: this.#todoExpanded,
      todoHudDismissed: this.#todoHudDismissed,
      jobs,
      version: OMA_VERSION,
      commands: this.store.commands.getAll(),
      trafficEntries: this.store.traffic.list(),
      toolPreviewLines: this.#config.ui.tool_preview_lines,
      evictedNodeIds: this.store.transcript.evictedTurnIds,
      hiddenCompactedTurnCount: transcriptSlice.hiddenCompactedTurnCount,
      totalCompactedTurnCount: transcriptSlice.totalCompactedTurnCount,
      hasCompactedHistory: transcriptSlice.hasCompactedHistory,
      compactedHistoryExpanded: transcriptSlice.compactedHistoryExpanded,
      config: this.#config,
      configPath: this.#configPath,
      agySettingsPath: this.#agySettingsPath,
      workingStartedAt: this.#workingStartedAt,
      hasPendingApproval: this.store.approvals.hasPending(),
      now: this.#now(),
      callbacks: {
        transcript: {
          onToggleThought: (thoughtId, open) => {
            this.store.transcript.toggleThought(thoughtId, open);
            this.scheduler.renderNow();
          },
          onToggleTool: (toolCallId, collapsed) => {
            this.store.transcript.toggleTool(toolCallId, collapsed);
            this.scheduler.renderNow();
          },
          onToggleToolGroup: (groupId, expanded) => {
            this.store.toggleToolGroup(groupId, expanded);
            this.scheduler.renderNow();
          },
          onToggleNotice: (noticeId, collapsed) => {
            this.store.transcript.toggleNotice(noticeId, collapsed);
            this.scheduler.renderNow();
          },
          onToggleCompactedHistory: show => {
            if (this.store.transcript.setShowCompactedHistory(show)) {
              this.scheduler.renderNow();
            }
          },
          onToggleAgent: (agentId, collapsed) => {
            this.store.transcript.toggleAgent(agentId, collapsed);
            this.scheduler.renderNow();
          },
          onApproveTool: (toolCallId, action) => {
            this.handleApprovalDecision(action, toolCallId);
          },
          onCopyMessage: text => {
            void this.#copyTextWithToast(text, 'Copied message to clipboard');
          },
          onCopyAnswer: text => {
            void this.#copyTextWithToast(text, 'Copied answer to clipboard');
          },
          onCopyError: message => {
            void this.#copyTextWithToast(message, 'Copied error to clipboard');
          },
          onRetryTurn: turnIndex => {
            void this.#retryTurn(turnIndex);
          },
          onEditAndResend: text => {
            this.store.draft.setText(text);
            this.store.closeSettings();
            this.#refreshCompletion();
            this.scheduler.renderNow();
            this.syncFocus(true);
          },
          onSwitchModel: () => {
            void this.#openPicker('model', '');
          },
          onQuestionChange: (questionId, value) => {
            this.store.setQuestionAnswer(questionId, value);
            this.scheduler.renderNow();
            this.syncFocus();
          },
          onQuestionOtherEdit: (questionId, ev) => {
            const card = this.store.getState().activeQuestion;
            if (!card) return;
            const prev = card.otherDrafts[questionId] ?? '';
            if (ev.len !== prev.length) return;
            const next = prev.slice(0, ev.from) + ev.text + prev.slice(ev.to);
            this.store.setQuestionOtherDraft(questionId, next);
            this.scheduler.renderNow();
          },
          onQuestionOtherFocus: questionId => {
            this.store.setQuestionFocusedOther(questionId);
            this.syncFocus();
          },
          onQuestionBack: () => {
            this.#stepQuestion(-1);
          },
          onQuestionNext: () => {
            this.#stepQuestion(1);
          },
          onQuestionSkip: () => {
            this.#skipCurrentQuestion();
          },
          onQuestionSubmit: answers => {
            this.#submitCurrentQuestion(answers);
          },
          onQuestionDecline: () => {
            this.#resolveQuestion({ action: 'decline' });
          },
          onQuestionCancel: () => {
            this.#resolveQuestion({ action: 'cancel' });
          },
          onRetryCrash: () => {
            void this.#retryAfterCrash();
          },
          onLoginAuth: () => {
            void this.#handleAuthLogin();
          },
          onDismissAuth: () => {
            this.store.setAuthRequired(null);
            this.scheduler.renderNow();
          },
        },
        composer: {
          onEdit: ev => this.#handleEditorEdit(ev),
          onUndo: ev => this.#handleEditorUndo(ev),
          onSend: ev => {
            void this.#handleEditorSend(ev);
          },
          onFocus: ev => this.#handleFocusEvent(ev),
          onSubmit: () => {
            void this.submitInput(this.store.draft.text);
          },
          onStop: () => {
            void this.cancelPendingAndTurn();
          },
          onRemoveAttachment: id => {
            const removed = this.store
              .getState()
              .pendingAttachments.find(att => att.id === id);
            this.store.removeAttachment(id);
            if (removed?.kind === 'file' && removed.path) {
              this.#suppressedMentionPaths.add(this.#normalizeMentionPathKey(removed.path));
              this.#removeMentionTokenFromDraft(removed.path);
            }
            this.#refreshCompletion();
            this.scheduler.renderNow();
          },
          onOpenPicker: kind => {
            void this.#openPicker(kind, '');
          },
          onOpenPlannerPicker: () => {
            void this.#openPicker('planner', '');
          },
          onOpenExecutorPicker: () => {
            void this.#openPicker('executor', '');
          },
          onCycleThinking: () => {
            void this.cycleThinkingLevel();
          },
          onCyclePlannerThinking: () => {
            void this.#cycleOrchestratorRoleThinking('planner');
          },
          onCycleExecutorThinking: () => {
            void this.#cycleOrchestratorRoleThinking('executor');
          },
          onOpenSwarmBoard: () => {
            void this.#openSwarmBoard('');
          },
          onOpenJobs: () => {
            this.#openInfoOverlay('jobs');
          },
          onOpenGit: () => {
            void this.#openGitOverlay();
          },
          onOpenContext: () => {
            this.#openInfoOverlay('context');
          },
          onCycleMode: () => {
            void this.cycleMode();
          },
        },
        popup: {
          onSelect: itemId => {
            this.store.selectCompletionByKey(itemId);
            this.scheduler.renderNow();
          },
          onActivate: itemId => {
            void this.#acceptCompletion('click', itemId);
          },
        },
        picker: {
          onSelect: itemId => {
            this.store.setPickerSelected(itemId);
            this.scheduler.renderNow();
          },
          onActivate: itemId => {
            const kind = this.store.getState().picker?.kind;
            if (kind) {
              void this.#activatePickerItem(kind, itemId);
            }
          },
          onScopeChange: scope => {
            const prevPicker = this.store.getState().picker;
            const isModelLike =
              prevPicker?.kind === 'model' ||
              prevPicker?.kind === 'planner' ||
              prevPicker?.kind === 'executor';
            const nextScope =
              isModelLike &&
              scope === prevPicker?.scope &&
              scope !== 'all'
                ? 'all'
                : scope;
            this.store.setPickerScope(nextScope);
            const curState = this.store.getState();
            if (curState.picker) {
              const computed = computePickerData(
                curState,
                curState.picker,
                this.store.traffic.list(),
                this.#now()
              );
              this.store.setPickerSelected(computed.selectedId ?? null);
            }
            this.scheduler.renderNow();
          },
          onLevelChange: level => {
            this.store.setModelPickerThinking(level);
            this.scheduler.renderNow();
          },
          onClose: () => {
            void this.#closePicker({ commitModelThinking: true });
          },
          onClearQuery: () => {
            this.#updatePickerQueryAndSelection('', 0);
          },
          onExportLog: () => {
            void this.#exportTrafficLog();
          },
          onClearLog: () => {
            this.store.traffic.clear();
            this.store.setPickerSelected(null);
            this.scheduler.renderNow();
          },
          onRefreshSwarm: () => {
            void this.#refreshSwarmBoard();
          },
          onToggleSwarmFollow: () => {
            this.#toggleSwarmFollow();
          },
          onToggleMcp: serverName => {
            void this.#toggleMcpServer(serverName);
          },
          onRefreshMcp: () => {
            void this.#loadMcpPickerItems(++this.#pickerLoadToken);
          },
          onTogglePlugin: pluginName => {
            void this.#togglePlugin(pluginName);
          },
          onRefreshPlugins: () => {
            void this.#loadPluginsPickerItems(++this.#pickerLoadToken);
          },
          onRefreshSkills: () => {
            void this.#loadSkillsPickerItems(++this.#pickerLoadToken);
          },
          onRefreshAgents: () => {
            void this.#loadAgentsPickerItems(++this.#pickerLoadToken);
          },
          onCloseHelp: () => {
            this.store.closeHelp();
            this.scheduler.renderNow();
            this.syncFocus();
          },
        },
        swarm: {
          onClose: () => {
            this.#closeSwarmBoard();
          },
          onRefresh: () => {
            void this.#refreshSwarmBoard();
          },
          onToggleFollow: () => {
            this.#toggleSwarmFollow();
          },
          onToggleAgentFilter: agentName => {
            this.store.toggleSwarmAgentFilter(agentName);
            this.scheduler.renderNow();
          },
          onSelectPost: seq => {
            this.store.selectSwarmPost(seq);
            this.scheduler.renderNow();
          },
          onClearQuery: () => {
            this.store.setSwarmBoardQuery('');
            this.scheduler.renderNow();
          },
        },
        git: {
          onClose: () => {
            this.#closeGitOverlay();
          },
          onRefresh: () => {
            void this.#refreshGitOverlay();
          },
          onSelectFile: file => {
            void this.#selectGitOverlayFile(file);
          },
          onStepFile: delta => {
            void this.#stepGitOverlayFile(delta);
          },
          onSetViewMode: mode => {
            void this.#setGitOverlayViewMode(mode);
          },
          onToggleWrap: () => {
            this.store.toggleGitWrap();
            this.scheduler.renderNow();
          },
          onSetSidebarStyle: style => {
            this.store.setGitSidebarStyle(style);
            this.scheduler.renderNow();
          },
          onToggleSectionFold: area => {
            this.store.toggleGitSectionFold(area);
            this.scheduler.renderNow();
          },
          onToggleDirFold: dirKey => {
            this.store.toggleGitDirFold(dirKey);
            this.scheduler.renderNow();
          },
          onStageFile: file => {
            void this.#runGitOverlayStage(file, 'stage');
          },
          onUnstageFile: file => {
            void this.#runGitOverlayStage(file, 'unstage');
          },
          onStageAll: () => {
            void this.#runGitOverlayStageAll('stage');
          },
          onUnstageAll: () => {
            void this.#runGitOverlayStageAll('unstage');
          },
          onFocusField: field => {
            this.store.setGitFocusedField(field);
            this.scheduler.renderNow();
            this.syncFocus();
          },
          onSummaryEdit: ev => {
            const git = this.store.getState().gitOverlay;
            if (!git) return;
            const prev = git.commitSummary;
            if (ev.len !== prev.length) return;
            const next = prev.slice(0, ev.from) + ev.text.replace(/\r?\n/g, ' ') + prev.slice(ev.to);
            this.store.setGitCommitSummary(next);
            this.scheduler.renderNow();
          },
          onSummaryUndo: () => {},
          onBodyEdit: ev => {
            const git = this.store.getState().gitOverlay;
            if (!git) return;
            const prev = git.commitBody;
            if (ev.len !== prev.length) return;
            const next = prev.slice(0, ev.from) + ev.text + prev.slice(ev.to);
            this.store.setGitCommitBody(next);
            this.scheduler.renderNow();
          },
          onBodyUndo: () => {},
          onToggleAmend: () => {
            this.store.toggleGitAmend();
            this.scheduler.renderNow();
          },
          onCommit: () => {
            void this.#runGitOverlayCommit();
          },
        },
        settings: {
          onPageChange: page => {
            this.#setSettingsPageWithFocus(page);
          },
          onChange: (rowId, value) => {
            void this.#handleSettingsChange(rowId, value);
          },
          onSelect: itemId => {
            this.store.setSettingsFocus(itemId);
            this.store.setSettingsFocused(true);
            this.scheduler.renderNow();
            this.syncFocus();
          },
          onActivate: rowId => {
            void this.#handleSettingsActivate(rowId);
          },
          onAction: (act, value) => {
            void this.#handleSettingsAction(act, value);
          },
          onClose: () => {
            this.#closeSettings();
          },
        },
        info: {
          onClose: () => {
            this.#closeInfoOverlay();
          },
          onConfirmLogout: () => {
            void this.#performLogout();
          },
          onOpenSettings: () => {
            this.#closeInfoOverlay();
            void this.#openSettings();
          },
          onSelectJob: jobId => {
            this.store.setSelectedJobId(jobId);
            this.scheduler.renderNow();
          },
          onStopJob: () => {
            void this.cancelPendingAndTurn();
          },
          onDetachJob: jobId => {
            this.#detachBackgroundJob(jobId);
          },
        },
      },
    });
  }

  /** Helper accessor for tests inspecting current focus target. */
  get currentSurfaceFocus(): string | null | undefined {
    return this.#lastFocusedId;
  }

  /** Helper accessor for tests verifying swarm board watcher lifecycle. */
  get isSwarmWatcherActive(): boolean {
    return this.#swarmWatcher !== null && !this.#swarmWatcher.stopped;
  }

  /** Helper constant re-export for focus checks. */
  static readonly EDITOR_FOCUS_ID = EDITOR_NODE_ID;
}
