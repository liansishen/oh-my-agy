/**
 * ACP 双轨模型 ID 解析与动态 configOptions 状态提取。
 * 对齐 docs/DESIGN.md 4.2.4：
 * - 轨道 1（主控）：configOptions[model] 无后缀基模型 + configOptions[thought_level]
 * - 轨道 2（兼容）：models.availableModels 带后缀完整 ID（如 gemini-4-neon-xhigh）
 * - 动态兼容 Orchestrator 等无 thought_level 的模型，以及自身含 -medium 后缀的基模型（如 gpt-oss-120b-medium）。
 */

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
    return {
      configOptions: latestConfigOptions,
      appliedModelId: selection.modelId,
      thoughtLevelSkipped: true,
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
