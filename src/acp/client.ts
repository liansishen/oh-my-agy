/**
 * ACP JSON-RPC 2.0 客户端层：
 * - Bun.spawn 托管官方 `agy acp` 子进程（支持注入自定义 spawn/流实现 100% Mock 离线测试）
 * - 不限单行长度的分块流式 NDJSON 读取
 * - 串行 stdin 写入队列与脱敏流量钩子（onTraffic）
 * - pending RPC 路由、严格保序的 session/update 通知派发、不阻塞主读循环的反向请求（session/request_permission、elicitation/create）
 * - stderr 尾部环形收集
 * - 优雅 session/close + 500ms 超时 proc.kill() 清理与异常崩溃通知
 */

import { sameDir } from "./path.ts";
import {
  AcpRpcError,
  JSON_RPC_ERROR,
  extractSessionTier,
  type AcpIncomingRequest,
  type AntigravityTierInfo,
  type AuthLogoutResult,
  type ImplementationInfo,
  type InitializeParams,
  type InitializeResult,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  type McpServerConfig,
  type SessionCancelParams,
  type SessionCloseResult,
  type SessionListParams,
  type SessionListResult,
  type SessionLoadResult,
  type SessionNewResult,
  type SessionPromptParams,
  type SessionPromptResult,
  type SessionResumeResult,
  type SessionSetConfigOptionParams,
  type SessionSetConfigOptionResult,
  type SessionSetModeParams,
  type SessionSetModeResult,
  type SessionSetModelParams,
  type SessionSetModelResult,
  type SessionSummary,
  type SessionUpdateParams,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// 进程与流抽象接口（用于默认 Bun.spawn 与离线 Mock 测试注入）
// ---------------------------------------------------------------------------

export interface AcpWritableSink {
  write(
    chunk: string | Uint8Array,
  ): number | Promise<number> | void | Promise<void>;
  flush?(): number | Promise<number> | void | Promise<void>;
  end?(): number | Promise<number> | void | Promise<void>;
}

export interface AcpChildProcess {
  stdin: AcpWritableSink;
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  pid?: number;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface AcpSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export type AcpSpawnFn = (
  cmd: string[],
  options: AcpSpawnOptions,
) => AcpChildProcess;

// ---------------------------------------------------------------------------
// 回调与配置类型
// ---------------------------------------------------------------------------

export type AcpTrafficDirection = "out" | "in" | "stderr" | "lifecycle";

export type AcpTrafficKind =
  | "request"
  | "response"
  | "error"
  | "notification"
  | "server_request"
  | "stderr"
  | "lifecycle"
  | "parse_error";

export interface AcpTrafficEvent {
  timestamp: number;
  direction: AcpTrafficDirection;
  kind: AcpTrafficKind;
  method?: string;
  id?: JsonRpcId | null;
  summary: string;
  raw?: unknown;
}

export interface AcpExitInfo {
  code: number | null;
  expected: boolean;
  stderrTail: string;
  error?: Error;
}

export interface AcpClientOptions {
  /** agy 可执行文件路径，默认 "agy"（从 PATH 查找） */
  agyBin?: string;
  /** 仅用于透传用户显式指定的官方参数（例如 --add-dir） */
  extraArgs?: string[];
  /** 子进程工作目录 */
  cwd?: string;
  /** 子进程环境变量 */
  env?: Record<string, string | undefined>;
  /** 可选自定义 spawn 工厂（用于 Mock 离线测试） */
  spawn?: AcpSpawnFn;
  /** close() 优雅关闭等待上限（毫秒），默认 500 */
  closeTimeoutMs?: number;
  /** stderr 尾部保留的最大行数，默认 100 */
  stderrMaxLines?: number;
  /** stderr 尾部保留的最大字符数，默认 32768 */
  stderrMaxChars?: number;
  /** session/update 通知回调（按到达顺序严格串行派发） */
  onUpdate?: (params: SessionUpdateParams) => void | Promise<void>;
  /** 全部服务端单向通知回调（包含 session/update 之外的扩展通知） */
  onNotification?: (notification: JsonRpcNotification) => void | Promise<void>;
  /**
   * 服务端反向请求回调（如 session/request_permission、elicitation/create）。
   * 返回非 undefined 值时自动作为 JSON-RPC result 回写；
   * 也可手动调用 client.respondToServerRequest / respondErrorToServerRequest 并返回 undefined。
   */
  onServerRequest?: (request: AcpIncomingRequest) => unknown | Promise<unknown>;
  /** 脱敏流量观测钩子（对接 src/state/traffic.ts 供 /log 展示） */
  onTraffic?: (event: AcpTrafficEvent) => void;
  /** stderr 单行实时回调 */
  onStderr?: (line: string) => void;
  /** 子进程退出通知（意外崩溃时 expected === false 并携带 stderrTail） */
  onExit?: (info: AcpExitInfo) => void;
}

interface PendingRpc {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// 默认 Bun.spawn 适配器
// ---------------------------------------------------------------------------

export function defaultBunSpawn(
  cmd: string[],
  options: AcpSpawnOptions,
): AcpChildProcess {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!proc.stdin || typeof proc.stdin === "number") {
    throw new Error("Failed to open stdin pipe for agy acp subprocess");
  }
  if (!proc.stdout || typeof proc.stdout === "number") {
    throw new Error("Failed to open stdout pipe for agy acp subprocess");
  }

  const stdinSink = proc.stdin;
  const stderrStream =
    proc.stderr && typeof proc.stderr !== "number" ? proc.stderr : null;

  return {
    stdin: {
      write: (chunk) => stdinSink.write(chunk),
      flush: () => stdinSink.flush(),
      end: () => stdinSink.end(),
    },
    stdout: proc.stdout,
    stderr: stderrStream,
    exited: proc.exited,
    pid: proc.pid,
    kill: (signal) => proc.kill(signal),
  };
}

// ---------------------------------------------------------------------------
// 脱敏摘要生成（避免图片 base64 / 超长内容塞满 traffic 环形缓冲）
// ---------------------------------------------------------------------------

const MAX_TRAFFIC_STRING_LEN = 240;

function sanitizeForTraffic(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length > MAX_TRAFFIC_STRING_LEN) {
      return `${value.slice(0, MAX_TRAFFIC_STRING_LEN)}...(${value.length} chars)`;
    }
    return value;
  }
  if (typeof value !== "object") return value;
  if (depth >= 4) return "[truncated]";

  if (Array.isArray(value)) {
    const preview = value
      .slice(0, 8)
      .map((item) => sanitizeForTraffic(item, depth + 1));
    if (value.length > 8) {
      preview.push(`...(+${value.length - 8} items)`);
    }
    return preview;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries.slice(0, 20)) {
    if (
      (k === "data" || k === "blob") &&
      typeof v === "string" &&
      v.length > 64
    ) {
      out[k] = `<base64:${v.length} chars>`;
    } else {
      out[k] = sanitizeForTraffic(v, depth + 1);
    }
  }
  if (entries.length > 20) {
    out["__truncatedKeys"] = entries.length - 20;
  }
  return out;
}

function summarizeMessage(
  kind: AcpTrafficKind,
  method?: string,
  id?: JsonRpcId | null,
  extra?: string,
): string {
  const parts: string[] = [kind];
  if (method) parts.push(method);
  if (id !== undefined && id !== null) parts.push(`#${String(id)}`);
  if (extra) parts.push(extra);
  return parts.join(" ");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// AcpClient 主实现
// ---------------------------------------------------------------------------

export class AcpClient {
  private readonly options: AcpClientOptions;
  private readonly closeTimeoutMs: number;
  private readonly stderrMaxLines: number;
  private readonly stderrMaxChars: number;

  private proc: AcpChildProcess | null = null;
  private generation = 0;
  private nextRequestId = 1;
  private activeSessionId: string | null = null;
  private lastInitializeResult: InitializeResult | null = null;
  private activeTier: AntigravityTierInfo | null = null;

  private pending = new Map<JsonRpcId, PendingRpc>();
  private pendingServerRequests = new Set<JsonRpcId>();
  private writeChain: Promise<void> = Promise.resolve();
  private dispatchChain: Promise<void> = Promise.resolve();

  private stderrLines: string[] = [];
  private stderrChars = 0;
  private stderrDonePromise: Promise<void> = Promise.resolve();

  private closing = false;
  private closePromise: Promise<void> | null = null;
  private exitNotifiedGen = -1;

  constructor(options: AcpClientOptions = {}) {
    this.options = options;
    this.closeTimeoutMs = options.closeTimeoutMs ?? 500;
    this.stderrMaxLines = options.stderrMaxLines ?? 100;
    this.stderrMaxChars = options.stderrMaxChars ?? 32_768;
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.closing;
  }

  get currentSessionId(): string | null {
    return this.activeSessionId;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** 服务端 initialize 响应中声明的 agentInfo（未初始化时为 null） */
  get agentInfo(): ImplementationInfo | null {
    return this.lastInitializeResult?.agentInfo ?? null;
  }

  /** 服务端 initialize 响应中是否声明支持 `auth/logout` RPC */
  get supportsLogout(): boolean {
    const logoutCap = this.lastInitializeResult?.agentCapabilities?.auth?.logout;
    return logoutCap !== undefined && logoutCap !== false;
  }

  /** 最近一次 initialize 完整结果 */
  get initializeResult(): InitializeResult | null {
    return this.lastInitializeResult;
  }

  /** 最近一次 session/new 或 session/load 提取的订阅层级信息 */
  get currentTier(): AntigravityTierInfo | null {
    return this.activeTier;
  }

  /** 启动 `agy acp` 子进程并开始异步 stdout / stderr 读取循环 */
  start(): void {
    if (this.proc && !this.closing) {
      return;
    }

    const gen = ++this.generation;
    this.closing = false;
    this.closePromise = null;
    this.lastInitializeResult = null;
    this.activeTier = null;
    this.stderrLines = [];
    this.stderrChars = 0;
    this.pendingServerRequests.clear();
    this.writeChain = Promise.resolve();
    this.dispatchChain = Promise.resolve();

    const agyBin = this.options.agyBin?.trim() || "agy";
    const extraArgs = this.options.extraArgs ?? [];
    const cmd = [agyBin, "acp", ...extraArgs];
    const spawnFn = this.options.spawn ?? defaultBunSpawn;

    this.emitTraffic({
      timestamp: Date.now(),
      direction: "lifecycle",
      kind: "lifecycle",
      summary: `spawn ${cmd.join(" ")}`,
    });

    const child = spawnFn(cmd, {
      cwd: this.options.cwd,
      env: this.options.env,
    });
    this.proc = child;

    this.stderrDonePromise = child.stderr
      ? this.readStderrLoop(child.stderr, gen)
      : Promise.resolve();

    const stdoutDone = this.readStdoutLoop(child.stdout, gen);

    void this.monitorProcessExit(child, stdoutDone, gen);
  }

  /** 获取当前已收集的 stderr 尾部诊断摘要 */
  getStderrTail(): string {
    return this.stderrLines.join("\n");
  }

  // -------------------------------------------------------------------------
  // 底层 JSON-RPC 2.0 传输原语
  // -------------------------------------------------------------------------

  /** 发送 JSON-RPC 请求并等待响应 */
  request<R = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number },
  ): Promise<R> {
    return this.sendRequestInternal<R>(method, params, options);
  }

  private sendRequestInternal<R = unknown>(
    method: string,
    params?: unknown,
    options?: { timeoutMs?: number; allowWhileClosing?: boolean },
  ): Promise<R> {
    if (!this.proc || (this.closing && !options?.allowWhileClosing)) {
      return Promise.reject(
        new Error(`ACP client is not running (cannot send ${method})`),
      );
    }

    const id = this.nextRequestId++;
    const payload: JsonRpcRequest =
      params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params };

    return new Promise<R>((resolve, reject) => {
      const entry: PendingRpc = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      if (options?.timeoutMs && options.timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(
              new Error(
                `ACP request "${method}" (#${id}) timed out after ${options.timeoutMs}ms`,
              ),
            );
          }
        }, options.timeoutMs);
      }

      this.pending.set(id, entry);

      void this.enqueueWrite(payload, {
        kind: "request",
        method,
        id,
      }).catch((err: unknown) => {
        const current = this.pending.get(id);
        if (current) {
          if (current.timer) clearTimeout(current.timer);
          this.pending.delete(id);
          current.reject(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      });
    });
  }

  /** 发送 JSON-RPC 单向通知（无 id，不等待响应） */
  notify(method: string, params?: unknown): Promise<void> {
    if (!this.proc) {
      return Promise.reject(
        new Error(`ACP client is not running (cannot notify ${method})`),
      );
    }
    const payload: JsonRpcNotification =
      params === undefined
        ? { jsonrpc: "2.0", method }
        : { jsonrpc: "2.0", method, params };

    return this.enqueueWrite(payload, {
      kind: "notification",
      method,
    });
  }

  /** 回复服务端反向请求（成功 result）；若该 id 已被应答则幂等跳过 */
  async respondToServerRequest(id: JsonRpcId, result: unknown): Promise<void> {
    if (!this.pendingServerRequests.delete(id)) {
      return;
    }
    if (!this.proc) {
      return;
    }
    const payload: JsonRpcSuccessResponse = {
      jsonrpc: "2.0",
      id,
      result,
    };
    await this.enqueueWrite(payload, {
      kind: "response",
      id,
    });
  }

  /** 回复服务端反向请求（错误 error）；若该 id 已被应答则幂等跳过 */
  async respondErrorToServerRequest(
    id: JsonRpcId,
    code: number,
    message: string,
    data?: unknown,
  ): Promise<void> {
    if (!this.pendingServerRequests.delete(id)) {
      return;
    }
    if (!this.proc) {
      return;
    }
    const payload: JsonRpcErrorResponse = {
      jsonrpc: "2.0",
      id,
      error: data === undefined ? { code, message } : { code, message, data },
    };
    await this.enqueueWrite(payload, {
      kind: "error",
      id,
      extra: `${code} ${message}`,
    });
  }

  // -------------------------------------------------------------------------
  // ACP 高层方法（严格对齐 docs/DESIGN.md 4.2.2）
  // -------------------------------------------------------------------------

  async initialize(
    params?: Partial<InitializeParams>,
  ): Promise<InitializeResult> {
    const req: InitializeParams = {
      protocolVersion: params?.protocolVersion ?? 1,
      clientInfo: params?.clientInfo ?? { name: "oma", version: "0.2.0" },
      clientCapabilities: params?.clientCapabilities ?? {},
      ...(params?._meta ? { _meta: params._meta } : {}),
    };
    const res = await this.request<InitializeResult>("initialize", req);
    this.lastInitializeResult = res ?? null;
    return res;
  }

  /** 发送官方 ACP `auth/logout` RPC 退出登录（绝不手动触碰凭证文件） */
  async logout(): Promise<void> {
    await this.request<AuthLogoutResult | void>("auth/logout", {});
    this.activeSessionId = null;
    this.activeTier = null;
  }

  async newSession(params: {
    cwd: string;
    mcpServers?: McpServerConfig[];
    _meta?: Record<string, unknown>;
  }): Promise<SessionNewResult> {
    const res = await this.request<SessionNewResult>("session/new", {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...(params._meta ? { _meta: params._meta } : {}),
    });
    if (res?.sessionId) {
      this.activeSessionId = res.sessionId;
    }
    const tier = extractSessionTier(res?._meta);
    if (tier) {
      this.activeTier = tier;
    }
    return res;
  }

  async listSessions(params?: SessionListParams): Promise<SessionListResult> {
    return this.request<SessionListResult>("session/list", params ?? {});
  }

  /**
   * 分页拉取全部历史会话，并在传入 cwd 时使用 sameDir() 本地精确筛选
   * （实测 agy 1.5.13 忽略服务端 cwd 参数）。
   */
  async listAllSessions(options?: {
    cwd?: string;
    maxPages?: number;
  }): Promise<SessionSummary[]> {
    const maxPages = options?.maxPages ?? 50;
    const all: SessionSummary[] = [];
    const seenIds = new Set<string>();
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const res = await this.listSessions(cursor ? { cursor } : {});
      const batch = Array.isArray(res?.sessions) ? res.sessions : [];
      for (const item of batch) {
        if (!seenIds.has(item.sessionId)) {
          seenIds.add(item.sessionId);
          all.push(item);
        }
      }
      if (!res?.nextCursor || res.nextCursor === cursor) {
        break;
      }
      cursor = res.nextCursor;
    }

    if (options?.cwd) {
      const targetCwd = options.cwd;
      return all.filter((s) => sameDir(s.cwd, targetCwd));
    }
    return all;
  }

  async loadSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: McpServerConfig[];
    _meta?: Record<string, unknown>;
  }): Promise<SessionLoadResult & { sessionId: string }> {
    const res = await this.request<SessionLoadResult>("session/load", {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...(params._meta ? { _meta: params._meta } : {}),
    });
    const sessionId = res?.sessionId ?? params.sessionId;
    this.activeSessionId = sessionId;
    const tier = extractSessionTier(res?._meta);
    if (tier) {
      this.activeTier = tier;
    }
    return { ...res, sessionId };
  }

  async resumeSession(params: {
    sessionId: string;
    cwd: string;
    mcpServers?: McpServerConfig[];
    _meta?: Record<string, unknown>;
  }): Promise<SessionResumeResult & { sessionId: string }> {
    const res = await this.request<SessionResumeResult>("session/resume", {
      sessionId: params.sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
      ...(params._meta ? { _meta: params._meta } : {}),
    });
    const sessionId = res?.sessionId ?? params.sessionId;
    this.activeSessionId = sessionId;
    const tier = extractSessionTier(res?._meta);
    if (tier) {
      this.activeTier = tier;
    }
    return { ...res, sessionId };
  }

  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    return this.request<SessionPromptResult>("session/prompt", params);
  }

  /** 发送 session/cancel 通知中断当前 Turn */
  async cancel(sessionId: string): Promise<void> {
    const params: SessionCancelParams = { sessionId };
    await this.notify("session/cancel", params);
  }

  async setConfigOption(
    params: SessionSetConfigOptionParams,
  ): Promise<SessionSetConfigOptionResult> {
    return this.request<SessionSetConfigOptionResult>(
      "session/set_config_option",
      params,
    );
  }

  async setMode(params: SessionSetModeParams): Promise<SessionSetModeResult> {
    return this.request<SessionSetModeResult>("session/set_mode", params);
  }

  async setModel(
    params: SessionSetModelParams,
  ): Promise<SessionSetModelResult> {
    return this.request<SessionSetModelResult>("session/set_model", params);
  }

  async closeSession(sessionId: string, timeoutMs?: number): Promise<void> {
    if (!this.proc) return;
    try {
      await this.request<SessionCloseResult>(
        "session/close",
        { sessionId },
        { timeoutMs: timeoutMs ?? this.closeTimeoutMs },
      );
    } finally {
      if (this.activeSessionId === sessionId) {
        this.activeSessionId = null;
      }
    }
  }

  /**
   * 优雅关闭：
   * 1. 若有活跃会话，发送 `session/close`（受总超时保护，默认 500ms）；
   * 2. 关闭 stdin 并等待子进程自行退出；
   * 3. 超过超时上限仍未退出则执行 `proc.kill()` 强杀；
   * 4. 清理全部 pending RPC，不留僵尸进程。
   */
  async close(options?: {
    sessionId?: string;
    timeoutMs?: number;
  }): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    const child = this.proc;
    const gen = this.generation;
    const totalTimeout = options?.timeoutMs ?? this.closeTimeoutMs;
    const sessionId = options?.sessionId ?? this.activeSessionId ?? undefined;

    if (!child) {
      this.closing = true;
      return;
    }

    this.closing = true;
    this.activeSessionId = null;
    this.activeTier = null;
    this.lastInitializeResult = null;

    this.closePromise = (async () => {
      const deadline = Date.now() + totalTimeout;

      // 1. 尝试先优雅发送 session/close（closing 已置 true 避免子进程立即退出误报崩溃）
      if (sessionId) {
        const remaining = Math.max(20, deadline - Date.now());
        try {
          await this.sendRequestInternal<SessionCloseResult>(
            "session/close",
            { sessionId },
            { timeoutMs: remaining, allowWhileClosing: true },
          );
        } catch {
          // 忽略关闭期 session/close 失败或超时，继续强退清理
        }
      }

      // 2. 尝试刷新并关闭 stdin
      try {
        await this.writeChain.catch(() => {});
        await child.stdin.end?.();
      } catch {
        // 忽略已断开管道错误
      }

      // 3. 在剩余预算内等待子进程退出，超时则 kill
      const waitBudget = Math.max(0, deadline - Date.now());
      let exitedNaturally = false;
      const exitCodePromise = child.exited
        .then((code) => {
          exitedNaturally = true;
          return code;
        })
        .catch(() => {
          exitedNaturally = true;
          return null;
        });

      await Promise.race([exitCodePromise, delay(waitBudget)]);

      if (!exitedNaturally) {
        this.emitTraffic({
          timestamp: Date.now(),
          direction: "lifecycle",
          kind: "lifecycle",
          summary: `kill subprocess after ${totalTimeout}ms close timeout`,
        });
        try {
          child.kill();
        } catch {
          // 子进程可能刚刚退出
        }
        await Promise.race([exitCodePromise, delay(150)]);
      }

      // 4. 清理所有未决请求
      this.rejectAllPending(new Error("ACP client closed"));
      this.pendingServerRequests.clear();

      if (this.generation === gen) {
        this.proc = null;
      }

      const code = exitedNaturally ? await exitCodePromise : null;
      this.notifyExitOnce(gen, {
        code,
        expected: true,
        stderrTail: this.getStderrTail(),
      });
    })();

    return this.closePromise;
  }

  // -------------------------------------------------------------------------
  // 内部串行写入、流式读循环与事件路由
  // -------------------------------------------------------------------------

  private enqueueWrite(
    payload: unknown,
    meta: {
      kind: AcpTrafficKind;
      method?: string;
      id?: JsonRpcId | null;
      extra?: string;
    },
  ): Promise<void> {
    const serialized = `${JSON.stringify(payload)}\n`;
    const child = this.proc;

    const run = async (): Promise<void> => {
      if (!child) {
        throw new Error("ACP subprocess is not active");
      }
      this.emitTraffic({
        timestamp: Date.now(),
        direction: "out",
        kind: meta.kind,
        method: meta.method,
        id: meta.id,
        summary: summarizeMessage(meta.kind, meta.method, meta.id, meta.extra),
        raw: sanitizeForTraffic(payload),
      });
      await child.stdin.write(serialized);
      await child.stdin.flush?.();
    };

    const next = this.writeChain.then(run, run);
    // 保持 writeChain 不会因单次失败而永久卡在 rejected 状态
    this.writeChain = next.catch(() => {});
    return next;
  }

  /**
   * 不限单行长度的流式 NDJSON 读取循环：
   * 通过 string[] 分块暂存直到遇到 `\n` 一次性 join，支持数 MB 单行且无 UTF-8 跨分片截断问题。
   */
  private async readStdoutLoop(
    stream: ReadableStream<Uint8Array>,
    gen: number,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const pendingParts: string[] = [];

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (gen !== this.generation) {
          break;
        }
        const text = decoder.decode(value, { stream: true });
        if (text.length === 0) {
          continue;
        }

        let start = 0;
        while (true) {
          const nl = text.indexOf("\n", start);
          if (nl === -1) {
            if (start < text.length) {
              pendingParts.push(text.slice(start));
            }
            break;
          }
          if (nl > start) {
            pendingParts.push(text.slice(start, nl));
          }
          const rawLine =
            pendingParts.length === 1
              ? (pendingParts[0] ?? "")
              : pendingParts.join("");
          pendingParts.length = 0;
          start = nl + 1;

          const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
          if (line.length > 0) {
            this.handleInboundLine(line, gen);
          }
        }
      }

      // 冲刷流末尾残余字节（最后一行可能无换行符）
      const tail = decoder.decode();
      if (tail.length > 0) {
        pendingParts.push(tail);
      }
      if (pendingParts.length > 0 && gen === this.generation) {
        const rawLine = pendingParts.join("");
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length > 0) {
          this.handleInboundLine(line, gen);
        }
      }
    } catch (err) {
      if (!this.closing && gen === this.generation) {
        this.emitTraffic({
          timestamp: Date.now(),
          direction: "lifecycle",
          kind: "error",
          summary: `stdout read error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  private async readStderrLoop(
    stream: ReadableStream<Uint8Array>,
    gen: number,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let remainder = "";

    const pushLine = (line: string) => {
      if (gen !== this.generation || line.length === 0) return;
      this.stderrLines.push(line);
      this.stderrChars += line.length + 1;
      while (
        this.stderrLines.length > this.stderrMaxLines ||
        (this.stderrLines.length > 1 && this.stderrChars > this.stderrMaxChars)
      ) {
        const removed = this.stderrLines.shift();
        if (removed !== undefined) {
          this.stderrChars -= removed.length + 1;
        }
      }
      this.emitTraffic({
        timestamp: Date.now(),
        direction: "stderr",
        kind: "stderr",
        summary: line.slice(0, MAX_TRAFFIC_STRING_LEN),
      });
      try {
        this.options.onStderr?.(line);
      } catch {
        // 避免日志回调影响 stderr 消费导致 pipe 堵塞
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (gen !== this.generation) break;
        remainder += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = remainder.indexOf("\n")) !== -1) {
          const rawLine = remainder.slice(0, nl);
          remainder = remainder.slice(nl + 1);
          pushLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
        }
      }
      remainder += decoder.decode();
      if (remainder.length > 0) {
        pushLine(remainder.endsWith("\r") ? remainder.slice(0, -1) : remainder);
      }
    } catch {
      // ignore stderr stream errors on exit
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  }

  private handleInboundLine(line: string, gen: number): void {
    if (gen !== this.generation) return;

    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.emitTraffic({
        timestamp: Date.now(),
        direction: "in",
        kind: "parse_error",
        summary: `invalid JSON line (${line.length} chars): ${err instanceof Error ? err.message : String(err)}`,
        raw: line.slice(0, MAX_TRAFFIC_STRING_LEN),
      });
      return;
    }

    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      this.emitTraffic({
        timestamp: Date.now(),
        direction: "in",
        kind: "parse_error",
        summary: "ignored non-object JSON-RPC message",
      });
      return;
    }

    const record = msg as Record<string, unknown>;
    const hasId =
      record.id !== undefined &&
      record.id !== null &&
      (typeof record.id === "number" || typeof record.id === "string");
    const hasMethod = typeof record.method === "string";

    // 1. 服务端反向请求：同时有 id + method
    if (hasId && hasMethod) {
      const req: AcpIncomingRequest = {
        id: record.id as JsonRpcId,
        method: record.method as string,
        params: record.params,
      };
      this.pendingServerRequests.add(req.id);
      this.emitTraffic({
        timestamp: Date.now(),
        direction: "in",
        kind: "server_request",
        method: req.method,
        id: req.id,
        summary: summarizeMessage("server_request", req.method, req.id),
        raw: sanitizeForTraffic(record),
      });

      // 等待此前已入队的通知（如前一行 tool_call）派发完再触发反向请求，
      // 但不把反向请求的等待挂回 dispatchChain，避免阻塞后续通知与取消响应！
      const prior = this.dispatchChain;
      void prior.then(() => this.handleServerRequest(req, gen));
      return;
    }

    // 2. RPC 响应：有 id 且无 method
    if (hasId && !hasMethod) {
      const id = record.id as JsonRpcId;
      const hasError = "error" in record && record.error !== undefined;
      this.emitTraffic({
        timestamp: Date.now(),
        direction: "in",
        kind: hasError ? "error" : "response",
        id,
        summary: summarizeMessage(
          hasError ? "error" : "response",
          this.pending.get(id)?.method,
          id,
        ),
        raw: sanitizeForTraffic(record),
      });

      // 挂入 dispatchChain，保证先于响应到达的 session/update 通知（如 session/load 历史回放）先交付完毕
      this.enqueueDispatch(() => {
        if (gen !== this.generation) return;
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);

        if (hasError) {
          const errObj = record.error as {
            code?: unknown;
            message?: unknown;
            data?: unknown;
          };
          const code =
            typeof errObj?.code === "number"
              ? errObj.code
              : JSON_RPC_ERROR.INTERNAL_ERROR;
          const message =
            typeof errObj?.message === "string"
              ? errObj.message
              : "ACP JSON-RPC error";
          entry.reject(new AcpRpcError(code, message, errObj?.data, entry.method));
        } else {
          entry.resolve(record.result);
        }
      });
      return;
    }

    // 3. 单向通知：仅有 method 无 id
    if (hasMethod) {
      const notification: JsonRpcNotification = {
        jsonrpc: "2.0",
        method: record.method as string,
        params: record.params,
      };
      const updateKind =
        notification.method === "session/update" &&
        typeof (record.params as { update?: { sessionUpdate?: unknown } })
          ?.update?.sessionUpdate === "string"
          ? (record.params as { update: { sessionUpdate: string } }).update
              .sessionUpdate
          : undefined;

      this.emitTraffic({
        timestamp: Date.now(),
        direction: "in",
        kind: "notification",
        method: notification.method,
        summary: summarizeMessage(
          "notification",
          notification.method,
          undefined,
          updateKind,
        ),
        raw: sanitizeForTraffic(record),
      });

      this.enqueueDispatch(async () => {
        if (gen !== this.generation) return;
        if (
          notification.method === "session/update" &&
          this.options.onUpdate &&
          typeof record.params === "object" &&
          record.params !== null
        ) {
          await this.options.onUpdate(record.params as SessionUpdateParams);
        }
        if (this.options.onNotification) {
          await this.options.onNotification(notification);
        }
      });
    }
  }

  private enqueueDispatch(task: () => void | Promise<void>): void {
    const run = async () => {
      try {
        await task();
      } catch (err) {
        this.emitTraffic({
          timestamp: Date.now(),
          direction: "lifecycle",
          kind: "error",
          summary: `handler error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    };
    this.dispatchChain = this.dispatchChain.then(run, run);
  }

  private async handleServerRequest(
    req: AcpIncomingRequest,
    gen: number,
  ): Promise<void> {
    if (gen !== this.generation) return;

    if (!this.options.onServerRequest) {
      await this.respondErrorToServerRequest(
        req.id,
        JSON_RPC_ERROR.METHOD_NOT_FOUND,
        `Unhandled client method: ${req.method}`,
      );
      return;
    }

    try {
      const result = await this.options.onServerRequest(req);
      if (gen !== this.generation) return;
      if (result !== undefined) {
        await this.respondToServerRequest(req.id, result);
      }
    } catch (err) {
      if (gen !== this.generation) return;
      if (err instanceof AcpRpcError) {
        await this.respondErrorToServerRequest(
          req.id,
          err.code,
          err.message,
          err.data,
        );
      } else {
        await this.respondErrorToServerRequest(
          req.id,
          JSON_RPC_ERROR.INTERNAL_ERROR,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  private async monitorProcessExit(
    child: AcpChildProcess,
    stdoutDone: Promise<void>,
    gen: number,
  ): Promise<void> {
    let exitCode: number | null = null;
    let exitError: Error | undefined;

    try {
      // 等待 stdout 读完和子进程真正退出（防止单边先结束）
      const codePromise = child.exited
        .then((code) => code)
        .catch((err: unknown) => {
          exitError = err instanceof Error ? err : new Error(String(err));
          return null;
        });

      await Promise.race([
        Promise.all([stdoutDone, codePromise]),
        codePromise.then(() => Promise.race([stdoutDone, delay(100)])),
      ]);
      exitCode = await Promise.race([codePromise, delay(200).then(() => null)]);
    } catch (err) {
      exitError = err instanceof Error ? err : new Error(String(err));
    }

    if (gen !== this.generation) {
      return;
    }

    // 给 stderr 读循环极短窗口冲刷崩溃前的最后诊断行
    await Promise.race([this.stderrDonePromise, delay(50)]);
    // 确保已读到的入站通知与响应先完成派发
    await this.dispatchChain.catch(() => {});

    if (gen !== this.generation) {
      return;
    }

    const expected = this.closing;
    const stderrTail = this.getStderrTail();

    if (!expected) {
      this.proc = null;
      this.activeSessionId = null;
      this.activeTier = null;
      this.lastInitializeResult = null;
      const summary =
        exitCode !== null
          ? `agy acp exited unexpectedly with code ${exitCode}`
          : "agy acp exited unexpectedly";
      const detail = stderrTail ? `${summary}\n${stderrTail}` : summary;
      const crashErr = exitError ?? new Error(detail);

      this.rejectAllPending(crashErr);
      this.pendingServerRequests.clear();

      this.emitTraffic({
        timestamp: Date.now(),
        direction: "lifecycle",
        kind: "error",
        summary,
      });

      this.notifyExitOnce(gen, {
        code: exitCode,
        expected: false,
        stderrTail,
        error: crashErr,
      });
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private notifyExitOnce(gen: number, info: AcpExitInfo): void {
    if (this.exitNotifiedGen === gen) {
      return;
    }
    this.exitNotifiedGen = gen;
    try {
      this.options.onExit?.(info);
    } catch {
      // 防止外部回调抛异常导致未捕获 rejection
    }
  }

  private emitTraffic(event: AcpTrafficEvent): void {
    try {
      this.options.onTraffic?.(event);
    } catch {
      // 观测钩子异常绝不影响协议主链路
    }
  }
}
