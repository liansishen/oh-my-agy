import { readFile, stat } from 'node:fs/promises';
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
  extractSessionTier,
  isElicitationCreateRequest,
  isRequestPermissionRequest,
  type AcpIncomingRequest,
  type AuthMethod,
  type ContentBlock,
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
  loadConfig,
  normalizeToolDisplayMode,
  saveConfig,
  type OmaConfig,
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
import {
  getDataDir,
  PreviewStore,
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
  type AgentItem,
  type BeeMemberBlobPair,
  type McpServerItem,
  type ModalPickerKind,
  type PluginItem,
  type ResumeSessionEntry,
  type SkillItem,
} from '../state/store';
import {
  buildElicitationContent,
  type AttachmentItem,
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
const DEFAULT_REPLAY_DRAIN_INITIAL_QUIET_MS = 120;
const DEFAULT_REPLAY_DRAIN_ACTIVE_QUIET_MS = 250;
const DEFAULT_REPLAY_DRAIN_MAX_MS = 10_000;
const GIT_PROBE_MIN_INTERVAL_MS = 1500;
const TPS_FLUSH_MIN_INTERVAL_MS = 120;

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
      tool_display: normalizeToolDisplayMode(config.ui.tool_display),
      tool_preview_lines: config.ui.tool_preview_lines,
      osc_7501: config.ui.osc_7501,
      reopen_anchor: config.ui.reopen_anchor,
    },
    approval: {
      auto_allow_tools: [...(config.approval.auto_allow_tools ?? [])],
    },
  };
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

interface SessionControlCarryOver {
  readonly modelId: string | null;
  readonly thoughtLevel: string | null;
  readonly modeId: string | null;
}

interface ResumeAnchorHint {
  readonly model?: string;
  readonly thoughtLevel?: string;
  readonly mode?: string;
}

interface InitialSessionOutcome {
  readonly kind: 'new' | 'resumed';
  readonly epoch: number;
  readonly anchorHint?: ResumeAnchorHint;
}

export class AppController {
  readonly store: AppStore;
  readonly session: Session;
  readonly surface: Surface;
  readonly scheduler: RenderScheduler;
  osc: OscWriter;

  readonly #cli: CliOptions;
  #config: OmaConfig;
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
  readonly #ecosystemRunner?: ExecCommandFn;
  readonly #configPath: string;
  readonly #agySettingsPath: string;
  readonly #workspaceSkillsDir?: string;
  readonly #globalSkillsDir?: string;
  readonly #dataDir?: string;
  readonly #gitExec?: GitExecFn;
  readonly #backgroundDoneGraceMs: number;
  readonly #backgroundWakeupGraceMs: number;
  readonly #replayDrainInitialQuietMs: number;
  readonly #replayDrainActiveQuietMs: number;
  readonly #metricsTracker: SessionMetricsTracker;

  #acpClient: AcpClient | null = null;
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
  #awaitingSwarmCoordinatorReply = false;
  #swarmCoordinatorReplied = false;
  #deferredSettleTurnIndex: number | null = null;
  #activePromptTask: Promise<void> | null = null;
  #promptSubmitting = false;
  #acpClientAlive = false;
  #sessionEpoch = 0;
  #lastCommittedSessionId: string | null = null;
  #lastCommittedCwd: string | null = null;
  #replayingSessionId: string | null = null;
  #replayingSessionEpoch: number | null = null;
  #creatingSessionEpoch: number | null = null;
  #pendingNewSessionUpdates: SessionUpdateParams[] = [];
  #pendingCarryOverControls: SessionControlCarryOver | null = null;
  #suppressedMentionPaths = new Set<string>();
  #configWriteBlockedReason: string | null = null;
  #configVerifiedWritable = false;
  #configSaveChain: Promise<void> = Promise.resolve();
  #pickerLoadToken = 0;
  #attachmentSeq = 0;
  #shutdownPromise: Promise<void> | null = null;
  #shuttingDown = false;
  #exitCode = 0;
  #welcomeLogoStyleInstalled = false;
  #swarmFxStyleInstalled = false;
  #swarmFxStyleSig = '';
  #memberBeeBlobDark: boolean | null = null;
  #memberBeeBlobCache: Record<string, BeeMemberBlobPair> = {};
  #doneIdleTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  #backgroundDoneTimer: ReturnType<typeof setTimeout> | undefined = undefined;
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
    this.#ecosystemRunner = options.ecosystemRunner;
    this.#configPath = options.configPath ?? getConfigPath();
    this.#configWriteBlockedReason = options.configParseError ?? null;
    this.#agySettingsPath = options.agySettingsPath ?? getAgySettingsPath();
    this.#workspaceSkillsDir = options.workspaceSkillsDir;
    this.#globalSkillsDir = options.globalSkillsDir;
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

    this.store = new AppStore({
      cwd: initialCwd,
      autoAllowTools: this.#config.approval.auto_allow_tools,
      autoCollapseThought: this.#config.ui.auto_collapse_thought,
      toolDisplayMode: normalizeToolDisplayMode(this.#config.ui.tool_display),
      recentModels: this.#config.recent_models,
      hour12: this.session.caps.hour12,
      supportsAside: this.session.caps.features.includes('aside'),
      supportsPrefs:
        this.session.caps.kinds.length === 0 || this.session.caps.kinds.includes('prefs'),
      welcomeLogoBlobId: initialWelcomeLogoBlobId,
      ...(options.terminalRows !== undefined ? { terminalRows: options.terminalRows } : {}),
      now: this.#now,
    });
    if (initialBeeBlobs) {
      this.store.setBeeBlobs(initialBeeBlobs);
    }

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
      title: 'oma · Antigravity',
    });

    this.#syncWelcomeLogoStylesheet(this.session.caps.features);

    // Emit OSC 2 pane title + DECTCEM hide cursor immediately after opening the surface.
    this.osc.setTitleAndHideCursor('oma · Antigravity');

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
    const orbitBees = supportsStyles && state.hasSwarm ? resolveOrbitSwarmBees(state) : [];

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
    this.#cancelReplayDrain();
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
        this.store.cancelActiveQuestion();

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
        // Wait for any accepted serialized config writes before exiting
        await this.#configSaveChain.catch(() => {});

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

    return new AcpClient({
      agyBin: this.#resolveAgyBin(),
      extraArgs,
      cwd: this.store.getState().cwd,
      spawn: this.#acpSpawn,
      closeTimeoutMs: 500,
      onUpdate: params => this.#handleAcpUpdate(params),
      onServerRequest: req => this.#handleAcpServerRequest(req),
      onTraffic: ev => this.#handleAcpTraffic(ev),
      onStderr: line => {
        this.store.traffic.recordStderr(line);
      },
      onExit: info => this.#handleAcpExit(info),
    });
  }

  #isAcpClientLive(client: AcpClient): boolean {
    return (
      this.#acpClient === client &&
      this.#acpClientAlive &&
      this.store.getState().connectionStatus !== 'crashed'
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

  /**
   * Atomically begin a single-epoch session transition (`creating` for `/new` or
   * initial `session/new`, `replaying` for `/resume` or `session/load`).
   * Cancels any in-flight replay drain, clears stale creation/replay state, and
   * resets session UI state under one unified epoch so interleaved `/resume` and
   * `/new` calls can never inherit old replay chunks, wipe a newer command buffer,
   * or leave the scheduler suspended.
   */
  #beginSessionTransition(
    mode: 'creating' | 'replaying',
    replaySessionId?: string
  ): number {
    const epoch = ++this.#sessionEpoch;
    this.#cancelReplayDrain(new Error('Superseded by session switch'));
    this.#stopSwarmWatcher();
    this.#clearBackgroundDoneTimer();
    this.#clearDoneIdleTimer();
    this.#metricsTracker.setSession(null);
    this.#lastTpsStoreFlushAt = 0;
    this.#pendingBackgroundDone = false;
    this.#awaitingPostToolWakeup = false;
    this.#awaitingSwarmCoordinatorReply = false;
    this.#swarmCoordinatorReplied = false;
    this.#deferredSettleTurnIndex = null;
    this.#workingStartedAt = undefined;
    this.#activePromptTask = null;
    this.#pendingNewSessionUpdates = [];
    this.#pendingCarryOverControls = null;

    if (mode === 'replaying') {
      this.#creatingSessionEpoch = null;
      this.#replayingSessionId = replaySessionId ?? null;
      this.#replayingSessionEpoch = epoch;
    } else {
      this.#replayingSessionId = null;
      this.#replayingSessionEpoch = null;
      this.#creatingSessionEpoch = epoch;
    }

    this.store.resetSessionState({ keepCommands: true });
    this.#syncSwarmFxStylesheet();
    this.scheduler.resetSession();

    if (mode === 'replaying') {
      this.scheduler.suspendForReplay();
      this.store.setReplaying(true);
    } else {
      this.store.setReplaying(false);
      if (this.scheduler.suspended) {
        this.scheduler.resumeAfterReplay(false);
      }
    }

    return epoch;
  }

  #drainPendingNewSessionUpdates(sessionId: string, epoch: number): void {
    const queued = this.#pendingNewSessionUpdates;
    this.#pendingNewSessionUpdates = [];
    if (queued.length === 0) return;
    for (const params of queued) {
      if (this.#shuttingDown || epoch !== this.#sessionEpoch) return;
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
      if (this.#shuttingDown || !this.#isAcpClientLive(client)) return;
      this.#authMethods = initRes.authMethods ?? [];
      this.store.setAgentInitializeInfo(
        initRes.agentInfo,
        initRes.agentCapabilities?.promptCapabilities,
        { supportsLogout: client.supportsLogout }
      );

      const initialOutcome = await this.#openInitialSession(client, retrySessionId);
      if (this.#shuttingDown || !this.#isAcpClientLive(client)) return;

      await this.#applyInitialPreferences(client, initialOutcome, Boolean(retrySessionId));
      if (this.#shuttingDown || !this.#isAcpClientLive(client)) return;

      this.store.setConnectionStatus('ready');
      this.osc.setStatusIdle();
      this.osc.setWorkingDirectory(this.store.getState().cwd);
      await this.#persistSessionAnchorAndOsc();

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
      if (this.#shuttingDown) return;
      // Preserve crash state already set by `#handleAcpExit` when the child exited mid-bootstrap/replay
      if (!this.#acpClientAlive && this.store.getState().connectionStatus === 'crashed') {
        return;
      }
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
    retrySessionId?: string
  ): Promise<InitialSessionOutcome> {
    const cwd = this.store.getState().cwd;

    if (retrySessionId) {
      try {
        const loaded = await this.#loadSessionWithReplay(client, retrySessionId, cwd);
        if (loaded) {
          return { kind: 'resumed', epoch: this.#sessionEpoch };
        }
      } catch (err) {
        if (!this.#isAcpClientLive(client)) throw err;
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
        try {
          const loaded = await this.#loadSessionWithReplay(
            client,
            target.sessionId,
            targetCwd,
            target.title
          );
          if (loaded) {
            const anchorHint: ResumeAnchorHint = {
              ...(target.model ? { model: target.model } : {}),
              ...(target.thoughtLevel ? { thoughtLevel: target.thoughtLevel } : {}),
              ...(target.mode ? { mode: target.mode } : {}),
            };
            return {
              kind: 'resumed',
              epoch: this.#sessionEpoch,
              ...(Object.keys(anchorHint).length > 0 ? { anchorHint } : {}),
            };
          }
        } catch (err) {
          if (!this.#isAcpClientLive(client)) throw err;
          if (err instanceof AcpRpcError && err.isAuthRequired()) {
            throw err;
          }
          this.store.pushToast(
            `Failed to load session ${target.sessionId}; starting a new session.`,
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
        sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
        const latest = sessions[0];
        if (latest) {
          const loaded = await this.#loadSessionWithReplay(
            client,
            latest.sessionId,
            cwd,
            latest.title ?? undefined
          );
          if (loaded) {
            return { kind: 'resumed', epoch: this.#sessionEpoch };
          }
        }
      } catch (err) {
        if (!this.#isAcpClientLive(client)) throw err;
        if (err instanceof AcpRpcError && err.isAuthRequired()) {
          throw err;
        }
        // Fallback to creating a new session
      }
    }

    const createEpoch = this.#beginSessionTransition('creating');
    try {
      const created = await client.newSession({ cwd, mcpServers: [] });
      if (this.#shuttingDown || !this.#isAcpClientLive(client) || createEpoch !== this.#sessionEpoch) {
        throw new Error('ACP connection closed while creating session');
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
      this.#lastCommittedSessionId = created.sessionId;
      this.#lastCommittedCwd = cwd;
      if (this.#creatingSessionEpoch === createEpoch) {
        this.#creatingSessionEpoch = null;
      }
      this.#drainPendingNewSessionUpdates(created.sessionId, createEpoch);
      this.#bindSessionMetrics(created.sessionId);
      this.#ensureSwarmWatcher(created.sessionId, { forceRestart: true });
      void this.#refreshGitStatus();
      return { kind: 'new', epoch: createEpoch };
    } finally {
      if (this.#creatingSessionEpoch === createEpoch) {
        this.#creatingSessionEpoch = null;
        this.#pendingNewSessionUpdates = [];
      }
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
    if (this.#shuttingDown || this.#replayDrainInitialQuietMs <= 0) {
      return;
    }
    this.#cancelReplayDrain();
    this.#replayDrainActive = true;
    await new Promise<void>((resolve, reject) => {
      this.#replayDrainResolve = resolve;
      this.#replayDrainReject = reject;
      this.#replayDrainTimer = setTimeout(() => {
        this.#cancelReplayDrain();
      }, this.#replayDrainInitialQuietMs);
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
    }
  ): Promise<boolean> {
    const loadEpoch =
      existingEpoch !== undefined
        ? existingEpoch
        : this.#beginSessionTransition('replaying', sessionId);

    try {
      const loaded = await client.loadSession({
        sessionId,
        cwd,
        mcpServers: [],
      });

      if (this.#shuttingDown || loadEpoch !== this.#sessionEpoch) {
        return false;
      }
      if (!this.#isAcpClientLive(client)) {
        throw new Error('ACP connection closed during session load');
      }

      await this.#waitForReplayDrain();
      if (this.#shuttingDown || loadEpoch !== this.#sessionEpoch) {
        return false;
      }
      if (!this.#isAcpClientLive(client)) {
        throw new Error('ACP connection closed during session replay');
      }

      this.store.transcript.finalizeReplayedTurns();
      this.store.setReplaying(false);
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
      this.#lastCommittedSessionId = loaded.sessionId;
      this.#lastCommittedCwd = cwd;

      this.#bindSessionMetrics(loaded.sessionId, false);
      await this.#syncSessionMetricsFromTranscript();
      if (this.#shuttingDown || loadEpoch !== this.#sessionEpoch) return false;
      if (!this.#isAcpClientLive(client)) {
        throw new Error('ACP connection closed during session restore');
      }
      if (options?.restoreSavedControls) {
        const savedControls = await this.#resolveResumedSessionControls(
          loaded.sessionId,
          options.anchorHint
        );
        if (this.#shuttingDown || loadEpoch !== this.#sessionEpoch) return false;
        if (!this.#isAcpClientLive(client)) {
          throw new Error('ACP connection closed during session restore');
        }
        if (savedControls) {
          await this.#applyCarryOverControls(client, loaded.sessionId, savedControls, loadEpoch);
          if (this.#shuttingDown || loadEpoch !== this.#sessionEpoch) return false;
          if (!this.#isAcpClientLive(client)) {
            throw new Error('ACP connection closed during session restore');
          }
        }
      }
      void this.#refreshGitStatus({ force: true });

      this.scheduler.resumeAfterReplay(true);

      // Settle historical completed turns (keep the last turn unsettled so reveal/copy stays crisp)
      const turns = this.store.transcript.getVisibleTurns();
      let settledAny = false;
      for (let i = 0; i < turns.length - 1; i++) {
        const turn = turns[i];
        if (turn && turn.status !== 'streaming') {
          this.scheduler.settleTurn(turn.index);
          settledAny = true;
        }
      }
      if (settledAny) {
        this.osc.reassertCursorHidden();
      }
      this.#ensureSwarmWatcher(loaded.sessionId, { forceRestart: true });
      return true;
    } catch (err) {
      if (loadEpoch !== this.#sessionEpoch) {
        // Superseded by a newer `/new` or `/resume` transition; do not touch the newer epoch's state
        return false;
      }
      this.#cancelReplayDrain();
      this.store.setReplaying(false);
      this.scheduler.resumeAfterReplay(false);
      throw err;
    } finally {
      if (this.#replayingSessionEpoch === loadEpoch) {
        this.#replayingSessionId = null;
        this.#replayingSessionEpoch = null;
      }
    }
  }

  async #applyInitialPreferences(
    client: AcpClient,
    outcome: InitialSessionOutcome,
    preferSavedOverCli = false
  ): Promise<void> {
    const state = this.store.getState();
    const sessionId = state.sessionId;
    if (!sessionId) return;

    const applyModelAndThoughtPreference = async (
      desiredModel: string,
      desiredThought: string
    ): Promise<void> => {
      if (desiredModel) {
        const curState = this.store.getState();
        const resolved = resolveModelSelection(desiredModel, {
          configOptions: [...curState.configOptions],
          models: curState.models,
          modes: curState.modes,
        });
        if (resolved) {
          try {
            const applied = await applyModelSelection(
              client,
              sessionId,
              resolved,
              desiredThought || undefined
            );
            if (applied.configOptions) {
              this.store.updateConfigOptions(applied.configOptions);
            } else {
              this.store.updateCurrentModelId(applied.appliedModelId);
            }
          } catch (err) {
            this.store.pushToast(
              `Failed to apply initial model "${desiredModel}": ${err instanceof Error ? err.message : String(err)}`,
              'warning'
            );
          }
        }
      } else if (desiredThought) {
        await this.#applyThoughtLevel(desiredThought, true);
      }
    };

    if (outcome.kind === 'new') {
      const desiredModel = this.#cli.model?.trim() || this.#config.default_model?.trim() || '';
      const desiredThought =
        this.#cli.thought?.trim() || this.#config.default_thought?.trim() || '';
      const desiredMode = this.#cli.mode?.trim() || this.#config.default_mode?.trim() || '';

      await applyModelAndThoughtPreference(desiredModel, desiredThought);
      if (desiredMode) {
        await this.#applyMode(desiredMode, true);
      }
      return;
    }

    const saved = await this.#resolveResumedSessionControls(sessionId, outcome.anchorHint);
    if (
      this.#shuttingDown ||
      !this.#isAcpClientLive(client) ||
      outcome.epoch !== this.#sessionEpoch
    ) {
      return;
    }

    const cliModel = preferSavedOverCli ? '' : (this.#cli.model?.trim() || '');
    const cliThought = preferSavedOverCli ? '' : (this.#cli.thought?.trim() || '');
    const cliMode = preferSavedOverCli ? '' : (this.#cli.mode?.trim() || '');

    if (cliModel) {
      await applyModelAndThoughtPreference(
        cliModel,
        cliThought || this.#config.default_thought?.trim() || ''
      );
    } else if (saved?.modelId || saved?.thoughtLevel) {
      await this.#applyCarryOverControls(
        client,
        sessionId,
        {
          modelId: saved.modelId,
          thoughtLevel: cliThought || saved.thoughtLevel,
          modeId: null,
        },
        outcome.epoch
      );
    } else {
      await applyModelAndThoughtPreference(
        this.#config.default_model?.trim() || '',
        cliThought || this.#config.default_thought?.trim() || ''
      );
    }

    if (
      this.#shuttingDown ||
      !this.#isAcpClientLive(client) ||
      outcome.epoch !== this.#sessionEpoch
    ) {
      return;
    }

    if (cliMode) {
      await this.#applyMode(cliMode, true);
    } else if (saved?.modeId) {
      await this.#applyCarryOverControls(
        client,
        sessionId,
        { modelId: null, thoughtLevel: null, modeId: saved.modeId },
        outcome.epoch
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

    // While `session/new` is in flight, buffer incoming notifications and replay ONLY
    // those whose `sessionId` matches the newly created session (so early new-session
    // notifications like `available_commands_update` are preserved while stale old-session
    // chunks are discarded).
    if (this.#creatingSessionEpoch !== null && !this.#replayingSessionId) {
      if (incomingSessionId && this.#pendingNewSessionUpdates.length < 256) {
        this.#pendingNewSessionUpdates.push(params);
      } else {
        this.store.traffic.recordSystem(
          `ignored session/update without sessionId during session creation`,
          params
        );
      }
      return;
    }

    const expectedSessionId = this.#replayingSessionId ?? this.store.getState().sessionId;
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
        if (isSwarmTool || isSwarmWait) {
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
        if (this.store.hasActiveBackgroundTasks()) {
          this.#metricsTracker.pauseForTools();
        } else {
          this.#metricsTracker.resumeAfterTools();
        }
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
        if (isMessageChunk) {
          this.#awaitingPostToolWakeup = false;
        } else if (isThoughtChunk) {
          this.#awaitingPostToolWakeup = true;
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

  #handleAcpServerRequest(req: AcpIncomingRequest): void {
    const client = this.#acpClient;
    if (!client) return;

    const reqSessionId =
      req.params && typeof (req.params as { sessionId?: unknown }).sessionId === 'string'
        ? ((req.params as { sessionId: string }).sessionId.trim() || undefined)
        : undefined;
    const activeSessionId = this.store.getState().sessionId;
    const isStaleRequestSession = Boolean(
      reqSessionId &&
        (this.#creatingSessionEpoch !== null ||
          this.#replayingSessionId !== null ||
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
      this.store.transcript.finalizeActiveThoughts({
        autoCollapseThought: this.store.autoCollapseThought,
        expandAllTools: this.store.getState().expandAllTools,
      });
      const card = this.store.openQuestion(req.id, req.params, response => {
        void client.respondToServerRequest(req.id, response).catch(() => {});
      });
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
      return;
    }

    // Unsupported server request -> JSON-RPC Method Not Found
    void client
      .respondErrorToServerRequest(req.id, -32601, `Unsupported server request: ${req.method}`)
      .catch(() => {});
  }

  #handleAcpExit(info: AcpExitInfo): void {
    if (this.#shuttingDown || info.expected) return;

    this.#acpClientAlive = false;
    const crashMessage =
      info.error?.message ||
      `agy acp exited unexpectedly${info.code !== null ? ` (exit code ${info.code})` : ''}.`;

    this.#cancelReplayDrain(new Error(crashMessage));
    this.#replayingSessionId = null;
    this.#replayingSessionEpoch = null;
    this.#creatingSessionEpoch = null;
    this.#pendingNewSessionUpdates = [];
    this.store.setReplaying(false);
    this.#stopSwarmWatcher();
    this.#clearBackgroundDoneTimer();
    this.#pendingBackgroundDone = false;
    this.#awaitingPostToolWakeup = false;
    this.#awaitingSwarmCoordinatorReply = false;
    this.#swarmCoordinatorReplied = false;
    this.#deferredSettleTurnIndex = null;
    this.#workingStartedAt = undefined;
    this.store.transcript.cancelActiveBackgroundTasks('cancelled');

    const cancelledPerms = this.store.approvals.cancelAll();
    for (const perm of cancelledPerms) {
      this.store.transcript.resolvePermissionOnTool(perm.toolCallId, 'cancelled');
    }
    this.store.cancelActiveQuestion();

    if (this.store.getState().isStreaming || this.store.transcript.activeTurn !== undefined) {
      this.store.transcript.finishActiveTurn(undefined, 'error', undefined, {
        autoCollapseThought: this.store.autoCollapseThought,
        expandAllTools: this.store.getState().expandAllTools,
      });
      if (this.#metricsTracker.isStreaming) {
        const endedSnap = this.#metricsTracker.endStreamTurn();
        this.#applySessionMetricsSnapshot(endedSnap);
      }
      this.store.setStreaming(false);
    }

    this.#syncSwarmFxStylesheet();
    this.osc.setStatusError();
    this.store.setCrashError({
      message: crashMessage,
      stderrTail: info.stderrTail,
      exitCode: info.code,
    });
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
      return;
    }
    if (this.store.getFocusMode() !== prevMode) {
      this.scheduler.renderNow();
      this.syncFocus();
    }
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
        if (name === 'x' && !key.ctrl && !key.alt && !key.meta) {
          const selected =
            items.find(j => j.id === state.infoOverlay?.selectedJobId) ?? items[0];
          if (selected && selected.status === 'running' && selected.endedAt === undefined && state.isBusy) {
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

    // Check slash commands when no image attachments are attached
    if (pendingAttachments.length === 0) {
      const dispatched = dispatchSlashCommand(text, this.store.commands);
      if (dispatched.isCommand) {
        if (!isolated) {
          this.store.draft.reset();
        }
        void this.store.history.push(text, this.store.getState().cwd);
        this.scheduler.renderNow();
        await executeCommandAction(
          dispatched.action,
          this.#commandExecutor({ preserveDraft: isolated })
        );
        return;
      }
    }

    await this.#sendPromptToAcp(text, pendingAttachments, { preserveDraft: isolated });
  }

  #commandExecutor(options: { readonly preserveDraft?: boolean } = {}): CommandActionExecutor {
    const preserveDraft = options.preserveDraft === true;
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
        await this.#sendPromptToAcp(text, [], { preserveDraft });
      },
      unknownCommand: (commandName, _rawText, suggestions) => {
        const hint =
          suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
        this.store.pushToast(`Unknown command /${commandName}.${hint}`, 'warning');
        this.scheduler.renderNow();
      },
    };
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
      this.store.pushToast('Session is not ready yet', 'warning');
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
    const promptEpoch = this.#sessionEpoch;
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
        promptEpoch !== this.#sessionEpoch ||
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
            promptEpoch !== this.#sessionEpoch ||
            !this.#isAcpClientLive(client) ||
            !preSendState.isReady ||
            preSendState.sessionId !== sessionId
          ) {
            return;
          }

          const result = await client.prompt({
            sessionId,
            prompt: promptBlocks,
          });

        if (
          this.#shuttingDown ||
          promptEpoch !== this.#sessionEpoch ||
          this.store.getState().sessionId !== sessionId
        ) {
          return;
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
          // Keep "waiting for coordinator reply" and "waiting for workers to go idle after
          // visible reply" distinct so a lagged worker snapshot never suppresses `state=done`.
          this.#awaitingSwarmCoordinatorReply = needSwarmReply;
          this.#pendingBackgroundDone =
            hasBgTools || (!needSwarmReply && this.#swarmCoordinatorReplied);
          this.#awaitingPostToolWakeup = false;
          if (finishedTurn) {
            this.#deferredSettleTurnIndex = finishedTurn.index;
          }
          this.#clearDoneIdleTimer();
          this.#clearBackgroundDoneTimer();
        }

        // Flush final non-streaming frame & settle turn BEFORE emitting OSC 7501 `state=done`
        // so the user never receives a completion notification ahead of the final reply.
        this.scheduler.renderNow();
        if (!stillBusy && finishedTurn) {
          this.scheduler.settleTurn(finishedTurn.index);
          this.osc.reassertCursorHidden();
        }

        if (stillBusy) {
          this.osc.setStatusWorking();
        } else {
          this.osc.setStatusDone();
          this.#scheduleDoneToIdle();
        }

        // Authoritatively calibrate post-turn TPS + cumulative tokens from transcript.jsonl and refresh git
        void this.#syncSessionMetricsFromTranscript();
        void this.#refreshGitStatus();
        void this.#persistSessionAnchorAndOsc().catch(() => {});
      } catch (err) {
        if (
          this.#shuttingDown ||
          promptEpoch !== this.#sessionEpoch ||
          this.store.getState().sessionId !== sessionId
        ) {
          return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.store.transcript.finishActiveTurn(undefined, 'error', msg, {
          autoCollapseThought: this.store.autoCollapseThought,
          expandAllTools: this.store.getState().expandAllTools,
        });
        const endedSnap = this.#metricsTracker.endStreamTurn();
        this.#applySessionMetricsSnapshot(endedSnap);
        this.store.setStreaming(false);
        if (!this.store.isBusy) {
          this.#pendingBackgroundDone = false;
          this.#awaitingPostToolWakeup = false;
          this.#deferredSettleTurnIndex = null;
          this.#workingStartedAt = undefined;
          this.#clearBackgroundDoneTimer();
        }

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
    const cancelledQ = this.store.cancelActiveQuestion();

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

    this.scheduler.renderNow();
    this.syncFocus();
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
      snapshot => {
        if (this.#shuttingDown || this.#swarmWatcher !== watcher) {
          watcher.stop();
          return;
        }
        this.#applySwarmSnapshot(snapshot);
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

  #applySwarmSnapshot(snapshot: SwarmBoardSnapshot | null): void {
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

    this.store.setSwarmSnapshot(snapshot);
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
        this.#applySwarmSnapshot(snapshot);
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
    this.#applySwarmSnapshot(snapshot);
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
      // Immediately capture rejection on the concurrent remote list request so a fast failure
      // while local previews are still reading — or after the picker closes — never produces
      // an `unhandledRejection`.
      const remoteResultPromise = client.listAllSessions().then(
        sessions => ({ ok: true as const, sessions }),
        error => ({ ok: false as const, error })
      );
      const previewMap = await this.#previewStore.loadMap();
      if (isStale()) return;

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

      const merged: ResumeSessionEntry[] = remoteSessions.map(s => {
        const cached: SessionAnchorRecord | undefined = previewMap.get(s.sessionId);
        const rawCwd = s.cwd || cached?.cwd || '';
        return {
          sessionId: s.sessionId,
          cwd: rawCwd,
          displayCwd: normalizeDisplayPath(rawCwd),
          title: (s.title ?? '').trim() || cached?.title || '',
          updatedAt: s.updatedAt || cached?.updatedAt || '',
          ...(cached?.model ? { model: cached.model } : {}),
          ...(cached?.thoughtLevel ? { thoughtLevel: cached.thoughtLevel } : {}),
          ...(cached?.mode ? { mode: cached.mode } : {}),
          ...(cached?.turnCount !== undefined ? { turnCount: cached.turnCount } : {}),
          ...(cached?.preview && cached.preview.length > 0 ? { preview: cached.preview } : {}),
        };
      });

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

  async #switchToSession(
    sessionId: string,
    meta?: ResumeSessionEntry
  ): Promise<void> {
    const client = this.#acpClient;
    if (!client) return;

    const state = this.store.getState();
    const oldSessionId = state.sessionId;
    const wasStreaming = state.isStreaming;
    const targetCwd =
      meta?.cwd && !sameDir(meta.cwd, state.cwd) ? normalizeDisplayPath(meta.cwd) : state.cwd;

    const switchEpoch = this.#beginSessionTransition('replaying', sessionId);
    try {
      if (oldSessionId && oldSessionId !== sessionId) {
        if (wasStreaming) {
          await client.cancel(oldSessionId).catch(() => {});
        }
        await client.closeSession(oldSessionId).catch(() => {});
      }

      if (this.#shuttingDown || switchEpoch !== this.#sessionEpoch) {
        return;
      }
      if (!this.#isAcpClientLive(client)) {
        if (this.#replayingSessionEpoch === switchEpoch) {
          this.#replayingSessionId = null;
          this.#replayingSessionEpoch = null;
        }
        this.store.setReplaying(false);
        if (this.scheduler.suspended) {
          this.scheduler.resumeAfterReplay(false);
        } else {
          this.scheduler.renderNow(true);
        }
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
        switchEpoch !== this.#sessionEpoch ||
        !this.#isAcpClientLive(client)
      ) {
        return;
      }
      this.osc.setStatusIdle();
      this.osc.setWorkingDirectory(this.store.getState().cwd);
      await this.#persistSessionAnchorAndOsc();
      if (this.#shuttingDown || switchEpoch !== this.#sessionEpoch) return;
      this.store.pushToast(
        `Loaded session ${meta?.title || sessionId.slice(0, 8)}`,
        'success',
        { ttl: 2500 }
      );
      this.scheduler.renderNow();
      this.syncFocus();
    } catch (err) {
      if (switchEpoch !== this.#sessionEpoch) {
        return;
      }
      if (this.#replayingSessionEpoch === switchEpoch) {
        this.#replayingSessionId = null;
        this.#replayingSessionEpoch = null;
      }
      this.store.setReplaying(false);
      if (this.scheduler.suspended) {
        this.scheduler.resumeAfterReplay(false);
      }
      if (!this.#acpClientAlive && this.store.getState().connectionStatus === 'crashed') {
        this.scheduler.renderNow(true);
        return;
      }
      this.store.pushToast(
        `Failed to load session: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
      this.scheduler.renderNow();
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

  async #applyCarryOverControls(
    client: AcpClient,
    sessionId: string,
    carryOver: SessionControlCarryOver,
    createEpoch: number
  ): Promise<void> {
    const isStale = (): boolean =>
      this.#shuttingDown || createEpoch !== this.#sessionEpoch || !this.#isAcpClientLive(client);

    let modelRestoreFailed = false;
    let curState = this.store.getState();

    // 1. Model
    if (
      carryOver.modelId &&
      carryOver.modelId !== curState.controls.currentModelId &&
      curState.controls.availableModels.length > 0
    ) {
      const resolved = resolveModelSelection(carryOver.modelId, {
        configOptions: [...curState.configOptions],
        models: curState.models,
        modes: curState.modes,
      });
      if (
        resolved &&
        resolved.matchKind !== 'fuzzy_config_model' &&
        resolved.matchKind !== 'legacy_fuzzy'
      ) {
        try {
          const applied = await applyModelSelection(client, sessionId, resolved);
          if (isStale()) return;
          if (applied.configOptions) {
            this.store.updateConfigOptions(applied.configOptions);
          } else {
            this.store.updateCurrentModelId(applied.appliedModelId);
          }
        } catch (err) {
          modelRestoreFailed = true;
          if (isStale()) return;
          this.store.pushToast(
            `Failed to carry over model "${carryOver.modelId}": ${
              err instanceof Error ? err.message : String(err)
            }`,
            'warning',
            { ttl: 3000 }
          );
        }
      }
    }

    // 2. Thought level
    if (!modelRestoreFailed && carryOver.thoughtLevel) {
      curState = this.store.getState();
      if (
        curState.controls.supportsThoughtLevel &&
        curState.controls.currentThoughtLevel !== carryOver.thoughtLevel
      ) {
        const resolvedThought = resolveThoughtLevel(carryOver.thoughtLevel, [
          ...curState.configOptions,
        ]);
        const targetThought = resolvedThought.ok
          ? resolvedThought.value
          : resolvedThought.reason === 'invalid'
            ? clampThoughtLevelForChoices(
                carryOver.thoughtLevel,
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
            if (isStale()) return;
            this.store.pushToast(
              `Failed to carry over thought level "${targetThought}": ${
                err instanceof Error ? err.message : String(err)
              }`,
              'warning',
              { ttl: 3000 }
            );
          }
        }
      }
    }

    // 3. Mode
    if (carryOver.modeId) {
      curState = this.store.getState();
      const targetModeId = carryOver.modeId;
      if (
        targetModeId !== curState.controls.currentModeId &&
        curState.controls.availableModes.some(
          m => m.value.toLowerCase() === targetModeId.toLowerCase()
        )
      ) {
        const resolvedMode = resolveModeSelection(targetModeId, {
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
            if (isStale()) return;
            this.store.pushToast(
              `Failed to carry over mode "${targetModeId}": ${
                err instanceof Error ? err.message : String(err)
              }`,
              'warning',
              { ttl: 3000 }
            );
          }
        }
      }
    }
  }

  async #startNewSession(): Promise<void> {
    const client = this.#acpClient;
    if (!client) return;
    const state = this.store.getState();
    const oldId = state.sessionId;
    const wasStreaming = state.isStreaming;
    const carryOver: SessionControlCarryOver = this.#pendingCarryOverControls ?? {
      modelId: state.controls.currentModelId,
      thoughtLevel: state.controls.supportsThoughtLevel ? state.controls.currentThoughtLevel : null,
      modeId: state.controls.currentModeId,
    };
    const hasCarryOver = Boolean(carryOver.modelId || carryOver.thoughtLevel || carryOver.modeId);
    const createEpoch = this.#beginSessionTransition('creating');
    this.#pendingCarryOverControls = hasCarryOver ? carryOver : null;

    if (oldId) {
      if (wasStreaming) {
        await client.cancel(oldId).catch(() => {});
      }
      await client.closeSession(oldId).catch(() => {});
    }

    if (
      this.#shuttingDown ||
      createEpoch !== this.#sessionEpoch ||
      !this.#isAcpClientLive(client)
    ) {
      if (this.#creatingSessionEpoch === createEpoch) {
        this.#creatingSessionEpoch = null;
        this.#pendingNewSessionUpdates = [];
      }
      if (createEpoch === this.#sessionEpoch) {
        this.#pendingCarryOverControls = null;
      }
      return;
    }

    try {
      const created = await client.newSession({ cwd: state.cwd, mcpServers: [] });
      if (
        this.#shuttingDown ||
        !this.#isAcpClientLive(client) ||
        createEpoch !== this.#sessionEpoch
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
      this.#lastCommittedSessionId = created.sessionId;
      this.#lastCommittedCwd = state.cwd;
      if (this.#creatingSessionEpoch === createEpoch) {
        this.#creatingSessionEpoch = null;
      }
      this.#drainPendingNewSessionUpdates(created.sessionId, createEpoch);
      if (hasCarryOver) {
        await this.#applyCarryOverControls(client, created.sessionId, carryOver, createEpoch);
        if (
          this.#shuttingDown ||
          !this.#isAcpClientLive(client) ||
          createEpoch !== this.#sessionEpoch
        ) {
          return;
        }
      }
      this.#bindSessionMetrics(created.sessionId);
      this.#ensureSwarmWatcher(created.sessionId, { forceRestart: true });
      void this.#refreshGitStatus();
      this.osc.setStatusIdle();
      await this.#persistSessionAnchorAndOsc();
      if (this.#shuttingDown || createEpoch !== this.#sessionEpoch) return;
      this.store.pushToast('Started a new session', 'info', { ttl: 2000 });
      this.scheduler.renderNow();
      this.syncFocus();
    } catch (err) {
      if (
        createEpoch !== this.#sessionEpoch ||
        (!this.#acpClientAlive && this.store.getState().connectionStatus === 'crashed')
      ) {
        return;
      }
      this.store.pushToast(
        `Failed to create session: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
      this.scheduler.renderNow();
    } finally {
      // Only the owning epoch may clear creation state & buffered updates so an
      // earlier superseded `/new` never wipes a newer `/new`'s early command buffer.
      if (this.#creatingSessionEpoch === createEpoch) {
        this.#creatingSessionEpoch = null;
        this.#pendingNewSessionUpdates = [];
      }
      if (createEpoch === this.#sessionEpoch) {
        this.#pendingCarryOverControls = null;
      }
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
      }
      await this.#persistSessionAnchorAndOsc();
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
    if (rowId === 'ui.auto_collapse_thought') {
      const next = Boolean(value);
      this.#config = {
        ...this.#config,
        ui: { ...this.#config.ui, auto_collapse_thought: next },
      };
      this.store.setAutoCollapseThought(next);
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
        this.store.pushToast('Saved setting to config.toml', 'success', { ttl: 1800 });
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
      this.store.setToolDisplayMode(this.#config.ui.tool_display);
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

    try {
      await client.logout();
      this.osc.setStatusBlocked('auth');
      this.store.setAuthRequired({
        message: 'Signed out of Antigravity. Run /login or click Sign in to reconnect.',
        authMethods: this.#authMethods,
      });
      this.store.pushToast('Signed out of Antigravity', 'success', { ttl: 2500 });
    } catch (err) {
      this.store.pushToast(
        `Failed to sign out: ${err instanceof Error ? err.message : String(err)}`,
        'error'
      );
    }
    this.scheduler.renderNow();
    this.syncFocus();
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

  async #retryAfterCrash(): Promise<void> {
    const previousSessionId =
      this.store.getState().sessionId ?? this.#lastCommittedSessionId ?? undefined;
    if (this.#lastCommittedCwd && !sameDir(this.store.getState().cwd, this.#lastCommittedCwd)) {
      this.store.setCwd(this.#lastCommittedCwd);
    }
    if (this.#acpClient) {
      await this.#acpClient.close({ timeoutMs: 200 }).catch(() => {});
      this.#acpClient = null;
    }
    this.store.setCrashError(null);
    await this.#bootstrapAcp(previousSessionId);
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
      this.osc.setTitleAndHideCursor('oma · Antigravity');
    }

    this.store.setAuthRequired(null);
    await this.#retryAfterCrash();
  }

  // -------------------------------------------------------------------------
  // Anchor Persistence, OSC & Signal Helpers
  // -------------------------------------------------------------------------

  async #persistSessionAnchorAndOsc(): Promise<void> {
    const state = this.store.getState();
    const sid = state.sessionId;
    if (!sid) return;
    const epoch = this.#sessionEpoch;

    const firstUserText = this.store.transcript.turns.find(t => t.user?.text)?.user?.text;
    const title =
      state.sessionTitle ||
      (firstUserText ? firstUserText.trim().split(/\r?\n/)[0]?.slice(0, 80) : '') ||
      'New Session';

    try {
      const anchorFile = await this.#previewStore.save({
        sessionId: sid,
        cwd: state.cwd,
        title,
        ...(state.controls.currentModelId ? { model: state.controls.currentModelId } : {}),
        ...(state.controls.currentThoughtLevel
          ? { thoughtLevel: state.controls.currentThoughtLevel }
          : {}),
        ...(state.controls.currentModeId ? { mode: state.controls.currentModeId } : {}),
        turnCount: this.store.transcript.turns.length,
        preview: this.store.transcript.getPreviewMessages(3, 400),
      });
      if (
        this.#shuttingDown ||
        epoch !== this.#sessionEpoch ||
        this.store.getState().sessionId !== sid
      ) {
        return;
      }
      this.osc.setReopenAnchor(anchorFile);
    } catch {
      // Anchor persistence errors must not interrupt interactive conversation
    }
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
    this.#backgroundDoneTimer = setTimeout(() => {
      this.#backgroundDoneTimer = undefined;
      if (this.#shuttingDown || !this.#pendingBackgroundDone) return;
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
      this.#pendingBackgroundDone = false;
      this.#awaitingPostToolWakeup = false;
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
        this.osc.reassertCursorHidden();
      }
      if (!this.store.approvals.hasPending() && !state.activeQuestion) {
        this.osc.setStatusDone();
        this.#scheduleDoneToIdle();
      }
      void this.#syncSessionMetricsFromTranscript();
      void this.#persistSessionAnchorAndOsc();
    }, waitMs);
  }

  #clearBackgroundDoneTimer(): void {
    if (this.#backgroundDoneTimer !== undefined) {
      clearTimeout(this.#backgroundDoneTimer);
      this.#backgroundDoneTimer = undefined;
    }
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

  async #syncSessionMetricsFromTranscript(): Promise<void> {
    if (this.#shuttingDown) return;
    const expectedSessionId = this.#metricsTracker.sessionId;
    if (!expectedSessionId) return;
    const snap = await this.#metricsTracker.syncFromTranscript();
    if (this.#shuttingDown || this.#metricsTracker.sessionId !== expectedSessionId) return;
    if (this.#applySessionMetricsSnapshot(snap)) {
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
    return buildAppView({
      state,
      draft: this.store.draft.getState(),
      turns: this.store.transcript.getVisibleTurns(),
      plan: this.store.transcript.plan,
      jobs,
      version: OMA_VERSION,
      commands: this.store.commands.getAll(),
      trafficEntries: this.store.traffic.list(),
      toolPreviewLines: this.#config.ui.tool_preview_lines,
      evictedNodeIds: this.store.transcript.evictedTurnIds,
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
