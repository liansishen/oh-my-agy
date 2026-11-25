/**
 * ACP 双轨模型 ID 解析与动态 configOptions 状态提取。
 * 对齐 docs/DESIGN.md 4.2.4：
 * - 轨道 1（主控）：configOptions[model] 无后缀基模型 + configOptions[thought_level]
 * - 轨道 2（兼容）：models.availableModels 带后缀完整 ID（如 gemini-4-neon-xhigh）
 * - 动态兼容 Orchestrator 等无 thought_level 的模型，以及自身含 -medium 后缀的基模型（如 gpt-oss-120b-medium）。
 */

import {
  parseOrchestratorModelSpec,
  type AgyOrchestratorSettings,
} from "../config/agy_settings.ts";
import {
  flattenConfigOptionChoices,
  type ConfigOption,
  type ConfigOptionChoice,
  type ModelInfo,
  type SessionModeState,
  type SessionModelState,
  type SessionSetConfigOptionParams,
  type SessionSetConfigOptionResult,
  type SessionSetModelParams,
  type SessionSetModelResult,
} from "./protocol.ts";

/** 已知思考深度档位列表（按长度降序优先匹配，避免 high 先于 xhigh） */
export const KNOWN_THOUGHT_LEVELS = [
  "minimal",
  "medium",
  "xhigh",
  "high",
  "low",
  "max",
] as const;

const DEFAULT_THREE_THOUGHT_LEVELS: readonly ConfigOptionChoice[] = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
];

const DEFAULT_FOUR_THOUGHT_LEVELS: readonly ConfigOptionChoice[] = [
  { value: "low", name: "Low" },
  { value: "medium", name: "Medium" },
  { value: "high", name: "High" },
  { value: "xhigh", name: "Extra" },
];

/** `/model` 选择框中用于代表全部 Orchestrator 变体的统一合并条目 ID */
export const ORCHESTRATOR_PICKER_ID = "orchestrator";

/** Orchestrator Planner 严格受限的可选模型白名单（固定展示顺序，对齐 `agy`） */
export const ORCHESTRATOR_PLANNER_MODEL_IDS = [
  "gemini-4-neon",
  "gemini-4-carbon",
  "gemini-4-argon",
  "claude-opus-5-5",
] as const;

/** Orchestrator Executor 严格受限的可选模型白名单（固定展示顺序，对齐 `agy`） */
export const ORCHESTRATOR_EXECUTOR_MODEL_IDS = [
  "gemini-4-hydrogen",
  "claude-sonnet-5-5",
] as const;

/**
 * 判断模型 ID 或名称是否为 Orchestrator 编排模型（如 `gemini-pro-orchestrator-neon` 或合并 ID `orchestrator`）。
 */
export function isOrchestratorModelId(
  modelIdOrName: string | null | undefined,
): boolean {
  if (!modelIdOrName) return false;
  return modelIdOrName.toLowerCase().includes("orchestrator");
}

/**
 * 按 Orchestrator 角色排序并过滤可用模型：
 * 返回全部非 Orchestrator 模型，优先按该角色推荐顺序排列（`planner` 优先
 * `Neon / Carbon / Argon / Claude Opus 5.5`；`executor` 优先 `Hydrogen / Claude Sonnet 5.5`），
 * 其余非 Orchestrator 模型按服务端原始顺序附后。
 */
export function filterOrchestratorRoleModels(
  role: "planner" | "executor",
  availableModels: readonly ConfigOptionChoice[],
): readonly ConfigOptionChoice[] {
  const nonOrch = availableModels.filter((c) => !isOrchestratorModelId(c.value));
  if (nonOrch.length === 0) {
    return availableModels;
  }
  const preferredOrder: readonly string[] =
    role === "planner"
      ? ORCHESTRATOR_PLANNER_MODEL_IDS
      : ORCHESTRATOR_EXECUTOR_MODEL_IDS;
  const byLowerId = new Map<string, ConfigOptionChoice>();
  for (const choice of nonOrch) {
    byLowerId.set(choice.value.toLowerCase(), choice);
  }
  const ordered: ConfigOptionChoice[] = [];
  const seen = new Set<string>();
  for (const id of preferredOrder) {
    const found = byLowerId.get(id);
    if (found) {
      ordered.push(found);
      seen.add(found.value.toLowerCase());
    }
  }
  for (const choice of nonOrch) {
    if (!seen.has(choice.value.toLowerCase())) {
      ordered.push(choice);
    }
  }
  return ordered;
}

export interface OrchestratorSingleAgentSelection {
  readonly modelId: string;
  readonly modelName: string;
  readonly thoughtLevel?: string;
}

function resolveOrchestratorRoleSpec(
  role: "planner" | "executor",
  orchestratorSettings: AgyOrchestratorSettings | undefined,
  controls: Pick<
    SessionControlState,
    "currentModelId" | "supportsThoughtLevel" | "availableThoughtLevels" | "availableModels"
  >,
  cachedByModel?: Readonly<Record<string, readonly ConfigOptionChoice[]>>,
): OrchestratorSingleAgentSelection | null {
  const nonOrch = controls.availableModels.filter(
    (c) => !isOrchestratorModelId(c.value),
  );
  if (nonOrch.length === 0) return null;

  const rawSpec = orchestratorSettings?.[role]?.trim();
  if (rawSpec) {
    const rawLower = rawSpec.toLowerCase();
    const directFixed = nonOrch.find(
      (c) =>
        c.name.toLowerCase() === rawLower || c.value.toLowerCase() === rawLower,
    );
    if (
      directFixed &&
      resolveThoughtLevelsForModel(directFixed.value, controls, cachedByModel)
        .length === 0
    ) {
      return {
        modelId: directFixed.value,
        modelName: directFixed.name,
      };
    }
  }

  const parsed = parseOrchestratorModelSpec(rawSpec);
  const fallback =
    role === "planner"
      ? inferOrchestratorDefaultPlannerModel(controls.currentModelId) ?? {
          modelId: "gemini-4-carbon",
          modelName: "Gemini 4 Carbon",
        }
      : inferOrchestratorDefaultExecutorModel(controls.currentModelId) ?? {
          modelId: "gemini-4-hydrogen",
          modelName: "Gemini 4 Hydrogen",
        };
  const targetName = parsed?.modelName ?? fallback.modelName;
  const targetLower = targetName.toLowerCase();
  const matched =
    nonOrch.find(
      (c) =>
        c.name.toLowerCase() === targetLower ||
        c.value.toLowerCase() === targetLower,
    ) ??
    (!parsed
      ? nonOrch.find(
          (c) => c.value.toLowerCase() === fallback.modelId.toLowerCase(),
        )
      : undefined);
  if (!matched) return null;

  const choices = resolveThoughtLevelsForModel(
    matched.value,
    controls,
    cachedByModel,
  );
  if (choices.length === 0) {
    return {
      modelId: matched.value,
      modelName: matched.name,
    };
  }
  const thoughtLevel = clampThoughtLevelForChoices(
    parsed?.thoughtLevel ?? "high",
    choices,
  )?.toLowerCase();
  return {
    modelId: matched.value,
    modelName: matched.name,
    ...(thoughtLevel ? { thoughtLevel } : {}),
  };
}

/**
 * 判断 Orchestrator 的 Planner 与 Executor 是否指向完全相同的模型与思考强度：
 * - 若模型与 `Effort` 完全一致，返回单 Agent 直跑目标 `{ modelId, modelName, thoughtLevel }`；
 * - 若模型不同，或同模型采用不同的 `Effort` 档位，返回 `null`（维持两阶段 Plan-and-Execute）。
 */
export function resolveOrchestratorSingleAgentSelection(
  orchestratorSettings: AgyOrchestratorSettings | undefined,
  controls: Pick<
    SessionControlState,
    "currentModelId" | "supportsThoughtLevel" | "availableThoughtLevels" | "availableModels"
  >,
  cachedByModel?: Readonly<Record<string, readonly ConfigOptionChoice[]>>,
): OrchestratorSingleAgentSelection | null {
  const planner = resolveOrchestratorRoleSpec(
    "planner",
    orchestratorSettings,
    controls,
    cachedByModel,
  );
  const executor = resolveOrchestratorRoleSpec(
    "executor",
    orchestratorSettings,
    controls,
    cachedByModel,
  );
  if (!planner || !executor) return null;
  if (planner.modelId.toLowerCase() !== executor.modelId.toLowerCase()) {
    return null;
  }
  if (planner.thoughtLevel !== executor.thoughtLevel) {
    return null;
  }
  return planner;
}

/**
 * 将模型全名精简为底部紧凑胶囊使用的短名（悬停 tooltip 仍展示完整名称）：
 * - `Gemini 4 Neon` -> `Neon`
 * - `Gemini 4 Carbon` -> `Carbon`
 * - `Gemini 4 Argon` -> `Argon`
 * - `Gemini 4 Hydrogen` -> `Hydrogen`
 * - `Claude Opus 5.5` -> `Opus 5.5`
 * - `Claude Sonnet 5.5` -> `Sonnet 5.5`
 */
export function formatShortOrchestratorModelName(rawName: string): string {
  const trimmed = rawName.trim();
  if (!trimmed) return "";
  const geminiMatch = /^gemini\s+\d+(?:\.\d+)?\s+(.+)$/i.exec(trimmed);
  if (geminiMatch && geminiMatch[1]) {
    return geminiMatch[1].trim();
  }
  const claudeMatch = /^claude\s+(.+)$/i.exec(trimmed);
  if (claudeMatch && claudeMatch[1]) {
    return claudeMatch[1].trim();
  }
  return trimmed;
}

/**
 * 推导某个 Orchestrator 变体对应的默认 Planner 模型（用于 `settings.json` 未显式配置时的回退显示）。
 */
export function inferOrchestratorDefaultPlannerModel(
  orchestratorModelId: string | null | undefined,
): { readonly modelId: string; readonly modelName: string } | null {
  if (!isOrchestratorModelId(orchestratorModelId)) return null;
  const lower = orchestratorModelId!.trim().toLowerCase();
  if (lower.includes("neon")) {
    return { modelId: "gemini-4-neon", modelName: "Gemini 4 Neon" };
  }
  if (lower.includes("argon")) {
    return { modelId: "gemini-4-argon", modelName: "Gemini 4 Argon" };
  }
  return { modelId: "gemini-4-carbon", modelName: "Gemini 4 Carbon" };
}

/**
 * 推导 Orchestrator 默认 Executor 模型（`settings.json` 未显式配置时默认 `Gemini 4 Hydrogen`）。
 */
export function inferOrchestratorDefaultExecutorModel(
  orchestratorModelId: string | null | undefined,
): { readonly modelId: string; readonly modelName: string } | null {
  if (!isOrchestratorModelId(orchestratorModelId)) return null;
  return { modelId: "gemini-4-hydrogen", modelName: "Gemini 4 Hydrogen" };
}

/**
 * 根据选定的 Planner 模型名/ID 映射到 ACP 服务端提供的对应 Orchestrator 变体 ID：
 * - Neon -> `gemini-pro-orchestrator-neon`
 * - Argon -> `gemini-pro-orchestrator-argon`
 * - Carbon -> `gemini-pro-orchestrator`
 * - Claude Opus 5.5 / 其他 -> 若当前已是 Orchestrator 变体则保留，否则回退 `gemini-pro-orchestrator` 或首个可用 Orchestrator
 */
export function resolveAcpOrchestratorModelIdForPlanner(
  plannerModelIdOrName: string | null | undefined,
  availableModels: readonly ConfigOptionChoice[],
  currentModelId?: string | null,
): string | null {
  const orchChoices = availableModels.filter((c) => isOrchestratorModelId(c.value));
  if (orchChoices.length === 0) return null;

  const findOrch = (predicate: (lower: string) => boolean): string | undefined =>
    orchChoices.find((c) => predicate(c.value.toLowerCase()))?.value;

  const lowerPlanner = plannerModelIdOrName?.trim().toLowerCase() ?? "";
  if (lowerPlanner.includes("neon")) {
    const m = findOrch((v) => v.includes("neon"));
    if (m) return m;
  } else if (lowerPlanner.includes("argon")) {
    const m = findOrch((v) => v.includes("argon"));
    if (m) return m;
  } else if (lowerPlanner.includes("carbon")) {
    const m = findOrch(
      (v) => v === "gemini-pro-orchestrator" || v.includes("carbon"),
    );
    if (m) return m;
  }

  if (
    currentModelId &&
    orchChoices.some((c) => c.value === currentModelId)
  ) {
    return currentModelId;
  }

  return (
    findOrch((v) => v === "gemini-pro-orchestrator") ??
    findOrch((v) => v.includes("neon")) ??
    orchChoices[0]!.value
  );
}

/**
 * 解析 Orchestrator 的指定角色（`planner` 或 `executor`）当前对应的真实可调思考档位列表。
 */
export function resolveOrchestratorRoleThoughtLevels(
  role: "planner" | "executor",
  controls: Pick<
    SessionControlState,
    "currentModelId" | "supportsThoughtLevel" | "availableThoughtLevels" | "availableModels"
  >,
  cachedByModel?: Readonly<Record<string, readonly ConfigOptionChoice[]>>,
  configuredModelName?: string | null,
): readonly ConfigOptionChoice[] {
  const custom = configuredModelName?.trim();
  let underlyingModelId: string | undefined;
  if (custom) {
    const matched = controls.availableModels.find(
      (c) =>
        c.name.toLowerCase() === custom.toLowerCase() ||
        c.value.toLowerCase() === custom.toLowerCase(),
    );
    underlyingModelId = matched?.value ?? custom;
  } else if (role === "planner") {
    underlyingModelId =
      inferOrchestratorDefaultPlannerModel(controls.currentModelId)?.modelId ??
      "gemini-4-carbon";
  } else {
    underlyingModelId = "gemini-4-hydrogen";
  }
  return resolveThoughtLevelsForModel(underlyingModelId, controls, cachedByModel);
}

/**
 * 判断候选模型是否原生支持 4 档思考深度（`low / medium / high / xhigh`）。
 * 基于 `agy` 实测：仅 `neon` 与 `hydrogen` 系列（非 Orchestrator）支持 4 档，其余支持思考的模型为 3 档。
 */
export function modelSupportsFourThoughtLevels(
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  const lower = modelId.trim().toLowerCase();
  if (!lower || isOrchestratorModelId(lower)) return false;
  return /(?:^|[-_/\s])(neon|hydrogen)(?:$|[-_/\s])/.test(lower);
}

/**
 * 判断候选模型是否支持可调思考档位（排除 Orchestrator 及自带固定档位后缀如 `gpt-oss-120b-medium`）。
 */
export function modelSupportsThoughtLevelOption(
  modelId: string | null | undefined,
): boolean {
  if (!modelId) return false;
  const lower = modelId.trim().toLowerCase();
  if (!lower) return false;
  if (isOrchestratorModelId(lower)) return false;
  if (lower.startsWith("gpt-oss-")) return false;
  return true;
}

/**
 * 解析指定候选模型 `modelId` 应展示的思考档位选项：
 * 1. 若 `modelId` 即当前激活模型，严格以服务端实时 `controls.availableThoughtLevels` 为准；
 * 2. 若本次会话已切换过该模型并缓存了服务端实际返回的档位，直接采用权威缓存；
 * 3. 否则对尚未切换的候选模型按模型族能力精确推导：
 *    - Orchestrator / 固定档位模型 -> `[]`（不支持）
 *    - `neon` / `hydrogen` -> 4 档（`low / medium / high / xhigh`）
 *    - 其余支持思考的模型（`carbon` / `argon` / `flash` / `claude` 等）-> 3 档（`low / medium / high`）
 */
export function resolveThoughtLevelsForModel(
  modelId: string | null | undefined,
  controls: Pick<
    SessionControlState,
    "currentModelId" | "supportsThoughtLevel" | "availableThoughtLevels"
  >,
  cachedByModel?: Readonly<Record<string, readonly ConfigOptionChoice[]>>,
): readonly ConfigOptionChoice[] {
  const targetId = modelId?.trim() || controls.currentModelId?.trim() || "";
  if (!targetId) {
    return controls.supportsThoughtLevel ? controls.availableThoughtLevels : [];
  }

  // 1. Authoritative live server state for the currently active model
  if (controls.currentModelId && targetId === controls.currentModelId) {
    return controls.supportsThoughtLevel ? controls.availableThoughtLevels : [];
  }

  // 2. Authoritative cached server state from an earlier switch in this session
  if (cachedByModel && targetId in cachedByModel) {
    return cachedByModel[targetId] ?? [];
  }

  // 3. Static capability inference for unvisited candidate models
  if (!modelSupportsThoughtLevelOption(targetId)) {
    return [];
  }

  const labelByValue = new Map<string, string>();
  for (const c of controls.availableThoughtLevels) {
    labelByValue.set(c.value.toLowerCase(), c.name);
  }

  const baseList = modelSupportsFourThoughtLevels(targetId)
    ? DEFAULT_FOUR_THOUGHT_LEVELS
    : DEFAULT_THREE_THOUGHT_LEVELS;

  return baseList.map((entry) => ({
    value: entry.value,
    name: labelByValue.get(entry.value) ?? entry.name,
  }));
}

/**
 * 将期望思考档位安全钳位到目标模型实际支持的选项列表内
 * （例如从 4 档模型的 `xhigh` 移到 3 档模型时自动回落到 `high`）。
 */
export function clampThoughtLevelForChoices(
  desired: string | null | undefined,
  choices: readonly ConfigOptionChoice[],
): string | undefined {
  if (choices.length === 0) return undefined;
  const trimmed = desired?.trim().toLowerCase();
  if (!trimmed) return choices[0]?.value;
  const exact = choices.find((c) => c.value.toLowerCase() === trimmed);
  if (exact) return exact.value;

  const rankOrder = ["minimal", "low", "medium", "high", "xhigh", "max"];
  const desiredRank = rankOrder.indexOf(trimmed);
  if (desiredRank >= 0) {
    // Pick the highest supported level <= desiredRank, or the lowest available level above it
    let bestBelow: { value: string; rank: number } | null = null;
    let bestAbove: { value: string; rank: number } | null = null;
    for (const c of choices) {
      const r = rankOrder.indexOf(c.value.toLowerCase());
      if (r < 0) continue;
      if (r <= desiredRank && (!bestBelow || r > bestBelow.rank)) {
        bestBelow = { value: c.value, rank: r };
      } else if (r > desiredRank && (!bestAbove || r < bestAbove.rank)) {
        bestAbove = { value: c.value, rank: r };
      }
    }
    if (bestBelow) return bestBelow.value;
    if (bestAbove) return bestAbove.value;
  }
  return choices[choices.length - 1]?.value;
}

export interface SessionControlContext {
  configOptions?: ConfigOption[];
  models?: SessionModelState;
  modes?: SessionModeState;
}

export interface SessionControlState {
  /** 是否应通过 session/set_config_option 控制（否则降级 session/set_model / set_mode） */
  useConfigOptions: boolean;
  currentModelId: string | null;
  currentModelName: string | null;
  availableModels: ConfigOptionChoice[];
  /** 当前模型是否支持 thought_level（严格由服务端 configOptions 动态决定） */
  supportsThoughtLevel: boolean;
  currentThoughtLevel: string | null;
  currentThoughtLevelName: string | null;
  availableThoughtLevels: ConfigOptionChoice[];
  currentModeId: string | null;
  currentModeName: string | null;
  availableModes: ConfigOptionChoice[];
}

export type ModelMatchKind =
  | "exact_config_model"
  | "exact_config_name"
  | "available_model_mapped"
  | "split_with_thought_level"
  | "fuzzy_config_model"
  | "legacy_exact"
  | "legacy_fuzzy";

export interface ResolvedModelSelection {
  strategy: "config_option" | "legacy_set_model";
  modelId: string;
  modelName?: string;
  thoughtLevel?: string;
  matchKind: ModelMatchKind;
}

export type ThoughtLevelResolution =
  | { ok: true; value: string; name?: string }
  | { ok: false; reason: "unsupported" | "invalid"; available: string[] };

export interface ResolvedModeSelection {
  strategy: "config_option" | "legacy_set_mode";
  modeId: string;
  modeName?: string;
}

// ---------------------------------------------------------------------------
// ConfigOption 查询与权威状态提取
// ---------------------------------------------------------------------------

/** 按 id 或 category 查找指定 ConfigOption */
export function findConfigOption(
  configOptions: ConfigOption[] | undefined,
  idOrCategory: string,
): ConfigOption | undefined {
  if (!configOptions || configOptions.length === 0) {
    return undefined;
  }
  const byId = configOptions.find((opt) => opt.id === idOrCategory);
  if (byId) {
    return byId;
  }
  return configOptions.find((opt) => opt.category === idOrCategory);
}

export function getModelConfigOption(
  configOptions: ConfigOption[] | undefined,
): ConfigOption | undefined {
  return findConfigOption(configOptions, "model");
}

export function getThoughtLevelConfigOption(
  configOptions: ConfigOption[] | undefined,
): ConfigOption | undefined {
  return findConfigOption(configOptions, "thought_level");
}

export function getModeConfigOption(
  configOptions: ConfigOption[] | undefined,
): ConfigOption | undefined {
  return findConfigOption(configOptions, "mode");
}

export function hasThoughtLevelSupport(
  configOptions: ConfigOption[] | undefined,
): boolean {
  return getThoughtLevelConfigOption(configOptions) !== undefined;
}

/**
 * 从会话快照提取权威 UI 控制状态。
 * 优先采用 configOptions；仅在未返回 configOptions 时回退 models / modes。
 */
export function extractSessionControlState(
  context: SessionControlContext,
): SessionControlState {
  const modelOpt = getModelConfigOption(context.configOptions);
  const thoughtOpt = getThoughtLevelConfigOption(context.configOptions);
  const modeOpt = getModeConfigOption(context.configOptions);
  const hasAnyConfigOption =
    Array.isArray(context.configOptions) && context.configOptions.length > 0;

  // 模型
  let currentModelId: string | null = null;
  let currentModelName: string | null = null;
  let availableModels: ConfigOptionChoice[] = [];

  if (modelOpt) {
    availableModels = flattenConfigOptionChoices(modelOpt);
    currentModelId = modelOpt.currentValue || null;
    currentModelName =
      availableModels.find((c) => c.value === currentModelId)?.name ??
      currentModelId;
  } else if (context.models) {
    availableModels = context.models.availableModels.map((m) => ({
      value: m.modelId,
      name: m.name,
      description: m.description,
    }));
    currentModelId = context.models.currentModelId || null;
    currentModelName =
      availableModels.find((c) => c.value === currentModelId)?.name ??
      currentModelId;
  }

  // 思考档位（完全由服务端 configOptions 动态驱动）
  const supportsThoughtLevel = thoughtOpt !== undefined;
  const availableThoughtLevels = thoughtOpt
    ? flattenConfigOptionChoices(thoughtOpt)
    : [];
  const currentThoughtLevel = thoughtOpt ? thoughtOpt.currentValue || null : null;
  const currentThoughtLevelName =
    thoughtOpt && currentThoughtLevel
      ? (availableThoughtLevels.find((c) => c.value === currentThoughtLevel)
          ?.name ?? currentThoughtLevel)
      : null;

  // 权限模式
  let currentModeId: string | null = null;
  let currentModeName: string | null = null;
  let availableModes: ConfigOptionChoice[] = [];

  if (modeOpt) {
    availableModes = flattenConfigOptionChoices(modeOpt);
    currentModeId = modeOpt.currentValue || null;
    currentModeName =
      availableModes.find((c) => c.value === currentModeId)?.name ??
      currentModeId;
  } else if (context.modes) {
    availableModes = context.modes.availableModes.map((m) => ({
      value: m.id,
      name: m.name,
      description: m.description,
    }));
    currentModeId = context.modes.currentModeId || null;
    currentModeName =
      availableModes.find((c) => c.value === currentModeId)?.name ??
      currentModeId;
  }

  return {
    useConfigOptions: hasAnyConfigOption,
    currentModelId,
    currentModelName,
    availableModels,
    supportsThoughtLevel,
    currentThoughtLevel,
    currentThoughtLevelName,
    availableThoughtLevels,
    currentModeId,
    currentModeName,
    availableModes,
  };
}

// ---------------------------------------------------------------------------
// 双轨模型 ID 拆分与解析
// ---------------------------------------------------------------------------

function collectKnownThoughtLevels(configOptions?: ConfigOption[]): string[] {
  const seen = new Set<string>();
  const thoughtOpt = getThoughtLevelConfigOption(configOptions);
  if (thoughtOpt) {
    for (const c of flattenConfigOptionChoices(thoughtOpt)) {
      seen.add(c.value.toLowerCase());
    }
  }
  for (const level of KNOWN_THOUGHT_LEVELS) {
    seen.add(level);
  }
  // 按长度降序，保证 `-xhigh` 优先于 `-high`
  return Array.from(seen).sort((a, b) => b.length - a.length);
}

/**
 * 尝试将组合模型 ID 拆分为 `{ baseModelId, thoughtLevel }`。
 * 例如 `gemini-4-neon-xhigh` -> `{ baseModelId: "gemini-4-neon", thoughtLevel: "xhigh" }`。
 */
export function splitModelThoughtSuffix(
  rawModelId: string,
  validLevels: readonly string[] = KNOWN_THOUGHT_LEVELS,
): { baseModelId: string; thoughtLevel: string } | null {
  const trimmed = rawModelId.trim();
  const lower = trimmed.toLowerCase();
  const sortedLevels = [...validLevels].sort((a, b) => b.length - a.length);

  for (const level of sortedLevels) {
    const suffix = `-${level.toLowerCase()}`;
    if (lower.endsWith(suffix) && trimmed.length > suffix.length) {
      const base = trimmed.slice(0, trimmed.length - suffix.length);
      if (base.length > 0) {
        return { baseModelId: base, thoughtLevel: level };
      }
    }
  }
  return null;
}

/** 内部模糊打分：越高越匹配，0 表示不匹配 */
function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q || !c) return 0;
  if (c === q) return 1000;
  if (c.startsWith(q)) return 800 - (c.length - q.length);
  const idx = c.indexOf(q);
  if (idx !== -1) return 500 - idx * 2 - (c.length - q.length);

  // 词元子序列匹配（如 "g4n" 或 "opus55"）
  const qTokens = q.split(/[\s\-_/]+/).filter(Boolean);
  if (qTokens.length > 1 && qTokens.every((t) => c.includes(t))) {
    return 400 - (c.length - q.length);
  }

  let qi = 0;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] === q[qi]) {
      qi++;
    }
  }
  if (qi === q.length) {
    return Math.max(10, 200 - (c.length - q.length));
  }
  return 0;
}

function findBestFuzzyChoice(
  query: string,
  choices: readonly ConfigOptionChoice[],
): ConfigOptionChoice | undefined {
  let best: ConfigOptionChoice | undefined;
  let bestScore = 0;
  for (const choice of choices) {
    const score = Math.max(
      fuzzyScore(query, choice.value),
      fuzzyScore(query, choice.name),
    );
    if (score > bestScore) {
      bestScore = score;
      best = choice;
    }
  }
  return best;
}

/**
 * 解析用户输入的模型标识（支持基模型 ID、显示名、带档位组合 ID 与模糊简写）。
 * 严格遵循 docs/DESIGN.md 4.2.4 优先级：
 * 1. 先精确匹配 configOptions[model]（保护如 `gpt-oss-120b-medium` 等自带后缀基模型不被误拆）；
 * 2. 若未命中，检查 models.availableModels 或拆出 `<base>-<level>` 映射到基模型 + thought_level；
 * 3. 再进行模糊匹配；
 * 4. 若服务端未返回 configOptions，降级为 legacy `session/set_model`。
 */
export function resolveModelSelection(
  input: string,
  context: SessionControlContext,
): ResolvedModelSelection | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();

  const modelOpt = getModelConfigOption(context.configOptions);
  if (modelOpt) {
    const choices = flattenConfigOptionChoices(modelOpt);
    const validLevels = collectKnownThoughtLevels(context.configOptions);
    const thoughtOpt = getThoughtLevelConfigOption(context.configOptions);
    const thoughtChoices = flattenConfigOptionChoices(thoughtOpt);

    const canonicalizeLevel = (lvl: string): string => {
      const matched = thoughtChoices.find(
        (c) => c.value.toLowerCase() === lvl.toLowerCase(),
      );
      return matched ? matched.value : lvl.toLowerCase();
    };

    // 1. 精确匹配 configOptions[model].value
    const exactValue = choices.find((c) => c.value.toLowerCase() === lower);
    if (exactValue) {
      return {
        strategy: "config_option",
        modelId: exactValue.value,
        modelName: exactValue.name,
        matchKind: "exact_config_model",
      };
    }

    // 2. 精确匹配 configOptions[model].name
    const exactName = choices.find((c) => c.name.toLowerCase() === lower);
    if (exactName) {
      return {
        strategy: "config_option",
        modelId: exactName.value,
        modelName: exactName.name,
        matchKind: "exact_config_name",
      };
    }

    // 3. 命中 models.availableModels（如带档位后缀的组合 ID 或其展示名）
    const availableModels = context.models?.availableModels ?? [];
    const matchedAvailable = availableModels.find(
      (m) =>
        m.modelId.toLowerCase() === lower || m.name.toLowerCase() === lower,
    );
    if (matchedAvailable) {
      // 3a. 先检查 availableModels.modelId 是否直接是某个基模型
      const directBase = choices.find(
        (c) => c.value.toLowerCase() === matchedAvailable.modelId.toLowerCase(),
      );
      if (directBase) {
        return {
          strategy: "config_option",
          modelId: directBase.value,
          modelName: directBase.name,
          matchKind: "available_model_mapped",
        };
      }
      // 3b. 拆分 `<base>-<level>`
      const splitFromAvail = splitModelThoughtSuffix(
        matchedAvailable.modelId,
        validLevels,
      );
      if (splitFromAvail) {
        const baseChoice = choices.find(
          (c) =>
            c.value.toLowerCase() === splitFromAvail.baseModelId.toLowerCase(),
        );
        if (baseChoice) {
          return {
            strategy: "config_option",
            modelId: baseChoice.value,
            modelName: baseChoice.name,
            thoughtLevel: canonicalizeLevel(splitFromAvail.thoughtLevel),
            matchKind: "available_model_mapped",
          };
        }
      }
    }

    // 4. 直接对用户输入拆分 `<base>-<level>`
    const directSplit = splitModelThoughtSuffix(trimmed, validLevels);
    if (directSplit) {
      const exactBase = choices.find(
        (c) => c.value.toLowerCase() === directSplit.baseModelId.toLowerCase(),
      );
      if (exactBase) {
        return {
          strategy: "config_option",
          modelId: exactBase.value,
          modelName: exactBase.name,
          thoughtLevel: canonicalizeLevel(directSplit.thoughtLevel),
          matchKind: "split_with_thought_level",
        };
      }
    }

    // 5. 模糊匹配：先尝试整串，再尝试拆分后的基名模糊匹配
    const fuzzyDirect = findBestFuzzyChoice(trimmed, choices);
    if (fuzzyDirect) {
      return {
        strategy: "config_option",
        modelId: fuzzyDirect.value,
        modelName: fuzzyDirect.name,
        matchKind: "fuzzy_config_model",
      };
    }

    if (directSplit) {
      const fuzzyBase = findBestFuzzyChoice(directSplit.baseModelId, choices);
      if (fuzzyBase) {
        return {
          strategy: "config_option",
          modelId: fuzzyBase.value,
          modelName: fuzzyBase.name,
          thoughtLevel: canonicalizeLevel(directSplit.thoughtLevel),
          matchKind: "fuzzy_config_model",
        };
      }
    }

    return null;
  }

  // 降级：服务端未返回 configOptions，走 models.availableModels + session/set_model
  const legacyList = context.models?.availableModels ?? [];
  if (legacyList.length === 0) {
    return {
      strategy: "legacy_set_model",
      modelId: trimmed,
      matchKind: "legacy_exact",
    };
  }

  const exactLegacy = legacyList.find(
    (m) => m.modelId.toLowerCase() === lower || m.name.toLowerCase() === lower,
  );
  if (exactLegacy) {
    return {
      strategy: "legacy_set_model",
      modelId: exactLegacy.modelId,
      modelName: exactLegacy.name,
      matchKind: "legacy_exact",
    };
  }

  const legacyChoices: ConfigOptionChoice[] = legacyList.map((m) => ({
    value: m.modelId,
    name: m.name,
    description: m.description,
  }));
  const fuzzyLegacy = findBestFuzzyChoice(trimmed, legacyChoices);
  if (fuzzyLegacy) {
    return {
      strategy: "legacy_set_model",
      modelId: fuzzyLegacy.value,
      modelName: fuzzyLegacy.name,
      matchKind: "legacy_fuzzy",
    };
  }

  return null;
}

/** 校验并解析思考深度输入（严格依据服务端当前 configOptions[thought_level]） */
export function resolveThoughtLevel(
  input: string,
  configOptions?: ConfigOption[],
): ThoughtLevelResolution {
  const thoughtOpt = getThoughtLevelConfigOption(configOptions);
  if (!thoughtOpt) {
    return { ok: false, reason: "unsupported", available: [] };
  }
  const choices = flattenConfigOptionChoices(thoughtOpt);
  const available = choices.map((c) => c.value);
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return { ok: false, reason: "invalid", available };
  }

  const exact = choices.find(
    (c) =>
      c.value.toLowerCase() === trimmed || c.name.toLowerCase() === trimmed,
  );
  if (exact) {
    return { ok: true, value: exact.value, name: exact.name };
  }

  const prefix = choices.find((c) => c.value.toLowerCase().startsWith(trimmed));
  if (prefix) {
    return { ok: true, value: prefix.value, name: prefix.name };
  }

  return { ok: false, reason: "invalid", available };
}

/** 解析权限模式输入 */
export function resolveModeSelection(
  input: string,
  context: SessionControlContext,
): ResolvedModeSelection | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const modeOpt = getModeConfigOption(context.configOptions);
  if (modeOpt) {
    const choices = flattenConfigOptionChoices(modeOpt);
    const exact = choices.find(
      (c) =>
        c.value.toLowerCase() === trimmed || c.name.toLowerCase() === trimmed,
    );
    if (exact) {
      return {
        strategy: "config_option",
        modeId: exact.value,
        modeName: exact.name,
      };
    }
    const fuzzy = findBestFuzzyChoice(trimmed, choices);
    if (fuzzy) {
      return {
        strategy: "config_option",
        modeId: fuzzy.value,
        modeName: fuzzy.name,
      };
    }
    return null;
  }

  const legacyModes = context.modes?.availableModes ?? [];
  const exactLegacy = legacyModes.find(
    (m) => m.id.toLowerCase() === trimmed || m.name.toLowerCase() === trimmed,
  );
  if (exactLegacy) {
    return {
      strategy: "legacy_set_mode",
      modeId: exactLegacy.id,
      modeName: exactLegacy.name,
    };
  }
  return null;
}

/** 获取下一个权限模式（用于 Shift+Tab 循环切换） */
export function getNextModeSelection(
  context: SessionControlContext,
): ResolvedModeSelection | null {
  const modeOpt = getModeConfigOption(context.configOptions);
  if (modeOpt) {
    const choices = flattenConfigOptionChoices(modeOpt);
    if (choices.length === 0) return null;
    const idx = choices.findIndex((c) => c.value === modeOpt.currentValue);
    const next = choices[(idx + 1) % choices.length];
    return next
      ? { strategy: "config_option", modeId: next.value, modeName: next.name }
      : null;
  }

  const legacyModes = context.modes?.availableModes ?? [];
  if (legacyModes.length === 0) return null;
  const idx = legacyModes.findIndex(
    (m) => m.id === context.modes?.currentModeId,
  );
  const next = legacyModes[(idx + 1) % legacyModes.length];
  return next
    ? { strategy: "legacy_set_mode", modeId: next.id, modeName: next.name }
    : null;
}

/**
 * 将基模型 ID 与思考档位组合为完整显示/CLI 模型 ID。
 * 若 availableModels 含 `${baseModelId}-${thoughtLevel}` 或未提供列表但有 thoughtLevel，则返回组合 ID；
 * 若基模型在 availableModels 中本身不带后缀（如 Orchestrator 或 gpt-oss-120b-medium），则保持基模型 ID。
 */
export function combineModelId(
  baseModelId: string,
  thoughtLevel?: string | null,
  availableModels?: readonly ModelInfo[],
): string {
  if (!thoughtLevel) {
    return baseModelId;
  }
  const combined = `${baseModelId}-${thoughtLevel}`;
  if (availableModels && availableModels.length > 0) {
    const exactCombined = availableModels.find(
      (m) => m.modelId.toLowerCase() === combined.toLowerCase(),
    );
    if (exactCombined) {
      return exactCombined.modelId;
    }
    const exactBase = availableModels.find(
      (m) => m.modelId.toLowerCase() === baseModelId.toLowerCase(),
    );
    if (exactBase) {
      return exactBase.modelId;
    }
  }
  return combined;
}

// ---------------------------------------------------------------------------
// 自动双步应用（先切换 model，再按最新 configOptions 按需设置 thought_level）
// ---------------------------------------------------------------------------

export interface ModelConfigMutator {
  setConfigOption(
    params: SessionSetConfigOptionParams,
  ): Promise<SessionSetConfigOptionResult>;
  setModel(params: SessionSetModelParams): Promise<SessionSetModelResult>;
}

export interface ApplyModelSelectionResult {
  configOptions?: ConfigOption[];
  appliedModelId: string;
  appliedThoughtLevel?: string;
  /** 若用户期望设置 thought_level，但目标模型切完后不支持 thought_level，标记为 skipped */
  thoughtLevelSkipped?: boolean;
}

/**
 * 执行解析后的模型选择：
 * - `config_option` 策略：先调 `set_config_option("model", modelId)`，根据服务端返回的最新
 *   `configOptions` 判断是否支持 `thought_level`，若支持且提供了目标档位，再调 `set_config_option("thought_level", ...)`。
 * - `legacy_set_model` 策略：降级调 `session/set_model`。
 */
export async function applyModelSelection(
  client: ModelConfigMutator,
  sessionId: string,
  selection: ResolvedModelSelection,
  overrideThoughtLevel?: string,
): Promise<ApplyModelSelectionResult> {
  if (selection.strategy === "legacy_set_model") {
    await client.setModel({ sessionId, modelId: selection.modelId });
    return { appliedModelId: selection.modelId };
  }

  const modelRes = await client.setConfigOption({
    sessionId,
    configId: "model",
    value: selection.modelId,
  });
  let latestConfigOptions = modelRes.configOptions;

  const desiredThought = overrideThoughtLevel ?? selection.thoughtLevel;
  if (!desiredThought) {
    return {
      configOptions: latestConfigOptions,
      appliedModelId: selection.modelId,
    };
  }

  const resolvedThought = resolveThoughtLevel(
    desiredThought,
    latestConfigOptions,
  );
  if (!resolvedThought.ok) {
    if (resolvedThought.reason === "unsupported") {
      return {
        configOptions: latestConfigOptions,
        appliedModelId: selection.modelId,
        thoughtLevelSkipped: true,
      };
    }
    const thoughtOpt = getThoughtLevelConfigOption(latestConfigOptions);
    const availableChoices = flattenConfigOptionChoices(thoughtOpt);
    const clamped = clampThoughtLevelForChoices(desiredThought, availableChoices);
    if (!clamped) {
      return {
        configOptions: latestConfigOptions,
        appliedModelId: selection.modelId,
        thoughtLevelSkipped: true,
      };
    }
    const thoughtRes = await client.setConfigOption({
      sessionId,
      configId: "thought_level",
      value: clamped,
    });
    latestConfigOptions = thoughtRes.configOptions;
    return {
      configOptions: latestConfigOptions,
      appliedModelId: selection.modelId,
      appliedThoughtLevel: clamped,
    };
  }

  const thoughtRes = await client.setConfigOption({
    sessionId,
    configId: "thought_level",
    value: resolvedThought.value,
  });
  latestConfigOptions = thoughtRes.configOptions;

  return {
    configOptions: latestConfigOptions,
    appliedModelId: selection.modelId,
    appliedThoughtLevel: resolvedThought.value,
  };
}
