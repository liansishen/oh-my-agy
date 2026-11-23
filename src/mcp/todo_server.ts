import crypto from 'node:crypto';
import type { McpServerConfig } from '../acp/protocol';
import {
  applyTodoOperation,
  cloneTodoPhases,
  OMA_TODO_MCP_SERVER_NAME,
  OMA_TODO_TOOL_NAME,
  type TodoCompletedDelta,
  type TodoOp,
  type TodoPhase,
} from '../state/todo';

export interface TodoServerUpdateEvent {
  readonly sessionId: string;
  readonly op: TodoOp;
  readonly phases: TodoPhase[];
  readonly completedTasks: readonly TodoCompletedDelta[];
  readonly isError: boolean;
  readonly text: string;
  readonly rawArgs: unknown;
}

export interface EmbeddedTodoMcpServerOptions {
  readonly version?: string;
  readonly onTodoChanged?: (event: TodoServerUpdateEvent) => void;
}

const TODO_TOOL_DECLARATION = {
  name: OMA_TODO_TOOL_NAME,
  description:
    'Write or update a structured multi-phase session todo list to track progress (ops: init, start, done, drop, append, rm, view).',
  inputSchema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['init', 'start', 'done', 'rm', 'drop', 'append', 'view'],
        description: 'Todo list operation to perform.',
      },
      list: {
        type: 'array',
        description: 'Structured phases with task items (used by init).',
        items: {
          type: 'object',
          properties: {
            phase: { type: 'string' },
            items: { type: 'array', items: { type: 'string' }, minItems: 1 },
          },
          required: ['phase', 'items'],
        },
      },
      task: {
        oneOf: [
          { type: 'string' },
          { type: 'array', items: { type: 'string' } },
        ],
        description: 'Verbatim task text (or array for done/drop/rm). Never pass synthetic IDs.',
      },
      phase: {
        type: 'string',
        description: 'Phase name for flat init, append target, or whole-phase done/drop/rm.',
      },
      items: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task list for flat init, append, done, drop, or rm.',
      },
      note: {
        type: 'string',
        description: 'Optional short progress note attached to the updated task(s).',
      },
    },
    required: ['op'],
  },
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
  _meta: {
    'antigravity/alwaysLoad': true,
  },
} as const;

function extractConversationSessionId(
  meta: Record<string, unknown> | undefined,
  fallbackSessionId: string | null,
): string {
  const convId = meta?.['antigravity.google/conversation_id'];
  if (typeof convId === 'string' && convId.trim().length > 0) {
    return convId.trim();
  }
  const rootId = meta?.['antigravity.google/root_conversation_id'];
  if (typeof rootId === 'string' && rootId.trim().length > 0) {
    return rootId.trim();
  }
  return fallbackSessionId?.trim() || 'default';
}

/**
 * In-process Streamable HTTP MCP server exposed to `agy acp` via `session/new` & `session/load`.
 * Binds to `127.0.0.1` on an ephemeral port with a per-process secret path token.
 */
export class EmbeddedTodoMcpServer {
  readonly #version: string;
  readonly #onTodoChanged?: (event: TodoServerUpdateEvent) => void;
  readonly #secretPath: string;
  readonly #server: ReturnType<typeof Bun.serve>;
  readonly #endpointUrl: string;
  readonly #sessionTodos = new Map<string, TodoPhase[]>();
  #activeSessionId: string | null = null;
  #disposed = false;

  constructor(options: EmbeddedTodoMcpServerOptions = {}) {
    this.#version = options.version ?? '0.2.0';
    this.#onTodoChanged = options.onTodoChanged;
    this.#secretPath = `/mcp/${crypto.randomUUID()}`;

    this.#server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req) => this.#handleHttpRequest(req),
    });

    this.#endpointUrl = `http://127.0.0.1:${this.#server.port}${this.#secretPath}`;
  }

  get endpointUrl(): string {
    return this.#endpointUrl;
  }

  setActiveSessionId(sessionId: string | null): void {
    this.#activeSessionId = sessionId;
  }

  getMcpServerConfig(): McpServerConfig {
    return {
      type: 'http',
      name: OMA_TODO_MCP_SERVER_NAME,
      url: this.#endpointUrl,
    };
  }

  getPhases(sessionId: string): TodoPhase[] {
    return cloneTodoPhases(this.#sessionTodos.get(sessionId) ?? []);
  }

  seedSession(sessionId: string, phases: readonly TodoPhase[]): void {
    const cleanId = sessionId.trim();
    if (!cleanId) return;
    if (phases.length === 0) {
      this.#sessionTodos.delete(cleanId);
    } else {
      this.#sessionTodos.set(cleanId, cloneTodoPhases(phases));
    }
  }

  clearSession(sessionId: string): void {
    const cleanId = sessionId.trim();
    if (cleanId) {
      this.#sessionTodos.delete(cleanId);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#sessionTodos.clear();
    try {
      this.#server.stop(true);
    } catch {
      // ignore close errors during shutdown
    }
  }

  async #handleHttpRequest(req: Request): Promise<Response> {
    if (this.#disposed) {
      return new Response('Service Unavailable', { status: 503 });
    }

    const url = new URL(req.url);
    if (url.pathname.startsWith('/.well-known/')) {
      return new Response('Not Found', { status: 404 });
    }
    if (url.pathname !== this.#secretPath) {
      return new Response('Not Found', { status: 404 });
    }
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    let rawBody = '';
    try {
      rawBody = await req.text();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return new Response('Invalid JSON-RPC payload', { status: 400 });
      }
      msg = parsed as Record<string, unknown>;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    const id = msg.id as string | number | null | undefined;
    const method = typeof msg.method === 'string' ? msg.method : '';
    const params =
      typeof msg.params === 'object' && msg.params !== null && !Array.isArray(msg.params)
        ? (msg.params as Record<string, unknown>)
        : {};

    // Notifications carry no request id
    if (id === undefined || id === null) {
      return new Response(null, { status: 202 });
    }

    if (method === 'initialize') {
      const protocolVersion =
        typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return Response.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: {
            name: OMA_TODO_MCP_SERVER_NAME,
            version: this.#version,
          },
        },
      });
    }

    if (method === 'ping') {
      return Response.json({ jsonrpc: '2.0', id, result: {} });
    }

    if (method === 'tools/list') {
      return Response.json({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [TODO_TOOL_DECLARATION],
        },
      });
    }

    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      if (toolName !== OMA_TODO_TOOL_NAME) {
        return Response.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
            isError: true,
          },
        });
      }

      const meta =
        typeof params._meta === 'object' && params._meta !== null && !Array.isArray(params._meta)
          ? (params._meta as Record<string, unknown>)
          : undefined;
      const sessionId = extractConversationSessionId(meta, this.#activeSessionId);
      const current = this.getPhases(sessionId);
      const outcome = applyTodoOperation(current, params.arguments);

      if (!outcome.isError && outcome.op !== 'view') {
        this.seedSession(sessionId, outcome.phases);
      }

      this.#onTodoChanged?.({
        sessionId,
        op: outcome.op,
        phases: cloneTodoPhases(outcome.phases),
        completedTasks: outcome.completedTasks,
        isError: outcome.isError,
        text: outcome.text,
        rawArgs: params.arguments,
      });

      return Response.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: outcome.text }],
          ...(outcome.isError ? { isError: true } : {}),
        },
      });
    }

    return Response.json({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`,
      },
    });
  }
}
