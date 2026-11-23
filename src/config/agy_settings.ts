import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { basename, dirname, posix, win32 } from 'node:path';

/**
 * Strict safe allowlist of `agy` settings keys in `~/.gemini/antigravity-cli/settings.json`.
 *
 * Security & ToS boundary:
 * - Only these five non-sensitive safety/behavior keys may be read or written.
 * - Unknown keys in `settings.json` are preserved verbatim on write and never exposed.
 * - OAuth / Keyring / API Key credential files are strictly forbidden.
 */
export const AGY_SAFE_SETTING_KEYS = [
  'toolPermission',
  'enableTerminalSandbox',
  'allowNonWorkspaceAccess',
  'artifactReviewPolicy',
  'useG1Credits',
  'showThinking',
  'orchestrator',
] as const;

export type AgySafeSettingKey = (typeof AGY_SAFE_SETTING_KEYS)[number];

export interface AgyOrchestratorSettings {
  readonly planner?: string;
  readonly executor?: string;
}

export const AGY_TOOL_PERMISSION_VALUES = [
  'request-review',
  'proceed-in-sandbox',
  'strict',
  'always-proceed',
] as const;

export type AgyToolPermission = (typeof AGY_TOOL_PERMISSION_VALUES)[number];

export const AGY_ARTIFACT_REVIEW_POLICY_VALUES = [
  'asks-for-review',
  'always-proceed',
] as const;

export type AgyArtifactReviewPolicy = (typeof AGY_ARTIFACT_REVIEW_POLICY_VALUES)[number];

export interface AgySafeSettings {
  readonly toolPermission: AgyToolPermission;
  readonly enableTerminalSandbox: boolean;
  readonly allowNonWorkspaceAccess: boolean;
  readonly artifactReviewPolicy: AgyArtifactReviewPolicy;
  readonly useG1Credits: boolean;
  readonly showThinking: boolean;
  readonly orchestrator: AgyOrchestratorSettings;
}

export const DEFAULT_AGY_SAFE_SETTINGS: AgySafeSettings = Object.freeze({
  toolPermission: 'request-review',
  enableTerminalSandbox: false,
  allowNonWorkspaceAccess: false,
  artifactReviewPolicy: 'asks-for-review',
  useG1Credits: false,
  showThinking: false,
  orchestrator: Object.freeze({}),
});

/**
 * Parse an `agy` Orchestrator model spec string such as `"Gemini 4 Carbon (High)"`
 * or `"Gemini 4 Neon (Extra)"` into `{ modelName, thoughtLevel }`.
 */
export function parseOrchestratorModelSpec(raw: string | undefined): {
  readonly modelName: string;
  readonly thoughtLevel?: string;
} | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const m = /^(.*?)\s*\((Low|Medium|High|XHigh|Extra|Minimal|Max)\)$/i.exec(trimmed);
  if (!m) {
    return { modelName: trimmed };
  }
  const base = (m[1] ?? '').trim();
  const rawLvl = (m[2] ?? '').trim().toLowerCase();
  const normalizedLevel = rawLvl === 'extra' ? 'xhigh' : rawLvl;
  return base ? { modelName: base, thoughtLevel: normalizedLevel } : { modelName: trimmed };
}

/**
 * Format a model display name + optional thought level into `agy` `settings.json`
 * orchestrator format (e.g. `"Gemini 4 Carbon (High)"`, `"Gemini 4 Neon (Extra)"`).
 */
export function formatOrchestratorModelSpec(
  modelName: string,
  thoughtLevel?: string | null,
): string {
  const cleanName = modelName.trim();
  if (!cleanName) return '';
  const lvl = thoughtLevel?.trim().toLowerCase();
  if (!lvl || lvl === 'off') return cleanName;
  const labelMap: Record<string, string> = {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra',
    extra: 'Extra',
    max: 'Max',
  };
  const displayLvl = labelMap[lvl] ?? lvl.charAt(0).toUpperCase() + lvl.slice(1);
  return `${cleanName} (${displayLvl})`;
}

export interface AgySettingsPathOptions {
  /** Explicit path override for unit tests. */
  readonly path?: string;
  readonly homedir?: string;
  readonly platform?: NodeJS.Platform;
}

export interface LoadAgySettingsResult {
  readonly path: string;
  readonly exists: boolean;
  readonly settings: AgySafeSettings;
  /** Safe allowlisted keys currently explicitly present in `settings.json`. */
  readonly presentKeys: readonly AgySafeSettingKey[];
  readonly warnings: readonly string[];
}

export type AgySafeSettingsPatch = {
  readonly [K in AgySafeSettingKey]?: AgySafeSettings[K] | null;
};

export interface SaveAgySettingsResult {
  readonly path: string;
  readonly settings: AgySafeSettings;
  readonly updatedKeys: readonly AgySafeSettingKey[];
  readonly deletedKeys: readonly AgySafeSettingKey[];
  readonly ignoredKeys: readonly string[];
}

const SAFE_KEY_SET: ReadonlySet<string> = new Set(AGY_SAFE_SETTING_KEYS);
const TOOL_PERMISSION_SET: ReadonlySet<string> = new Set(AGY_TOOL_PERMISSION_VALUES);
const ARTIFACT_REVIEW_SET: ReadonlySet<string> = new Set(AGY_ARTIFACT_REVIEW_POLICY_VALUES);

const FORBIDDEN_CREDENTIAL_FILENAMES = new Set([
  'oauth_creds.json',
  'google_accounts.json',
  'jetski-standalone-oauth-token',
  'credentials.json',
  'auth.json',
  'tokens.json',
]);

function assertSafeSettingsPath(filePath: string): void {
  const base = basename(filePath.replace(/\\/g, '/')).toLowerCase();
  if (
    FORBIDDEN_CREDENTIAL_FILENAMES.has(base) ||
    base.includes('oauth') ||
    base.includes('keyring') ||
    base.includes('credential') ||
    base.includes('token')
  ) {
    throw new Error(`Refusing to access credential-like file: ${filePath}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves the default `~/.gemini/antigravity-cli/settings.json` path (or an injected test path).
 */
export function getAgySettingsPath(options: AgySettingsPathOptions = {}): string {
  if (options.path) {
    assertSafeSettingsPath(options.path);
    return options.path;
  }
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? osHomedir();
  const resolved =
    platform === 'win32'
      ? win32.join(home, '.gemini', 'antigravity-cli', 'settings.json')
      : posix.join(home, '.gemini', 'antigravity-cli', 'settings.json');
  assertSafeSettingsPath(resolved);
  return resolved;
}

export function isAgySafeSettingKey(key: string): key is AgySafeSettingKey {
  return SAFE_KEY_SET.has(key);
}

function extractSafeSettings(
  raw: Record<string, unknown>,
  warnings: string[],
): { settings: AgySafeSettings; presentKeys: AgySafeSettingKey[] } {
  const presentKeys: AgySafeSettingKey[] = [];

  let toolPermission: AgyToolPermission = DEFAULT_AGY_SAFE_SETTINGS.toolPermission;
  if ('toolPermission' in raw && raw['toolPermission'] !== undefined) {
    presentKeys.push('toolPermission');
    const v = raw['toolPermission'];
    if (typeof v === 'string' && TOOL_PERMISSION_SET.has(v)) {
      toolPermission = v as AgyToolPermission;
    } else {
      warnings.push(`toolPermission: invalid value "${String(v)}", using default`);
    }
  }

  let enableTerminalSandbox = DEFAULT_AGY_SAFE_SETTINGS.enableTerminalSandbox;
  if ('enableTerminalSandbox' in raw && raw['enableTerminalSandbox'] !== undefined) {
    presentKeys.push('enableTerminalSandbox');
    const v = raw['enableTerminalSandbox'];
    if (typeof v === 'boolean') {
      enableTerminalSandbox = v;
    } else {
      warnings.push('enableTerminalSandbox: expected boolean, using default');
    }
  }

  let allowNonWorkspaceAccess = DEFAULT_AGY_SAFE_SETTINGS.allowNonWorkspaceAccess;
  if ('allowNonWorkspaceAccess' in raw && raw['allowNonWorkspaceAccess'] !== undefined) {
    presentKeys.push('allowNonWorkspaceAccess');
    const v = raw['allowNonWorkspaceAccess'];
    if (typeof v === 'boolean') {
      allowNonWorkspaceAccess = v;
    } else {
      warnings.push('allowNonWorkspaceAccess: expected boolean, using default');
    }
  }

  let artifactReviewPolicy: AgyArtifactReviewPolicy =
    DEFAULT_AGY_SAFE_SETTINGS.artifactReviewPolicy;
  if ('artifactReviewPolicy' in raw && raw['artifactReviewPolicy'] !== undefined) {
    presentKeys.push('artifactReviewPolicy');
    const v = raw['artifactReviewPolicy'];
    if (typeof v === 'string' && ARTIFACT_REVIEW_SET.has(v)) {
      artifactReviewPolicy = v as AgyArtifactReviewPolicy;
    } else {
      warnings.push(`artifactReviewPolicy: invalid value "${String(v)}", using default`);
    }
  }

  let useG1Credits = DEFAULT_AGY_SAFE_SETTINGS.useG1Credits;
  if ('useG1Credits' in raw && raw['useG1Credits'] !== undefined) {
    presentKeys.push('useG1Credits');
    const v = raw['useG1Credits'];
    if (typeof v === 'boolean') {
      useG1Credits = v;
    } else {
      warnings.push('useG1Credits: expected boolean, using default');
    }
  }

  let showThinking = DEFAULT_AGY_SAFE_SETTINGS.showThinking;
  if ('showThinking' in raw && raw['showThinking'] !== undefined) {
    presentKeys.push('showThinking');
    const v = raw['showThinking'];
    if (typeof v === 'boolean') {
      showThinking = v;
    } else {
      warnings.push('showThinking: expected boolean, using default');
    }
  }

  let orchestrator: AgyOrchestratorSettings = DEFAULT_AGY_SAFE_SETTINGS.orchestrator;
  if ('orchestrator' in raw && raw['orchestrator'] !== undefined) {
    presentKeys.push('orchestrator');
    const v = raw['orchestrator'];
    if (isPlainObject(v)) {
      const planner = typeof v['planner'] === 'string' && v['planner'].trim().length > 0
        ? v['planner'].trim()
        : undefined;
      const executor = typeof v['executor'] === 'string' && v['executor'].trim().length > 0
        ? v['executor'].trim()
        : undefined;
      orchestrator = {
        ...(planner ? { planner } : {}),
        ...(executor ? { executor } : {}),
      };
    } else {
      warnings.push('orchestrator: expected object, using default');
    }
  }

  return {
    settings: {
      toolPermission,
      enableTerminalSandbox,
      allowNonWorkspaceAccess,
      artifactReviewPolicy,
      useG1Credits,
      showThinking,
      orchestrator,
    },
    presentKeys,
  };
}

function validateSafeSettingValue(key: AgySafeSettingKey, value: unknown): boolean {
  switch (key) {
    case 'toolPermission':
      return typeof value === 'string' && TOOL_PERMISSION_SET.has(value);
    case 'artifactReviewPolicy':
      return typeof value === 'string' && ARTIFACT_REVIEW_SET.has(value);
    case 'enableTerminalSandbox':
    case 'allowNonWorkspaceAccess':
    case 'useG1Credits':
    case 'showThinking':
      return typeof value === 'boolean';
    case 'orchestrator': {
      if (!isPlainObject(value)) return false;
      for (const [k, v] of Object.entries(value)) {
        if (k !== 'planner' && k !== 'executor') return false;
        if (v !== undefined && typeof v !== 'string') return false;
      }
      return true;
    }
  }
}

/**
 * Reads only the 5 allowlisted safe settings from `~/.gemini/antigravity-cli/settings.json`.
 * Never throws on missing or malformed files; never exposes unknown keys.
 */
export async function loadAgySettings(
  options: AgySettingsPathOptions = {},
): Promise<LoadAgySettingsResult> {
  const filePath = getAgySettingsPath(options);
  try {
    const text = await readFile(filePath, 'utf8');
    if (text.trim().length === 0) {
      return {
        path: filePath,
        exists: true,
        settings: DEFAULT_AGY_SAFE_SETTINGS,
        presentKeys: [],
        warnings: [],
      };
    }
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      return {
        path: filePath,
        exists: true,
        settings: DEFAULT_AGY_SAFE_SETTINGS,
        presentKeys: [],
        warnings: ['agy settings.json root must be a JSON object, using defaults'],
      };
    }
    const warnings: string[] = [];
    const { settings, presentKeys } = extractSafeSettings(parsed, warnings);
    return {
      path: filePath,
      exists: true,
      settings,
      presentKeys,
      warnings,
    };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') {
      return {
        path: filePath,
        exists: false,
        settings: DEFAULT_AGY_SAFE_SETTINGS,
        presentKeys: [],
        warnings: [],
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      path: filePath,
      exists: true,
      settings: DEFAULT_AGY_SAFE_SETTINGS,
      presentKeys: [],
      warnings: [`Failed to read ${filePath}: ${message}`],
    };
  }
}

/**
 * Atomically updates allowlisted safe keys in `~/.gemini/antigravity-cli/settings.json`.
 *
 * Guarantees:
 * - Preserves 100% of all unknown keys already present in `settings.json`.
 * - Ignores any non-allowlisted keys passed in `patch`.
 * - Deletes an allowlisted key when its value is reset to the official default (or `null`).
 * - Refuses to overwrite a corrupted existing JSON file.
 * - Writes atomically via temp file + `rename`.
 */
export async function saveAgySettings(
  patch: AgySafeSettingsPatch | Record<string, unknown>,
  options: AgySettingsPathOptions = {},
): Promise<SaveAgySettingsResult> {
  const filePath = getAgySettingsPath(options);

  // 1. Read existing JSON document while preserving all unknown keys verbatim
  let existing: Record<string, unknown> = {};
  try {
    const text = await readFile(filePath, 'utf8');
    if (text.trim().length > 0) {
      const parsed: unknown = JSON.parse(text);
      if (!isPlainObject(parsed)) {
        throw new Error(`Existing ${filePath} is not a JSON object; refusing to overwrite`);
      }
      existing = { ...parsed };
    }
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== 'ENOENT') {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  // 2. Apply strictly allowlisted updates; delete keys when set to default or null
  const updatedKeys: AgySafeSettingKey[] = [];
  const deletedKeys: AgySafeSettingKey[] = [];
  const ignoredKeys: string[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (!isAgySafeSettingKey(key)) {
      ignoredKeys.push(key);
      continue;
    }
    if (value === undefined) {
      continue;
    }
    const defaultValue = DEFAULT_AGY_SAFE_SETTINGS[key];
    if (key === 'orchestrator') {
      if (value === null) {
        if (key in existing) delete existing[key];
        deletedKeys.push(key);
        continue;
      }
      if (!validateSafeSettingValue(key, value)) {
        throw new Error(`Invalid value for agy setting "${key}": ${String(value)}`);
      }
      const nextOrch = value as AgyOrchestratorSettings;
      const cleaned: Record<string, string> = {};
      if (typeof nextOrch.planner === 'string' && nextOrch.planner.trim().length > 0) {
        cleaned['planner'] = nextOrch.planner.trim();
      }
      if (typeof nextOrch.executor === 'string' && nextOrch.executor.trim().length > 0) {
        cleaned['executor'] = nextOrch.executor.trim();
      }
      if (Object.keys(cleaned).length === 0) {
        if (key in existing) delete existing[key];
        deletedKeys.push(key);
      } else {
        existing[key] = cleaned;
        updatedKeys.push(key);
      }
      continue;
    }
    if (value === null || value === defaultValue) {
      if (key in existing) {
        delete existing[key];
      }
      deletedKeys.push(key);
      continue;
    }
    if (!validateSafeSettingValue(key, value)) {
      throw new Error(`Invalid value for agy setting "${key}": ${String(value)}`);
    }
    existing[key] = value;
    updatedKeys.push(key);
  }

  // 3. Atomic write via temp file + rename
  await mkdir(dirname(filePath), { recursive: true });
  const serialized = `${JSON.stringify(existing, null, 2)}\n`;
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  const tmpPath = `${filePath}.${nonce}.tmp`;

  try {
    await writeFile(tmpPath, serialized, 'utf8');
    await rename(tmpPath, filePath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  const warnings: string[] = [];
  const { settings } = extractSafeSettings(existing, warnings);

  return {
    path: filePath,
    settings,
    updatedKeys,
    deletedKeys,
    ignoredKeys,
  };
}

/**
 * Convenience helper to update (or reset with `null`) a single allowlisted `agy` setting.
 */
export async function updateAgySetting<K extends AgySafeSettingKey>(
  key: K,
  value: AgySafeSettings[K] | null,
  options: AgySettingsPathOptions = {},
): Promise<SaveAgySettingsResult> {
  return saveAgySettings({ [key]: value } as AgySafeSettingsPatch, options);
}

export interface AutoCompactOverrideInfo {
  readonly raw: string;
  readonly kind: 'tokens' | 'percent';
  readonly requestedTokens?: number;
  readonly requestedPercent?: number;
  readonly effectiveTokens?: number;
  readonly effectivePercent?: number;
  readonly clamped: boolean;
}

export interface AutoCompactDisplaySummary {
  readonly label: string;
  readonly compactLabel: string;
  readonly isOverride: boolean;
  readonly info: AutoCompactOverrideInfo | null;
}

function formatCompactCountForAutoCompact(n: number): string {
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

function formatCompactPercentForAutoCompact(pct: number): string {
  if (!Number.isFinite(pct)) return '0%';
  return pct < 10 ? `${pct.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(pct)}%`;
}

/**
 * Parse `AGY_CLI_AUTO_COMPACT_OVERRIDE` values matching `agy 1.5.15`:
 * integer token counts (`700000`), `K`/`M` shorthand (`800K`, `0.5M`), or percentages (`80%`).
 */
export function parseAutoCompactOverride(
  raw: string | undefined,
  contextWindowSize?: number,
): AutoCompactOverrideInfo | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;

  const windowSize =
    typeof contextWindowSize === 'number' && Number.isFinite(contextWindowSize) && contextWindowSize > 0
      ? Math.round(contextWindowSize)
      : undefined;

  const pctMatch = /^(\d+(?:\.\d+)?)\s*%$/.exec(trimmed);
  if (pctMatch?.[1]) {
    const pct = Number(pctMatch[1]);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
    if (windowSize !== undefined) {
      const effectiveTokens = Math.max(1, Math.min(windowSize, Math.round((windowSize * pct) / 100)));
      const effectivePercent = (effectiveTokens / windowSize) * 100;
      return {
        raw: trimmed,
        kind: 'percent',
        requestedPercent: pct,
        effectiveTokens,
        effectivePercent,
        clamped: false,
      };
    }
    return {
      raw: trimmed,
      kind: 'percent',
      requestedPercent: pct,
      effectivePercent: pct,
      clamped: false,
    };
  }

  let requestedTokens: number | undefined;
  const unitMatch = /^(\d+(?:\.\d+)?)\s*([km])$/i.exec(trimmed);
  if (unitMatch?.[1] && unitMatch[2]) {
    const num = Number(unitMatch[1]);
    if (!Number.isFinite(num) || num <= 0) return null;
    const mult = unitMatch[2].toLowerCase() === 'm' ? 1_000_000 : 1_000;
    requestedTokens = Math.round(num * mult);
  } else if (/^\d+$/.test(trimmed)) {
    requestedTokens = Number.parseInt(trimmed, 10);
  } else {
    return null;
  }

  if (!Number.isFinite(requestedTokens) || requestedTokens <= 0) {
    return null;
  }

  if (windowSize !== undefined) {
    const clamped = requestedTokens > windowSize;
    const effectiveTokens = Math.min(requestedTokens, windowSize);
    const effectivePercent = (effectiveTokens / windowSize) * 100;
    return {
      raw: trimmed,
      kind: 'tokens',
      requestedTokens,
      effectiveTokens,
      effectivePercent,
      clamped,
    };
  }

  return {
    raw: trimmed,
    kind: 'tokens',
    requestedTokens,
    effectiveTokens: requestedTokens,
    clamped: false,
  };
}

/**
 * Format `AGY_CLI_AUTO_COMPACT_OVERRIDE` into human-readable summary strings
 * for `/context` and `/model` UI surfaces.
 */
export function formatAutoCompactSummary(
  raw: string | undefined,
  contextWindowSize?: number,
): AutoCompactDisplaySummary {
  const info = parseAutoCompactOverride(raw, contextWindowSize);
  if (!info) {
    return {
      label: 'Default (managed by agy)',
      compactLabel: 'Default',
      isOverride: false,
      info: null,
    };
  }

  let compactLabel: string;
  if (info.effectiveTokens !== undefined && info.effectivePercent !== undefined) {
    compactLabel = `${formatCompactCountForAutoCompact(info.effectiveTokens)} (${formatCompactPercentForAutoCompact(info.effectivePercent)})`;
  } else if (info.effectiveTokens !== undefined) {
    compactLabel = formatCompactCountForAutoCompact(info.effectiveTokens);
  } else if (info.effectivePercent !== undefined) {
    compactLabel = formatCompactPercentForAutoCompact(info.effectivePercent);
  } else {
    compactLabel = info.raw;
  }

  const clampedNote = info.clamped ? ', clamped' : '';
  return {
    label: `${compactLabel} · override (AGY_CLI_AUTO_COMPACT_OVERRIDE=${info.raw}${clampedNote})`,
    compactLabel,
    isOverride: true,
    info,
  };
}
