import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Op, type Session, type TermInput, type WireNode } from '@stencil-hq/tern';
import type { AcpChildProcess, AcpSpawnFn } from '../../src/acp/client';
import type { ConfigOption, SessionSummary } from '../../src/acp/protocol';
import { AppController, type AppControllerOptions } from '../../src/app/controller';
import { parseCliArgs } from '../../src/app/fallback';
import { DEFAULT_CONFIG, type OmaConfig, type TodoProvider } from '../../src/config/config';
import { PreviewStore } from '../../src/preview/store';
import { SafeTermOutput } from '../../src/termio/output';

const harnessTempDirs: string[] = [];

export function makeHarnessTempDir(prefix = 'oma-ctrl-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  harnessTempDirs.push(dir);
  return dir;
}

export function cleanupHarnessTempDirs(): void {
  while (harnessTempDirs.length > 0) {
    const dir = harnessTempDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    } catch {}
  }
}

export interface ReplayedWireNode {
  id: string;
  k: string;
  p: Record<string, unknown>;
}

export function replayWire(host: { readonly allOps: readonly Op[] }): Map<string, ReplayedWireNode> {
  const nodes = new Map<string, ReplayedWireNode>();
  const addSub = (n: WireNode): void => {
    nodes.set(n.id, { id: n.id, k: n.k, p: { ...(n.p ?? {}) } });
    if (n.c) for (const child of n.c) addSub(child);
  };
  const delSub = (id: string): void => {
    nodes.delete(id);
    const prefix = `${id}.`;
    for (const k of [...nodes.keys()]) if (k.startsWith(prefix)) nodes.delete(k);
  };
  for (const op of host.allOps) {
    if (op[0] === 'add') addSub(op[4]);
    else if (op[0] === 'del') delSub(op[1]);
    else if (op[0] === 'set') {
      const entry = nodes.get(op[1]);
      if (entry) {
        for (const [k, v] of Object.entries(op[2])) {
          if (v === null) delete entry.p[k];
          else entry.p[k] = v;
        }
      }
    }
  }
  return nodes;
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('waitFor timed out');
}

export class HarnessTermInput implements TermInput {
  isTTY = true;
  isRaw = false;
  readonly #listeners = new Set<(chunk: Uint8Array | string) => void>();
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): void {
    if (event === 'data') this.#listeners.add(listener);
  }
  off(event: 'data', listener: (chunk: Uint8Array | string) => void): void {
    if (event === 'data') this.#listeners.delete(listener);
  }
  setRawMode(mode: boolean): void {
    this.isRaw = mode;
  }
  resume(): void {}
  pause(): void {}
  emit(chunk: Uint8Array | string): void {
    for (const listener of [...this.#listeners]) listener(chunk);
  }
  emitTspReply(body: Record<string, unknown>): void {
    this.emit(`\x1b_tsp;r;${JSON.stringify(body)}\x1b\\`);
  }
  emitTspEvent(body: Record<string, unknown>): void {
    this.emit(`\x1b_tsp;e;${JSON.stringify(body)}\x1b\\`);
  }
}

export class TestTernHost {
  readonly input = new HarnessTermInput();
  readonly safeOutput: SafeTermOutput;
  readonly osc7501: string[] = [];
  readonly osc1337: string[] = [];
  readonly allOps: Op[] = [];
  #decoder = new TextDecoder();

  constructor(features: readonly string[] = ['blobs', 'settle', 'dock', 'scroll', 'font', 'aside']) {
    this.safeOutput = new SafeTermOutput({
      isTTY: true,
      columns: 120,
      write: (data: Uint8Array | string) => {
        const chunk = typeof data === 'string' ? data : this.#decoder.decode(data);
        for (const m of chunk.matchAll(/\x1b\]7501;([^\x1b\x07]+)(?:\x1b\\|\x07)/g)) if (m[1]) this.osc7501.push(m[1]);
        for (const m of chunk.matchAll(/\x1b\]1337;SetUserVar=([^\x1b\x07]+)(?:\x1b\\|\x07)/g)) if (m[1]) this.osc1337.push(m[1]);
        for (const m of chunk.matchAll(/\x1b_tsp;([^;]+);([^\x1b]*)\x1b\\/g)) {
          const verb = m[1] ?? '';
          if (verb === 'b') continue;
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(m[2] ?? '') as Record<string, unknown>;
          } catch {
            continue;
          }
          if (verb === 'q' && body['q'] === 'hello') {
            queueMicrotask(() =>
              this.input.emitTspReply({
                r: 'hello',
                v: 1,
                term: 'tern-fake',
                ver: '0.9.29',
                apc: 65536,
                credits: 8,
                cols: 120,
                cell: { w: 8, h: 16 },
                dark: true,
                reduceMotion: false,
                hour12: false,
                features: [...features],
              }),
            );
          } else if (verb === 'f') {
            const ops = body['ops'] as Op[] | undefined;
            if (Array.isArray(ops)) this.allOps.push(...ops);
            if (typeof body['sf'] === 'string' && typeof body['s'] === 'number') {
              const sf = body['sf'];
              const s = body['s'];
              queueMicrotask(() => this.input.emitTspEvent({ ev: 'ack', sf, s }));
            }
          }
        }
      },
    });
  }

  replayWire(): Map<string, ReplayedWireNode> {
    return replayWire(this);
  }

  findWireNodes(predicate: (node: WireNode) => boolean): WireNode[] {
    const matches: WireNode[] = [];
    const visit = (n: WireNode): void => {
      if (predicate(n)) matches.push(n);
      if (n.c) for (const child of n.c) visit(child);
    };
    for (const op of this.allOps) if (op[0] === 'add') visit(op[4]);
    return matches;
  }
}

export async function createConnectedTestSession(host: { input: TermInput; safeOutput: SafeTermOutput }): Promise<Session> {
  const session = await connect({
    app: 'oma',
    version: '0.1.0',
    features: ['edit', 'undo', 'send'],
    input: host.input,
    output: host.safeOutput,
    exitHooks: false,
    timeout: 1000,
    env: {},
  });
  if (!session) throw new Error('Failed to connect test Tern session');
  return session;
}

export const DEFAULT_TEST_CONFIG_OPTIONS: ConfigOption[] = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-4-neon',
    options: [
      { value: 'gemini-4-neon', name: 'Gemini 4 Neon', description: 'Flagship reasoning model' },
      { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon', description: 'Balanced model' },
      { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator Neon', description: 'Orchestrator' },
    ],
  },
  {
    id: 'thought_level',
    name: 'Thought Level',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'xhigh', name: 'XHigh' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'accept-edits', name: 'Accept Edits' },
      { value: 'auto', name: 'Auto' },
      { value: 'plan', name: 'Plan' },
    ],
  },
];

export interface TestRpcEnvelope {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface SentPromptRecord {
  sessionId: string;
  blocks: Array<{ type?: string; text?: string }>;
  text: string;
}

export class DeclarativeAcpHarness {
  readonly received: TestRpcEnvelope[] = [];
  readonly newParams: Array<Record<string, unknown>> = [];
  readonly loadParams: Array<Record<string, unknown>> = [];
  readonly mcpUrls: string[] = [];
  readonly sentPrompts: SentPromptRecord[] = [];
  spawnCount = 0;
  newCount = 0;
  loadCount = 0;
  shuttingDown = false;
  #stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
  #exitResolve: ((code: number) => void) | null = null;
  #encoder = new TextEncoder();
  #handler?: (msg: TestRpcEnvelope, acp: DeclarativeAcpHarness) => void;

  setHandler(fn: (msg: TestRpcEnvelope, acp: DeclarativeAcpHarness) => void): void {
    this.#handler = fn;
  }
  send(payload: Record<string, unknown>): void {
    this.#stdoutController?.enqueue(this.#encoder.encode(`${JSON.stringify(payload)}\n`));
  }
  sendUpdate(sessionId: string, update: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
  }
  reply(id: string | number | undefined, result: unknown): void {
    if (id !== undefined) this.send({ jsonrpc: '2.0', id, result });
  }
  replyError(id: string | number | undefined, code: number, message: string): void {
    if (id !== undefined) this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }
  crash(exitCode = 1): void {
    try {
      this.#stdoutController?.close();
    } catch {}
    this.#stdoutController = null;
    this.#exitResolve?.(exitCode);
    this.#exitResolve = null;
  }

  createSpawnFn(): AcpSpawnFn {
    return (): AcpChildProcess => {
      this.spawnCount += 1;
      const exited = Promise.withResolvers<number>();
      this.#exitResolve = exited.resolve;
      const stdout = new ReadableStream<Uint8Array>({ start: c => { this.#stdoutController = c; } });
      const stderr = new ReadableStream<Uint8Array>({ start() {} });
      let buf = '';
      return {
        stdout,
        stderr,
        exited: exited.promise,
        pid: 9999,
        stdin: {
          write: (chunk: string | Uint8Array) => {
            buf += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
            for (;;) {
              const nl = buf.indexOf('\n');
              if (nl < 0) break;
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              const msg = JSON.parse(line) as TestRpcEnvelope;
              this.received.push(msg);
              this.#handler?.(msg, this);
            }
          },
          flush: () => {},
          end: () => {},
        },
        kill: () => this.crash(0),
      };
    };
  }
}

export interface CreateTestControllerOptions {
  tmp?: string;
  cwd?: string;
  tag?: string;
  cliArgs?: string[];
  todoProvider?: TodoProvider;
  config?: Partial<OmaConfig>;
  agentVersion?: string;
  supportsLogout?: boolean;
  previewStore?: PreviewStore;
  host?: {
    input: TermInput & { emit(chunk: Uint8Array | string): void };
    safeOutput: SafeTermOutput;
    allOps: readonly Op[];
    osc7501: string[];
    osc1337: string[];
  };
  sessions?: SessionSummary[];
  newSessionId?: string | ((count: number) => string);
  replayUpdates?: (sessionId: string, loadCount: number) => Array<Record<string, unknown>>;
  onPrompt?: (prompt: SentPromptRecord, msg: TestRpcEnvelope, acp: DeclarativeAcpHarness) => boolean | void | Promise<boolean | void>;
  onRpc?: (msg: TestRpcEnvelope, acp: DeclarativeAcpHarness) => boolean | void | Promise<boolean | void>;
  controllerOptions?: Partial<AppControllerOptions>;
}

export async function createTestController(opts: CreateTestControllerOptions = {}) {
  const tmp = opts.tmp ?? makeHarnessTempDir();
  const tag = opts.tag ?? Math.random().toString(36).slice(2, 8);
  const cwd = opts.cwd ?? tmp;
  const previewStore = opts.previewStore ?? new PreviewStore({ sessionsDir: join(tmp, 'sessions') });
  const defaultHost = opts.host ? null : new TestTernHost();
  const host = opts.host ?? defaultHost!;
  const session = await createConnectedTestSession(host);
  const acp = new DeclarativeAcpHarness();
  const agentVersion = opts.agentVersion ?? '1.5.16';
  const supportsLogout = opts.supportsLogout ?? true;

  acp.setHandler((msg, h) => {
    const recordMcpUrl = (params: Record<string, unknown> | undefined): void => {
      const servers = params?.['mcpServers'] as Array<{ name?: string; url?: string }> | undefined;
      const url = servers?.find(s => s.name === 'oma_todo')?.url ?? servers?.[0]?.url;
      if (url) h.mcpUrls.push(url);
    };
    const custom = opts.onRpc?.(msg, h);
    if (custom === true || custom instanceof Promise) {
      void custom;
      return;
    }
    if (msg.method === 'initialize') {
      h.reply(msg.id, {
        protocolVersion: 1,
        agentInfo: { name: 'Antigravity ACP Server', version: agentVersion },
        agentCapabilities: { loadSession: true, ...(supportsLogout ? { auth: { logout: {} } } : {}) },
      });
    } else if (msg.method === 'session/new') {
      h.newCount += 1;
      const p = (msg.params ?? {}) as Record<string, unknown>;
      h.newParams.push(p);
      recordMcpUrl(p);
      const sessionId =
        typeof opts.newSessionId === 'function'
          ? opts.newSessionId(h.newCount)
          : opts.newSessionId && h.newCount === 1
            ? opts.newSessionId
            : `sess-new-${h.newCount}`;
      h.reply(msg.id, { sessionId, configOptions: DEFAULT_TEST_CONFIG_OPTIONS });
    } else if (msg.method === 'session/load') {
      h.loadCount += 1;
      const p = (msg.params ?? {}) as Record<string, unknown>;
      h.loadParams.push(p);
      recordMcpUrl(p);
      const sid = String(p['sessionId'] ?? '');
      for (const update of opts.replayUpdates?.(sid, h.loadCount) ?? []) h.sendUpdate(sid, update);
      h.reply(msg.id, { sessionId: sid, configOptions: DEFAULT_TEST_CONFIG_OPTIONS });
    } else if (msg.method === 'session/list') {
      h.reply(msg.id, { sessions: opts.sessions ?? [], nextCursor: null });
    } else if (msg.method === 'session/set_config_option') {
      const p = (msg.params ?? {}) as { configId?: string; value?: string };
      h.reply(msg.id, {
        configOptions: DEFAULT_TEST_CONFIG_OPTIONS.map(o =>
          o.id === (p.configId ?? 'thought_level') ? { ...o, currentValue: p.value ?? o.currentValue } : o,
        ),
      });
    } else if (msg.method === 'session/prompt') {
      const p = (msg.params ?? {}) as { sessionId?: string; prompt?: Array<{ type?: string; text?: string }> };
      const blocks = p.prompt ?? [];
      const rec: SentPromptRecord = { sessionId: p.sessionId ?? '', blocks, text: blocks.map(b => b.text ?? '').join('') };
      h.sentPrompts.push(rec);
      const promptHandled = opts.onPrompt?.(rec, msg, h);
      if (promptHandled === true || promptHandled instanceof Promise) {
        void promptHandled;
        return;
      }
      h.reply(msg.id, { stopReason: 'end_turn' });
    } else if (msg.method === 'auth/logout') {
      h.reply(msg.id, {});
    } else if (msg.method === 'session/close') {
      h.reply(msg.id, {});
      if (h.shuttingDown) h.crash(0);
    } else if (msg.id !== undefined) {
      h.reply(msg.id, {});
    }
  });

  const mergedConfig: OmaConfig = {
    ...DEFAULT_CONFIG,
    ...opts.config,
    ui: { ...DEFAULT_CONFIG.ui, ...(opts.config?.ui ?? {}), ...(opts.todoProvider ? { todo_provider: opts.todoProvider } : {}) },
    approval: opts.config?.approval ?? DEFAULT_CONFIG.approval,
  };

  const controller = new AppController({
    cli: parseCliArgs(opts.cliArgs ?? []),
    config: mergedConfig,
    cwd,
    session,
    output: host.safeOutput,
    acpSpawn: acp.createSpawnFn(),
    previewStore,
    configPath: join(tmp, `config-${tag}.toml`),
    agySettingsPath: join(tmp, `settings-${tag}.json`),
    workspaceSkillsDir: join(tmp, 'empty-ws'),
    globalSkillsDir: join(tmp, 'empty-global'),
    agentsGlobalSkillsDir: join(tmp, 'empty-agents-global'),
    dataDir: join(tmp, `data-${tag}`),
    gitExec: async () => ({ exitCode: 128, stdout: '' }),
    installSignals: false,
    throttleMs: 5,
    replayDrainQuietMs: 5,
    ...opts.controllerOptions,
  });

  let runPromise: Promise<number> | null = null;
  return {
    tmp,
    cwd,
    host,
    testHost: defaultHost,
    session,
    acp,
    previewStore,
    controller,
    replayWire: () => replayWire(host),
    start() {
      if (!runPromise) runPromise = controller.run();
      return runPromise;
    },
    async boot(): Promise<void> {
      this.start();
      await controller.readyPromise;
      await waitFor(() => controller.store.getState().isReady);
    },
    async shutdown() {
      acp.shuttingDown = true;
      await controller.shutdown({ cleanExit: true });
      if (runPromise) await runPromise;
    },
  };
}

export async function callTodoMcp(
  url: string,
  args: Record<string, unknown>,
  meta?: Record<string, unknown>,
  id = 1,
): Promise<{ status: number; isError: boolean; text: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'todo', arguments: args, ...(meta ? { _meta: meta } : {}) },
    }),
  });
  if (res.status !== 200) return { status: res.status, isError: true, text: '' };
  const json = (await res.json()) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  return { status: res.status, isError: Boolean(json.result?.isError), text: json.result?.content?.[0]?.text ?? '' };
}
