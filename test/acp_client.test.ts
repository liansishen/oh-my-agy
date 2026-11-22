import { describe, expect, test } from "bun:test";
import {
  AcpClient,
  type AcpChildProcess,
  type AcpExitInfo,
  type AcpSpawnFn,
  type AcpTrafficEvent,
} from "../src/acp/client.ts";
import {
  applyModelSelection,
  clampThoughtLevelForChoices,
  combineModelId,
  extractSessionControlState,
  filterOrchestratorRoleModels,
  formatShortOrchestratorModelName,
  getNextModeSelection,
  hasThoughtLevelSupport,
  inferOrchestratorDefaultExecutorModel,
  inferOrchestratorDefaultPlannerModel,
  isOrchestratorModelId,
  modelSupportsFourThoughtLevels,
  modelSupportsThoughtLevelOption,
  resolveAcpOrchestratorModelIdForPlanner,
  resolveModeSelection,
  resolveModelSelection,
  resolveOrchestratorRoleThoughtLevels,
  resolveThoughtLevel,
  resolveThoughtLevelsForModel,
  splitModelThoughtSuffix,
} from "../src/acp/model.ts";
import {
  fromFileUri,
  normalizeDisplayPath,
  sameDir,
  toFileUri,
} from "../src/acp/path.ts";
import {
  AcpRpcError,
  JSON_RPC_ERROR,
  extractContentText,
  extractNoticeText,
  extractToolExitCode,
  extractToolOutputText,
  flattenConfigOptionChoices,
  isElicitationCreateRequest,
  isKnownSessionUpdate,
  isRequestPermissionRequest,
  mapAcpToolStatusToTsp,
  mapPlanStatusToChecklist,
  type AcpIncomingRequest,
  type ConfigOption,
  type JsonRpcMessage,
  type RequestPermissionResult,
  type SessionModelState,
  type SessionModeState,
  type SessionUpdateParams,
} from "../src/acp/protocol.ts";

// ---------------------------------------------------------------------------
// 内存 Mock ACP 子进程工具（100% 离线、可控分片、可控挂起/崩溃）
// ---------------------------------------------------------------------------

interface MockAcpHarness {
  spawn: AcpSpawnFn;
  sentToServer: JsonRpcMessage[];
  spawnedCmds: string[][];
  killedSignals: Array<number | NodeJS.Signals | undefined>;
  stdinEnded: boolean;
  /** 直接向客户端 stdout 推送原始字节块（可用于任意切分测试） */
  pushStdoutBytes(bytes: Uint8Array): void;
  /** 向客户端 stdout 发送一条 NDJSON 消息 */
  sendFromServer(msg: unknown): void;
  /** 向客户端 stderr 推送原始文本 */
  pushStderr(text: string): void;
  /** 结束进程并关闭 stdout/stderr 流 */
  exitProcess(code: number): void;
  /** 注册客户端向服务端发消息时的自动处理回调 */
  onClientMessage(handler: (msg: JsonRpcMessage) => void): void;
}

function createMockAcpHarness(): MockAcpHarness {
  const encoder = new TextEncoder();
  let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let stderrCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  let exited = false;
  let stdinRemainder = "";
  let messageHandler: ((msg: JsonRpcMessage) => void) | null = null;

  const sentToServer: JsonRpcMessage[] = [];
  const spawnedCmds: string[][] = [];
  const killedSignals: Array<number | NodeJS.Signals | undefined> = [];

  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      stdoutCtrl = controller;
    },
  });

  const stderr = new ReadableStream<Uint8Array>({
    start(controller) {
      stderrCtrl = controller;
    },
  });

  const exitedPromise = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const harness: MockAcpHarness = {
    sentToServer,
    spawnedCmds,
    killedSignals,
    stdinEnded: false,
    onClientMessage(handler) {
      messageHandler = handler;
    },
    pushStdoutBytes(bytes) {
      if (!exited) {
        stdoutCtrl.enqueue(bytes);
      }
    },
    sendFromServer(msg) {
      if (!exited) {
        stdoutCtrl.enqueue(encoder.encode(`${JSON.stringify(msg)}\n`));
      }
    },
    pushStderr(text) {
      if (!exited) {
        stderrCtrl.enqueue(encoder.encode(text));
      }
    },
    exitProcess(code) {
      if (exited) return;
      exited = true;
      try {
        stdoutCtrl.close();
      } catch {
        // already closed
      }
      try {
        stderrCtrl.close();
      } catch {
        // already closed
      }
      resolveExit(code);
    },
    spawn(cmd) {
      spawnedCmds.push(cmd);
      const child: AcpChildProcess = {
        pid: 42424,
        stdin: {
          write(chunk) {
            const text =
              typeof chunk === "string"
                ? chunk
                : new TextDecoder().decode(chunk);
            stdinRemainder += text;
            let nl: number;
            while ((nl = stdinRemainder.indexOf("\n")) !== -1) {
              const line = stdinRemainder.slice(0, nl).trim();
              stdinRemainder = stdinRemainder.slice(nl + 1);
              if (!line) continue;
              const parsed = JSON.parse(line) as JsonRpcMessage;
              sentToServer.push(parsed);
              messageHandler?.(parsed);
            }
            return text.length;
          },
          flush() {},
          end() {
            harness.stdinEnded = true;
          },
        },
        stdout,
        stderr,
        exited: exitedPromise,
        kill(signal) {
          killedSignals.push(signal);
          harness.exitProcess(137);
        },
      };
      return child;
    },
  };

  return harness;
}

// ---------------------------------------------------------------------------
// 示例 ACP 配置数据（对齐 agy 1.5.13 实测结构）
// ---------------------------------------------------------------------------

function makeStandardConfigOptions(
  currentModel = "gemini-4-neon",
  currentThought = "high",
  currentMode = "default",
): ConfigOption[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: [
        { value: "gemini-4-neon", name: "Gemini 4 Neon" },
        { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
        { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
        {
          value: "gemini-pro-orchestrator-neon",
          name: "Gemini Pro Orchestrator Neon",
        },
        { value: "gpt-oss-120b-medium", name: "GPT OSS 120B Medium" },
      ],
    },
    {
      id: "thought_level",
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: currentThought,
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
        { value: "xhigh", name: "Extra High" },
      ],
    },
    {
      id: "mode",
      name: "Permission Mode",
      category: "mode",
      type: "select",
      currentValue: currentMode,
      options: [
        { value: "default", name: "Default" },
        { value: "accept-edits", name: "Accept Edits" },
        { value: "auto", name: "Auto" },
        { value: "plan", name: "Plan" },
      ],
    },
  ];
}

function makeOrchestratorConfigOptions(
  currentMode = "default",
): ConfigOption[] {
  // 切换 Orchestrator 后服务端动态移除 thought_level
  return makeStandardConfigOptions(
    "gemini-pro-orchestrator-neon",
    "high",
    currentMode,
  ).filter((opt) => opt.id !== "thought_level");
}

function makeAvailableModels(): SessionModelState {
  return {
    currentModelId: "gemini-4-neon-high",
    availableModels: [
      { modelId: "gemini-4-neon-low", name: "Gemini 4 Neon (Low)" },
      { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
      { modelId: "gemini-4-neon-xhigh", name: "Gemini 4 Neon (Extra High)" },
      { modelId: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
      { modelId: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
      {
        modelId: "gemini-pro-orchestrator-neon",
        name: "Gemini Pro Orchestrator Neon",
      },
      { modelId: "gpt-oss-120b-medium", name: "GPT OSS 120B Medium" },
    ],
  };
}

// ===========================================================================
// 1. Windows 路径标准化测试（src/acp/path.ts）
// ===========================================================================

describe("src/acp/path.ts Windows 路径标准化与跨平台对比", () => {
  test("normalizeDisplayPath 在 Windows 上剥离 /D:/... 与 File /D:/... 并转换分隔符", () => {
    expect(normalizeDisplayPath("/D:/Projects/oh-my-agy", true)).toBe(
      "D:\\Projects\\oh-my-agy",
    );
    expect(
      normalizeDisplayPath("/d:/Projects/oh-my-agy/src/acp/path.ts", true),
    ).toBe("d:\\Projects\\oh-my-agy\\src\\acp\\path.ts");
    expect(
      normalizeDisplayPath("File /D:/Projects/oh-my-agy/README.md", true),
    ).toBe("File D:\\Projects\\oh-my-agy\\README.md");
    expect(
      normalizeDisplayPath("File /D:/My Projects/oh my agy/a b.ts", true),
    ).toBe("File D:\\My Projects\\oh my agy\\a b.ts");
    expect(
      normalizeDisplayPath("Read /C:/Users/demo/notes.md", true),
    ).toBe("Read C:\\Users\\demo\\notes.md");
    expect(
      normalizeDisplayPath("D:/Projects/oh-my-agy/package.json", true),
    ).toBe("D:\\Projects\\oh-my-agy\\package.json");
    // 不破坏 file:/// URI 或普通文本
    expect(
      normalizeDisplayPath("file:///D:/Projects/oh-my-agy/README.md", true),
    ).toBe("file:///D:/Projects/oh-my-agy/README.md");
  });

  test("normalizeDisplayPath 在 POSIX 上原样保留路径", () => {
    expect(normalizeDisplayPath("/usr/local/bin/agy", false)).toBe(
      "/usr/local/bin/agy",
    );
    expect(normalizeDisplayPath("/D:/Projects/oh-my-agy", false)).toBe(
      "/D:/Projects/oh-my-agy",
    );
    expect(normalizeDisplayPath("File /D:/Projects/a.ts", false)).toBe(
      "File /D:/Projects/a.ts",
    );
  });

  test("sameDir 跨平台大小写与分隔符安全对比", () => {
    // Windows：忽略前导斜杠、正反斜杠、末尾斜杠、大小写与 ..
    expect(
      sameDir("/D:/Projects/oh-my-agy", "D:\\Projects\\oh-my-agy\\", true),
    ).toBe(true);
    expect(
      sameDir("/d:/projects/oh-my-agy/", "D:\\Projects\\OH-MY-AGY", true),
    ).toBe(true);
    expect(
      sameDir(
        "D:\\Projects\\sub\\..\\oh-my-agy",
        "/D:/Projects/oh-my-agy",
        true,
      ),
    ).toBe(true);
    expect(sameDir("/d:/", "D:\\", true)).toBe(true);
    expect(
      sameDir("D:\\Projects\\oh-my-agy", "D:\\Projects\\other", true),
    ).toBe(false);
    expect(sameDir("", "D:\\Projects\\oh-my-agy", true)).toBe(false);

    // POSIX：大小写敏感，但忽略末尾斜杠与规范化
    expect(sameDir("/home/user/proj/", "/home/user/proj", false)).toBe(true);
    expect(sameDir("/home/User/proj", "/home/user/proj", false)).toBe(false);
  });

  test("toFileUri 与 fromFileUri 正确转换 Windows/POSIX/含空格与中文路径", () => {
    expect(toFileUri("D:\\Projects\\oh-my-agy\\README.md", true)).toBe(
      "file:///D:/Projects/oh-my-agy/README.md",
    );
    expect(toFileUri("D:\\", true)).toBe("file:///D:/");
    expect(toFileUri("D:", true)).toBe("file:///D:/");
    expect(toFileUri("/D:/Projects/oh-my-agy/README.md", true)).toBe(
      "file:///D:/Projects/oh-my-agy/README.md",
    );
    expect(toFileUri("D:\\My Docs\\设计 #1.md", true)).toBe(
      "file:///D:/My%20Docs/%E8%AE%BE%E8%AE%A1%20%231.md",
    );
    expect(
      fromFileUri("file:///D:/My%20Docs/%E8%AE%BE%E8%AE%A1%20%231.md", true),
    ).toBe("D:\\My Docs\\设计 #1.md");

    expect(toFileUri("/home/user/my file.ts", false)).toBe(
      "file:///home/user/my%20file.ts",
    );
    expect(fromFileUri("file:///home/user/my%20file.ts", false)).toBe(
      "/home/user/my file.ts",
    );
    expect(toFileUri("\\\\fileserver\\share\\doc.txt", true)).toBe(
      "file://fileserver/share/doc.txt",
    );
  });
});

// ===========================================================================
// 2. 双轨模型 ID 解析与动态 configOptions 测试（src/acp/model.ts）
// ===========================================================================

describe("src/acp/model.ts 双轨模型 ID 与动态 configOptions", () => {
  test("精确匹配基模型且保护自带 -medium 后缀的 gpt-oss-120b-medium 不被误拆", () => {
    const configOptions = makeStandardConfigOptions();
    const models = makeAvailableModels();

    const baseHit = resolveModelSelection("gemini-4-neon", {
      configOptions,
      models,
    });
    expect(baseHit).toEqual({
      strategy: "config_option",
      modelId: "gemini-4-neon",
      modelName: "Gemini 4 Neon",
      matchKind: "exact_config_model",
    });

    const gptOss = resolveModelSelection("gpt-oss-120b-medium", {
      configOptions,
      models,
    });
    expect(gptOss).toEqual({
      strategy: "config_option",
      modelId: "gpt-oss-120b-medium",
      modelName: "GPT OSS 120B Medium",
      matchKind: "exact_config_model",
    });
    expect(gptOss?.thoughtLevel).toBeUndefined();
  });

  test("按模型真实能力解析思考档位（neon/hydrogen 4 档、其余 3 档、orchestrator/gpt-oss 0 档）并支持缓存与安全降档", () => {
    expect(isOrchestratorModelId("gemini-pro-orchestrator-neon")).toBe(true);
    expect(isOrchestratorModelId("gemini-4-neon")).toBe(false);
    expect(modelSupportsFourThoughtLevels("gemini-4-neon")).toBe(true);
    expect(modelSupportsFourThoughtLevels("gemini-4-hydrogen")).toBe(true);
    expect(modelSupportsFourThoughtLevels("gemini-4-carbon")).toBe(false);
    expect(modelSupportsFourThoughtLevels("gemini-4-argon")).toBe(false);
    expect(modelSupportsFourThoughtLevels("claude-opus-5-5")).toBe(false);
    expect(modelSupportsFourThoughtLevels("gemini-pro-orchestrator-neon")).toBe(false);
    expect(modelSupportsThoughtLevelOption("gemini-pro-orchestrator-neon")).toBe(false);
    expect(modelSupportsThoughtLevelOption("gpt-oss-120b-medium")).toBe(false);
    expect(modelSupportsThoughtLevelOption("gemini-4-carbon")).toBe(true);

    const activeNeon = extractSessionControlState({
      configOptions: makeStandardConfigOptions("gemini-4-neon", "xhigh"),
    });
    expect(resolveThoughtLevelsForModel("gemini-4-neon", activeNeon).map((c) => c.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(resolveThoughtLevelsForModel("gemini-4-hydrogen", activeNeon).map((c) => c.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(resolveThoughtLevelsForModel("gemini-4-carbon", activeNeon).map((c) => c.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(resolveThoughtLevelsForModel("claude-opus-5-5", activeNeon).map((c) => c.value)).toEqual([
      "low",
      "medium",
      "high",
    ]);
    expect(resolveThoughtLevelsForModel("gemini-pro-orchestrator-neon", activeNeon)).toEqual([]);
    expect(resolveThoughtLevelsForModel("gpt-oss-120b-medium", activeNeon)).toEqual([]);

    // 权威服务端缓存优先于静态推导
    const cached = {
      "gemini-4-carbon": [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    };
    expect(resolveThoughtLevelsForModel("gemini-4-carbon", activeNeon, cached).map((c) => c.value)).toEqual([
      "low",
      "high",
    ]);

    // 从 xhigh 切到 3 档模型自动安全钳位至 high
    const threeChoices = resolveThoughtLevelsForModel("gemini-4-carbon", activeNeon);
    expect(clampThoughtLevelForChoices("xhigh", threeChoices)).toBe("high");
    expect(clampThoughtLevelForChoices("medium", threeChoices)).toBe("medium");
    expect(clampThoughtLevelForChoices("high", [])).toBeUndefined();

    // Orchestrator 角色严格白名单过滤（Planner 4 选 1 / Executor 2 选 1）、短名格式化与 ACP 变体映射
    const fullModels = [
      { value: "gemini-4-neon", name: "Gemini 4 Neon" },
      { value: "gemini-4-carbon", name: "Gemini 4 Carbon" },
      { value: "gemini-4-argon", name: "Gemini 4 Argon" },
      { value: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
      { value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
      { value: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { value: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { value: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
      { value: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)" },
      { value: "gemini-pro-orchestrator-argon", name: "Orchestrator (Argon)" },
      { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    ];
    expect(filterOrchestratorRoleModels("planner", fullModels).map((c) => c.value)).toEqual([
      "gemini-4-neon",
      "gemini-4-carbon",
      "gemini-4-argon",
      "claude-opus-5-5",
    ]);
    expect(filterOrchestratorRoleModels("executor", fullModels).map((c) => c.value)).toEqual([
      "gemini-4-hydrogen",
      "claude-sonnet-5-5",
    ]);
    expect(formatShortOrchestratorModelName("Gemini 4 Carbon")).toBe("Carbon");
    expect(formatShortOrchestratorModelName("Gemini 4 Hydrogen")).toBe("Hydrogen");
    expect(formatShortOrchestratorModelName("Claude Opus 5.5")).toBe("Opus 5.5");
    expect(formatShortOrchestratorModelName("Claude Sonnet 5.5")).toBe("Sonnet 5.5");

    expect(inferOrchestratorDefaultPlannerModel("gemini-pro-orchestrator-neon")).toEqual({
      modelId: "gemini-4-neon",
      modelName: "Gemini 4 Neon",
    });
    expect(inferOrchestratorDefaultPlannerModel("gemini-pro-orchestrator")).toEqual({
      modelId: "gemini-4-carbon",
      modelName: "Gemini 4 Carbon",
    });
    expect(inferOrchestratorDefaultExecutorModel("gemini-pro-orchestrator")).toEqual({
      modelId: "gemini-4-hydrogen",
      modelName: "Gemini 4 Hydrogen",
    });
    expect(resolveAcpOrchestratorModelIdForPlanner("gemini-4-neon", fullModels)).toBe(
      "gemini-pro-orchestrator-neon",
    );
    expect(resolveAcpOrchestratorModelIdForPlanner("gemini-4-argon", fullModels)).toBe(
      "gemini-pro-orchestrator-argon",
    );
    expect(resolveAcpOrchestratorModelIdForPlanner("claude-opus-5-5", fullModels)).toBe(
      "gemini-pro-orchestrator",
    );

    expect(
      resolveOrchestratorRoleThoughtLevels("planner", activeNeon, undefined, "Gemini 4 Neon").map(
        (c) => c.value,
      ),
    ).toEqual(["low", "medium", "high", "xhigh"]);
    expect(
      resolveOrchestratorRoleThoughtLevels("planner", activeNeon, undefined, "Claude Opus 5.5").map(
        (c) => c.value,
      ),
    ).toEqual(["low", "medium", "high"]);
    expect(
      resolveOrchestratorRoleThoughtLevels("executor", activeNeon, undefined, "Gemini 4 Hydrogen").map(
        (c) => c.value,
      ),
    ).toEqual(["low", "medium", "high", "xhigh"]);
    expect(
      resolveOrchestratorRoleThoughtLevels("executor", activeNeon, undefined, "Claude Sonnet 5.5").map(
        (c) => c.value,
      ),
    ).toEqual(["low", "medium", "high"]);
  });

  test("带思考档位后缀的组合 ID（availableModels 轨道与直接拆分）正确拆分为基模型 + thought_level", () => {
    const configOptions = makeStandardConfigOptions();
    const models = makeAvailableModels();

    // 命中 availableModels 列表中的组合 ID
    const xhigh = resolveModelSelection("gemini-4-neon-xhigh", {
      configOptions,
      models,
    });
    expect(xhigh).toEqual({
      strategy: "config_option",
      modelId: "gemini-4-neon",
      modelName: "Gemini 4 Neon",
      thoughtLevel: "xhigh",
      matchKind: "available_model_mapped",
    });

    const opusMed = resolveModelSelection("claude-opus-5-5-medium", {
      configOptions,
      models,
    });
    expect(opusMed).toEqual({
      strategy: "config_option",
      modelId: "claude-opus-5-5",
      modelName: "Claude Opus 5.5",
      thoughtLevel: "medium",
      matchKind: "available_model_mapped",
    });

    // 未在 availableModels 列出但可拆分 <base>-<level>
    const carbonLow = resolveModelSelection("gemini-4-carbon-low", {
      configOptions,
      models,
    });
    expect(carbonLow).toEqual({
      strategy: "config_option",
      modelId: "gemini-4-carbon",
      modelName: "Gemini 4 Carbon",
      thoughtLevel: "low",
      matchKind: "split_with_thought_level",
    });

    // 模糊匹配基名 + 后缀
    const fuzzyWithLevel = resolveModelSelection("opus-xhigh", {
      configOptions,
      models,
    });
    expect(fuzzyWithLevel?.modelId).toBe("claude-opus-5-5");
    expect(fuzzyWithLevel?.thoughtLevel).toBe("xhigh");
  });

  test("splitModelThoughtSuffix 优先识别 xhigh 而非 high", () => {
    expect(splitModelThoughtSuffix("gemini-4-neon-xhigh")).toEqual({
      baseModelId: "gemini-4-neon",
      thoughtLevel: "xhigh",
    });
    expect(splitModelThoughtSuffix("gemini-4-neon-high")).toEqual({
      baseModelId: "gemini-4-neon",
      thoughtLevel: "high",
    });
  });

  test("动态兼容 Orchestrator 移除 thought_level 与恢复支持", () => {
    const stdState = extractSessionControlState({
      configOptions: makeStandardConfigOptions(),
    });
    expect(stdState.supportsThoughtLevel).toBe(true);
    expect(stdState.currentModelId).toBe("gemini-4-neon");
    expect(stdState.currentThoughtLevel).toBe("high");
    expect(stdState.availableThoughtLevels.map((o) => o.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);

    const orchOptions = makeOrchestratorConfigOptions();
    expect(hasThoughtLevelSupport(orchOptions)).toBe(false);
    const orchState = extractSessionControlState({
      configOptions: orchOptions,
    });
    expect(orchState.supportsThoughtLevel).toBe(false);
    expect(orchState.currentModelId).toBe("gemini-pro-orchestrator-neon");
    expect(orchState.currentThoughtLevel).toBeNull();
    expect(orchState.availableThoughtLevels).toEqual([]);

    // 当前模型不支持 thought_level 时明确返回 unsupported
    expect(resolveThoughtLevel("high", orchOptions)).toEqual({
      ok: false,
      reason: "unsupported",
      available: [],
    });

    // 即便当前处在 Orchestrator（无 thought_level），切回 gemini-4-neon-xhigh 仍可拆出双步参数
    const switchBack = resolveModelSelection("gemini-4-neon-xhigh", {
      configOptions: orchOptions,
      models: makeAvailableModels(),
    });
    expect(switchBack?.modelId).toBe("gemini-4-neon");
    expect(switchBack?.thoughtLevel).toBe("xhigh");
  });

  test("无 configOptions 时降级 legacy_set_model / legacy_set_mode 与循环切模式", () => {
    const legacyModels = makeAvailableModels();
    const legacyModes: SessionModeState = {
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "auto", name: "Auto" },
        { id: "plan", name: "Plan" },
      ],
    };

    const res = resolveModelSelection("gemini-4-neon-xhigh", {
      models: legacyModels,
    });
    expect(res).toEqual({
      strategy: "legacy_set_model",
      modelId: "gemini-4-neon-xhigh",
      modelName: "Gemini 4 Neon (Extra High)",
      matchKind: "legacy_exact",
    });

    expect(resolveModeSelection("auto", { modes: legacyModes })).toEqual({
      strategy: "legacy_set_mode",
      modeId: "auto",
      modeName: "Auto",
    });

    expect(getNextModeSelection({ modes: legacyModes })).toEqual({
      strategy: "legacy_set_mode",
      modeId: "auto",
      modeName: "Auto",
    });

    expect(
      combineModelId("gemini-4-neon", "xhigh", legacyModels.availableModels),
    ).toBe("gemini-4-neon-xhigh");
    expect(
      combineModelId(
        "gpt-oss-120b-medium",
        "high",
        legacyModels.availableModels,
      ),
    ).toBe("gpt-oss-120b-medium");
  });
});

// ===========================================================================
// 3. Protocol 状态映射与数据提取测试（src/acp/protocol.ts）
// ===========================================================================

describe("src/acp/protocol.ts tool_call 状态、exit_code 与辅助函数", () => {
  test("mapAcpToolStatusToTsp 全状态与优先级映射", () => {
    expect(mapAcpToolStatusToTsp("pending")).toBe("pending");
    expect(mapAcpToolStatusToTsp("in_progress")).toBe("running");
    expect(mapAcpToolStatusToTsp("completed")).toBe("done");
    expect(mapAcpToolStatusToTsp("failed")).toBe("error");
    expect(mapAcpToolStatusToTsp(undefined)).toBe("pending");

    // 存在未决权限请求优先覆盖为 ask
    expect(
      mapAcpToolStatusToTsp("in_progress", { awaitingPermission: true }),
    ).toBe("ask");
    // cancelled 优先级最高
    expect(
      mapAcpToolStatusToTsp("in_progress", {
        awaitingPermission: true,
        cancelled: true,
      }),
    ).toBe("cancelled");
  });

  test("extractToolExitCode 与 extractToolOutputText 正确解析 run_command 实测输出", () => {
    expect(extractToolExitCode({ output: "ok\n", exit_code: 0 })).toBe(0);
    expect(extractToolExitCode({ output: "not found", exit_code: 127 })).toBe(
      127,
    );
    expect(extractToolExitCode({ exitCode: 2 })).toBe(2);
    expect(extractToolExitCode({ output: "no exit code" })).toBeUndefined();
    expect(extractToolExitCode("plain string")).toBeUndefined();
    expect(extractToolExitCode(null)).toBeUndefined();

    expect(extractToolOutputText({ output: "hello world", exit_code: 0 })).toBe(
      "hello world",
    );
    expect(extractToolOutputText({ stdout: "out", stderr: "err" })).toBe(
      "out\nerr",
    );
    expect(extractToolOutputText("raw text")).toBe("raw text");
  });

  test("plan 状态映射、分组 configOptions 展平、内容文本提取与认证错误判断", () => {
    expect(mapPlanStatusToChecklist("pending")).toBe("pending");
    expect(mapPlanStatusToChecklist("in_progress")).toBe("active");
    expect(mapPlanStatusToChecklist("completed")).toBe("done");

    const grouped: ConfigOption = {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "a",
      options: [
        { group: "g1", name: "Group 1", options: [{ value: "a", name: "A" }] },
        { value: "b", name: "B" },
      ],
    };
    expect(flattenConfigOptionChoices(grouped).map((c) => c.value)).toEqual([
      "a",
      "b",
    ]);

    expect(extractContentText({ type: "text", text: "abc" })).toBe("abc");
    expect(
      extractContentText({
        type: "resource",
        resource: { uri: "file:///a.ts", text: "const x = 1;" },
      }),
    ).toBe("const x = 1;");
    expect(
      extractNoticeText({
        sessionUpdate: "compaction_update",
        message: "Compacting context...",
      }),
    ).toBe("Compacting context...");

    expect(
      isKnownSessionUpdate({
        sessionUpdate: "usage_update",
        used: 100,
        size: 1000,
      }),
    ).toBe(true);
    expect(isKnownSessionUpdate({ sessionUpdate: "future_custom_event" })).toBe(
      false,
    );

    expect(
      new AcpRpcError(JSON_RPC_ERROR.AUTH_REQUIRED, "Auth needed").isAuthRequired(),
    ).toBe(true);
    expect(
      new AcpRpcError(-32603, "User is not logged in").isAuthRequired(),
    ).toBe(true);
    expect(
      new AcpRpcError(-32602, "Invalid params").isAuthRequired(),
    ).toBe(false);
  });
});

// ===========================================================================
// 4. AcpClient 协议流、大行切分、竞态、回放、动态配置与崩溃测试
// ===========================================================================

describe("src/acp/client.ts Mock ACP 端到端协议测试", () => {
  test("大 JSON 行 (>1.2MB) 跨不规则字节与多字节 UTF-8 边界分片读取无损解析", async () => {
    const harness = createMockAcpHarness();
    const receivedUpdates: SessionUpdateParams[] = [];
    const trafficEvents: AcpTrafficEvent[] = [];

    const client = new AcpClient({
      spawn: harness.spawn,
      onUpdate: (u) => {
        receivedUpdates.push(u);
      },
      onTraffic: (ev) => {
        trafficEvents.push(ev);
      },
    });
    client.start();

    // 构造超过 1.2MB 且含中文与 Emoji 的单行 JSON 通知
    const unit = "你好世界🚀ACP大行分片测试-0123456789abcdef\n";
    const bigText = unit.repeat(24_000); // > 1.3MB UTF-8 bytes
    const notification = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-big",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tc-big",
          status: "completed",
          kind: "execute",
          name: "run_command",
          rawOutput: { output: bigText, exit_code: 0 },
          content: [{ type: "content", content: { type: "text", text: bigText } }],
        },
      },
    };

    const rawBytes = new TextEncoder().encode(
      `not-a-json-noise-line\n${JSON.stringify(notification)}\n`,
    );
    expect(rawBytes.byteLength).toBeGreaterThan(1_200_000);

    // 故意使用非 4 的倍数 1021 字节切片，刻意劈开多字节中文与 Emoji 代理对
    const chunkSize = 1021;
    for (let offset = 0; offset < rawBytes.byteLength; offset += chunkSize) {
      harness.pushStdoutBytes(
        rawBytes.subarray(offset, Math.min(offset + chunkSize, rawBytes.byteLength)),
      );
    }

    // 再紧跟一个 initialize 请求确认杂讯行和大行后读循环仍完全健康
    harness.onClientMessage((msg) => {
      if ("id" in msg && "method" in msg && msg.method === "initialize") {
        harness.sendFromServer({
          jsonrpc: "2.0",
          id: msg.id,
          result: { protocolVersion: 1, agentInfo: { name: "agy", version: "1.5.13" } },
        });
      }
    });

    const initRes = await client.initialize();
    expect(initRes.agentInfo?.version).toBe("1.5.13");
    expect(receivedUpdates).toHaveLength(1);

    const upd = receivedUpdates[0]!.update;
    expect(upd.sessionUpdate).toBe("tool_call_update");
    if (upd.sessionUpdate === "tool_call_update") {
      expect(upd.toolCallId).toBe("tc-big");
      expect(mapAcpToolStatusToTsp(upd.status)).toBe("done");
      expect(extractToolExitCode(upd.rawOutput)).toBe(0);
      expect(extractToolOutputText(upd.rawOutput)).toBe(bigText);
    }

    // 杂讯行被记为 parse_error 而不崩溃
    expect(trafficEvents.some((e) => e.kind === "parse_error")).toBe(true);

    await client.close({ timeoutMs: 50 });
  });

  test("并发 session/request_permission + session/cancel 竞态与先答复 cancelled 再发 cancel", async () => {
    const harness = createMockAcpHarness();
    const events: string[] = [];
    const serverTimeline: string[] = [];

    let pendingPermResolve: ((res: RequestPermissionResult) => void) | null =
      null;
    let promptReqId: number | string | null = null;

    harness.onClientMessage((msg) => {
      if ("method" in msg && "id" in msg) {
        if (msg.method === "session/prompt") {
          promptReqId = msg.id;
          // 1. 先推 tool_call 通知，紧接着推反向权限请求
          harness.sendFromServer({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "sess-1",
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc-exec-1",
                status: "pending",
                kind: "execute",
                name: "run_command",
                title: "rm -rf build",
                locations: [{ path: "/D:/Projects/oh-my-agy/build" }],
              },
            },
          });
          harness.sendFromServer({
            jsonrpc: "2.0",
            id: "perm-99",
            method: "session/request_permission",
            params: {
              sessionId: "sess-1",
              toolCall: {
                toolCallId: "tc-exec-1",
                title: "rm -rf build",
                kind: "execute",
              },
              options: [
                { optionId: "opt-allow", name: "Allow once", kind: "allow_once" },
                { optionId: "opt-always", name: "Always allow", kind: "allow_always" },
                { optionId: "opt-deny", name: "Reject", kind: "reject_once" },
              ],
            },
          });
          // 2. 权限等待期间服务端继续发送其他 update，验证读循环不被反向请求阻塞
          harness.sendFromServer({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "sess-1",
              update: {
                sessionUpdate: "usage_update",
                used: 12345,
                size: 1048576,
              },
            },
          });
        }
      } else if ("id" in msg && msg.id === "perm-99" && "result" in msg) {
        serverTimeline.push(
          `perm_reply:${(msg.result as RequestPermissionResult).outcome.outcome}`,
        );
      } else if ("method" in msg && !("id" in msg) && msg.method === "session/cancel") {
        serverTimeline.push("session/cancel");
        if (promptReqId !== null) {
          harness.sendFromServer({
            jsonrpc: "2.0",
            id: promptReqId,
            result: { stopReason: "cancelled" },
          });
        }
      }
    });

    let permArrived!: () => void;
    const permArrivedPromise = new Promise<void>((r) => {
      permArrived = r;
    });
    let usageArrived!: () => void;
    const usageArrivedPromise = new Promise<void>((r) => {
      usageArrived = r;
    });

    const client = new AcpClient({
      spawn: harness.spawn,
      onUpdate: (params) => {
        events.push(`update:${params.update.sessionUpdate}`);
        if (params.update.sessionUpdate === "usage_update") {
          usageArrived();
        }
      },
      onServerRequest: (req: AcpIncomingRequest) => {
        if (isRequestPermissionRequest(req)) {
          events.push(`server_req:${req.method}:${req.params.toolCall.toolCallId}`);
          permArrived();
          return new Promise<RequestPermissionResult>((resolve) => {
            pendingPermResolve = resolve;
          });
        }
        return undefined;
      },
    });
    client.start();

    const promptPromise = client.prompt({
      sessionId: "sess-1",
      prompt: [{ type: "text", text: "clean build" }],
    });

    // 等待权限弹窗到达，同时确认后续 usage_update 在审批挂起期间照常送达（未死锁）
    await permArrivedPromise;
    await usageArrivedPromise;
    expect(events).toEqual([
      "update:tool_call",
      "server_req:session/request_permission:tc-exec-1",
      "update:usage_update",
    ]);

    // 模拟用户按 Esc：先答复权限请求 cancelled，再发送 session/cancel
    pendingPermResolve!({ outcome: { outcome: "cancelled" } });
    // 等一个微任务让 cancelled 响应先排入写入队列，再发 cancel（同 controller.ts 顺序）
    await Promise.resolve();
    await client.cancel("sess-1");

    const promptRes = await promptPromise;
    expect(promptRes.stopReason).toBe("cancelled");
    expect(serverTimeline).toEqual(["perm_reply:cancelled", "session/cancel"]);

    await client.close({ timeoutMs: 50 });
  });

  test("elicitation/create 反向表单请求与未知反向请求返回 -32601", async () => {
    const harness = createMockAcpHarness();
    const replies = new Map<string | number, JsonRpcMessage>();

    harness.onClientMessage((msg) => {
      if ("id" in msg && !("method" in msg) && msg.id !== null) {
        replies.set(msg.id, msg);
      }
    });

    const client = new AcpClient({
      spawn: harness.spawn,
      onServerRequest: (req) => {
        if (isElicitationCreateRequest(req)) {
          return {
            action: "accept",
            content: { framework: "bun", confirm: true },
          };
        }
        throw new AcpRpcError(
          JSON_RPC_ERROR.METHOD_NOT_FOUND,
          `Unsupported: ${req.method}`,
        );
      },
    });
    client.start();

    harness.sendFromServer({
      jsonrpc: "2.0",
      id: "elic-1",
      method: "elicitation/create",
      params: {
        mode: "form",
        message: "Choose stack",
        requestedSchema: {
          type: "object",
          properties: {
            framework: { type: "string", enum: ["bun", "node"] },
            confirm: { type: "boolean" },
          },
          required: ["framework"],
        },
      },
    });
    harness.sendFromServer({
      jsonrpc: "2.0",
      id: "unknown-2",
      method: "fs/read_text_file",
      params: { path: "/etc/hosts" },
    });

    await Bun.sleep(20);
    const r1 = replies.get("elic-1");
    expect(r1 && "result" in r1 ? r1.result : null).toEqual({
      action: "accept",
      content: { framework: "bun", confirm: true },
    });
    const r2 = replies.get("unknown-2");
    expect(r2 && "error" in r2 ? r2.error.code : null).toBe(
      JSON_RPC_ERROR.METHOD_NOT_FOUND,
    );

    await client.close({ timeoutMs: 50 });
  });

  test("session/load 历史流式回放严格先于 RPC 响应全部交付，含 diff 块与 usage_update", async () => {
    const harness = createMockAcpHarness();
    const replayLog: string[] = [];

    harness.onClientMessage((msg) => {
      if ("id" in msg && "method" in msg && msg.method === "session/load") {
        const sid = (msg.params as { sessionId: string }).sessionId;
        const updates = [
          {
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "refactor path.ts" },
          },
          {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Let me check Windows drive paths." },
          },
          {
            sessionUpdate: "tool_call",
            toolCallId: "tc-edit-1",
            status: "in_progress",
            kind: "edit",
            name: "edit_file",
            title: "File /D:/Projects/oh-my-agy/src/acp/path.ts",
          },
          {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-edit-1",
            status: "completed",
            content: [
              {
                type: "diff",
                path: "/D:/Projects/oh-my-agy/src/acp/path.ts",
                oldText: "return raw;",
                newText: "return normalize(raw);",
              },
            ],
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Done." },
          },
          {
            sessionUpdate: "usage_update",
            used: 280321,
            size: 1048576,
          },
        ];

        for (const update of updates) {
          harness.sendFromServer({
            jsonrpc: "2.0",
            method: "session/update",
            params: { sessionId: sid, update },
          });
        }
        harness.sendFromServer({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            sessionId: sid,
            configOptions: makeStandardConfigOptions(),
            models: makeAvailableModels(),
          },
        });
      }
    });

    const client = new AcpClient({
      spawn: harness.spawn,
      // 刻意使用异步 onUpdate 验证派发保序屏障
      onUpdate: async (params) => {
        await Bun.sleep(2);
        replayLog.push(params.update.sessionUpdate);
        if (
          params.update.sessionUpdate === "tool_call_update" &&
          params.update.content?.[0]?.type === "diff"
        ) {
          expect(
            normalizeDisplayPath(params.update.content[0].path, true),
          ).toBe("D:\\Projects\\oh-my-agy\\src\\acp\\path.ts");
        }
      },
    });
    client.start();

    const loaded = await client.loadSession({
      sessionId: "sess-history-1",
      cwd: "D:\\Projects\\oh-my-agy",
    });

    // loadSession resolve 瞬间，全部 6 条异步历史回放必须已经严格按序交付完毕
    expect(replayLog).toEqual([
      "user_message_chunk",
      "agent_thought_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "usage_update",
    ]);
    expect(loaded.sessionId).toBe("sess-history-1");
    expect(client.currentSessionId).toBe("sess-history-1");

    await client.close({ timeoutMs: 50 });
  });

  test("动态切换 Orchestrator 移除 thought_level 后，再通过双轨 ID 切回基模型 + thought_level", async () => {
    const harness = createMockAcpHarness();
    let currentOptions = makeStandardConfigOptions();
    const rpcCalls: Array<{ configId: string; value: string }> = [];

    harness.onClientMessage((msg) => {
      if (
        "id" in msg &&
        "method" in msg &&
        msg.method === "session/set_config_option"
      ) {
        const p = msg.params as {
          sessionId: string;
          configId: string;
          value: string;
        };
        rpcCalls.push({ configId: p.configId, value: p.value });

        if (p.configId === "model") {
          currentOptions =
            p.value === "gemini-pro-orchestrator-neon"
              ? makeOrchestratorConfigOptions()
              : makeStandardConfigOptions(p.value, "medium");
        } else if (p.configId === "thought_level") {
          currentOptions = makeStandardConfigOptions(
            currentOptions.find((o) => o.id === "model")?.currentValue ??
              "gemini-4-neon",
            p.value,
          );
        }

        harness.sendFromServer({
          jsonrpc: "2.0",
          id: msg.id,
          result: { configOptions: currentOptions },
        });
      }
    });

    const client = new AcpClient({ spawn: harness.spawn });
    client.start();

    // 1. 切到 Orchestrator（服务端动态移除 thought_level）
    const selOrch = resolveModelSelection("gemini-pro-orchestrator-neon", {
      configOptions: currentOptions,
      models: makeAvailableModels(),
    });
    expect(selOrch).not.toBeNull();
    const res1 = await applyModelSelection(client, "sess-1", selOrch!, "high");
    expect(hasThoughtLevelSupport(res1.configOptions)).toBe(false);
    expect(res1.thoughtLevelSkipped).toBe(true);
    expect(rpcCalls).toEqual([
      { configId: "model", value: "gemini-pro-orchestrator-neon" },
    ]);

    // 2. 在 Orchestrator 状态（无 thought_level）下输入带后缀组合 ID gemini-4-neon-xhigh
    const selBack = resolveModelSelection("gemini-4-neon-xhigh", {
      configOptions: res1.configOptions,
      models: makeAvailableModels(),
    });
    expect(selBack?.modelId).toBe("gemini-4-neon");
    expect(selBack?.thoughtLevel).toBe("xhigh");

    const res2 = await applyModelSelection(client, "sess-1", selBack!);
    expect(hasThoughtLevelSupport(res2.configOptions)).toBe(true);
    expect(res2.appliedModelId).toBe("gemini-4-neon");
    expect(res2.appliedThoughtLevel).toBe("xhigh");
    expect(rpcCalls).toEqual([
      { configId: "model", value: "gemini-pro-orchestrator-neon" },
      { configId: "model", value: "gemini-4-neon" },
      { configId: "thought_level", value: "xhigh" },
    ]);

    await client.close({ timeoutMs: 50 });
  });

  test("listAllSessions 自动翻页并在本地用 sameDir 精准过滤 Windows /D:/... 目录", async () => {
    const harness = createMockAcpHarness();

    harness.onClientMessage((msg) => {
      if ("id" in msg && "method" in msg && msg.method === "session/list") {
        const cursor = (msg.params as { cursor?: string })?.cursor;
        if (!cursor) {
          harness.sendFromServer({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              sessions: [
                {
                  sessionId: "s1",
                  cwd: "/D:/Projects/oh-my-agy",
                  title: "First",
                },
                {
                  sessionId: "s2",
                  cwd: "/D:/Projects/other-repo",
                  title: "Other",
                },
              ],
              nextCursor: "page-2",
            },
          });
        } else {
          harness.sendFromServer({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              sessions: [
                {
                  sessionId: "s3",
                  cwd: "d:\\projects\\OH-MY-AGY\\",
                  title: "Third",
                },
              ],
              nextCursor: null,
            },
          });
        }
      }
    });

    const client = new AcpClient({ spawn: harness.spawn });
    client.start();

    const all = await client.listAllSessions();
    expect(all.map((s) => s.sessionId)).toEqual(["s1", "s2", "s3"]);

    // 在 Windows 环境测试 sameDir 过滤（或全平台直接验证本地过滤行为）
    if (process.platform === "win32") {
      const filtered = await client.listAllSessions({
        cwd: "D:\\Projects\\oh-my-agy",
      });
      expect(filtered.map((s) => s.sessionId)).toEqual(["s1", "s3"]);
    }

    await client.close({ timeoutMs: 50 });
  });

  test("子进程意外崩溃时收集 stderr 尾部、reject 未决 RPC 并触发 onExit(expected=false)", async () => {
    const harness = createMockAcpHarness();
    const exits: AcpExitInfo[] = [];
    const stderrSeen: string[] = [];

    let exitNotified!: () => void;
    const exitNotifiedPromise = new Promise<void>((r) => {
      exitNotified = r;
    });

    const client = new AcpClient({
      spawn: harness.spawn,
      onStderr: (line) => stderrSeen.push(line),
      onExit: (info) => {
        exits.push(info);
        exitNotified();
      },
    });
    client.start();

    const pendingPrompt = client.prompt({
      sessionId: "sess-crash",
      prompt: [{ type: "text", text: "trigger crash" }],
    });

    harness.pushStderr("WARN preparing backend\n");
    harness.pushStderr("FATAL panic: broken language server pipe\n");
    harness.exitProcess(137);

    await expect(pendingPrompt).rejects.toThrow(/code 137/);
    await exitNotifiedPromise;

    expect(exits).toHaveLength(1);
    expect(exits[0]!.expected).toBe(false);
    expect(exits[0]!.code).toBe(137);
    expect(exits[0]!.stderrTail).toContain("FATAL panic: broken language server pipe");
    expect(stderrSeen).toEqual([
      "WARN preparing backend",
      "FATAL panic: broken language server pipe",
    ]);
    expect(client.isRunning).toBe(false);
  });

  test("优雅 close() 发送 session/close，超时未退出时调用 proc.kill() 强杀", async () => {
    const harness = createMockAcpHarness();
    const exits: AcpExitInfo[] = [];

    harness.onClientMessage((msg) => {
      if ("id" in msg && "method" in msg && msg.method === "session/new") {
        harness.sendFromServer({
          jsonrpc: "2.0",
          id: msg.id,
          result: { sessionId: "sess-hang" },
        });
      }
      // 刻意不响应 session/close 且不退出子进程，模拟僵尸/卡死后端
    });

    const client = new AcpClient({
      spawn: harness.spawn,
      extraArgs: ["--add-dir", "D:\\Extra"],
      closeTimeoutMs: 60,
      onExit: (info) => exits.push(info),
    });
    client.start();

    expect(harness.spawnedCmds[0]).toEqual([
      "agy",
      "acp",
      "--add-dir",
      "D:\\Extra",
    ]);

    await client.newSession({ cwd: "D:\\Projects\\oh-my-agy" });
    expect(client.currentSessionId).toBe("sess-hang");

    const t0 = Date.now();
    await client.close();
    const elapsed = Date.now() - t0;

    // 发出过 session/close 且超时后触发了 proc.kill()
    expect(
      harness.sentToServer.some(
        (m) => "method" in m && m.method === "session/close",
      ),
    ).toBe(true);
    expect(harness.stdinEnded).toBe(true);
    expect(harness.killedSignals.length).toBe(1);
    expect(elapsed).toBeLessThan(400);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.expected).toBe(true);
  });

  test("onTraffic 钩子自动脱敏超长图片 base64 payload", async () => {
    const harness = createMockAcpHarness();
    const traffic: AcpTrafficEvent[] = [];

    harness.onClientMessage((msg) => {
      if ("id" in msg && "method" in msg && msg.method === "session/prompt") {
        harness.sendFromServer({
          jsonrpc: "2.0",
          id: msg.id,
          result: { stopReason: "end_turn" },
        });
      }
    });

    const client = new AcpClient({
      spawn: harness.spawn,
      onTraffic: (ev) => traffic.push(ev),
    });
    client.start();

    const fakeBase64 = "A".repeat(4096);
    await client.prompt({
      sessionId: "sess-img",
      prompt: [
        { type: "text", text: "describe image" },
        { type: "image", mimeType: "image/png", data: fakeBase64 },
      ],
    });

    const outPrompt = traffic.find(
      (e) => e.direction === "out" && e.method === "session/prompt",
    );
    expect(outPrompt).toBeDefined();
    const rawStr = JSON.stringify(outPrompt?.raw);
    expect(rawStr).toContain("<base64:4096 chars>");
    expect(rawStr).not.toContain("A".repeat(200));

    await client.close({ timeoutMs: 50 });
  });

  test("真实 Bun.spawn 管道冒烟：通过微型 bun -e 子进程完成 JSON-RPC 往返与优雅退出", async () => {
    // 借用当前 bun 可执行文件作为伪 agy，但命令会是 [bun, "acp", ...] — 用自定义包装仅改命令行复用 defaultBunSpawn
    const script = [
      'const dec = new TextDecoder();',
      'let buf = "";',
      'for await (const chunk of Bun.stdin.stream()) {',
      '  buf += dec.decode(chunk, { stream: true });',
      '  let idx;',
      '  while ((idx = buf.indexOf("\\n")) !== -1) {',
      '    const line = buf.slice(0, idx).trim();',
      '    buf = buf.slice(idx + 1);',
      '    if (!line) continue;',
      '    const m = JSON.parse(line);',
      '    if (m.method === "initialize") {',
      '      console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentInfo: { name: "mock-bun", version: "1.0.0" } } }));',
      '    } else if (m.method === "session/close") {',
      '      console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: {} }));',
      '      process.exit(0);',
      '    }',
      '  }',
      '}',
    ].join("\n");

    const { defaultBunSpawn } = await import("../src/acp/client.ts");
    const exits: AcpExitInfo[] = [];
    const client = new AcpClient({
      spawn: (_cmd, opts) => defaultBunSpawn([process.execPath, "-e", script], opts),
      closeTimeoutMs: 500,
      onExit: (info) => exits.push(info),
    });
    client.start();

    const init = await client.initialize();
    expect(init.agentInfo?.name).toBe("mock-bun");
    expect(client.pid).toBeGreaterThan(0);

    await client.close({ sessionId: "sess-real-pipe" });
    expect(client.isRunning).toBe(false);
    expect(exits).toHaveLength(1);
    expect(exits[0]!.expected).toBe(true);
    expect(exits[0]!.code).toBe(0);
  });
});
