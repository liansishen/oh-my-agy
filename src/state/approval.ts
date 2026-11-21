/**
 * Permission approval queue, `auto_allow_tools` prefix/exact rule matcher,
 * ACP permission option mapper (`allow_once` / `allow_always` / `reject_once`),
 * and batch cancellation support for `Esc` / shutdown races (DESIGN.md 4.2.3, 4.5.1, 4.8, 5).
 */

export type ApprovalAction = 'allow' | 'always' | 'deny';
export type ApprovalDecision = 'once' | 'always' | 'denied' | 'cancelled';

export interface PermissionOptionLike {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

export interface PermissionToolCallLike {
  readonly toolCallId: string;
  readonly name?: string;
  readonly title?: string;
  readonly kind?: string;
  readonly rawInput?: unknown;
}

export interface PermissionRequestLike {
  readonly sessionId: string;
  readonly toolCall: PermissionToolCallLike;
  readonly options: readonly PermissionOptionLike[];
}

export type PermissionResponsePayload =
  | { readonly outcome: { readonly outcome: 'selected'; readonly optionId: string } }
  | { readonly outcome: { readonly outcome: 'cancelled' } };

export interface MappedPermissionOptions {
  readonly allowOnce?: PermissionOptionLike;
  readonly allowAlways?: PermissionOptionLike;
  readonly rejectOnce?: PermissionOptionLike;
  readonly rejectAlways?: PermissionOptionLike;
  readonly ask: {
    readonly text: string;
    readonly allow: string;
    readonly deny: string;
    readonly always: string | false;
  };
}

export interface PendingApproval {
  readonly requestId: string | number;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName?: string;
  readonly toolKind?: string;
  readonly title?: string;
  readonly rawInput?: unknown;
  readonly options: readonly PermissionOptionLike[];
  readonly mapped: MappedPermissionOptions;
  readonly createdAt: number;
  readonly resolve: (response: PermissionResponsePayload) => void;
}

export type EnqueueApprovalResult =
  | {
      readonly autoAllowed: true;
      readonly toolCallId: string;
      readonly optionId: string;
      readonly decision: 'once' | 'always';
      readonly matchedRule: string;
    }
  | {
      readonly autoAllowed: false;
      readonly item: PendingApproval;
    };

export interface ApprovalDecisionResult {
  readonly item: PendingApproval;
  readonly decision: 'once' | 'always' | 'denied';
  readonly optionId: string;
}

const PREFIX_BOUNDARY_RE = /[_\-:/.\s]/;

/**
 * Match a single tool identifier against an `auto_allow_tools` rule.
 * Supports:
 *  - exact match (e.g. `"read_file"` matches `"read_file"`)
 *  - explicit wildcard prefix (e.g. `"read_*"` matches `"read_file"`)
 *  - boundary-safe prefix match (e.g. `"read"` matches `"read_file"` or `"read:foo"`,
 *    `"mcp_github_"` matches `"mcp_github_list_issues"`, without falsely matching `"ready"`)
 */
export function matchToolRule(candidate: string, rawRule: string): boolean {
  const target = candidate.trim().toLowerCase();
  const rule = rawRule.trim().toLowerCase();
  if (!target || !rule) return false;

  if (rule === '*') return true;

  if (rule.endsWith('*')) {
    const prefix = rule.slice(0, -1);
    return prefix.length > 0 && target.startsWith(prefix);
  }

  if (target === rule) return true;

  if (target.startsWith(rule)) {
    const lastRuleChar = rule[rule.length - 1] ?? '';
    const nextTargetChar = target[rule.length] ?? '';
    if (PREFIX_BOUNDARY_RE.test(lastRuleChar) || PREFIX_BOUNDARY_RE.test(nextTargetChar)) {
      return true;
    }
  }

  return false;
}

/**
 * Check if a permission request matches any rule in `autoAllowTools`.
 * Returns the first matching rule string, or null.
 */
export function findMatchingAutoAllowRule(
  toolCall: PermissionToolCallLike,
  autoAllowTools: readonly string[],
): string | null {
  if (autoAllowTools.length === 0) return null;

  const candidates: string[] = [];
  if (toolCall.name) candidates.push(toolCall.name);
  if (toolCall.kind) candidates.push(toolCall.kind);
  // Some ACP servers put the tool name in `title` (e.g. "read_file" or "read_file src/a.ts")
  if (toolCall.title) {
    const firstToken = toolCall.title.trim().split(/\s+/)[0];
    if (firstToken) candidates.push(firstToken);
  }

  for (const rule of autoAllowTools) {
    for (const candidate of candidates) {
      if (matchToolRule(candidate, rule)) {
        return rule;
      }
    }
  }
  return null;
}

/**
 * Map ACP permission options to structured allow_once / allow_always / reject_once
 * slots and `<tool ask={...}>` display labels.
 */
export function mapPermissionOptions(
  options: readonly PermissionOptionLike[],
  toolCall?: PermissionToolCallLike,
): MappedPermissionOptions {
  const allowOnce =
    options.find((o) => o.kind === 'allow_once') ??
    options.find((o) => o.kind.startsWith('allow') && o.kind !== 'allow_always') ??
    options.find((o) => o.kind === 'allow_always') ??
    options[0];

  const allowAlways = options.find((o) => o.kind === 'allow_always');

  const rejectOnce =
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => o.kind === 'reject_always') ??
    options.find((o) => o.kind.startsWith('reject'));

  const rejectAlways = options.find((o) => o.kind === 'reject_always');

  const label = toolCall?.title || toolCall?.name || toolCall?.kind || 'this tool';
  const askText = `Allow ${label}?`;

  return {
    allowOnce,
    allowAlways,
    rejectOnce,
    rejectAlways,
    ask: {
      text: askText,
      allow: allowOnce?.name || 'Allow',
      deny: rejectOnce?.name || 'Deny',
      always: allowAlways ? allowAlways.name || 'Always allow' : false,
    },
  };
}

export class ApprovalQueue {
  private readonly _queue: PendingApproval[] = [];
  private _autoAllowTools: string[];
  private readonly _now: () => number;

  constructor(options: { autoAllowTools?: readonly string[]; now?: () => number } = {}) {
    this._autoAllowTools = [...(options.autoAllowTools ?? [])];
    this._now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this._queue.length;
  }

  hasPending(): boolean {
    return this._queue.length > 0;
  }

  get autoAllowTools(): readonly string[] {
    return this._autoAllowTools;
  }

  setAutoAllowTools(rules: readonly string[]): void {
    this._autoAllowTools = [...rules];
  }

  peek(): PendingApproval | undefined {
    return this._queue[0];
  }

  list(): readonly PendingApproval[] {
    return this._queue;
  }

  getByToolCallId(toolCallId: string): PendingApproval | undefined {
    return this._queue.find((item) => item.toolCallId === toolCallId);
  }

  getByRequestId(requestId: string | number): PendingApproval | undefined {
    return this._queue.find((item) => item.requestId === requestId);
  }

  /**
   * Enqueue an incoming `session/request_permission` request.
   * If the tool matches `auto_allow_tools`, immediately responds via `resolve`
   * and skips queueing.
   */
  enqueue(
    requestId: string | number,
    request: PermissionRequestLike,
    resolve: (response: PermissionResponsePayload) => void,
  ): EnqueueApprovalResult {
    const mapped = mapPermissionOptions(request.options, request.toolCall);

    const matchedRule = findMatchingAutoAllowRule(request.toolCall, this._autoAllowTools);
    if (matchedRule !== null && mapped.allowOnce) {
      resolve({
        outcome: {
          outcome: 'selected',
          optionId: mapped.allowOnce.optionId,
        },
      });
      return {
        autoAllowed: true,
        toolCallId: request.toolCall.toolCallId,
        optionId: mapped.allowOnce.optionId,
        decision: mapped.allowOnce.kind === 'allow_always' ? 'always' : 'once',
        matchedRule,
      };
    }

    const item: PendingApproval = {
      requestId,
      sessionId: request.sessionId,
      toolCallId: request.toolCall.toolCallId,
      ...(request.toolCall.name !== undefined ? { toolName: request.toolCall.name } : {}),
      ...(request.toolCall.kind !== undefined ? { toolKind: request.toolCall.kind } : {}),
      ...(request.toolCall.title !== undefined ? { title: request.toolCall.title } : {}),
      ...(request.toolCall.rawInput !== undefined ? { rawInput: request.toolCall.rawInput } : {}),
      options: request.options,
      mapped,
      createdAt: this._now(),
      resolve,
    };

    this._queue.push(item);
    return { autoAllowed: false, item };
  }

  /**
   * Resolve a queued permission request using user action (`allow` / `always` / `deny`).
   * Defaults to the head of the queue when `target` is omitted.
   * Returns `null` if no matching item exists or the requested option is unavailable
   * (e.g. `always` when server did not provide an `allow_always` option).
   */
  decide(
    action: ApprovalAction,
    target?: { toolCallId?: string; requestId?: string | number },
  ): ApprovalDecisionResult | null {
    const idx = this.findIndex(target);
    if (idx === -1) return null;

    const item = this._queue[idx];
    if (!item) return null;

    let option: PermissionOptionLike | undefined;
    let decision: 'once' | 'always' | 'denied';

    if (action === 'allow') {
      option = item.mapped.allowOnce;
      decision = 'once';
    } else if (action === 'always') {
      option = item.mapped.allowAlways;
      decision = 'always';
    } else {
      option = item.mapped.rejectOnce;
      decision = 'denied';
    }

    if (!option) {
      // Fallback: if denying and server omitted reject options, cancel instead of stranding
      if (action === 'deny') {
        this._queue.splice(idx, 1);
        item.resolve({ outcome: { outcome: 'cancelled' } });
        return { item, decision: 'denied', optionId: '' };
      }
      return null;
    }

    this._queue.splice(idx, 1);
    item.resolve({
      outcome: {
        outcome: 'selected',
        optionId: option.optionId,
      },
    });

    return {
      item,
      decision,
      optionId: option.optionId,
    };
  }

  /**
   * Cancel a single pending permission request with `{ outcome: { outcome: 'cancelled' } }`.
   */
  cancelOne(target: { toolCallId?: string; requestId?: string | number }): PendingApproval | null {
    const idx = this.findIndex(target);
    if (idx === -1) return null;
    const [removed] = this._queue.splice(idx, 1);
    if (!removed) return null;
    removed.resolve({ outcome: { outcome: 'cancelled' } });
    return removed;
  }

  /**
   * Batch-cancel all pending permission requests before `session/cancel` or shutdown.
   * Returns all cancelled items so callers can update tool cards to `cancelled`.
   */
  cancelAll(): PendingApproval[] {
    if (this._queue.length === 0) return [];
    const cancelled = this._queue.splice(0, this._queue.length);
    for (const item of cancelled) {
      item.resolve({ outcome: { outcome: 'cancelled' } });
    }
    return cancelled;
  }

  private findIndex(target?: { toolCallId?: string; requestId?: string | number }): number {
    if (!target) return this._queue.length > 0 ? 0 : -1;
    if (target.requestId !== undefined) {
      return this._queue.findIndex((i) => i.requestId === target.requestId);
    }
    if (target.toolCallId !== undefined) {
      return this._queue.findIndex((i) => i.toolCallId === target.toolCallId);
    }
    return this._queue.length > 0 ? 0 : -1;
  }
}
