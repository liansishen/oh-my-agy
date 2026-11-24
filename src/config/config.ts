import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';

export type ToolDisplayMode = 'all' | 'compact' | 'hidden';
export type TodoProvider = 'off' | 'mcp' | 'native';

export interface OmaUiConfig {
  readonly auto_collapse_thought: boolean;
  readonly collapse_compacted: boolean;
  readonly tool_display: ToolDisplayMode;
  readonly tool_preview_lines: number;
  readonly todo_provider: TodoProvider;
  readonly osc_7501: boolean;
  readonly reopen_anchor: boolean;
}

export interface OmaApprovalConfig {
  readonly auto_allow_tools: readonly string[];
}

export interface OmaConfig {
  readonly agy_bin: string;
  readonly default_model: string;
  readonly default_thought: string;
  readonly default_mode: string;
  readonly recent_models: string[];
  readonly ui: OmaUiConfig;
  readonly approval: OmaApprovalConfig;
}

export const MAX_RECENT_MODELS = 12;

export const DEFAULT_CONFIG: OmaConfig = Object.freeze({
  agy_bin: '',
  default_model: '',
  default_thought: '',
  default_mode: '',
  recent_models: Object.freeze([]) as unknown as string[],
  ui: Object.freeze({
    auto_collapse_thought: true,
    collapse_compacted: true,
    tool_display: 'all' as ToolDisplayMode,
    tool_preview_lines: 8,
    todo_provider: 'mcp' as TodoProvider,
    osc_7501: true,
    reopen_anchor: true,
  }),
  approval: Object.freeze({
    auto_allow_tools: Object.freeze([]),
  }),
});

export interface ConfigPathOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly homedir?: string;
}

export interface LoadConfigOptions extends ConfigPathOptions {
  /** Explicitly load from a custom TOML file path instead of the default OS path. */
  readonly path?: string;
}

export interface ParseConfigResult {
  readonly config: OmaConfig;
  readonly warnings: readonly string[];
  /** Non-empty when config.toml failed to parse or read (used to prevent overwriting broken user config). */
  readonly parseError?: string;
}

export interface LoadConfigResult extends ParseConfigResult {
  readonly path: string;
  readonly exists: boolean;
}

const KNOWN_TOP_KEYS = new Set([
  'agy_bin',
  'default_model',
  'default_thought',
  'default_mode',
  'recent_models',
  'ui',
  'approval',
]);

const KNOWN_UI_KEYS = new Set([
  'auto_collapse_thought',
  'collapse_compacted',
  'tool_display',
  'tool_preview_lines',
  'todo_provider',
  'osc_7501',
  'reopen_anchor',
]);

const KNOWN_TOOL_DISPLAY_MODES = new Set<ToolDisplayMode>(['all', 'compact', 'hidden']);
const KNOWN_TODO_PROVIDERS = new Set<TodoProvider>(['off', 'mcp', 'native']);

export function normalizeToolDisplayMode(value: unknown): ToolDisplayMode {
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase() as ToolDisplayMode;
    if (KNOWN_TOOL_DISPLAY_MODES.has(lower)) return lower;
  }
  return DEFAULT_CONFIG.ui.tool_display;
}

export function normalizeTodoProvider(value: unknown): TodoProvider {
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase() as TodoProvider;
    if (KNOWN_TODO_PROVIDERS.has(lower)) return lower;
  }
  return DEFAULT_CONFIG.ui.todo_provider;
}

export function isSemverAtLeast(
  rawVersion: string | undefined,
  major: number,
  minor: number,
  patch: number,
): boolean {
  if (!rawVersion) return false;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/i.exec(rawVersion.trim());
  if (!m) return false;
  const curMajor = Number.parseInt(m[1]!, 10);
  const curMinor = Number.parseInt(m[2]!, 10);
  const curPatch = Number.parseInt(m[3]!, 10);
  if (curMajor !== major) return curMajor > major;
  if (curMinor !== minor) return curMinor > minor;
  return curPatch >= patch;
}

export function supportsNativeUpdateSteps(rawVersion: string | undefined): boolean {
  return isSemverAtLeast(rawVersion, 1, 5, 16);
}

export function resolveEffectiveTodoProvider(
  configured: TodoProvider,
  agentVersion: string | undefined,
): TodoProvider {
  const normalized = normalizeTodoProvider(configured);
  if (normalized === 'native' && !supportsNativeUpdateSteps(agentVersion)) {
    return 'off';
  }
  return normalized;
}

const KNOWN_APPROVAL_KEYS = new Set(['auto_allow_tools']);

const KNOWN_MODES = new Set(['', 'default', 'accept-edits', 'auto', 'plan']);
const MIN_TOOL_PREVIEW_LINES = 1;
const MAX_TOOL_PREVIEW_LINES = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes a list of recent model IDs: trims whitespace, removes empty/duplicate
 * entries while preserving order, and caps length to `max` (default 12).
 */
export function normalizeRecentModels(
  models: readonly string[] | undefined,
  max = MAX_RECENT_MODELS,
): string[] {
  if (!models || models.length === 0) return [];
  const limit = Math.max(0, Math.floor(max));
  if (limit === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of models) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Prepends `modelId` to `current`, deduplicating and capping to `max` (default 12).
 */
export function recordRecentModel(
  current: readonly string[] | undefined,
  modelId: string,
  max = MAX_RECENT_MODELS,
): string[] {
  const trimmed = modelId.trim();
  if (trimmed.length === 0) {
    return normalizeRecentModels(current, max);
  }
  return normalizeRecentModels([trimmed, ...(current ?? [])], max);
}

/**
 * Returns the platform-appropriate `oma` configuration directory:
 * - Windows: `%APPDATA%\oma`
 * - Linux / macOS: `$XDG_CONFIG_HOME/oma` (fallback `~/.config/oma`)
 */
export function getConfigDir(options: ConfigPathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? osHomedir();

  if (platform === 'win32') {
    const appData = env['APPDATA']?.trim();
    if (appData && appData.length > 0) {
      return win32.join(appData, 'oma');
    }
    return win32.join(home, 'AppData', 'Roaming', 'oma');
  }

  const xdgConfig = env['XDG_CONFIG_HOME']?.trim();
  if (xdgConfig && xdgConfig.length > 0) {
    return posix.join(xdgConfig, 'oma');
  }
  return posix.join(home, '.config', 'oma');
}

/**
 * Returns the platform-appropriate path to `config.toml`.
 */
export function getConfigPath(options: ConfigPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const dir = getConfigDir(options);
  return platform === 'win32' ? win32.join(dir, 'config.toml') : posix.join(dir, 'config.toml');
}

function readStringField(
  obj: Record<string, unknown>,
  key: string,
  fallback: string,
  warnings: string[],
  prefix = '',
): string {
  if (!(key in obj) || obj[key] === undefined) return fallback;
  const raw = obj[key];
  if (typeof raw !== 'string') {
    warnings.push(`${prefix}${key}: expected string, using default`);
    return fallback;
  }
  return raw.trim();
}

function readBooleanField(
  obj: Record<string, unknown>,
  key: string,
  fallback: boolean,
  warnings: string[],
  prefix = '',
): boolean {
  if (!(key in obj) || obj[key] === undefined) return fallback;
  const raw = obj[key];
  if (typeof raw !== 'boolean') {
    warnings.push(`${prefix}${key}: expected boolean, using default (${String(fallback)})`);
    return fallback;
  }
  return raw;
}

function readPreviewLinesField(
  obj: Record<string, unknown>,
  key: string,
  fallback: number,
  warnings: string[],
): number {
  if (!(key in obj) || obj[key] === undefined) return fallback;
  const raw = obj[key];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw)) {
    warnings.push(`ui.${key}: expected integer, using default (${fallback})`);
    return fallback;
  }
  if (raw < MIN_TOOL_PREVIEW_LINES || raw > MAX_TOOL_PREVIEW_LINES) {
    const clamped = Math.min(MAX_TOOL_PREVIEW_LINES, Math.max(MIN_TOOL_PREVIEW_LINES, raw));
    warnings.push(
      `ui.${key}: out of range (${raw}), clamped to ${clamped} (${MIN_TOOL_PREVIEW_LINES}..${MAX_TOOL_PREVIEW_LINES})`,
    );
    return clamped;
  }
  return raw;
}

function readStringArrayField(
  obj: Record<string, unknown>,
  key: string,
  warnings: string[],
  prefix = '',
  maxItems?: number,
): string[] {
  if (!(key in obj) || obj[key] === undefined) return [];
  const raw = obj[key];
  if (!Array.isArray(raw)) {
    warnings.push(`${prefix}${key}: expected string array, using default ([])`);
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'string') {
      warnings.push(`${prefix}${key}[${i}]: expected string, skipped`);
      continue;
    }
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (maxItems !== undefined && out.length >= maxItems) {
      break;
    }
  }
  return out;
}

/**
 * Parses and validates a `config.toml` document via `Bun.TOML.parse`.
 * Never throws on malformed TOML or invalid field types; falls back to defaults
 * and returns human-readable warnings.
 */
export function parseConfigToml(tomlText: string): ParseConfigResult {
  const warnings: string[] = [];
  if (tomlText.trim().length === 0) {
    return { config: DEFAULT_CONFIG, warnings };
  }

  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(tomlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const parseError = `Failed to parse config.toml: ${message}`;
    warnings.push(parseError);
    return { config: DEFAULT_CONFIG, warnings, parseError };
  }

  if (!isRecord(parsed)) {
    const parseError = 'config.toml root must be a table, using defaults';
    warnings.push(parseError);
    return { config: DEFAULT_CONFIG, warnings, parseError };
  }

  for (const key of Object.keys(parsed)) {
    if (!KNOWN_TOP_KEYS.has(key)) {
      warnings.push(`Unknown config key "${key}" ignored`);
    }
  }

  const agy_bin = readStringField(parsed, 'agy_bin', DEFAULT_CONFIG.agy_bin, warnings);
  const default_model = readStringField(
    parsed,
    'default_model',
    DEFAULT_CONFIG.default_model,
    warnings,
  );
  const default_thought = readStringField(
    parsed,
    'default_thought',
    DEFAULT_CONFIG.default_thought,
    warnings,
  );
  const default_mode = readStringField(
    parsed,
    'default_mode',
    DEFAULT_CONFIG.default_mode,
    warnings,
  );
  if (!KNOWN_MODES.has(default_mode)) {
    warnings.push(
      `default_mode: unrecognized value "${default_mode}" (expected default|accept-edits|auto|plan)`,
    );
  }

  const recent_models = readStringArrayField(
    parsed,
    'recent_models',
    warnings,
    '',
    MAX_RECENT_MODELS,
  );

  let uiTable: Record<string, unknown> = {};
  if ('ui' in parsed && parsed['ui'] !== undefined) {
    if (isRecord(parsed['ui'])) {
      uiTable = parsed['ui'];
      for (const key of Object.keys(uiTable)) {
        if (!KNOWN_UI_KEYS.has(key)) {
          warnings.push(`Unknown config key "ui.${key}" ignored`);
        }
      }
    } else {
      warnings.push('ui: expected table, using defaults');
    }
  }

  let approvalTable: Record<string, unknown> = {};
  if ('approval' in parsed && parsed['approval'] !== undefined) {
    if (isRecord(parsed['approval'])) {
      approvalTable = parsed['approval'];
      for (const key of Object.keys(approvalTable)) {
        if (!KNOWN_APPROVAL_KEYS.has(key)) {
          warnings.push(`Unknown config key "approval.${key}" ignored`);
        }
      }
    } else {
      warnings.push('approval: expected table, using defaults');
    }
  }

  const rawToolDisplay = readStringField(
    uiTable,
    'tool_display',
    DEFAULT_CONFIG.ui.tool_display,
    warnings,
    'ui.',
  );
  const tool_display = KNOWN_TOOL_DISPLAY_MODES.has(rawToolDisplay as ToolDisplayMode)
    ? (rawToolDisplay as ToolDisplayMode)
    : (() => {
        warnings.push(
          `ui.tool_display: unrecognized value "${rawToolDisplay}" (expected all|compact|hidden), using "${DEFAULT_CONFIG.ui.tool_display}"`,
        );
        return DEFAULT_CONFIG.ui.tool_display;
      })();

  const rawTodoProvider = readStringField(
    uiTable,
    'todo_provider',
    DEFAULT_CONFIG.ui.todo_provider,
    warnings,
    'ui.',
  )
    .trim()
    .toLowerCase();
  const todo_provider = KNOWN_TODO_PROVIDERS.has(rawTodoProvider as TodoProvider)
    ? (rawTodoProvider as TodoProvider)
    : (() => {
        warnings.push(
          `ui.todo_provider: unrecognized value "${rawTodoProvider}" (expected off|mcp|native), using "${DEFAULT_CONFIG.ui.todo_provider}"`,
        );
        return DEFAULT_CONFIG.ui.todo_provider;
      })();

  const config: OmaConfig = {
    agy_bin,
    default_model,
    default_thought,
    default_mode,
    recent_models,
    ui: {
      auto_collapse_thought: readBooleanField(
        uiTable,
        'auto_collapse_thought',
        DEFAULT_CONFIG.ui.auto_collapse_thought,
        warnings,
        'ui.',
      ),
      collapse_compacted: readBooleanField(
        uiTable,
        'collapse_compacted',
        DEFAULT_CONFIG.ui.collapse_compacted,
        warnings,
        'ui.',
      ),
      tool_display,
      tool_preview_lines: readPreviewLinesField(
        uiTable,
        'tool_preview_lines',
        DEFAULT_CONFIG.ui.tool_preview_lines,
        warnings,
      ),
      todo_provider,
      osc_7501: readBooleanField(
        uiTable,
        'osc_7501',
        DEFAULT_CONFIG.ui.osc_7501,
        warnings,
        'ui.',
      ),
      reopen_anchor: readBooleanField(
        uiTable,
        'reopen_anchor',
        DEFAULT_CONFIG.ui.reopen_anchor,
        warnings,
        'ui.',
      ),
    },
    approval: {
      auto_allow_tools: readStringArrayField(
        approvalTable,
        'auto_allow_tools',
        warnings,
        'approval.',
      ),
    },
  };

  return { config, warnings };
}

/**
 * Asynchronously loads `config.toml`. Returns {@link DEFAULT_CONFIG} when the
 * file does not exist or cannot be parsed.
 */
export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadConfigResult> {
  const filePath = options.path ?? getConfigPath(options);
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed = parseConfigToml(content);
    return {
      path: filePath,
      exists: true,
      config: parsed.config,
      warnings: parsed.warnings,
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
    };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') {
      return {
        path: filePath,
        exists: false,
        config: DEFAULT_CONFIG,
        warnings: [],
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    const parseError = `Failed to read ${filePath}: ${message}`;
    return {
      path: filePath,
      exists: existsSync(filePath),
      config: DEFAULT_CONFIG,
      warnings: [parseError],
      parseError,
    };
  }
}

/**
 * Synchronously loads `config.toml`. Useful during early CLI bootstrap.
 */
export function loadConfigSync(options: LoadConfigOptions = {}): LoadConfigResult {
  const filePath = options.path ?? getConfigPath(options);
  if (!existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
      config: DEFAULT_CONFIG,
      warnings: [],
    };
  }
  try {
    const content = readFileSync(filePath, 'utf8');
    const parsed = parseConfigToml(content);
    return {
      path: filePath,
      exists: true,
      config: parsed.config,
      warnings: parsed.warnings,
      ...(parsed.parseError ? { parseError: parsed.parseError } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const parseError = `Failed to read ${filePath}: ${message}`;
    return {
      path: filePath,
      exists: true,
      config: DEFAULT_CONFIG,
      warnings: [parseError],
      parseError,
    };
  }
}

function formatTomlString(value: string): string {
  return JSON.stringify(value);
}

function formatTomlStringArray(values: readonly string[]): string {
  return `[${values.map((v) => formatTomlString(v)).join(', ')}]`;
}

function normalizeConfigForSave(config: OmaConfig): OmaConfig {
  const rawLines = Number.isInteger(config.ui.tool_preview_lines)
    ? config.ui.tool_preview_lines
    : DEFAULT_CONFIG.ui.tool_preview_lines;
  const clampedLines = Math.min(
    MAX_TOOL_PREVIEW_LINES,
    Math.max(MIN_TOOL_PREVIEW_LINES, rawLines),
  );

  const seenTools = new Set<string>();
  const autoAllowTools: string[] = [];
  for (const item of config.approval.auto_allow_tools ?? []) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0 || seenTools.has(trimmed)) continue;
    seenTools.add(trimmed);
    autoAllowTools.push(trimmed);
  }

  return {
    agy_bin: (config.agy_bin ?? '').trim(),
    default_model: (config.default_model ?? '').trim(),
    default_thought: (config.default_thought ?? '').trim(),
    default_mode: (config.default_mode ?? '').trim(),
    recent_models: normalizeRecentModels(config.recent_models, MAX_RECENT_MODELS),
    ui: {
      auto_collapse_thought: Boolean(config.ui.auto_collapse_thought),
      collapse_compacted:
        typeof config.ui?.collapse_compacted === 'boolean'
          ? config.ui.collapse_compacted
          : DEFAULT_CONFIG.ui.collapse_compacted,
      tool_display: normalizeToolDisplayMode(config.ui.tool_display),
      tool_preview_lines: clampedLines,
      todo_provider: normalizeTodoProvider(config.ui?.todo_provider),
      osc_7501: Boolean(config.ui.osc_7501),
      reopen_anchor: Boolean(config.ui.reopen_anchor),
    },
    approval: {
      auto_allow_tools: autoAllowTools,
    },
  };
}

/**
 * Formats an {@link OmaConfig} object into canonical, human-readable TOML.
 */
export function formatConfigToml(config: OmaConfig): string {
  const norm = normalizeConfigForSave(config);
  return [
    '# Optional: override agy executable path (defaults to PATH lookup)',
    `agy_bin = ${formatTomlString(norm.agy_bin)}`,
    '',
    '# Optional: default model, thought level, and permission mode',
    `default_model = ${formatTomlString(norm.default_model)}`,
    `default_thought = ${formatTomlString(norm.default_thought)}`,
    `default_mode = ${formatTomlString(norm.default_mode)}`,
    `recent_models = ${formatTomlStringArray(norm.recent_models)}`,
    '',
    '[ui]',
    `auto_collapse_thought = ${String(norm.ui.auto_collapse_thought)}`,
    `collapse_compacted = ${String(norm.ui.collapse_compacted)}`,
    `tool_display = ${formatTomlString(norm.ui.tool_display)}`,
    `tool_preview_lines = ${norm.ui.tool_preview_lines}`,
    `todo_provider = ${formatTomlString(norm.ui.todo_provider)}`,
    `osc_7501 = ${String(norm.ui.osc_7501)}`,
    `reopen_anchor = ${String(norm.ui.reopen_anchor)}`,
    '',
    '[approval]',
    `auto_allow_tools = ${formatTomlStringArray(norm.approval.auto_allow_tools)}`,
    '',
  ].join('\n');
}

/**
 * Returns a commented default `config.toml` template matching DESIGN.md 4.8.
 */
export function formatDefaultConfigToml(): string {
  return formatConfigToml(DEFAULT_CONFIG);
}

/**
 * Atomically persists an {@link OmaConfig} to `config.toml` via temp file + rename.
 * Automatically creates parent directories if they do not exist.
 */
export async function saveConfig(
  config: OmaConfig,
  pathOrOptions?: string | LoadConfigOptions,
): Promise<string> {
  const filePath =
    typeof pathOrOptions === 'string'
      ? pathOrOptions
      : (pathOrOptions?.path ?? getConfigPath(pathOrOptions));

  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const toml = formatConfigToml(config);
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  const tmpPath = `${filePath}.${nonce}.tmp`;

  try {
    await writeFile(tmpPath, toml, 'utf8');
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  return filePath;
}

/** Helper re-export for tests constructing paths relative to the config dir. */
export function resolveConfigFile(filename: string, options: ConfigPathOptions = {}): string {
  return join(getConfigDir(options), filename);
}
