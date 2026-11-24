/**
 * ACP (Agent Client Protocol) JSON-RPC 2.0 完整类型定义与状态映射辅助函数。
 * 严格对齐 docs/DESIGN.md 4.2.2、4.2.3 及 agy 1.5.13 实测报文 Schema。
 * 零外部运行时依赖。
 */

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 基础类型
// ---------------------------------------------------------------------------

export type JsonRpcVersion = "2.0";
export type JsonRpcId = string | number;

export interface JsonRpcRequest<M extends string = string, P = unknown> {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId;
  method: M;
  params?: P;
}

export interface JsonRpcNotification<M extends string = string, P = unknown> {
  jsonrpc: JsonRpcVersion;
  method: M;
  params?: P;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse<R = unknown> {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorResponse {
  jsonrpc: JsonRpcVersion;
  id: JsonRpcId | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<R = unknown> =
  | JsonRpcSuccessResponse<R>
  | JsonRpcErrorResponse;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

export const JSON_RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
  REQUEST_CANCELLED: -32800,
} as const;

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly method?: string;

  constructor(code: number, message: string, data?: unknown, method?: string) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
    this.method = method;
  }

  /** 判断是否为未认证/登录过期类错误 */
  isAuthRequired(): boolean {
    if (this.code === JSON_RPC_ERROR.AUTH_REQUIRED || this.code === 401) {
      return true;
    }
    const lower = this.message.toLowerCase();
    return (
      lower.includes("auth") ||
      lower.includes("unauthenticated") ||
      lower.includes("unauthorized") ||
      lower.includes("not logged in") ||
      lower.includes("login required")
    );
  }

  /** 判断是否为会话/资源不存在错误（agy 1.5.15+ 返回 -32002） */
  isSessionNotFound(): boolean {
    if (this.code === JSON_RPC_ERROR.RESOURCE_NOT_FOUND) {
      return true;
    }
    const lower = this.message.toLowerCase();
    return (
      lower.includes("session not found") ||
      lower.includes("conversation not found") ||
      lower.includes("trajectory not found")
    );
  }
}

// ---------------------------------------------------------------------------
// ContentBlock（用于 session/prompt、消息块、tool_call 内容块）
// ---------------------------------------------------------------------------

export interface TextContentBlock {
  type: "text";
  text: string;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface ImageContentBlock {
  type: "image";
  mimeType: string;
  data: string;
  uri?: string;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface AudioContentBlock {
  type: "audio";
  mimeType: string;
  data: string;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface EmbeddedResourceText {
  uri: string;
  mimeType?: string;
  text: string;
  _meta?: Record<string, unknown>;
}

export interface EmbeddedResourceBlob {
  uri: string;
  mimeType?: string;
  blob: string;
  _meta?: Record<string, unknown>;
}

export interface EmbeddedResourceContentBlock {
  type: "resource";
  resource: EmbeddedResourceText | EmbeddedResourceBlob;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface ResourceLinkContentBlock {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | AudioContentBlock
  | EmbeddedResourceContentBlock
  | ResourceLinkContentBlock;

// ---------------------------------------------------------------------------
// Initialize
// ---------------------------------------------------------------------------

export interface ImplementationInfo {
  name: string;
  version: string;
  title?: string;
}

export interface ClientElicitationCapabilities {
  form?: Record<string, unknown>;
  url?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ClientCapabilities {
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
  terminal?: boolean;
  elicitation?: ClientElicitationCapabilities;
  [key: string]: unknown;
}

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
  [key: string]: unknown;
}

export interface McpCapabilities {
  http?: boolean;
  sse?: boolean;
  [key: string]: unknown;
}

export interface SessionCapabilities {
  list?: Record<string, unknown> | boolean;
  load?: Record<string, unknown> | boolean;
  resume?: Record<string, unknown> | boolean;
  close?: Record<string, unknown> | boolean;
  fork?: Record<string, unknown> | boolean;
  [key: string]: unknown;
}

export interface AuthCapabilities {
  logout?: Record<string, unknown> | boolean;
  [key: string]: unknown;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: McpCapabilities;
  sessionCapabilities?: SessionCapabilities;
  auth?: AuthCapabilities;
  [key: string]: unknown;
}

export interface AntigravityTierInfo {
  name?: string;
  id?: string;
  upgradeUri?: string;
  [key: string]: unknown;
}

export interface AntigravitySessionMeta {
  tier?: AntigravityTierInfo;
  [key: string]: unknown;
}

export interface SessionMeta {
  antigravity?: AntigravitySessionMeta;
  [key: string]: unknown;
}

/** 从 `session/new` / `session/load` / `session/resume` 响应的 `_meta` 中安全提取订阅层级信息 */
export function extractSessionTier(
  meta?: SessionMeta | Record<string, unknown> | null,
): AntigravityTierInfo | null {
  if (!meta || typeof meta !== "object") {
    return null;
  }
  const agy = (meta as SessionMeta).antigravity;
  if (!agy || typeof agy !== "object") {
    return null;
  }
  const tier = agy.tier;
  if (!tier || typeof tier !== "object" || Array.isArray(tier)) {
    return null;
  }
  const out: AntigravityTierInfo = { ...tier };
  const hasName = typeof tier.name === "string" && tier.name.trim().length > 0;
  const hasId = typeof tier.id === "string" && tier.id.trim().length > 0;
  const hasUpgrade =
    typeof tier.upgradeUri === "string" && tier.upgradeUri.trim().length > 0;
  if (!hasName && !hasId && !hasUpgrade) {
    return null;
  }
  if (hasName) out.name = tier.name!.trim();
  if (hasId) out.id = tier.id!.trim();
  if (hasUpgrade) out.upgradeUri = tier.upgradeUri!.trim();
  return out;
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface InitializeParams {
  protocolVersion: number;
  clientInfo?: ImplementationInfo;
  clientCapabilities?: ClientCapabilities;
  _meta?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: ImplementationInfo;
  authMethods?: AuthMethod[];
  _meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Models / Modes / ConfigOptions
// ---------------------------------------------------------------------------

export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface SessionModelState {
  currentModelId: string;
  availableModels: ModelInfo[];
  _meta?: Record<string, unknown>;
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
  _meta?: Record<string, unknown>;
}

export interface ConfigOptionChoice {
  value: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface ConfigOptionGroup {
  group: string;
  name: string;
  options: ConfigOptionChoice[];
}

export type ConfigOptionEntry = ConfigOptionChoice | ConfigOptionGroup;

export type ConfigOptionCategory =
  | "model"
  | "thought_level"
  | "mode"
  | (string & {});

export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: ConfigOptionCategory;
  type: "select" | (string & {});
  currentValue: string;
  options: ConfigOptionEntry[];
  _meta?: Record<string, unknown>;
}

export function isConfigOptionGroup(
  entry: ConfigOptionEntry,
): entry is ConfigOptionGroup {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "options" in entry &&
    Array.isArray(entry.options)
  );
}

/** 展平 select ConfigOption 中的平铺选项与分组选项 */
export function flattenConfigOptionChoices(
  option: ConfigOption | undefined,
): ConfigOptionChoice[] {
  if (!option || !Array.isArray(option.options)) {
    return [];
  }
  const result: ConfigOptionChoice[] = [];
  for (const entry of option.options) {
    if (isConfigOptionGroup(entry)) {
      for (const child of entry.options) {
        result.push(child);
      }
    } else if (entry && typeof entry.value === "string") {
      result.push(entry);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Session 方法请求与响应（C -> S）
// ---------------------------------------------------------------------------

export interface McpServerEnvVar {
  name: string;
  value: string;
}

export interface McpServerConfig {
  name: string;
  command?: string;
  args?: string[];
  env?: McpServerEnvVar[];
  type?: string;
  url?: string;
  headers?: McpServerEnvVar[];
  [key: string]: unknown;
}

export interface SessionStateResult {
  sessionId: string;
  models?: SessionModelState;
  modes?: SessionModeState;
  configOptions?: ConfigOption[];
  _meta?: SessionMeta;
}

export interface SessionNewParams {
  cwd: string;
  mcpServers: McpServerConfig[];
  _meta?: Record<string, unknown>;
}

export type SessionNewResult = SessionStateResult;

export interface SessionListParams {
  cwd?: string;
  cursor?: string;
  _meta?: Record<string, unknown>;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  _meta?: Record<string, unknown>;
}

export interface SessionListResult {
  sessions: SessionSummary[];
  nextCursor?: string | null;
  _meta?: Record<string, unknown>;
}

export interface SessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: McpServerConfig[];
  _meta?: Record<string, unknown>;
}

export interface SessionLoadResult {
  sessionId?: string;
  models?: SessionModelState;
  modes?: SessionModeState;
  configOptions?: ConfigOption[];
  _meta?: SessionMeta;
}

export interface SessionResumeParams {
  sessionId: string;
  cwd: string;
  mcpServers: McpServerConfig[];
  _meta?: Record<string, unknown>;
}

export type SessionResumeResult = SessionLoadResult;

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | (string & {});

export interface UsageInfo {
  used?: number;
  size?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  [key: string]: unknown;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
  _meta?: Record<string, unknown>;
}

export interface SessionPromptResult {
  stopReason: StopReason;
  usage?: UsageInfo;
  _meta?: Record<string, unknown>;
}

export interface SessionCancelParams {
  sessionId: string;
  _meta?: Record<string, unknown>;
}

export interface SessionSetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string;
  _meta?: Record<string, unknown>;
}

export interface SessionSetConfigOptionResult {
  configOptions: ConfigOption[];
  _meta?: Record<string, unknown>;
}

export interface SessionSetModeParams {
  sessionId: string;
  modeId: string;
  _meta?: Record<string, unknown>;
}

export interface SessionSetModeResult {
  _meta?: Record<string, unknown>;
}

export interface SessionSetModelParams {
  sessionId: string;
  modelId: string;
  _meta?: Record<string, unknown>;
}

export interface SessionSetModelResult {
  _meta?: Record<string, unknown>;
}

export interface SessionCloseParams {
  sessionId: string;
  _meta?: Record<string, unknown>;
}

export interface SessionCloseResult {
  _meta?: Record<string, unknown>;
}

export interface AuthLogoutResult {
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Tool Calls / Plan / Commands / Usage / 15+ 类 session/update 通知
// ---------------------------------------------------------------------------

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type TspToolStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "ask"
  | "cancelled";

export type ToolCallKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export interface ToolCallContentBlock {
  type: "content";
  content: ContentBlock;
}

export interface ToolCallDiffPatch {
  text: string;
}

export interface ToolCallDiffContent {
  type: "diff";
  path: string;
  oldText?: string | null;
  newText?: string;
  /** 兼容 v2 diff 扩展字段 */
  patch?: ToolCallDiffPatch;
  changes?: unknown;
  _meta?: Record<string, unknown>;
}

export interface ToolCallTerminalContent {
  type: "terminal";
  terminalId: string;
}

export type ToolCallContent =
  | ToolCallContentBlock
  | ToolCallDiffContent
  | ToolCallTerminalContent;

export interface ToolCallFields {
  toolCallId: string;
  status?: ToolCallStatus;
  kind?: ToolCallKind | (string & {});
  name?: string;
  title?: string;
  args?: Record<string, unknown>;
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: ToolCallLocation[];
  content?: ToolCallContent[];
  _meta?: Record<string, unknown>;
}

export interface UserMessageChunkUpdate {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
  messageId?: string;
  _meta?: Record<string, unknown>;
}

export interface AgentMessageChunkUpdate {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
  messageId?: string;
  _meta?: Record<string, unknown>;
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
  messageId?: string;
  _meta?: Record<string, unknown>;
}

export interface ToolCallUpdate extends ToolCallFields {
  sessionUpdate: "tool_call";
}

export interface ToolCallDeltaUpdate extends ToolCallFields {
  sessionUpdate: "tool_call_update";
}

export type PlanEntryPriority = "high" | "medium" | "low";
export type PlanEntryStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "done"
  | "skipped"
  | "failed"
  | (string & {});
export type TspChecklistStatus = "pending" | "active" | "done" | "dropped" | "blocked";

export interface PlanEntry {
  content: string;
  priority?: PlanEntryPriority;
  status: PlanEntryStatus;
}

export interface PlanSessionUpdate {
  sessionUpdate: "plan";
  entries: PlanEntry[];
  _meta?: Record<string, unknown>;
}

export interface PlanDeltaSessionUpdate {
  sessionUpdate: "plan_update";
  entries: PlanEntry[];
  _meta?: Record<string, unknown>;
}

export interface PlanRemovedSessionUpdate {
  sessionUpdate: "plan_removed";
  _meta?: Record<string, unknown>;
}

export interface UsageUpdateSessionUpdate {
  sessionUpdate: "usage_update";
  used: number;
  size: number;
  cost?: {
    amount: number;
    currency: string;
  };
  _meta?: Record<string, unknown>;
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: {
    hint?: string;
  };
  _meta?: Record<string, unknown>;
}

export interface AvailableCommandsUpdateSessionUpdate {
  sessionUpdate: "available_commands_update";
  availableCommands: AvailableCommand[];
  _meta?: Record<string, unknown>;
}

export interface CurrentModeUpdateSessionUpdate {
  sessionUpdate: "current_mode_update";
  currentModeId: string;
  _meta?: Record<string, unknown>;
}

export interface ConfigOptionUpdateSessionUpdate {
  sessionUpdate: "config_option_update";
  configOptions: ConfigOption[];
  _meta?: Record<string, unknown>;
}

export interface SessionInfoUpdateSessionUpdate {
  sessionUpdate: "session_info_update";
  title?: string | null;
  updatedAt?: string | null;
  _meta?: Record<string, unknown>;
}

export interface CompactionUpdateSessionUpdate {
  sessionUpdate: "compaction_update";
  status?: string;
  message?: string;
  text?: string;
  content?: ContentBlock | string;
  _meta?: Record<string, unknown>;
}

export interface CompactionSummaryChunkSessionUpdate {
  sessionUpdate: "compaction_summary_chunk";
  status?: string;
  message?: string;
  text?: string;
  content?: ContentBlock | string;
  _meta?: Record<string, unknown>;
}

export interface NoticeSessionUpdate {
  sessionUpdate: "notice";
  level?: "info" | "warn" | "warning" | "error" | (string & {});
  status?: string;
  message?: string;
  text?: string;
  content?: ContentBlock | string;
  _meta?: Record<string, unknown>;
}

/** 精确判别联合类型，覆盖 DESIGN.md 4.2.3 全部已知 session/update 类型 */
export type SessionUpdate =
  | UserMessageChunkUpdate
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | ToolCallUpdate
  | ToolCallDeltaUpdate
  | PlanSessionUpdate
  | PlanDeltaSessionUpdate
  | PlanRemovedSessionUpdate
  | UsageUpdateSessionUpdate
  | AvailableCommandsUpdateSessionUpdate
  | CurrentModeUpdateSessionUpdate
  | ConfigOptionUpdateSessionUpdate
  | SessionInfoUpdateSessionUpdate
  | CompactionUpdateSessionUpdate
  | CompactionSummaryChunkSessionUpdate
  | NoticeSessionUpdate;

export type KnownSessionUpdateType = SessionUpdate["sessionUpdate"];

export const KNOWN_SESSION_UPDATE_TYPES: ReadonlySet<string> = new Set<KnownSessionUpdateType>([
  "user_message_chunk",
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "plan_update",
  "plan_removed",
  "usage_update",
  "available_commands_update",
  "current_mode_update",
  "config_option_update",
  "session_info_update",
  "compaction_update",
  "compaction_summary_chunk",
  "notice",
]);

export interface UnknownSessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export function isKnownSessionUpdate(
  update: unknown,
): update is SessionUpdate {
  if (typeof update !== "object" || update === null) {
    return false;
  }
  const kind = (update as { sessionUpdate?: unknown }).sessionUpdate;
  return typeof kind === "string" && KNOWN_SESSION_UPDATE_TYPES.has(kind);
}

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
  _meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 服务端反向请求（S -> C）：session/request_permission & elicitation/create
// ---------------------------------------------------------------------------

export type PermissionOptionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always"
  | (string & {});

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
  _meta?: Record<string, unknown>;
}

export interface PermissionToolCallRef {
  toolCallId: string;
  title?: string;
  kind?: ToolCallKind | (string & {});
  name?: string;
  status?: ToolCallStatus;
  rawInput?: unknown;
  locations?: ToolCallLocation[];
  content?: ToolCallContent[];
  _meta?: Record<string, unknown>;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: PermissionToolCallRef;
  options: PermissionOption[];
  _meta?: Record<string, unknown>;
}

export type RequestPermissionOutcome =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface RequestPermissionResult {
  outcome: RequestPermissionOutcome;
  _meta?: Record<string, unknown>;
}

export interface JsonSchemaOneOfOption {
  const?: string | number | boolean;
  title?: string;
  description?: string;
}

export interface JsonSchemaProperty {
  type?:
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "array"
    | "object"
    | (string & {});
  title?: string;
  description?: string;
  default?: unknown;
  enum?: Array<string | number | boolean>;
  enumNames?: string[];
  oneOf?: JsonSchemaOneOfOption[];
  items?: JsonSchemaProperty;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  [key: string]: unknown;
}

export interface ElicitationRequestedSchema {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  title?: string;
  description?: string;
  [key: string]: unknown;
}

export interface ElicitationCreateParams {
  sessionId?: string;
  mode?: "form" | "url";
  message?: string;
  requestedSchema?: ElicitationRequestedSchema;
  url?: string;
  elicitationId?: string;
  _meta?: Record<string, unknown>;
}

export type ElicitationCreateResult =
  | {
      action: "accept";
      content: Record<string, unknown>;
      _meta?: Record<string, unknown>;
    }
  | {
      action: "decline";
      _meta?: Record<string, unknown>;
    }
  | {
      action: "cancel";
      _meta?: Record<string, unknown>;
    };

export interface AcpIncomingRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface PermissionServerRequest {
  id: JsonRpcId;
  method: "session/request_permission";
  params: RequestPermissionParams;
}

export interface ElicitationServerRequest {
  id: JsonRpcId;
  method: "elicitation/create";
  params: ElicitationCreateParams;
}

export type KnownAcpServerRequest =
  | PermissionServerRequest
  | ElicitationServerRequest;

export function isRequestPermissionRequest(
  req: AcpIncomingRequest,
): req is PermissionServerRequest {
  return req.method === "session/request_permission";
}

export function isElicitationCreateRequest(
  req: AcpIncomingRequest,
): req is ElicitationServerRequest {
  return req.method === "elicitation/create";
}

// ---------------------------------------------------------------------------
// 协议状态映射与数据提取纯函数
// ---------------------------------------------------------------------------

/**
 * 将 ACP tool_call 状态映射为 TSP `<tool status>`。
 * 优先级：cancelled > awaitingPermission ("ask") > 非后台命令失败/超时 ("error") > ACP status。
 */
export function mapAcpToolStatusToTsp(
  status?: ToolCallStatus,
  options?: {
    awaitingPermission?: boolean;
    cancelled?: boolean;
    exitCode?: number;
    timedOut?: boolean;
    backgroundRunning?: boolean;
  },
): TspToolStatus {
  if (options?.cancelled) {
    return "cancelled";
  }
  if (options?.awaitingPermission) {
    return "ask";
  }
  switch (status) {
    case "pending":
      return "pending";
    case "in_progress":
      return "running";
    case "completed":
      if (
        !options?.backgroundRunning &&
        (options?.timedOut ||
          (typeof options?.exitCode === "number" &&
            Number.isFinite(options.exitCode) &&
            options.exitCode !== 0))
      ) {
        return "error";
      }
      return "done";
    case "failed":
      return "error";
    default:
      return "pending";
  }
}

/** 将 ACP plan / update_steps 条目状态映射为 TSP `<checklist>` 项状态 */
export function mapPlanStatusToChecklist(
  status: PlanEntryStatus,
): TspChecklistStatus {
  switch (typeof status === "string" ? status.trim().toLowerCase() : "") {
    case "pending":
      return "pending";
    case "in_progress":
    case "active":
      return "active";
    case "completed":
    case "done":
      return "done";
    case "skipped":
    case "dropped":
    case "cancelled":
    case "canceled":
      return "dropped";
    case "failed":
    case "error":
    case "blocked":
      return "blocked";
    default:
      return "pending";
  }
}

/** 判断 tool_call rawOutput 是否携带超时标记 */
export function isToolRawOutputTimedOut(rawOutput: unknown): boolean {
  if (typeof rawOutput !== "object" || rawOutput === null || Array.isArray(rawOutput)) {
    return false;
  }
  const rec = rawOutput as Record<string, unknown>;
  if (rec.timed_out === true || rec.timedOut === true) {
    return true;
  }
  return typeof rec.status === "string" && rec.status.trim().toLowerCase() === "timed_out";
}

/**
 * 从 tool_call / tool_call_update 的 rawOutput 提取退出码。
 * 实测 agy 1.5.13 的 run_command 返回 `{ output?: string, exit_code?: number }`。
 */
export function extractToolExitCode(rawOutput: unknown): number | undefined {
  if (typeof rawOutput !== "object" || rawOutput === null) {
    return undefined;
  }
  const rec = rawOutput as Record<string, unknown>;
  if (typeof rec.exit_code === "number" && Number.isFinite(rec.exit_code)) {
    return rec.exit_code;
  }
  if (typeof rec.exitCode === "number" && Number.isFinite(rec.exitCode)) {
    return rec.exitCode;
  }
  return undefined;
}

/** 从 tool_call 的 rawOutput 提取可读输出文本 */
export function extractToolOutputText(rawOutput: unknown): string | undefined {
  if (typeof rawOutput === "string") {
    return rawOutput;
  }
  if (typeof rawOutput !== "object" || rawOutput === null) {
    return undefined;
  }
  const rec = rawOutput as Record<string, unknown>;
  if (typeof rec.output === "string" && rec.output.length > 0) {
    return rec.output;
  }
  const parts: string[] = [];
  if (typeof rec.stdout === "string" && rec.stdout.length > 0) {
    parts.push(rec.stdout);
  }
  if (typeof rec.stderr === "string" && rec.stderr.length > 0) {
    parts.push(rec.stderr);
  }
  if (parts.length > 0) {
    return parts.join("\n");
  }
  if (typeof rec.error === "string" && rec.error.trim().length > 0) {
    return rec.error;
  }
  if (typeof rec.error === "object" && rec.error !== null) {
    const errObj = rec.error as Record<string, unknown>;
    if (typeof errObj.message === "string" && errObj.message.trim().length > 0) {
      return errObj.message;
    }
  }
  if (typeof rec.message === "string" && rec.message.trim().length > 0) {
    return rec.message;
  }
  if (typeof rec.output === "string") {
    return rec.output;
  }
  return undefined;
}

/** 从 ContentBlock、字符串或容错通知字段中提取纯文本 */
export function extractContentText(
  content: ContentBlock | string | undefined | null,
): string {
  if (!content) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  switch (content.type) {
    case "text":
      return content.text;
    case "resource":
      return "text" in content.resource ? content.resource.text : "";
    case "resource_link":
      return content.title || content.name || content.uri;
    case "image":
      return `[image: ${content.mimeType}]`;
    case "audio":
      return `[audio: ${content.mimeType}]`;
    default:
      return "";
  }
}

/** 从 compaction_update / compaction_summary_chunk / notice 提取展示文本 */
export function extractNoticeText(
  update:
    | CompactionUpdateSessionUpdate
    | CompactionSummaryChunkSessionUpdate
    | NoticeSessionUpdate,
): string {
  if (typeof update.text === "string" && update.text.length > 0) {
    return update.text;
  }
  if (typeof update.message === "string" && update.message.length > 0) {
    return update.message;
  }
  const fromContent = extractContentText(update.content);
  if (fromContent.length > 0) {
    return fromContent;
  }
  if (typeof update.status === "string" && update.status.length > 0) {
    return update.status;
  }
  return "";
}
