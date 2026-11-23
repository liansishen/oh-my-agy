import type { JSX, ViewInput } from '@stencil-hq/tern';
import type { SlashCommandDef } from '../commands/registry';
import { DEFAULT_CONFIG, type OmaConfig } from '../config/config';
import type { DraftState } from '../editor/draft';
import type { AppState } from '../state/store';
import type { TrafficEntry } from '../state/traffic';
import type { BackgroundJobsSnapshot, PlanState, TranscriptTurn } from '../state/transcript';
import { ComposerView, type ComposerCallbacks } from './ComposerView';
import { GitOverlayView, type GitOverlayCallbacks } from './GitOverlayView';
import { InfoOverlayView, type InfoOverlayCallbacks } from './InfoOverlayView';
import { HelpOverlayView, PickerView, type PickerCallbacks } from './PickerView';
import { PopupView, type PopupCallbacks } from './PopupView';
import { SettingsView, type SettingsCallbacks } from './SettingsView';
import { SwarmBoardView, type SwarmBoardCallbacks } from './SwarmBoardView';
import { TranscriptView, type TranscriptCallbacks } from './TranscriptView';

export interface AppViewCallbacks {
  readonly transcript: TranscriptCallbacks;
  readonly composer: ComposerCallbacks;
  readonly popup: PopupCallbacks;
  readonly picker: PickerCallbacks;
  readonly swarm?: SwarmBoardCallbacks;
  readonly git?: GitOverlayCallbacks;
  readonly settings?: SettingsCallbacks;
  readonly info?: InfoOverlayCallbacks;
}

export interface AppViewProps {
  readonly state: AppState;
  readonly draft: DraftState;
  readonly turns: readonly TranscriptTurn[];
  readonly transcriptTurns?: readonly TranscriptTurn[];
  readonly plan: PlanState | null;
  readonly todoExpanded?: boolean;
  readonly todoHudDismissed?: boolean;
  readonly jobs?: BackgroundJobsSnapshot;
  readonly version: string;
  readonly commands: readonly SlashCommandDef[];
  readonly trafficEntries: readonly TrafficEntry[];
  readonly toolPreviewLines: number;
  readonly evictedNodeIds?: ReadonlySet<string>;
  readonly hiddenCompactedTurnCount?: number;
  readonly totalCompactedTurnCount?: number;
  readonly hasCompactedHistory?: boolean;
  readonly compactedHistoryExpanded?: boolean;
  readonly config?: OmaConfig;
  readonly configPath?: string;
  readonly agySettingsPath?: string;
  readonly workingStartedAt?: number;
  readonly hasPendingApproval?: boolean;
  readonly now?: number;
  readonly callbacks: AppViewCallbacks;
}

const NOOP_SETTINGS_CALLBACKS: SettingsCallbacks = {
  onPageChange: () => {},
  onChange: () => {},
  onSelect: () => {},
  onActivate: () => {},
  onAction: () => {},
  onClose: () => {},
};

const NOOP_INFO_CALLBACKS: InfoOverlayCallbacks = {
  onClose: () => {},
};

const NOOP_SWARM_CALLBACKS: SwarmBoardCallbacks = {
  onClose: () => {},
  onRefresh: () => {},
  onToggleFollow: () => {},
  onToggleAgentFilter: () => {},
  onSelectPost: () => {},
};

const NOOP_GIT_CALLBACKS: GitOverlayCallbacks = {
  onClose: () => {},
  onRefresh: () => {},
  onSelectFile: () => {},
  onStepFile: () => {},
  onSetViewMode: () => {},
  onToggleWrap: () => {},
  onSetSidebarStyle: () => {},
  onToggleSectionFold: () => {},
  onToggleDirFold: () => {},
  onStageFile: () => {},
  onUnstageFile: () => {},
  onStageAll: () => {},
  onUnstageAll: () => {},
  onFocusField: () => {},
  onSummaryEdit: () => {},
  onSummaryUndo: () => {},
  onBodyEdit: () => {},
  onBodyUndo: () => {},
  onToggleAmend: () => {},
  onCommit: () => {},
};

/**
 * Top-level view composer returning `{ main, dock, layer }` for `surface.render(...)`,
 * aligned 1:1 with `omp`'s `omp.session` surface structure.
 *
 * Layer composition & priority:
 * 1. Modal `<picker>` mounted directly under `layer` root (never inside `<overlay>`):
 *    `/model`, `/resume`, `/mcp`, `/plugins`, `/skills`, `/agents`, `/thought`, `/mode`, `/log`.
 * 2. Dedicated native `agy`-style Swarm Board modal `<overlay key="swarm">` (`Alt+S`, `/swarm board`,
 *    or clicking the pixel bee HUD capsule button).
 * 3. Info modal overlays: `/status`, `/context`, `/usage`, `/jobs`, `/logout` confirmation.
 * 4. `/help` modal `<overlay anchor="center" modal role="omp.overlay.hotkeys">`.
 * 5. `/settings` `<prefs>`: when `state.supportsAside === true`, mounted directly under
 *    `layer` root (never inside `<overlay>`) so Tern docks it as a right-side aside sheet
 *    that coexists with the chat & composer completion popup; otherwise wrapped in a modal `<overlay>`.
 * 6. Caret completion popup `<overlay key="complete" anchor={{ caret: EDITOR_NODE_ID }} role="omp.autocomplete">`.
 * `<toast>` renders independently alongside any layer element.
 */
export function buildAppView(props: AppViewProps): ViewInput {
  const {
    state,
    draft,
    turns,
    transcriptTurns,
    plan,
    todoExpanded,
    todoHudDismissed,
    jobs,
    version,
    commands,
    trafficEntries,
    toolPreviewLines,
    evictedNodeIds,
    hiddenCompactedTurnCount,
    totalCompactedTurnCount,
    hasCompactedHistory,
    compactedHistoryExpanded,
    config,
    configPath,
    agySettingsPath,
    workingStartedAt,
    hasPendingApproval,
    now,
    callbacks,
  } = props;

  const main: JSX.Element = (
    <TranscriptView
      state={state}
      turns={transcriptTurns ?? turns}
      plan={plan}
      version={version}
      toolPreviewLines={toolPreviewLines}
      evictedNodeIds={evictedNodeIds}
      hiddenCompactedTurnCount={hiddenCompactedTurnCount}
      totalCompactedTurnCount={totalCompactedTurnCount}
      hasCompactedHistory={hasCompactedHistory}
      compactedHistoryExpanded={compactedHistoryExpanded}
      now={now}
      callbacks={callbacks.transcript}
    />
  );

  const dock: JSX.Element = (
    <ComposerView
      state={state}
      draft={draft}
      plan={plan}
      todoExpanded={todoExpanded}
      todoHudDismissed={todoHudDismissed}
      jobs={jobs}
      hasTurns={turns.length > 0}
      commands={commands}
      workingStartedAt={workingStartedAt}
      hasPendingApproval={hasPendingApproval}
      now={now}
      callbacks={callbacks.composer}
    />
  );

  const layerChildren: Array<JSX.Element | null> = [];
  const hasBlockingModal = Boolean(
    state.picker || state.swarmBoardOpen || state.gitOverlay || state.infoOverlay || state.helpOpen
  );

  if (state.picker) {
    layerChildren.push(
      <PickerView
        state={state}
        picker={state.picker}
        trafficEntries={trafficEntries}
        callbacks={callbacks.picker}
        nowMs={now}
      />
    );
  } else if (state.swarmBoardOpen) {
    layerChildren.push(
      <SwarmBoardView
        state={state}
        now={now}
        callbacks={callbacks.swarm ?? NOOP_SWARM_CALLBACKS}
      />
    );
  } else if (state.gitOverlay) {
    layerChildren.push(
      <GitOverlayView
        git={state.gitOverlay}
        callbacks={callbacks.git ?? NOOP_GIT_CALLBACKS}
      />
    );
  } else if (state.infoOverlay) {
    layerChildren.push(
      <InfoOverlayView
        state={state}
        info={state.infoOverlay}
        turns={turns}
        jobs={jobs}
        now={now}
        version={version}
        configPath={configPath}
        agySettingsPath={agySettingsPath}
        callbacks={callbacks.info ?? NOOP_INFO_CALLBACKS}
      />
    );
  } else if (state.helpOpen) {
    layerChildren.push(
      <HelpOverlayView
        commands={commands}
        onClose={callbacks.picker.onCloseHelp}
      />
    );
  }

  // `/settings` `<prefs>`: direct child of `layer` root when `supportsAside === true`
  // (never wrapped in `<overlay>`), or modal `<overlay>` fallback when `supportsAside === false`.
  if (state.settings && (!hasBlockingModal || state.supportsAside)) {
    layerChildren.push(
      <SettingsView
        state={state}
        settings={state.settings}
        config={config ?? DEFAULT_CONFIG}
        configPath={configPath}
        agySettingsPath={agySettingsPath}
        callbacks={callbacks.settings ?? NOOP_SETTINGS_CALLBACKS}
      />
    );
  }

  // Completion popup coexists with aside `/settings` when the composer holds focus
  const settingsBlocksCompletion = Boolean(state.settings && !state.supportsAside);
  if (!hasBlockingModal && !settingsBlocksCompletion && state.completion.open) {
    layerChildren.push(
      <PopupView
        completion={state.completion}
        callbacks={callbacks.popup}
      />
    );
  }

  if (state.activeToast) {
    layerChildren.push(
      <toast
        key={`toast-${state.activeToast.seq}`}
        text={state.activeToast.text}
        sub={state.activeToast.sub}
        tone={state.activeToast.tone}
        ttl={state.activeToast.ttl}
      />
    );
  }

  const layer: JSX.Element | undefined =
    layerChildren.length > 0 ? <col>{layerChildren}</col> : undefined;

  return {
    main,
    dock,
    ...(layer ? { layer } : {}),
  };
}
