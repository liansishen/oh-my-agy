import type {
  IconName,
  JSX,
  PrefsOption,
  PrefsProps,
  PrefsRow,
} from '@stencil-hq/tern';
import type { SettingsPageId } from '../commands/handlers';
import {
  AGY_ARTIFACT_REVIEW_POLICY_VALUES,
  AGY_TOOL_PERMISSION_VALUES,
  DEFAULT_AGY_SAFE_SETTINGS,
} from '../config/agy_settings';
import { DEFAULT_CONFIG, type OmaConfig } from '../config/config';
import type { AppState, SettingsPanelState } from '../state/store';

export interface SettingsCallbacks {
  readonly onPageChange: (page: SettingsPageId) => void;
  readonly onChange: (rowId: string, value: unknown) => void;
  readonly onSelect: (itemId: string) => void;
  readonly onActivate: (rowId: string) => void;
  readonly onAction: (act: string, value?: unknown) => void;
  readonly onClose: () => void;
}

export interface SettingsViewProps {
  readonly state: AppState;
  readonly settings: SettingsPanelState;
  readonly config: OmaConfig;
  readonly configPath?: string;
  readonly agySettingsPath?: string;
  readonly callbacks: SettingsCallbacks;
}

export interface SettingsPageDef {
  readonly id: SettingsPageId;
  readonly label: string;
  readonly icon: IconName;
  readonly lead: string;
}

export const SETTINGS_PAGES: readonly SettingsPageDef[] = [
  {
    id: 'session',
    label: 'Session',
    icon: 'model',
    lead: 'Live ACP session controls — changes apply immediately.',
  },
  {
    id: 'interface',
    label: 'Interface',
    icon: 'appearance',
    lead: 'Transcript display, folding behavior, and terminal integration.',
  },
  {
    id: 'defaults',
    label: 'Defaults',
    icon: 'sliders',
    lead: 'Persisted startup defaults written atomically to oma config.toml.',
  },
  {
    id: 'permissions',
    label: 'Permissions',
    icon: 'shield',
    lead: 'Local oma auto-allow tools and safe agy backend safety settings.',
  },
  {
    id: 'ecosystem',
    label: 'Ecosystem',
    icon: 'plugins',
    lead: 'Extensions, account authentication, and configuration files.',
  },
];

export interface SettingsSectionData {
  readonly id: string;
  readonly title: string;
  readonly page?: string;
  readonly rows: readonly PrefsRow[];
}

export interface ComputedSettingsData {
  readonly pages: NonNullable<PrefsProps['pages']>;
  readonly page: SettingsPageId;
  readonly lead: string;
  readonly sections: readonly SettingsSectionData[];
  readonly visibleRowIds: readonly string[];
  readonly rowById: ReadonlyMap<string, PrefsRow>;
}

const COMMON_AUTO_ALLOW_TOOLS: readonly PrefsOption[] = [
  { value: 'read_file', label: 'read_file', detail: 'Read workspace files' },
  { value: 'list_dir', label: 'list_dir', detail: 'List directory entries' },
  { value: 'find_by_name', label: 'find_by_name', detail: 'Find files by name' },
  { value: 'grep_search', label: 'grep_search', detail: 'Search file contents' },
  { value: 'view_file', label: 'view_file', detail: 'View file lines' },
  { value: 'view_file_outline', label: 'view_file_outline', detail: 'Inspect file symbols' },
  { value: 'search_web', label: 'search_web', detail: 'Run read-only web search' },
];

const MODE_FALLBACK_OPTIONS: readonly PrefsOption[] = [
  { value: 'default', label: 'Default' },
  { value: 'accept-edits', label: 'Accept edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'plan', label: 'Plan' },
];

const TOOL_PERMISSION_LABELS: Readonly<Record<string, string>> = {
  'request-review': 'Request review',
  'proceed-in-sandbox': 'Proceed in sandbox',
  strict: 'Strict',
  'always-proceed': 'Always proceed',
};

const ARTIFACT_REVIEW_LABELS: Readonly<Record<string, string>> = {
  'asks-for-review': 'Ask for review',
  'always-proceed': 'Always proceed',
};

function buildPageSections(
  pageId: SettingsPageId,
  state: AppState,
  settings: SettingsPanelState,
  config: OmaConfig,
  configPath?: string,
  agySettingsPath?: string
): readonly SettingsSectionData[] {
  const { controls } = state;
  const agy = settings.agySettings;

  if (pageId === 'session') {
    const modelOptions: PrefsOption[] = controls.availableModels.map(m => ({
      value: m.value,
      label: m.name,
      ...(m.value !== m.name ? { detail: m.value } : {}),
    }));
    const thoughtOptions: PrefsOption[] = controls.availableThoughtLevels.map(t => ({
      value: t.value,
      label: t.name,
      ...(t.description ? { detail: t.description } : {}),
    }));
    const modeOptions: PrefsOption[] =
      controls.availableModes.length > 0
        ? controls.availableModes.map(m => ({
            value: m.value,
            label: m.name,
            ...(m.description ? { detail: m.description } : {}),
          }))
        : [...MODE_FALLBACK_OPTIONS];

    const rows: PrefsRow[] = [
      {
        id: 'session.model',
        label: 'Model',
        hint: 'Active model for this ACP session (Alt+P for compact switcher)',
        disabled: modelOptions.length === 0 ? 'Waiting for session models' : undefined,
        control: {
          k: 'choice',
          value: controls.currentModelId ?? '',
          options: modelOptions,
          style: 'menu',
          mono: true,
        },
      },
      {
        id: 'session.thought',
        label: 'Thinking Level',
        hint: 'Reasoning depth for models that support thought_level',
        disabled:
          !controls.supportsThoughtLevel || thoughtOptions.length === 0
            ? 'Not supported by current model'
            : undefined,
        control: {
          k: 'choice',
          value: controls.currentThoughtLevel ?? thoughtOptions[0]?.value ?? '',
          options: thoughtOptions,
          style: 'segmented',
        },
      },
      {
        id: 'session.mode',
        label: 'Permission Mode',
        hint: 'Session permission preset (Shift+Tab to cycle)',
        control: {
          k: 'choice',
          value: controls.currentModeId ?? 'default',
          options: modeOptions,
          style: 'segmented',
        },
      },
      {
        id: 'session.save_defaults',
        label: 'Save Current as Defaults',
        hint: 'Persist active model, thinking level, and mode to oma config.toml',
        control: {
          k: 'action',
          act: 'save-defaults',
          label: 'Save to config.toml',
        },
      },
    ];

    return [{ id: 'session-current', title: 'Current Session', rows }];
  }

  if (pageId === 'interface') {
    const transcriptRows: PrefsRow[] = [
      {
        id: 'ui.auto_collapse_thought',
        label: 'Auto-collapse Thinking',
        hint: 'Collapse completed thinking sections automatically',
        changed: config.ui.auto_collapse_thought !== DEFAULT_CONFIG.ui.auto_collapse_thought,
        defaultLabel: 'On',
        control: {
          k: 'switch',
          on: config.ui.auto_collapse_thought,
        },
      },
      {
        id: 'ui.tool_preview_lines',
        label: 'Tool Output Preview Lines',
        hint: 'Maximum preview lines shown before expanding tool outputs (1–200)',
        changed: config.ui.tool_preview_lines !== DEFAULT_CONFIG.ui.tool_preview_lines,
        defaultLabel: `${DEFAULT_CONFIG.ui.tool_preview_lines} lines`,
        control: {
          k: 'number',
          value: config.ui.tool_preview_lines,
          min: 1,
          max: 200,
          step: 1,
          unit: 'lines',
        },
      },
      {
        id: 'ui.show_thinking',
        label: 'Show Thinking Blocks',
        hint: 'Display reasoning blocks in transcript (Ctrl+T)',
        changed: !state.showThinking,
        defaultLabel: 'On',
        control: {
          k: 'switch',
          on: state.showThinking,
        },
      },
      {
        id: 'ui.expand_all_tools',
        label: 'Expand All Tool Outputs',
        hint: 'Keep tool calls expanded across the transcript (Ctrl+O)',
        changed: state.expandAllTools,
        defaultLabel: 'Off',
        control: {
          k: 'switch',
          on: state.expandAllTools,
        },
      },
    ];

    const terminalRows: PrefsRow[] = [
      {
        id: 'ui.osc_7501',
        label: 'Terminal Status & Notifications (OSC 7501)',
        hint: 'Emit Tern pane busy/idle/blocked status and completion badges',
        changed: config.ui.osc_7501 !== DEFAULT_CONFIG.ui.osc_7501,
        defaultLabel: 'On',
        control: {
          k: 'switch',
          on: config.ui.osc_7501,
        },
      },
      {
        id: 'ui.reopen_anchor',
        label: 'Session Reopen Anchor (OSC 1337)',
        hint: 'Allow Tern to restore this session automatically when reopening tabs',
        changed: config.ui.reopen_anchor !== DEFAULT_CONFIG.ui.reopen_anchor,
        defaultLabel: 'On',
        control: {
          k: 'switch',
          on: config.ui.reopen_anchor,
        },
      },
    ];

    return [
      { id: 'ui-transcript', title: 'Transcript & Layout', rows: transcriptRows },
      { id: 'ui-terminal', title: 'Terminal Integration', rows: terminalRows },
    ];
  }

  if (pageId === 'defaults') {
    const modelOptions: PrefsOption[] = [
      { value: '', label: 'Inherit agy default' },
      ...controls.availableModels.map(m => ({
        value: m.value,
        label: m.name,
        ...(m.value !== m.name ? { detail: m.value } : {}),
      })),
    ];
    if (
      config.default_model &&
      !modelOptions.some(opt => opt.value === config.default_model)
    ) {
      modelOptions.push({ value: config.default_model, label: config.default_model });
    }

    const thoughtOptions: PrefsOption[] = [
      { value: '', label: 'Inherit agy default' },
      ...(controls.availableThoughtLevels.length > 0
        ? controls.availableThoughtLevels.map(t => ({ value: t.value, label: t.name }))
        : [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
          ]),
    ];
    if (
      config.default_thought &&
      !thoughtOptions.some(opt => opt.value === config.default_thought)
    ) {
      thoughtOptions.push({ value: config.default_thought, label: config.default_thought });
    }

    const modeOptions: PrefsOption[] = [
      { value: '', label: 'Inherit agy default' },
      ...MODE_FALLBACK_OPTIONS,
    ];

    const startupRows: PrefsRow[] = [
      {
        id: 'defaults.model',
        label: 'Default Model',
        hint: 'Applied automatically when starting a new oma session',
        changed: config.default_model !== DEFAULT_CONFIG.default_model,
        defaultLabel: 'Inherit agy default',
        control: {
          k: 'choice',
          value: config.default_model,
          options: modelOptions,
          style: 'menu',
          mono: true,
        },
      },
      {
        id: 'defaults.thought',
        label: 'Default Thinking Level',
        hint: 'Initial thought_level requested on startup',
        changed: config.default_thought !== DEFAULT_CONFIG.default_thought,
        defaultLabel: 'Inherit agy default',
        control: {
          k: 'choice',
          value: config.default_thought,
          options: thoughtOptions,
          style: 'auto',
        },
      },
      {
        id: 'defaults.mode',
        label: 'Default Permission Mode',
        hint: 'Initial permission mode requested on startup',
        changed: config.default_mode !== DEFAULT_CONFIG.default_mode,
        defaultLabel: 'Inherit agy default',
        control: {
          k: 'choice',
          value: config.default_mode,
          options: modeOptions,
          style: 'auto',
        },
      },
    ];

    const binaryRows: PrefsRow[] = [
      {
        id: 'defaults.agy_bin',
        label: 'Custom agy Binary Path',
        hint: 'Leave empty to resolve `agy` from PATH',
        warning: config.agy_bin ? 'Applies on next launch or reconnect' : undefined,
        changed: config.agy_bin !== DEFAULT_CONFIG.agy_bin,
        defaultLabel: 'PATH lookup',
        control: {
          k: 'text',
          value: config.agy_bin,
          placeholder: 'agy (from PATH)',
          mono: true,
        },
      },
    ];

    return [
      { id: 'defaults-startup', title: 'Startup Defaults', rows: startupRows },
      { id: 'defaults-binary', title: 'Binary & Process', rows: binaryRows },
    ];
  }

  if (pageId === 'permissions') {
    const toolOptionMap = new Map<string, PrefsOption>();
    for (const opt of COMMON_AUTO_ALLOW_TOOLS) {
      toolOptionMap.set(opt.value, opt);
    }
    for (const toolName of config.approval.auto_allow_tools) {
      if (!toolOptionMap.has(toolName)) {
        toolOptionMap.set(toolName, { value: toolName, label: toolName });
      }
    }

    const omaRows: PrefsRow[] = [
      {
        id: 'approval.auto_allow_tools',
        label: 'Auto-allow Tools',
        hint: 'Tools approved automatically without prompting in oma',
        changed: config.approval.auto_allow_tools.length > 0,
        defaultLabel: 'None',
        control: {
          k: 'multi',
          values: config.approval.auto_allow_tools,
          options: [...toolOptionMap.values()],
        },
      },
    ];

    const effectiveToolPerm =
      agy.toolPermission ?? DEFAULT_AGY_SAFE_SETTINGS.toolPermission;
    const effectiveSandbox =
      agy.enableTerminalSandbox ?? DEFAULT_AGY_SAFE_SETTINGS.enableTerminalSandbox;
    const effectiveNonWs =
      agy.allowNonWorkspaceAccess ?? DEFAULT_AGY_SAFE_SETTINGS.allowNonWorkspaceAccess;
    const effectiveArtifact =
      agy.artifactReviewPolicy ?? DEFAULT_AGY_SAFE_SETTINGS.artifactReviewPolicy;
    const effectiveG1 =
      agy.useG1Credits ?? DEFAULT_AGY_SAFE_SETTINGS.useG1Credits;

    const agyRows: PrefsRow[] = [
      {
        id: 'agy.toolPermission',
        label: 'Tool Permission Preset',
        hint: 'Applies to next agy acp session (safe allowlist)',
        changed: effectiveToolPerm !== DEFAULT_AGY_SAFE_SETTINGS.toolPermission,
        defaultLabel: TOOL_PERMISSION_LABELS[DEFAULT_AGY_SAFE_SETTINGS.toolPermission],
        control: {
          k: 'choice',
          value: effectiveToolPerm,
          options: AGY_TOOL_PERMISSION_VALUES.map(v => ({
            value: v,
            label: TOOL_PERMISSION_LABELS[v] ?? v,
          })),
          style: 'menu',
        },
      },
      {
        id: 'agy.enableTerminalSandbox',
        label: 'Terminal Sandbox',
        hint: 'Applies to next agy acp session (enableTerminalSandbox)',
        changed: effectiveSandbox !== DEFAULT_AGY_SAFE_SETTINGS.enableTerminalSandbox,
        defaultLabel: 'Off',
        control: {
          k: 'switch',
          on: effectiveSandbox,
        },
      },
      {
        id: 'agy.allowNonWorkspaceAccess',
        label: 'Non-Workspace File Access',
        hint: 'Applies to next agy acp session (allowNonWorkspaceAccess)',
        changed: effectiveNonWs !== DEFAULT_AGY_SAFE_SETTINGS.allowNonWorkspaceAccess,
        defaultLabel: 'Off',
        control: {
          k: 'switch',
          on: effectiveNonWs,
        },
      },
      {
        id: 'agy.artifactReviewPolicy',
        label: 'Artifact Review Policy',
        hint: 'Applies to next agy acp session (artifactReviewPolicy)',
        changed: effectiveArtifact !== DEFAULT_AGY_SAFE_SETTINGS.artifactReviewPolicy,
        defaultLabel: ARTIFACT_REVIEW_LABELS[DEFAULT_AGY_SAFE_SETTINGS.artifactReviewPolicy],
        control: {
          k: 'choice',
          value: effectiveArtifact,
          options: AGY_ARTIFACT_REVIEW_POLICY_VALUES.map(v => ({
            value: v,
            label: ARTIFACT_REVIEW_LABELS[v] ?? v,
          })),
          style: 'segmented',
        },
      },
      {
        id: 'agy.useG1Credits',
        label: 'Use G1 AI Credits',
        hint: 'Applies to next agy acp session (useG1Credits)',
        changed: effectiveG1 !== DEFAULT_AGY_SAFE_SETTINGS.useG1Credits,
        defaultLabel: 'Off',
        control: {
          k: 'switch',
          on: effectiveG1,
        },
      },
      {
        id: 'agy.reconnect',
        label: 'Reconnect agy acp',
        hint: 'Restart backend process so updated agy safety settings take effect',
        control: {
          k: 'action',
          act: 'reconnect',
          label: 'Reconnect',
        },
      },
    ];

    return [
      { id: 'perm-oma', title: 'oma Local Auto-Allow', rows: omaRows },
      { id: 'perm-agy', title: 'agy Backend Safety', rows: agyRows },
    ];
  }

  // `ecosystem`
  const extRows: PrefsRow[] = [
    {
      id: 'eco.mcp',
      label: 'MCP Servers',
      hint: 'Inspect, enable, or disable configured MCP servers',
      control: { k: 'action', act: 'open-mcp', label: 'Open /mcp' },
    },
    {
      id: 'eco.plugins',
      label: 'Plugins',
      hint: 'Manage installed Antigravity plugins',
      control: { k: 'action', act: 'open-plugins', label: 'Open /plugins' },
    },
    {
      id: 'eco.skills',
      label: 'Skills',
      hint: 'Browse workspace, global, and ACP skills with SKILL.md preview',
      control: { k: 'action', act: 'open-skills', label: 'Open /skills' },
    },
    {
      id: 'eco.agents',
      label: 'Agents',
      hint: 'Inspect built-in/custom agents and active session subagents',
      control: { k: 'action', act: 'open-agents', label: 'Open /agents' },
    },
  ];

  const authRows: PrefsRow[] = [
    {
      id: 'eco.tier',
      label: 'Subscription Tier',
      hint: 'Reported by agy acp session metadata',
      disabled: state.tier?.name ? state.tier.name : 'Not reported by backend',
      control: {
        k: 'text',
        value: state.tier?.name ?? 'Standard / not reported',
      },
    },
    {
      id: 'eco.login',
      label: 'Account Sign In',
      hint: 'Authenticate or switch account via official agy acp --login',
      control: { k: 'action', act: 'login', label: 'Run /login' },
    },
    {
      id: 'eco.logout',
      label: 'Account Sign Out',
      hint: state.supportsLogout
        ? 'Sign out via official ACP auth/logout RPC'
        : 'Not supported by current agy acp version',
      disabled: state.supportsLogout ? undefined : 'Unsupported by current agy acp',
      control: { k: 'action', act: 'logout', label: 'Run /logout' },
    },
  ];

  const pathRows: PrefsRow[] = [
    {
      id: 'eco.oma_config_path',
      label: 'oma config.toml',
      hint: 'Local oma configuration file (read-only path)',
      disabled: 'Read-only path',
      control: {
        k: 'text',
        value: configPath || 'config.toml',
        mono: true,
      },
    },
    {
      id: 'eco.agy_settings_path',
      label: 'agy settings.json',
      hint: 'Allowlisted agy safety settings file (read-only path)',
      disabled: 'Read-only path',
      control: {
        k: 'text',
        value: agySettingsPath || '~/.gemini/antigravity-cli/settings.json',
        mono: true,
      },
    },
    {
      id: 'eco.reset_defaults',
      label: 'Reset oma Defaults',
      hint: 'Restore oma UI, startup defaults, and auto-allow list to defaults',
      control: { k: 'action', act: 'reset-defaults', label: 'Reset Defaults' },
    },
  ];

  return [
    { id: 'eco-ext', title: 'Extensions', rows: extRows },
    { id: 'eco-auth', title: 'Account & Auth', rows: authRows },
    { id: 'eco-paths', title: 'Configuration Files', rows: pathRows },
  ];
}

/**
 * Pure computation shared by `SettingsView` and `AppController` keyboard routing
 * so page tabs, search filtering, changed badges, and row navigation stay in sync.
 */
export function computeSettingsData(
  state: AppState,
  settings: SettingsPanelState,
  config: OmaConfig,
  configPath?: string,
  agySettingsPath?: string
): ComputedSettingsData {
  const sectionsByPage = new Map<SettingsPageId, readonly SettingsSectionData[]>();
  const rowById = new Map<string, PrefsRow>();

  const pages = SETTINGS_PAGES.map(pageDef => {
    const pageSections = buildPageSections(
      pageDef.id,
      state,
      settings,
      config,
      configPath,
      agySettingsPath
    );
    sectionsByPage.set(pageDef.id, pageSections);

    let changedCount = 0;
    for (const sec of pageSections) {
      for (const row of sec.rows) {
        rowById.set(row.id, row);
        if (row.changed) changedCount++;
      }
    }

    return {
      id: pageDef.id,
      label: pageDef.label,
      icon: pageDef.icon,
      ...(changedCount > 0 ? { changed: changedCount } : {}),
    };
  });

  const activePageDef =
    SETTINGS_PAGES.find(p => p.id === settings.page) ?? SETTINGS_PAGES[0]!;
  const query = settings.query.trim().toLowerCase();

  let sections: SettingsSectionData[];
  if (query.length > 0) {
    sections = [];
    for (const pageDef of SETTINGS_PAGES) {
      const pageSections = sectionsByPage.get(pageDef.id) ?? [];
      for (const sec of pageSections) {
        const matchedRows = sec.rows.filter(row => {
          const hay = `${row.id} ${row.label ?? ''} ${row.hint ?? ''} ${sec.title}`.toLowerCase();
          return hay.includes(query);
        });
        if (matchedRows.length > 0) {
          sections.push({
            id: `${pageDef.id}.${sec.id}`,
            title: sec.title,
            page: pageDef.label,
            rows: matchedRows,
          });
        }
      }
    }
  } else {
    sections = [...(sectionsByPage.get(activePageDef.id) ?? [])];
  }

  const visibleRowIds: string[] = [];
  for (const sec of sections) {
    for (const row of sec.rows) {
      visibleRowIds.push(row.id);
    }
  }

  return {
    pages,
    page: activePageDef.id,
    lead: query.length > 0 ? `Search results for “${settings.query.trim()}”` : activePageDef.lead,
    sections,
    visibleRowIds,
    rowById,
  };
}

/**
 * `/settings` & `/config` `<prefs>` panel aligned 1:1 with `omp`:
 * - When `state.supportsAside === true` (desktop Tern), returns top-level
 *   `<prefs key="settings" title="oma settings" ... />` mounted directly in `layer`
 *   (NEVER wrapped in `<overlay>`) so Tern docks it as a live side sheet beside the chat.
 * - When `state.supportsAside === false`, falls back to a centered modal `<overlay>`.
 */
export function SettingsView(props: SettingsViewProps): JSX.Element {
  const { state, settings, config, configPath, agySettingsPath, callbacks } = props;
  const computed = computeSettingsData(state, settings, config, configPath, agySettingsPath);

  const forwardAction = (act: string) => (ev: { value?: unknown; item?: string }) => {
    callbacks.onAction(act, ev.value ?? ev.item);
  };

  const prefsNode = (
    <prefs
      key={state.supportsAside ? 'settings' : 'prefs'}
      title="oma settings"
      pages={computed.pages}
      page={computed.page}
      lead={computed.lead}
      sections={computed.sections}
      query={settings.query}
      cursor={settings.cursor}
      focus={settings.focus ?? undefined}
      editing={settings.editing ?? undefined}
      onChange={ev => {
        if (ev.item !== undefined) {
          callbacks.onChange(ev.item, ev.value);
        }
      }}
      onSelect={ev => callbacks.onSelect(ev.item)}
      onActivate={ev => callbacks.onActivate(ev.item)}
      onAction={{
        page: ev => {
          if (typeof ev.value === 'string' && ev.value.length > 0) {
            callbacks.onPageChange(ev.value as SettingsPageId);
          }
        },
        close: ev => {
          if (typeof ev.value === 'string' && ev.value.length > 0) {
            callbacks.onAction('close-edit', ev.value);
          } else {
            callbacks.onClose();
          }
        },
        edit: ev => callbacks.onAction('edit', ev.value ?? ev.item),
        'save-defaults': forwardAction('save-defaults'),
        reconnect: forwardAction('reconnect'),
        'open-mcp': forwardAction('open-mcp'),
        'open-plugins': forwardAction('open-plugins'),
        'open-skills': forwardAction('open-skills'),
        'open-agents': forwardAction('open-agents'),
        login: forwardAction('login'),
        logout: forwardAction('logout'),
        'reset-defaults': forwardAction('reset-defaults'),
      }}
    />
  );

  if (state.supportsAside) {
    return prefsNode;
  }

  return (
    <overlay key="settings" anchor="center" size="lg" modal>
      {prefsNode}
    </overlay>
  );
}
