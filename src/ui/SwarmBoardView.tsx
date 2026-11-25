import type { JSX, SpanData, Tone } from '@stencil-hq/tern';
import type { AppState } from '../state/store';
import type {
  SwarmBoardMessage,
  SwarmBoardSnapshot,
  SwarmMember,
  SwarmMemberStatus,
  SwarmMessageBadgeTone,
  SwarmOverviewThread,
} from '../swarm/board';
import { BEE_CARD_SIZE, getBeePaletteIdForMember } from './assets';

export const SWARM_POSTS_LIST_PREFIX = 'layer.swarm.body.split.posts-pane.posts.';
/** Minimum terminal row height required to display the Swarm Overview header pane. */
export const SWARM_OVERVIEW_MIN_ROWS = 28;

export interface SwarmBoardCallbacks {
  readonly onClose: () => void;
  readonly onRefresh: () => void;
  readonly onToggleFollow: () => void;
  readonly onToggleAgentFilter: (agentName: string | null) => void;
  readonly onSelectPost: (seq: number) => void;
  readonly onClearQuery?: () => void;
}

export interface SwarmBoardViewProps {
  readonly state: AppState;
  readonly now?: number;
  readonly callbacks: SwarmBoardCallbacks;
}

/**
 * Filter swarm posts identically to `AppStore.getFilteredSwarmPosts`
 * (descending `seq` order — newest post at index 0 — so `↑`/`↓` navigation
 * matches `store.moveSwarmPostSelection`).
 */
export function filterSwarmBoardPosts(
  snapshot: SwarmBoardSnapshot | null,
  filterAgent: string | null,
  query: string
): readonly SwarmBoardMessage[] {
  if (!snapshot) return [];
  const normalizedAgent = filterAgent?.trim() || null;
  const normalizedQuery = query.trim().toLowerCase();

  const filtered = snapshot.messages.filter(msg => {
    if (normalizedAgent && msg.agent !== normalizedAgent) {
      return false;
    }
    if (normalizedQuery.length === 0) return true;
    if (`#${msg.seq}`.includes(normalizedQuery)) return true;
    if (msg.agent.toLowerCase().includes(normalizedQuery)) return true;
    if (msg.summary.toLowerCase().includes(normalizedQuery)) return true;
    if (msg.text.toLowerCase().includes(normalizedQuery)) return true;
    if (
      msg.badges.some(
        b =>
          b.tag.toLowerCase().includes(normalizedQuery) ||
          b.label.toLowerCase().includes(normalizedQuery)
      )
    ) {
      return true;
    }
    if (msg.mentions.some(m => m.toLowerCase().includes(normalizedQuery))) {
      return true;
    }
    return false;
  });

  // Descending `seq` order: newest post at the top
  return filtered.slice().sort((a, b) => b.seq - a.seq);
}

function mapBadgeTone(tone: SwarmMessageBadgeTone): Tone {
  if (tone === 'danger') return 'error';
  return tone;
}

function memberStatusTone(status: SwarmMemberStatus): Tone {
  switch (status) {
    case 'working':
      return 'success';
    case 'waiting':
      return 'muted';
    case 'stopped':
      return 'warning';
    case 'killed':
      return 'muted';
  }
}

function formatPostedAgo(rawTime: string | undefined, nowMs: number): string | null {
  if (!rawTime) return null;
  const trimmed = rawTime.trim();
  if (!trimmed) return null;
  // Support both ISO-8601 and `YYYY-MM-DD HH:MM:SS`
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const diffSec = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function formatPostClock(rawTime: string): string {
  const trimmed = rawTime.trim();
  if (!trimmed) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/.exec(trimmed);
  if (m && m[4]) {
    return m[4];
  }
  return trimmed.slice(0, 16);
}

function sanitizeNodeKey(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : fallback;
}

export function isSystemSwarmAgent(agent: string): boolean {
  return agent.trim().toLowerCase() === 'system';
}

function resolveMemberBeeBlob(
  state: AppState,
  member: SwarmMember | undefined,
  fallbackWorking = false
): string | undefined {
  const isWorking = member ? member.status === 'working' : fallbackWorking;
  if (member) {
    const custom = state.beeMemberBlobs?.[member.name];
    if (custom) {
      return isWorking ? custom.active : custom.sleep;
    }
  }
  return isWorking ? state.beeActiveBlobId : state.beeSleepBlobId;
}

function formatRosterSummary(snapshot: SwarmBoardSnapshot): string {
  const { counts } = snapshot;
  const parts: string[] = [
    `${counts.totalMembers} ${counts.totalMembers === 1 ? 'member' : 'members'}`,
  ];
  if (counts.workingMembers > 0) {
    parts.push(`${counts.workingMembers} working`);
  }
  if (counts.waitingMembers > 0 || counts.workingMembers === 0) {
    parts.push(`${counts.waitingMembers} waiting`);
  }
  if (counts.stoppedMembers > 0) {
    parts.push(`${counts.stoppedMembers} stopped`);
  }
  return parts.join(', ');
}

function formatModelLine(model: string | undefined): string {
  if (!model) return 'default model';
  const trimmed = model.trim();
  if (trimmed.length <= 24) return trimmed;
  return `${trimmed.slice(0, 23).trimEnd()}…`;
}

function resolveSelectedSeqFromItem(raw: string | undefined): number | null {
  if (!raw) return null;
  const stripped = raw.startsWith(SWARM_POSTS_LIST_PREFIX)
    ? raw.slice(SWARM_POSTS_LIST_PREFIX.length)
    : raw;
  const m = /^(?:seq-)?(\d+)$/.exec(stripped);
  if (!m || !m[1]) return null;
  const seq = Number(m[1]);
  return Number.isFinite(seq) ? seq : null;
}

/**
 * Native `agy`-style Swarm Board modal overlay mounted directly under `layer`:
 * - **Top Roster**: header summary (`Roster · N members, ...`), airy borderless
 *   multi-column member cards with per-member colored pixel bee sprites (`working`
 *   fluffy wings vs `waiting` `z` sleep sprite, coordinator crown `👑`), click to
 *   filter posts, plus a compact single-line `Retired (K): ...` footer.
 * - **Bottom Split (`52% / 48%`)**:
 *   - Left: searchable & scrollable Posts `<list>` with `#seq`, `HH:MM`, sender,
 *     semantic `[done]`/`[stall]` badges, and single-line summary.
 *   - Right: selected Post header metadata (member bee, `#seq`, agent, status,
 *     model, timestamp, mentions) + `<scroll>` wrapping full `<md>` body.
 */
export function SwarmBoardView(props: SwarmBoardViewProps): JSX.Element {
  const { state, callbacks } = props;
  const now = props.now ?? Date.now();
  const snapshot = state.swarmSnapshot;
  const followOn = state.swarmBoardFollow;
  const filterAgent = state.swarmBoardFilterAgent;
  const query = state.swarmBoardQuery;

  const headerControls = (
    <row key="controls" gap="xs" align="center">
      <button
        key="refresh"
        size="sm"
        icon="repeat"
        keys={['ctrl+r']}
        actions={{ click: 'swarm.refresh' }}
        onClick={() => callbacks.onRefresh()}
      >
        Refresh
      </button>
      <button
        key="follow"
        size="sm"
        icon="arrow-down"
        on={followOn}
        actions={{ click: 'swarm.follow' }}
        onClick={() => callbacks.onToggleFollow()}
      >
        Follow
      </button>
      <button
        key="close"
        size="sm"
        keys={['escape']}
        actions={{ click: 'swarm.close' }}
        onClick={() => callbacks.onClose()}
      >
        Close
      </button>
    </row>
  );

  if (!snapshot) {
    return (
      <overlay
        key="swarm"
        anchor="center"
        size="lg"
        modal
        role="oma.overlay.swarm"
        head="Swarm Board"
        icon="users"
        meta="No active swarm"
        end={headerControls}
      >
        <empty
          key="empty"
          variant="center"
          icon="users"
          title="No active swarm"
          text="No active swarm in this session. Run /swarm <task> to start one."
        />
      </overlay>
    );
  }

  const activeMembers = snapshot.members.filter(m => !m.killed);
  const retiredMembers = snapshot.members.filter(m => m.killed);

  const filteredPosts = filterSwarmBoardPosts(snapshot, filterAgent, query);
  const usedPostKeys = new Set<string>();
  const keyedPosts = filteredPosts.map((msg, idx) => {
    let key = `seq-${msg.seq}`;
    if (usedPostKeys.has(key)) {
      key = `seq-${msg.seq}-${idx}`;
    }
    usedPostKeys.add(key);
    return { msg, key };
  });

  const usedMemberKeys = new Set<string>();
  const keyedActiveMembers = activeMembers.map((member, idx) => {
    let key = sanitizeNodeKey(`member-${member.name}`, `member-${idx}`);
    if (usedMemberKeys.has(key)) {
      key = `${key}-${idx}`;
    }
    usedMemberKeys.add(key);
    return { member, key };
  });

  const selectedPostEntry =
    keyedPosts.find(e => e.msg.seq === state.swarmBoardSelectedSeq) ??
    keyedPosts[0] ??
    undefined;
  const selectedPost = selectedPostEntry?.msg;
  const selectedListNodeId = selectedPostEntry
    ? `${SWARM_POSTS_LIST_PREFIX}${selectedPostEntry.key}`
    : undefined;

  const handlePickPost = (raw: string | undefined) => {
    const seq = resolveSelectedSeqFromItem(raw);
    if (seq !== null) callbacks.onSelectPost(seq);
  };

  const retiredNames = retiredMembers.map(m => m.name);
  const retiredMaxShown = 10;
  const retiredText =
    retiredNames.length > retiredMaxShown
      ? `${retiredNames.slice(0, retiredMaxShown).join(', ')}, …`
      : retiredNames.join(', ');

  const postsCountLabel =
    filterAgent || query.trim().length > 0
      ? `${filteredPosts.length} / ${snapshot.counts.totalMessages} posts`
      : `${snapshot.counts.totalMessages} total`;

  const selectedSender = selectedPost
    ? snapshot.memberByName[selectedPost.agent]
    : undefined;
  const selectedIsSystem = Boolean(selectedPost && isSystemSwarmAgent(selectedPost.agent));
  const selectedSenderPalette = selectedPost
    ? getBeePaletteIdForMember(selectedPost.agent, selectedSender?.role)
    : 'gold';
  const selectedSenderBee =
    selectedPost && !selectedIsSystem
      ? resolveMemberBeeBlob(state, selectedSender, false)
      : undefined;

  const overview = snapshot.overview ?? null;
  const showOverview = Boolean(overview && state.terminalRows >= SWARM_OVERVIEW_MIN_ROWS);

  const threadStatusGlyph = (status: SwarmOverviewThread['status']): { text: string; style: string; role: string } => {
    switch (status) {
      case 'done':
        return { text: '✓', style: 'success strong', role: 'oma.swarm.overview.thread.done' };
      case 'working':
        return { text: '●', style: 'info strong', role: 'oma.swarm.overview.thread.working' };
      case 'blocked':
        return { text: '▲', style: 'error strong', role: 'oma.swarm.overview.thread.blocked' };
      default:
        return { text: '○', style: 'muted', role: 'oma.swarm.overview.thread' };
    }
  };

  return (
    <overlay
      key="swarm"
      anchor="center"
      size="lg"
      modal
      role="oma.overlay.swarm"
      head={snapshot.title || 'Swarm Board'}
      icon="users"
      meta={`${snapshot.counts.workingMembers} working · ${snapshot.counts.totalMessages} posts`}
      end={headerControls}
    >
      <col key="body" role="oma.swarm.body" gap="sm" grow={1}>
        {/* -----------------------------------------------------------------
            0. Real-Time Swarm Overview (shown when terminal height >= 28 rows & plan.json present)
            ----------------------------------------------------------------- */}
        {showOverview && overview ? (
          <col key="overview" role="oma.swarm.overview" gap="xs">
            <row key="overview-head" justify="between" align="center" gap="sm">
              <text
                key="goal"
                spans={[
                  { t: 'Overview', s: 'strong' },
                  { t: ` · ${overview.goalTitle}`, s: 'accent' },
                ]}
                wrap="none"
                truncate="end"
              />
              <row key="progress" gap="xs" align="center">
                <badge
                  key="done"
                  text={`${overview.doneCount}/${overview.totalTasks} done`}
                  tone={
                    overview.totalTasks > 0 && overview.doneCount >= overview.totalTasks
                      ? 'success'
                      : 'accent'
                  }
                />
                {overview.workingCount > 0 ? (
                  <badge key="working" text={`${overview.workingCount} active`} tone="info" />
                ) : null}
                {overview.blockedCount > 0 ? (
                  <badge key="blocked" text={`${overview.blockedCount} blocked`} tone="error" />
                ) : null}
              </row>
            </row>

            {overview.goalLine ? (
              <text
                key="goal-line"
                spans={[{ t: overview.goalLine, s: 'muted' }]}
                wrap="word"
                lines={2}
              />
            ) : null}

            {overview.threads.length > 0 ? (
              <row
                key="threads"
                role="oma.swarm.overview.threads"
                wrap
                gap="xs"
                align="center"
              >
                {overview.threads.slice(0, 6).map((thread, idx) => {
                  const glyph = threadStatusGlyph(thread.status);
                  const firstMember = thread.tasks.find(name => Boolean(snapshot.memberByName[name])) ?? thread.tasks[0];
                  const threadTitle = [
                    thread.title,
                    thread.goal || undefined,
                    `${thread.doneCount}/${thread.totalCount} done`,
                    thread.blockedCount > 0 ? `${thread.blockedCount} blocked` : undefined,
                    thread.tasks.length > 0 ? `workers: ${thread.tasks.join(', ')}` : undefined,
                  ]
                    .filter(Boolean)
                    .join(' · ');

                  return (
                    <row
                      key={sanitizeNodeKey(`thread-${thread.id}`, `thread-${idx}`)}
                      role={glyph.role}
                      gap="xs"
                      align="center"
                      title={threadTitle}
                      aria={`${thread.title}, ${thread.status}, ${thread.doneCount} of ${thread.totalCount} done`}
                      actions={firstMember ? { click: `swarm.thread=${thread.id}` } : undefined}
                      onClick={
                        firstMember
                          ? () => callbacks.onToggleAgentFilter(firstMember)
                          : undefined
                      }
                    >
                      <text key="st" spans={[{ t: glyph.text, s: glyph.style }]} wrap="none" />
                      <text
                        key="lbl"
                        spans={[{ t: thread.title, s: 'strong' }]}
                        wrap="none"
                        truncate="end"
                      />
                      <text
                        key="cnt"
                        spans={[{ t: `${thread.doneCount}/${thread.totalCount}`, s: 'mono dim' }]}
                        wrap="none"
                      />
                    </row>
                  );
                })}
              </row>
            ) : null}
          </col>
        ) : null}

        {showOverview && overview ? <rule key="overview-sep" /> : null}

        {/* -----------------------------------------------------------------
            1. Top Roster Section (1:1 aligned with native `agy` Roster)
            ----------------------------------------------------------------- */}
        <col key="roster" role="oma.swarm.roster" gap="xs">
          <row key="roster-head" justify="between" align="center" gap="sm">
            <text
              key="summary"
              spans={[
                { t: 'Roster', s: 'strong' },
                { t: ` · ${formatRosterSummary(snapshot)}`, s: 'muted' },
              ]}
              wrap="none"
            />
            {filterAgent ? (
              <row
                key="filter-pill"
                gap="xs"
                align="center"
                title="Click to clear member filter"
                actions={{ click: 'swarm.filter.clear' }}
                onClick={() => callbacks.onToggleAgentFilter(null)}
              >
                <badge key="b" text={`Filter: ${filterAgent} ×`} tone="warning" />
              </row>
            ) : (
              <text
                key="hint"
                spans={[{ t: 'Click a member to filter posts', s: 'dim' }]}
                wrap="none"
              />
            )}
          </row>

          {activeMembers.length > 0 ? (
            <row
              key="roster-grid"
              role="oma.swarm.roster.grid"
              wrap
              gap="md"
              align="start"
            >
              {keyedActiveMembers.map(({ member, key: memberKey }) => {
                const isCoordinator =
                  member.role === 'coordinator' || member.name === 'coordinator';
                const isWorking = member.status === 'working';
                const isSelectedFilter = filterAgent === member.name;
                const paletteId = getBeePaletteIdForMember(member.name, member.role);
                const beeBlobId = resolveMemberBeeBlob(state, member, isWorking);
                const postedAgo = formatPostedAgo(member.lastMessageTime, now);

                const statusSpans: SpanData[] = isWorking
                  ? [{ t: '● working', s: 'success strong' }]
                  : member.status === 'waiting'
                    ? [{ t: '○ waiting', s: 'muted' }]
                    : [{ t: '◌ stopped', s: 'warning' }];
                if (postedAgo) {
                  statusSpans.push({ t: ` · ${postedAgo}`, s: 'dim' });
                }

                const cardTitle = [
                  member.name,
                  `status: ${member.status}`,
                  member.model ? `model: ${member.model}` : undefined,
                  postedAgo ? `posted ${postedAgo}` : undefined,
                  `${member.messageCount} ${member.messageCount === 1 ? 'post' : 'posts'}`,
                  isSelectedFilter ? '(click to clear filter)' : '(click to filter posts)',
                ]
                  .filter(Boolean)
                  .join(' · ');

                return (
                  <row
                    key={memberKey}
                    role={
                      isSelectedFilter
                        ? 'oma.swarm.roster.card.selected'
                        : 'oma.swarm.roster.card'
                    }
                    gap="sm"
                    align="center"
                    title={cardTitle}
                    aria={`${member.name}, ${member.status}`}
                    actions={{ click: `swarm.filter=${member.name}` }}
                    onClick={() => callbacks.onToggleAgentFilter(member.name)}
                  >
                    {beeBlobId ? (
                      <image
                        key="bee"
                        role="oma.swarm.card.bee"
                        blob={beeBlobId}
                        w={BEE_CARD_SIZE}
                        h={BEE_CARD_SIZE}
                        alt={isWorking ? 'Working bee' : 'Waiting bee'}
                      />
                    ) : (
                      <icon
                        key="icon"
                        name={isCoordinator ? 'compass' : 'agent'}
                        tone={memberStatusTone(member.status)}
                      />
                    )}
                    <col key="info" gap="none">
                      <row key="name-row" gap="xs" align="center">
                        <text
                          key="name"
                          role={`oma.swarm.name.${paletteId}`}
                          text={member.name}
                          wrap="none"
                          truncate="end"
                        />
                        {isCoordinator ? (
                          <text
                            key="crown"
                            spans={[{ t: '👑', s: 'warning' }]}
                            wrap="none"
                          />
                        ) : null}
                      </row>
                      <text key="status" spans={statusSpans} wrap="none" />
                      <text
                        key="model"
                        spans={[{ t: formatModelLine(member.model), s: 'dim' }]}
                        wrap="none"
                        truncate="end"
                      />
                    </col>
                  </row>
                );
              })}
            </row>
          ) : (
            <text
              key="no-active"
              spans={[{ t: 'No active swarm members', s: 'muted' }]}
            />
          )}

          {retiredMembers.length > 0 ? (
            <text
              key="retired"
              role="oma.swarm.retired"
              spans={[
                { t: `Retired (${retiredMembers.length}): `, s: 'muted' },
                { t: retiredText, s: 'dim' },
              ]}
              wrap="none"
              truncate="end"
              title={`Retired (${retiredMembers.length}): ${retiredNames.join(', ')}`}
            />
          ) : null}
        </col>

        <rule key="sep" />

        {/* -----------------------------------------------------------------
            2. Bottom Split: Left Posts List (52%) + Right Post Detail (48%)
            ----------------------------------------------------------------- */}
        <split
          key="split"
          role="oma.swarm.split"
          dir="row"
          sizes={[0.52, 0.48]}
          variant="hairline"
          grow={1}
        >
          <col key="posts-pane" role="oma.swarm.posts" gap="xs" grow={1}>
            <row key="posts-head" justify="between" align="center" gap="sm">
              <row key="title-wrap" gap="xs" align="center">
                <text
                  key="title"
                  spans={[
                    { t: 'Posts', s: 'strong' },
                    { t: ` · ${postsCountLabel}`, s: 'muted' },
                  ]}
                  wrap="none"
                />
                {query.trim().length > 0 ? (
                  <badge
                    key="q"
                    text={`/${query.trim()}`}
                    tone="accent"
                    title="Press Backspace to edit search query"
                    actions={callbacks.onClearQuery ? { click: 'swarm.query.clear' } : undefined}
                    onClick={callbacks.onClearQuery ? () => callbacks.onClearQuery?.() : undefined}
                  />
                ) : null}
              </row>
              <text
                key="nav"
                spans={[{ t: '↑/↓ select · type to search', s: 'dim' }]}
                wrap="none"
              />
            </row>

            <list
              key="posts"
              selected={selectedListNodeId}
              empty={
                query.trim().length > 0
                  ? 'No posts matching search query'
                  : filterAgent
                    ? `No posts from ${filterAgent} yet`
                    : 'Waiting for posts on board.jsonl…'
              }
              actions={{ click: 'select', dblclick: 'activate' }}
              onSelect={ev => handlePickPost(ev.item)}
              onActivate={ev => handlePickPost(ev.item)}
              onAction={{
                select: ev =>
                  handlePickPost(
                    typeof ev.item === 'string'
                      ? ev.item
                      : typeof ev.value === 'string'
                        ? ev.value
                        : undefined
                  ),
                activate: ev =>
                  handlePickPost(
                    typeof ev.item === 'string'
                      ? ev.item
                      : typeof ev.value === 'string'
                        ? ev.value
                        : undefined
                  ),
              }}
            >
              {keyedPosts.map(({ msg, key: postKey }) => {
                const sender = snapshot.memberByName[msg.agent];
                const isSystemPost = !sender && isSystemSwarmAgent(msg.agent);
                const tone: Tone = sender
                  ? memberStatusTone(sender.status)
                  : isSystemPost
                    ? 'info'
                    : 'muted';
                const labelSpans: SpanData[] = [
                  { t: `#${msg.seq}`, s: 'mono dim' },
                  { t: ` ${msg.agent}`, s: 'strong' },
                ];
                for (const b of msg.badges.slice(0, 2)) {
                  const badgeStyle =
                    b.tone === 'success'
                      ? 'success'
                      : b.tone === 'warning'
                        ? 'warning'
                        : b.tone === 'danger'
                          ? 'error'
                          : 'accent';
                  labelSpans.push({ t: ` [${b.label}]`, s: badgeStyle });
                }
                if (msg.kind === 'brief' && !msg.badges.some(b => b.tag === 'brief')) {
                  labelSpans.push({ t: ' [brief]', s: 'info' });
                }

                const clock = formatPostClock(msg.time);
                return (
                  <item
                    key={postKey}
                    label={labelSpans}
                    detail={msg.summary || '(empty message)'}
                    value={clock ? [{ t: clock, s: 'mono muted' }] : undefined}
                    icon={
                      isSystemPost
                        ? 'bell'
                        : sender?.role === 'coordinator'
                          ? 'compass'
                          : 'message'
                    }
                    tone={tone}
                  />
                );
              })}
            </list>
          </col>

          <col key="detail-pane" role="oma.swarm.detail" gap="sm" grow={1}>
            {selectedPost ? (
              <col key={`detail-${selectedPost.seq}`} role="oma.swarm.detail.inner" gap="sm" grow={1}>
                <row key="head" justify="between" align="center" gap="sm">
                  <row key="who" gap="xs" align="center">
                    {selectedSenderBee ? (
                      <image
                        key="bee"
                        role="oma.swarm.card.bee"
                        blob={selectedSenderBee}
                        w={20}
                        h={20}
                        alt={selectedPost.agent}
                      />
                    ) : (
                      <icon
                        key="icon"
                        name={selectedIsSystem ? 'bell' : 'message'}
                        tone={selectedIsSystem ? 'info' : 'accent'}
                      />
                    )}
                    <text
                      key="seq"
                      spans={[{ t: `#${selectedPost.seq} · `, s: 'mono dim' }]}
                      wrap="none"
                    />
                    <text
                      key="agent"
                      role={`oma.swarm.name.${selectedSenderPalette}`}
                      text={selectedPost.agent}
                      wrap="none"
                    />
                    {selectedSender?.role === 'coordinator' ? (
                      <text key="crown" spans={[{ t: '👑', s: 'warning' }]} wrap="none" />
                    ) : null}
                  </row>
                  <text
                    key="time"
                    spans={[{ t: selectedPost.time || '-', s: 'mono muted' }]}
                    wrap="none"
                  />
                </row>

                <row key="meta-row" gap="xs" wrap align="center">
                  {selectedSender ? (
                    <badge
                      key="status"
                      text={selectedSender.status}
                      tone={memberStatusTone(selectedSender.status)}
                    />
                  ) : selectedIsSystem ? (
                    <badge key="system" text="system" tone="info" />
                  ) : null}
                  {selectedSender?.model ? (
                    <badge key="model" text={selectedSender.model} tone="muted" />
                  ) : null}
                  {selectedPost.kind ? (
                    <badge key="kind" text={selectedPost.kind} tone="info" />
                  ) : null}
                  {selectedPost.badges.map((b, i) => (
                    <badge
                      key={`b-${b.tag}-${i}`}
                      text={b.label}
                      tone={mapBadgeTone(b.tone)}
                    />
                  ))}
                  {selectedPost.mentions.length > 0 ? (
                    <text
                      key="mentions"
                      spans={[
                        {
                          t: `→ ${selectedPost.mentions.map(m => `@${m}`).join(' ')}`,
                          s: 'dim',
                        },
                      ]}
                      wrap="none"
                    />
                  ) : null}
                </row>

                <rule key="detail-sep" />

                <scroll
                  key={`scroll-${selectedPost.seq}`}
                  role="oma.swarm.detail.scroll"
                  bar="auto"
                  grow={1}
                >
                  <md key="body" text={selectedPost.text} />
                </scroll>
              </col>
            ) : (
              <empty
                key="no-post"
                variant="center"
                icon="message"
                title="No post selected"
                text="Select a post on the left to inspect its full Markdown content."
              />
            )}
          </col>
        </split>
      </col>
    </overlay>
  );
}
