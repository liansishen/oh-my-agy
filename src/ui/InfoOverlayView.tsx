import {
  node,
  type IconName,
  type JSX,
  type KvItem,
  type SpanData,
  type StatItem,
  type TableRow,
  type Tone,
} from '@stencil-hq/tern';
import { formatAutoCompactSummary } from '../config/agy_settings';
import {
  formatCompactTokens,
  formatContextUsage,
  type AppState,
  type InfoOverlayState,
} from '../state/store';
import type {
  BackgroundJobItem,
  BackgroundJobsSnapshot,
  BackgroundJobStatus,
  BackgroundJobType,
  TranscriptTurn,
} from '../state/transcript';

export interface InfoOverlayCallbacks {
  readonly onClose: () => void;
  readonly onConfirmLogout?: () => void;
  readonly onOpenSettings?: () => void;
  readonly onSelectJob?: (jobId: string) => void;
  readonly onStopJob?: () => void;
  readonly onDetachJob?: (jobId: string) => void;
}

export interface InfoOverlayViewProps {
  readonly state: AppState;
  readonly info: InfoOverlayState;
  readonly turns: readonly TranscriptTurn[];
  readonly jobs?: BackgroundJobsSnapshot;
  readonly now?: number;
  readonly version: string;
  readonly configPath?: string;
  readonly agySettingsPath?: string;
  readonly callbacks: InfoOverlayCallbacks;
}

export const JOBS_LIST_PREFIX = 'layer.info.body.split.master.jobs.';

const JOB_STATUS_TONE: Readonly<Record<BackgroundJobStatus, Tone>> = {
  running: 'pending',
  completed: 'success',
  failed: 'error',
  cancelled: 'muted',
};

const JOB_STATUS_GLYPH: Readonly<Record<BackgroundJobStatus, SpanData>> = {
  running: { t: '●', fx: 'pulse' },
  completed: { t: '✓' },
  failed: { t: '✕' },
  cancelled: { t: '⊘' },
};

const JOB_STATUS_LABEL: Readonly<Record<BackgroundJobStatus, string>> = {
  running: 'Running',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const JOB_TYPE_ICON: Readonly<Record<BackgroundJobType, IconName>> = {
  bash: 'bash',
  schedule: 'timer',
  workflow: 'flow',
  task: 'job',
};

function safeJobKey(raw: string, fallbackIndex: number): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : `job_${fallbackIndex}`;
}

function formatJobDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 1000) return `${Math.round(safe)}ms`;
  const secs = safe / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  const rem = Math.round(secs % 60);
  return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
}

function resolveJobIcon(job: BackgroundJobItem): IconName {
  if (job.agentId) return 'agent';
  return JOB_TYPE_ICON[job.type] ?? 'job';
}

function buildJobSummaryText(runningCount: number, recentCount: number): string {
  const parts: string[] = [];
  if (runningCount > 0) parts.push(`${runningCount} running`);
  if (recentCount > 0) parts.push(`${recentCount} recent`);
  return parts.join(' · ');
}

function connectionStatusBadge(status: AppState['connectionStatus']): {
  readonly label: string;
  readonly style: 'success' | 'warning' | 'error' | 'muted';
} {
  switch (status) {
    case 'ready':
      return { label: 'Connected', style: 'success' };
    case 'initializing':
      return { label: 'Connecting…', style: 'warning' };
    case 'auth_required':
      return { label: 'Authentication required', style: 'warning' };
    case 'crashed':
      return { label: 'Disconnected (error)', style: 'error' };
    case 'closing':
      return { label: 'Closing…', style: 'muted' };
  }
}

function formatCategoryName(category: string): string {
  switch (category) {
    case 'user':
      return 'User messages';
    case 'assistant':
      return 'Assistant replies';
    case 'thought':
      return 'Thinking blocks';
    case 'tool':
      return 'Tool calls & outputs';
    default:
      return category;
  }
}

function formatCostValue(cost: { readonly amount: number; readonly currency: string }): string {
  const cur = cost.currency.trim().toUpperCase();
  const num = cost.amount >= 0.01 ? cost.amount.toFixed(2) : cost.amount.toFixed(4);
  if (cur === 'USD' || cur === '$') return `$${num}`;
  return `${num} ${cur}`;
}

function renderCloseFooter(onClose: () => void, extra?: JSX.Element): JSX.Element {
  return (
    <row key="actions" role="omp.actions" gap="sm" justify="end">
      {extra ?? null}
      <button
        key="close"
        role="omp.btn"
        keys={['escape']}
        actions={{ click: 'close' }}
        onClick={() => onClose()}
      >
        Close
      </button>
    </row>
  );
}

/**
 * Modal info overlays for `/status`, `/context`, `/usage` (`/quota`), `/jobs` (`/tasks`),
 * and `/logout` secondary confirmation dialog.
 */
export function InfoOverlayView(props: InfoOverlayViewProps): JSX.Element {
  const { state, info, turns, jobs, version, configPath, agySettingsPath, callbacks } = props;
  const now = props.now ?? Date.now();
  const effectiveConfigPath = info.configPath ?? configPath ?? 'config.toml';
  const effectiveAgyPath =
    info.agySettingsPath ?? agySettingsPath ?? '~/.gemini/antigravity-cli/settings.json';
  const usageText = formatContextUsage(state.usage);

  if (info.kind === 'jobs') {
    const allJobs = jobs?.all ?? [];
    const runningCount = jobs?.running.length ?? 0;
    const recentCount = jobs?.recent.length ?? 0;

    if (allJobs.length === 0) {
      return (
        <overlay
          key="info"
          anchor="center"
          size="lg"
          modal
          role="omp.overlay.jobs"
          head="Background jobs"
        >
          <col key="body">
            <col key="empty" role="omp.jobs.empty" align="center">
              <icon key="icon" name="jobs" />
              <text key="title" role="omp.jobs.empty.title" text="No background jobs" />
              <text
                key="note"
                role="omp.jobs.empty.note"
                text="Commands and background tasks started in this session show up here while they run."
                wrap="word"
              />
            </col>
            <row key="actions" role="omp.actions" gap="sm" align="center">
              <spacer key="sp" grow={1} />
              <button
                key="close"
                role="omp.btn"
                keys={['escape']}
                actions={{ click: 'close' }}
                onClick={() => callbacks.onClose()}
              >
                Close
              </button>
            </row>
          </col>
        </overlay>
      );
    }

    const usedKeys = new Set<string>();
    const keyedJobs = allJobs.map((job, idx) => {
      let key = safeJobKey(job.id, idx);
      if (usedKeys.has(key)) {
        key = `${key}_${idx}`;
      }
      usedKeys.add(key);
      return { job, key };
    });

    const keyToJobId = new Map<string, string>();
    for (const entry of keyedJobs) {
      keyToJobId.set(entry.key, entry.job.id);
    }

    const resolveSelectedJobId = (raw: string): string | undefined => {
      if (!raw) return undefined;
      const stripped = raw.startsWith(JOBS_LIST_PREFIX)
        ? raw.slice(JOBS_LIST_PREFIX.length)
        : raw;
      return keyToJobId.get(stripped) ?? (allJobs.some(j => j.id === raw) ? raw : undefined);
    };

    const selectedEntry =
      keyedJobs.find(e => e.job.id === info.selectedJobId) ?? keyedJobs[0]!;
    const selected = selectedEntry.job;
    const selectedKey = selectedEntry.key;
    const selectedListNodeId = `${JOBS_LIST_PREFIX}${selectedKey}`;

    const settled = selected.status !== 'running' || selected.endedAt !== undefined;
    const selectedAgeMs = Math.max(0, now - selected.startedAt);
    const selectedTookMs =
      selected.tookMs ??
      (selected.endedAt !== undefined
        ? Math.max(0, selected.endedAt - selected.startedAt)
        : selectedAgeMs);

    const facts: KvItem[] = [];
    if (selected.exitCode !== undefined) {
      facts.push({
        k: [{ t: 'Exit', s: 'muted' }],
        v: [
          {
            t: String(selected.exitCode),
            s: selected.exitCode === 0 ? 'success mono' : 'error mono',
          },
        ],
      });
    }
    if (selected.isDaemon) {
      facts.push({
        k: [{ t: 'Mode', s: 'muted' }],
        v: [{ t: 'daemon (non-blocking)', s: 'muted' }],
      });
    }
    if (selected.agentKind) {
      facts.push({
        k: [{ t: 'Agent', s: 'muted' }],
        v: selected.agentKind,
      });
    }
    if (selected.model) {
      facts.push({
        k: [{ t: 'Model', s: 'muted' }],
        v: [{ t: selected.model, s: 'mono' }],
      });
    }
    if (selected.workspace) {
      facts.push({
        k: [{ t: 'Workspace', s: 'muted' }],
        v: selected.workspace,
      });
    }

    const detailTitle =
      selected.title && selected.title.trim() !== (selected.command ?? '').trim()
        ? selected.title.trim()
        : undefined;
    const summaryText = buildJobSummaryText(runningCount, recentCount);

    const handleJobPick = (raw: string | undefined) => {
      if (!raw) return;
      const resolved = resolveSelectedJobId(raw);
      if (resolved) callbacks.onSelectJob?.(resolved);
    };

    return (
      <overlay
        key="info"
        anchor="center"
        size="lg"
        modal
        role="omp.overlay.jobs"
        head="Background jobs"
      >
        <col key="body">
          <row key="split" role="omp.jobs.split">
            <col key="master" role="omp.jobs.master">
              <list
                key="jobs"
                selected={selectedListNodeId}
                max={{ lines: 12 }}
                actions={{ click: 'select', dblclick: 'activate' }}
                onSelect={ev => handleJobPick(ev.item)}
                onActivate={ev => handleJobPick(ev.item)}
                onAction={{
                  select: ev =>
                    handleJobPick(
                      typeof ev.item === 'string'
                        ? ev.item
                        : typeof ev.value === 'string'
                          ? ev.value
                          : undefined
                    ),
                  activate: ev =>
                    handleJobPick(
                      typeof ev.item === 'string'
                        ? ev.item
                        : typeof ev.value === 'string'
                          ? ev.value
                          : undefined
                    ),
                }}
              >
                {keyedJobs.map(({ job, key }) => {
                  const isItemSettled = job.status !== 'running' || job.endedAt !== undefined;
                  const itemMs = isItemSettled
                    ? (job.tookMs ??
                      (job.endedAt !== undefined
                        ? Math.max(0, job.endedAt - job.startedAt)
                        : 0))
                    : Math.max(0, now - job.startedAt);
                  const oneLineLabel = job.label.replace(/\s+/g, ' ').trim();
                  const statusText =
                    job.status === 'running' && job.isDaemon
                      ? 'Daemon'
                      : JOB_STATUS_LABEL[job.status];
                  return (
                    <item
                      key={key}
                      label={
                        job.type === 'bash'
                          ? [{ t: oneLineLabel, s: 'mono' }]
                          : oneLineLabel
                      }
                      value={[{ t: formatJobDuration(itemMs), s: 'mono' }]}
                      icon={resolveJobIcon(job)}
                      tone={JOB_STATUS_TONE[job.status]}
                      title={`${statusText} · ${job.type} · ${oneLineLabel}`}
                      aria={`${oneLineLabel}, ${statusText}`}
                    />
                  );
                })}
              </list>
            </col>

            <col key={`detail-${selectedKey}`} role="omp.jobs.detail">
              <row key="status" role="omp.jobs.status" gap="sm" align="center">
                <text
                  key="state"
                  role="omp.jobs.state"
                  tone={JOB_STATUS_TONE[selected.status]}
                  wrap="none"
                  spans={[
                    JOB_STATUS_GLYPH[selected.status],
                    {
                      t: ` ${
                        selected.status === 'running' && selected.isDaemon
                          ? 'Daemon'
                          : JOB_STATUS_LABEL[selected.status]
                      }`,
                    },
                  ]}
                />
                {!settled ? (
                  <elapsed
                    key="age-live"
                    role="omp.jobs.age"
                    age={selectedAgeMs}
                    format="short"
                    title="Running for"
                  />
                ) : (
                  <elapsed
                    key="age-stopped"
                    role="omp.jobs.age"
                    stopped={selectedTookMs}
                    format="short"
                    title="Ran for"
                  />
                )}
                <text
                  key="id"
                  role="omp.jobs.id"
                  spans={[{ t: `${selected.type} · ${selected.id}`, s: 'mono' }]}
                  wrap="none"
                  truncate="end"
                />
                <spacer key="sp" grow={1} />
                {!settled && !selected.isDaemon && !state.isStreaming && callbacks.onDetachJob ? (
                  <button
                    key="detach"
                    role="omp.btn"
                    keys={['d']}
                    actions={{ click: 'job.detach' }}
                    onClick={() => callbacks.onDetachJob?.(selected.id)}
                  >
                    Detach
                  </button>
                ) : null}
                {!settled && (state.isStreaming || (!selected.isDaemon && state.isBusy)) && callbacks.onStopJob ? (
                  <button
                    key="stop"
                    role="omp.btn"
                    keys={['x']}
                    variant="danger"
                    tone="error"
                    actions={{ click: 'job.stop' }}
                    onClick={() => callbacks.onStopJob?.()}
                  >
                    Stop
                  </button>
                ) : null}
              </row>

              {detailTitle ? (
                <col key="about" role="omp.jobs.about" gap="xs">
                  <text
                    key="title"
                    role="omp.jobs.title"
                    text={detailTitle}
                    wrap="word"
                    title={detailTitle}
                  />
                </col>
              ) : null}

              {selected.command
                ? node('code', {
                    key: 'command',
                    role: 'omp.jobs.command',
                    lang: 'bash',
                    text: selected.command,
                    wrap: true,
                    preview: { lines: 6 },
                  })
                : null}

              {facts.length > 0 ? (
                <kv key="facts" role="omp.jobs.facts" layout="inline" items={facts} />
              ) : null}

              <col key="out" role="omp.jobs.out" gap="sm">
                <row key="source" role="omp.jobs.source" gap="sm" align="center">
                  <text key="label" role="omp.jobs.label" text="Output" />
                  <spacer key="sp" grow={1} />
                  {!settled ? (
                    <text
                      key="follow"
                      role="omp.jobs.follow"
                      text="Following"
                      tone="pending"
                      wrap="none"
                    />
                  ) : null}
                </row>
                {selected.outputText.trim() === '' ? (
                  <text
                    key="empty"
                    role="omp.jobs.nooutput"
                    text={settled ? 'No output' : 'No output yet'}
                  />
                ) : (
                  <ansi
                    key={`text-${selectedKey}`}
                    role="omp.jobs.output"
                    text={selected.outputText}
                    follow={!settled}
                    max={{ h: '16lines' }}
                  />
                )}
              </col>
            </col>
          </row>

          <row key="actions" role="omp.actions" gap="sm" align="center">
            <text key="summary" role="omp.jobs.summary" text={summaryText} wrap="none" />
            <spacer key="sp" grow={1} />
            <button
              key="close"
              role="omp.btn"
              keys={['escape']}
              actions={{ click: 'close' }}
              onClick={() => callbacks.onClose()}
            >
              Close
            </button>
          </row>
        </col>
      </overlay>
    );
  }

  if (info.kind === 'logout_confirm') {
    return (
      <overlay
        key="info"
        anchor="center"
        size="md"
        modal
        tone="warning"
        role="omp.overlay.logout"
        head="Sign out of Antigravity?"
        icon="signOut"
        foot={
          <row key="actions" role="omp.actions" gap="sm" justify="end">
            <button
              key="cancel"
              role="omp.btn"
              keys={['escape']}
              actions={{ click: 'close' }}
              onClick={() => callbacks.onClose()}
            >
              Cancel
            </button>
            <button
              key="confirm-logout"
              role="omp.btn"
              variant="danger"
              icon="signOut"
              keys={['enter']}
              disabled={state.supportsLogout ? undefined : 'Not supported by current agy acp'}
              actions={{ click: 'logout.confirm' }}
              onClick={() => callbacks.onConfirmLogout?.()}
            >
              Sign out
            </button>
          </row>
        }
      >
        <col key="logout-body" gap="sm">
          <text
            key="desc"
            wrap="word"
            text={
              info.message ??
              'This will invoke the official ACP auth/logout RPC to sign out of your current Antigravity session. You will need to run /login to reconnect.'
            }
          />
          {!state.supportsLogout ? (
            <text
              key="unsupported"
              wrap="word"
              spans={[
                {
                  t: 'Current agy acp backend did not advertise auth.logout capability.',
                  s: 'warning',
                },
              ]}
            />
          ) : null}
        </col>
      </overlay>
    );
  }

  if (info.kind === 'context') {
    const breakdown = info.contextBreakdown;
    const hasUsage = Boolean(state.usage && state.usage.size > 0);
    const meterValue =
      hasUsage && state.usage
        ? Math.min(1, Math.max(0, state.usage.used / state.usage.size))
        : undefined;
    const autoCompact = formatAutoCompactSummary(state.autoCompactOverrideRaw, state.usage?.size);

    const rows: TableRow[] = (breakdown?.categories ?? []).map(cat => ({
      id: cat.category,
      cells: {
        category: formatCategoryName(cat.category),
        chars: [{ t: cat.chars.toLocaleString('en-US'), s: 'mono muted' }],
        tokens: [{ t: formatCompactTokens(cat.estimatedTokens), s: 'mono' }],
        share: {
          meter: {
            value: Math.min(1, Math.max(0, cat.sharePercent / 100)),
            tone: (cat.category === 'tool' ? 'warning' : 'accent') as Tone,
            title: `${cat.sharePercent.toFixed(1)}%`,
          },
        },
        pct: [{ t: `${cat.sharePercent.toFixed(1)}%`, s: 'mono muted' }],
      },
    }));

    return (
      <overlay
        key="info"
        anchor="center"
        size="lg"
        modal
        role="omp.overlay.context"
        head="Context window"
        icon="context"
        meta={usageText ?? 'Waiting for ACP usage metrics'}
        foot={renderCloseFooter(callbacks.onClose)}
      >
        <col key="context-body" gap="md">
          <meter
            key="meter"
            value={meterValue}
            style="bar"
            size="md"
            thresholds={{ warn: 0.7, bad: 0.9 }}
            label={
              hasUsage && state.usage
                ? `${formatCompactTokens(state.usage.used)} (${Math.round(state.usage.percent)}%)`
                : 'No ACP usage reported yet'
            }
            total={hasUsage && state.usage ? formatCompactTokens(state.usage.size) : undefined}
            title={usageText ?? undefined}
          />

          <kv
            key="compaction"
            layout="inline"
            items={[
              {
                k: [{ t: 'Auto-compact', s: 'muted' }],
                v: [
                  {
                    t: autoCompact.label,
                    s: autoCompact.isOverride ? 'accent mono' : 'muted',
                  },
                ],
              },
            ]}
          />

          <section key="breakdown" head="Local transcript estimate">
            <table
              key="tbl"
              cols={[
                { id: 'category', head: 'Category', grow: 1 },
                { id: 'chars', head: 'Chars', align: 'end', mono: true },
                { id: 'tokens', head: 'Est. tokens', align: 'end', mono: true },
                { id: 'share', head: 'Share', priority: 1 },
                { id: 'pct', head: '%', align: 'end', mono: true },
              ]}
              rows={rows}
              empty="No conversation turns recorded yet."
            />
          </section>

          <kv
            key="summary"
            layout="grid"
            items={[
              {
                k: [{ t: 'Turns', s: 'muted' }],
                v: String(breakdown?.turnCount ?? turns.length),
              },
              {
                k: [{ t: 'Est. total', s: 'muted' }],
                v: [
                  {
                    t: `${formatCompactTokens(breakdown?.totalEstimatedTokens ?? 0)} tokens (${(breakdown?.totalChars ?? 0).toLocaleString('en-US')} chars)`,
                    s: 'mono',
                  },
                ],
              },
              ...(hasUsage && usageText
                ? [{ k: [{ t: 'ACP reported', s: 'muted' as const }], v: [{ t: usageText, s: 'mono' as const }] }]
                : []),
            ]}
          />

          <text
            key="note"
            wrap="word"
            spans={[
              {
                t: 'Tip: Run ',
                s: 'muted',
              },
              { t: '/compact', s: 'code' },
              {
                t: ' to summarize and compress now, or set ',
                s: 'muted',
              },
              { t: 'AGY_CLI_AUTO_COMPACT_OVERRIDE', s: 'code' },
              {
                t: ' to override the auto-compaction threshold.',
                s: 'muted',
              },
            ]}
          />
        </col>
      </overlay>
    );
  }

  if (info.kind === 'usage') {
    const totalTools = turns.reduce((sum, t) => sum + t.toolCalls.length, 0);
    const totalThoughts = turns.reduce((sum, t) => sum + t.thoughts.length, 0);
    const statItems: StatItem[] = [
      {
        label: 'Subscription Tier',
        value: state.tier?.name || 'Standard',
        sub: state.tier?.id ? state.tier.id : 'From ACP session metadata',
        tone: state.tier?.name ? 'accent' : 'muted',
      },
      {
        label: 'Context Used',
        value: state.usage ? formatCompactTokens(state.usage.used) : '—',
        sub: state.usage
          ? `of ${formatCompactTokens(state.usage.size)} (${state.usage.percent.toFixed(1)}%)`
          : 'Waiting for usage_update',
      },
      {
        label: 'Session Activity',
        value: `${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}`,
        sub: `${totalTools} tools · ${totalThoughts} thoughts`,
      },
      ...(state.usage?.cost
        ? [
            {
              label: 'Reported Cost',
              value: formatCostValue(state.usage.cost),
              sub: state.usage.cost.currency,
              tone: 'info' as Tone,
            },
          ]
        : []),
    ];

    const detailItems: KvItem[] = [
      {
        k: [{ t: 'Model', s: 'muted' }],
        v: [
          {
            t: state.controls.currentModelName || state.controls.currentModelId || '—',
            s: 'mono',
          },
        ],
      },
      {
        k: [{ t: 'Thinking', s: 'muted' }],
        v: state.controls.supportsThoughtLevel
          ? state.controls.currentThoughtLevelName || state.controls.currentThoughtLevel || '—'
          : [{ t: 'Not supported', s: 'muted' }],
      },
      ...(state.tier?.upgradeUri
        ? [
            {
              k: [{ t: 'Plan details', s: 'muted' as const }],
              v: [{ t: state.tier.upgradeUri, s: 'link' as const, href: state.tier.upgradeUri }],
            },
          ]
        : []),
    ];

    return (
      <overlay
        key="info"
        anchor="center"
        size="lg"
        modal
        role="omp.overlay.usage"
        head="Usage & subscription"
        icon="stats"
        foot={renderCloseFooter(callbacks.onClose)}
      >
        <col key="usage-body" gap="md">
          <stats key="tiles" items={statItems} />
          <kv key="details" layout="grid" items={detailItems} />
          <text
            key="quota-note"
            wrap="word"
            spans={[
              {
                t: 'Note: agy acp reports session context usage and subscription tier only. For detailed 5-hour or weekly quota windows, check the official agy CLI or Antigravity dashboard.',
                s: 'muted',
              },
            ]}
          />
        </col>
      </overlay>
    );
  }

  // Default: `/status`
  const conn = connectionStatusBadge(state.connectionStatus);
  const agyVersion = state.agentVersion ?? state.agentInfo?.version ?? 'unknown';
  const agyName = state.agentInfo?.name ?? 'agy acp';

  const statusItems: KvItem[] = [
    {
      k: [{ t: 'Connection', s: 'muted' }],
      v: [{ t: conn.label, s: conn.style }],
    },
    {
      k: [{ t: 'oma Version', s: 'muted' }],
      v: [{ t: `v${version}`, s: 'mono' }],
    },
    {
      k: [{ t: 'Backend', s: 'muted' }],
      v: [{ t: `${agyName} ${agyVersion}`, s: 'mono' }],
    },
    {
      k: [{ t: 'Account Tier', s: 'muted' }],
      v: state.tier?.name
        ? [{ t: state.tier.name, s: 'accent' }]
        : [{ t: 'Not reported', s: 'muted' }],
    },
    {
      k: [{ t: 'Model', s: 'muted' }],
      v: [
        {
          t: state.controls.currentModelName || state.controls.currentModelId || '—',
          s: 'mono',
        },
      ],
    },
    {
      k: [{ t: 'Thinking', s: 'muted' }],
      v: state.controls.supportsThoughtLevel
        ? state.controls.currentThoughtLevelName || state.controls.currentThoughtLevel || '—'
        : [{ t: 'Not supported', s: 'muted' }],
    },
    {
      k: [{ t: 'Permission Mode', s: 'muted' }],
      v: state.controls.currentModeName || state.controls.currentModeId || 'default',
    },
    {
      k: [{ t: 'Context Usage', s: 'muted' }],
      v: usageText ? [{ t: usageText, s: 'mono' }] : [{ t: 'Waiting for metrics', s: 'muted' }],
    },
    {
      k: [{ t: 'Session ID', s: 'muted' }],
      v: [{ t: state.sessionId || '(none)', s: 'mono dim' }],
    },
    {
      k: [{ t: 'Working Dir', s: 'muted' }],
      v: [{ t: state.displayCwd, s: 'path' }],
    },
    {
      k: [{ t: 'oma Config', s: 'muted' }],
      v: [{ t: effectiveConfigPath, s: 'path dim' }],
    },
    {
      k: [{ t: 'agy Settings', s: 'muted' }],
      v: [{ t: effectiveAgyPath, s: 'path dim' }],
    },
  ];

  const settingsButton: JSX.Element | undefined = callbacks.onOpenSettings ? (
    <button
      key="open-settings"
      role="omp.btn"
      icon="settings"
      actions={{ click: 'open-settings' }}
      onClick={() => callbacks.onOpenSettings?.()}
    >
      Settings
    </button>
  ) : undefined;

  return (
    <overlay
      key="info"
      anchor="center"
      size="lg"
      modal
      role="omp.overlay.status"
      head="Session status"
      icon="activity"
      meta={state.tier?.name ?? `${agyName} ${agyVersion}`}
      foot={renderCloseFooter(callbacks.onClose, settingsButton)}
    >
      <col key="status-body" gap="sm">
        <kv key="kv" layout="grid" items={statusItems} />
        {info.message ? (
          <text
            key="msg"
            wrap="word"
            spans={[{ t: info.message, s: 'muted' as SpanData['s'] }]}
          />
        ) : null}
      </col>
    </overlay>
  );
}
