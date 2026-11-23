import {
  html,
  type Decor,
  type EditEvent,
  type FocusEvent,
  type JSX,
  type KvItem,
  type Node,
  type SendEvent,
  type SpanData,
  type UndoEvent,
} from '@stencil-hq/tern';
import {
  formatShortOrchestratorModelName,
  inferOrchestratorDefaultExecutorModel,
  inferOrchestratorDefaultPlannerModel,
  isOrchestratorModelId,
} from '../acp/model';
import type { SlashCommandDef } from '../commands/registry';
import { parseOrchestratorModelSpec } from '../config/agy_settings';
import type { DraftState } from '../editor/draft';
import type { GitStatusSnapshot } from '../state/git_status';
import {
  formatTpsText,
  type SessionMetricsSnapshot,
} from '../state/session_metrics';
import {
  formatCompactTokens,
  formatContextUsage,
  type AppState,
  type ModalPickerKind,
} from '../state/store';
import type { BackgroundJobsSnapshot, PlanState } from '../state/transcript';
import { BEE_HUD_SIZE, BEE_ORBIT_SIZE, MAX_ORBIT_BEES, type OrbitBeeSpec } from './assets';

export interface OrbitBeeEntry extends OrbitBeeSpec {
  readonly name: string;
  readonly blobId: string;
}

/**
 * Resolves the exact list of orbiting pixel bees to display around `omp.editor`
 * whenever the session is in swarm mode (`hasSwarm`), matching the real count
 * of non-killed members in the swarm (capped at `MAX_ORBIT_BEES`), each using
 * that member's colored sprite (`active` while working, `sleep` while waiting).
 */
export function resolveOrbitSwarmBees(state: AppState): readonly OrbitBeeEntry[] {
  const hasSwarm = Boolean(state.hasSwarm || state.swarmSnapshot !== null);
  if (!hasSwarm) return [];

  const fallbackActive = state.beeActiveBlobId;
  const fallbackSleep = state.beeSleepBlobId ?? fallbackActive;
  if (!fallbackActive && !fallbackSleep) return [];

  const memberBlobs = state.beeMemberBlobs;
  const activeMembers = (state.swarmSnapshot?.members ?? []).filter(m => !m.killed);

  if (activeMembers.length === 0) {
    const blobId = fallbackActive ?? fallbackSleep;
    if (!blobId) return [];
    return [{ name: 'coordinator', isWorking: Boolean(state.isSwarmWorking), blobId }];
  }

  const out: OrbitBeeEntry[] = [];
  for (const member of activeMembers) {
    if (out.length >= MAX_ORBIT_BEES) break;
    const isWorking = member.status === 'working';
    const pair = memberBlobs?.[member.name];
    const blobId = isWorking
      ? (pair?.active ?? fallbackActive ?? fallbackSleep)
      : (pair?.sleep ?? pair?.active ?? fallbackSleep ?? fallbackActive);
    if (!blobId) continue;
    out.push({ name: member.name, isWorking, blobId });
  }
  return out;
}

export interface ComposerCallbacks {
  readonly onEdit: (event: EditEvent) => void;
  readonly onUndo: (event: UndoEvent) => void;
  readonly onSend: (event: SendEvent) => void;
  readonly onFocus: (event: FocusEvent) => void;
  readonly onSubmit: () => void;
  readonly onStop: () => void;
  readonly onRemoveAttachment: (id: string) => void;
  readonly onOpenPicker: (kind: ModalPickerKind) => void;
  readonly onOpenPlannerPicker?: () => void;
  readonly onOpenExecutorPicker?: () => void;
  readonly onOpenContext: () => void;
  readonly onCycleMode: () => void;
  readonly onCycleThinking?: () => void;
  readonly onCyclePlannerThinking?: () => void;
  readonly onCycleExecutorThinking?: () => void;
  readonly onOpenSwarmBoard?: () => void;
  readonly onOpenJobs?: () => void;
  readonly onOpenGit?: () => void;
}

export interface ComposerViewProps {
  readonly state: AppState;
  readonly draft: DraftState;
  readonly plan: PlanState | null;
  readonly todoExpanded?: boolean;
  readonly todoHudDismissed?: boolean;
  readonly jobs?: BackgroundJobsSnapshot;
  readonly hasTurns: boolean;
  readonly commands?: readonly SlashCommandDef[];
  readonly workingStartedAt?: number;
  readonly hasPendingApproval?: boolean;
  readonly now?: number;
  readonly callbacks: ComposerCallbacks;
}

function normalizeEffortLevel(raw: string | null | undefined): string {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'medium';
  if (
    value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  ) {
    return value;
  }
  return value;
}

function formatEffortDisplayName(level: string): string {
  const lower = level.trim().toLowerCase();
  if (lower === 'xhigh' || lower === 'extra') return 'Extra';
  return lower ? lower.charAt(0).toUpperCase() + lower.slice(1) : 'High';
}

function resolveOrchestratorRoleCapsuleDisplay(
  role: 'planner' | 'executor',
  state: AppState
): {
  readonly shortName: string;
  readonly fullName: string;
  readonly thoughtLevel: string;
  readonly thoughtDisplay: string;
  readonly title: string;
  readonly effortTitle: string;
} | null {
  if (!isOrchestratorModelId(state.controls.currentModelId)) {
    return null;
  }
  const rawSpec = state.orchestratorSettings[role]?.trim();
  const parsed = parseOrchestratorModelSpec(rawSpec);
  const fallback =
    role === 'planner'
      ? (inferOrchestratorDefaultPlannerModel(state.controls.currentModelId)?.modelName ??
          'Gemini 4 Carbon')
      : (inferOrchestratorDefaultExecutorModel(state.controls.currentModelId)?.modelName ??
          'Gemini 4 Hydrogen');
  const fullName = parsed?.modelName || fallback;
  const shortName = formatShortOrchestratorModelName(fullName) || fullName;
  const thoughtLevel = normalizeEffortLevel(parsed?.thoughtLevel ?? 'high');
  const thoughtDisplay = formatEffortDisplayName(thoughtLevel);
  const roleLabel = role === 'planner' ? 'Planner' : 'Executor';
  return {
    shortName,
    fullName,
    thoughtLevel,
    thoughtDisplay,
    title: `Orchestrator ${roleLabel}: ${fullName} (${thoughtDisplay}) — click to switch`,
    effortTitle: `${roleLabel} thinking: ${thoughtDisplay} (click to cycle)`,
  };
}

function formatSessionCost(cost: { readonly amount: number; readonly currency: string }): string {
  const cur = cost.currency.trim().toUpperCase();
  const formatted =
    cost.amount >= 1
      ? cost.amount.toFixed(2)
      : cost.amount >= 0.01
        ? cost.amount.toFixed(2)
        : cost.amount.toFixed(4);
  if (cur === 'USD' || cur === '$') return `$${formatted}`;
  if (cur === 'EUR' || cur === '€') return `€${formatted}`;
  if (cur === 'GBP' || cur === '£') return `£${formatted}`;
  if (cur === 'CNY' || cur === 'JPY' || cur === '¥') return `¥${formatted}`;
  return `${formatted} ${cur}`;
}

function formatSwarmWorkingPlaceholder(names: readonly string[], workingCount: number): string {
  const count = Math.max(workingCount, names.length);
  if (count <= 0) {
    return 'Swarm running — type to steer/add context, or Alt+S for board';
  }
  const unit = count === 1 ? 'worker' : 'workers';
  if (names.length === 0) {
    return `Swarm running · ${count} ${unit} active — type to steer/add context, or Alt+S for board`;
  }
  const shown = names.slice(0, 3);
  const extra = names.length > 3 ? ` +${names.length - 3}` : '';
  return `Swarm running · ${count} ${unit} active (${shown.join(', ')}${extra}) — type to steer/add context, or Alt+S for board`;
}

/**
 * Compute inline UTF-16 syntax highlights for leading `/command` tokens and `@file` mentions.
 */
export function computeEditorDecor(text: string): readonly Decor[] | undefined {
  if (!text) return undefined;
  const decor: Decor[] = [];

  // 1. Leading `/command` (including `/skill:<name>` or `/swarm board`)
  const slashMatch = /^\/([A-Za-z0-9_:-]+)/.exec(text);
  if (slashMatch) {
    decor.push({
      from: 0,
      to: slashMatch[0].length,
      s: 'accent',
    });
  }

  // 2. `@file` mentions preceded by start-of-string or whitespace/punctuation
  const mentionRe = /(^|[\s([{"'`,;:<>|])(@[^\s)\]}"'`,;<>|]+)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRe.exec(text)) !== null) {
    const prefixLen = match[1]?.length ?? 0;
    const token = match[2];
    if (!token) continue;
    const from = match.index + prefixLen;
    const to = from + token.length;
    decor.push({ from, to, s: 'path' });
  }

  return decor.length > 0 ? decor : undefined;
}

/**
 * Compute inline ghost argument hint when the user has typed a known `/command`
 * and the cursor sits at the end with no arguments yet.
 */
export function computeEditorGhost(
  draft: DraftState,
  commands: readonly SlashCommandDef[] | undefined,
  completionOpen: boolean
): string | undefined {
  if (completionOpen || !commands || commands.length === 0) return undefined;
  if (draft.cursor !== draft.text.length) return undefined;
  const match = /^\/([A-Za-z0-9_-]+)(\s*)$/.exec(draft.text);
  if (!match) return undefined;

  const cmdName = match[1]!.toLowerCase();
  const trailingSpace = match[2] ?? '';
  const found = commands.find(
    cmd =>
      cmd.name.toLowerCase() === cmdName ||
      cmd.aliases.some(alias => alias.toLowerCase() === cmdName)
  );
  if (!found?.argHint) return undefined;
  return trailingSpace.length > 0 ? found.argHint : ` ${found.argHint}`;
}

/**
 * Bottom dock region aligned 1:1 with `omp`'s native TSP 3-layer dock layout,
 * enhanced with:
 * 1. Dedicated Swarm Pixel Bee HUD button (`oma.bee.hud`) positioned left of `jobs`
 *    when the session is in swarm mode (`state.hasSwarm`).
 * 2. Orbiting pixel bees (`oma.swarm.fx`) around `omp.editor` while `state.isSwarmWorking`.
 * 3. Live muted placeholder & `omp.working` banner during swarm/background activity.
 * 4. Smart Stop/Send button toggling: shows `Stop` while `isStreaming` or while
 *    background/swarm tasks run with an empty draft, and switches to `Send` as soon as
 *    the user types steering/follow-up text or adds attachments (`!isStreaming`).
 */
export function ComposerView(props: ComposerViewProps): JSX.Element {
  const {
    state,
    draft,
    plan,
    todoExpanded,
    todoHudDismissed,
    jobs,
    commands,
    workingStartedAt,
    hasPendingApproval,
    callbacks,
  } = props;
  const now = props.now ?? Date.now();
  const { controls } = state;

  const isCtrlCArmed = state.ctrlCArmedUntil > 0 && now <= state.ctrlCArmedUntil;
  const workingAgeMs =
    workingStartedAt !== undefined ? Math.max(0, now - workingStartedAt) : 0;
  const hasActiveQuestion = state.activeQuestion !== null;

  const hasSwarm = Boolean(state.hasSwarm || state.swarmSnapshot !== null);
  const isSwarmWorking = Boolean(state.isSwarmWorking);
  const swarmWorkingNames = state.swarmWorkingNames ?? [];
  const swarmWorkingCount =
    state.swarmSnapshot?.counts.workingMembers ?? swarmWorkingNames.length;
  const hasActiveBgTasks = Boolean(
    state.hasActiveBackgroundTasks || jobs?.hasActiveBackgroundTasks
  );
  const isBackgroundBusy = isSwarmWorking || hasActiveBgTasks;
  const showWorkingBar = state.isStreaming || isBackgroundBusy;

  const hasDraftOrAttachments =
    draft.text.trim().length > 0 || state.pendingAttachments.length > 0;
  const showStopButton = state.isStreaming || (isBackgroundBusy && !hasDraftOrAttachments);

  const placeholder: string | readonly (string | SpanData)[] = !state.isReady
    ? 'Connecting to agy acp… (you can start typing)'
    : hasActiveQuestion
      ? 'Answer above, or type here to skip the questions'
      : hasPendingApproval && draft.text.length === 0
        ? 'Permission pending: press y (allow) · a (always) · n (deny), or type to reply'
        : isSwarmWorking && draft.text.length === 0
          ? [{ t: formatSwarmWorkingPlaceholder(swarmWorkingNames, swarmWorkingCount), s: 'muted' }]
          : !state.isStreaming && hasActiveBgTasks && draft.text.length === 0
            ? [
                {
                  t: 'Background task running… — type to add context, or /jobs to inspect',
                  s: 'muted',
                },
              ]
            : state.sessionTitle && state.sessionTitle.trim().length > 0
              ? [{ t: `“${state.sessionTitle.trim()}”`, s: 'em' }]
              : 'What are we cooking?';

  const usageText = formatContextUsage(state.usage);
  const costText = state.usage?.cost ? formatSessionCost(state.usage.cost) : null;
  const workingLabel = hasPendingApproval
    ? 'Waiting for approval…'
    : state.isStreaming
      ? 'Working…'
      : isSwarmWorking
        ? swarmWorkingCount > 0
          ? `Swarm running (${swarmWorkingCount} active)…`
          : 'Swarm running…'
        : 'Background task running…';
  const hasPlan = Boolean(
    !todoHudDismissed &&
      plan &&
      ((plan.phases && plan.phases.some(p => p.items.length > 0)) || plan.entries.length > 0)
  );

  // Aggregate `agents` (or swarm bee) and `jobs` segments for `omp.hud`
  const swarmActiveCount = state.activeSwarmCount ?? 0;
  const runningAgents =
    Math.max(
      isSwarmWorking ? Math.max(1, swarmWorkingCount) : 0,
      swarmActiveCount,
      jobs?.runningSwarmAgentCount ?? 0
    ) + (jobs?.runningSubagentCount ?? 0);
  const inspectableAgents = Math.max(
    state.swarmSnapshot?.counts.totalMembers ?? 0,
    swarmActiveCount,
    jobs?.inspectableAgentCount ?? 0
  );
  const runningJobs = jobs?.runningJobCount ?? 0;

  const showSwarmBeeSeg = hasSwarm;
  const showGenericAgentsSeg = !hasSwarm && (runningAgents > 0 || inspectableAgents > 0);
  const showJobsSeg = runningJobs > 0;
  const showHudRow = showSwarmBeeSeg || showGenericAgentsSeg || showJobsSeg;
  const showActivityRow = showWorkingBar || hasPlan;

  const swarmBadgeCount = isSwarmWorking
    ? Math.max(1, swarmWorkingCount)
    : runningAgents;
  const swarmAria = isSwarmWorking
    ? `Swarm active, ${swarmBadgeCount} ${swarmBadgeCount === 1 ? 'worker' : 'workers'} working`
    : `Swarm idle, ${inspectableAgents} ${inspectableAgents === 1 ? 'member' : 'members'} in this session`;
  const swarmTitle = isSwarmWorking
    ? `${swarmAria}  Alt+S`
    : `Swarm board (${inspectableAgents} members · idle)  Alt+S`;

  const agentsAria =
    runningAgents > 0
      ? `${runningAgents} ${runningAgents === 1 ? 'agent' : 'agents'} running`
      : `No agents running, ${inspectableAgents} in this session`;
  const agentsTitle =
    runningAgents > 0
      ? `${agentsAria}  Alt+S`
      : `No agents running · ${inspectableAgents} in this session  Alt+S`;

  const jobsAria = `${runningJobs} ${runningJobs === 1 ? 'job' : 'jobs'} running`;
  const jobSummaryLines = (jobs?.runningJobSummaries ?? []).slice(0, 5);
  const jobsTitle =
    jobSummaryLines.length > 0
      ? `${jobsAria}  /jobs\n${jobSummaryLines.join('\n')}`
      : `${jobsAria}  /jobs`;

  const modeId = controls.currentModeId ?? 'default';
  const modeLabel = controls.currentModeName || modeId;
  const showModeChip = modeId !== 'default';
  const isOrchestratorActive = isOrchestratorModelId(controls.currentModelId);
  const effortLevel = normalizeEffortLevel(controls.currentThoughtLevel);
  const effortDisplay =
    controls.currentThoughtLevelName || controls.currentThoughtLevel || effortLevel;

  const decor = computeEditorDecor(draft.text);
  const ghost = computeEditorGhost(draft, commands, state.completion.open);

  const hasUsageData = Boolean(state.usage && state.usage.size > 0);
  const meterValue =
    hasUsageData && state.usage
      ? Math.min(1, Math.max(0, state.usage.used / state.usage.size))
      : undefined;

  // Dynamic perimeter bees matching the real active (non-retired) member count while in swarm mode
  const orbitBees = resolveOrbitSwarmBees(state);
  const plannerCapsule = resolveOrchestratorRoleCapsuleDisplay('planner', state);
  const executorCapsule = resolveOrchestratorRoleCapsuleDisplay('executor', state);

  return (
    <col>
      {showHudRow ? (
        <row key="hud" role="omp.hud" justify="end">
          <row key="running" role="omp.hud.pill" align="center">
            {showSwarmBeeSeg ? (
              <row
                key="agents"
                role="omp.hud.seg"
                gap="xs"
                align="center"
                tone={isSwarmWorking ? 'warning' : undefined}
                title={swarmTitle}
                aria={swarmAria}
                actions={{ click: 'agents.open' }}
                onClick={() =>
                  callbacks.onOpenSwarmBoard
                    ? callbacks.onOpenSwarmBoard()
                    : callbacks.onOpenPicker('swarm')
                }
              >
                {state.beeHudBlobId ? (
                  <image
                    key="bee"
                    role="oma.bee.hud"
                    blob={state.beeHudBlobId}
                    w={BEE_HUD_SIZE}
                    h={BEE_HUD_SIZE}
                    alt="Swarm"
                  />
                ) : (
                  <icon
                    key="icon"
                    name="users"
                    tone={isSwarmWorking ? 'warning' : 'muted'}
                  />
                )}
                {isSwarmWorking && swarmBadgeCount > 0 ? (
                  <text
                    key="count"
                    role="oma.hud.bee.active"
                    spans={[{ t: String(swarmBadgeCount), s: 'num strong' }]}
                    wrap="none"
                  />
                ) : null}
              </row>
            ) : showGenericAgentsSeg ? (
              <row
                key="agents"
                role="omp.hud.seg"
                gap="xs"
                align="center"
                title={agentsTitle}
                aria={agentsAria}
                actions={{ click: 'agents.open' }}
                onClick={() =>
                  callbacks.onOpenSwarmBoard
                    ? callbacks.onOpenSwarmBoard()
                    : callbacks.onOpenPicker('swarm')
                }
              >
                <icon
                  key="icon"
                  name="users"
                  tone={runningAgents > 0 ? 'accent' : 'muted'}
                />
                {runningAgents > 0 ? (
                  <text
                    key="count"
                    spans={[{ t: String(runningAgents), s: 'num' }]}
                    wrap="none"
                  />
                ) : null}
              </row>
            ) : null}

            {showJobsSeg ? (
              <row
                key="jobs"
                role="omp.hud.seg"
                gap="xs"
                align="center"
                title={jobsTitle}
                aria={jobsAria}
                actions={{ click: 'jobs.open' }}
                onClick={() => callbacks.onOpenJobs?.()}
              >
                <icon key="icon" name="job" tone="warning" />
                <text
                  key="count"
                  spans={[{ t: String(runningJobs), s: 'num' }]}
                  wrap="none"
                />
              </row>
            ) : null}
          </row>
        </row>
      ) : null}

      {showActivityRow ? (
        <row key="activity" role="omp.hud.activity" align="center" gap="sm">
          {showWorkingBar ? (
            <col key="status" role="omp.hud.status" grow={1}>
              <row key="working" role="omp.working" align="center" gap="sm">
                <spinner
                  key="spinner"
                  style="starburst"
                  tone={isSwarmWorking && !state.isStreaming ? 'warning' : 'accent'}
                />
                <elapsed key="elapsed" age={workingAgeMs} format="short" />
                <text key="sep" text="·" role="omp.working.sep" />
                <shimmer
                  key="label"
                  spans={[{ t: workingLabel, s: 'muted' }]}
                  mode="classic"
                  palette={{
                    low: 'dim',
                    mid: 'muted',
                    high: isSwarmWorking && !state.isStreaming ? 'warning' : 'accent',
                  }}
                  role="omp.working.label"
                />
                <row key="fill" grow={1} />
                <row
                  key="stop"
                  role="omp.working.stop"
                  gap="xs"
                  align="center"
                  title="Stop  Esc"
                  actions={{ click: 'interrupt' }}
                  onClick={() => callbacks.onStop()}
                >
                  <kbd key="key" keys={['escape']} />
                  <text key="lbl" text="Stop" />
                </row>
              </row>
            </col>
          ) : null}

          {hasPlan && plan ? (
            <checklist
              key="todo"
              mode="hud"
              role="omp.hud.todo"
              phases={
                plan.phases && plan.phases.length > 0
                  ? plan.phases.map(phase => ({
                      id: phase.id,
                      title: phase.title,
                      ...(!todoExpanded && phase.collapsed ? { collapsed: true } : {}),
                      items: phase.items.map(e => ({
                        id: e.id,
                        text: e.text,
                        status: e.status,
                        ...(e.note ? { note: e.note } : {}),
                      })),
                    }))
                  : [
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
                    ]
              }
            />
          ) : null}
        </row>
      ) : null}

      <col
        key="composer"
        role="omp.editor"
        folded={hasActiveQuestion ? true : undefined}
        tone={state.isStreaming || hasActiveBgTasks ? 'pending' : undefined}
      >
        <meter
          key="context"
          role="omp.composer.context"
          value={meterValue}
          style="bar"
          thresholds={{ warn: 0.7, bad: 0.9 }}
          label={hasUsageData && state.usage ? `${Math.round(state.usage.percent)}%` : undefined}
          total={hasUsageData && state.usage ? formatCompactTokens(state.usage.size) : undefined}
          title={usageText ?? 'Context window usage'}
          actions={{ click: 'status.context' }}
          onClick={() => callbacks.onOpenContext()}
        />

        {state.pendingAttachments.length > 0 ? (
          <row key="chips" gap="sm" wrap role="omp.composer.chips">
            {state.pendingAttachments.map(att => (
              <card
                key={att.id}
                role="omp.composer.chip"
                tone="accent"
                head={att.name}
                icon={att.kind === 'image' ? 'image' : 'file'}
                end={
                  <icon
                    key="rm"
                    name="x"
                    title="Remove attachment"
                    aria={`Remove ${att.name}`}
                    actions={{ click: 'remove' }}
                    onClick={() => callbacks.onRemoveAttachment(att.id)}
                  />
                }
              />
            ))}
          </row>
        ) : null}

        <row key="line" role="omp.composer.line" align="start" gap="sm">
          {showModeChip ? (
            <row
              key="mode"
              role="omp.composer.mode"
              gap="xs"
              align="center"
              tone={modeId === 'plan' ? 'info' : 'accent'}
              title="Permission mode (Shift+Tab to cycle)"
              actions={{ click: 'mode.cycle' }}
              onClick={() => callbacks.onCycleMode()}
            >
              <icon key="icon" name={modeId === 'plan' ? 'plan' : 'shield'} />
              <text key="label" text={modeLabel} wrap="none" />
            </row>
          ) : null}

          <editor
            key="input"
            text={draft.text}
            cursor={draft.cursor}
            anchor={draft.anchor}
            decor={decor}
            ghost={ghost}
            sendable={state.isReady}
            typeahead={!state.isReady}
            placeholder={placeholder}
            maxLines={8}
            onEdit={ev => callbacks.onEdit(ev)}
            onUndo={ev => callbacks.onUndo(ev)}
            onSend={ev => callbacks.onSend(ev)}
            onFocus={ev => callbacks.onFocus(ev)}
          />
        </row>

        <row key="bar" role="omp.composer.bar" gap="sm" align="center">
          <row
            key="model"
            role={isOrchestratorActive ? 'oma.composer.model.orchestrator' : 'omp.composer.model'}
            gap="xs"
            align="center"
            title="Switch model  ⌥P"
            actions={{ click: 'status.model' }}
            onClick={() => callbacks.onOpenPicker('model')}
          >
            {!isOrchestratorActive && controls.supportsThoughtLevel ? (
              <effort
                key="effort"
                level={effortLevel}
                role="omp.composer.model.effort"
                title={`Thinking effort: ${effortDisplay} (click to cycle)`}
                actions={{ click: 'thinking.cycle' }}
                onClick={() =>
                  callbacks.onCycleThinking
                    ? callbacks.onCycleThinking()
                    : callbacks.onOpenPicker('thought')
                }
              />
            ) : null}
            <text
              key="name"
              role={isOrchestratorActive ? 'oma.composer.model.orchestrator.name' : undefined}
              spans={[
                {
                  t: isOrchestratorActive
                    ? 'Orchestrator'
                    : controls.currentModelName || (state.isReady ? 'model' : 'connecting…'),
                  ...(state.isReady ? {} : { s: 'muted' }),
                },
              ]}
              wrap="none"
            />
            <icon key="chev" name="chev" />
          </row>

          {plannerCapsule ? (
            <row
              key="planner"
              role="oma.composer.planner"
              gap="xs"
              align="center"
              tone="info"
              title={plannerCapsule.title}
              aria={plannerCapsule.title}
              actions={{ click: 'status.planner' }}
              onClick={() =>
                callbacks.onOpenPlannerPicker
                  ? callbacks.onOpenPlannerPicker()
                  : callbacks.onOpenPicker('planner')
              }
            >
              <text
                key="tag"
                role="oma.composer.planner.tag"
                text="Plan"
                wrap="none"
              />
              <effort
                key="effort"
                level={plannerCapsule.thoughtLevel}
                role="oma.composer.planner.effort"
                title={plannerCapsule.effortTitle}
                actions={{ click: 'planner.thinking.cycle' }}
                onClick={() => callbacks.onCyclePlannerThinking?.()}
              />
              <text
                key="name"
                text={plannerCapsule.shortName}
                wrap="none"
              />
              <icon key="chev" name="chev" />
            </row>
          ) : null}

          {executorCapsule ? (
            <row
              key="executor"
              role="oma.composer.executor"
              gap="xs"
              align="center"
              tone="success"
              title={executorCapsule.title}
              aria={executorCapsule.title}
              actions={{ click: 'status.executor' }}
              onClick={() =>
                callbacks.onOpenExecutorPicker
                  ? callbacks.onOpenExecutorPicker()
                  : callbacks.onOpenPicker('executor')
              }
            >
              <text
                key="tag"
                role="oma.composer.executor.tag"
                text="Exec"
                wrap="none"
              />
              <effort
                key="effort"
                level={executorCapsule.thoughtLevel}
                role="oma.composer.executor.effort"
                title={executorCapsule.effortTitle}
                actions={{ click: 'executor.thinking.cycle' }}
                onClick={() => callbacks.onCycleExecutorThinking?.()}
              />
              <text
                key="name"
                text={executorCapsule.shortName}
                wrap="none"
              />
              <icon key="chev" name="chev" />
            </row>
          ) : null}

          {renderComposerExtras({
            modeId,
            modeLabel,
            gitStatus: state.gitStatus,
            sessionMetrics: state.sessionMetrics,
            usage: state.usage,
            isCtrlCArmed,
            onCycleMode: callbacks.onCycleMode,
            onOpenContext: callbacks.onOpenContext,
            onOpenGit: callbacks.onOpenGit,
          })}

          {costText ? (
            <text
              key="usage"
              role="omp.composer.usage"
              text={costText}
              wrap="none"
            />
          ) : null}

          {showStopButton ? (
            <text
              key="stop"
              role="omp.composer.stop"
              text="Stop"
              tone="error"
              title="Stop  Esc"
              actions={{ click: 'interrupt' }}
              onClick={() => callbacks.onStop()}
            />
          ) : (
            <kbd
              key="send"
              role="omp.composer.send"
              keys={['enter']}
              title="Send  Enter"
              actions={{ click: 'submit' }}
              onClick={() => callbacks.onSubmit()}
            />
          )}
        </row>

        {orbitBees.length > 0 ? (
          <html.div
            key="swarm-fx"
            role="oma.swarm.fx"
            class="oma-swarm-fx"
            attrs={{ 'data-role': 'oma.swarm.fx', 'aria-hidden': true }}
          >
            {orbitBees.map((bee, idx) => (
              <html.div
                key={`bee-${idx + 1}`}
                role={`oma.swarm.bee-${idx + 1}`}
                class={`oma-swarm-bee oma-bee-${idx + 1}`}
                attrs={{ 'data-role': `oma.swarm.bee-${idx + 1}`, 'aria-hidden': true }}
              >
                <image
                  key="img"
                  role="oma.swarm.bee.img"
                  blob={bee.blobId}
                  w={BEE_ORBIT_SIZE}
                  h={BEE_ORBIT_SIZE}
                  alt=""
                />
              </html.div>
            ))}
          </html.div>
        ) : null}
      </col>
    </col>
  );
}

// ---------------------------------------------------------------------------
// Bottom Status Bar (`omp.composer.extras`) Helpers
// ---------------------------------------------------------------------------

export type ModeSemanticTone = 'success' | 'warning' | 'info' | 'muted';

export function resolveModeTone(modeId: string): ModeSemanticTone {
  const normalized = modeId.trim().toLowerCase();
  if (normalized === 'auto') return 'success';
  if (normalized === 'accept-edits' || normalized === 'accept_edits') return 'warning';
  if (normalized === 'plan') return 'info';
  return 'muted';
}

export function buildGitSegSpans(git: GitStatusSnapshot): SpanData[] {
  const branchText = git.detached ? `@${git.branch}` : git.branch;
  const spans: SpanData[] = [{ t: branchText, s: 'muted' }];
  if (git.isDirty) {
    spans.push({ t: '*', s: 'warning' });
  }
  if (git.ahead > 0) {
    spans.push({ t: ` ↑${git.ahead}`, s: 'info' });
  }
  if (git.behind > 0) {
    spans.push({ t: ` ↓${git.behind}`, s: 'warning' });
  }
  return spans;
}

function buildGitTitle(git: GitStatusSnapshot): string {
  const headLabel = git.detached ? `${git.branch} (detached)` : git.branch;
  const parts: string[] = [];
  if (git.staged > 0) parts.push(`${git.staged} staged`);
  if (git.unstaged > 0) parts.push(`${git.unstaged} unstaged`);
  if (git.untracked > 0) parts.push(`${git.untracked} untracked`);
  const treeSummary = parts.length > 0 ? `dirty: ${parts.join(', ')}` : 'clean';
  const syncParts: string[] = [];
  if (git.ahead > 0) syncParts.push(`↑${git.ahead}`);
  if (git.behind > 0) syncParts.push(`↓${git.behind}`);
  const syncSuffix = syncParts.length > 0 ? ` · ${syncParts.join(' ')}` : '';
  return `Git: ${headLabel} (${treeSummary}${syncSuffix})`;
}

function buildGitHovercard(git: GitStatusSnapshot): Node {
  const items: KvItem[] = [
    {
      k: 'Branch',
      v: git.detached
        ? [{ t: git.branch, s: 'mono' }, { t: ' (detached)', s: 'muted' }]
        : [{ t: git.branch, s: 'mono' }],
    },
    {
      k: 'Working tree',
      v: git.isDirty ? [{ t: 'Dirty', s: 'warning' }] : [{ t: 'Clean', s: 'success' }],
    },
    { k: 'Staged', v: [{ t: String(git.staged), s: git.staged > 0 ? 'info' : 'muted' }] },
    {
      k: 'Unstaged',
      v: [{ t: String(git.unstaged), s: git.unstaged > 0 ? 'warning' : 'muted' }],
    },
    {
      k: 'Untracked',
      v: [{ t: String(git.untracked), s: git.untracked > 0 ? 'warning' : 'muted' }],
    },
  ];
  if (git.ahead > 0 || git.behind > 0) {
    const syncSpans: SpanData[] = [];
    if (git.ahead > 0) syncSpans.push({ t: `↑${git.ahead} ahead`, s: 'info' });
    if (git.ahead > 0 && git.behind > 0) syncSpans.push({ t: ' · ', s: 'muted' });
    if (git.behind > 0) syncSpans.push({ t: `↓${git.behind} behind`, s: 'warning' });
    items.push({ k: 'Sync', v: syncSpans });
  }
  return (
    <col gap="xs">
      <text spans={[{ t: 'Git Status', s: 'strong' }]} wrap="none" />
      <kv layout="grid" items={items} />
    </col>
  ) as Node;
}

export function buildTokenSegSpans(metrics: SessionMetricsSnapshot): SpanData[] {
  const spans: SpanData[] = [
    { t: `↑${formatCompactTokens(metrics.totalInputTokens)}`, s: 'info' },
  ];
  if (metrics.cacheHitPercent !== null && Number.isFinite(metrics.cacheHitPercent)) {
    spans.push({ t: `(${Math.round(metrics.cacheHitPercent)}%)`, s: 'success' });
  }
  spans.push({ t: ` ↓${formatCompactTokens(metrics.totalOutputTokens)}`, s: 'warning' });
  return spans;
}

function formatExactPercent(percent: number): string {
  return percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

function buildTokenTitle(
  metrics: SessionMetricsSnapshot,
  usage: AppState['usage']
): string {
  const lines: string[] = [];
  if (usage && usage.size > 0) {
    lines.push(
      `Context: ${usage.used.toLocaleString('en-US')} / ${usage.size.toLocaleString('en-US')} (${formatExactPercent(usage.percent)})`
    );
  }
  const hitLabel =
    metrics.cacheHitPercent !== null && Number.isFinite(metrics.cacheHitPercent)
      ? `${metrics.cacheHitPercent.toFixed(1)}%`
      : 'n/a';
  lines.push(
    `Input: ${metrics.totalInputTokens.toLocaleString('en-US')} (uncached ${metrics.totalUncachedInputTokens.toLocaleString('en-US')}, cache read ${metrics.totalCacheReadTokens.toLocaleString('en-US')}, hit ${hitLabel})`
  );
  lines.push(`Output: ${metrics.totalOutputTokens.toLocaleString('en-US')}`);
  lines.push('Click to open /context');
  return lines.join('\n');
}

function buildTokenHovercard(
  metrics: SessionMetricsSnapshot,
  usage: AppState['usage']
): Node {
  const items: KvItem[] = [];
  if (usage && usage.size > 0) {
    items.push({
      k: 'Context',
      v: [
        {
          t: `${formatCompactTokens(usage.used)} / ${formatCompactTokens(usage.size)}`,
          s: 'mono',
        },
        { t: ` (${formatExactPercent(usage.percent)})`, s: 'muted' },
      ],
    });
  }
  items.push(
    {
      k: 'Total input',
      v: [{ t: metrics.totalInputTokens.toLocaleString('en-US'), s: 'info' }],
    },
    {
      k: 'Uncached input',
      v: [{ t: metrics.totalUncachedInputTokens.toLocaleString('en-US'), s: 'mono' }],
    },
    {
      k: 'Cache read',
      v: [{ t: metrics.totalCacheReadTokens.toLocaleString('en-US'), s: 'success' }],
    },
    {
      k: 'Cache hit',
      v:
        metrics.cacheHitPercent !== null && Number.isFinite(metrics.cacheHitPercent)
          ? [{ t: `${metrics.cacheHitPercent.toFixed(1)}%`, s: 'success' }]
          : [{ t: '—', s: 'muted' }],
    },
    {
      k: 'Total output',
      v: [{ t: metrics.totalOutputTokens.toLocaleString('en-US'), s: 'warning' }],
    }
  );
  if (metrics.responseCount > 0) {
    items.push({
      k: 'Responses',
      v: [{ t: String(metrics.responseCount), s: 'muted' }],
    });
  }
  const tpsText = formatTpsText(metrics.currentTps);
  if (tpsText) {
    items.push({
      k: 'Speed',
      v: [
        { t: tpsText, s: metrics.isStreamingTps ? 'info' : 'muted' },
        { t: metrics.isStreamingTps ? ' (live)' : ' (last turn)', s: 'muted' },
      ],
    });
  }
  return (
    <col gap="xs">
      <row justify="between" align="center" gap="sm">
        <text spans={[{ t: 'Session Telemetry', s: 'strong' }]} wrap="none" />
        <text spans={[{ t: '/context', s: 'muted' }]} wrap="none" />
      </row>
      <kv layout="grid" items={items} />
    </col>
  ) as Node;
}

interface ComposerExtrasParams {
  readonly modeId: string;
  readonly modeLabel: string;
  readonly gitStatus: GitStatusSnapshot | null;
  readonly sessionMetrics: SessionMetricsSnapshot | null;
  readonly usage: AppState['usage'];
  readonly isCtrlCArmed: boolean;
  readonly onCycleMode: () => void;
  readonly onOpenContext: () => void;
  readonly onOpenGit?: () => void;
}

function renderComposerExtras(params: ComposerExtrasParams): JSX.Element {
  const {
    modeId,
    modeLabel,
    gitStatus,
    sessionMetrics,
    usage,
    isCtrlCArmed,
    onCycleMode,
    onOpenContext,
    onOpenGit,
  } = params;

  const modeTone = resolveModeTone(modeId);
  const tpsText = formatTpsText(sessionMetrics?.currentTps);
  const isStreamingTps = Boolean(sessionMetrics?.isStreamingTps);
  const hasTokenMetrics = Boolean(
    sessionMetrics &&
      (sessionMetrics.totalInputTokens > 0 || sessionMetrics.totalOutputTokens > 0)
  );

  return (
    <status key="extras" role="omp.composer.extras" transparent grow={1}>
      <seg
        key="mode"
        role="omp.composer.fact"
        priority={10}
        tone={modeTone}
        icon={modeId === 'plan' ? 'plan' : 'shield'}
        spans={[{ t: modeLabel, s: modeTone }]}
        title={`Permission mode: ${modeLabel} (click or Shift+Tab to cycle)`}
        actions={{ click: 'mode.cycle' }}
        onClick={() => onCycleMode()}
      />
      {gitStatus !== null ? (
        <seg
          key="git"
          role="omp.composer.fact"
          priority={3}
          min={{ w: '10ch' }}
          tone={gitStatus.isDirty ? 'warning' : 'muted'}
          icon="git-branch"
          spans={buildGitSegSpans(gitStatus)}
          title={`${buildGitTitle(gitStatus)} (click or /git to open)`}
          hovercard={buildGitHovercard(gitStatus)}
          actions={{ click: 'status.git' }}
          onClick={() => onOpenGit?.()}
        />
      ) : null}
      {tpsText !== null ? (
        <seg
          key="tps"
          role="omp.composer.fact"
          side="right"
          priority={5}
          tone={isStreamingTps ? 'info' : 'muted'}
          icon="bolt"
          spans={[{ t: tpsText, s: isStreamingTps ? 'info' : 'muted' }]}
          title={
            isStreamingTps
              ? `Streaming output speed: ${tpsText}`
              : `Last turn output speed: ${tpsText}`
          }
        />
      ) : null}
      {hasTokenMetrics && sessionMetrics ? (
        <seg
          key="tokens"
          role="omp.composer.fact"
          side="right"
          priority={7}
          tone="info"
          icon="tokens"
          spans={buildTokenSegSpans(sessionMetrics)}
          title={buildTokenTitle(sessionMetrics, usage)}
          hovercard={buildTokenHovercard(sessionMetrics, usage)}
          actions={{ click: 'status.context' }}
          onClick={() => onOpenContext()}
        />
      ) : null}
      {isCtrlCArmed ? (
        <seg
          key="ctrlc"
          role="omp.composer.fact"
          side="right"
          priority={9}
          tone="warning"
          spans={[{ t: 'Press Ctrl+C again to exit', s: 'warning' }]}
        />
      ) : null}
    </status>
  );
}
