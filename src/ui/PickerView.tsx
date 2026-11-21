import path from 'node:path';
import type {
  IconName,
  JSX,
  Json,
  PickerAction,
  PickerColumn,
  PickerGroup,
  PickerItem,
  PickerLevel,
  PickerScope,
  SpanData,
  TableRow,
  Tone,
} from '@stencil-hq/tern';
import { sameDir } from '../acp/path';
import { fuzzyMatchText, type SlashCommandDef } from '../commands/registry';
import {
  inferModelProvider,
  MODEL_PROVIDER_META,
  type AgentItem,
  type AppState,
  type McpServerItem,
  type ModelProviderId,
  type PickerModalState,
  type PluginItem,
  type ResumeSessionEntry,
  type SkillItem,
} from '../state/store';
import type { TrafficEntry } from '../state/traffic';
import type {
  SwarmBoardMessage,
  SwarmBoardSnapshot,
  SwarmMember,
  SwarmMemberStatus,
  SwarmMessageBadgeTone,
} from '../swarm/board';

export interface PickerCallbacks {
  readonly onSelect: (itemId: string) => void;
  readonly onActivate: (itemId: string) => void;
  readonly onScopeChange: (scope: string) => void;
  readonly onClose: () => void;
  readonly onClearQuery: () => void;
  readonly onExportLog: () => void;
  readonly onClearLog: () => void;
  readonly onRefreshSwarm: () => void;
  readonly onToggleSwarmFollow: () => void;
  readonly onCloseHelp: () => void;
  /** Inline thinking effort slider change inside the compact model picker. */
  readonly onLevelChange?: (level: string) => void;
  /** Toggle an MCP server enabled/disabled inside `/mcp`. */
  readonly onToggleMcp?: (serverName: string) => void;
  readonly onRefreshMcp?: () => void;
  /** Toggle a plugin enabled/disabled inside `/plugins`. */
  readonly onTogglePlugin?: (pluginName: string) => void;
  readonly onRefreshPlugins?: () => void;
  readonly onRefreshSkills?: () => void;
  readonly onRefreshAgents?: () => void;
}

export interface ComputedPickerData {
  readonly title?: string;
  readonly subtitle?: string;
  readonly icon: IconName;
  readonly size: 'md' | 'lg';
  readonly layout: 'rows' | 'cards';
  readonly preview: 'side' | 'none';
  readonly anchor?: 'composer';
  readonly search?: 'head' | 'list';
  readonly density?: 'snug';
  readonly scopeStyle?: 'list' | 'rail';
  readonly level?: PickerLevel | null;
  readonly noun: string;
  readonly placeholder: string;
  readonly columns?: readonly PickerColumn[];
  readonly items: readonly PickerItem[];
  readonly order?: readonly (string | PickerGroup)[];
  readonly visibleIds: readonly string[];
  readonly selectedId: string | undefined;
  readonly current?: readonly string[];
  readonly hits?: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  readonly scopes?: readonly PickerScope[];
  readonly actions: readonly PickerAction[];
  readonly empty: string;
  readonly selectedSession?: ResumeSessionEntry;
  readonly selectedLog?: TrafficEntry;
  readonly selectedChoice?: { readonly value: string; readonly name: string; readonly description?: string };
  readonly selectedSwarmMessage?: SwarmBoardMessage;
  readonly selectedSwarmMember?: SwarmMember;
  readonly swarmSnapshot?: SwarmBoardSnapshot | null;
  readonly selectedMcp?: McpServerItem;
  readonly selectedPlugin?: PluginItem;
  readonly selectedSkill?: SkillItem;
  readonly selectedAgent?: AgentItem;
}

const PROVIDER_ORDER: readonly ModelProviderId[] = [
  'google',
  'anthropic',
  'openai',
  'xai',
  'antigravity',
];

function basenameOfDisplayPath(displayPath: string): string {
  const cleaned = displayPath.replace(/[\\/]+$/, '');
  if (!cleaned) return displayPath;
  const winBase = path.win32.basename(cleaned);
  const posixBase = path.posix.basename(cleaned);
  return winBase.length <= posixBase.length ? winBase : posixBase;
}

function formatPathSpans(displayPath: string): readonly (string | SpanData)[] {
  const cleaned = displayPath.replace(/[\\/]+$/, '');
  if (!cleaned) return [{ t: displayPath, s: 'path' }];
  const lastSep = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  if (lastSep < 0) return [{ t: cleaned, s: 'path' }];
  const dirPart = cleaned.slice(0, lastSep + 1);
  const basePart = cleaned.slice(lastSep + 1);
  return [
    { t: dirPart, s: 'path dim' },
    { t: basePart, s: 'path' },
  ];
}

function formatPickerAge(iso: string, nowMs: number): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.max(0, Math.floor((nowMs - ts) / 1000));
  if (diffSec < 60) return 'now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 14) return `${diffDay}d`;
  const diffWeek = Math.floor(diffDay / 7);
  if (diffWeek < 8) return `${diffWeek}w`;
  return `${Math.floor(diffDay / 30)}mo`;
}

function classifyDateGroup(iso: string, nowMs: number): { id: string; label: string; rank: number } {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) {
    return { id: 'earlier', label: 'Earlier', rank: 3 };
  }
  const nowDate = new Date(nowMs);
  const startOfToday = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate()
  ).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  const startOfWeek = startOfToday - 7 * 24 * 60 * 60 * 1000;

  if (ts >= startOfToday) return { id: 'today', label: 'Today', rank: 0 };
  if (ts >= startOfYesterday) return { id: 'yesterday', label: 'Yesterday', rank: 1 };
  if (ts >= startOfWeek) return { id: 'this-week', label: 'This week', rank: 2 };
  return { id: 'earlier', label: 'Earlier', rank: 3 };
}

function formatShortTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}

function computeThoughtDepth(value: string, idx: number, total: number): number {
  const lower = value.toLowerCase();
  if (lower === 'off' || lower === 'none') return 0;
  if (lower === 'minimal') return 0.17;
  if (lower === 'low') return 0.33;
  if (lower === 'medium' || lower === 'med') return 0.55;
  if (lower === 'high') return 0.78;
  if (lower === 'xhigh' || lower === 'very_high') return 0.92;
  if (lower === 'max') return 1;
  return total <= 1 ? 1 : Number(((idx + 1) / total).toFixed(2));
}

function resolveSelectedId(
  requested: string | null,
  visibleIds: readonly string[]
): string | undefined {
  if (visibleIds.length === 0) return undefined;
  if (requested && visibleIds.includes(requested)) return requested;
  return visibleIds[0];
}

function toSafeJson(value: unknown): Json {
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    return String(value);
  }
}

export function memberStatusDot(status: SwarmMemberStatus): Tone {
  switch (status) {
    case 'working':
      return 'accent';
    case 'waiting':
      return 'success';
    case 'stopped':
      return 'warning';
    case 'killed':
      return 'muted';
  }
}

function mapSwarmBadgeTone(tone: SwarmMessageBadgeTone): Tone {
  if (tone === 'danger') return 'error';
  return tone;
}

function formatSwarmSubtitle(snapshot: SwarmBoardSnapshot): string {
  const { counts } = snapshot;
  const parts: string[] = [`${counts.activeMembers} active`];
  if (counts.stoppedMembers > 0) {
    parts.push(`${counts.stoppedMembers} stopped`);
  }
  if (counts.killedMembers > 0) {
    parts.push(`${counts.killedMembers} killed`);
  }
  parts.push(
    `${counts.totalMessages} ${counts.totalMessages === 1 ? 'message' : 'messages'}`
  );
  return parts.join(' · ');
}

function formatSwarmTimeColumn(rawTime: string, nowMs: number): string {
  const trimmed = rawTime.trim();
  if (!trimmed) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})(?::\d{2})?/.exec(trimmed);
  if (m) {
    const [, yyyy, mm, dd, hhmm] = m;
    const nowDate = new Date(nowMs);
    const sameDay =
      String(nowDate.getFullYear()) === yyyy &&
      String(nowDate.getMonth() + 1).padStart(2, '0') === mm &&
      String(nowDate.getDate()).padStart(2, '0') === dd;
    if (sameDay) {
      return hhmm!;
    }
    return `${mm}-${dd} ${hhmm}`;
  }
  return formatPickerAge(trimmed, nowMs) || trimmed;
}

function resolveAgentStatusDot(status?: string): Tone {
  const lower = status?.toLowerCase() ?? '';
  if (lower === 'running' || lower === 'working') return 'accent';
  if (lower === 'done' || lower === 'waiting' || lower === 'active' || lower === 'enabled') {
    return 'success';
  }
  if (lower === 'failed' || lower === 'error') return 'error';
  if (lower === 'stopped' || lower === 'aborted' || lower === 'warning') return 'warning';
  return 'muted';
}

/**
 * Pure computation shared by `PickerView` and `AppController` keyboard routing
 * so visual order and Up/Down/Enter/Left/Right navigation stay 100% synchronized.
 */
export function computePickerData(
  state: AppState,
  picker: PickerModalState,
  trafficEntries: readonly TrafficEntry[],
  nowMs = Date.now()
): ComputedPickerData {
  const query = picker.query.trim();

  // -------------------------------------------------------------------------
  // 1. `/resume` — `omp` clean sidebar-less session picker (Tab toggles scope)
  // -------------------------------------------------------------------------
  if (picker.kind === 'resume') {
    const allSessions = picker.sessions;
    const thisFolderSessions = allSessions.filter(s => sameDir(s.cwd, state.cwd));
    const scopedSessions =
      picker.scope === 'all-folders' ? allSessions : thisFolderSessions;

    const scored: Array<{
      session: ResumeSessionEntry;
      score: number;
      hits: readonly (readonly [number, number])[];
    }> = [];

    for (const s of scopedSessions) {
      const label = s.title || s.sessionId;
      if (!query) {
        scored.push({ session: s, score: 0, hits: [] });
        continue;
      }
      const titleMatch = fuzzyMatchText(label, query);
      const cwdMatch = fuzzyMatchText(s.displayCwd, query);
      const idMatch = fuzzyMatchText(s.sessionId, query);
      const bestScore = Math.max(
        titleMatch ? titleMatch.score + 50 : -Infinity,
        cwdMatch ? cwdMatch.score : -Infinity,
        idMatch ? idMatch.score - 20 : -Infinity
      );
      if (bestScore > -Infinity) {
        scored.push({
          session: s,
          score: bestScore,
          hits: titleMatch ? titleMatch.hits : [],
        });
      }
    }

    scored.sort((a, b) => {
      if (query && b.score !== a.score) return b.score - a.score;
      const ta = Date.parse(a.session.updatedAt) || 0;
      const tb = Date.parse(b.session.updatedAt) || 0;
      return tb - ta;
    });

    const buckets = new Map<
      string,
      { label: string; rank: number; ids: string[] }
    >();
    const items: PickerItem[] = [];
    const hitsMap: Record<string, readonly (readonly [number, number])[]> = {};
    const byId = new Map<string, ResumeSessionEntry>();

    for (const { session, hits } of scored) {
      byId.set(session.sessionId, session);
      const label = session.title || '(Untitled session)';
      const ageLabel = formatPickerAge(session.updatedAt, nowMs);
      const sizeLabel =
        session.turnCount !== undefined
          ? `${session.turnCount} ${session.turnCount === 1 ? 'turn' : 'turns'}`
          : '';
      const firstPreview = session.preview?.[0]?.text;
      const detail =
        picker.scope === 'all-folders'
          ? formatPathSpans(session.displayCwd)
          : firstPreview
            ? firstPreview.replace(/\s+/g, ' ').slice(0, 96)
            : formatPathSpans(session.displayCwd);

      const badges: Array<{ text: string; tone?: 'accent' | 'muted' }> = [];
      if (state.sessionId && session.sessionId === state.sessionId) {
        badges.push({ text: 'current', tone: 'accent' });
      }
      if (session.model) {
        badges.push({ text: session.model, tone: 'muted' });
      }

      const facts: Record<string, string> = {};
      if (ageLabel) facts['when'] = ageLabel;
      if (sizeLabel) facts['size'] = sizeLabel;

      items.push({
        id: session.sessionId,
        label,
        detail,
        icon: 'history',
        ...(Object.keys(facts).length > 0 ? { facts } : {}),
        ...(hits.length > 0 ? { hits } : {}),
        ...(badges.length > 0 ? { badges } : {}),
      });
      if (hits.length > 0) {
        hitsMap[session.sessionId] = hits;
      }

      const grp = classifyDateGroup(session.updatedAt, nowMs);
      let bucket = buckets.get(grp.id);
      if (!bucket) {
        bucket = { label: grp.label, rank: grp.rank, ids: [] };
        buckets.set(grp.id, bucket);
      }
      bucket.ids.push(session.sessionId);
    }

    const order: Array<string | PickerGroup> = [];
    const visibleIds: string[] = [];

    if (query) {
      for (const item of items) {
        order.push(item.id);
        visibleIds.push(item.id);
      }
    } else {
      const sortedBuckets = [...buckets.entries()].sort((a, b) => a[1].rank - b[1].rank);
      for (const [groupId, bucket] of sortedBuckets) {
        order.push({ group: groupId, label: bucket.label, count: bucket.ids.length });
        for (const id of bucket.ids) {
          order.push(id);
          visibleIds.push(id);
        }
      }
    }

    const selectedId = resolveSelectedId(picker.selectedId, visibleIds);
    const folderBase = basenameOfDisplayPath(state.displayCwd);

    return {
      icon: 'history',
      size: 'lg',
      layout: 'cards',
      preview: 'side',
      noun: 'sessions',
      placeholder:
        picker.scope === 'all-folders'
          ? 'Search sessions across all projects…'
          : `Search sessions in ${folderBase}…`,
      columns: [
        { id: 'when', format: 'time' },
        { id: 'size', format: 'dim' },
      ],
      items,
      order,
      visibleIds,
      selectedId,
      current: state.sessionId ? [state.sessionId] : undefined,
      hits: Object.keys(hitsMap).length > 0 ? hitsMap : undefined,
      actions: [
        { id: 'resume', label: 'Resume', keys: ['enter'], primary: true },
        {
          id: 'scope',
          label: picker.scope === 'this-folder' ? 'All projects' : 'This folder',
          keys: ['tab'],
        },
        { id: 'close', label: 'Close', keys: ['esc'], end: true },
      ],
      empty: picker.loading
        ? 'Loading sessions…'
        : picker.scope === 'this-folder'
          ? 'No sessions in this folder (press Tab for All projects)'
          : 'No matching sessions',
      selectedSession: selectedId ? byId.get(selectedId) : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // 2. `/model` — Figure 1 compact composer-anchored sheet + inline level slider
  // -------------------------------------------------------------------------
  if (picker.kind === 'model') {
    const choices = state.controls.availableModels;

    // Count models per provider for the left icon rail (`scopeStyle="rail"`)
    const providerCounts = new Map<ModelProviderId, number>();
    for (const c of choices) {
      const pid = inferModelProvider(c.value);
      providerCounts.set(pid, (providerCounts.get(pid) ?? 0) + 1);
    }

    const providerScopes: PickerScope[] = [];
    for (const pid of PROVIDER_ORDER) {
      const count = providerCounts.get(pid);
      if (!count) continue;
      const meta = MODEL_PROVIDER_META[pid];
      providerScopes.push({
        id: `provider:${pid}`,
        label: meta.label,
        mark: { text: meta.abbr, seed: pid, icon: meta.icon },
        count,
      });
    }
    const scopes: PickerScope[] =
      providerScopes.length > 0
        ? [
            { id: 'all', label: 'All', icon: 'layers', count: choices.length },
            ...providerScopes,
          ]
        : [];

    const activeProviderFilter =
      picker.scope.startsWith('provider:')
        ? (picker.scope.slice('provider:'.length) as ModelProviderId)
        : null;

    const hitsMap: Record<string, readonly (readonly [number, number])[]> = {};
    const scored: Array<{
      choice: (typeof choices)[number];
      providerId: ModelProviderId;
      score: number;
      hits: readonly (readonly [number, number])[];
    }> = [];

    for (const c of choices) {
      const providerId = inferModelProvider(c.value);
      if (activeProviderFilter && providerId !== activeProviderFilter) continue;

      if (!query) {
        scored.push({ choice: c, providerId, score: 0, hits: [] });
        continue;
      }

      const nameM = fuzzyMatchText(c.name, query);
      const valM = fuzzyMatchText(c.value, query);
      const provM = fuzzyMatchText(MODEL_PROVIDER_META[providerId].label, query);
      const best = Math.max(
        nameM ? nameM.score + 20 : -Infinity,
        valM ? valM.score : -Infinity,
        provM ? provM.score - 20 : -Infinity
      );
      if (best > -Infinity) {
        scored.push({ choice: c, providerId, score: best, hits: nameM?.hits ?? [] });
      }
    }

    if (query) {
      scored.sort((a, b) => b.score - a.score);
    }

    const items: PickerItem[] = [];
    const byId = new Map<string, (typeof choices)[number]>();
    const providerById = new Map<string, ModelProviderId>();

    for (const { choice, providerId, hits } of scored) {
      const meta = MODEL_PROVIDER_META[providerId];
      byId.set(choice.value, choice);
      providerById.set(choice.value, providerId);
      items.push({
        id: choice.value,
        label: choice.name,
        mono: true,
        mark: { text: meta.abbr, seed: providerId, icon: meta.icon },
        ...(choice.value !== choice.name ? { detail: choice.value } : {}),
        ...(hits.length > 0 ? { hits } : {}),
      });
      if (hits.length > 0) hitsMap[choice.value] = hits;
    }

    const order: Array<string | PickerGroup> = [];
    const visibleIds: string[] = [];

    if (query) {
      if (items.length > 0) {
        order.push({ group: 'rest', label: 'Matches', count: items.length });
        for (const item of items) {
          order.push(item.id);
          visibleIds.push(item.id);
        }
      }
    } else {
      const recentSet = new Set<string>();
      const recentIds: string[] = [];
      for (const recentId of state.recentModels) {
        if (byId.has(recentId) && !recentSet.has(recentId)) {
          recentSet.add(recentId);
          recentIds.push(recentId);
        }
      }

      const restIds: string[] = [];
      for (const item of items) {
        if (!recentSet.has(item.id)) {
          restIds.push(item.id);
        }
      }

      if (recentIds.length > 0) {
        order.push({ group: 'recent', label: 'Recent', count: recentIds.length });
        for (const id of recentIds) {
          order.push(id);
          visibleIds.push(id);
        }
      }
      if (restIds.length > 0) {
        order.push({ group: 'rest', label: 'All', count: restIds.length });
        for (const id of restIds) {
          order.push(id);
          visibleIds.push(id);
        }
      }
    }

    const selectedId = resolveSelectedId(
      picker.selectedId ?? state.controls.currentModelId,
      visibleIds
    );

    const activeProviderId =
      (selectedId ? providerById.get(selectedId) : undefined) ??
      (state.controls.currentModelId ? inferModelProvider(state.controls.currentModelId) : 'antigravity');
    const activeProviderLabel = MODEL_PROVIDER_META[activeProviderId].label;

    const thoughtChoices = state.controls.availableThoughtLevels;
    const supportsThought = state.controls.supportsThoughtLevel && thoughtChoices.length > 0;
    const selectedThought =
      picker.modelPickerThinking ??
      state.controls.currentThoughtLevel ??
      thoughtChoices[0]?.value;

    const level: PickerLevel = supportsThought
      ? {
          label: 'Thinking',
          icon: 'brain',
          detail: activeProviderLabel,
          steps: thoughtChoices.map(c => ({ id: c.value, label: c.name })),
          value: selectedThought,
          keys: ['left', 'right'],
        }
      : {
          label: 'Thinking',
          icon: 'brain',
          detail: activeProviderLabel,
          steps: [{ id: 'off', label: 'Off' }],
          value: 'off',
          keys: ['left', 'right'],
          disabled: 'Not supported by this model',
        };

    return {
      icon: 'cpu',
      size: 'md',
      layout: 'rows',
      preview: 'none',
      anchor: 'composer',
      search: 'list',
      density: 'snug',
      scopeStyle: 'rail',
      level,
      noun: 'models',
      placeholder: 'Search, @ for roles…',
      items,
      order,
      visibleIds,
      selectedId,
      current: state.controls.currentModelId ? [state.controls.currentModelId] : undefined,
      hits: Object.keys(hitsMap).length > 0 ? hitsMap : undefined,
      scopes: scopes.length > 0 ? scopes : undefined,
      actions: [],
      empty: 'No matching models',
      selectedChoice: selectedId ? byId.get(selectedId) : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // 3. `/thought`
  // -------------------------------------------------------------------------
  if (picker.kind === 'thought') {
    const choices = state.controls.availableThoughtLevels;
    const hitsMap: Record<string, readonly (readonly [number, number])[]> = {};
    const items: PickerItem[] = [];
    const visibleIds: string[] = [];

    for (let idx = 0; idx < choices.length; idx++) {
      const c = choices[idx]!;
      if (query) {
        const nameM = fuzzyMatchText(c.name, query);
        const valM = fuzzyMatchText(c.value, query);
        if (!nameM && !valM) continue;
        if (nameM && nameM.hits.length > 0) hitsMap[c.value] = nameM.hits;
      }
      visibleIds.push(c.value);
      items.push({
        id: c.value,
        label: c.name,
        detail: c.description || c.value,
        icon: 'brain',
        facts: { depth: computeThoughtDepth(c.value, idx, choices.length) },
        ...(hitsMap[c.value] ? { hits: hitsMap[c.value] } : {}),
      });
    }

    const selectedId = resolveSelectedId(
      picker.selectedId ?? state.controls.currentThoughtLevel,
      visibleIds
    );

    return {
      title: 'Thinking level',
      icon: 'brain',
      size: 'md',
      layout: 'rows',
      preview: 'none',
      noun: 'levels',
      placeholder: 'Filter thinking levels…',
      columns: [{ id: 'depth', format: 'bar' }],
      items,
      visibleIds,
      selectedId,
      current: state.controls.currentThoughtLevel
        ? [state.controls.currentThoughtLevel]
        : undefined,
      hits: Object.keys(hitsMap).length > 0 ? hitsMap : undefined,
      actions: [
        { id: 'select', label: 'Apply', keys: ['enter'], primary: true },
        { id: 'close', label: 'Close', keys: ['esc'], end: true },
      ],
      empty: state.controls.supportsThoughtLevel
        ? 'No matching thinking levels'
        : 'Current model does not support thought_level',
    };
  }

  // -------------------------------------------------------------------------
  // 4. `/mode`
  // -------------------------------------------------------------------------
  if (picker.kind === 'mode') {
    const choices = state.controls.availableModes;
    const hitsMap: Record<string, readonly (readonly [number, number])[]> = {};
    const items: PickerItem[] = [];
    const visibleIds: string[] = [];

    for (const c of choices) {
      if (query) {
        const nameM = fuzzyMatchText(c.name, query);
        const valM = fuzzyMatchText(c.value, query);
        if (!nameM && !valM) continue;
        if (nameM && nameM.hits.length > 0) hitsMap[c.value] = nameM.hits;
      }
      visibleIds.push(c.value);
      items.push({
        id: c.value,
        label: c.name,
        detail: c.description || c.value,
        icon: 'shield',
        ...(hitsMap[c.value] ? { hits: hitsMap[c.value] } : {}),
      });
    }

    const selectedId = resolveSelectedId(
      picker.selectedId ?? state.controls.currentModeId,
      visibleIds
    );

    return {
      title: 'Permission Mode',
      icon: 'shield',
      size: 'md',
      layout: 'rows',
      preview: 'none',
      noun: 'modes',
      placeholder: 'Filter modes…',
      items,
      visibleIds,
      selectedId,
      current: state.controls.currentModeId ? [state.controls.currentModeId] : undefined,
      hits: Object.keys(hitsMap).length > 0 ? hitsMap : undefined,
      actions: [
        { id: 'select', label: 'Apply', keys: ['enter'], primary: true },
        { id: 'close', label: 'Close', keys: ['esc'], end: true },
      ],
      empty: 'No matching permission modes',
    };
  }

  // -------------------------------------------------------------------------
  // 5. P1 Ecosystem: `/mcp`
  // -------------------------------------------------------------------------
  if (picker.kind === 'mcp') {
    const allServers = picker.mcpServers ?? [];
    const enabledCount = allServers.filter(s => s.enabled).length;
    const disabledCount = allServers.length - enabledCount;
    const activeScope = picker.scope || 'all';

    const items: PickerItem[] = [];
    const visibleIds: string[] = [];
    const hitsMap: Record<string, readonly (readonly [number, number])[]> = {};
    const byId = new Map<string, McpServerItem>();

    for (const srv of allServers) {
      if (activeScope === 'enabled' && !srv.enabled) continue;
      if (activeScope === 'disabled' && srv.enabled) continue;

      let hits: readonly (readonly [number, number])[] = [];
      if (query) {
        const nameM = fuzzyMatchText(srv.name, query);
        const detM = fuzzyMatchText(
          `${srv.transport ?? ''} ${srv.command ?? ''} ${srv.url ?? ''} ${srv.detail ?? ''}`,
          query
        );
        if (!nameM && !detM) continue;
        hits = nameM?.hits ?? [];
      }

      byId.set(srv.name, srv);
      visibleIds.push(srv.name);
      items.push({
        id: srv.name,
        label: srv.name,
        mono: true,
        dot: srv.enabled ? 'success' : 'muted',
        detail: srv.command || srv.url || srv.detail || srv.transport,
        badges: [
          ...(srv.transport ? [{ text: srv.transport, tone: 'muted' as Tone }] : []),
          { text: srv.enabled ? 'enabled' : 'disabled', tone: srv.enabled ? 'success' : 'muted' },
        ],
        ...(hits.length > 0 ? { hits } : {}),
      });
      if (hits.length > 0) hitsMap[srv.name] = hits;
    }

    const selectedId = resolveSelectedId(picker.selectedId, visibleIds);
    const selectedMcp = selectedId ? byId.get(selectedId) : undefined;

    return {
      title: 'MCP Servers',
      subtitle: `${enabledCount} enabled · ${allServers.length} total`,
      icon: 'mcp',
      size: 'lg',
      layout: 'rows',
      preview: 'side',
      noun: 'servers',
      placeholder: 'Filter MCP servers…',
      items,
      visibleIds,
      selectedId,
      hits: Object.keys(hitsMap).length > 0 ? hitsMap : undefined,
      scopes: [
        { id: 'all', label: 'All', icon: 'layers', count: allServers.length },
        { id: 'enabled', label: 'Enabled', icon: 'check', dot: 'success', count: enabledCount },
        { id: 'disabled', label: 'Disabled', icon: 'slash-circle', dot: 'muted', count: disabledCount },
      ],
      actions: [
        {
          id: 'toggle',
          label: selectedMcp?.enabled ? 'Disable' : 'Enable',
          keys: ['enter'],
          primary: true,
          disabled: selectedMcp ? undefined : 'No server selected',
        },
        { id: 'refresh', label: 'Refresh', keys: ['ctrl+r'] },
        { id: 'close', label: 'Close', keys: ['esc'], end: true },
      ],
      empty: picker.loading
        ? 'Loading MCP servers via agy mcp list…'
        : 'No MCP servers configured',
      selectedMcp,
    };
  }

  // -------------------------------------------------------------------------
  // 6. P1 Ecosystem: `/plugins`
  // -------------------------------------------------------------------------
  if (picker.kind === 'plugins') {
    const allPlugins = picker.plugins ?? [];
    const enabledCount = allPlugins.filter(p => p.enabled).length;
    const disabledCount = allPlugins.length - enabledCount;
    const activeScope = picker.scope || 'all';

    const items: PickerItem[] = [];
    const visibleIds: string[] = [];
    const hitsMap: Record<string, readonly (readonly [number, number])[]> = {};
    const byId = new Map<string, PluginItem>();

    for (const plugin of allPlugins) {
      if (activeScope === 'enabled' && !plugin.enabled) continue;
      if (activeScope === 'disabled' && plugin.enabled) continue;

      let hits: readonly (readonly [number, number])[] = [];
      if (query) {
        const nameM = fuzzyMatchText(plugin.name, query);
        const descM = fuzzyMatchText(plugin.description ?? '', query);
        if (!nameM && !descM) continue;
        hits = nameM?.hits ?? [];
      }

      byId.set(plugin.name, plugin);
      visibleIds.push(plugin.name);
      items.push({
        id: plugin.name,
        label: plugin.name,
        dot: plugin.enabled ? 'success' : 'muted',
        detail: plugin.description || plugin.source,
        badges: [
          ...(plugin.version ? [{ text: `v${plugin.version}`, tone: 'muted' as Tone }] : []),
          {
            text: plugin.enabled ? 'enabled' : 'disabled',
            tone: plugin.enabled ? 'success' : 'muted',
          },
        ],
        ...(hits.length > 0 ? { hits } : {}),
      });
      if (hits.length > 0) hitsMap[plugin.name] = hits;
    }

    const selectedId = resolveSelectedId(picker.selectedId, visibleIds);
    const selectedPlugin = selectedId ? byId.get(selectedId) : undefined;

    return {
      title: 'Plugins',
      subtitle: `${enabledCount} enabled · ${allPlugins.length} installed`,
      icon: 'package',
      size: 'lg',
      layout: 'rows',
      preview: 'side',
      noun: 'plugins',
      placeholder: 'Filter plugins…',
      items,
      visibleIds,
      selectedId,
      hits: Object.keys(hitsMap).length > 0 ? hitsMap : undefined,
      scopes: [
        { id: 'all', label: 'All', icon: 'layers', count: allPlugins.length },
        { id: 'enabled', label: 'Enabled', icon: 'check', dot: 'success', count: enabledCount },
        { id: 'disabled', label: 'Disabled', icon: 'slash-circle', dot: 'muted', count: disabledCount },
      ],
      actions: [
        {
          id: 'toggle',
          label: selectedPlugin?.enabled ? 'Disable' : 'Enable',
          keys: ['enter'],
          primary: true,
          disabled: selectedPlugin ? undefined : 'No plugin selected',
        },
        { id: 'refresh', label: 'Refresh', keys: ['ctrl+r'] },
        { id: 'close', label: 'Close', keys: ['esc'], end: true },
      ],
      empty: picker.loading
        ? 'Loading plugins via agy plugin list --json…'
        : 'No plugins installed',
      selectedPlugin,
    };
  }

  // -------------------------------------------------------------------------
  // 7. P1 Ecosystem: `/skills`
  // -------------------------------------------------------------------------
  if (picker.kind === 'skills') {
    const allSkills = picker.skills ?? [];
    const activeScope = picker.scope || 'all';
    const countSource = (src: SkillItem['source']) =>
      allSkills.filter(s => s.source === src).length;

    const items: PickerItem[] = [];
    const visibleIds: string[] = [];
    const hitsMap: Record<string, readonly (readonly [number, number])[]> = {};
    const byId = new Map<string, SkillItem>();

    for (const skill of allSkills) {
      if (activeScope !== 'all' && skill.source !== activeScope) continue;

      let hits: readonly (readonly [number, number])[] = [];
      if (query) {
        const nameM = fuzzyMatchText(skill.name, query);
        const descM = fuzzyMatchText(skill.description, query);
        if (!nameM && !descM) continue;
        hits = nameM?.hits ?? [];
      }

      byId.set(skill.name, skill);
      visibleIds.push(skill.name);
      items.push({
        id: skill.name,
        label: skill.name,
        icon: 'skill',
        detail: skill.description,
        badges: [
          {
            text: skill.source,
            tone: skill.source === 'workspace' ? 'accent' : 'muted',
          },
        ],
        ...(hits.length > 0 ? { hits } : {}),
      });
      if (hits.length > 0) hitsMap[skill.name] = hits;
    }

    const selectedId = resolveSelectedId(picker.selectedId, visibleIds);
    const selectedSkill = selectedId ? byId.get(selectedId) : undefined;

    return {
      title: 'Skills',
      subtitle: `${allSkills.length} ${allSkills.length === 1 ? 'skill' : 'skills'} available`,
      icon: 'skill',
      size: 'lg',
      layout: 'rows',
      preview: 'side',
      noun: 'skills',
      placeholder: 'Search skills…',
      items,
      visibleIds,
      selectedId,
      hits: Object.keys(hitsMap).length > 0 ? hitsMap : undefined,
      scopes: [
        { id: 'all', label: 'All', icon: 'layers', count: allSkills.length },
        { id: 'workspace', label: 'Workspace', icon: 'folder', count: countSource('workspace') },
        { id: 'user', label: 'User', icon: 'user', count: countSource('user') },
        { id: 'acp', label: 'ACP', icon: 'skill', count: countSource('acp') },
        ...(countSource('plugin') > 0
          ? [{ id: 'plugin', label: 'Plugin', icon: 'package' as IconName, count: countSource('plugin') }]
          : []),
      ],
      actions: [
        {
          id: 'select',
          label: 'Insert /skill',
          keys: ['enter'],
          primary: true,
          disabled: selectedSkill ? undefined : 'No skill selected',
        },
        { id: 'refresh', label: 'Refresh', keys: ['ctrl+r'] },
        { id: 'close', label: 'Close', keys: ['esc'], end: true },
      ],
      empty: picker.loading ? 'Scanning workspace & ACP skills…' : 'No matching skills',
      selectedSkill,
    };
  }

  // -------------------------------------------------------------------------
  // 8. P1 Ecosystem: `/agents`
  // -------------------------------------------------------------------------
  if (picker.kind === 'agents') {
    const allAgents = picker.agents ?? [];
    const activeScope = picker.scope || 'all';
    const sessionCount = allAgents.filter(a => a.kind === 'subagent' || a.kind === 'swarm').length;
    const builtinCount = allAgents.filter(a => a.kind === 'builtin').length;
    const customCount = allAgents.filter(a => a.kind === 'custom').length;

    const items: PickerItem[] = [];
    const visibleIds: string[] = [];
    const hitsMap: Record<string, readonly (readonly [number, number])[]> = {};
    const byId = new Map<string, AgentItem>();

    for (const agent of allAgents) {
      if (activeScope === 'builtin' && agent.kind !== 'builtin') continue;
      if (activeScope === 'custom' && agent.kind !== 'custom') continue;
      if (activeScope === 'session' && agent.kind !== 'subagent' && agent.kind !== 'swarm') {
        continue;
      }

      let hits: readonly (readonly [number, number])[] = [];
      if (query) {
        const nameM = fuzzyMatchText(agent.name, query);
        const descM = fuzzyMatchText(agent.description ?? '', query);
        if (!nameM && !descM) continue;
        hits = nameM?.hits ?? [];
      }

      byId.set(agent.id, agent);
      visibleIds.push(agent.id);
      items.push({
        id: agent.id,
        label: agent.name,
        icon: agent.kind === 'swarm' ? 'users' : 'agent',
        dot: agent.status ? resolveAgentStatusDot(agent.status) : undefined,
        detail: agent.description || agent.model,
        badges: [
          {
            text: agent.kind,
            tone: agent.kind === 'subagent' || agent.kind === 'swarm' ? 'accent' : 'muted',
          },
          ...(agent.status
            ? [{ text: agent.status, tone: resolveAgentStatusDot(agent.status) }]
            : []),
        ],
        ...(hits.length > 0 ? { hits } : {}),
      });
      if (hits.length > 0) hitsMap[agent.id] = hits;
    }

    const selectedId = resolveSelectedId(picker.selectedId, visibleIds);
    const selectedAgent = selectedId ? byId.get(selectedId) : undefined;

    return {
      title: 'Agents',
      subtitle: `${allAgents.length} ${allAgents.length === 1 ? 'agent' : 'agents'}`,
      icon: 'agents',
      size: 'lg',
      layout: 'rows',
      preview: 'side',
      noun: 'agents',
      placeholder: 'Filter agents…',
      items,
      visibleIds,
      selectedId,
      hits: Object.keys(hitsMap).length > 0 ? hitsMap : undefined,
      scopes: [
        { id: 'all', label: 'All', icon: 'layers', count: allAgents.length },
        { id: 'session', label: 'Session', icon: 'users', count: sessionCount },
        { id: 'custom', label: 'Custom', icon: 'agent', count: customCount },
        { id: 'builtin', label: 'Built-in', icon: 'cpu', count: builtinCount },
      ],
      actions: [
        { id: 'refresh', label: 'Refresh', keys: ['ctrl+r'] },
        { id: 'close', label: 'Close', keys: ['esc'], end: true },
      ],
      empty: picker.loading ? 'Loading agents…' : 'No agents found',
      selectedAgent,
    };
  }

  // -------------------------------------------------------------------------
  // 9. `/swarm board`
  // -------------------------------------------------------------------------
  if (picker.kind === 'swarm') {
    const snapshot = picker.swarmSnapshot;
    const followOn = picker.swarmFollow !== false;
    const actions: PickerAction[] = [
      { id: 'refresh', label: 'Refresh', keys: ['ctrl+r'] },
      { id: 'follow', label: 'Follow', on: followOn },
      { id: 'close', label: 'Close', keys: ['esc'], end: true },
    ];

    if (!snapshot) {
      return {
        title: 'Swarm Board',
        subtitle: picker.loading ? 'Loading swarm board…' : 'No active swarm',
        icon: 'users',
        size: 'lg',
        layout: 'cards',
        preview: 'side',
        noun: 'messages',
        placeholder: 'Search agent, #seq, or message…',
        columns: [{ id: 'when', format: 'time', min: 6 }],
        items: [],
        visibleIds: [],
        selectedId: undefined,
        actions,
        empty: picker.loading
          ? 'Loading swarm board…'
          : 'No active swarm in this session. Run /swarm <task> to start one.',
        swarmSnapshot: snapshot ?? null,
      };
    }

    const scopes: PickerScope[] = [
      {
        id: 'all',
        label: 'All messages',
        icon: 'users',
        count: snapshot.counts.totalMessages,
      },
    ];
    const seenScope = new Set<string>(['all']);
    for (const member of snapshot.members) {
      if (seenScope.has(member.name)) continue;
      seenScope.add(member.name);
      scopes.push({
        id: member.name,
        label: member.name,
        icon: member.role === 'coordinator' ? 'compass' : 'agent',
        dot: memberStatusDot(member.status),
        count: member.messageCount,
      });
    }
    for (const agentName of Object.keys(snapshot.messageCounts).sort((a, b) =>
      a.localeCompare(b)
    )) {
      if (seenScope.has(agentName)) continue;
      seenScope.add(agentName);
      scopes.push({
        id: agentName,
        label: agentName,
        icon: 'user',
        dot: 'muted',
        count: snapshot.messageCounts[agentName] ?? 0,
      });
    }

    const activeScope = seenScope.has(picker.scope) ? picker.scope : 'all';
    const newestFirst = [...snapshot.messages].reverse();
    const scopedMessages =
      activeScope === 'all'
        ? newestFirst
        : newestFirst.filter(msg => msg.agent === activeScope);

    const scored: Array<{
      msg: SwarmBoardMessage;
      label: string;
      score: number;
      hits: readonly (readonly [number, number])[];
    }> = [];

    const queryLower = query.toLowerCase();
    for (const msg of scopedMessages) {
      const label = `#${msg.seq} ${msg.agent}`;
      if (!query) {
        scored.push({ msg, label, score: 0, hits: [] });
        continue;
      }

      const seqStr = String(msg.seq);
      const seqExact = queryLower === seqStr || queryLower === `#${seqStr}`;
      const labelMatch = fuzzyMatchText(label, query);
      const agentMatch = fuzzyMatchText(msg.agent, query);
      const bodyIdx = msg.text.toLowerCase().indexOf(queryLower);
      const summaryMatch = bodyIdx < 0 ? fuzzyMatchText(msg.summary, query) : null;

      let bestScore = -Infinity;
      if (seqExact) bestScore = Math.max(bestScore, 1500);
      if (labelMatch) bestScore = Math.max(bestScore, labelMatch.score + 200);
      if (agentMatch) bestScore = Math.max(bestScore, agentMatch.score + 150);
      if (bodyIdx >= 0) bestScore = Math.max(bestScore, 400 - Math.min(200, bodyIdx));
      if (summaryMatch) bestScore = Math.max(bestScore, summaryMatch.score);

      if (bestScore > -Infinity) {
        scored.push({
          msg,
          label,
          score: bestScore,
          hits: labelMatch ? labelMatch.hits : [],
        });
      }
    }

    if (query) {
      scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.msg.seq - a.msg.seq;
      });
    }

    const items: PickerItem[] = [];
    const visibleIds: string[] = [];
    const hitsMap: Record<string, readonly (readonly [number, number])[]> = {};
    const msgById = new Map<string, SwarmBoardMessage>();
    const seenIds = new Set<string>();
    let maxWhenLen = 0;

    for (let idx = 0; idx < scored.length; idx++) {
      const { msg, label, hits } = scored[idx]!;
      let id = String(msg.seq);
      if (seenIds.has(id)) {
        id = `${msg.seq}-${idx}`;
      }
      seenIds.add(id);
      msgById.set(id, msg);
      visibleIds.push(id);

      const member = snapshot.memberByName[msg.agent];
      const dot: Tone = member ? memberStatusDot(member.status) : 'muted';
      const whenLabel = formatSwarmTimeColumn(msg.time, nowMs);
      const facts: Record<string, string> = {};
      if (whenLabel) {
        facts['when'] = whenLabel;
        if (whenLabel.length > maxWhenLen) {
          maxWhenLen = whenLabel.length;
        }
      }

      const badges: Array<{ text: string; tone?: Tone }> = msg.badges.map(b => ({
        text: b.label,
        tone: mapSwarmBadgeTone(b.tone),
      }));
      if (msg.kind === 'brief' && !badges.some(b => b.text === 'brief')) {
        badges.push({ text: 'brief', tone: 'info' });
      }

      items.push({
        id,
        label,
        detail: msg.summary || '(empty message)',
        dot,
        ...(Object.keys(facts).length > 0 ? { facts } : {}),
        ...(badges.length > 0 ? { badges } : {}),
        ...(hits.length > 0 ? { hits } : {}),
      });
      if (hits.length > 0) {
        hitsMap[id] = hits;
      }
    }

    const selectedId = resolveSelectedId(picker.selectedId, visibleIds);
    const selectedSwarmMessage = selectedId ? msgById.get(selectedId) : undefined;
    const selectedSwarmMember = selectedSwarmMessage
      ? snapshot.memberByName[selectedSwarmMessage.agent]
      : activeScope !== 'all'
        ? snapshot.memberByName[activeScope]
        : undefined;

    return {
      title: snapshot.title || 'Swarm Board',
      subtitle: formatSwarmSubtitle(snapshot),
      icon: 'users',
      size: 'lg',
      layout: 'cards',
      preview: 'side',
      noun: 'messages',
      placeholder:
        activeScope === 'all'
          ? 'Search agent, #seq, or message…'
          : `Filter messages from ${activeScope}…`,
      columns: [{ id: 'when', format: 'time', min: Math.max(6, maxWhenLen + 1) }],
      items,
      visibleIds,
      selectedId,
      hits: Object.keys(hitsMap).length > 0 ? hitsMap : undefined,
      scopes,
      actions,
      empty: query
        ? 'No matching board messages'
        : activeScope !== 'all'
          ? `No messages posted by ${activeScope} yet`
          : 'No messages on the swarm board yet',
      selectedSwarmMessage,
      selectedSwarmMember,
      swarmSnapshot: snapshot,
    };
  }

  // -------------------------------------------------------------------------
  // 10. `/log` traffic inspector
  // -------------------------------------------------------------------------
  const reversed = [...trafficEntries].reverse();
  const scopeDir = picker.scope;
  const filtered = reversed.filter(entry => {
    if (scopeDir !== 'all' && entry.direction !== scopeDir) return false;
    if (!query) return true;
    const q = query.toLowerCase();
    return (
      entry.summary.toLowerCase().includes(q) ||
      (entry.method ?? '').toLowerCase().includes(q) ||
      entry.direction.toLowerCase().includes(q)
    );
  });

  const items: PickerItem[] = [];
  const visibleIds: string[] = [];
  const byId = new Map<string, TrafficEntry>();

  for (const entry of filtered.slice(0, 200)) {
    const id = String(entry.seq);
    byId.set(id, entry);
    visibleIds.push(id);
    const tone =
      entry.direction === 'tern-error' || entry.direction === 'stderr'
        ? 'error'
        : entry.direction === 'out'
          ? 'info'
          : 'neutral';
    items.push({
      id,
      label: entry.summary,
      detail: `${entry.timestamp} · #${entry.seq}`,
      dot: tone,
      mono: true,
      badges: [{ text: entry.direction, tone }],
    });
  }

  const countDir = (dir: string) =>
    dir === 'all'
      ? trafficEntries.length
      : trafficEntries.filter(e => e.direction === dir).length;

  const selectedId = resolveSelectedId(picker.selectedId, visibleIds);

  return {
    title: 'ACP & Tern Traffic Log',
    icon: 'terminal',
    size: 'lg',
    layout: 'rows',
    preview: 'side',
    noun: 'events',
    placeholder: 'Filter traffic…',
    items,
    visibleIds,
    selectedId,
    scopes: [
      { id: 'all', label: 'All', icon: 'terminal', count: countDir('all') },
      { id: 'out', label: 'C→S', icon: 'arrow-up', count: countDir('out') },
      { id: 'in', label: 'S→C', icon: 'arrow-down', count: countDir('in') },
      { id: 'stderr', label: 'stderr', icon: 'warn', count: countDir('stderr') },
      { id: 'tern-error', label: 'Tern Err', icon: 'x-circle', count: countDir('tern-error') },
    ],
    actions: [
      { id: 'export', label: 'Export JSONL', primary: true },
      { id: 'clear-log', label: 'Clear', danger: true },
      { id: 'close', label: 'Close', keys: ['esc'], end: true },
    ],
    empty: 'No traffic entries recorded',
    selectedLog: selectedId ? byId.get(selectedId) : undefined,
  };
}

function renderPickerPreview(
  picker: PickerModalState,
  data: ComputedPickerData
): JSX.Element | null {
  if (data.preview === 'none') return null;

  if (picker.kind === 'resume') {
    const s = data.selectedSession;
    if (!s) {
      return (
        <empty
          key="empty-pv"
          variant="center"
          icon="history"
          title="No session selected"
          text="Select a session from the list to inspect its metadata and recent turns."
        />
      );
    }

    const metaItems = [
      { k: [{ t: 'Folder', s: 'muted' as const }], v: formatPathSpans(s.displayCwd || '-') },
      { k: [{ t: 'Modified', s: 'muted' as const }], v: formatShortTime(s.updatedAt) || '-' },
      ...(s.model ? [{ k: [{ t: 'Model', s: 'muted' as const }], v: s.model }] : []),
      ...(s.thoughtLevel
        ? [{ k: [{ t: 'Thinking', s: 'muted' as const }], v: s.thoughtLevel }]
        : []),
      ...(s.turnCount !== undefined
        ? [{ k: [{ t: 'Turns', s: 'muted' as const }], v: String(s.turnCount) }]
        : []),
      {
        k: [{ t: 'Session', s: 'muted' as const }],
        v: [{ t: s.sessionId, s: 'mono dim' as const }],
      },
    ];

    return (
      <col key="preview" gap="sm">
        <text
          key="title"
          text={s.title || '(Untitled session)'}
          role="omp.picker.title"
        />
        <kv key="meta" layout="grid" items={metaItems} />
        <section key="conv" head="Conversation">
          {s.preview && s.preview.length > 0 ? (
            <col key="turns" gap="xs">
              {s.preview.slice(-6).map((msg, idx) => (
                <md
                  key={`turn-${idx}`}
                  tone={msg.role === 'user' ? 'user' : undefined}
                  text={msg.text}
                />
              ))}
            </col>
          ) : (
            <text
              key="hint"
              spans={[
                {
                  t: 'Press Enter to load full history and generate a local preview cache.',
                  s: 'muted',
                },
              ]}
            />
          )}
        </section>
      </col>
    );
  }

  if (picker.kind === 'mcp') {
    const srv = data.selectedMcp;
    if (!srv) {
      return (
        <empty
          key="mcp-empty-pv"
          variant="center"
          icon="mcp"
          title="No MCP server selected"
          text="Select a server to inspect its transport and toggle enabled status."
        />
      );
    }

    return (
      <col key="mcp-pv" gap="sm">
        <text key="title" text={srv.name} role="omp.picker.title" />
        <kv
          key="meta"
          layout="grid"
          items={[
            {
              k: [{ t: 'Status', s: 'muted' }],
              v: [
                {
                  t: srv.enabled ? 'Enabled' : 'Disabled',
                  s: srv.enabled ? 'success' : 'muted',
                },
              ],
            },
            ...(srv.transport
              ? [{ k: [{ t: 'Transport', s: 'muted' as const }], v: srv.transport }]
              : []),
            ...(srv.command
              ? [{ k: [{ t: 'Command', s: 'muted' as const }], v: [{ t: srv.command, s: 'mono' as const }] }]
              : []),
            ...(srv.url
              ? [{ k: [{ t: 'URL', s: 'muted' as const }], v: [{ t: srv.url, s: 'mono' as const }] }]
              : []),
            ...(srv.status
              ? [{ k: [{ t: 'State', s: 'muted' as const }], v: srv.status }]
              : []),
          ]}
        />
        {srv.detail ? (
          <section key="detail" head="Details">
            <text key="txt" text={srv.detail} wrap="word" />
          </section>
        ) : null}
        <text
          key="note"
          wrap="word"
          spans={[
            {
              t: 'Press Enter to toggle this MCP server via agy mcp. Start a new session or reconnect for changes to take effect.',
              s: 'muted',
            },
          ]}
        />
      </col>
    );
  }

  if (picker.kind === 'plugins') {
    const plugin = data.selectedPlugin;
    if (!plugin) {
      return (
        <empty
          key="plugins-empty-pv"
          variant="center"
          icon="package"
          title="No plugin selected"
          text="Select a plugin to inspect its version, description, and status."
        />
      );
    }

    return (
      <col key="plugins-pv" gap="sm">
        <text key="title" text={plugin.name} role="omp.picker.title" />
        <kv
          key="meta"
          layout="grid"
          items={[
            {
              k: [{ t: 'Status', s: 'muted' }],
              v: [
                {
                  t: plugin.enabled ? 'Enabled' : 'Disabled',
                  s: plugin.enabled ? 'success' : 'muted',
                },
              ],
            },
            ...(plugin.version
              ? [{ k: [{ t: 'Version', s: 'muted' as const }], v: [{ t: `v${plugin.version}`, s: 'mono' as const }] }]
              : []),
            ...(plugin.source
              ? [{ k: [{ t: 'Source', s: 'muted' as const }], v: plugin.source }]
              : []),
            ...(plugin.path
              ? [{ k: [{ t: 'Path', s: 'muted' as const }], v: formatPathSpans(plugin.path) }]
              : []),
          ]}
        />
        {plugin.description ? (
          <section key="desc" head="Description">
            <md key="md" text={plugin.description} />
          </section>
        ) : null}
      </col>
    );
  }

  if (picker.kind === 'skills') {
    const skill = data.selectedSkill;
    if (!skill) {
      return (
        <empty
          key="skills-empty-pv"
          variant="center"
          icon="skill"
          title="No skill selected"
          text="Select a skill to preview its SKILL.md instructions."
        />
      );
    }

    return (
      <col key="skills-pv" gap="sm">
        <text key="title" text={`/${skill.name}`} role="omp.picker.title" />
        <kv
          key="meta"
          layout="grid"
          items={[
            { k: [{ t: 'Source', s: 'muted' }], v: skill.source },
            ...(skill.path
              ? [{ k: [{ t: 'Path', s: 'muted' as const }], v: formatPathSpans(skill.path) }]
              : []),
          ]}
        />
        <section key="skill-doc" head={skill.content ? 'SKILL.md' : 'Description'}>
          <md key="md" text={skill.content || skill.description} />
        </section>
      </col>
    );
  }

  if (picker.kind === 'agents') {
    const agent = data.selectedAgent;
    if (!agent) {
      return (
        <empty
          key="agents-empty-pv"
          variant="center"
          icon="agents"
          title="No agent selected"
          text="Select an agent or session subagent to inspect its details."
        />
      );
    }

    return (
      <col key="agents-pv" gap="sm">
        <text key="title" text={agent.name} role="omp.picker.title" />
        <kv
          key="meta"
          layout="grid"
          items={[
            { k: [{ t: 'Kind', s: 'muted' }], v: agent.kind },
            ...(agent.status
              ? [
                  {
                    k: [{ t: 'Status', s: 'muted' as const }],
                    v: [{ t: agent.status, s: resolveAgentStatusDot(agent.status) }],
                  },
                ]
              : []),
            ...(agent.model
              ? [{ k: [{ t: 'Model', s: 'muted' as const }], v: [{ t: agent.model, s: 'mono' as const }] }]
              : []),
            ...(agent.path
              ? [{ k: [{ t: 'Path', s: 'muted' as const }], v: formatPathSpans(agent.path) }]
              : []),
          ]}
        />
        {agent.description ? (
          <section key="desc" head="Description">
            <md key="md" text={agent.description} />
          </section>
        ) : null}
        <text
          key="hint"
          wrap="word"
          spans={[
            {
              t: 'Runtime main-agent switching is not supported over ACP. Launch with ',
              s: 'muted',
            },
            { t: 'agy --agent <name>', s: 'code' },
            { t: ' for a custom main agent.', s: 'muted' },
          ]}
        />
      </col>
    );
  }

  if (picker.kind === 'log') {
    const entry = data.selectedLog;
    if (!entry) {
      return (
        <empty
          key="empty-log"
          variant="center"
          icon="terminal"
          title="No log entry selected"
        />
      );
    }

    return (
      <col key="log-pv" gap="sm">
        <text key="title" text={entry.summary} role="omp.picker.title" />
        <kv
          key="meta"
          layout="grid"
          items={[
            { k: [{ t: 'Seq', s: 'muted' }], v: `#${entry.seq}` },
            { k: [{ t: 'Direction', s: 'muted' }], v: entry.direction },
            { k: [{ t: 'Time', s: 'muted' }], v: entry.timestamp },
            ...(entry.method ? [{ k: [{ t: 'Method', s: 'muted' }], v: entry.method }] : []),
            ...(entry.rpcId !== undefined
              ? [{ k: [{ t: 'RPC ID', s: 'muted' }], v: String(entry.rpcId) }]
              : []),
          ]}
        />
        <section key="payload" head="Sanitized Payload">
          {entry.payload !== undefined ? (
            typeof entry.payload === 'string' ? (
              <code key="payload-str" text={entry.payload} />
            ) : (
              <json key="payload-json" value={toSafeJson(entry.payload)} open={2} />
            )
          ) : (
            <text key="payload-empty" spans={[{ t: '(no payload)', s: 'muted' }]} />
          )}
        </section>
      </col>
    );
  }

  if (picker.kind === 'swarm') {
    const snapshot = data.swarmSnapshot;
    if (!snapshot) {
      return (
        <empty
          key="swarm-empty-pv"
          variant="center"
          icon="users"
          title={picker.loading ? 'Loading swarm board…' : 'No active swarm'}
          text={
            picker.loading
              ? 'Reading swarm.json, members.json, and board.jsonl…'
              : 'No active swarm in this session. Run /swarm <task> to start one.'
          }
        />
      );
    }

    const msg = data.selectedSwarmMessage;
    if (msg) {
      const member = snapshot.memberByName[msg.agent];
      const statusTone = member ? memberStatusDot(member.status) : 'muted';
      const metaItems = [
        {
          k: [{ t: 'Agent', s: 'muted' as const }],
          v: member?.role === 'coordinator'
            ? [
                { t: msg.agent, s: 'strong' as const },
                { t: ' · coordinator', s: 'dim' as const },
              ]
            : [{ t: msg.agent, s: 'strong' as const }],
        },
        ...(member
          ? [
              {
                k: [{ t: 'Status', s: 'muted' as const }],
                v: [{ t: member.status, s: statusTone }],
              },
            ]
          : []),
        ...(member?.model
          ? [
              {
                k: [{ t: 'Model', s: 'muted' as const }],
                v: [{ t: member.model, s: 'mono' as const }],
              },
            ]
          : []),
        {
          k: [{ t: 'Seq', s: 'muted' as const }],
          v: [{ t: `#${msg.seq}`, s: 'mono' as const }],
        },
        {
          k: [{ t: 'Time', s: 'muted' as const }],
          v: msg.time || '-',
        },
        ...(msg.kind
          ? [{ k: [{ t: 'Kind', s: 'muted' as const }], v: msg.kind }]
          : []),
        ...(msg.mentions.length > 0
          ? [
              {
                k: [{ t: 'Mentions', s: 'muted' as const }],
                v: msg.mentions.map(m => `@${m}`).join(', '),
              },
            ]
          : []),
      ];

      return (
        <col key="swarm-preview" gap="sm">
          <text
            key="title"
            text={`#${msg.seq} · ${msg.agent}`}
            role="omp.picker.title"
          />
          <kv key="meta" layout="grid" items={metaItems} />
          <section key="message" head="Message">
            <md key="body" text={msg.text} />
          </section>
        </col>
      );
    }

    const member = data.selectedSwarmMember;
    if (member) {
      const statusTone = memberStatusDot(member.status);
      const memberMeta = [
        { k: [{ t: 'Role', s: 'muted' as const }], v: member.role },
        {
          k: [{ t: 'Status', s: 'muted' as const }],
          v: [{ t: member.status, s: statusTone }],
        },
        ...(member.model
          ? [
              {
                k: [{ t: 'Model', s: 'muted' as const }],
                v: [{ t: member.model, s: 'mono' as const }],
              },
            ]
          : []),
        ...(member.workspaceMode
          ? [{ k: [{ t: 'Workspace', s: 'muted' as const }], v: member.workspaceMode }]
          : []),
        {
          k: [{ t: 'Messages', s: 'muted' as const }],
          v: String(member.messageCount),
        },
        ...(member.lastReadSeq !== undefined
          ? [
              {
                k: [{ t: 'Last Read', s: 'muted' as const }],
                v: `#${member.lastReadSeq}`,
              },
            ]
          : []),
        ...(member.conversationId
          ? [
              {
                k: [{ t: 'Conversation', s: 'muted' as const }],
                v: [{ t: member.conversationId, s: 'mono dim' as const }],
              },
            ]
          : []),
      ];

      return (
        <col key="swarm-member-pv" gap="sm">
          <text key="title" text={member.name} role="omp.picker.title" />
          <kv key="meta" layout="grid" items={memberMeta} />
          <section key="activity" head="Activity">
            <text
              key="hint"
              spans={[
                {
                  t: 'No messages posted by this member yet.',
                  s: 'muted',
                },
              ]}
            />
          </section>
        </col>
      );
    }

    return (
      <empty
        key="swarm-no-msg"
        variant="center"
        icon="users"
        title={snapshot.title || 'Swarm Board'}
        text="Waiting for swarm messages on board.jsonl…"
      />
    );
  }

  return null;
}

export interface PickerViewProps {
  readonly state: AppState;
  readonly picker: PickerModalState;
  readonly trafficEntries: readonly TrafficEntry[];
  readonly callbacks: PickerCallbacks;
  readonly nowMs?: number;
}

/**
 * Modal `<picker>` mounted directly under `layer` root (`<col>`) — NEVER wrapped in `<overlay>`.
 * Covers `/model` (Figure 1 compact composer sheet + inline thinking slider), `/resume` (sidebar-less),
 * `/mcp`, `/plugins`, `/skills`, `/agents`, `/swarm`, `/thought`, `/mode`, and `/log`.
 */
export function PickerView(props: PickerViewProps): JSX.Element {
  const { state, picker, trafficEntries, callbacks, nowMs } = props;
  const data = computePickerData(state, picker, trafficEntries, nowMs);
  const previewNode = renderPickerPreview(picker, data);

  return (
    <picker
      key="modal"
      size={data.size}
      layout={data.layout}
      preview={data.preview}
      anchor={data.anchor}
      search={data.search}
      density={data.density}
      scopeStyle={data.scopeStyle}
      level={data.level}
      title={data.title}
      subtitle={data.subtitle}
      icon={data.icon}
      query={picker.query}
      cursor={picker.cursor}
      placeholder={data.placeholder}
      noun={data.noun}
      columns={data.columns}
      state={picker.error ? 'error' : picker.loading ? 'loading' : 'ready'}
      message={picker.error}
      empty={data.empty}
      total={data.items.length}
      items={data.items}
      order={data.order}
      selected={data.selectedId}
      current={data.current}
      hits={data.hits}
      scopes={data.scopes}
      scope={data.scopes ? picker.scope : undefined}
      actions={data.actions}
      onSelect={ev => callbacks.onSelect(ev.item)}
      onActivate={ev => callbacks.onActivate(ev.item)}
      onAction={{
        scope: ev => {
          if (typeof ev.value === 'string' && ev.value.length > 0) {
            callbacks.onScopeChange(ev.value);
          } else if (picker.kind === 'resume') {
            callbacks.onScopeChange(
              picker.scope === 'this-folder' ? 'all-folders' : 'this-folder'
            );
          }
        },
        level: ev => {
          if (typeof ev.value === 'string' && ev.value.length > 0) {
            callbacks.onLevelChange?.(ev.value);
          }
        },
        close: () => callbacks.onClose(),
        clear: () => callbacks.onClearQuery(),
        resume: () => {
          if (data.selectedId) callbacks.onActivate(data.selectedId);
        },
        select: () => {
          if (data.selectedId) callbacks.onActivate(data.selectedId);
        },
        toggle: () => {
          if (!data.selectedId) return;
          if (picker.kind === 'mcp' && callbacks.onToggleMcp) {
            callbacks.onToggleMcp(data.selectedId);
          } else if (picker.kind === 'plugins' && callbacks.onTogglePlugin) {
            callbacks.onTogglePlugin(data.selectedId);
          } else {
            callbacks.onActivate(data.selectedId);
          }
        },
        export: () => callbacks.onExportLog(),
        'clear-log': () => callbacks.onClearLog(),
        refresh: () => {
          if (picker.kind === 'swarm') callbacks.onRefreshSwarm();
          else if (picker.kind === 'mcp') callbacks.onRefreshMcp?.();
          else if (picker.kind === 'plugins') callbacks.onRefreshPlugins?.();
          else if (picker.kind === 'skills') callbacks.onRefreshSkills?.();
          else if (picker.kind === 'agents') callbacks.onRefreshAgents?.();
        },
        follow: () => callbacks.onToggleSwarmFollow(),
      }}
    >
      {previewNode}
    </picker>
  );
}

export interface HelpOverlayViewProps {
  readonly commands: readonly SlashCommandDef[];
  readonly onClose: () => void;
}

function keycapSpans(keys: readonly string[]): readonly (string | SpanData)[] {
  const spans: Array<string | SpanData> = [];
  keys.forEach((k, idx) => {
    if (idx > 0) spans.push({ t: ' / ', s: 'dim' });
    spans.push({ t: k, s: 'key' });
  });
  return spans;
}

/**
 * Concise built-in command descriptions strictly <= 28 characters to prevent
 * any table column truncation in Tern's two-column `/help` modal.
 */
const SHORT_BUILTIN_COMMAND_DESC: Readonly<Record<string, string>> = {
  settings: 'Open settings panel',
  status: 'Show session & tier status',
  resume: 'Open session picker',
  new: 'Start a new session',
  model: 'Switch model & thinking',
  thought: 'Switch thinking level',
  mode: 'Switch permission mode',
  context: 'Inspect context tokens',
  usage: 'Show tier & usage summary',
  mcp: 'Manage MCP servers',
  plugins: 'Manage installed plugins',
  skills: 'Browse & preview skills',
  agents: 'Inspect agents & subagents',
  permissions: 'Manage permission rules',
  login: 'Sign in to Antigravity',
  logout: 'Sign out of session',
  export: 'Export chat as Markdown',
  copy: 'Copy reply [n] as Markdown',
  log: 'Inspect ACP & Tern traffic',
  compact: 'Compact context via agy',
  help: 'Show shortcuts & commands',
  quit: 'Exit oma cleanly',
  board: 'Open swarm board',
  jobs: 'Inspect background jobs',
  git: 'Inspect Git diff & commit',
};

function clampHelpDesc(text: string, maxLen = 28): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen - 1).trimEnd()}…`;
}

/**
 * `/help` read-only modal dialog aligned 1:1 with `omp`'s `omp.overlay.hotkeys`
 * + `omp.hotkeys.group` / `omp.hotkeys.table` + `omp.actions` / `omp.btn`.
 */
export function HelpOverlayView(props: HelpOverlayViewProps): JSX.Element {
  const { commands, onClose } = props;

  const shortcutRows: readonly TableRow[] = [
    { id: 'send', cells: { keys: keycapSpans(['enter']), action: 'Send message / run command' } },
    {
      id: 'newline',
      cells: { keys: keycapSpans(['shift+enter', 'alt+enter']), action: 'Insert newline' },
    },
    {
      id: 'model',
      cells: { keys: keycapSpans(['alt+p']), action: 'Switch model & thinking' },
    },
    {
      id: 'mode',
      cells: { keys: keycapSpans(['shift+tab']), action: 'Cycle permission mode' },
    },
    {
      id: 'thinking',
      cells: { keys: keycapSpans(['ctrl+t']), action: 'Toggle thinking blocks' },
    },
    {
      id: 'tools',
      cells: { keys: keycapSpans(['ctrl+o']), action: 'Toggle expand all tools' },
    },
    {
      id: 'swarm',
      cells: { keys: keycapSpans(['alt+s']), action: 'Toggle swarm board' },
    },
    {
      id: 'retry',
      cells: { keys: keycapSpans(['f5']), action: 'Retry failed turn' },
    },
    {
      id: 'history',
      cells: { keys: keycapSpans(['up', 'down']), action: 'History or popup navigate' },
    },
    {
      id: 'paste',
      cells: { keys: keycapSpans(['ctrl+v']), action: 'Paste image or text' },
    },
    { id: 'undo', cells: { keys: keycapSpans(['ctrl+z']), action: 'Undo edit' } },
    {
      id: 'approve',
      cells: { keys: keycapSpans(['y', 'a', 'n']), action: 'Approve / Always / Deny' },
    },
    {
      id: 'esc',
      cells: { keys: keycapSpans(['escape']), action: 'Close overlay / cancel' },
    },
    {
      id: 'ctrlc',
      cells: { keys: keycapSpans(['ctrl+c']), action: 'Cancel / clear / exit (x2)' },
    },
  ];

  const hasBoardCmd = commands.some(cmd => cmd.name === 'board');
  const commandRows: TableRow[] = commands.map(cmd => {
    const shortDesc =
      cmd.source === 'oma'
        ? (SHORT_BUILTIN_COMMAND_DESC[cmd.name] ?? clampHelpDesc(cmd.description))
        : clampHelpDesc(cmd.description, 22);
    const actionCell =
      cmd.source === 'oma'
        ? shortDesc
        : [
            { t: shortDesc },
            { t: `\u00A0·\u00A0${cmd.source}`, s: 'dim mono' as const },
          ];
    const displayKey =
      cmd.name === 'board'
        ? '/swarm board'
        : `/${cmd.name}${cmd.argHint ? ` ${cmd.argHint}` : ''}`;
    return {
      id: `cmd-${cmd.name}`,
      cells: {
        keys: [{ t: displayKey, s: 'code' }],
        action: actionCell,
      },
    };
  });
  if (!hasBoardCmd) {
    commandRows.push({
      id: 'cmd-swarm-board',
      cells: {
        keys: [{ t: '/swarm board', s: 'code' }],
        action: 'Open swarm board',
      },
    });
  }

  return (
    <overlay
      key="help"
      anchor="center"
      size="lg"
      modal
      role="omp.overlay.hotkeys"
      head="Keyboard shortcuts"
      icon="help"
      foot={
        <row key="actions" role="omp.actions" justify="end">
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
      }
    >
      <col key="help-body" gap="md">
        <section key="keys" head="Keyboard shortcuts" role="omp.hotkeys.group">
          <table
            key="tbl"
            role="omp.hotkeys.table"
            cols={[
              { id: 'keys', head: 'Key' },
              { id: 'action', head: 'Action', grow: 1, truncate: 'end' },
            ]}
            rows={shortcutRows}
          />
        </section>
        <section key="cmds" head="Slash commands" role="omp.hotkeys.group">
          <table
            key="tbl"
            role="omp.hotkeys.table"
            cols={[
              { id: 'keys', head: 'Command' },
              { id: 'action', head: 'Description', grow: 1, truncate: 'end' },
            ]}
            rows={commandRows}
          />
        </section>
      </col>
    </overlay>
  );
}
