import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  blobId,
  connect,
  encodeJson,
  type Op,
  type TermInput,
  type WireNode,
} from '@stencil-hq/tern';
import type { AcpChildProcess, AcpSpawnFn } from '../src/acp/client';
import { AppController } from '../src/app/controller';
import { parseCliArgs } from '../src/app/fallback';
import { DEFAULT_CONFIG, parseConfigToml } from '../src/config/config';
import type { ExecCommandFn } from '../src/ecosystem/cli';
import { PreviewStore } from '../src/preview/store';
import type { GitExecFn } from '../src/state/git_status';
import { COMPLETION_LIST_PREFIX, EDITOR_NODE_ID } from '../src/state/store';
import { HIDE_CURSOR, SHOW_CURSOR } from '../src/termio/osc';
import { SafeTermOutput } from '../src/termio/output';
import {
  ANTIGRAVITY_LOGO_PATH,
  getAntigravityLogoAsset,
  getMemberBeeAssetPair,
  getSwarmBeeAssets,
  SWARM_BEE_EFFECT_CSS,
  WELCOME_LOGO_HEIGHT,
  WELCOME_LOGO_WIDTH,
} from '../src/ui/assets';
import { computePickerData } from '../src/ui/PickerView';
import { SWARM_POSTS_LIST_PREFIX } from '../src/ui/SwarmBoardView';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oma-ui-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
    } catch {
      // Ignore transient Windows EBUSY lock on temp dir cleanup after test assertions passed
    }
  }
});

// ---------------------------------------------------------------------------
// In-memory Fake Terminal driving real `@stencil-hq/tern` Session & Surface
// ---------------------------------------------------------------------------

interface CapturedTspMessage {
  verb: string;
  body: Record<string, unknown>;
}

class FakeTermInput implements TermInput {
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
    for (const listener of [...this.#listeners]) {
      listener(chunk);
    }
  }

  emitTspReply(body: Record<string, unknown>): void {
    this.emit(`\x1b_tsp;r;${JSON.stringify(body)}\x1b\\`);
  }

  emitTspEvent(body: Record<string, unknown>): void {
    this.emit(`\x1b_tsp;e;${JSON.stringify(body)}\x1b\\`);
  }
}

class FakeTernHost {
  readonly input = new FakeTermInput();
  readonly safeOutput: SafeTermOutput;
  readonly rawWrites: string[] = [];
  readonly tspMessages: CapturedTspMessage[] = [];
  readonly osc7501: string[] = [];
  readonly osc1337: string[] = [];
  readonly oscTitles: string[] = [];
  readonly allOps: Op[] = [];

  #decoder = new TextDecoder();
  #autoAck: boolean;
  readonly #features: readonly string[];
  readonly #kinds?: readonly string[];
  readonly #credits: number;
  readonly #hour12: boolean;
  readonly #dark: boolean;

  constructor(
    options: {
      features?: readonly string[];
      kinds?: readonly string[];
      credits?: number;
      autoAck?: boolean;
      hour12?: boolean;
      dark?: boolean;
    } = {}
  ) {
    this.#features = options.features ?? ['blobs', 'settle', 'dock', 'scroll', 'font', 'aside'];
    this.#kinds = options.kinds;
    this.#credits = options.credits ?? 8;
    this.#autoAck = options.autoAck ?? true;
    this.#hour12 = options.hour12 ?? false;
    this.#dark = options.dark ?? true;
    this.safeOutput = new SafeTermOutput({
      isTTY: true,
      columns: 120,
      write: (data: Uint8Array | string) => {
        const text = typeof data === 'string' ? data : this.#decoder.decode(data);
        this.rawWrites.push(text);
        this.#parseOutput(text);
      },
    });
  }

  setAutoAck(enabled: boolean): void {
    this.#autoAck = enabled;
  }

  ackFrame(sf: string, s: number): void {
    this.input.emitTspEvent({ ev: 'ack', sf, s });
  }

  get rawStream(): string {
    return this.rawWrites.join('');
  }

  #parseOutput(chunk: string): void {
    // Parse OSC 2 window/pane title sequences
    for (const m of chunk.matchAll(/\x1b\]2;([^\x1b\x07]*)(?:\x1b\\|\x07)/g)) {
      if (m[1] !== undefined) this.oscTitles.push(m[1]);
    }
    // Parse OSC 7501 sequences
    for (const m of chunk.matchAll(/\x1b\]7501;([^\x1b\x07]+)(?:\x1b\\|\x07)/g)) {
      if (m[1]) this.osc7501.push(m[1]);
    }
    // Parse OSC 1337 SetUserVar sequences
    for (const m of chunk.matchAll(/\x1b\]1337;SetUserVar=([^\x1b\x07]+)(?:\x1b\\|\x07)/g)) {
      if (m[1]) this.osc1337.push(m[1]);
    }
    // Parse TSP APC frames: ESC _ tsp;<verb>;<body> ESC \
    for (const m of chunk.matchAll(/\x1b_tsp;([^;]+);([^\x1b]*)\x1b\\/g)) {
      const verb = m[1] ?? '';
      const rawBody = m[2] ?? '';
      let body: Record<string, unknown> = {};
      try {
        if (verb !== 'b') {
          body = JSON.parse(rawBody) as Record<string, unknown>;
        } else {
          const mimeMatch = /^mime=([^;]+);(.*)$/s.exec(rawBody);
          body = mimeMatch
            ? { blob: rawBody, mime: mimeMatch[1], base64: mimeMatch[2] }
            : { blob: rawBody, base64: rawBody };
        }
      } catch {
        body = { raw: rawBody };
      }
      this.tspMessages.push({ verb, body });

      if (verb === 'q' && body['q'] === 'hello') {
        queueMicrotask(() => {
          this.input.emitTspReply({
            r: 'hello',
            v: 1,
            term: 'tern-fake',
            ver: '0.9.29',
            apc: 65536,
            credits: this.#credits,
            cols: 120,
            cell: { w: 8, h: 16 },
            dark: this.#dark,
            reduceMotion: false,
            hour12: this.#hour12,
            ...(this.#kinds ? { kinds: [...this.#kinds] } : {}),
            features: [...this.#features],
          });
        });
      } else if (verb === 'f') {
        const ops = body['ops'] as Op[] | undefined;
        if (Array.isArray(ops)) {
          this.allOps.push(...ops);
        }
        if (this.#autoAck && typeof body['sf'] === 'string' && typeof body['s'] === 'number') {
          const sf = body['sf'];
          const s = body['s'];
          queueMicrotask(() => {
            this.input.emitTspEvent({ ev: 'ack', sf, s });
          });
        }
      }
    }
  }

  getFocusOps(): Array<string | null> {
    return this.allOps
      .filter((op): op is readonly ['focus', string | null] => op[0] === 'focus')
      .map(op => op[1]);
  }

  findWireNodes(predicate: (node: WireNode) => boolean): WireNode[] {
    const matches: WireNode[] = [];
    const visit = (n: WireNode): void => {
      if (predicate(n)) matches.push(n);
      if (n.c) {
        for (const child of n.c) visit(child);
      }
    };
    for (const op of this.allOps) {
      if (op[0] === 'add') {
        visit(op[4]);
      }
    }
    return matches;
  }
}

// ---------------------------------------------------------------------------
// In-memory Mock ACP Server for deterministic E2E tests
// ---------------------------------------------------------------------------

interface RpcEnvelope {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

class MockAcpHarness {
  readonly received: RpcEnvelope[] = [];
  readonly spawnCount = { value: 0 };

  #stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
  #exitResolve: ((code: number) => void) | null = null;
  #encoder = new TextEncoder();
  #onMessage?: (msg: RpcEnvelope, harness: MockAcpHarness) => void;

  setHandler(fn: (msg: RpcEnvelope, harness: MockAcpHarness) => void): void {
    this.#onMessage = fn;
  }

  send(payload: Record<string, unknown>): void {
    if (!this.#stdoutController) return;
    this.#stdoutController.enqueue(this.#encoder.encode(`${JSON.stringify(payload)}\n`));
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
      this.spawnCount.value += 1;
      const exited = Promise.withResolvers<number>();
      this.#exitResolve = exited.resolve;

      const stdout = new ReadableStream<Uint8Array>({
        start: controller => {
          this.#stdoutController = controller;
        },
      });
      const stderr = new ReadableStream<Uint8Array>({
        start: controller => {
          controller.enqueue(this.#encoder.encode('mock stderr diagnostic\n'));
        },
      });

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
              const msg = JSON.parse(line) as RpcEnvelope;
              this.received.push(msg);
              this.#onMessage?.(msg, this);
            }
          },
          flush: () => {},
          end: () => {},
        },
        kill: () => {
          this.crash(0);
        },
      };
    };
  }
}

const DEFAULT_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'gemini-4-neon',
    options: [
      { value: 'gemini-4-neon', name: 'Gemini 4 Neon', description: 'Flagship reasoning model' },
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('waitFor timed out');
}

async function createConnectedSession(host: FakeTernHost) {
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
  expect(session).not.toBeNull();
  return session!;
}

// ---------------------------------------------------------------------------
// E2E Tests
// ---------------------------------------------------------------------------

describe('UI + Controller + Real @stencil-hq/tern Session/Surface E2E', () => {
  test('initialization sendable/typeahead transition, dock.ed focus, OSC 7501/1337, and clean /quit', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    const releaseNewSession = Promise.withResolvers<void>();

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'Antigravity', version: '1.5.13' },
            agentCapabilities: { promptCapabilities: { image: true, embeddedContext: true } },
          },
        });
      } else if (msg.method === 'session/new') {
        void releaseNewSession.promise.then(() => {
          h.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessionId: 'sess-init-1',
              configOptions: DEFAULT_CONFIG_OPTIONS,
            },
          });
        });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();

    // Verify 1:1 omp surface open options (`role: 'omp.session'`, no `font: 'sans'`, `chat: true`)
    const openMsg = host.tspMessages.find(m => m.verb === 'o');
    expect(openMsg).toBeDefined();
    expect(openMsg!.body['id']).toBe('oma');
    expect(openMsg!.body['role']).toBe('omp.session');
    expect(openMsg!.body['chat']).toBe(true);
    expect(openMsg!.body['font']).toBeUndefined();

    // Before session/new finishes: editor must be sendable=false, typeahead=true, no prompt="> ", and focused on EDITOR_NODE_ID
    await waitFor(() => host.findWireNodes(n => n.id === EDITOR_NODE_ID).length > 0);
    const initialEd = host.findWireNodes(n => n.id === EDITOR_NODE_ID)[0]!;
    expect(initialEd.p?.['sendable']).toBe(false);
    expect(initialEd.p?.['typeahead']).toBe(true);
    expect(initialEd.p?.['prompt']).toBeUndefined();
    expect(host.getFocusOps()[0]).toBe(EDITOR_NODE_ID);

    // Verify 1:1 omp Welcome card & Antigravity A-mark logo uploaded via `b` frame
    const mainRoot = host.findWireNodes(n => n.id === 'main')[0];
    expect(mainRoot?.p?.['role']).toBe('omp.transcript');
    const welcomeCard = host.findWireNodes(n => n.id === 'main.welcome' && n.k === 'card')[0];
    expect(welcomeCard?.p?.['role']).toBe('omp.welcome');
    expect(host.findWireNodes(n => n.p?.['role'] === 'omp.welcome.lockup').length).toBeGreaterThan(0);
    const darkLogo = getAntigravityLogoAsset(true);
    const expectedDarkBlobId = blobId(darkLogo.bytes);
    const blobFrames = host.tspMessages.filter(m => m.verb === 'b');
    expect(blobFrames.length).toBeGreaterThanOrEqual(1);
    expect(blobFrames[0]?.body['mime']).toBe('image/svg+xml');
    const uploadedSvg = Buffer.from(String(blobFrames[0]?.body['base64'] ?? ''), 'base64').toString('utf8');
    expect(uploadedSvg).toContain('<svg');
    expect(uploadedSvg).toContain(ANTIGRAVITY_LOGO_PATH);
    expect(uploadedSvg).not.toContain('currentColor');
    const logoNode = host.findWireNodes(n => n.p?.['role'] === 'omp.welcome.logo')[0];
    expect(logoNode?.k).toBe('image');
    expect(logoNode?.p?.['blob']).toBe(expectedDarkBlobId);
    expect(logoNode?.p?.['builtin']).toBeUndefined();
    expect(logoNode?.p?.['w']).toBe(WELCOME_LOGO_WIDTH);
    expect(logoNode?.p?.['h']).toBe(WELCOME_LOGO_HEIGHT);
    expect(host.findWireNodes(n => n.p?.['role'] === 'omp.welcome.wordmark').length).toBeGreaterThan(0);
    expect(host.findWireNodes(n => n.p?.['role'] === 'omp.welcome.version').length).toBeGreaterThan(0);
    expect(host.findWireNodes(n => n.p?.['role'] === 'omp.welcome.tip').length).toBeGreaterThan(0);

    // Verify Welcome (.sf-fresh) hides duplicate cwd segment in omp.composer.extras
    expect(host.findWireNodes(n => n.id === 'dock.composer.bar.extras.cwd').length).toBe(0);

    // Verify 1:1 omp Composer card hierarchy & bar roles
    const composerCard = host.findWireNodes(n => n.id === 'dock.composer')[0];
    expect(composerCard?.p?.['role']).toBe('omp.editor');
    const composerLine = host.findWireNodes(n => n.id === 'dock.composer.line')[0];
    expect(composerLine?.p?.['role']).toBe('omp.composer.line');
    const composerBar = host.findWireNodes(n => n.id === 'dock.composer.bar')[0];
    expect(composerBar?.p?.['role']).toBe('omp.composer.bar');
    const modelBtn = host.findWireNodes(n => n.id === 'dock.composer.bar.model')[0];
    expect(modelBtn?.p?.['role']).toBe('omp.composer.model');
    expect((modelBtn?.p?.['actions'] as Record<string, unknown> | undefined)?.['click']).toBe('status.model');
    const sendKbd = host.findWireNodes(n => n.id === 'dock.composer.bar.send')[0];
    expect(sendKbd?.p?.['role']).toBe('omp.composer.send');
    expect((sendKbd?.p?.['actions'] as Record<string, unknown> | undefined)?.['click']).toBe('submit');

    // Now resolve session/new -> ready state
    releaseNewSession.resolve();
    await controller.readyPromise;

    await waitFor(() =>
      host.allOps.some(
        op => op[0] === 'set' && op[1] === EDITOR_NODE_ID && op[2]['sendable'] === true && op[2]['typeahead'] === false
      )
    );
    expect(host.osc7501).toContain('state=idle');
    expect(host.osc1337.some(v => v.startsWith('omp_restore=MQ=='))).toBe(true);
    expect(host.osc1337.some(v => v.startsWith('omp_session_file=') && v.length > 'omp_session_file='.length)).toBe(true);

    // Clean exit via /quit -> must clear reopen anchor, emit OSC 7501 state=clear, send session/close BEFORE session.close()
    await controller.submitInput('/quit');
    const code = await runPromise;

    expect(code).toBe(0);
    expect(host.osc1337).toContain('omp_restore=');
    expect(host.osc1337).toContain('omp_session_file=');
    expect(host.osc7501).toContain('state=clear');
    expect(acp.received.some(m => m.method === 'session/close')).toBe(true);
    expect(host.tspMessages.some(m => m.verb === 'x')).toBe(true);
    expect(host.input.isRaw).toBe(false);
    expect(host.safeOutput.closed).toBe(true);
  });

  test('dual-track Key + EditEvent (strict len guard) + UndoEvent + caret completion popup', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-ed', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // 1. Key-track typing "/re" triggers 1:1 omp caret-anchored completion popup
    host.input.emit('/re');
    await waitFor(() => controller.store.draft.text === '/re');

    const overlays = host.findWireNodes(n => n.id === 'layer.complete' && n.k === 'overlay');
    expect(overlays.length).toBeGreaterThan(0);
    expect(overlays[0]!.p?.['anchor']).toEqual({ caret: EDITOR_NODE_ID });
    expect(overlays[0]!.p?.['role']).toBe('omp.autocomplete');
    expect(overlays[0]!.p?.['size']).toBeUndefined();

    const selectWrap = host.findWireNodes(n => n.id === 'layer.complete.select' && n.k === 'col');
    expect(selectWrap.length).toBeGreaterThan(0);
    expect(selectWrap[0]!.p?.['role']).toBe('omp.select');

    const lists = host.findWireNodes(n => n.id === 'layer.complete.select.list' && n.k === 'list');
    expect(lists.length).toBeGreaterThan(0);
    const selectedProp = lists[lists.length - 1]!.p?.['selected'];
    expect(typeof selectedProp).toBe('string');
    expect(String(selectedProp).startsWith(COMPLETION_LIST_PREFIX)).toBe(true);
    // Incremental typing '/re' updates item label with `s: 'mark'` highlight spans via `set` op
    const markUpdateOp = host.allOps.find(
      op =>
        op[0] === 'set' &&
        op[1] === `${COMPLETION_LIST_PREFIX}cmd_resume` &&
        JSON.stringify(op[2]['label'] ?? '').includes('"s":"mark"')
    );
    expect(markUpdateOp).toBeDefined();

    // 2. EditEvent with mismatched len MUST be ignored
    host.input.emitTspEvent({
      ev: 'edit',
      sf: 'oma',
      id: EDITOR_NODE_ID,
      from: 0,
      to: 3,
      text: 'BROKEN',
      cursor: 6,
      len: 999,
    });
    await Bun.sleep(30);
    expect(controller.store.draft.text).toBe('/re');

    // 3. EditEvent with exact matching len replaces text cleanly
    host.input.emitTspEvent({
      ev: 'edit',
      sf: 'oma',
      id: EDITOR_NODE_ID,
      from: 0,
      to: 3,
      text: '你好世界',
      cursor: 4,
      len: 3,
    });
    await waitFor(() => controller.store.draft.text === '你好世界');

    // 4. UndoEvent restores previous text
    host.input.emitTspEvent({ ev: 'undo', sf: 'oma', id: EDITOR_NODE_ID });
    await waitFor(() => controller.store.draft.text === '/re');

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('streaming transcript (1:1 omp.user, omp.assistant, omp.thinking, omp.tool.* & omp.run, omp.tool.task, omp.tool.todo, omp.working Spindle, usage meter, settle, GoneEvent) & dynamic effort hiding', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, agentInfo: { name: 'agy', version: '1.5.13' } },
        });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-stream', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        const sid = 'sess-stream';
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking deeply...' } },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-bash',
              kind: 'execute',
              name: 'run_command',
              title: 'bun test',
              args: { CommandLine: 'bun test' },
              status: 'completed',
              rawOutput: { output: 'all green', exit_code: 0 },
            },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-edit',
              kind: 'edit',
              name: 'edit_file',
              title: 'File /D:/Projects/oh-my-agy/a.ts',
              locations: [{ path: '/D:/Projects/oh-my-agy/a.ts' }],
              status: 'completed',
              content: [{ type: 'diff', path: '/D:/Projects/oh-my-agy/a.ts', oldText: 'const a = 1;', newText: 'const a = 2;' }],
            },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-swarm',
              name: 'swarm',
              title: 'swarm add',
              status: 'in_progress',
              args: { action: 'add', name: 'worker', brief: 'Build UI' },
            },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'plan',
              entries: [{ content: 'Implement UI', status: 'in_progress', priority: 'high' }],
            },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'usage_update', used: 14000, size: 1000000 },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'compaction_update', status: 'done', text: 'Compacted context' },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'compaction_summary_chunk', text: 'Compacted earlier turns.' },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'notice', level: 'warning', message: 'Quota notice' },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done implementing!' } },
          },
        });
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn' },
        });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // Submit via SendEvent
    host.input.emitTspEvent({ ev: 'send', sf: 'oma', id: EDITOR_NODE_ID, text: 'Hello agent' });

    await waitFor(() =>
      host.allOps.some(op => op[0] === 'settle' && typeof op[1] === 'string' && op[1].startsWith('main.t0-'))
    );

    expect(host.osc7501).toContain('state=working');
    expect(host.osc7501).toContain('state=done');

    // Verify 1:1 omp.working Spindle animation trigger rendered during streaming
    const workingRow = host.findWireNodes(n => n.k === 'row' && n.p?.['role'] === 'omp.working')[0];
    expect(workingRow).toBeDefined();
    const starburstSpin = (workingRow?.c ?? []).find(c => c.k === 'spinner');
    expect(starburstSpin?.p?.['style']).toBe('starburst');
    expect(starburstSpin?.p?.['tone']).toBe('accent');

    // Verify 1:1 omp.user card & omp.assistant container (NOT <message> or <trace>)
    const userCards = host.findWireNodes(n => n.k === 'card' && n.p?.['role'] === 'omp.user');
    expect(userCards.length).toBeGreaterThanOrEqual(1);
    expect(userCards[0]!.p?.['tone']).toBe('user');
    expect(host.findWireNodes(n => n.p?.['role'] === 'omp.user.tools').length).toBeGreaterThan(0);

    const assistantCols = host.findWireNodes(n => n.k === 'col' && n.p?.['role'] === 'omp.assistant');
    expect(assistantCols.length).toBeGreaterThanOrEqual(1);
    expect(host.findWireNodes(n => n.p?.['role'] === 'omp.turn.usage').length).toBeGreaterThan(0);

    // Verify 1:1 omp.thinking section WITH `took` duration prop
    const thinkingSections = host.findWireNodes(
      n => n.k === 'section' && (n.p?.['role'] === 'omp.thinking' || n.p?.['role'] === 'omp.thinking.live')
    );
    expect(thinkingSections.length).toBeGreaterThan(0);
    expect(typeof thinkingSections[0]!.p?.['took']).toBe('number');
    expect(host.findWireNodes(n => n.k === 'trace').length).toBe(0);

    // Verify bash tool has omp.tool.bash, frame='inline', normalized verb title ('Bash' vs target 'bun test'), exit=0, and omp.run internals
    const bashTool = host.findWireNodes(n => n.k === 'tool' && n.p?.['name'] === 'bash')[0];
    expect(bashTool?.p?.['role']).toBe('omp.tool.bash');
    expect(bashTool?.p?.['frame']).toBe('inline');
    expect(bashTool?.p?.['title']).toBe('Bash');
    expect(bashTool?.p?.['target']).toBe('bun test');
    expect(bashTool?.p?.['targetKind']).toBe('command');
    expect(bashTool?.p?.['exit']).toBe(0);
    expect(host.findWireNodes(n => n.p?.['role'] === 'omp.run').length).toBeGreaterThan(0);
    expect(host.findWireNodes(n => n.p?.['role'] === 'omp.tool.bash.command').length).toBeGreaterThan(0);
    expect(host.findWireNodes(n => n.p?.['role'] === 'omp.tool.bash.output').length).toBeGreaterThan(0);
    expect(host.findWireNodes(n => n.p?.['role'] === 'omp.run.foot').length).toBeGreaterThan(0);

    // Verify edit tool has omp.tool.edit, frame='card', normalized verb title ('Edit'), and omp.tool.edit.file diff
    const editTool = host.findWireNodes(n => n.k === 'tool' && n.p?.['name'] === 'edit')[0];
    expect(editTool?.p?.['role']).toBe('omp.tool.edit');
    expect(editTool?.p?.['frame']).toBe('card');
    expect(editTool?.p?.['title']).toBe('Edit');

    // Duplicate cwd segment is intentionally omitted from omp.composer.extras (1:1 omp bar)
    expect(host.findWireNodes(n => n.id === 'dock.composer.bar.extras.cwd').length).toBe(0);
    const diffNodes = host.findWireNodes(n => n.k === 'diff');
    expect(diffNodes.length).toBeGreaterThan(0);
    expect(diffNodes[0]!.p?.['mode']).toBe('auto');
    expect(diffNodes[0]!.p?.['role']).toBe('omp.tool.edit.file');

    // Verify swarm/subagent inside omp.tool.task + <agent>
    const taskTool = host.findWireNodes(n => n.k === 'tool' && n.p?.['role'] === 'omp.tool.task')[0];
    expect(taskTool?.p?.['frame']).toBe('card');
    const agentNodes = host.findWireNodes(n => n.k === 'agent');
    expect(agentNodes.length).toBeGreaterThan(0);

    // Verify plan in main (omp.tool.todo) and dock HUD (omp.hud.todo)
    const todoTool = host.findWireNodes(n => n.k === 'tool' && n.p?.['role'] === 'omp.tool.todo')[0];
    expect(todoTool).toBeDefined();
    const planNodes = host.findWireNodes(n => n.k === 'checklist' && n.p?.['mode'] === 'full');
    expect(planNodes.length).toBeGreaterThan(0);
    const hudTodoNodes = host.findWireNodes(n => n.k === 'checklist' && n.p?.['role'] === 'omp.hud.todo');
    expect(hudTodoNodes.length).toBeGreaterThan(0);

    // Verify compaction & notice roles
    expect(host.findWireNodes(n => n.k === 'section' && n.p?.['role'] === 'omp.compaction').length).toBeGreaterThan(0);
    expect(host.findWireNodes(n => n.k === 'row' && n.p?.['role'] === 'omp.notice.warning').length).toBeGreaterThan(0);

    // Verify persistent context meter in Composer bar & title tooltip with formatted usage
    const contextMeter = host.findWireNodes(n => n.id === 'dock.composer.context' && n.k === 'meter')[0];
    expect(contextMeter?.p?.['role']).toBe('omp.composer.context');
    const contextSetOps = host.allOps.filter(
      op => op[0] === 'set' && op[1] === 'dock.composer.context' && op[2]['title'] === '14k / 1M (1.4%)'
    );
    expect(contextSetOps.length).toBeGreaterThan(0);

    // Verify flat omp-aligned main children (`main.t0-user`, `main.t0-assistant-*`, `main.t0-<tool>`) with NO wrapper turn-0 col
    expect(host.findWireNodes(n => n.id === 'main.turn-0').length).toBe(0);
    expect(userCards[0]!.id).toBe('main.t0-user');

    // Verify GoneEvent evicts flat top-level node cleanly without breaking subsequent frames
    host.input.emitTspEvent({ ev: 'gone', sf: 'oma', ids: ['main.t0-user'] });
    await waitFor(() => controller.scheduler.isEvicted('main.t0-user'));
    expect(controller.store.transcript.evictedTurnIds.has('main.t0-user')).toBe(true);

    // Dynamic configOptions removing thought_level hides embedded dock.composer.bar.model.effort glyph
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-stream',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: DEFAULT_CONFIG_OPTIONS.filter(o => o.id !== 'thought_level'),
        },
      },
    });
    await waitFor(() => !controller.store.getState().controls.supportsThoughtLevel);
    await waitFor(() =>
      host.allOps.some(op => op[0] === 'del' && op[1] === 'dock.composer.bar.model.effort')
    );

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('inline <tool status="ask"> approval: y/a/n guarded by empty draft, Esc cancels permission before session/cancel', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let promptCount = 0;
    const permResponses: RpcEnvelope[] = [];
    let promptIdToFinish: string | number | undefined;

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-perm', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        promptCount += 1;
        promptIdToFinish = msg.id;
        h.send({
          jsonrpc: '2.0',
          id: `perm-${promptCount}`,
          method: 'session/request_permission',
          params: {
            sessionId: 'sess-perm',
            toolCall: { toolCallId: `tc-ask-${promptCount}`, name: 'run_command', kind: 'execute', title: 'rm -rf temp' },
            options: [
              { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'opt-always', name: 'Always allow', kind: 'allow_always' },
              { optionId: 'opt-deny', name: 'Deny', kind: 'reject_once' },
            ],
          },
        });
      } else if (msg.id === 'perm-1' && msg.result) {
        permResponses.push(msg);
        h.send({ jsonrpc: '2.0', id: promptIdToFinish, result: { stopReason: 'end_turn' } });
      } else if (msg.id === 'perm-2' && msg.result) {
        permResponses.push(msg);
      } else if (msg.method === 'session/cancel') {
        h.send({ jsonrpc: '2.0', id: promptIdToFinish, result: { stopReason: 'cancelled' } });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // Turn 1: trigger permission card
    void controller.submitInput('run dangerous command');
    await waitFor(() => controller.store.approvals.hasPending());
    expect(host.osc7501).toContain('state=blocked:kind=permission');

    const askTool = host.findWireNodes(n => n.k === 'tool' && n.p?.['status'] === 'ask')[0];
    expect(askTool).toBeDefined();
    expect(askTool?.p?.['confirm']).toBe('card');

    // Type text into editor so draft is non-empty, then press 'y' -> MUST NOT approve tool!
    host.input.emit('hi');
    await waitFor(() => controller.store.draft.text === 'hi');
    host.input.emit('y');
    await waitFor(() => controller.store.draft.text === 'hiy');
    expect(controller.store.approvals.hasPending()).toBe(true);
    expect(permResponses.length).toBe(0);

    // Clear draft, then press 'y' -> MUST approve pending tool!
    controller.store.draft.clear(false);
    host.input.emit('y');
    await waitFor(() => permResponses.length === 1);
    expect(permResponses[0]!.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'opt-allow' },
    });
    await waitFor(() => !controller.store.getState().isStreaming);

    // Turn 2: trigger permission card, press Esc -> MUST reply cancelled BEFORE session/cancel
    void controller.submitInput('second command');
    await waitFor(() => controller.store.approvals.hasPending());

    const idxBefore = acp.received.length;
    host.input.emit('\x1b');
    await waitFor(() => !controller.store.getState().isStreaming);

    const afterEsc = acp.received.slice(idxBefore);
    const permReplyIdx = afterEsc.findIndex(m => m.id === 'perm-2');
    const cancelIdx = afterEsc.findIndex(m => m.method === 'session/cancel');
    expect(permReplyIdx).toBeGreaterThanOrEqual(0);
    expect(cancelIdx).toBeGreaterThan(permReplyIdx);
    expect(afterEsc[permReplyIdx]!.result).toEqual({ outcome: { outcome: 'cancelled' } });

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('/resume modal <picker> mounts directly under layer with children preview, focuses null -> restores dock.ed, and suspends replay during session/load', async () => {
    const tmp = makeTempDir();
    const sessionsDir = join(tmp, 'sessions');
    const previewStore = new PreviewStore({ sessionsDir });
    await previewStore.save({
      sessionId: 'sess-history-42',
      cwd: tmp,
      title: 'Design Discussion',
      model: 'gemini-4-neon',
      thoughtLevel: 'high',
      turnCount: 2,
      updatedAt: new Date().toISOString(),
      preview: [
        { role: 'user', text: 'How should we build oma?' },
        { role: 'assistant', text: 'Use TSP surfaces with agy acp.' },
      ],
    });

    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-initial', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/list') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessions: [
              {
                sessionId: 'sess-history-42',
                cwd: tmp,
                title: 'Design Discussion',
                updatedAt: new Date().toISOString(),
              },
            ],
          },
        });
      } else if (msg.method === 'session/load') {
        // Replay history before responding
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-history-42',
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Replayed user msg' } },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-history-42',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Replayed assistant reply' } },
          },
        });
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-history-42', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        if ((msg.params as { sessionId?: string })?.sessionId === 'sess-history-42') {
          h.crash(0);
        }
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore,
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // Open /resume picker
    await controller.submitInput('/resume');
    await waitFor(() => !controller.store.getState().picker?.loading);

    // Focus MUST switch to null AFTER modal picker is rendered (consistent with openHelp)
    const layerAddIdx = host.allOps.findIndex(op => op[0] === 'add' && op[1] === 'layer');
    const nullFocusIdx = host.allOps.findIndex(op => op[0] === 'focus' && op[1] === null);
    expect(layerAddIdx).toBeGreaterThanOrEqual(0);
    expect(nullFocusIdx).toBeGreaterThan(layerAddIdx);
    expect(host.getFocusOps()).toContain(null);
    expect(controller.currentSurfaceFocus).toBeNull();

    // Picker MUST mount directly under `layer` as `layer.modal` (NOT inside any <overlay>)
    // and render right-side preview directly as `layer.modal` children (`layer.modal.preview`)
    const layerAddOp = host.allOps.find(
      (op): op is readonly ['add', string, string, string | null, WireNode] =>
        op[0] === 'add' && op[1] === 'layer'
    );
    expect(layerAddOp).toBeDefined();
    expect(layerAddOp![4].k).toBe('col');
    const directPicker = (layerAddOp![4].c ?? []).find(child => child.id === 'layer.modal');
    expect(directPicker).toBeDefined();
    expect(directPicker!.k).toBe('picker');
    expect(directPicker!.p?.['size']).toBe('lg');
    expect(directPicker!.p?.['layout']).toBe('cards');
    expect(directPicker!.p?.['preview']).toBe('side');
    expect(directPicker!.p?.['columns']).toEqual([
      { id: 'when', format: 'time' },
      { id: 'size', format: 'dim' },
    ]);

    const previewAddOp = host.allOps.find(
      (op): op is readonly ['add', string, string, string | null, WireNode] =>
        op[0] === 'add' && op[1] === 'layer.modal.preview'
    );
    expect(previewAddOp).toBeDefined();
    expect(previewAddOp![2]).toBe('layer.modal');
    const serializedPreview = JSON.stringify(previewAddOp![4]);
    expect(serializedPreview).toContain('omp.picker.title');
    expect(serializedPreview).toContain('Conversation');
    expect(serializedPreview).toContain('Design Discussion');
    expect(serializedPreview).toContain('Use TSP surfaces with agy acp.');
    // Ensure NO overlay wraps the picker
    const wrappingOverlays = host.findWireNodes(
      n => n.k === 'overlay' && JSON.stringify(n.c ?? []).includes('"k":"picker"')
    );
    expect(wrappingOverlays.length).toBe(0);

    // Press Enter to resume selected session -> closes picker, restores EDITOR_NODE_ID focus, loads & replays
    host.input.emit('\r');
    await waitFor(
      () =>
        controller.store.getState().sessionId === 'sess-history-42' &&
        !controller.scheduler.suspended &&
        host.allOps.some(op => op[0] === 'scroll' && op[1] === 'main' && op[2] === 'end')
    );

    expect(controller.store.getState().picker).toBeNull();
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);
    expect(host.getFocusOps()[host.getFocusOps().length - 1]).toBe(EDITOR_NODE_ID);
    expect(controller.store.transcript.turns.length).toBe(1);
    expect(controller.store.transcript.turns[0]!.assistantText).toBe('Replayed assistant reply');
    expect(host.allOps.some(op => op[0] === 'scroll' && op[1] === 'main' && op[2] === 'end')).toBe(true);

    // Verify 1:1 omp /help overlay (`role: 'omp.overlay.hotkeys'`, table with keycap spans, close button)
    await controller.submitInput('/help');
    await waitFor(() => controller.store.getState().helpOpen);
    expect(controller.currentSurfaceFocus).toBeNull();
    const helpOverlay = host.findWireNodes(n => n.id === 'layer.help' && n.k === 'overlay')[0];
    expect(helpOverlay?.p?.['role']).toBe('omp.overlay.hotkeys');
    expect(helpOverlay?.p?.['size']).toBe('lg');
    expect(host.findWireNodes(n => n.p?.['role'] === 'omp.hotkeys.group').length).toBeGreaterThanOrEqual(2);
    const hotkeyTables = host.findWireNodes(n => n.k === 'table' && n.p?.['role'] === 'omp.hotkeys.table');
    expect(hotkeyTables.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(hotkeyTables[0])).toContain('"s":"key"');
    for (const tbl of hotkeyTables) {
      const cols = tbl.p?.['cols'] as Array<Record<string, unknown>> | undefined;
      expect(cols?.[1]?.['truncate']).toBe('end');
    }
    expect(JSON.stringify(hotkeyTables[1])).not.toContain('[oma]');
    const helpCloseBtn = host.findWireNodes(n => n.p?.['role'] === 'omp.btn' && n.k === 'button')[0];
    expect(helpCloseBtn).toBeDefined();
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: helpCloseBtn!.id, act: 'close' });
    await waitFor(() => !controller.store.getState().helpOpen);
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);

    // Verify clicking fused Composer model pill opens Figure 1 compact model sheet (no title, composer-anchored, inline level slider)
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: 'dock.composer.bar.model', act: 'status.model' });
    await waitFor(() => controller.store.getState().picker?.kind === 'model');
    const modelPicker = host.findWireNodes(n => n.id === 'layer.modal' && n.p?.['icon'] === 'cpu')[0];
    expect(modelPicker?.p?.['title']).toBeUndefined();
    expect(modelPicker?.p?.['anchor']).toBe('composer');
    expect(modelPicker?.p?.['search']).toBe('list');
    expect(modelPicker?.p?.['density']).toBe('snug');
    expect(modelPicker?.p?.['scopeStyle']).toBe('rail');
    expect(modelPicker?.p?.['preview']).toBe('none');
    expect(modelPicker?.p?.['actions']).toEqual([]);
    expect(modelPicker?.p?.['level']).toBeDefined();
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);

    // Verify `/thought` opens thinking level picker with depth bar column
    await controller.submitInput('/thought');
    await waitFor(() => controller.store.getState().picker?.kind === 'thought');
    const thoughtPicker = host.findWireNodes(n => n.id === 'layer.modal' && n.p?.['icon'] === 'brain')[0];
    expect(thoughtPicker?.p?.['title']).toBe('Thinking level');
    expect(thoughtPicker?.p?.['columns']).toEqual([{ id: 'depth', format: 'bar' }]);
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('<questions> elicitation/create with <input key="<id>.other" />, remote SSH Ctrl+V toast, auth suspend/resume, and crash Retry', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let needAuth = true;
    let loginInvoked = 0;
    const elicitationReplies: RpcEnvelope[] = [];
    let promptId: string | number | undefined;

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            authMethods: [{ id: 'oauth', name: 'Google OAuth' }],
          },
        });
      } else if (msg.method === 'session/new') {
        if (needAuth) {
          h.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'Login required: unauthenticated' },
          });
        } else {
          h.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: { sessionId: 'sess-auth-ok', configOptions: DEFAULT_CONFIG_OPTIONS },
          });
        }
      } else if (msg.method === 'session/load') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-auth-ok', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        promptId = msg.id;
        h.send({
          jsonrpc: '2.0',
          id: 'elic-1',
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: 'Need input',
            requestedSchema: {
              type: 'object',
              required: ['reason'],
              properties: {
                reason: { type: 'string', title: 'Why?' },
              },
            },
          },
        });
      } else if (msg.id === 'elic-1' && msg.result) {
        elicitationReplies.push(msg);
        h.send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      clipboard: {
        readImage: async () => null,
        readText: async () => null,
        writeText: async () => false,
        isRemoteSshWithoutDisplay: () => true,
      },
      runLogin: async () => {
        loginInvoked += 1;
        needAuth = false;
        return 0;
      },
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // 1. Auth required state -> OSC 7501 blocked:kind=auth
    expect(controller.store.getState().authRequired).not.toBeNull();
    expect(host.osc7501).toContain('state=blocked:kind=auth');

    // Click Login button -> surface.suspend(), runLogin(), surface.resume(), auto reconnect
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'main.auth-required.body.actions.login',
      act: 'click',
    });
    await waitFor(() => controller.store.getState().isReady);
    expect(loginInvoked).toBe(1);
    expect(host.allOps.some(op => op[0] === 'suspend')).toBe(true);
    expect(host.allOps.some(op => op[0] === 'resume')).toBe(true);

    // 2. Remote SSH Ctrl+V shows graceful degradation warning toast
    host.input.emit('\x16'); // Ctrl+V
    await waitFor(() =>
      Boolean(controller.store.getState().activeToast?.text.includes('Remote SSH'))
    );

    // 3. Elicitation <questions> with <input key="reason.other" />
    void controller.submitInput('ask me something');
    await waitFor(() => controller.store.getState().activeQuestion !== null);
    expect(host.osc7501).toContain('state=blocked:kind=question');

    const qNodes = host.findWireNodes(n => n.id === 'main.questions' && n.k === 'questions');
    expect(qNodes.length).toBeGreaterThan(0);
    const otherInput = host.findWireNodes(n => n.id === 'main.questions.reason.other' && n.k === 'input');
    expect(otherInput.length).toBeGreaterThan(0);
    expect(controller.currentSurfaceFocus).toBe('main.questions.reason.other');

    // Type answer into other input and submit with Enter
    host.input.emit('testing\r');
    await waitFor(() => elicitationReplies.length === 1);
    expect(elicitationReplies[0]!.result).toEqual({
      action: 'accept',
      content: { reason: 'testing' },
    });
    await waitFor(() => !controller.store.getState().isStreaming);
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);

    // 4. Unexpected agy acp crash -> OSC 7501 state=error + crash banner + Retry reloads session
    const spawnsBefore = acp.spawnCount.value;
    acp.crash(1);
    await waitFor(() => controller.store.getState().crashError !== null);
    expect(host.osc7501).toContain('state=error');

    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'main.crash-banner.end',
      act: 'click',
    });
    await waitFor(() => controller.store.getState().isReady && acp.spawnCount.value > spawnsBefore);
    expect(acp.received.some(m => m.method === 'session/load')).toBe(true);

    // Verify encodeJson sanity import used without warning
    expect(encodeJson({ verb: 'x', body: { id: 'oma', keep: true } }).byteLength).toBeGreaterThan(0);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('regression: keyboard Enter prompt does not deadlock input loop (keyboard y approval & Esc cancel), stderr dedup, /resume loading Esc, surrogate-pair editing, and thought/mode hits safety', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let promptSeq = 0;
    let currentPromptId: string | number | undefined;
    const permReplies: RpcEnvelope[] = [];
    const releaseSessionList = Promise.withResolvers<void>();

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-reg', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/list') {
        void releaseSessionList.promise.then(() => {
          h.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessions: [
                {
                  sessionId: 'sess-late',
                  cwd: tmp,
                  title: 'Late Result',
                  updatedAt: new Date().toISOString(),
                },
              ],
            },
          });
        });
      } else if (msg.method === 'session/prompt') {
        promptSeq += 1;
        currentPromptId = msg.id;
        if (promptSeq <= 2) {
          h.send({
            jsonrpc: '2.0',
            id: `reg-perm-${promptSeq}`,
            method: 'session/request_permission',
            params: {
              sessionId: 'sess-reg',
              toolCall: { toolCallId: `reg-tc-${promptSeq}`, name: 'run_command', kind: 'execute', title: 'echo hi' },
              options: [
                { optionId: 'allow-1', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny-1', name: 'Deny', kind: 'reject_once' },
              ],
            },
          });
        } else {
          h.send({
            jsonrpc: '2.0',
            id: 'reg-elic',
            method: 'elicitation/create',
            params: {
              mode: 'form',
              requestedSchema: {
                type: 'object',
                properties: { note: { type: 'string', title: 'Note' } },
              },
            },
          });
        }
      } else if (msg.id === 'reg-perm-1' && msg.result) {
        permReplies.push(msg);
        h.send({ jsonrpc: '2.0', id: currentPromptId, result: { stopReason: 'end_turn' } });
      } else if (msg.id === 'reg-perm-2' && msg.result) {
        permReplies.push(msg);
      } else if (msg.id === 'reg-elic' && msg.result) {
        permReplies.push(msg);
        h.send({ jsonrpc: '2.0', id: currentPromptId, result: { stopReason: 'end_turn' } });
      } else if (msg.method === 'session/cancel') {
        h.send({ jsonrpc: '2.0', id: currentPromptId, result: { stopReason: 'cancelled' } });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // 1. P0 regression: submit prompt via keyboard Enter (`\r`), then approve with keyboard `y`
    host.input.emit('run via keyboard\r');
    await waitFor(() => controller.store.approvals.hasPending());
    host.input.emit('y');
    await waitFor(() => permReplies.length === 1 && !controller.store.getState().isStreaming);
    expect(permReplies[0]!.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-1' },
    });

    // 2. P0 regression: submit second prompt via keyboard Enter (`\r`), then cancel with keyboard Esc (`\x1b`)
    host.input.emit('second keyboard prompt\r');
    await waitFor(() => controller.store.approvals.hasPending());
    host.input.emit('\x1b');
    await waitFor(() => permReplies.length === 2 && !controller.store.getState().isStreaming);
    expect(permReplies[1]!.result).toEqual({ outcome: { outcome: 'cancelled' } });

    // 3. stderr deduplication: single mock stderr line must appear exactly once in TrafficBuffer
    const stderrEntries = controller.store.traffic.list({ direction: 'stderr' });
    expect(stderrEntries.length).toBe(1);
    expect(stderrEntries[0]!.summary).toContain('mock stderr diagnostic');

    // 4. `/resume` loading must NOT block Esc, and late session/list response must be ignored
    host.input.emit('/resume\r');
    await waitFor(() => controller.store.getState().picker?.kind === 'resume');
    expect(controller.store.getState().picker?.loading).toBe(true);
    expect(controller.currentSurfaceFocus).toBeNull();

    // Immediately press Esc while session/list is still pending
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);

    // Late session/list resolution must not reopen or mutate closed picker
    releaseSessionList.resolve();
    await Bun.sleep(30);
    expect(controller.store.getState().picker).toBeNull();

    // 5. Surrogate-pair safe cursor/backspace/delete in modal picker search box
    //    (in `/model`, Alt+Left moves search cursor while unmodified Left/Right steps the inline level slider)
    host.input.emit('/model\r');
    await waitFor(() => controller.store.getState().picker?.kind === 'model');
    host.input.emit('a🚀b');
    await waitFor(() => controller.store.getState().picker?.query === 'a🚀b');
    // Move left once past 'b' via Alt+Left (`\x1b[1;3D`), then Backspace must delete entire '🚀' (2 UTF-16 units) -> 'ab'
    host.input.emit('\x1b[1;3D\x7f');
    await waitFor(() => controller.store.getState().picker?.query === 'ab');
    expect(controller.store.getState().picker?.cursor).toBe(1);
    // Insert '🚀' at index 1 ('a🚀b'), move left once over '🚀' via Alt+Left -> cursor=1, Delete must remove full '🚀' -> 'ab'
    host.input.emit('🚀');
    await waitFor(() => controller.store.getState().picker?.query === 'a🚀b');
    host.input.emit('\x1b[1;3D\x1b[3~');
    await waitFor(() => controller.store.getState().picker?.query === 'ab');
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);

    // 6. Surrogate-pair safe backspace in <questions> Other input
    host.input.emit('ask emoji\r');
    await waitFor(() => controller.store.getState().activeQuestion !== null);
    host.input.emit('ok🚀\x7f\r');
    await waitFor(() => permReplies.length === 3 && !controller.store.getState().isStreaming);
    expect(permReplies[2]!.result).toEqual({
      action: 'accept',
      content: { note: 'ok' },
    });

    // 7. `/thought` & `/mode` picker hits safety when matching value vs name
    controller.store.updateConfigOptions([
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'accept-edits',
        options: [
          { value: 'accept-edits-verbose-id', name: 'Fast' },
        ],
      },
      {
        id: 'thought_level',
        name: 'Thought',
        category: 'thought_level',
        type: 'select',
        currentValue: 'xhigh',
        options: [
          { value: 'super-deep-xhigh', name: 'Max' },
        ],
      },
    ]);
    const modeComputedByVal = computePickerData(
      controller.store.getState(),
      { kind: 'mode', query: 'verbose', cursor: 7, scope: 'default', selectedId: null, loading: false, sessions: [] },
      []
    );
    expect(modeComputedByVal.items.length).toBe(1);
    expect(modeComputedByVal.items[0]!.hits).toBeUndefined();
    expect(modeComputedByVal.hits).toBeUndefined();

    const thoughtComputedByVal = computePickerData(
      controller.store.getState(),
      { kind: 'thought', query: 'super-deep', cursor: 10, scope: 'default', selectedId: null, loading: false, sessions: [] },
      []
    );
    expect(thoughtComputedByVal.items.length).toBe(1);
    expect(thoughtComputedByVal.items[0]!.hits).toBeUndefined();
    expect(thoughtComputedByVal.hits).toBeUndefined();

    const thoughtComputedByName = computePickerData(
      controller.store.getState(),
      { kind: 'thought', query: 'Ma', cursor: 2, scope: 'default', selectedId: null, loading: false, sessions: [] },
      []
    );
    expect(thoughtComputedByName.items[0]!.hits).toEqual([[0, 2]]);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('Swarm Board E2E: Alt+S toggle, native agy-style Roster + Retired + Split Posts/Detail, colored pixel bees, oma-swarm-fx, /swarm passthrough, live watch, and /help entries', async () => {
    const tmp = makeTempDir();
    const brainRoot = join(tmp, 'brain');
    const swarmSessionId = 'sess-swarm-e2e';
    const swarmDir = join(brainRoot, swarmSessionId, '.system_generated', 'swarm');
    mkdirSync(swarmDir, { recursive: true });

    writeFileSync(
      join(swarmDir, 'swarm.json'),
      JSON.stringify({
        version: 1,
        backend: 'local',
        swarm_id: swarmSessionId,
        created_at: '2026-11-21T00:00:00Z',
      }),
      'utf8'
    );
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Swarm Board UI Sprint',
        members: {
          coordinator: {
            conversation_id: 'conv-coord',
            role: 'coordinator',
            phase: 'RUNNING',
            desired_state: 'RUNNING',
            wake_mode: 'mentions',
            applied_model: 'claude-opus-4-6',
            killed: false,
          },
          'swarm-ui': {
            conversation_id: 'conv-ui',
            role: 'worker',
            phase: 'RUNNING',
            desired_state: 'RUNNING',
            applied_model: 'gemini-3-pro',
            workspace_mode: 'inherit',
            killed: false,
          },
          'swarm-idle': {
            conversation_id: 'conv-idle',
            role: 'worker',
            phase: 'STOPPED',
            desired_state: 'STOPPED',
            applied_model: 'gemini-3-flash',
            killed: false,
          },
          'old-worker': {
            conversation_id: 'conv-old',
            role: 'worker',
            phase: 'KILLED',
            desired_state: 'KILLED',
            applied_model: 'gemini-2.5-pro',
            killed: true,
          },
        },
      }),
      'utf8'
    );
    const boardFile = join(swarmDir, 'board.jsonl');
    const initialLines = [
      JSON.stringify({
        seq: 1,
        agent: 'coordinator',
        text: '@swarm-ui Build the native Swarm Board panel.',
        time: '2026-11-21 00:47:39',
        kind: 'brief',
      }),
      JSON.stringify({
        seq: 2,
        agent: 'swarm-ui',
        text: '@coordinator [done] Implemented **Swarm Board** preview!\n\n```ts\nconst ok = true;\n```',
        time: '2026-11-21 00:55:10',
      }),
      JSON.stringify({
        seq: 3,
        agent: 'old-worker',
        text: '@coordinator [stall] Waiting for earlier phase.',
        time: '2026-11-21 00:56:00',
      }),
    ];
    writeFileSync(boardFile, `${initialLines.join('\n')}\n`, 'utf8');

    const host = new FakeTernHost({
      features: ['blobs', 'styles', 'settle', 'dock', 'scroll', 'font', 'aside'],
    });
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();
    const receivedPrompts: string[] = [];

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: swarmSessionId, configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        const blocks = (msg.params?.['prompt'] as Array<{ type?: string; text?: string }> | undefined) ?? [];
        const textBlock = blocks.find(b => b.type === 'text');
        if (textBlock?.text) receivedPrompts.push(textBlock.text);
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: swarmSessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Swarm task accepted.' } },
          },
        });
        h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      baseBrainDir: brainRoot,
      swarmPollIntervalMs: 30,
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // Background watcher automatically mounts on session start and picks up live swarm state
    await waitFor(
      () =>
        controller.isSwarmWatcherActive &&
        controller.store.getState().swarmSnapshot?.latestSeq === 3
    );
    expect(controller.store.isSwarmWorking).toBe(true);
    expect(controller.store.swarmWorkingNames).toContain('swarm-ui');

    // `oma-swarm-fx` stylesheet dynamically installed & 4 orbiting bees + HUD bee button rendered
    const fxSheet = host.tspMessages.find(
      m => m.verb === 's' && m.body['name'] === 'oma-swarm-fx' && typeof m.body['css'] === 'string'
    );
    expect(fxSheet).toBeDefined();
    expect(String(fxSheet?.body['css'] ?? '')).toContain('@keyframes oma-bee-orbit');
    expect(String(fxSheet?.body['css'] ?? '')).not.toContain('url(');
    expect(String(fxSheet?.body['css'] ?? '')).not.toContain('position: fixed');
    expect(host.findWireNodes(n => n.p?.['role'] === 'oma.swarm.fx').length).toBeGreaterThan(0);
    expect(host.findWireNodes(n => n.p?.['role'] === 'oma.bee.hud').length).toBeGreaterThan(0);

    // 1. `/swarm 做点事` MUST pass through untouched to `agy acp` and NEVER open Swarm Board overlay
    await controller.submitInput('/swarm 做点事');
    await waitFor(() => receivedPrompts.includes('/swarm 做点事') && !controller.store.getState().isStreaming);
    expect(controller.store.getState().swarmBoardOpen).toBe(false);
    expect(controller.store.getState().picker).toBeNull();
    expect(controller.isSwarmWatcherActive).toBe(true);

    // 2. Press Alt+S (`\x1bs`) -> opens native `agy`-style SwarmBoardView (`layer.swarm`), renders BEFORE focus(null)
    const opsBeforeAltS = host.allOps.length;
    host.input.emit('\x1bs');
    await waitFor(() => controller.store.getState().swarmBoardOpen === true);

    const opsAfterAltS = host.allOps.slice(opsBeforeAltS);
    const swarmAddIdx = opsAfterAltS.findIndex(
      op => op[0] === 'add' && (op[1] === 'layer' || op[1] === 'layer.swarm')
    );
    const nullFocusIdx = opsAfterAltS.findIndex(op => op[0] === 'focus' && op[1] === null);
    expect(swarmAddIdx).toBeGreaterThanOrEqual(0);
    expect(nullFocusIdx).toBeGreaterThan(swarmAddIdx);
    expect(controller.currentSurfaceFocus).toBeNull();

    // Verify top Roster + colored pixel bee avatars + Retired line + bottom Split (Posts list + Detail Markdown) + lg dialog size
    const swarmOverlay = host.findWireNodes(n => n.id === 'layer.swarm' && n.p?.['role'] === 'oma.overlay.swarm').pop();
    expect(swarmOverlay).toBeDefined();
    expect(swarmOverlay?.p?.['size']).toBe('lg');
    expect(swarmOverlay?.p?.['head']).toBe('Swarm Board UI Sprint');

    const coordCard = host.findWireNodes(n => n.id === 'layer.swarm.body.roster.roster-grid.member-coordinator').pop();
    expect(coordCard).toBeDefined();
    expect(JSON.stringify(coordCard)).toContain('👑');
    const coordBeeBlob = blobId(getMemberBeeAssetPair('coordinator', true, 'coordinator').sleep.bytes);
    const coordBeeImg = host.findWireNodes(n => n.id === 'layer.swarm.body.roster.roster-grid.member-coordinator.bee').pop();
    expect(coordBeeImg?.p?.['blob']).toBe(coordBeeBlob);

    const uiBeeBlob = blobId(getMemberBeeAssetPair('swarm-ui', true, 'worker').active.bytes);
    const uiBeeImg = host.findWireNodes(n => n.id === 'layer.swarm.body.roster.roster-grid.member-swarm-ui.bee').pop();
    expect(uiBeeImg?.p?.['blob']).toBe(uiBeeBlob);
    expect(uiBeeBlob).not.toBe(coordBeeBlob);

    const retiredNode = host.findWireNodes(n => n.p?.['role'] === 'oma.swarm.retired').pop();
    expect(JSON.stringify(retiredNode)).toContain('Retired (1): ');
    expect(JSON.stringify(retiredNode)).toContain('old-worker');

    // Bottom split with Posts list (descending `seq` order: #3, #2, #1) & Detail Markdown showing newest post (#3) by default
    expect(controller.store.getFilteredSwarmPosts().map(m => m.seq)).toEqual([3, 2, 1]);
    expect(controller.store.getState().swarmBoardSelectedSeq).toBe(3);
    const postsList = host.findWireNodes(n => n.id === 'layer.swarm.body.split.posts-pane.posts').pop();
    expect(postsList?.k).toBe('list');
    expect((postsList?.c ?? []).map(c => c.id)).toEqual([
      `${SWARM_POSTS_LIST_PREFIX}seq-3`,
      `${SWARM_POSTS_LIST_PREFIX}seq-2`,
      `${SWARM_POSTS_LIST_PREFIX}seq-1`,
    ]);
    expect(postsList?.p?.['selected']).toBe(`${SWARM_POSTS_LIST_PREFIX}seq-3`);
    const detail3 = host.findWireNodes(n => n.id === 'layer.swarm.body.split.detail-pane.detail-3').pop();
    expect(JSON.stringify(detail3)).toContain('Waiting for earlier phase.');

    // 3. Down arrow selects next older post (#2) in descending list and renders full Markdown preview; click member card filters posts
    host.input.emit('\x1b[B');
    await waitFor(() => controller.store.getState().swarmBoardSelectedSeq === 2);
    const detail2 = host.findWireNodes(n => n.id === 'layer.swarm.body.split.detail-pane.detail-2').pop();
    expect(JSON.stringify(detail2)).toContain('Implemented **Swarm Board** preview!');

    // Click `swarm-ui` Roster card -> filters to swarm-ui posts only; click again clears filter
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'layer.swarm.body.roster.roster-grid.member-swarm-ui',
      act: 'swarm.filter=swarm-ui',
    });
    await waitFor(() => controller.store.getState().swarmBoardFilterAgent === 'swarm-ui');
    expect(controller.store.getFilteredSwarmPosts().map(m => m.seq)).toEqual([2]);

    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'layer.swarm.body.roster.roster-grid.member-swarm-ui',
      act: 'swarm.filter=swarm-ui',
    });
    await waitFor(() => controller.store.getState().swarmBoardFilterAgent === null);

    // Re-enable Follow via the actual header Follow button, append #4 to board.jsonl -> live watcher auto-refreshes & Follow selects #4
    const followBtn = host
      .findWireNodes(
        n =>
          n.k === 'button' &&
          (n.p?.['actions'] as Record<string, unknown> | undefined)?.['click'] === 'swarm.follow'
      )
      .pop();
    expect(followBtn).toBeDefined();
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: followBtn!.id,
      act: 'swarm.follow',
    });
    await waitFor(() => controller.store.getState().swarmBoardFollow === true);

    appendFileSync(
      boardFile,
      `${JSON.stringify({
        seq: 4,
        agent: 'swarm-ui',
        text: '@swarm-verifier [done] Live update arrived!',
        time: '2026-11-21 00:57:00',
      })}\n`,
      'utf8'
    );
    await waitFor(() => controller.store.getState().swarmSnapshot?.latestSeq === 4);
    expect(controller.store.getState().swarmBoardSelectedSeq).toBe(4);

    // Toggle Follow OFF, select #2 via list select event, append #5 -> preserves selection #2
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: followBtn!.id,
      act: 'swarm.follow',
    });
    await waitFor(() => controller.store.getState().swarmBoardFollow === false);
    host.input.emitTspEvent({
      ev: 'select',
      sf: 'oma',
      id: 'layer.swarm.body.split.posts-pane.posts',
      item: `${SWARM_POSTS_LIST_PREFIX}seq-2`,
    });
    await waitFor(() => controller.store.getState().swarmBoardSelectedSeq === 2);

    appendFileSync(
      boardFile,
      `${JSON.stringify({
        seq: 5,
        agent: 'coordinator',
        text: '@all Message #5 while Follow is paused.',
        time: '2026-11-21 00:58:00',
      })}\n`,
      'utf8'
    );
    await waitFor(() => controller.store.getState().swarmSnapshot?.latestSeq === 5);
    expect(controller.store.getState().swarmBoardSelectedSeq).toBe(2);

    // 4. Press Alt+S again -> closes Swarm Board & restores EDITOR_NODE_ID focus (background watcher stays active!)
    host.input.emit('\x1bs');
    await waitFor(() => controller.store.getState().swarmBoardOpen === false);
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);
    expect(controller.isSwarmWatcherActive).toBe(true);

    // 5. `/swarm board swarm-ui` opens Swarm Board pre-filtered with query `swarm-ui` (descending order), typing & Backspace work, Esc closes
    await controller.submitInput('/swarm board swarm-ui');
    await waitFor(() => controller.store.getState().swarmBoardOpen === true);
    expect(controller.store.getState().swarmBoardQuery).toBe('swarm-ui');
    expect(controller.store.getFilteredSwarmPosts().map(m => m.seq)).toEqual([4, 2, 1]);

    // Backspace edits search query cleanly
    host.input.emit('\x7f');
    await waitFor(() => controller.store.getState().swarmBoardQuery === 'swarm-u');

    // Press Esc -> closes Swarm Board & restores EDITOR_NODE_ID focus
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().swarmBoardOpen === false);
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);

    // 6. `/help` overlay contains Alt+S (`Toggle swarm board`) & `/swarm board` (`Open swarm board`), all <= 28 chars
    await controller.submitInput('/help');
    await waitFor(() => controller.store.getState().helpOpen);
    const helpTables = host.findWireNodes(n => n.k === 'table' && n.p?.['role'] === 'omp.hotkeys.table');
    const shortcutTblJson = JSON.stringify(helpTables[helpTables.length - 2]);
    const cmdTblJson = JSON.stringify(helpTables[helpTables.length - 1]);
    expect(shortcutTblJson).toContain('alt+s');
    expect(shortcutTblJson).toContain('Toggle swarm board');
    expect(cmdTblJson).toContain('/swarm board');
    expect(cmdTblJson).toContain('Open swarm board');
    host.input.emit('\x1b');
    await waitFor(() => !controller.store.getState().helpOpen);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
    expect(controller.isSwarmWatcherActive).toBe(false);
  });

  test('Swarm Board empty state when session has no active swarm & shutdown stops active watcher', async () => {
    const tmp = makeTempDir();
    const emptyBrainRoot = join(tmp, 'empty-brain');
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-no-swarm', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      baseBrainDir: emptyBrainRoot,
      swarmPollIntervalMs: 30,
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    await controller.submitInput('/board');
    await waitFor(() => controller.store.getState().swarmBoardOpen === true);
    expect(controller.store.getState().swarmSnapshot).toBeNull();
    expect(controller.isSwarmWatcherActive).toBe(true);
    expect(controller.currentSurfaceFocus).toBeNull();

    const emptyNode = host.findWireNodes(n => n.id === 'layer.swarm.empty' && n.k === 'empty').pop();
    expect(emptyNode).toBeDefined();
    expect(String(emptyNode?.p?.['title'] ?? '')).toBe('No active swarm');
    expect(String(emptyNode?.p?.['text'] ?? '')).toContain('No active swarm in this session');
    expect(String(emptyNode?.p?.['text'] ?? '')).toContain('/swarm <task>');

    // Shutdown while Swarm Board is still open MUST stop the watcher cleanly
    await controller.shutdown({ cleanExit: true });
    await runPromise;
    expect(controller.isSwarmWatcherActive).toBe(false);
  });

  test('Figure 4 cursor hide/show + OSC 2 title, and Figure 1 fused model pill + compact model sheet + level slider + Recent persistence + Esc thinking commit', async () => {
    const tmp = makeTempDir();
    const configPath = join(tmp, 'oma-config.toml');
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let currentModel = 'gemini-4-neon';
    let currentThought = 'high';
    const setConfigCalls: Array<{ configId: string; value: string }> = [];

    const buildOpts = () => [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: currentModel,
        options: [
          { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
          { value: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
          { value: 'gpt-5-codex', name: 'GPT-5 Codex' },
        ],
      },
      {
        id: 'thought_level',
        name: 'Thought Level',
        category: 'thought_level',
        type: 'select',
        currentValue: currentThought,
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
          { value: 'xhigh', name: 'XHigh' },
        ],
      },
      DEFAULT_CONFIG_OPTIONS[2]!,
    ];

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, agentInfo: { name: 'agy', version: '1.5.13' } },
        });
      } else if (msg.method === 'session/new' || msg.method === 'session/load') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-fig14', configOptions: buildOpts() },
        });
      } else if (msg.method === 'session/set_config_option') {
        const configId = String(msg.params?.['configId'] ?? '');
        const value = String(msg.params?.['value'] ?? '');
        setConfigCalls.push({ configId, value });
        if (configId === 'model') currentModel = value;
        if (configId === 'thought_level') currentThought = value;
        h.send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: buildOpts() } });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      configPath,
      agySettingsPath: join(tmp, 'agy-settings.json'),
      runLogin: async () => 0,
      installSignals: false,
      throttleMs: 5,
    });

    // Figure 4: HIDE_CURSOR emitted BEFORE surface.open(), OSC 2 title emitted AFTER surface.open()
    const stream = host.rawStream;
    const hideIdx = stream.indexOf(HIDE_CURSOR);
    const openIdx = stream.indexOf('\x1b_tsp;o;');
    const titleIdx = stream.indexOf('\x1b]2;oma · Antigravity\x1b\\');
    expect(hideIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeGreaterThan(hideIdx);
    expect(titleIdx).toBeGreaterThan(openIdx);
    expect(host.oscTitles).toContain('oma · Antigravity');

    const runPromise = controller.run();
    await controller.readyPromise;

    // Figure 1: Fused single pill `omp.composer.model` with embedded `omp.composer.model.effort` as its first child (before `name`)
    const modelPill = host.findWireNodes(n => n.id === 'dock.composer.bar.model')[0];
    expect(modelPill?.p?.['role']).toBe('omp.composer.model');
    const effortAddOp = host.allOps.find(
      (op): op is readonly ['add', string, string, string | null, WireNode] =>
        op[0] === 'add' && op[1] === 'dock.composer.bar.model.effort'
    );
    expect(effortAddOp).toBeDefined();
    expect(effortAddOp![2]).toBe('dock.composer.bar.model');
    expect(effortAddOp![3]).toBe('dock.composer.bar.model.name');
    expect(effortAddOp![4].k).toBe('effort');
    expect(effortAddOp![4].p?.['role']).toBe('omp.composer.model.effort');
    expect(String(effortAddOp![4].p?.['title'] ?? '')).toContain('click to cycle');
    expect(String(effortAddOp![4].p?.['title'] ?? '')).not.toContain('Shift+Tab');
    // No standalone effort chip outside model pill
    expect(host.findWireNodes(n => n.id === 'dock.composer.bar.effort').length).toBe(0);

    // Clicking `omp.composer.model.effort` directly cycles thought_level (high -> xhigh)
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'dock.composer.bar.model.effort',
      act: 'thinking.cycle',
    });
    await waitFor(() => controller.store.getState().controls.currentThoughtLevel === 'xhigh');
    expect(setConfigCalls).toContainEqual({ configId: 'thought_level', value: 'xhigh' });

    // Alt+P opens compact Figure 1 model sheet (`anchor=composer`, `search=list`, `density=snug`, `scopeStyle=rail`, `level`)
    host.input.emit('\x1bp');
    await waitFor(() => controller.store.getState().picker?.kind === 'model');
    const modelSheet = host.findWireNodes(n => n.id === 'layer.modal' && n.p?.['anchor'] === 'composer')[0];
    expect(modelSheet).toBeDefined();
    expect(modelSheet?.p?.['title']).toBeUndefined();
    expect(modelSheet?.p?.['search']).toBe('list');
    expect(modelSheet?.p?.['density']).toBe('snug');
    expect(modelSheet?.p?.['scopeStyle']).toBe('rail');
    expect(modelSheet?.p?.['preview']).toBe('none');
    expect(modelSheet?.p?.['actions']).toEqual([]);
    expect((modelSheet?.p?.['level'] as Record<string, unknown> | undefined)?.['value']).toBe('xhigh');

    // Unmodified Left arrow steps `level` slider (xhigh -> high), and Esc commits that thought_level to ACP!
    host.input.emit('\x1b[D');
    await waitFor(() => controller.store.getState().picker?.modelPickerThinking === 'high');
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);
    await waitFor(() => controller.store.getState().controls.currentThoughtLevel === 'high');

    // Re-open with Alt+P, click level slider (`act: 'level'`), verify top `all` scope & toggle-to-all on second click, then select Claude Opus 4.6 & Enter
    host.input.emit('\x1bp');
    await waitFor(() => controller.store.getState().picker?.kind === 'model');
    const preScopeData = computePickerData(
      controller.store.getState(),
      controller.store.getState().picker!,
      []
    );
    expect(preScopeData.scopes?.[0]?.id).toBe('all');
    expect(preScopeData.scopes?.[0]?.icon).toBe('layers');
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: 'layer.modal', act: 'level', value: 'medium' });
    await waitFor(() => controller.store.getState().picker?.modelPickerThinking === 'medium');
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: 'layer.modal', act: 'scope', value: 'provider:anthropic' });
    await waitFor(() => controller.store.getState().picker?.scope === 'provider:anthropic');
    // Second click on active provider scope toggles back to `'all'`
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: 'layer.modal', act: 'scope', value: 'provider:anthropic' });
    await waitFor(() => controller.store.getState().picker?.scope === 'all');
    // Click Anthropic again and confirm selection
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: 'layer.modal', act: 'scope', value: 'provider:anthropic' });
    await waitFor(() => controller.store.getState().picker?.scope === 'provider:anthropic');
    host.input.emit('\r');

    await waitFor(
      () =>
        controller.store.getState().controls.currentModelId === 'claude-opus-4-6' &&
        controller.store.getState().controls.currentThoughtLevel === 'medium'
    );

    // Recent models persisted atomically to config.toml and shown in `Recent` group next time
    await waitFor(() => existsSync(configPath));
    const parsedCfg = parseConfigToml(readFileSync(configPath, 'utf8')).config;
    expect(parsedCfg.recent_models[0]).toBe('claude-opus-4-6');

    host.input.emit('\x1bp');
    await waitFor(() => controller.store.getState().picker?.kind === 'model');
    const modelComputed = computePickerData(
      controller.store.getState(),
      controller.store.getState().picker!,
      []
    );
    expect(modelComputed.order?.[0]).toEqual({ group: 'recent', label: 'Recent', count: 1 });
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);

    // `/login` emits SHOW_CURSOR before suspend and HIDE_CURSOR after resume
    const rawLenBeforeLogin = host.rawStream.length;
    await controller.submitInput('/login');
    await waitFor(() => host.rawStream.slice(rawLenBeforeLogin).includes(SHOW_CURSOR));
    const loginSlice = host.rawStream.slice(rawLenBeforeLogin);
    const loginShowIdx = loginSlice.indexOf(SHOW_CURSOR);
    const loginHideIdx = loginSlice.lastIndexOf(HIDE_CURSOR);
    expect(loginShowIdx).toBeGreaterThanOrEqual(0);
    expect(loginHideIdx).toBeGreaterThan(loginShowIdx);

    // Shutdown MUST restore native cursor (`\x1b[?25h`) before closing SafeTermOutput
    const rawLenBeforeQuit = host.rawStream.length;
    await controller.shutdown({ cleanExit: true });
    await runPromise;
    expect(host.rawStream.slice(rawLenBeforeQuit)).toContain(SHOW_CURSOR);
  });

  test('Figure 3 slash completion (no leading "/", semantic icons, live status values, skill: collapse/expand, 10-row cap) & sidebar-less /resume Tab toggle', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, agentInfo: { name: 'agy', version: '1.5.13' } },
        });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'sess-fig3',
            configOptions: DEFAULT_CONFIG_OPTIONS,
            _meta: { antigravity: { tier: { name: 'Google AI Ultra' } } },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-fig3',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [
                { name: 'agy-customizations', description: 'Customize agy extensions' },
                { name: 'antigravity-guide', description: 'Antigravity reference guide' },
                { name: 'run-workflow', description: 'Execute workflow script' },
              ],
            },
          },
        });
      } else if (msg.method === 'session/list') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessions: [
              { sessionId: 's-local', cwd: tmp, title: 'Local Session', updatedAt: new Date().toISOString() },
              { sessionId: 's-other', cwd: join(tmp, 'other-repo'), title: 'Other Repo Session', updatedAt: new Date().toISOString() },
            ],
          },
        });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      configPath: join(tmp, 'config.toml'),
      agySettingsPath: join(tmp, 'settings.json'),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;
    await waitFor(() => controller.store.commands.getAcpSkillCommands().length === 3);

    // Type `/` -> Figure 3 completion popup opens with <= 10 items, `skill:` collapsed row, no leading `/`, semantic icons, muted live status values
    host.input.emit('/');
    await waitFor(() => controller.store.getState().completion.open);
    const popupItems = controller.store.getState().completion.items;
    expect(popupItems.length).toBeLessThanOrEqual(10);
    expect(popupItems[0]?.label).toBe('skill:');
    expect(popupItems[0]?.icon).toBe('skill');
    expect(popupItems[0]?.statusValue).toBe('3 skills');
    for (const item of popupItems) {
      expect(item.label.startsWith('/')).toBe(false);
      expect(item.icon).not.toBe('slash');
    }

    const listNodes = host.findWireNodes(n => n.id === 'layer.complete.select.list' && n.k === 'list');
    const latestList = listNodes[listNodes.length - 1]!;
    expect(latestList.p?.['max']).toEqual({ lines: 10 });
    const skillItemNode = (latestList.c ?? []).find(c => c.id === `${COMPLETION_LIST_PREFIX}cmd_skill_group`);
    expect(skillItemNode?.p?.['icon']).toBe('skill');
    expect(skillItemNode?.p?.['value']).toEqual([{ t: '3 skills', s: 'muted' }]);

    // Accept `skill:` row via Tab -> expands into `/skill:` sub-list
    host.input.emit('\t');
    await waitFor(() => controller.store.draft.text === '/skill:');
    expect(controller.store.getState().completion.open).toBe(true);
    expect(controller.store.getState().completion.items.every(i => i.label.startsWith('skill:'))).toBe(true);

    // Clear draft, type `/model` prefix to verify live right-hand model status value
    controller.store.draft.clear(false);
    host.input.emit('/mod');
    await waitFor(() => controller.store.draft.text === '/mod');
    const modelComp = controller.store.getState().completion.items.find(i => i.value === 'model');
    expect(modelComp?.label).toBe('model');
    expect(modelComp?.icon).toBe('model');
    expect(modelComp?.statusValue).toBe('Gemini 4 Neon');

    // Open `/resume` -> verify sidebar-less omp design (no title, no scopes rail, Tab toggles This folder <-> All projects)
    controller.store.draft.clear(false);
    await controller.submitInput('/resume');
    await waitFor(() => controller.store.getState().picker?.kind === 'resume' && !controller.store.getState().picker?.loading);
    const resumePicker = host.findWireNodes(n => n.id === 'layer.modal' && n.p?.['layout'] === 'cards').pop();
    expect(resumePicker?.p?.['title']).toBeUndefined();
    expect(resumePicker?.p?.['scopes']).toBeUndefined();
    expect(controller.store.getState().picker?.scope).toBe('this-folder');

    host.input.emit('\t');
    await waitFor(() => controller.store.getState().picker?.scope === 'all-folders');
    const allComputed = computePickerData(
      controller.store.getState(),
      controller.store.getState().picker!,
      []
    );
    expect(allComputed.visibleIds).toContain('s-local');
    expect(allComputed.visibleIds).toContain('s-other');

    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('/settings (<prefs>) aside docking, FocusEvent coexistence, dynamic features event, config.toml & agy safe allowlist atomic persistence', async () => {
    const tmp = makeTempDir();
    const configPath = join(tmp, 'config.toml');
    const agySettingsPath = join(tmp, 'agy-settings.json');
    // Seed existing agy settings.json with unknown keys that MUST be preserved verbatim
    writeFileSync(
      agySettingsPath,
      JSON.stringify({
        toolPermission: 'request-review',
        trustedWorkspaces: ['/safe/repo'],
        customFlag: 'keep-me',
      }),
      'utf8'
    );

    const host = new FakeTernHost({ features: ['blobs', 'settle', 'dock', 'aside'] });
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let currentMode = 'default';
    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-prefs', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/set_config_option') {
        if (msg.params?.['configId'] === 'mode') {
          currentMode = String(msg.params['value']);
        }
        const nextOpts = DEFAULT_CONFIG_OPTIONS.map(o =>
          o.id === 'mode' ? { ...o, currentValue: currentMode } : o
        );
        h.send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: nextOpts } });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      configPath,
      agySettingsPath,
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;
    expect(controller.store.getState().supportsAside).toBe(true);

    // Open `/settings` -> top-level `<prefs key="settings">` directly under `layer` (NEVER inside `<overlay>`)
    await controller.submitInput('/settings');
    await waitFor(() => controller.store.getState().settings !== null);
    expect(controller.currentSurfaceFocus).toBeNull();

    const directPrefs = host.findWireNodes(n => n.id === 'layer.settings' && n.k === 'prefs');
    expect(directPrefs.length).toBeGreaterThan(0);
    const wrappedPrefs = host.findWireNodes(
      n => n.k === 'overlay' && JSON.stringify(n.c ?? []).includes('"k":"prefs"')
    );
    expect(wrappedPrefs.length).toBe(0);

    // FocusEvent coexistence: clicking editor shifts focus back to Composer while aside stays open; clicking settings returns focus to aside
    host.input.emitTspEvent({ ev: 'focus', sf: 'oma', id: EDITOR_NODE_ID });
    await waitFor(() => controller.store.getState().focusMode === 'editor');
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);
    expect(controller.store.getState().settings).not.toBeNull();

    host.input.emitTspEvent({ ev: 'focus', sf: 'oma', id: 'layer.settings' });
    await waitFor(() => controller.store.getState().focusMode === 'settings');
    expect(controller.currentSurfaceFocus).toBeNull();

    // 1. Session page live ACP change (`session.mode` -> `plan`)
    host.input.emitTspEvent({
      ev: 'change',
      sf: 'oma',
      id: 'layer.settings',
      item: 'session.mode',
      value: 'plan',
    });
    await waitFor(() => controller.store.getState().controls.currentModeId === 'plan');

    // 2. Interface page change -> hot-updates & atomically writes `config.toml`
    host.input.emitTspEvent({
      ev: 'change',
      sf: 'oma',
      id: 'layer.settings',
      item: 'ui.tool_preview_lines',
      value: 20,
    });
    await waitFor(() => controller.config.ui.tool_preview_lines === 20);
    await waitFor(() => existsSync(configPath));
    const savedOmaCfg = parseConfigToml(readFileSync(configPath, 'utf8')).config;
    expect(savedOmaCfg.ui.tool_preview_lines).toBe(20);

    // 3. `/permissions` jumps directly to permissions page; edit `agy` allowlisted key -> preserves unknown keys + shows reconnect toast
    await controller.submitInput('/permissions');
    await waitFor(() => controller.store.getState().settings?.page === 'permissions');

    host.input.emitTspEvent({
      ev: 'change',
      sf: 'oma',
      id: 'layer.settings',
      item: 'agy.enableTerminalSandbox',
      value: true,
    });
    await waitFor(() => controller.store.getState().settings?.agySettings.enableTerminalSandbox === true);
    const savedAgyJson = JSON.parse(readFileSync(agySettingsPath, 'utf8')) as Record<string, unknown>;
    expect(savedAgyJson['enableTerminalSandbox']).toBe(true);
    expect(savedAgyJson['trustedWorkspaces']).toEqual(['/safe/repo']);
    expect(savedAgyJson['customFlag']).toBe('keep-me');
    expect(controller.store.getState().activeToast?.text).toContain('reconnect');

    // 4. Dynamic `features` event removing `aside` switches `<prefs>` into modal `<overlay>` fallback
    host.input.emitTspEvent({ ev: 'features', features: ['blobs', 'settle', 'dock'] });
    await waitFor(() => controller.store.getState().supportsAside === false);
    const fallbackOverlay = host.findWireNodes(
      n => n.id === 'layer.settings' && n.k === 'overlay'
    );
    expect(fallbackOverlay.length).toBeGreaterThan(0);

    // Esc closes settings & restores `surface.focus(EDITOR_NODE_ID)`
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().settings === null);
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('P0/P1 commands (/status, /context, /usage, /mcp, /plugins, /skills, /agents, /export, /copy [n], /logout) + Ctrl+T/Ctrl+O + error actions + user menu', async () => {
    const tmp = makeTempDir();
    const workspaceSkillsDir = join(tmp, 'ws-skills');
    const skillDir = join(workspaceSkillsDir, 'deploy-helper');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: deploy-helper\ndescription: Deploy services safely\n---\n# Deploy Helper\nRun checks first.\n',
      'utf8'
    );

    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let mcpEnabled = true;
    let pluginEnabled = true;
    const cliCalls: string[][] = [];
    const ecosystemRunner: ExecCommandFn = async cmd => {
      cliCalls.push([...cmd]);
      const [, sub, action] = cmd;
      if (sub === 'mcp' && action === 'list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { name: 'github', enabled: mcpEnabled, type: 'stdio', command: 'npx @mcp/github' },
          ]),
          stderr: '',
        };
      }
      if (sub === 'mcp' && (action === 'disable' || action === 'enable')) {
        mcpEnabled = action === 'enable';
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (sub === 'plugin' && action === 'list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { name: 'code-review', version: '1.2.0', enabled: pluginEnabled, description: 'Automated PR review' },
          ]),
          stderr: '',
        };
      }
      if (sub === 'plugin' && (action === 'disable' || action === 'enable')) {
        pluginEnabled = action === 'enable';
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      }
      if (sub === 'agent') {
        return {
          exitCode: 0,
          stdout: 'coder  Default coding agent\nreviewer  Code review specialist\n',
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };

    const copiedTexts: string[] = [];
    let promptNum = 0;
    let logoutCalled = false;

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'agy', version: '1.5.13' },
            agentCapabilities: { auth: { logout: {} } },
          },
        });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'sess-p1',
            configOptions: DEFAULT_CONFIG_OPTIONS,
            _meta: { antigravity: { tier: { name: 'Google AI Ultra', id: 'ultra' } } },
          },
        });
      } else if (msg.method === 'session/prompt') {
        promptNum += 1;
        if (promptNum === 1) {
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-p1',
              update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'First thought' } },
            },
          });
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-p1',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First answer markdown' } },
            },
          });
          h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        } else if (promptNum === 2) {
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-p1',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second answer markdown' } },
            },
          });
          h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        } else if (promptNum === 3) {
          h.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32001, message: 'Rate limit exceeded' },
          });
        } else {
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-p1',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Retry succeeded!' } },
            },
          });
          h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      } else if (msg.method === 'auth/logout') {
        logoutCalled = true;
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      clipboard: {
        readImage: async () => null,
        readText: async () => null,
        writeText: async text => {
          copiedTexts.push(text);
          return true;
        },
        isRemoteSshWithoutDisplay: () => false,
      },
      ecosystemRunner,
      configPath: join(tmp, 'config.toml'),
      agySettingsPath: join(tmp, 'settings.json'),
      workspaceSkillsDir,
      globalSkillsDir: join(tmp, 'empty-global-skills'),
      dataDir: join(tmp, 'data'),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // Produce 2 successful turns -> test `/copy` and `/copy 2`
    await controller.submitInput('Prompt one');
    await waitFor(() => !controller.store.getState().isStreaming && controller.store.transcript.turns.length === 1);
    await controller.submitInput('Prompt two');
    await waitFor(() => !controller.store.getState().isStreaming && controller.store.transcript.turns.length === 2);

    await controller.submitInput('/copy');
    await controller.submitInput('/copy 2');
    expect(copiedTexts).toEqual(['Second answer markdown', 'First answer markdown']);

    // `/export <path>` writes full Markdown transcript
    const exportPath = join(tmp, 'exported-chat.md');
    await controller.submitInput(`/export ${exportPath}`);
    expect(existsSync(exportPath)).toBe(true);
    const exportedMd = readFileSync(exportPath, 'utf8');
    expect(exportedMd).toContain('Prompt one');
    expect(exportedMd).toContain('Second answer markdown');

    // `Ctrl+T` toggles `showThinking`, `Ctrl+O` toggles `expandAllTools`
    expect(controller.store.getState().showThinking).toBe(true);
    host.input.emit('\x14'); // Ctrl+T
    await waitFor(() => controller.store.getState().showThinking === false);
    host.input.emit('\x0f'); // Ctrl+O
    await waitFor(() => controller.store.getState().expandAllTools === true);

    // `/status`, `/context`, `/usage` info overlays
    await controller.submitInput('/status');
    await waitFor(() => controller.store.getState().infoOverlay?.kind === 'status');
    const statusOverlay = host.findWireNodes(n => n.id === 'layer.info' && n.p?.['role'] === 'omp.overlay.status')[0];
    expect(JSON.stringify(statusOverlay)).toContain('Google AI Ultra');
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().infoOverlay === null);

    await controller.submitInput('/context');
    await waitFor(() => controller.store.getState().infoOverlay?.kind === 'context');
    expect(host.findWireNodes(n => n.id === 'layer.info' && n.p?.['role'] === 'omp.overlay.context').length).toBeGreaterThan(0);
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().infoOverlay === null);

    await controller.submitInput('/usage');
    await waitFor(() => controller.store.getState().infoOverlay?.kind === 'usage');
    expect(host.findWireNodes(n => n.id === 'layer.info' && n.p?.['role'] === 'omp.overlay.usage').length).toBeGreaterThan(0);
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().infoOverlay === null);

    // `/mcp` list + Enter toggles disabled via injected ecosystemRunner
    await controller.submitInput('/mcp');
    await waitFor(() => controller.store.getState().picker?.kind === 'mcp' && !controller.store.getState().picker?.loading);
    expect(controller.store.getState().picker?.mcpServers?.[0]?.name).toBe('github');
    expect(controller.store.getState().picker?.mcpServers?.[0]?.enabled).toBe(true);
    host.input.emit('\r');
    await waitFor(() => mcpEnabled === false && controller.store.getState().picker?.mcpServers?.[0]?.enabled === false);
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);

    // `/plugins` list + Enter toggles disabled
    await controller.submitInput('/plugins');
    await waitFor(() => controller.store.getState().picker?.kind === 'plugins' && !controller.store.getState().picker?.loading);
    expect(controller.store.getState().picker?.plugins?.[0]?.name).toBe('code-review');
    host.input.emit('\r');
    await waitFor(() => pluginEnabled === false && controller.store.getState().picker?.plugins?.[0]?.enabled === false);
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);

    // `/skills` previews SKILL.md and Enter inserts `/deploy-helper ` into draft
    await controller.submitInput('/skills');
    await waitFor(() => controller.store.getState().picker?.kind === 'skills' && !controller.store.getState().picker?.loading);
    expect(controller.store.getState().picker?.skills?.some(s => s.name === 'deploy-helper')).toBe(true);
    const skillPv = host.findWireNodes(n => n.id === 'layer.modal.skills-pv');
    expect(JSON.stringify(skillPv)).toContain('Run checks first.');
    host.input.emit('\r');
    await waitFor(() => controller.store.getState().picker === null && controller.store.draft.text === '/deploy-helper ');
    controller.store.draft.clear(false);

    // `/agents` lists CLI agents
    await controller.submitInput('/agents');
    await waitFor(() => controller.store.getState().picker?.kind === 'agents' && !controller.store.getState().picker?.loading);
    expect(controller.store.getState().picker?.agents?.some(a => a.name === 'coder')).toBe(true);
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);

    // Error card actions: trigger error turn -> Copy error, Switch model, Retry
    await controller.submitInput('Trigger rate limit');
    await waitFor(() => !controller.store.getState().isStreaming && controller.store.transcript.turns[2]?.status === 'error');
    const copyErrBtn = host.findWireNodes(n => n.p?.['role'] === 'omp.error.action' && n.p?.['text'] === 'Copy error')[0];
    const switchModelBtn = host.findWireNodes(n => n.p?.['role'] === 'omp.error.action' && n.p?.['text'] === 'Switch model')[0];
    const retryBtn = host.findWireNodes(n => n.p?.['role'] === 'omp.error.action' && n.p?.['text'] === 'Retry')[0];
    expect(copyErrBtn).toBeDefined();
    expect(switchModelBtn).toBeDefined();
    expect(retryBtn).toBeDefined();

    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: copyErrBtn!.id, act: 'error.copy' });
    await waitFor(() => copiedTexts.includes('Rate limit exceeded'));

    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: switchModelBtn!.id, act: 'error.switch-model' });
    await waitFor(() => controller.store.getState().picker?.kind === 'model');
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);

    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: retryBtn!.id, act: 'error.retry' });
    await waitFor(() => !controller.store.getState().isStreaming && controller.store.transcript.turns.length === 4);
    expect(controller.store.transcript.turns[3]?.assistantText).toBe('Retry succeeded!');

    // User message context menu: Edit & resend populates composer draft
    const userCard = host.findWireNodes(n => n.k === 'card' && n.p?.['role'] === 'omp.user')[0];
    expect(userCard).toBeDefined();
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: userCard!.id, act: 'edit-resend' });
    await waitFor(() => controller.store.draft.text === 'Prompt one');
    controller.store.draft.clear(false);

    // `/logout` opens confirmation card -> confirm invokes ACP `auth/logout` RPC
    await controller.submitInput('/logout');
    await waitFor(() => controller.store.getState().infoOverlay?.kind === 'logout_confirm');
    host.input.emit('\r');
    await waitFor(() => logoutCalled === true);
    expect(controller.store.getState().infoOverlay).toBeNull();
    expect(controller.store.getState().authRequired).not.toBeNull();
    expect(cliCalls.length).toBeGreaterThanOrEqual(5);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('Antigravity welcome logo switches dark/light blob on theme events, installs styles when supported, and falls back when blobs capability is absent', async () => {
    const tmp = makeTempDir();
    const darkAsset = getAntigravityLogoAsset(true);
    const lightAsset = getAntigravityLogoAsset(false);
    const darkBlobId = blobId(darkAsset.bytes);
    const lightBlobId = blobId(lightAsset.bytes);
    expect(darkBlobId).not.toBe(lightBlobId);

    // 1. Blob + styles capable terminal: starts dark -> switches to light -> switches back to dark
    const host = new FakeTernHost({
      dark: true,
      features: ['blobs', 'styles', 'settle', 'dock', 'scroll', 'font', 'aside'],
    });
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();
    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-logo-theme', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // Stylesheet installed without `!important` when `styles` feature is advertised,
    // and disables pointer events on bee/logo `<image>` nodes so Tern lightbox never hijacks clicks
    const sheetMsg = host.tspMessages.find(
      m => m.verb === 's' && m.body['name'] === 'oma-welcome-logo'
    );
    expect(sheetMsg).toBeDefined();
    expect(String(sheetMsg?.body['css'] ?? '')).toContain('box-shadow: none');
    expect(String(sheetMsg?.body['css'] ?? '')).toContain('pointer-events: none');
    expect(String(sheetMsg?.body['css'] ?? '')).not.toContain('!important');

    // Initial dark logo + 3 core pixel bees uploaded once via `b` frames and rendered via `blob`
    const darkBees = getSwarmBeeAssets(true);
    const lightBees = getSwarmBeeAssets(false);
    expect(host.tspMessages.filter(m => m.verb === 'b').length).toBe(4);
    expect(controller.store.getState().welcomeLogoBlobId).toBe(darkBlobId);
    expect(controller.store.getState().beeHudBlobId).toBe(blobId(darkBees.hud.bytes));
    expect(controller.store.getState().beeActiveBlobId).toBe(blobId(darkBees.active.bytes));
    expect(controller.store.getState().beeSleepBlobId).toBe(blobId(darkBees.sleep.bytes));
    const initialLogo = host.findWireNodes(n => n.p?.['role'] === 'omp.welcome.logo')[0];
    expect(initialLogo?.p?.['blob']).toBe(darkBlobId);
    expect(initialLogo?.p?.['builtin']).toBeUndefined();

    // Switch to light theme -> uploads light logo + 3 light bee SVG blobs and patches `main.welcome.lockup.logo`
    host.input.emitTspEvent({ ev: 'theme', dark: false });
    await waitFor(() => controller.store.getState().welcomeLogoBlobId === lightBlobId);
    await waitFor(() =>
      host.allOps.some(
        op => op[0] === 'set' && op[1] === 'main.welcome.lockup.logo' && op[2]['blob'] === lightBlobId
      )
    );
    const blobFramesAfterLight = host.tspMessages.filter(m => m.verb === 'b');
    expect(blobFramesAfterLight.length).toBe(8);
    expect(blobFramesAfterLight[4]?.body['mime']).toBe('image/svg+xml');
    const lightSvg = Buffer.from(String(blobFramesAfterLight[4]?.body['base64'] ?? ''), 'base64').toString('utf8');
    expect(lightSvg).toContain(ANTIGRAVITY_LOGO_PATH);
    expect(lightSvg).not.toContain('currentColor');
    expect(controller.store.getState().beeHudBlobId).toBe(blobId(lightBees.hud.bytes));
    expect(controller.store.getState().beeActiveBlobId).toBe(blobId(lightBees.active.bytes));
    expect(controller.store.getState().beeSleepBlobId).toBe(blobId(lightBees.sleep.bytes));

    // Switch back to dark theme -> reuses cached blobs without re-sending any new `b` frame
    host.input.emitTspEvent({ ev: 'theme', dark: true });
    await waitFor(() => controller.store.getState().welcomeLogoBlobId === darkBlobId);
    await waitFor(() =>
      host.allOps.some(
        op => op[0] === 'set' && op[1] === 'main.welcome.lockup.logo' && op[2]['blob'] === darkBlobId
      )
    );
    expect(host.tspMessages.filter(m => m.verb === 'b').length).toBe(8);

    await controller.shutdown({ cleanExit: true });
    await runPromise;

    // 2. Non-blob terminal fallback: no `b` frame sent, safely falls back to `builtin: 'omp'`
    const noBlobHost = new FakeTernHost({
      dark: true,
      features: ['settle', 'dock', 'scroll'],
    });
    const noBlobSession = await createConnectedSession(noBlobHost);
    const noBlobAcp = new MockAcpHarness();
    noBlobAcp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-no-blob', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const noBlobController = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session: noBlobSession,
      output: noBlobHost.safeOutput,
      acpSpawn: noBlobAcp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      installSignals: false,
      throttleMs: 5,
    });

    const noBlobRun = noBlobController.run();
    await noBlobController.readyPromise;

    expect(noBlobHost.tspMessages.filter(m => m.verb === 'b').length).toBe(0);
    expect(noBlobHost.tspMessages.filter(m => m.verb === 's').length).toBe(0);
    expect(noBlobController.store.getState().welcomeLogoBlobId).toBeUndefined();
    const fallbackLogo = noBlobHost.findWireNodes(n => n.p?.['role'] === 'omp.welcome.logo')[0];
    expect(fallbackLogo?.k).toBe('image');
    expect(fallbackLogo?.p?.['builtin']).toBe('omp');
    expect(fallbackLogo?.p?.['blob']).toBeUndefined();

    await noBlobController.shutdown({ cleanExit: true });
    await noBlobRun;
  });

  test('thinking timer stops immediately on tool_call, agent_message_chunk, and Esc cancel with zero lingering live <elapsed> nodes', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let clock = 500_000;
    let activePromptId: string | number | undefined;
    let promptSeq = 0;

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-think-timer', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        promptSeq += 1;
        activePromptId = msg.id;
      } else if (msg.method === 'session/cancel') {
        if (activePromptId !== undefined) {
          h.send({ jsonrpc: '2.0', id: activePromptId, result: { stopReason: 'cancelled' } });
          activePromptId = undefined;
        }
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    // Reconstruct the live wire node map by replaying all TSP frame ops in order
    const replayCurrentWireNodes = (): Map<string, { k: string; p: Record<string, unknown> }> => {
      const nodes = new Map<string, { k: string; p: Record<string, unknown> }>();
      const addSubtree = (n: WireNode): void => {
        nodes.set(n.id, { k: n.k, p: { ...(n.p ?? {}) } });
        if (n.c) {
          for (const child of n.c) addSubtree(child);
        }
      };
      const deleteSubtree = (id: string): void => {
        nodes.delete(id);
        const prefix = `${id}.`;
        for (const key of [...nodes.keys()]) {
          if (key.startsWith(prefix)) nodes.delete(key);
        }
      };
      for (const op of host.allOps) {
        if (op[0] === 'add') {
          addSubtree(op[4]);
        } else if (op[0] === 'del') {
          deleteSubtree(op[1]);
        } else if (op[0] === 'set') {
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
    };

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      installSignals: false,
      throttleMs: 5,
      now: () => clock,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // --- Turn 0: thought1 -> tool_call (bash) -> tool_call_update -> thought2 -> agent_message_chunk -> end_turn ---
    await controller.submitInput('Debug thinking timer');
    await waitFor(() => promptSeq === 1);

    // 1. Thought 1 starts -> must render omp.thinking.live + live <elapsed age=...>
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-think-timer',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Analyzing root cause...' },
        },
      },
    });
    await waitFor(() => {
      const current = replayCurrentWireNodes();
      return [...current.values()].some(
        n => n.k === 'section' && n.p['role'] === 'omp.thinking.live'
      );
    });

    let current = replayCurrentWireNodes();
    const liveThought1Entry = [...current.entries()].find(
      ([, n]) => n.k === 'section' && n.p['role'] === 'omp.thinking.live'
    );
    expect(liveThought1Entry).toBeDefined();
    const thought1Id = liveThought1Entry![0];
    expect(liveThought1Entry![1].p['took']).toBeUndefined();
    const liveElapsed1 = current.get(`${thought1Id}.head.age`);
    expect(liveElapsed1?.k).toBe('elapsed');
    expect(typeof liveElapsed1?.p['age']).toBe('number');
    expect(liveElapsed1?.p['stopped']).toBeUndefined();

    // 2. Advance 1500ms, then emit tool_call (bash in_progress) -> Thought 1 MUST freeze immediately!
    clock += 1500;
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-think-timer',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-bash-timer',
          name: 'run_command',
          kind: 'execute',
          status: 'in_progress',
          title: 'bun test',
          args: { CommandLine: 'bun test' },
        },
      },
    });
    await waitFor(() => {
      const snap = replayCurrentWireNodes();
      return snap.get(thought1Id)?.p['role'] === 'omp.thinking';
    });

    current = replayCurrentWireNodes();
    const doneThought1 = current.get(thought1Id)!;
    expect(doneThought1.p['role']).toBe('omp.thinking');
    expect(doneThought1.p['took']).toBe(1500);
    // Aligned with `omp`: completed thoughts round to whole seconds (1500ms -> 2s)
    expect(JSON.stringify(doneThought1.p['head'])).toContain('Thought for 2s');
    // Old live head row, spinner, and live <elapsed> MUST be completely deleted!
    expect(current.has(`${thought1Id}.head`)).toBe(false);
    expect(current.has(`${thought1Id}.head.age`)).toBe(false);
    expect(current.has(`${thought1Id}.head.spin`)).toBe(false);

    // Bash tool is running -> live <elapsed role="omp.run.time" age=...> exists
    const runningBashElapsed = [...current.entries()].find(
      ([, n]) => n.k === 'elapsed' && n.p['role'] === 'omp.run.time'
    );
    expect(runningBashElapsed).toBeDefined();
    expect(typeof runningBashElapsed![1].p['age']).toBe('number');
    expect(runningBashElapsed![1].p['stopped']).toBeUndefined();

    // 3. Advance 2000ms and complete bash tool -> Bash <elapsed> switches to stopped=2000 without age
    clock += 2000;
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-think-timer',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-bash-timer',
          status: 'completed',
          rawOutput: { output: 'pass', exit_code: 0 },
        },
      },
    });
    await waitFor(() => {
      const snap = replayCurrentWireNodes();
      return [...snap.values()].some(
        n => n.k === 'elapsed' && n.p['role'] === 'omp.run.time' && n.p['stopped'] === 2000
      );
    });
    current = replayCurrentWireNodes();
    const bashElapsedAfter = [...current.values()].filter(
      n => n.k === 'elapsed' && n.p['role'] === 'omp.run.time'
    );
    expect(bashElapsedAfter).toHaveLength(1);
    expect(bashElapsedAfter[0]!.p['stopped']).toBe(2000);
    expect(bashElapsedAfter[0]!.p['age']).toBeUndefined();

    // 4. Thought 2 starts -> Thought 1 stays frozen at took=1500, Thought 2 goes live
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-think-timer',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Synthesizing answer...' },
        },
      },
    });
    await waitFor(() => {
      const snap = replayCurrentWireNodes();
      return [...snap.entries()].some(
        ([id, n]) => id !== thought1Id && n.k === 'section' && n.p['role'] === 'omp.thinking.live'
      );
    });
    current = replayCurrentWireNodes();
    const thought2Id = [...current.entries()].find(
      ([id, n]) => id !== thought1Id && n.k === 'section' && n.p['role'] === 'omp.thinking.live'
    )![0];
    expect(current.get(thought1Id)?.p['took']).toBe(1500);
    expect(current.get(`${thought2Id}.head.age`)?.k).toBe('elapsed');

    // 5. Advance 800ms, emit agent_message_chunk -> Thought 2 freezes at took=800 & deletes live elapsed
    clock += 800;
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-think-timer',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Timer bug is fixed.' },
        },
      },
    });
    await waitFor(() => replayCurrentWireNodes().get(thought2Id)?.p['role'] === 'omp.thinking');

    current = replayCurrentWireNodes();
    expect(current.get(thought2Id)?.p['took']).toBe(800);
    expect(current.has(`${thought2Id}.head`)).toBe(false);
    expect(current.has(`${thought2Id}.head.age`)).toBe(false);

    // Complete Turn 0
    acp.send({ jsonrpc: '2.0', id: activePromptId, result: { stopReason: 'end_turn' } });
    activePromptId = undefined;
    await waitFor(() => !controller.store.getState().isStreaming);

    // After Turn 0 completes: ZERO live <elapsed> without `stopped`, ZERO omp.thinking.live!
    current = replayCurrentWireNodes();
    const lingeringLiveElapsed0 = [...current.values()].filter(
      n => n.k === 'elapsed' && n.p['stopped'] === undefined
    );
    expect(lingeringLiveElapsed0).toHaveLength(0);
    expect([...current.values()].some(n => n.p['role'] === 'omp.thinking.live')).toBe(false);

    // --- Turn 1: thought -> Esc cancel immediately freezes thinking timer ---
    clock += 1000;
    await controller.submitInput('Cancel while thinking');
    await waitFor(() => promptSeq === 2);

    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-think-timer',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Long thought to cancel...' },
        },
      },
    });
    await waitFor(() =>
      [...replayCurrentWireNodes().values()].some(
        n => n.k === 'section' && n.p['role'] === 'omp.thinking.live'
      )
    );
    const thought3Id = [...replayCurrentWireNodes().entries()].find(
      ([, n]) => n.k === 'section' && n.p['role'] === 'omp.thinking.live'
    )![0];

    clock += 650;
    host.input.emit('\x1b'); // Esc
    await waitFor(() => !controller.store.getState().isStreaming);

    current = replayCurrentWireNodes();
    expect(current.get(thought3Id)?.p['role']).toBe('omp.thinking');
    expect(current.get(thought3Id)?.p['took']).toBe(650);
    expect(current.has(`${thought3Id}.head`)).toBe(false);
    expect(current.has(`${thought3Id}.head.age`)).toBe(false);
    expect([...current.values()].filter(n => n.k === 'elapsed' && n.p['stopped'] === undefined)).toHaveLength(0);
    expect([...current.values()].some(n => n.p['role'] === 'omp.thinking.live')).toBe(false);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('Dock omp.hud 3-layer pill (agents + jobs segments), omp.overlay.jobs panel open/select/close focus restore, /jobs & /tasks, and zero lingering live <elapsed>', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let clock = 800_000;
    let activePromptId: string | number | undefined;

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-hud-jobs', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        activePromptId = msg.id;
      } else if (msg.method === 'session/cancel') {
        if (activePromptId !== undefined) {
          h.send({ jsonrpc: '2.0', id: activePromptId, result: { stopReason: 'cancelled' } });
          activePromptId = undefined;
        }
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const replayCurrentWireNodes = (): Map<string, { k: string; p: Record<string, unknown> }> => {
      const nodes = new Map<string, { k: string; p: Record<string, unknown> }>();
      const addSubtree = (n: WireNode): void => {
        nodes.set(n.id, { k: n.k, p: { ...(n.p ?? {}) } });
        if (n.c) {
          for (const child of n.c) addSubtree(child);
        }
      };
      const deleteSubtree = (id: string): void => {
        nodes.delete(id);
        const prefix = `${id}.`;
        for (const key of [...nodes.keys()]) {
          if (key.startsWith(prefix)) nodes.delete(key);
        }
      };
      for (const op of host.allOps) {
        if (op[0] === 'add') {
          addSubtree(op[4]);
        } else if (op[0] === 'del') {
          deleteSubtree(op[1]);
        } else if (op[0] === 'set') {
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
    };

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      installSignals: false,
      throttleMs: 5,
      now: () => clock,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // 1. Empty session: `/jobs` renders omp.overlay.jobs empty state and Esc restores editor focus
    await controller.submitInput('/jobs');
    await waitFor(() => controller.store.getState().infoOverlay?.kind === 'jobs');
    expect(controller.currentSurfaceFocus).toBeNull();
    let current = replayCurrentWireNodes();
    expect(current.get('layer.info')?.p['role']).toBe('omp.overlay.jobs');
    expect(current.get('layer.info')?.p['head']).toBe('Background jobs');
    expect(current.get('layer.info')?.p['foot']).toBeUndefined();
    expect(current.get('layer.info.body.empty')?.p['role']).toBe('omp.jobs.empty');
    expect(current.get('layer.info.body.empty.title')?.p['text']).toBe('No background jobs');

    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().infoOverlay === null);
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);

    // 2. Start turn with 2 non-agent background jobs (run_command + run_workflow) + 1 subagent + plan
    await controller.submitInput('Run checks and subagent');
    await waitFor(() => activePromptId !== undefined);

    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-hud-jobs',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-cmd-live',
          name: 'run_command',
          kind: 'execute',
          status: 'in_progress',
          title: 'Run build & tests',
          args: { CommandLine: 'bun test --bail' },
          content: [{ type: 'content', content: { type: 'text', text: 'Running suite 1/2...' } }],
        },
      },
    });
    await waitFor(() => controller.store.transcript.getToolById('tc-cmd-live') !== undefined);
    clock += 200;
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-hud-jobs',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-wf-live',
          name: 'run_workflow',
          status: 'in_progress',
          title: 'Parallel lint',
          args: { Description: 'Lint workspace packages' },
        },
      },
    });
    await waitFor(() => controller.store.transcript.getToolById('tc-wf-live') !== undefined);
    clock += 200;
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-hud-jobs',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-sub-live',
          name: 'invoke_subagent',
          status: 'in_progress',
          args: { name: 'verifier', task: 'Inspect HUD layout' },
        },
      },
    });
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-hud-jobs',
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'Verify HUD pill', status: 'in_progress' }],
        },
      },
    });

    await waitFor(() => {
      const m = replayCurrentWireNodes();
      return (
        m.has('dock.hud.running.jobs') &&
        m.has('dock.hud.running.agents') &&
        m.has('dock.activity.todo')
      );
    });

    // Verify 3-layer Dock structure: dock.hud (omp.hud) -> dock.hud.running (omp.hud.pill) -> agents + jobs segments
    current = replayCurrentWireNodes();
    expect(current.get('dock.hud')?.p['role']).toBe('omp.hud');
    expect(current.get('dock.hud')?.p['justify']).toBe('end');
    expect(current.get('dock.hud.running')?.p['role']).toBe('omp.hud.pill');
    // Must NOT nest omp.hud.pill inside omp.hud.activity
    expect(current.has('dock.activity.swarm')).toBe(false);
    expect(current.get('dock.activity')?.p['role']).toBe('omp.hud.activity');
    expect(current.get('dock.activity.status.working')?.p['role']).toBe('omp.working');
    expect(current.get('dock.activity.todo')?.p['role']).toBe('omp.hud.todo');

    // Agents segment: 1 running subagent (accent icon + pure numeric span)
    const agentsSeg = current.get('dock.hud.running.agents');
    expect(agentsSeg?.p['role']).toBe('omp.hud.seg');
    expect((agentsSeg?.p['actions'] as Record<string, unknown> | undefined)?.['click']).toBe('agents.open');
    expect(current.get('dock.hud.running.agents.icon')?.p['name']).toBe('users');
    expect(current.get('dock.hud.running.agents.icon')?.p['tone']).toBe('accent');
    expect(current.get('dock.hud.running.agents.count')?.p['spans']).toEqual([{ t: '1', s: 'num' }]);

    // Jobs segment: 2 running non-agent jobs (excludes subagent!)
    const jobsSeg = current.get('dock.hud.running.jobs');
    expect(jobsSeg?.p['role']).toBe('omp.hud.seg');
    expect((jobsSeg?.p['actions'] as Record<string, unknown> | undefined)?.['click']).toBe('jobs.open');
    expect(String(jobsSeg?.p['title'] ?? '')).toContain('2 jobs running  /jobs');
    expect(String(jobsSeg?.p['title'] ?? '')).toContain('bun test --bail');
    expect(current.get('dock.hud.running.jobs.icon')?.p['name']).toBe('job');
    expect(current.get('dock.hud.running.jobs.icon')?.p['tone']).toBe('warning');
    expect(current.get('dock.hud.running.jobs.count')?.p['spans']).toEqual([{ t: '2', s: 'num' }]);

    // 3. Click `dock.hud.running.jobs` -> opens omp.overlay.jobs, steals focus to null
    clock += 1000;
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'dock.hud.running.jobs',
      act: 'jobs.open',
    });
    await waitFor(() => controller.store.getState().infoOverlay?.kind === 'jobs');
    expect(controller.currentSurfaceFocus).toBeNull();

    current = replayCurrentWireNodes();
    expect(current.get('layer.info')?.p['role']).toBe('omp.overlay.jobs');
    expect(current.get('layer.info.body.split')?.p['role']).toBe('omp.jobs.split');
    expect(current.get('layer.info.body.split.master')?.p['role']).toBe('omp.jobs.master');
    expect(current.get('layer.info.body.actions.summary')?.p['role']).toBe('omp.jobs.summary');
    expect(current.get('layer.info.body.actions.summary')?.p['text']).toBe('3 running');

    // Select `tc-cmd-live` via list select event -> inspects bash command, live <elapsed>, and ANSI output
    host.input.emitTspEvent({
      ev: 'select',
      sf: 'oma',
      id: 'layer.info.body.split.master.jobs',
      item: 'layer.info.body.split.master.jobs.tc-cmd-live',
    });
    await waitFor(() => controller.store.getState().infoOverlay?.selectedJobId === 'tc-cmd-live');

    current = replayCurrentWireNodes();
    const detailPrefix = 'layer.info.body.split.detail-tc-cmd-live';
    expect(current.get(detailPrefix)?.p['role']).toBe('omp.jobs.detail');
    expect(current.get(`${detailPrefix}.status.age-live`)?.k).toBe('elapsed');
    expect(typeof current.get(`${detailPrefix}.status.age-live`)?.p['age']).toBe('number');
    expect(current.get(`${detailPrefix}.status.age-live`)?.p['stopped']).toBeUndefined();
    expect(current.get(`${detailPrefix}.command`)?.p['role']).toBe('omp.jobs.command');
    expect(current.get(`${detailPrefix}.command`)?.p['text']).toBe('bun test --bail');
    expect(current.get(`${detailPrefix}.out.text-tc-cmd-live`)?.p['role']).toBe('omp.jobs.output');
    expect(current.get(`${detailPrefix}.out.text-tc-cmd-live`)?.p['text']).toBe('Running suite 1/2...');
    expect(current.get(`${detailPrefix}.out.text-tc-cmd-live`)?.p['follow']).toBe(true);

    // Down arrow navigates to next job in the list
    host.input.emit('\x1b[B');
    await waitFor(() => controller.store.getState().infoOverlay?.selectedJobId !== 'tc-cmd-live');

    // Click Close button -> closes overlay & restores EDITOR_NODE_ID focus
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'layer.info.body.actions.close',
      act: 'close',
    });
    await waitFor(() => controller.store.getState().infoOverlay === null);
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);

    // 4. Complete all tasks & finish turn -> jobs HUD segment disappears, agents segment stays muted (inspectable), ZERO live <elapsed>
    clock += 1600;
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-hud-jobs',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-cmd-live',
          status: 'completed',
          rawOutput: { output: 'Suite passed (12/12)', exit_code: 0 },
        },
      },
    });
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-hud-jobs',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-wf-live',
          status: 'completed',
          rawOutput: { output: '0 lint issues' },
        },
      },
    });
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-hud-jobs',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-sub-live',
          status: 'completed',
          rawOutput: { output: 'HUD verified' },
        },
      },
    });
    acp.send({ jsonrpc: '2.0', id: activePromptId, result: { stopReason: 'end_turn' } });
    activePromptId = undefined;

    await waitFor(() => !controller.store.getState().isStreaming);

    current = replayCurrentWireNodes();
    // Jobs segment MUST vanish once runningJobs === 0
    expect(current.has('dock.hud.running.jobs')).toBe(false);
    // Agents segment stays in muted inspectable state (icon only, no numeric badge)
    expect(current.has('dock.hud.running.agents')).toBe(true);
    expect(current.get('dock.hud.running.agents.icon')?.p['tone']).toBe('muted');
    expect(current.has('dock.hud.running.agents.count')).toBe(false);

    // Open `/tasks` alias -> completed job shows `age-stopped` with `stopped`, follow=false, ZERO live `<elapsed>`
    await controller.submitInput('/tasks');
    await waitFor(() => controller.store.getState().infoOverlay?.kind === 'jobs');
    host.input.emitTspEvent({
      ev: 'select',
      sf: 'oma',
      id: 'layer.info.body.split.master.jobs',
      item: 'layer.info.body.split.master.jobs.tc-cmd-live',
    });
    await waitFor(() => controller.store.getState().infoOverlay?.selectedJobId === 'tc-cmd-live');

    current = replayCurrentWireNodes();
    expect(current.has(`${detailPrefix}.status.age-live`)).toBe(false);
    expect(current.get(`${detailPrefix}.status.age-stopped`)?.k).toBe('elapsed');
    expect(current.get(`${detailPrefix}.status.age-stopped`)?.p['stopped']).toBe(3000);
    expect(current.get(`${detailPrefix}.status.age-stopped`)?.p['age']).toBeUndefined();
    expect(current.get(`${detailPrefix}.out.text-tc-cmd-live`)?.p['follow']).toBe(false);

    // Strict stopwatch invariant across entire live wire tree: ZERO live <elapsed> without `stopped`!
    const lingeringLiveElapsed = [...current.values()].filter(
      n => n.k === 'elapsed' && n.p['stopped'] === undefined
    );
    expect(lingeringLiveElapsed).toHaveLength(0);

    // Esc closes `/tasks` and restores editor focus
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().infoOverlay === null);
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);

    // Verify `/help` table lists `/jobs` with concise <= 28-char description
    await controller.submitInput('/help');
    await waitFor(() => controller.store.getState().helpOpen);
    const helpTables = host.findWireNodes(n => n.k === 'table' && n.p?.['role'] === 'omp.hotkeys.table');
    const cmdTblJson = JSON.stringify(helpTables[helpTables.length - 1]);
    expect(cmdTblJson).toContain('/jobs');
    expect(cmdTblJson).toContain('Inspect background jobs');
    host.input.emit('\x1b');
    await waitFor(() => !controller.store.getState().helpOpen);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('cursor suppression timing regression: pre-open + post-open OSC2+DECTCEM + first-frame force reassert + resize/theme/features/settleTurn reassert + /login & /quit restore', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost({
      features: ['blobs', 'styles', 'settle', 'dock', 'scroll', 'font', 'aside'],
    });
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();
    let clock = 10_000;

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new' || msg.method === 'session/load') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-cursor-reg', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-cursor-reg',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Cursor check ok.' } },
          },
        });
        h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      runLogin: async () => 0,
      installSignals: false,
      throttleMs: 5,
      now: () => clock,
    });

    // 1. Double-lock: HIDE_CURSOR before `o` frame AND atomic `OSC 2 + HIDE_CURSOR` after `o` frame
    const startupStream = host.rawStream;
    const preHideIdx = startupStream.indexOf(HIDE_CURSOR);
    const openIdx = startupStream.indexOf('\x1b_tsp;o;');
    const atomicTitleHide = '\x1b]2;oma · Antigravity\x1b\\' + HIDE_CURSOR;
    const postTitleHideIdx = startupStream.indexOf(atomicTitleHide);
    expect(preHideIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeGreaterThan(preHideIdx);
    expect(postTitleHideIdx).toBeGreaterThan(openIdx);
    expect(controller.osc.cursorHidden).toBe(true);

    const beforeRunLen = host.rawStream.length;
    const runPromise = controller.run();
    await controller.readyPromise;

    // 2. First render + syncFocus(true) forcefully reasserts HIDE_CURSOR
    expect(host.rawStream.slice(beforeRunLen)).toContain(HIDE_CURSOR);

    // 3. `resize`, `theme`, `features`, and `settleTurn` each reassert HIDE_CURSOR after throttle interval
    clock += 300;
    const beforeResize = host.rawStream.length;
    host.input.emitTspEvent({ ev: 'resize', cols: 132, rows: 40 });
    await waitFor(() => host.rawStream.slice(beforeResize).includes(HIDE_CURSOR));

    clock += 300;
    const beforeTheme = host.rawStream.length;
    host.input.emitTspEvent({ ev: 'theme', dark: false });
    await waitFor(() => host.rawStream.slice(beforeTheme).includes(HIDE_CURSOR));

    clock += 300;
    const beforeFeatures = host.rawStream.length;
    host.input.emitTspEvent({ ev: 'features', features: ['blobs', 'styles', 'settle', 'dock', 'aside'] });
    await waitFor(() => host.rawStream.slice(beforeFeatures).includes(HIDE_CURSOR));

    clock += 300;
    const beforeTurn = host.rawStream.length;
    await controller.submitInput('Check settle cursor reassert');
    await waitFor(() =>
      host.allOps.some(op => op[0] === 'settle' && typeof op[1] === 'string' && op[1].startsWith('main.t0-'))
    );
    expect(host.rawStream.slice(beforeTurn)).toContain(HIDE_CURSOR);

    // 4. `/login` suspends with SHOW_CURSOR and resumes with atomic OSC 2 + HIDE_CURSOR
    const beforeLogin = host.rawStream.length;
    await controller.submitInput('/login');
    await waitFor(() => host.rawStream.slice(beforeLogin).includes(atomicTitleHide));
    const loginSlice = host.rawStream.slice(beforeLogin);
    expect(loginSlice.indexOf(SHOW_CURSOR)).toBeGreaterThanOrEqual(0);
    expect(loginSlice.indexOf(atomicTitleHide)).toBeGreaterThan(loginSlice.indexOf(SHOW_CURSOR));
    expect(controller.osc.cursorHidden).toBe(true);

    // 5. `/quit` restores native terminal cursor (`SHOW_CURSOR`) and disarms cursor guard
    const beforeQuit = host.rawStream.length;
    await controller.submitInput('/quit');
    await runPromise;
    expect(host.rawStream.slice(beforeQuit)).toContain(SHOW_CURSOR);
    expect(controller.osc.cursorHidden).toBe(false);
  });

  test('background task & active swarm defer OSC 7501 done, keep Stop when draft empty, switch to Send on typing for steering (#90), emit done & unload oma-swarm-fx on completion', async () => {
    const tmp = makeTempDir();
    const brainRoot = join(tmp, 'brain');
    const sessionId = 'sess-bg-swarm';
    const swarmDir = join(brainRoot, sessionId, '.system_generated', 'swarm');

    const host = new FakeTernHost({
      features: ['blobs', 'styles', 'settle', 'dock', 'scroll', 'font', 'aside'],
    });
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let clock = 900_000;
    let promptCount = 0;
    const receivedPrompts: string[] = [];
    let cancelCount = 0;

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId, configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        promptCount += 1;
        const blocks = (msg.params?.['prompt'] as Array<{ type?: string; text?: string }> | undefined) ?? [];
        const text = blocks.find(b => b.type === 'text')?.text ?? '';
        receivedPrompts.push(text);

        if (promptCount === 1) {
          // Turn 1: launch a detached background run_command and immediately end_turn
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-bg-cmd',
                name: 'run_command',
                kind: 'execute',
                status: 'completed',
                title: 'Start dev server',
                args: { CommandLine: 'bun run server.ts', IsDaemon: true },
                rawOutput: { output: 'Command is running in the background. TaskId: bg-task-42' },
              },
            },
          });
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Started in background.' } },
            },
          });
          h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        } else if (promptCount === 2) {
          // Turn 2: standard ACP `manage_task` tool_call with `title` + `rawInput` (no `name`) finishes bg-task-42
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-manage-kill',
                title: 'manage_task',
                status: 'completed',
                rawInput: { Action: 'kill', TaskId: 'bg-task-42' },
                rawOutput: { output: 'Task bg-task-42 killed.' },
              },
            },
          });
          h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        } else {
          // Turn 3+: steering message during active swarm
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Forwarded steering context to swarm.' } },
            },
          });
          h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      } else if (msg.method === 'session/cancel') {
        cancelCount += 1;
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const replayCurrentWireNodes = (): Map<string, { k: string; p: Record<string, unknown> }> => {
      const nodes = new Map<string, { k: string; p: Record<string, unknown> }>();
      const addSubtree = (n: WireNode): void => {
        nodes.set(n.id, { k: n.k, p: { ...(n.p ?? {}) } });
        if (n.c) {
          for (const child of n.c) addSubtree(child);
        }
      };
      const deleteSubtree = (id: string): void => {
        nodes.delete(id);
        const prefix = `${id}.`;
        for (const key of [...nodes.keys()]) {
          if (key.startsWith(prefix)) nodes.delete(key);
        }
      };
      for (const op of host.allOps) {
        if (op[0] === 'add') {
          addSubtree(op[4]);
        } else if (op[0] === 'del') {
          deleteSubtree(op[1]);
        } else if (op[0] === 'set') {
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
    };

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      baseBrainDir: brainRoot,
      swarmPollIntervalMs: 30,
      backgroundDoneGraceMs: 25,
      installSignals: false,
      throttleMs: 5,
      now: () => clock,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // --- Part A: Detached background task keeps Stop button & suppresses premature OSC 7501 done ---
    const oscLenBeforeBg = host.osc7501.length;
    await controller.submitInput('Start background server');
    await waitFor(() => !controller.store.getState().isStreaming && promptCount === 1);

    expect(controller.store.hasActiveBackgroundTasks()).toBe(true);
    expect(controller.store.isBusy).toBe(true);
    const oscAfterBgPrompt = host.osc7501.slice(oscLenBeforeBg);
    expect(oscAfterBgPrompt).toContain('state=working');
    expect(oscAfterBgPrompt).not.toContain('state=done');

    // Empty draft -> bottom action button is Stop (`interrupt`), editor placeholder shows muted bg hint
    let current = replayCurrentWireNodes();
    expect(current.has('dock.composer.bar.stop')).toBe(true);
    expect(current.has('dock.composer.bar.send')).toBe(false);
    expect(JSON.stringify(current.get(EDITOR_NODE_ID)?.p['placeholder'])).toContain('Background task running');

    // Typing steering text while background task runs -> button switches to Send (`submit`) & Enter sends prompt!
    host.input.emit('Please stop the server now');
    await waitFor(() => controller.store.draft.text === 'Please stop the server now');
    current = replayCurrentWireNodes();
    expect(current.has('dock.composer.bar.send')).toBe(true);
    expect(current.has('dock.composer.bar.stop')).toBe(false);

    host.input.emit('\r');
    await waitFor(() => promptCount === 2 && !controller.store.getState().isStreaming);
    expect(receivedPrompts[1]).toBe('Please stop the server now');
    expect(controller.store.hasActiveBackgroundTasks()).toBe(false);
    expect(host.osc7501.slice(oscLenBeforeBg)).toContain('state=done');
    current = replayCurrentWireNodes();
    expect(current.has('dock.composer.bar.send')).toBe(true);
    expect(current.has('dock.composer.bar.stop')).toBe(false);

    // --- Part B: Swarm becomes active via live board directory creation -> oma-swarm-fx, HUD bee left of jobs, smart Stop/Send steering (#90), auto-done & stylesheet unload ---
    const oscLenBeforeSwarm = host.osc7501.length;
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      join(swarmDir, 'swarm.json'),
      JSON.stringify({ version: 1, backend: 'local', swarm_id: sessionId, created_at: '2026-11-21T01:00:00Z' }),
      'utf8'
    );
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Live Bee Swarm',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', applied_model: 'gemini-4-neon', killed: false },
          'worker-bee': { role: 'worker', phase: 'RUNNING', applied_model: 'gemini-4-neon', killed: false },
        },
      }),
      'utf8'
    );
    writeFileSync(
      join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 1, agent: 'coordinator', text: '@worker-bee Go!', time: '2026-11-21 01:00:01', kind: 'brief' })}\n`,
      'utf8'
    );

    await waitFor(() => controller.store.isSwarmWorking === true);

    // Stylesheet installed (ONLY perimeter bee animation, zero composer box animation) + dynamic bee count matching actual active members (2: coordinator + worker-bee)
    expect(SWARM_BEE_EFFECT_CSS).not.toContain('oma-swarm-glow');
    const fx2Msg = host.tspMessages.filter(m => m.verb === 's' && m.body['name'] === 'oma-swarm-fx').pop();
    expect(typeof fx2Msg?.body['css']).toBe('string');
    expect(String(fx2Msg?.body['css'])).toContain('oma.swarm.bee-2');
    expect(String(fx2Msg?.body['css'])).not.toContain('oma.swarm.bee-3');
    expect(String(fx2Msg?.body['css'])).not.toContain('oma-swarm-glow');
    current = replayCurrentWireNodes();
    expect(current.has('dock.composer.swarm-fx')).toBe(true);
    expect(current.has('dock.composer.swarm-fx.bee-1')).toBe(true);
    expect(current.has('dock.composer.swarm-fx.bee-2')).toBe(true);
    expect(current.has('dock.composer.swarm-fx.bee-3')).toBe(false);
    expect(current.has('dock.hud.running.agents.bee')).toBe(true);
    expect(current.get('dock.hud.running.agents.bee')?.p['role']).toBe('oma.bee.hud');
    expect(current.has('dock.composer.bar.stop')).toBe(true);
    expect(current.has('dock.composer.bar.send')).toBe(false);
    expect(JSON.stringify(current.get(EDITOR_NODE_ID)?.p['placeholder'])).toContain('Swarm running');
    expect(JSON.stringify(current.get(EDITOR_NODE_ID)?.p['placeholder'])).toContain('worker-bee');

    // Adding more active swarm members dynamically increases orbiting bee count (2 -> 5)!
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Live Bee Swarm',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', applied_model: 'gemini-4-neon', killed: false },
          'worker-bee': { role: 'worker', phase: 'RUNNING', wake_mode: 'working', applied_model: 'gemini-4-neon', killed: false },
          'worker-2': { role: 'worker', phase: 'RUNNING', wake_mode: 'working', applied_model: 'gemini-4-neon', killed: false },
          'worker-3': { role: 'worker', phase: 'RUNNING', wake_mode: 'working', applied_model: 'gemini-4-neon', killed: false },
          monitor: { role: 'worker', phase: 'RUNNING', wake_mode: 'anything', applied_model: 'gemini-4-neon', killed: false },
          retired: { role: 'worker', phase: 'KILLED', killed: true, applied_model: 'gemini-4-neon' },
        },
      }),
      'utf8'
    );
    await waitFor(() => controller.store.getState().swarmSnapshot?.counts.activeMembers === 5);
    current = replayCurrentWireNodes();
    expect(current.has('dock.composer.swarm-fx.bee-5')).toBe(true);
    expect(current.has('dock.composer.swarm-fx.bee-6')).toBe(false);
    const fx5Msg = host.tspMessages.filter(m => m.verb === 's' && m.body['name'] === 'oma-swarm-fx').pop();
    expect(String(fx5Msg?.body['css'])).toContain('oma.swarm.bee-5');
    expect(String(fx5Msg?.body['css'])).not.toContain('oma.swarm.bee-6');

    // Steering during active swarm (`!isStreaming && isSwarmWorking`): typing switches Stop -> Send & Enter succeeds!
    host.input.emit('Add extra unit test');
    await waitFor(() => controller.store.draft.text === 'Add extra unit test');
    current = replayCurrentWireNodes();
    expect(current.has('dock.composer.bar.send')).toBe(true);
    expect(current.has('dock.composer.bar.stop')).toBe(false);

    host.input.emit('\r');
    await waitFor(() => promptCount === 3 && !controller.store.getState().isStreaming);
    expect(receivedPrompts[2]).toBe('Add extra unit test');

    // Because swarm is STILL working after Turn 3 ended, OSC 7501 MUST NOT emit `state=done` yet & empty draft returns to Stop!
    expect(host.osc7501.slice(oscLenBeforeSwarm)).not.toContain('state=done');
    current = replayCurrentWireNodes();
    expect(current.has('dock.composer.bar.stop')).toBe(true);
    expect(current.has('dock.composer.bar.send')).toBe(false);

    // Clicking Stop / pressing Esc during background swarm sends `session/cancel`
    host.input.emit('\x1b');
    await waitFor(() => cancelCount >= 1);

    // When all swarm workers transition to `waiting` + post `[done]` (and workers retired leaving 2 active members):
    // - Swarm workers finishing on their own MUST NOT emit a spurious OSC 7501 `state=done`
    //   before the coordinator emits a user-facing reply (avoids false finish notifications on
    //   worker pauses, subtask handoffs, or monitor checks!)
    // - bottom button switches back to Send!
    // - because session is STILL in swarm mode (`hasSwarm`), perimeter bee animation STAYS visible with 2 idle bees!
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Live Bee Swarm',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', applied_model: 'gemini-4-neon', killed: false },
          monitor: { role: 'worker', phase: 'RUNNING', wake_mode: 'anything', applied_model: 'gemini-4-neon', killed: false },
          'worker-bee': { role: 'worker', phase: 'KILLED', killed: true, applied_model: 'gemini-4-neon' },
        },
      }),
      'utf8'
    );
    appendFileSync(
      join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 2, agent: 'worker-bee', text: '@coordinator [done] All finished!', time: '2026-11-21 01:02:00' })}\n`,
      'utf8'
    );

    await waitFor(() => controller.store.isSwarmWorking === false);
    await Bun.sleep(60);
    expect(host.osc7501.slice(oscLenBeforeSwarm)).not.toContain('state=done');

    // Once the coordinator actually posts its user-facing final reply via ACP, OSC 7501 `state=done` fires cleanly
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'All swarm tasks finished and verified!' },
        },
      },
    });
    await waitFor(() => host.osc7501.slice(oscLenBeforeSwarm).includes('state=done'));

    current = replayCurrentWireNodes();
    // Swarm mode stays active visually with 2 idle orbiting bees (coordinator + monitor)
    expect(current.has('dock.composer.swarm-fx')).toBe(true);
    expect(current.has('dock.composer.swarm-fx.bee-1')).toBe(true);
    expect(current.has('dock.composer.swarm-fx.bee-2')).toBe(true);
    expect(current.has('dock.composer.swarm-fx.bee-3')).toBe(false);
    expect(current.has('dock.composer.bar.send')).toBe(true);
    expect(current.has('dock.composer.bar.stop')).toBe(false);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
    expect(controller.isSwarmWatcherActive).toBe(false);
  });

  test('bottom status bar telemetry: mode semantic colors & click cycle, git branch/dirty/ahead-behind & non-git hide, live->calibrated TPS, cumulative tokens & cache hit + /context click, NO cache countdown, /new clear', async () => {
    const tmp = makeTempDir();
    const brainRoot = join(tmp, 'brain');
    const resumedSessionId = 'sess-bar-resumed';
    const freshSessionId = 'sess-bar-fresh';

    // Pre-populate historical agy transcript.jsonl for the resumed session:
    // Total input = 150,000 + 850,000 = 1,000,000 (cache hit = 85%), output = 10,000
    const resumedLogsDir = join(brainRoot, resumedSessionId, '.system_generated', 'logs');
    mkdirSync(resumedLogsDir, { recursive: true });
    const resumedTranscriptPath = join(resumedLogsDir, 'transcript.jsonl');
    writeFileSync(
      resumedTranscriptPath,
      [
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          input_tokens: 100_000,
          cache_read_tokens: 400_000,
          output_tokens: 4_000,
        }),
        JSON.stringify({
          type: 'PLANNER_RESPONSE',
          input_tokens: 50_000,
          cache_read_tokens: 450_000,
          output_tokens: 6_000,
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const host = new FakeTernHost({
      features: ['blobs', 'styles', 'settle', 'dock', 'scroll', 'font', 'aside'],
    });
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let clock = 500_000;
    let currentMode = 'default';
    let gitIsRepo = true;
    const releasePromptEnd = Promise.withResolvers<void>();

    const mockGitExec: GitExecFn = async () => {
      if (!gitIsRepo) {
        return { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' };
      }
      return {
        exitCode: 0,
        stdout: [
          '# branch.oid 1234567890abcdef',
          '# branch.head feat/status-bar',
          '# branch.upstream origin/feat/status-bar',
          '# branch.ab +2 -1',
          '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
          '1 .M N... 100644 100644 100644 aaa bbb src/b.ts',
          '? untracked.txt',
        ].join('\n'),
      };
    };

    const makeConfigWithMode = (modeVal: string) =>
      DEFAULT_CONFIG_OPTIONS.map(opt =>
        opt.id === 'mode' ? { ...opt, currentValue: modeVal } : opt
      );

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/load') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: resumedSessionId,
            configOptions: makeConfigWithMode(currentMode),
          },
        });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: freshSessionId,
            configOptions: makeConfigWithMode('default'),
          },
        });
      } else if (msg.method === 'session/set_config_option') {
        const configId = String(msg.params?.['configId'] ?? '');
        const value = String(msg.params?.['value'] ?? '');
        if (configId === 'mode') {
          currentMode = value;
        }
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { configOptions: makeConfigWithMode(currentMode) },
        });
      } else if (msg.method === 'session/prompt') {
        const sid = String(msg.params?.['sessionId'] ?? resumedSessionId);
        // Emit streamed chunks across clock ticks so sliding-window live TPS activates
        queueMicrotask(() => {
          clock += 200;
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'Analyzing telemetry bar layout carefully... ' },
              },
            },
          });
          clock += 300;
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: 'Here is a detailed streaming answer with enough tokens to drive live TPS display.',
                },
              },
            },
          });
        });

        void releasePromptEnd.promise.then(() => {
          // Total turn duration = 2000ms (200 + 300 + 1500)
          clock += 1500;
          // Append authoritative PLANNER_RESPONSE: +50k uncached, +150k cache read, +500 output -> 500 / 2.0s = 250/s
          appendFileSync(
            resumedTranscriptPath,
            `${JSON.stringify({
              type: 'PLANNER_RESPONSE',
              input_tokens: 50_000,
              cache_read_tokens: 150_000,
              output_tokens: 500,
            })}\n`,
            'utf8'
          );
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: { sessionUpdate: 'usage_update', used: 200_000, size: 1_000_000 },
            },
          });
          h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        if (msg.params?.['sessionId'] === freshSessionId) {
          h.crash(0);
        }
      }
    });

    const replayCurrentWireNodes = (): Map<string, { k: string; p: Record<string, unknown> }> => {
      const nodes = new Map<string, { k: string; p: Record<string, unknown> }>();
      const addSubtree = (n: WireNode): void => {
        nodes.set(n.id, { k: n.k, p: { ...(n.p ?? {}) } });
        if (n.c) {
          for (const child of n.c) addSubtree(child);
        }
      };
      const deleteSubtree = (id: string): void => {
        nodes.delete(id);
        const prefix = `${id}.`;
        for (const key of [...nodes.keys()]) {
          if (key.startsWith(prefix)) nodes.delete(key);
        }
      };
      for (const op of host.allOps) {
        if (op[0] === 'add') {
          addSubtree(op[4]);
        } else if (op[0] === 'del') {
          deleteSubtree(op[1]);
        } else if (op[0] === 'set') {
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
    };

    const controller = new AppController({
      cli: parseCliArgs(['--resume', resumedSessionId]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      baseBrainDir: brainRoot,
      gitExec: mockGitExec,
      installSignals: false,
      throttleMs: 5,
      now: () => clock,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // 1. Resumed session immediately loads historical tokens + cache hit rate + git branch status
    await waitFor(
      () =>
        controller.store.getState().sessionMetrics?.totalInputTokens === 1_000_000 &&
        controller.store.getState().gitStatus?.branch === 'feat/status-bar'
    );
    await waitFor(() => {
      const nodes = replayCurrentWireNodes();
      return (
        nodes.has('dock.composer.bar.extras.tokens') &&
        nodes.has('dock.composer.bar.extras.git')
      );
    });

    let current = replayCurrentWireNodes();

    // 1a. Mode segment starts as `default` -> muted + shield
    const modeSegDefault = current.get('dock.composer.bar.extras.mode');
    expect(modeSegDefault?.p['icon']).toBe('shield');
    expect(modeSegDefault?.p['priority']).toBe(10);
    expect(modeSegDefault?.p['spans']).toEqual([{ t: 'Default', s: 'muted' }]);

    // 1b. Git segment shows branch + dirty `*` + ahead/behind + hovercard
    const gitSeg = current.get('dock.composer.bar.extras.git');
    expect(gitSeg?.p['icon']).toBe('git-branch');
    expect(gitSeg?.p['priority']).toBe(3);
    expect(gitSeg?.p['min']).toEqual({ w: '10ch' });
    expect(gitSeg?.p['spans']).toEqual([
      { t: 'feat/status-bar', s: 'muted' },
      { t: '*', s: 'warning' },
      { t: ' ↑2', s: 'info' },
      { t: ' ↓1', s: 'warning' },
    ]);
    expect(gitSeg?.p['hovercard']).toBeDefined();
    expect(String(gitSeg?.p['title'] ?? '')).toContain('feat/status-bar');

    // 1c. Tokens segment shows `↑1M(85%) ↓10k` on right side with hovercard (no `num` token overriding semantic colors)
    const tokensSeg = current.get('dock.composer.bar.extras.tokens');
    expect(tokensSeg?.p['side']).toBe('right');
    expect(tokensSeg?.p['priority']).toBe(7);
    expect(tokensSeg?.p['icon']).toBe('tokens');
    expect(tokensSeg?.p['spans']).toEqual([
      { t: '↑1M', s: 'info' },
      { t: '(85%)', s: 'success' },
      { t: ' ↓10k', s: 'warning' },
    ]);
    expect(tokensSeg?.p['hovercard']).toBeDefined();

    // 1d. Explicitly verify NO 5-minute cache countdown segment exists
    const extrasChildren = [...current.keys()].filter(id =>
      id.startsWith('dock.composer.bar.extras.')
    );
    expect(
      extrasChildren.some(id => /cache|ttl|countdown/i.test(id))
    ).toBe(false);

    // 2. Click `mode` segment to cycle through accept-edits (warning) -> auto (success) -> plan (info + plan icon)
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'dock.composer.bar.extras.mode',
      act: 'mode.cycle',
    });
    await waitFor(() => controller.store.getState().controls.currentModeId === 'accept-edits');
    current = replayCurrentWireNodes();
    expect(current.get('dock.composer.bar.extras.mode')?.p['icon']).toBe('shield');
    expect(current.get('dock.composer.bar.extras.mode')?.p['spans']).toEqual([
      { t: 'Accept Edits', s: 'warning' },
    ]);

    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'dock.composer.bar.extras.mode',
      act: 'mode.cycle',
    });
    await waitFor(() => controller.store.getState().controls.currentModeId === 'auto');
    current = replayCurrentWireNodes();
    expect(current.get('dock.composer.bar.extras.mode')?.p['icon']).toBe('shield');
    expect(current.get('dock.composer.bar.extras.mode')?.p['spans']).toEqual([
      { t: 'Auto', s: 'success' },
    ]);

    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'dock.composer.bar.extras.mode',
      act: 'mode.cycle',
    });
    await waitFor(() => controller.store.getState().controls.currentModeId === 'plan');
    current = replayCurrentWireNodes();
    expect(current.get('dock.composer.bar.extras.mode')?.p['icon']).toBe('plan');
    expect(current.get('dock.composer.bar.extras.mode')?.p['spans']).toEqual([
      { t: 'Plan', s: 'info' },
    ]);

    // 3. Click `tokens` segment -> opens `/context` info overlay, then Esc closes it
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'dock.composer.bar.extras.tokens',
      act: 'status.context',
    });
    await waitFor(() => controller.store.getState().infoOverlay?.kind === 'context');
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().infoOverlay === null);

    // 4. Streaming turn: live TPS lights up (`info`), then after end_turn calibrates from transcript (`250 tok/s`) & dims (`muted`), and tokens increment!
    await controller.submitInput('Show live TPS and calibrate');
    await waitFor(
      () =>
        controller.store.getState().sessionMetrics?.isStreamingTps === true &&
        (controller.store.getState().sessionMetrics?.currentTps ?? 0) > 0
    );
    await waitFor(() => {
      const tps = replayCurrentWireNodes().get('dock.composer.bar.extras.tps');
      return Boolean(tps && tps.p['tone'] === 'info');
    });
    current = replayCurrentWireNodes();
    const liveTpsSeg = current.get('dock.composer.bar.extras.tps');
    expect(liveTpsSeg?.p['side']).toBe('right');
    expect(liveTpsSeg?.p['priority']).toBe(5);
    expect(liveTpsSeg?.p['icon']).toBe('bolt');
    expect(liveTpsSeg?.p['tone']).toBe('info');
    expect(JSON.stringify(liveTpsSeg?.p['spans'])).toContain('"s":"info"');
    expect(JSON.stringify(liveTpsSeg?.p['spans'])).toContain(' tok/s');

    // Switch git mock to non-git before turn finishes (after >1500ms clock advance inside prompt) to verify non-git auto-hides
    gitIsRepo = false;
    releasePromptEnd.resolve();

    await waitFor(
      () =>
        !controller.store.getState().isStreaming &&
        controller.store.getState().sessionMetrics?.totalInputTokens === 1_200_000 &&
        controller.store.getState().sessionMetrics?.isStreamingTps === false &&
        controller.store.getState().gitStatus === null
    );
    await waitFor(() => {
      const nodes = replayCurrentWireNodes();
      const tps = nodes.get('dock.composer.bar.extras.tps');
      const tok = nodes.get('dock.composer.bar.extras.tokens');
      return (
        !nodes.has('dock.composer.bar.extras.git') &&
        tps?.p['tone'] === 'muted' &&
        JSON.stringify(tps?.p['spans'] ?? '').includes('250 tok/s') &&
        JSON.stringify(tok?.p['spans'] ?? '').includes('↑1.2M')
      );
    });
    current = replayCurrentWireNodes();
    expect(current.has('dock.composer.bar.extras.git')).toBe(false);
    expect(current.get('dock.composer.bar.extras.tps')?.p['spans']).toEqual([
      { t: '250 tok/s', s: 'muted' },
    ]);
    expect(current.get('dock.composer.bar.extras.tokens')?.p['spans']).toEqual([
      { t: '↑1.2M', s: 'info' },
      { t: '(83%)', s: 'success' },
      { t: ' ↓10.5k', s: 'warning' },
    ]);

    // Still zero cache countdown segments anywhere in extras
    const postTurnExtras = [...current.keys()].filter(id =>
      id.startsWith('dock.composer.bar.extras.')
    );
    expect(postTurnExtras.some(id => /cache|ttl|countdown/i.test(id))).toBe(false);

    // 5. `/new` clears sessionMetrics and hides `tps` & `tokens` segments
    await controller.submitInput('/new');
    await waitFor(() => controller.store.getState().sessionId === freshSessionId);
    expect(controller.store.getState().sessionMetrics).toBeNull();
    await waitFor(() => {
      const nodes = replayCurrentWireNodes();
      return (
        !nodes.has('dock.composer.bar.extras.tps') &&
        !nodes.has('dock.composer.bar.extras.tokens')
      );
    });

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('OSC 7501 state=done timing regression (#112): renderNow/settle precedes done, coordinator summarizing defers done, and late quiet-window chunks reset debounce', async () => {
    const tmp = makeTempDir();
    const brainRoot = join(tmp, 'brain');
    const sessionId = 'sess-done-timing';
    const swarmDir = join(brainRoot, sessionId, '.system_generated', 'swarm');

    const host = new FakeTernHost({
      features: ['blobs', 'styles', 'settle', 'dock', 'scroll', 'font', 'aside'],
    });
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId, configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Synchronous final answer text.' },
            },
          },
        });
        h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      baseBrainDir: brainRoot,
      swarmPollIntervalMs: 25,
      backgroundDoneGraceMs: 80,
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // --- Case 1: Synchronous turn renders & settles final reply BEFORE emitting OSC 7501 state=done ---
    const streamBeforeTurn = host.rawStream.length;
    await controller.submitInput('Reply synchronously');
    await waitFor(() => host.rawStream.slice(streamBeforeTurn).includes('state=done'));

    const turnStream = host.rawStream.slice(streamBeforeTurn);
    const replyIdx = turnStream.indexOf('Synchronous final answer text.');
    const settleIdx = turnStream.indexOf('["settle","main.t0-');
    const doneIdx = turnStream.indexOf('\x1b]7501;state=done');
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    expect(settleIdx).toBeGreaterThan(replyIdx);
    expect(doneIdx).toBeGreaterThan(settleIdx);

    // --- Case 2: Last swarm worker turns waiting while coordinator is still working -> MUST NOT emit state=done prematurely ---
    const oscLenBeforeSwarm = host.osc7501.length;
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      join(swarmDir, 'swarm.json'),
      JSON.stringify({ version: 1, backend: 'local', swarm_id: sessionId, created_at: '2026-11-22T00:00:00Z' }),
      'utf8'
    );
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Timing Swarm',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', applied_model: 'gemini-4-neon', killed: false },
          worker: { role: 'worker', phase: 'RUNNING', applied_model: 'gemini-4-neon', killed: false },
        },
      }),
      'utf8'
    );
    writeFileSync(
      join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 1, agent: 'coordinator', text: '@worker Go', time: '2026-11-22 00:00:01' })}\n`,
      'utf8'
    );
    await waitFor(() => controller.store.isSwarmWorking === true);

    // Worker finishes (waiting), coordinator wakes up to synthesize summary (`working`, no wake_mode)
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Timing Swarm',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', applied_model: 'gemini-4-neon', killed: false },
          worker: { role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', applied_model: 'gemini-4-neon', killed: false },
        },
      }),
      'utf8'
    );
    await waitFor(
      () =>
        controller.store.isSwarmWorking === false &&
        controller.store.getState().swarmSnapshot?.memberByName['coordinator']?.status === 'working'
    );

    // Wait longer than backgroundDoneGraceMs (80ms) while coordinator is still working -> still NO state=done!
    await Bun.sleep(140);
    expect(host.osc7501.slice(oscLenBeforeSwarm)).not.toContain('state=done');

    // Now coordinator transitions to waiting WITHOUT having sent any user-facing reply ->
    // MUST NOT emit spurious state=done (e.g. worker pause / monitor wake-sleep cycle)
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Timing Swarm',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', applied_model: 'gemini-4-neon', killed: false },
          worker: { role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', applied_model: 'gemini-4-neon', killed: false },
        },
      }),
      'utf8'
    );
    await waitFor(
      () => controller.store.getState().swarmSnapshot?.memberByName['coordinator']?.status === 'waiting'
    );
    await Bun.sleep(140);
    expect(host.osc7501.slice(oscLenBeforeSwarm)).not.toContain('state=done');

    // --- Case 3: Coordinator emits user-facing summary via ACP after workers finish -> renders BEFORE state=done ---
    const oscLenBeforeLate = host.osc7501.length;
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Timing Swarm',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', applied_model: 'gemini-4-neon', killed: false },
          worker: { role: 'worker', phase: 'RUNNING', applied_model: 'gemini-4-neon', killed: false },
        },
      }),
      'utf8'
    );
    await waitFor(() => controller.store.isSwarmWorking === true);

    // All members go waiting (worker finished its subtask) -> still NO premature state=done!
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Timing Swarm',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', applied_model: 'gemini-4-neon', killed: false },
          worker: { role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', applied_model: 'gemini-4-neon', killed: false },
        },
      }),
      'utf8'
    );
    await waitFor(() => controller.store.isSwarmWorking === false);

    // Wait longer than backgroundDoneGraceMs -> still NO state=done until coordinator actually replies
    await Bun.sleep(120);
    expect(host.osc7501.slice(oscLenBeforeLate)).not.toContain('state=done');

    // Coordinator wakes up and emits user-facing summary via ACP -> debounce waits then fires state=done STRICTLY AFTER render
    const streamBeforeLateChunk = host.rawStream.length;
    acp.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Late coordinator summary rendered first!' },
        },
      },
    });

    await Bun.sleep(40);
    expect(host.osc7501.slice(oscLenBeforeLate)).not.toContain('state=done');

    // Once quiet window after chunk completes, state=done fires STRICTLY AFTER the late summary is rendered
    await waitFor(() => host.osc7501.slice(oscLenBeforeLate).includes('state=done'));
    const lateStream = host.rawStream.slice(streamBeforeLateChunk);
    const lateTextIdx = lateStream.indexOf('Late coordinator summary rendered first!');
    const lateDoneIdx = lateStream.indexOf('\x1b]7501;state=done');
    expect(lateTextIdx).toBeGreaterThanOrEqual(0);
    expect(lateDoneIdx).toBeGreaterThan(lateTextIdx);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('clicking bottom git status segment (status.git) and /git open omp.app.git fullscreen UI with diff, stage/unstage, commit, and clean HEAD view', async () => {
    const tmp = makeTempDir();
    const repoDir = join(tmp, 'repo');
    mkdirSync(join(repoDir, 'src'), { recursive: true });

    const runGit = (args: string[]) => {
      const res = Bun.spawnSync(['git', ...args], {
        cwd: repoDir,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      if (res.exitCode !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${res.stderr.toString('utf8')}`);
      }
      return res.stdout.toString('utf8');
    };

    runGit(['init', '-b', 'main']);
    runGit(['config', 'user.name', 'OMA Tester']);
    runGit(['config', 'user.email', 'tester@oma.local']);
    writeFileSync(join(repoDir, 'src', 'hello.ts'), 'export const greeting = "hello";\n', 'utf8');
    runGit(['add', '.']);
    runGit(['commit', '-m', 'Initial commit']);

    // Modify tracked file so working tree is dirty
    writeFileSync(
      join(repoDir, 'src', 'hello.ts'),
      'export const greeting = "hello world";\nexport const version = 2;\n',
      'utf8'
    );

    const host = new FakeTernHost({
      features: ['blobs', 'styles', 'settle', 'dock', 'scroll', 'font', 'aside'],
    });
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();
    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-git-ui', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: repoDir,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      baseBrainDir: join(tmp, 'brain'),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    const replayNodes = (): Map<string, { p: Record<string, unknown> }> => {
      const nodes = new Map<string, { p: Record<string, unknown> }>();
      const addSubtree = (node: WireNode): void => {
        nodes.set(node.id, { p: { ...(node.p ?? {}) } });
        if (Array.isArray(node.c)) {
          for (const child of node.c) {
            addSubtree(child);
          }
        }
      };
      const deleteSubtree = (id: string): void => {
        nodes.delete(id);
        const prefix = `${id}.`;
        for (const key of [...nodes.keys()]) {
          if (key.startsWith(prefix)) nodes.delete(key);
        }
      };
      for (const op of host.allOps) {
        if (op[0] === 'add') {
          addSubtree(op[4]);
        } else if (op[0] === 'del') {
          deleteSubtree(op[1]);
        } else if (op[0] === 'set') {
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
    };

    const findDiffNode = (
      nodes: Map<string, { p: Record<string, unknown> }>
    ): { p: Record<string, unknown> } | undefined => {
      for (const [id, node] of nodes) {
        if (id.startsWith('layer.git.app.main.diff-')) return node;
      }
      return undefined;
    };

    // 1. Bottom composer git segment is rendered with clickable `status.git` action
    await waitFor(() => {
      const gitSeg = replayNodes().get('dock.composer.bar.extras.git');
      const spansJson = JSON.stringify(gitSeg?.p?.['spans'] ?? '');
      return Boolean(gitSeg && spansJson.includes('"main"') && spansJson.includes('"*"'));
    });
    const gitSeg = replayNodes().get('dock.composer.bar.extras.git');
    expect(gitSeg?.p?.['actions']).toEqual({ click: 'status.git' });

    // 2. Clicking bottom git segment opens fullscreen `omp.app.git` overlay
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'dock.composer.bar.extras.git',
      act: 'status.git',
    });
    await waitFor(() => {
      const g = controller.store.getState().gitOverlay;
      return Boolean(
        g &&
          !g.loading &&
          g.snapshot?.branch === 'main' &&
          g.snapshot.unstaged.length === 1 &&
          g.diff &&
          !g.diffLoading
      );
    });

    await waitFor(() => {
      const nodes = replayNodes();
      return nodes.has('layer.git') && Boolean(findDiffNode(nodes));
    });
    let nodes = replayNodes();
    expect(nodes.get('layer.git')?.p?.['size']).toBe('full');
    expect(nodes.get('layer.git')?.p?.['role']).toBe('oma.overlay.git');
    expect(nodes.get('layer.git.app')?.p?.['role']).toBe('omp.app.git');
    const diffNode = findDiffNode(nodes);
    expect(diffNode?.p?.['role']).toBe('omp.app.git.diff');
    expect(diffNode?.p?.['mode']).toBe('split');
    expect(String(diffNode?.p?.['text'] ?? '')).toContain('hello world');

    // 3. View mode switching (`inline`, `split`) and sidebar style (`tree`)
    host.input.emitTspEvent({
      ev: 'select',
      sf: 'oma',
      id: 'layer.git.app.main.bar.tools.views',
      item: 'inline',
    });
    await waitFor(() => findDiffNode(replayNodes())?.p?.['mode'] === 'unified');

    host.input.emitTspEvent({
      ev: 'select',
      sf: 'oma',
      id: 'layer.git.app.side.head.style',
      item: 'tree',
    });
    await waitFor(() => controller.store.getState().gitOverlay?.sidebarStyle === 'tree');

    // 4. Stage file via `s` hotkey, commit via Commit form, and verify Clean Tree HEAD commit view
    host.input.emit('s');
    await waitFor(
      () =>
        controller.store.getState().gitOverlay?.snapshot?.staged.length === 1 &&
        controller.store.getState().gitOverlay?.snapshot?.unstaged.length === 0
    );

    controller.store.setGitCommitSummary('feat: update greeting');
    await waitFor(
      () =>
        replayNodes().get('layer.git.app.side.commit.foot.commit-btn')?.p?.['disabled'] === false
    );
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: 'layer.git.app.side.commit.foot.commit-btn',
      act: 'git.commit',
    });
    await waitFor(() => {
      const g = controller.store.getState().gitOverlay;
      return Boolean(
        g &&
          !g.busy &&
          g.snapshot?.clean === true &&
          g.snapshot.headCommit?.subject === 'feat: update greeting'
      );
    });
    await waitFor(() => replayNodes().has('layer.git.app.side.head'));
    nodes = replayNodes();
    expect(nodes.get('layer.git.app.side.head')?.p?.['role']).toBe('omp.app.git.commit-info');
    expect(controller.store.getState().gitStatus?.isDirty).toBe(false);

    // 5. Esc closes Git overlay and restores composer editor focus
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().gitOverlay === null);
    expect(controller.store.getDesiredSurfaceFocus()).toBe(EDITOR_NODE_ID);

    // 6. `/git` slash command opens the same Git overlay and `q` closes it
    await controller.submitInput('/git');
    await waitFor(() => {
      const g = controller.store.getState().gitOverlay;
      return Boolean(g && !g.loading && g.snapshot?.headCommit?.subject === 'feat: update greeting');
    });
    host.input.emit('q');
    await waitFor(() => controller.store.getState().gitOverlay === null);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('elicitation/create (ask_question): advertises clientCapabilities.elicitation.form, pairs qN + qN_other into Other inputs, supports back/next/skip/arrows/custom write-in', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost({
      features: ['blobs', 'styles', 'settle', 'dock', 'scroll', 'font', 'aside'],
    });
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let initClientCaps: Record<string, unknown> | undefined;
    let promptCount = 0;
    let activePromptId: string | number | undefined;
    const elicitationReplies: RpcEnvelope[] = [];

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        initClientCaps = msg.params?.['clientCapabilities'] as Record<string, unknown> | undefined;
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-ask-q', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        promptCount += 1;
        activePromptId = msg.id;
        if (promptCount === 1) {
          h.send({
            jsonrpc: '2.0',
            id: 'elic-multi-1',
            method: 'elicitation/create',
            params: {
              sessionId: 'sess-ask-q',
              mode: 'form',
              message: 'Clarify deployment choices',
              requestedSchema: {
                type: 'object',
                properties: {
                  q1: {
                    type: 'string',
                    title: 'Repository visibility?',
                    oneOf: [
                      { const: 'public', title: 'Public' },
                      { const: 'private', title: 'Private' },
                    ],
                  },
                  q1_other: {
                    type: 'string',
                    title: 'Other visibility notes',
                  },
                  q2: {
                    type: 'array',
                    title: 'Features to include?',
                    items: {
                      type: 'string',
                      oneOf: [
                        { const: 'installer', title: 'Install script' },
                        { const: 'updater', title: 'Self updater' },
                      ],
                    },
                  },
                  q2_other: {
                    type: 'string',
                    description: 'Extra feature',
                  },
                },
                required: ['q1'],
              },
            },
          });
        } else {
          h.send({
            jsonrpc: '2.0',
            id: 'elic-other-2',
            method: 'elicitation/create',
            params: {
              sessionId: 'sess-ask-q',
              mode: 'form',
              requestedSchema: {
                type: 'object',
                properties: {
                  q1: {
                    type: 'string',
                    title: 'Pick target',
                    enum: ['win', 'linux'],
                  },
                  q1_other: {
                    type: 'string',
                    description: 'Custom target',
                  },
                },
              },
            },
          });
        }
      } else if ((msg.id === 'elic-multi-1' || msg.id === 'elic-other-2') && msg.result) {
        elicitationReplies.push(msg);
        h.send({ jsonrpc: '2.0', id: activePromptId, result: { stopReason: 'end_turn' } });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      baseBrainDir: join(tmp, 'brain'),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // 1. Verify initialize handshake explicitly advertises elicitation form & url capabilities
    expect(initClientCaps).toEqual({
      elicitation: { form: {}, url: {} },
    });

    // 2. Round 1: q1 + q1_other and q2 + q2_other merge into 2 questions (not 4) with Other inputs
    void controller.submitInput('ask two paired questions');
    await waitFor(() => controller.store.getState().activeQuestion !== null);

    const card = controller.store.getState().activeQuestion!;
    expect(card.items.length).toBe(2);
    expect(card.items[0]?.id).toBe('q1');
    expect(card.items[0]?.writeInFieldId).toBe('q1_other');
    expect(card.items[0]?.other).toBeTruthy();
    expect(card.items[1]?.id).toBe('q2');
    expect(card.items[1]?.writeInFieldId).toBe('q2_other');
    expect(card.items[1]?.multi).toBe(true);
    expect(card.items[1]?.other).toBeTruthy();

    expect(host.findWireNodes(n => n.id === 'main.questions.q1.other').length).toBeGreaterThan(0);
    expect(host.findWireNodes(n => n.id === 'main.questions.q2.other').length).toBeGreaterThan(0);

    // ArrowDown selects first choice ('public'), ArrowDown again selects 'private', ArrowUp returns to 'public'
    host.input.emit('\x1b[B');
    await waitFor(() => controller.store.getState().activeQuestion?.answers['q1'] === 'public');
    host.input.emit('\x1b[B');
    await waitFor(() => controller.store.getState().activeQuestion?.answers['q1'] === 'private');
    host.input.emit('\x1b[A');
    await waitFor(() => controller.store.getState().activeQuestion?.answers['q1'] === 'public');

    // Step forward via Tern `next` action and test `back` -> `next`
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: 'main.questions', act: 'next' });
    await waitFor(() => controller.store.getState().activeQuestion?.step === 1);
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: 'main.questions', act: 'back' });
    await waitFor(() => controller.store.getState().activeQuestion?.step === 0);
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: 'main.questions', act: 'next' });
    await waitFor(() => controller.store.getState().activeQuestion?.step === 1);

    // Multi-select: press '1' for 'installer', then '3' (N+1) to focus q2.other and type 'homebrew'
    host.input.emit('1');
    await waitFor(() =>
      JSON.stringify(controller.store.getState().activeQuestion?.answers['q2']) ===
      JSON.stringify(['installer'])
    );
    host.input.emit('3');
    await waitFor(() => controller.currentSurfaceFocus === 'main.questions.q2.other');
    host.input.emit('homebrew\r');

    await waitFor(() => elicitationReplies.length === 1);
    expect(elicitationReplies[0]!.result).toEqual({
      action: 'accept',
      content: {
        q1: 'public',
        q2: ['installer'],
        q2_other: 'homebrew',
      },
    });
    await waitFor(() => !controller.store.getState().isBusy);

    // 3. Round 2: Single-select answered via Other write-in writes ONLY `q1_other` (never invalid enum value in `q1`)
    void controller.submitInput('ask single question with other');
    await waitFor(() => controller.store.getState().activeQuestion !== null);
    host.input.emit('3'); // N+1 focuses q1.other
    await waitFor(() => controller.currentSurfaceFocus === 'main.questions.q1.other');
    host.input.emit('macos-arm64\r');

    await waitFor(() => elicitationReplies.length === 2);
    expect(elicitationReplies[1]!.result).toEqual({
      action: 'accept',
      content: {
        q1_other: 'macos-arm64',
      },
    });
    await waitFor(() => !controller.store.getState().isStreaming);
    expect(controller.currentSurfaceFocus).toBe(EDITOR_NODE_ID);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('Tool Call Display modes (all / compact / hidden) via Alt+O & /settings: groups routine tools, hides completed tools while keeping running & ask tools visible, and persists to config.toml', async () => {
    const tmp = makeTempDir();
    const configPath = join(tmp, 'config.toml');
    const host = new FakeTernHost({
      features: ['blobs', 'styles', 'settle', 'dock', 'scroll', 'font', 'aside'],
    });
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let turnCounter = 0;
    const releaseRunningTurn = Promise.withResolvers<void>();

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-tool-display', configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        turnCounter += 1;
        if (turnCounter === 1) {
          // Turn 1: 3 completed routine tools (2 bash + 1 read) + final answer
          const tools = [
            { id: 'tc-bash-1', name: 'run_command', kind: 'execute', title: 'python -c "print(1)"' },
            { id: 'tc-bash-2', name: 'run_command', kind: 'execute', title: 'python -c "print(2)"' },
            { id: 'tc-read-1', name: 'read_file', kind: 'read', title: 'README.md' },
          ];
          for (const t of tools) {
            h.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sess-tool-display',
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: t.id,
                  name: t.name,
                  kind: t.kind,
                  title: t.title,
                  status: 'in_progress',
                },
              },
            });
            h.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sess-tool-display',
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: t.id,
                  status: 'completed',
                  rawOutput: { output: 'ok', exit_code: 0 },
                },
              },
            });
          }
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-tool-display',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'All checks finished.' },
              },
            },
          });
          h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        } else {
          // Turn 2: an actively running bash tool to verify `hidden` keeps running tools visible
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-tool-display',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-live-bash',
                name: 'run_command',
                kind: 'execute',
                title: 'sleep 10',
                status: 'in_progress',
              },
            },
          });
          void releaseRunningTurn.promise.then(() => {
            h.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sess-tool-display',
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'tc-live-bash',
                  status: 'completed',
                  rawOutput: { output: 'done', exit_code: 0 },
                },
              },
            });
            h.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sess-tool-display',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Second turn done.' },
                },
              },
            });
            h.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          });
        }
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      configPath,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      baseBrainDir: join(tmp, 'brain'),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    const replayNodes = (): Map<string, { k: string; p: Record<string, unknown> }> => {
      const nodes = new Map<string, { k: string; p: Record<string, unknown> }>();
      const addSubtree = (node: WireNode): void => {
        nodes.set(node.id, { k: node.k, p: { ...(node.p ?? {}) } });
        if (Array.isArray(node.c)) {
          for (const child of node.c) addSubtree(child);
        }
      };
      const delSubtree = (id: string): void => {
        nodes.delete(id);
        const prefix = `${id}.`;
        for (const key of [...nodes.keys()]) {
          if (key.startsWith(prefix)) nodes.delete(key);
        }
      };
      for (const op of host.allOps) {
        if (op[0] === 'add') addSubtree(op[4]);
        else if (op[0] === 'del') delSubtree(op[1]);
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
    };

    const hasNodeSuffix = (
      nodes: Map<string, { k: string; p: Record<string, unknown> }>,
      suffix: string
    ): boolean => {
      for (const key of nodes.keys()) {
        if (key === suffix || key.endsWith(`.${suffix}`) || key.endsWith(`-${suffix}`)) return true;
      }
      return false;
    };

    // 1. Default mode = 'all': all 3 routine tools render directly under main with full previews
    await controller.submitInput('run checks');
    await waitFor(() => !controller.store.getState().isStreaming);
    await waitFor(() => {
      const n = replayNodes();
      return (
        hasNodeSuffix(n, 'tc-bash-1') &&
        hasNodeSuffix(n, 'tc-bash-2') &&
        hasNodeSuffix(n, 'tc-read-1') &&
        n.get('main.t0-tc-bash-1')?.p['preview'] === 'children'
      );
    });

    // 2. Press Alt+O (`\x1bo`) -> switches to 'compact': keeps native top-level `<tool>` nodes
    // (no custom `oma.tool.group` wrapper that breaks Tern's `Worked for ...` folding),
    // rendered as compact single-line inline rows (`frame='inline'`, `preview='none'`).
    host.input.emit('\x1bo');
    await waitFor(() => controller.store.getState().toolDisplayMode === 'compact');
    await waitFor(() => {
      const n = replayNodes();
      const b1 = n.get('main.t0-tc-bash-1');
      const r1 = n.get('main.t0-tc-read-1');
      return (
        b1?.k === 'tool' &&
        b1?.p['frame'] === 'inline' &&
        b1?.p['preview'] === 'none' &&
        r1?.k === 'tool' &&
        r1?.p['frame'] === 'inline' &&
        r1?.p['preview'] === 'none'
      );
    });
    expect(replayNodes().has('main.t0-folded-tc-bash-1')).toBe(false);

    // 3. Press Alt+O again -> switches to 'hidden': wraps completed routine tools in native `omp.activity` (`hidden: true`) AND persists `tool_display = "hidden"` to config.toml
    const isHiddenNode = (
      nodes: Map<string, { k: string; p: Record<string, unknown> }>,
      suffix: string
    ): boolean => {
      for (const key of nodes.keys()) {
        if (key === suffix || key.endsWith(`.${suffix}`) || key.endsWith(`-${suffix}`)) {
          // Walk ancestor chain to see if mounted inside a `hidden: true` container
          let cur = key;
          while (cur.includes('.')) {
            if (nodes.get(cur)?.p['hidden'] === true) return true;
            cur = cur.slice(0, cur.lastIndexOf('.'));
          }
          return nodes.get(cur)?.p['hidden'] === true;
        }
      }
      return true;
    };

    host.input.emit('\x1bo');
    await waitFor(() => controller.store.getState().toolDisplayMode === 'hidden');
    await waitFor(() => {
      const n = replayNodes();
      return (
        !n.has('main.t0-folded-tc-bash-1') &&
        n.get('main.t0-activity-tc-bash-1')?.p['role'] === 'omp.activity' &&
        n.get('main.t0-activity-tc-bash-1')?.p['hidden'] === true &&
        isHiddenNode(n, 'tc-bash-1') &&
        isHiddenNode(n, 'tc-read-1')
      );
    });
    await waitFor(() => existsSync(configPath) && readFileSync(configPath, 'utf8').includes('tool_display = "hidden"'));
    const parsedSaved = parseConfigToml(readFileSync(configPath, 'utf8'));
    expect(parsedSaved.warnings).toEqual([]);
    expect(parsedSaved.config.ui.tool_display).toBe('hidden');

    // 4. In 'hidden' mode, actively running tools stay visible while streaming, then hide via `omp.activity` once completed
    void controller.submitInput('run live command');
    await waitFor(() => !isHiddenNode(replayNodes(), 'tc-live-bash'));
    releaseRunningTurn.resolve();
    await waitFor(() => !controller.store.getState().isStreaming);
    await waitFor(() => isHiddenNode(replayNodes(), 'tc-live-bash'));

    // 5. `/settings` `ui.tool_display` choice switches back to 'all' and restores visible individual tool rows
    await controller.submitInput('/settings');
    await waitFor(() => controller.store.getState().settings !== null);
    host.input.emitTspEvent({
      ev: 'change',
      sf: 'oma',
      id: 'layer.settings',
      item: 'ui.tool_display',
      value: 'all',
    });
    await waitFor(() => controller.store.getState().toolDisplayMode === 'all');
    await waitFor(() => !isHiddenNode(replayNodes(), 'tc-bash-1'));

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('regression: resumed thoughts omit fake 0ms, pre-tool text finalizes immediately (stream=false), and in-flight background tool at end_turn defers OSC done until tool_call_update + final reply', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let clock = 500_000;
    const resumeSessionId = 'sess-resume-bg-regression';
    const releaseToolFinish = Promise.withResolvers<void>();

    acp.setHandler((msg, h) => {
      if (msg.method === 'initialize') {
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        });
      } else if (msg.method === 'session/load') {
        // Replay a historical turn instantaneously (0ms wall-clock gap)
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: resumeSessionId,
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Historical prompt' } },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: resumeSessionId,
            update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Historical reasoning' } },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: resumeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-hist-bash',
              name: 'run_command',
              kind: 'execute',
              status: 'completed',
              title: 'echo hist',
              args: { CommandLine: 'echo hist' },
              content: [
                {
                  type: 'content',
                  content: {
                    type: 'text',
                    text: 'Created At: 2026-11-22T12:41:22+08:00\nCompleted At: 2026-11-22T12:41:25+08:00\nCommand exited with code 0.\n\nhist',
                  },
                },
              ],
            },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: resumeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-hist-read',
              name: 'read_file',
              kind: 'read',
              status: 'completed',
              title: 'README.md',
              args: { Path: 'README.md' },
            },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: resumeSessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Historical done.' } },
          },
        });
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: resumeSessionId, configOptions: DEFAULT_CONFIG_OPTIONS },
        });
      } else if (msg.method === 'session/prompt') {
        // Real agy acp pattern: text before tool -> in_progress run_command -> status msg -> end_turn while tool still running -> later completed + final reply
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: resumeSessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Starting migration now...' } },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: resumeSessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-bg-migrate',
              name: 'run_command',
              kind: 'execute',
              status: 'in_progress',
              title: 'python migrate.py',
              args: { CommandLine: 'python migrate.py', WaitMsBeforeAsync: 500 },
            },
          },
        });
        h.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: resumeSessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Migrating in background, waiting for completion.' } },
          },
        });
        h.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 120 } },
        });

        void releaseToolFinish.promise.then(() => {
          clock += 2000;
          h.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: resumeSessionId,
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-bg-migrate',
                name: 'run_command',
                status: 'completed',
                rawOutput: { output: 'Command exited with code 0.\n\nOK', exit_code: 0 },
              },
            },
          });
          setTimeout(() => {
            h.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: resumeSessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nMigration finished cleanly!' } },
              },
            });
            h.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: resumeSessionId,
                update: { sessionUpdate: 'usage_update', used: 2000, size: 1048576 },
              },
            });
          }, 25);
        });
      } else if (msg.method === 'session/close') {
        h.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        h.crash(0);
      }
    });

    const replayNodes = (): Map<string, { k: string; p: Record<string, unknown> }> => {
      const nodes = new Map<string, { k: string; p: Record<string, unknown> }>();
      const addSubtree = (n: WireNode): void => {
        nodes.set(n.id, { k: n.k, p: { ...(n.p ?? {}) } });
        if (n.c) for (const c of n.c) addSubtree(c);
      };
      const delSubtree = (id: string): void => {
        nodes.delete(id);
        const prefix = `${id}.`;
        for (const k of [...nodes.keys()]) {
          if (k.startsWith(prefix)) nodes.delete(k);
        }
      };
      for (const op of host.allOps) {
        if (op[0] === 'add') addSubtree(op[4]);
        else if (op[0] === 'del') delSubtree(op[1]);
        else if (op[0] === 'set') {
          const e = nodes.get(op[1]);
          if (e) {
            for (const [k, v] of Object.entries(op[2])) {
              if (v === null) delete e.p[k];
              else e.p[k] = v;
            }
          }
        }
      }
      return nodes;
    };

    const controller = new AppController({
      cli: parseCliArgs(['--resume', resumeSessionId]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      backgroundDoneGraceMs: 60,
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
      now: () => clock,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // 1. Resumed session: thought renders as plain 'Thought' (NO 'Thought for 0ms' and NO took=0)
    const nodesAfterResume = replayNodes();
    const replayedThought = [...nodesAfterResume.values()].find(
      n => n.k === 'section' && n.p['role'] === 'omp.thinking'
    );
    expect(replayedThought).toBeDefined();
    expect(JSON.stringify(replayedThought?.p['head'])).toContain('Thought');
    expect(JSON.stringify(replayedThought?.p['head'])).not.toContain('0ms');
    expect(replayedThought?.p['took']).toBeUndefined();

    // Resumed bash tool with Created At/Completed At recovers real 3000ms duration; read tool without timestamps has undefined took
    const histBash = [...nodesAfterResume.entries()].find(
      ([id, n]) => n.k === 'tool' && (id.endsWith('.tc-hist-bash') || id.endsWith('-tc-hist-bash'))
    )?.[1];
    const histRead = [...nodesAfterResume.entries()].find(
      ([id, n]) => n.k === 'tool' && (id.endsWith('.tc-hist-read') || id.endsWith('-tc-hist-read'))
    )?.[1];
    expect(histBash?.p['took']).toBe(3000);
    expect(histRead?.p['took']).toBeUndefined();

    // Resumed turn footer must NOT display fake '0ms'
    const turn0Usage = [...nodesAfterResume.entries()].find(
      ([id]) => id.startsWith('main.t0-') && id.endsWith('.turn-usage.text')
    )?.[1];
    expect(String(turn0Usage?.p['text'] ?? '')).toBe('2 tools');

    // 2. Live prompt with in-flight background tool at end_turn:
    const oscLenBefore = host.osc7501.length;
    await controller.submitInput('Migrate now');
    await waitFor(() => !controller.store.getState().isStreaming);

    // Pre-tool text segment MUST already have stream=false (not held in streaming buffer while tool runs)
    const nodesWhileRunning = replayNodes();
    const preToolMd = [...nodesWhileRunning.values()].find(
      n => n.k === 'md' && n.p['text'] === 'Starting migration now...'
    );
    expect(preToolMd).toBeDefined();
    expect(preToolMd?.p['stream']).toBe(false);

    // Tool MUST stay running, turn-1 MUST NOT settle prematurely, and OSC 7501 state=done MUST NOT fire!
    const bgTool = controller.store.transcript.getToolById('tc-bg-migrate');
    expect(bgTool?.status).toBe('running');
    expect(bgTool?.endedAt).toBeUndefined();
    expect(controller.store.hasActiveBackgroundTasks()).toBe(true);
    await Bun.sleep(100);
    expect(host.osc7501.slice(oscLenBefore)).not.toContain('state=done');
    expect(
      host.allOps.some(op => op[0] === 'settle' && typeof op[1] === 'string' && op[1].startsWith('main.t1-'))
    ).toBe(false);

    // 3. Complete background tool + deliver post-tool final reply -> appended to SAME turn-1, settled, THEN state=done fires!
    releaseToolFinish.resolve();
    await waitFor(() => host.osc7501.slice(oscLenBefore).includes('state=done'));

    expect(controller.store.transcript.turns).toHaveLength(2);
    expect(controller.store.transcript.turns[1]?.assistantText).toContain('Migration finished cleanly!');
    expect(controller.store.transcript.getToolById('tc-bg-migrate')?.status).toBe('done');
    expect(
      host.allOps.some(op => op[0] === 'settle' && typeof op[1] === 'string' && op[1].startsWith('main.t1-'))
    ).toBe(true);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('session/load drains trailing async replay updates emitted after RPC response without splitting turns, losing footer, or misplacing edits', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    const resumeSessionId = 'sess-trailing-replay-1';
    acp.setHandler((msg, server) => {
      if (msg.method === 'initialize') {
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        });
      } else if (msg.method === 'session/load') {
        const sid = String((msg.params as { sessionId?: string })?.sessionId ?? resumeSessionId);
        // Batch 1 arrives BEFORE session/load RPC response
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'First historical question' },
            },
          },
        });
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'First historical answer.' },
            },
          },
        });

        // Resolve session/load EARLY while trailing historical updates are still in flight (real agy acp behavior)
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: sid },
        });

        // Batch 2 arrives AFTER session/load RPC response in staggered async chunks
        setTimeout(() => {
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'Second historical question' },
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'Trailing replay thought' },
              },
            },
          });
        }, 15);

        setTimeout(() => {
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-trailing-edit',
                name: 'edit_file',
                kind: 'edit',
                title: 'File /work/src/app/controller.ts',
                status: 'completed',
                locations: [{ path: '/work/src/app/controller.ts' }],
                content: [
                  {
                    type: 'diff',
                    path: '/work/src/app/controller.ts',
                    oldText: 'line1\nline2\n',
                    newText: 'line1\nline2\nline3\n',
                  },
                ],
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-trailing-bash',
                name: 'run_command',
                kind: 'execute',
                title: 'bun test',
                status: 'completed',
                rawOutput: { output: '162 pass', exit_code: 0 },
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Final trailing historical summary.' },
              },
            },
          });
        }, 35);
      } else if (msg.method === 'session/close') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        server.crash(0);
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const controller = new AppController({
      cli: parseCliArgs(['--resume', resumeSessionId]),
      config: {
        ...DEFAULT_CONFIG,
        ui: { ...DEFAULT_CONFIG.ui, tool_display: 'compact' },
      },
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      replayDrainQuietMs: 60,
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // 1. Both turns must be cleanly separated, marked replayed & finalized as done (not merged into a streaming turn!)
    const turns = controller.store.transcript.turns;
    expect(turns).toHaveLength(2);
    expect(turns[0]?.user?.text).toBe('First historical question');
    expect(turns[0]?.status).toBe('done');
    expect(turns[0]?.replayed).toBe(true);

    expect(turns[1]?.user?.text).toBe('Second historical question');
    expect(turns[1]?.status).toBe('done');
    expect(turns[1]?.replayed).toBe(true);
    expect(turns[1]?.thoughts[0]?.replayed).toBe(true);
    expect(turns[1]?.thoughts[0]?.tookMs).toBeUndefined();
    expect(turns[1]?.toolCalls.map(t => t.toolCallId)).toEqual([
      'tc-trailing-edit',
      'tc-trailing-bash',
    ]);
    expect(turns[1]?.assistantText).toBe('Final trailing historical summary.');

    // 2. Trailing replay must NOT trigger live TPS or spurious OSC 7501 state=done
    expect(controller.store.getState().sessionMetrics?.isStreamingTps ?? false).toBe(false);
    expect(host.osc7501).not.toContain('state=done');

    // 3. In compact mode, edit + bash fold together directly under `main` BEFORE the final assistant reply
    const lastTurnIdx = turns[1]!.index;
    const prefix = `main.t${lastTurnIdx}-`;
    const mainAddOps = host.allOps.filter(
      op => op[0] === 'add' && op[2] === 'main' && typeof op[1] === 'string' && op[1].startsWith(prefix)
    );
    // Note: reconcile.ts emits `add` in reverse order using `before` sibling ids; reconstruct visual order from `before`
    const orderedTopIds: string[] = [];
    for (const op of mainAddOps) {
      const id = op[1] as string;
      const beforeId = op[3] as string | null;
      const curIdx = orderedTopIds.indexOf(id);
      if (curIdx >= 0) orderedTopIds.splice(curIdx, 1);
      if (beforeId === null) {
        orderedTopIds.push(id);
      } else {
        const bIdx = orderedTopIds.indexOf(beforeId);
        if (bIdx >= 0) orderedTopIds.splice(bIdx, 0, id);
        else orderedTopIds.push(id);
      }
    }
    const editToolIdx = orderedTopIds.findIndex(id => id.endsWith('-tc-trailing-edit'));
    const finalReplyIdx = orderedTopIds.findIndex(id => id.includes('-assistant-msg-'));
    expect(editToolIdx).toBeGreaterThanOrEqual(0);
    expect(finalReplyIdx).toBeGreaterThan(editToolIdx);
    // No orphan edit tool after the final assistant reply
    expect(orderedTopIds.slice(finalReplyIdx + 1).some(id => id.includes('tc-trailing-edit'))).toBe(
      false
    );

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('omp-aligned thought & tool UX: live thought survives Ctrl+T with rate/tokens, whole-second Thought for Ns, Ctrl+O decoupled, toolSummary->intent, Bash preview=children, auto-expand running edit, Read(N) group, compact single edit preview=none, and Ctrl+Shift+O hidden toggle', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let clock = 1_000_000;
    const releaseLiveThought = Promise.withResolvers<void>();
    const releaseRunningEdit = Promise.withResolvers<void>();
    let promptCount = 0;

    acp.setHandler((msg, server) => {
      if (msg.method === 'initialize') {
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        });
      } else if (msg.method === 'session/new') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-omp-ux' } });
      } else if (msg.method === 'session/prompt') {
        promptCount += 1;
        if (promptCount === 1) {
          // Turn 0: quick 400ms thought -> rounds to 'Thought for 1s', Bash with toolSummary -> intent + preview='children',
          // consecutive 2 Reads -> Read (2) group, running Edit -> auto-expanded then collapsed when done
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-omp-ux',
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'Inspecting project files and running tests.' },
              },
            },
          });
          clock += 400;
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-omp-ux',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-bash-intent',
                name: 'run_command',
                kind: 'execute',
                status: 'completed',
                title: 'bun test',
                args: { CommandLine: 'bun test', toolSummary: 'Run unit test suite' },
                rawOutput: { output: '164 pass', exit_code: 0 },
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-omp-ux',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-read-a',
                name: 'read_file',
                kind: 'read',
                status: 'completed',
                title: 'File /work/src/a.ts',
                locations: [{ path: '/work/src/a.ts' }],
                rawOutput: { output: 'export const a = 1;\n' },
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-omp-ux',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-read-b',
                name: 'read_file',
                kind: 'read',
                status: 'completed',
                title: 'File /work/src/b.ts',
                locations: [{ path: '/work/src/b.ts' }],
                rawOutput: { output: 'export const b = 2;\n' },
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-omp-ux',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-edit-live',
                name: 'edit_file',
                kind: 'edit',
                status: 'in_progress',
                title: 'File /work/src/a.ts',
                locations: [{ path: '/work/src/a.ts' }],
                content: [
                  {
                    type: 'diff',
                    path: '/work/src/a.ts',
                    oldText: 'export const a = 1;\n',
                    newText: 'export const a = 2;\n',
                  },
                ],
              },
            },
          });

          void releaseRunningEdit.promise.then(() => {
            clock += 600;
            server.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sess-omp-ux',
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: 'tc-edit-live',
                  status: 'completed',
                },
              },
            });
            clock += 200;
            server.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sess-omp-ux',
                update: {
                  sessionUpdate: 'agent_thought_chunk',
                  content: { type: 'text', text: 'Summarizing the final answer.' },
                },
              },
            });
            clock += 300;
            server.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sess-omp-ux',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Updated a.ts successfully.' },
                },
              },
            });
            server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          });
        } else {
          // Turn 1: live streaming thought while showThinking === false -> must STILL render live thought + rate + tokens!
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-omp-ux',
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: {
                  type: 'text',
                  text: 'Streaming deep reasoning tokens to verify live rate and tooltip display...',
                },
              },
            },
          });
          clock += 1000;
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-omp-ux',
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: {
                  type: 'text',
                  text: ' More reasoning tokens arriving steadily over one second.',
                },
              },
            },
          });
          void releaseLiveThought.promise.then(() => {
            server.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'sess-omp-ux',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'Done.' },
                },
              },
            });
            server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          });
        }
      } else if (msg.method === 'session/close') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        server.crash(0);
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: { ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui, tool_display: 'all' } },
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      configPath: join(tmp, 'config.toml'),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
      now: () => clock,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    const replayNodes = (): Map<string, { k: string; p: Record<string, unknown> }> => {
      const nodes = new Map<string, { k: string; p: Record<string, unknown> }>();
      const addSubtree = (n: WireNode): void => {
        nodes.set(n.id, { k: n.k, p: { ...(n.p ?? {}) } });
        if (n.c) for (const c of n.c) addSubtree(c);
      };
      const delSubtree = (id: string): void => {
        nodes.delete(id);
        const prefix = `${id}.`;
        for (const k of [...nodes.keys()]) {
          if (k.startsWith(prefix)) nodes.delete(k);
        }
      };
      for (const op of host.allOps) {
        if (op[0] === 'add') addSubtree(op[4]);
        else if (op[0] === 'del') delSubtree(op[1]);
        else if (op[0] === 'set') {
          const e = nodes.get(op[1]);
          if (e) {
            for (const [k, v] of Object.entries(op[2])) {
              if (v === null) delete e.p[k];
              else e.p[k] = v;
            }
          }
        }
      }
      return nodes;
    };

    // 1. Start Turn 0 and inspect while edit_file is still in_progress:
    const p1 = controller.submitInput('update a.ts');
    await waitFor(() => replayNodes().has('main.t0-tc-edit-live'));

    const midNodes = replayNodes();
    // Flat main structure: direct top-level nodes under `main` (NO `main.turn-0` wrapper!)
    expect(midNodes.has('main.turn-0')).toBe(false);
    expect(midNodes.get('main.t0-user')?.p['role']).toBe('omp.user');
    // Running edit_file auto-expands (`collapsed === false`)
    expect(midNodes.get('main.t0-tc-edit-live')?.p['collapsed']).toBe(false);
    // Bash tool is direct child of `main`, maps `toolSummary` -> `intent`, and uses `preview: 'children'` in 'all' mode
    const bashNode = midNodes.get('main.t0-tc-bash-intent');
    expect(bashNode?.k).toBe('tool');
    expect(bashNode?.p['intent']).toBe('Run unit test suite');
    expect(bashNode?.p['preview']).toBe('children');
    // Consecutive 2 Reads aggregate into a native `<tool role="omp.tool.read" frame="inline">` directly under `main`
    // (aligned with `omp`'s `ReadToolGroupComponent`, so Tern's `Worked for ...` chain is never broken)
    const readGroup = midNodes.get('main.t0-read-group-tc-read-a');
    expect(readGroup?.k).toBe('tool');
    expect(readGroup?.p['role']).toBe('omp.tool.read');
    expect(readGroup?.p['name']).toBe('read');
    expect(readGroup?.p['title']).toBe('Read');
    expect(readGroup?.p['target']).toBe('2 files');
    expect(readGroup?.p['frame']).toBe('inline');
    expect(readGroup?.p['preview']).toBe('none');
    expect(JSON.stringify(readGroup?.p['meta'] ?? '')).toContain('a.ts, b.ts');

    // Finish Turn 0
    releaseRunningEdit.resolve();
    await p1;
    await waitFor(() => !controller.store.getState().isStreaming);

    const doneNodes = replayNodes();
    // Completed 400ms thought rounds to 'Thought for 1s' and has token tooltip
    const doneThought = [...doneNodes.values()].find(
      n => n.k === 'section' && n.p['role'] === 'omp.thinking'
    );
    expect(JSON.stringify(doneThought?.p['head'] ?? '')).toContain('Thought for 1s');
    expect(String(doneThought?.p['title'] ?? '')).toContain('tokens');
    // Completed edit returns to collapsed=true
    expect(doneNodes.get('main.t0-tc-edit-live')?.p['collapsed']).toBe(true);
    // Trailing thought right before final reply sits in its OWN thought-only `omp.assistant`
    // container (separate from prose `Done.` + `omp.turn.usage`) so Tern's `Worked for ...`
    // absorbs all thoughts cleanly without stranding a lone `Thought >` above the final answer.
    const trailingThoughtEntry = [...doneNodes.entries()].find(
      ([id, n]) =>
        n.k === 'section' &&
        n.p['role'] === 'omp.thinking' &&
        doneNodes.get(`${id}.body`)?.p['text'] === 'Summarizing the final answer.'
    );
    expect(trailingThoughtEntry).toBeDefined();
    const trailingThoughtParent = trailingThoughtEntry![0].slice(
      0,
      trailingThoughtEntry![0].lastIndexOf('.')
    );
    const proseMdEntry = [...doneNodes.entries()].find(
      ([, n]) => n.k === 'md' && n.p['text'] === 'Updated a.ts successfully.'
    );
    expect(proseMdEntry).toBeDefined();
    const proseParent = proseMdEntry![0].slice(0, proseMdEntry![0].lastIndexOf('.'));
    expect(trailingThoughtParent).not.toBe(proseParent);
    expect(doneNodes.get(`${proseParent}.turn-usage`)?.p['role']).toBe('omp.turn.usage');
    expect(doneNodes.has(`${trailingThoughtParent}.turn-usage`)).toBe(false);

    // 2. Ctrl+O expands tools ONLY — completed thought stays collapsed!
    host.input.emit('\x0f');
    await waitFor(() => controller.store.getState().expandAllTools === true);
    const afterCtrlO = replayNodes();
    expect(afterCtrlO.get('main.t0-tc-edit-live')?.p['collapsed']).toBe(false);
    const thoughtAfterCtrlO = [...afterCtrlO.values()].find(
      n => n.k === 'section' && n.p['role'] === 'omp.thinking'
    );
    expect(thoughtAfterCtrlO?.p['collapsed']).toBe(true);
    // Toggle Ctrl+O back off
    host.input.emit('\x0f');
    await waitFor(() => controller.store.getState().expandAllTools === false);

    // 3. Ctrl+Shift+O (`CSI 111;6u`) toggles directly to 'hidden' (using omp.activity hidden=true) and back to 'all'
    host.input.emit('\x1b[111;6u');
    await waitFor(() => controller.store.getState().toolDisplayMode === 'hidden');
    await waitFor(() => replayNodes().get('main.t0-activity-tc-bash-intent')?.p['hidden'] === true);
    host.input.emit('\x1b[111;6u');
    await waitFor(() => controller.store.getState().toolDisplayMode === 'all');

    // 4. Compact mode: standalone completed edit uses preview='none' (single-line collapsed header)
    controller.store.setToolDisplayMode('compact');
    // Inject a standalone turn with a single edit to test standalone compact edit
    const standaloneTurn = controller.store.transcript.beginUserTurn('single edit');
    controller.store.transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-solo-edit',
      name: 'edit_file',
      kind: 'edit',
      status: 'completed',
      title: 'File /work/src/solo.ts',
      locations: [{ path: '/work/src/solo.ts' }],
      content: [
        { type: 'diff', path: '/work/src/solo.ts', oldText: 'a\n', newText: 'b\n' },
      ],
    });
    controller.store.transcript.finishActiveTurn('end_turn');
    controller.scheduler.renderNow();
    const compactSolo = replayNodes().get(`main.t${standaloneTurn.index}-tc-solo-edit`);
    expect(compactSolo?.p['preview']).toBe('none');

    // 5. Ctrl+T hides completed thoughts, yet Turn 1's LIVE streaming thought remains visible with <rate unit="tok/s"> + tokens tooltip!
    host.input.emit('\x14');
    await waitFor(() => controller.store.getState().showThinking === false);
    const afterCtrlT = replayNodes();
    expect(
      [...afterCtrlT.values()].some(n => n.k === 'section' && n.p['role'] === 'omp.thinking')
    ).toBe(false);

    const p2 = controller.submitInput('think live while hidden');
    await waitFor(() =>
      [...replayNodes().values()].some(n => n.k === 'section' && n.p['role'] === 'omp.thinking.live')
    );
    const liveNodes = replayNodes();
    const liveThoughtEntry = [...liveNodes.entries()].find(
      ([, n]) => n.k === 'section' && n.p['role'] === 'omp.thinking.live'
    );
    expect(liveThoughtEntry).toBeDefined();
    const liveHead = liveNodes.get(`${liveThoughtEntry![0]}.head`);
    expect(String(liveHead?.p['title'] ?? '')).toContain('tokens');
    const liveRate = liveNodes.get(`${liveThoughtEntry![0]}.head.rate`);
    expect(liveRate?.k).toBe('rate');
    expect(liveRate?.p['unit']).toBe('tok/s');
    expect(Number(liveRate?.p['value'] ?? 0)).toBeGreaterThanOrEqual(0.05);

    releaseLiveThought.resolve();
    await p2;
    await waitFor(() => !controller.store.getState().isStreaming);
    // Once finished while showThinking === false, the thought hides cleanly
    await waitFor(() =>
      ![...replayNodes().values()].some(
        n => n.k === 'section' && (n.p['role'] === 'omp.thinking' || n.p['role'] === 'omp.thinking.live')
      )
    );

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('P1 regressions: concurrent submit guard, attachment removal cancels file send, stale session updates filtered, broken config preserved, and rapid toggles serialize cleanly', async () => {
    const tmp = makeTempDir();
    const secretFile = join(tmp, 'secret.txt');
    writeFileSync(secretFile, 'SECRET_ATTACHMENT_BODY', 'utf8');
    const brokenConfigPath = join(tmp, 'broken-config.toml');
    const brokenToml = 'agy_bin = "/custom/agy"\n[ui\nbroken syntax ===\n';
    writeFileSync(brokenConfigPath, brokenToml, 'utf8');

    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    const promptCalls: Array<{ sessionId: string; prompt: unknown[] }> = [];
    let releaseFirstPrompt = Promise.withResolvers<void>();
    let currentServer: { send: (msg: Record<string, unknown>) => void; crash: (code: number) => void } | null = null;

    acp.setHandler((msg, server) => {
      currentServer = server;
      if (msg.method === 'initialize') {
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'agy', version: '2.0.0' },
            agentCapabilities: {
              loadSession: true,
              promptCapabilities: { image: true, embeddedContext: true },
            },
          },
        });
      } else if (msg.method === 'session/new') {
        const sid = promptCalls.length === 0 ? 'sess-old' : 'sess-new';
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: sid, configOptions: [] },
        });
      } else if (msg.method === 'session/close') {
        // Simulate old session failing to close cleanly
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: 'close busy' },
        });
      } else if (msg.method === 'session/prompt') {
        const params = msg.params as { sessionId: string; prompt: unknown[] };
        promptCalls.push(params);
        if (promptCalls.length === 1) {
          void releaseFirstPrompt.promise.then(() => {
            server.send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: params.sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'First reply.' },
                },
              },
            });
            server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          });
        } else {
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Second reply.' },
              },
            },
          });
          server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      configPath: brokenConfigPath,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // P1-5: Toggling tool display via Alt+O with a malformed config.toml must keep the change
    // in memory ONLY and must NOT overwrite or lose the user's original file (e.g. `agy_bin`).
    host.input.emit('\x1bo');
    await waitFor(() => controller.store.getState().toolDisplayMode === 'compact');
    await new Promise(r => setTimeout(r, 30));
    expect(readFileSync(brokenConfigPath, 'utf8')).toBe(brokenToml);

    // P1-1: Two concurrent `submitInput` calls before the first awaits completes must only send ONE `session/prompt`
    const c1 = controller.submitInput('first concurrent');
    const c2 = controller.submitInput('second concurrent');
    await Promise.all([c1, c2]);
    await waitFor(() => promptCalls.length === 1);
    await new Promise(r => setTimeout(r, 30));
    expect(promptCalls).toHaveLength(1);
    releaseFirstPrompt.resolve();
    await waitFor(() => !controller.store.getState().isStreaming);

    // P1-3: Switch to a new session while old session fails to close; stale updates from `sess-old` must be ignored
    await controller.submitInput('/new');
    await waitFor(() => controller.store.getState().sessionId === 'sess-new');
    expect(controller.store.transcript.getVisibleTurns()).toHaveLength(0);
    currentServer!.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-old',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'STALE_LEAK_FROM_OLD_SESSION' },
        },
      },
    });
    await new Promise(r => setTimeout(r, 30));
    expect(controller.store.transcript.getVisibleTurns()).toHaveLength(0);

    // P1-4: Add file attachment + `@secret.txt` in draft, then remove attachment via TSP remove action ->
    // outbound `session/prompt` must NOT include `resource` or `resource_link` for `secret.txt`.
    controller.store.draft.setText('Inspect @secret.txt please');
    controller.store.addAttachment({
      id: 'file-rm-1',
      kind: 'file',
      name: 'secret.txt',
      ext: 'txt',
      mime: 'text/plain',
      path: 'secret.txt',
    });
    controller.scheduler.renderNow();
    const removeIconId = host.findWireNodes(
      n => n.k === 'icon' && n.p?.['title'] === 'Remove attachment'
    )[0]?.id;
    expect(removeIconId).toBeDefined();
    host.input.emitTspEvent({
      ev: 'action',
      sf: 'oma',
      id: removeIconId!,
      act: 'remove',
    });
    await waitFor(() => controller.store.getState().pendingAttachments.length === 0);
    // Removing the file attachment also strips `@secret.txt` from the draft AND suppresses it
    expect(controller.store.draft.text).not.toContain('@secret.txt');
    // Even if `@secret.txt` is passed again, removing the attachment suppresses file inclusion
    await controller.submitInput('Inspect @secret.txt please');
    await waitFor(() => promptCalls.length === 2);
    await waitFor(() => !controller.store.getState().isStreaming);
    const secondBlocks = promptCalls[1]!.prompt as Array<Record<string, unknown>>;
    expect(secondBlocks.some(b => b['type'] === 'resource' || b['type'] === 'resource_link')).toBe(false);
    expect(JSON.stringify(secondBlocks)).not.toContain('SECRET_ATTACHMENT_BODY');

    await controller.shutdown({ cleanExit: true });
    await runPromise;

    // P2-5: Rapid Alt+O toggles on a valid config.toml serialize writes and `shutdown()` flushes final state
    const tmp2 = makeTempDir();
    const validCfg = join(tmp2, 'config.toml');
    const host2 = new FakeTernHost();
    const session2 = await createConnectedSession(host2);
    const acp2 = new MockAcpHarness();
    acp2.setHandler((msg, server) => {
      if (msg.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      } else if (msg.method === 'session/new') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-ser', configOptions: [] } });
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });
    const controller2 = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      configPath: validCfg,
      cwd: tmp2,
      session: session2,
      output: host2.safeOutput,
      acpSpawn: acp2.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp2, 'sessions') }),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
    });
    const runPromise2 = controller2.run();
    await controller2.readyPromise;
    // Rapidly toggle all -> compact -> hidden -> all -> compact (4 times) and immediately shut down
    host2.input.emit('\x1bo');
    host2.input.emit('\x1bo');
    host2.input.emit('\x1bo');
    host2.input.emit('\x1bo');
    await waitFor(() => controller2.store.getState().toolDisplayMode === 'compact');
    await controller2.shutdown({ cleanExit: true });
    await runPromise2;
    const saved = parseConfigToml(readFileSync(validCfg, 'utf8'));
    expect(saved.parseError).toBeUndefined();
    expect(saved.config.ui.tool_display).toBe('compact');
  });

  test('P1 regression: ACP process crash during session/load replay drain ends in crashed state (never ready)', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    acp.setHandler((msg, server) => {
      if (msg.method === 'initialize') {
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentInfo: { name: 'agy', version: '2.0.0' },
            agentCapabilities: { loadSession: true },
          },
        });
      } else if (msg.method === 'session/load') {
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-crash-replay',
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'old turn' },
            },
          },
        });
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-crash-replay', configOptions: [] },
        });
        // Crash the ACP child while `#waitForReplayDrain()` is still waiting
        setTimeout(() => {
          server.crash(137);
        }, 20);
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const controller = new AppController({
      cli: parseCliArgs(['--resume', 'sess-crash-replay']),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      configPath: join(tmp, 'config.toml'),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
      replayDrainQuietMs: 120,
    });

    const runPromise = controller.run();
    await waitFor(() => controller.store.getState().connectionStatus === 'crashed');
    // Wait past the replay drain window to verify it NEVER transitions back to `ready`
    await new Promise(r => setTimeout(r, 180));
    const st = controller.store.getState();
    expect(st.connectionStatus).toBe('crashed');
    expect(st.isReady).toBe(false);
    expect(st.crashError).not.toBeNull();

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('P2 regressions: background handoff stays running, manual cancel marks tool+turn cancelled, ACP exit settles post-end_turn tool, and same-RPC swarm_wait reply emits OSC done', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let promptNum = 0;
    let latestServer: { send: (msg: Record<string, unknown>) => void; crash: (code: number) => void } | null = null;
    acp.setHandler((msg, server) => {
      latestServer = server;
      if (msg.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      } else if (msg.method === 'session/new') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-p2-bg', configOptions: [] } });
      } else if (msg.method === 'session/prompt') {
        promptNum += 1;
        if (promptNum === 1) {
          // Turn 0: Same-RPC `swarm_wait` + coordinator final reply -> must settle & emit OSC done!
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-p2-bg',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-sw-wait',
                name: 'swarm_wait',
                kind: 'other',
                status: 'in_progress',
                title: 'swarm_wait',
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-p2-bg',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-sw-wait',
                status: 'completed',
                content: [{ type: 'content', content: { type: 'text', text: 'woke up' } }],
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-p2-bg',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Coordinator final summary inside same RPC.' },
              },
            },
          });
          server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        } else if (promptNum === 2) {
          // Turn 1: `run_command` starts in_progress, returns end_turn while still running ->
          // then completes with background task handoff (`task-handoff-1`) -> must stay running until manually cancelled!
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-p2-bg',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-handoff',
                name: 'run_command',
                kind: 'execute',
                status: 'in_progress',
                title: 'long build',
                rawInput: { CommandLine: 'bun run build' },
              },
            },
          });
          server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        } else if (promptNum === 3) {
          // Turn 2: Leaves an in-flight background tool after end_turn, then ACP exits unexpectedly
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-p2-bg',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-crash-bg',
                name: 'run_command',
                kind: 'execute',
                status: 'in_progress',
                title: 'crash build',
                rawInput: { CommandLine: 'sleep 99' },
              },
            },
          });
          server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      configPath: join(tmp, 'config.toml'),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
      backgroundDoneGraceMs: 25,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // P2-4: Same-RPC swarm_wait + reply emits OSC 7501 done
    await controller.submitInput('coordinate swarm');
    await waitFor(() => !controller.store.getState().isStreaming);
    await waitFor(() => host.rawWrites.join('').includes('7501;state=done'));

    // P2-3: In-flight placeholder tool hands off to detached background task on `completed` -> stays running!
    await controller.submitInput('start bg build');
    await waitFor(() => !controller.store.getState().isStreaming);
    expect(controller.store.hasActiveBackgroundTasks()).toBe(true);
    latestServer!.send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'sess-p2-bg',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-handoff',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'Tool is running as a background task with task id: sess-p2-bg/task-999',
              },
            },
          ],
        },
      },
    });
    await new Promise(r => setTimeout(r, 30));
    expect(controller.store.hasActiveBackgroundTasks()).toBe(true);
    expect(
      controller.store.transcript
        .getDetachedBackgroundTasks()
        .some(t => t.taskId === 'sess-p2-bg/task-999' && t.status === 'running')
    ).toBe(true);

    // P2-2 (manual stop): Manually cancel while background task + still-open tool exist ->
    // task, tool card, and turn all transition consistently to `cancelled` (never `done`)!
    controller.store.transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-handoff-child',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      title: 'still running step',
    });
    await controller.cancelPendingAndTurn();
    expect(controller.store.hasActiveBackgroundTasks()).toBe(false);
    const turn1 = controller.store.transcript.getVisibleTurns()[1]!;
    expect(turn1.status).toBe('cancelled');
    expect(turn1.toolCalls.find(t => t.toolCallId === 'tc-handoff-child')?.status).toBe('cancelled');

    // P2-2 (ACP exit): Turn 2 ends RPC with background tool still running, then ACP crashes ->
    // active turn and running tool card must be finalized (not left running)!
    await controller.submitInput('crash bg');
    await waitFor(() => !controller.store.getState().isStreaming);
    expect(controller.store.hasActiveBackgroundTasks()).toBe(true);
    latestServer!.crash(1);
    await waitFor(() => controller.store.getState().connectionStatus === 'crashed');
    const turn2 = controller.store.transcript.getVisibleTurns()[2]!;
    expect(turn2.status).toBe('error');
    expect(turn2.toolCalls.find(t => t.toolCallId === 'tc-crash-bg')?.status).not.toBe('running');
    expect(controller.store.hasActiveBackgroundTasks()).toBe(false);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('P2 regressions: hidden mode keeps pending tool visible, Ctrl+O + manual Read group collapse sticks, and Ctrl+T preserves non-evicted prose after GoneEvent', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    const releaseTurn = Promise.withResolvers<void>();
    acp.setHandler((msg, server) => {
      if (msg.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      } else if (msg.method === 'session/new') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-p2-ui', configOptions: [] } });
      } else if (msg.method === 'session/prompt') {
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-p2-ui',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Earlier prose block.' },
            },
          },
        });
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-p2-ui',
            update: {
              sessionUpdate: 'agent_thought_chunk',
              content: { type: 'text', text: 'Middle reasoning.' },
            },
          },
        });
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-p2-ui',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Surviving later prose block.' },
            },
          },
        });
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-p2-ui',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-r1',
              name: 'read_file',
              kind: 'read',
              status: 'completed',
              title: 'File /w/one.ts',
              locations: [{ path: '/w/one.ts' }],
            },
          },
        });
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-p2-ui',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-r2',
              name: 'read_file',
              kind: 'read',
              status: 'completed',
              title: 'File /w/two.ts',
              locations: [{ path: '/w/two.ts' }],
            },
          },
        });
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-p2-ui',
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'tc-pending-1',
              name: 'run_command',
              kind: 'execute',
              status: 'pending',
              title: 'Queued command',
            },
          },
        });
        void releaseTurn.promise.then(() => {
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-p2-ui',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-pending-1',
                status: 'completed',
              },
            },
          });
          server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        });
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: { ...DEFAULT_CONFIG, ui: { ...DEFAULT_CONFIG.ui, tool_display: 'hidden' } },
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      configPath: join(tmp, 'config.toml'),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    const replayNodes = (): Map<string, { k: string; p: Record<string, unknown> }> => {
      const nodes = new Map<string, { k: string; p: Record<string, unknown> }>();
      const addSubtree = (n: WireNode): void => {
        nodes.set(n.id, { k: n.k, p: { ...(n.p ?? {}) } });
        if (n.c) for (const c of n.c) addSubtree(c);
      };
      const delSubtree = (id: string): void => {
        nodes.delete(id);
        const prefix = `${id}.`;
        for (const k of [...nodes.keys()]) {
          if (k.startsWith(prefix)) nodes.delete(k);
        }
      };
      for (const op of host.allOps) {
        if (op[0] === 'add') addSubtree(op[4]);
        else if (op[0] === 'del') delSubtree(op[1]);
        else if (op[0] === 'set') {
          const e = nodes.get(op[1]);
          if (e) {
            for (const [k, v] of Object.entries(op[2])) {
              if (v === null) delete e.p[k];
              else e.p[k] = v;
            }
          }
        }
      }
      return nodes;
    };

    const p = controller.submitInput('check ui edge cases');
    await waitFor(() => replayNodes().has('main.t0-tc-pending-1'));

    // P2-6a: In `hidden` mode, a `pending` tool is still mounted directly under `main` (not inside hidden `omp.activity`)
    const midNodes = replayNodes();
    expect(midNodes.get('main.t0-tc-pending-1')?.k).toBe('tool');
    expect(midNodes.get('main.t0-tc-pending-1')?.p['status']).toBe('pending');
    expect(midNodes.get('main.t0-activity-tc-r1')?.p['hidden']).toBe(true);

    releaseTurn.resolve();
    await p;
    await waitFor(() => !controller.store.getState().isStreaming);

    // Switch to `all`, expand all with Ctrl+O, then manually collapse the Read group -> must stick!
    controller.store.setToolDisplayMode('all');
    controller.scheduler.renderNow();
    await waitFor(() => replayNodes().has('main.t0-read-group-tc-r1'));
    host.input.emit('\x0f');
    await waitFor(() => replayNodes().get('main.t0-read-group-tc-r1')?.p['collapsed'] === false);
    host.input.emitTspEvent({
      ev: 'toggle',
      sf: 'oma',
      id: 'main.t0-read-group-tc-r1',
      collapsed: true,
    });
    await waitFor(() => replayNodes().get('main.t0-read-group-tc-r1')?.p['collapsed'] === true);
    expect(controller.store.getState().expandedToolGroups['turn-0:read-group-tc-r1']).toBe(false);

    // P2-6c: Evict the first prose node via Tern GoneEvent, then hide thoughts via Ctrl+T ->
    // the second (non-evicted) prose block must keep its own stable node ID and remain visible!
    const beforeEvict = replayNodes();
    const firstMdEntry = [...beforeEvict.entries()].find(
      ([, n]) => n.k === 'md' && n.p['text'] === 'Earlier prose block.'
    );
    const secondMdEntry = [...beforeEvict.entries()].find(
      ([, n]) => n.k === 'md' && n.p['text'] === 'Surviving later prose block.'
    );
    expect(firstMdEntry).toBeDefined();
    expect(secondMdEntry).toBeDefined();
    const firstParentId = firstMdEntry![0].slice(0, firstMdEntry![0].lastIndexOf('.'));
    const secondParentId = secondMdEntry![0].slice(0, secondMdEntry![0].lastIndexOf('.'));
    expect(firstParentId).not.toBe(secondParentId);

    const opsBeforeGone = host.allOps.length;
    host.input.emitTspEvent({ ev: 'gone', sf: 'oma', ids: [firstParentId] });
    await waitFor(() => controller.scheduler.isEvicted(firstParentId));

    host.input.emit('\x14'); // Ctrl+T hide thinking
    await waitFor(() => controller.store.getState().showThinking === false);
    const opsAfterGone = host.allOps.slice(opsBeforeGone);
    // Protocol-level Gone handling must emit zero ops (including no redundant `del`) targeting the evicted node
    expect(
      opsAfterGone.some(
        op =>
          typeof op[1] === 'string' &&
          (op[1] === firstParentId || op[1].startsWith(`${firstParentId}.`))
      )
    ).toBe(false);
    const afterCtrlT = replayNodes();
    expect(afterCtrlT.has(secondParentId)).toBe(true);
    expect(afterCtrlT.get(secondMdEntry![0])?.p['text']).toBe('Surviving later prose block.');

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('Review Round 2 P1/P2 regressions: /new session epoch & buffered early updates, non-destructive draft mention removal, permanent cancelled/completed task state, and swarm reply/worker separation', async () => {
    const tmp = makeTempDir();
    const swarmDir = join(tmp, 'swarm');
    mkdirSync(swarmDir, { recursive: true });
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Test Swarm',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
          'worker-1': { role: 'worker', phase: 'RUNNING', wake_mode: 'working', killed: false },
        },
      }),
      'utf8',
    );
    writeFileSync(join(swarmDir, 'board.jsonl'), '', 'utf8');

    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let sessionNum = 0;
    const releaseOldPrompt = Promise.withResolvers<void>();
    const releaseNewSession = Promise.withResolvers<void>();
    let serverRef: { send: (msg: Record<string, unknown>) => void } | null = null;

    acp.setHandler((msg, server) => {
      serverRef = server;
      if (msg.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      } else if (msg.method === 'session/new') {
        sessionNum += 1;
        if (sessionNum === 1) {
          server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-r2-1', configOptions: [] } });
        } else {
          // While `session/new` for sess-r2-2 is in flight:
          // - stale old-session chunk arrives (must be discarded!)
          // - early new-session `available_commands_update` arrives (must be buffered & applied!)
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-r2-1',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'STALE_INFLIGHT_LEAK' },
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-r2-2',
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [{ name: 'fresh-cmd', description: 'Early command for new session' }],
              },
            },
          });
          void releaseNewSession.promise.then(() => {
            server.send({
              jsonrpc: '2.0',
              id: msg.id,
              result: { sessionId: 'sess-r2-2', configOptions: [] },
            });
          });
        }
      } else if (msg.method === 'session/prompt') {
        const params = msg.params as { sessionId: string };
        if (params.sessionId === 'sess-r2-1') {
          // Stays open across `/new`, then resolves late AFTER we switched to sess-r2-2
          void releaseOldPrompt.promise.then(() => {
            server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          });
        } else {
          // On sess-r2-2: swarm_wait + empty whitespace chunk (must NOT clear wait) + visible reply
          // while worker snapshot still lags as `working` at `end_turn`!
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-r2-2',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-sw-r2',
                name: 'swarm_wait',
                kind: 'other',
                status: 'in_progress',
                title: 'swarm_wait',
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-r2-2',
              update: {
                sessionUpdate: 'tool_call_update',
                toolCallId: 'tc-sw-r2',
                status: 'completed',
              },
            },
          });
          // Empty/whitespace chunk must NOT clear waiting state
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-r2-2',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: '   ' },
              },
            },
          });
          // Actual visible coordinator reply
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-r2-2',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'All swarm tasks finished!' },
              },
            },
          });
          server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      configPath: join(tmp, 'config.toml'),
      swarmDir,
      swarmPollIntervalMs: 25,
      backgroundDoneGraceMs: 30,
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // P2-1: Removing a file attachment preserves Python indentation, double spaces inside strings, and cursor position!
    const pythonDraft = 'def f():\n    x = "a  b"\n    # ref @foo.py here\n    return x';
    controller.store.draft.setText(pythonDraft, 12); // cursor inside `"a  b"` line
    controller.store.addAttachment({
      id: 'att-py-1',
      kind: 'file',
      name: 'foo.py',
      ext: 'py',
      mime: 'text/x-python',
      path: 'foo.py',
    });
    controller.scheduler.renderNow();
    const rmIcon = host.findWireNodes(n => n.k === 'icon' && n.p?.['title'] === 'Remove attachment')[0];
    expect(rmIcon).toBeDefined();
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: rmIcon!.id, act: 'remove' });
    await waitFor(() => controller.store.getState().pendingAttachments.length === 0);
    expect(controller.store.draft.text).toBe('def f():\n    x = "a  b"\n    # ref here\n    return x');
    expect(controller.store.draft.cursor).toBe(12);
    controller.store.draft.reset();

    // P1-1: Start a slow prompt on sess-r2-1, then run `/new` while prompt is still in flight
    await controller.submitInput('long old turn');
    await waitFor(() => controller.store.getState().isStreaming);
    const newSessionPromise = controller.submitInput('/new');
    // Before `session/new` resolves, verify `sessionId` is already cleared and stale leak did NOT enter transcript
    await waitFor(() => controller.store.getState().sessionId === null);
    expect(controller.store.transcript.getVisibleTurns()).toHaveLength(0);

    releaseNewSession.resolve();
    await newSessionPromise;
    await waitFor(() => controller.store.getState().sessionId === 'sess-r2-2');
    // Stale old-session chunk was discarded, while early new-session command was buffered & applied!
    expect(controller.store.transcript.getVisibleTurns()).toHaveLength(0);
    expect(controller.store.commands.getAll().some(c => c.name === 'fresh-cmd')).toBe(true);

    // Now let the old session's late prompt response arrive -> must NOT emit `state=done` or touch sess-r2-2!
    const writesBeforeOldResolve = host.rawWrites.join('').length;
    releaseOldPrompt.resolve();
    await new Promise(r => setTimeout(r, 40));
    expect(host.rawWrites.join('').slice(writesBeforeOldResolve)).not.toContain('7501;state=done');

    // P2-2: Cancelled tool card stays `cancelled` on late `completed`; completed handoff task stays `completed` on late title update
    const tTool = controller.store.transcript.beginUserTurn('cancel & handoff test');
    controller.store.transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-cancel-persist',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      title: 'slow job',
    });
    controller.store.transcript.finalizeBackgroundTurn({
      terminalToolStatus: 'cancelled',
      terminalTurnStatus: 'cancelled',
    });
    expect(tTool.toolCalls[0]?.status).toBe('cancelled');
    controller.store.transcript.applySessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-cancel-persist',
      status: 'completed',
    });
    expect(tTool.toolCalls[0]?.status).toBe('cancelled');

    const tHandoff = controller.store.transcript.beginUserTurn('completed handoff stays terminal');
    controller.store.transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-bg-done',
      name: 'run_command',
      kind: 'execute',
      status: 'completed',
      title: 'bg job',
      content: [{ type: 'content', content: { type: 'text', text: 'Tool is running as a background task with task id: sess-r2-2/task-77' } }],
    });
    expect(controller.store.transcript.completeBackgroundTask('sess-r2-2/task-77', 'completed')).toBe(true);
    expect(controller.store.transcript.hasActiveBackgroundTasks()).toBe(false);
    // Late incremental title-only update on `tc-bg-done` must NOT resurrect the completed task back to `running`!
    controller.store.transcript.applySessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-bg-done',
      title: 'bg job (renamed)',
    });
    expect(controller.store.transcript.hasActiveBackgroundTasks()).toBe(false);
    controller.store.transcript.finishActiveTurn('end_turn');
    expect(tHandoff.status).toBe('done');

    // P2-3: On sess-r2-2, swarm worker is still `working` when coordinator emits visible reply + `end_turn`.
    // Once watcher sees worker transition to `waiting`, OSC 7501 `state=done` MUST fire!
    await waitFor(() => controller.store.isSwarmWorking === true);
    const writesBeforeSwarm = host.rawWrites.join('').length;
    await controller.submitInput('finish swarm');
    await waitFor(() => !controller.store.getState().isStreaming);
    // While worker-1 is still `working`, `done` must not have fired yet
    await new Promise(r => setTimeout(r, 40));
    expect(host.rawWrites.join('').slice(writesBeforeSwarm)).not.toContain('7501;state=done');

    // Transition swarm members to `waiting` (no second coordinator reply arrives!) -> deferred `done` must fire!
    writeFileSync(
      join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Test Swarm',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
          'worker-1': { role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
        },
      }),
      'utf8',
    );
    await waitFor(() => host.rawWrites.join('').slice(writesBeforeSwarm).includes('7501;state=done'));

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('Review Round 3 P1/P2 regressions: rapid double /new preserves latest command buffer, late anchor save does not overwrite OSC anchor, and stale permission/elicitation requests are rejected cleanly', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let newCount = 0;
    const releaseNew2 = Promise.withResolvers<void>();
    const releaseNew3 = Promise.withResolvers<void>();
    const releaseOldSave = Promise.withResolvers<void>();
    const serverResponses: Array<{ id: unknown; result: unknown }> = [];
    let serverRef: { send: (msg: Record<string, unknown>) => void } | null = null;

    acp.setHandler((msg, server) => {
      serverRef = server;
      if (msg.id !== undefined && msg.method === undefined) {
        serverResponses.push({ id: msg.id, result: msg.result });
        return;
      }
      if (msg.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      } else if (msg.method === 'session/new') {
        newCount += 1;
        if (newCount === 1) {
          server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-kept', configOptions: [] } });
        } else if (newCount === 2) {
          void releaseNew2.promise.then(() => {
            server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-superseded', configOptions: [] } });
          });
        } else {
          // Third session (second `/new`) pushes an early slash command BEFORE resolving
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-current',
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [{ name: 'final-cmd', description: 'Must survive superseded /new finally' }],
              },
            },
          });
          void releaseNew3.promise.then(() => {
            server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-current', configOptions: [] } });
          });
        }
      } else if (msg.method === 'session/prompt') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const basePreviewStore = new PreviewStore({ sessionsDir: join(tmp, 'sessions') });
    let holdKeptSave = false;
    const delayedPreviewStore = Object.assign(Object.create(Object.getPrototypeOf(basePreviewStore)), basePreviewStore, {
      async save(input: Parameters<PreviewStore['save']>[0]): Promise<string> {
        const savedPath = await basePreviewStore.save(input);
        if (input.sessionId === 'sess-kept' && holdKeptSave) {
          await releaseOldSave.promise;
        }
        return savedPath;
      },
    }) as PreviewStore;

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: delayedPreviewStore,
      configPath: join(tmp, 'config.toml'),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
    });

    const runPromise = controller.run();
    await controller.readyPromise;
    expect(controller.store.getState().sessionId).toBe('sess-kept');

    // Trigger a prompt on `sess-kept` whose post-turn anchor `save()` will resolve LATE after we switch sessions
    holdKeptSave = true;
    await controller.submitInput('trigger delayed anchor save');
    await waitFor(() => !controller.store.getState().isStreaming);

    // P1-2: Trigger TWO consecutive `/new` calls while neither has resolved yet!
    const firstNew = controller.submitInput('/new');
    await waitFor(() => newCount === 2);
    const secondNew = controller.submitInput('/new');
    await waitFor(() => newCount === 3);

    // First (superseded) `/new` resolves FIRST and runs its `finally` block -> must NOT wipe second `/new`'s command buffer!
    releaseNew2.resolve();
    await firstNew;
    // Now second `/new` resolves -> must apply its buffered `final-cmd`!
    releaseNew3.resolve();
    await secondNew;
    await waitFor(() => controller.store.getState().sessionId === 'sess-current');
    expect(controller.store.commands.getAll().some(c => c.name === 'final-cmd')).toBe(true);

    // P2-1a: Now let `sess-kept`'s delayed anchor `save()` resolve -> OSC 1337 SetUserVar must NOT revert to `sess-kept.json`!
    const writesBeforeLateAnchor = host.rawWrites.join('').length;
    releaseOldSave.resolve();
    await new Promise(r => setTimeout(r, 40));
    const lateOsc = host.rawWrites.join('').slice(writesBeforeLateAnchor);
    expect(lateOsc).not.toContain('SetUserVar=omp_session_file=');

    // P2-1b: Stale reverse server requests (`session/request_permission` & `elicitation/create`) carrying old sessionId
    // must be automatically cancelled without mounting into `sess-current` UI!
    serverRef!.send({
      jsonrpc: '2.0',
      id: 9001,
      method: 'session/request_permission',
      params: {
        sessionId: 'sess-kept',
        toolCall: { toolCallId: 'tc-stale-perm', title: 'stale rm' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });
    serverRef!.send({
      jsonrpc: '2.0',
      id: 9002,
      method: 'elicitation/create',
      params: {
        sessionId: 'sess-kept',
        mode: 'form',
        message: 'Stale question',
        requestedSchema: { type: 'object', properties: { q1: { type: 'string' } } },
      },
    });
    await waitFor(
      () =>
        serverResponses.some(r => r.id === 9001) &&
        serverResponses.some(r => r.id === 9002)
    );
    expect(controller.store.approvals.hasPending()).toBe(false);
    expect(controller.store.getState().activeQuestion).toBeNull();
    expect(serverResponses.find(r => r.id === 9001)?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(serverResponses.find(r => r.id === 9002)?.result).toEqual({ action: 'cancel' });

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('Review Round 4 P1 regression: interleaved /resume and /new in BOTH directions preserve latest session, discard old replay, keep early commands, and leave scheduler unsuspended', async () => {
    const tmp = makeTempDir();
    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let newCount = 0;
    let loadCount = 0;
    let closeStarted = 0;
    let holdFirstClose = true;
    const releaseFirstClose = Promise.withResolvers<void>();
    const releaseReplay2 = Promise.withResolvers<void>();
    const releaseNewAfterReplay = Promise.withResolvers<void>();
    const loadedSessionIds: string[] = [];

    acp.setHandler((msg, server) => {
      if (msg.method === 'initialize') {
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        });
      } else if (msg.method === 'session/list') {
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessions: [
              {
                sessionId: 'sess-hist-1',
                cwd: tmp,
                title: 'Historical Session 1',
                updatedAt: '2026-11-22T10:00:00Z',
              },
              {
                sessionId: 'sess-hist-2',
                cwd: tmp,
                title: 'Historical Session 2',
                updatedAt: '2026-11-22T11:00:00Z',
              },
            ],
          },
        });
      } else if (msg.method === 'session/new') {
        newCount += 1;
        if (newCount === 1) {
          server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-init', configOptions: [] } });
        } else if (newCount === 2) {
          server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-new-wins', configOptions: [] } });
        } else {
          // Third `/new` (started WHILE `sess-hist-2` is mid-replay):
          // Old replay emits a trailing message, while new session emits its early slash command!
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-hist-2',
              update: {
                sessionUpdate: 'user_message_chunk',
                content: { type: 'text', text: 'STALE_REPLAY_MESSAGE_MUST_NOT_LEAK' },
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-after-replay',
              update: {
                sessionUpdate: 'available_commands_update',
                availableCommands: [{ name: 'after-replay-cmd', description: 'Early command after replay' }],
              },
            },
          });
          void releaseNewAfterReplay.promise.then(() => {
            server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-after-replay', configOptions: [] } });
          });
        }
      } else if (msg.method === 'session/close') {
        closeStarted += 1;
        if (holdFirstClose) {
          holdFirstClose = false;
          void releaseFirstClose.promise.then(() => {
            server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
          });
        } else {
          server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
        }
      } else if (msg.method === 'session/load') {
        const sid = (msg.params as { sessionId: string }).sessionId;
        loadedSessionIds.push(sid);
        loadCount += 1;
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: `History turn of ${sid}` },
            },
          },
        });
        void releaseReplay2.promise.then(() => {
          server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid, configOptions: [] } });
        });
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      configPath: join(tmp, 'config.toml'),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
      replayDrainQuietMs: 80,
    });

    const runPromise = controller.run();
    await controller.readyPromise;
    expect(controller.store.getState().sessionId).toBe('sess-init');

    // Direction 1: Activate `/resume` for `sess-hist-1` -> blocks on `session/close` ->
    // `/new` completes -> release old `/resume`'s `closeSession` -> MUST NOT load `sess-hist-1` or revert UI!
    await controller.submitInput('/resume sess-hist-1');
    await waitFor(() => controller.store.getState().picker?.selectedId === 'sess-hist-1');
    host.input.emit('\r');
    await waitFor(() => closeStarted === 1);

    await controller.submitInput('/new');
    await waitFor(() => controller.store.getState().sessionId === 'sess-new-wins');
    releaseFirstClose.resolve();
    await new Promise(r => setTimeout(r, 40));
    expect(controller.store.getState().sessionId).toBe('sess-new-wins');
    expect(loadedSessionIds).not.toContain('sess-hist-1');
    expect(controller.scheduler.suspended).toBe(false);

    // Direction 2: Activate `/resume` for `sess-hist-2` -> actively replaying -> trigger `/new` mid-replay ->
    // new session must NOT inherit old replay message, MUST keep its own early command,
    // and scheduler MUST NOT remain suspended!
    await controller.submitInput('/resume sess-hist-2');
    await waitFor(() => controller.store.getState().picker?.selectedId === 'sess-hist-2');
    host.input.emit('\r');
    await waitFor(() => loadCount === 1 && controller.store.getState().isReplaying === true);
    expect(controller.scheduler.suspended).toBe(true);

    const newDuringReplay = controller.submitInput('/new');
    await waitFor(() => newCount === 3);
    releaseReplay2.resolve();
    await new Promise(r => setTimeout(r, 30));
    releaseNewAfterReplay.resolve();
    await newDuringReplay;

    await waitFor(() => controller.store.getState().sessionId === 'sess-after-replay');
    expect(controller.store.getState().isReplaying).toBe(false);
    expect(controller.scheduler.suspended).toBe(false);
    expect(controller.store.transcript.getVisibleTurns()).toHaveLength(0);
    expect(controller.store.commands.getAll().some(c => c.name === 'after-replay-cmd')).toBe(true);

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('OMP parity P1/P2 regressions: isolated SendEvent, /resume crash recovery + Retry, 1-credit Gone filtering, model Esc guard, quoted @mentions, Git wrap, progressive /resume search, and no-prefs /settings fallback', async () => {
    const tmp = makeTempDir();
    const spacedDir = join(tmp, 'my folder');
    mkdirSync(spacedDir, { recursive: true });
    const spacedFile = join(spacedDir, 'space note.txt');
    writeFileSync(spacedFile, 'SPACED_FILE_CONTENT_OK\n', 'utf8');

    // -----------------------------------------------------------------------
    // Part A: Isolated SendEvent, Model Picker Esc guard, quoted @mention +
    //         completion refresh, Git wrap prop, and progressive /resume search
    // -----------------------------------------------------------------------
    const previewStore = new PreviewStore({ sessionsDir: join(tmp, 'sessions') });
    await previewStore.save({
      sessionId: 'sess-cached-preview',
      cwd: tmp,
      title: 'Cached Title',
      updatedAt: '2026-11-22T12:00:00Z',
      turnCount: 2,
      preview: [
        { role: 'user', text: 'Investigate quantum_flux_capacitor timeout' },
      ],
    });

    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    const promptsReceived: Array<Array<Record<string, unknown>>> = [];
    const configOptionCalls: Array<{ configId: string; value: string }> = [];
    const releaseRemoteList = Promise.withResolvers<void>();
    let crashOnNextClose = false;
    const loadedSessionsOnRetry: string[] = [];

    acp.setHandler((msg, server) => {
      if (msg.method === 'initialize') {
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          },
        });
      } else if (msg.method === 'session/new') {
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'sess-main-1',
            configOptions: [
              {
                id: 'model',
                category: 'model',
                name: 'Model',
                type: 'select',
                currentValue: 'model-a',
                options: [
                  { value: 'model-a', name: 'Model A' },
                  { value: 'model-b', name: 'Model B' },
                ],
              },
              {
                id: 'thought_level',
                category: 'thought_level',
                name: 'Thinking',
                type: 'select',
                currentValue: 'low',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'high', name: 'High' },
                ],
              },
            ],
          },
        });
      } else if (msg.method === 'session/set_config_option') {
        const p = msg.params as { configId: string; value: string };
        configOptionCalls.push(p);
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            configOptions: [
              {
                id: 'model',
                category: 'model',
                name: 'Model',
                type: 'select',
                currentValue: p.configId === 'model' ? p.value : 'model-a',
                options: [
                  { value: 'model-a', name: 'Model A' },
                  { value: 'model-b', name: 'Model B' },
                ],
              },
              {
                id: 'thought_level',
                category: 'thought_level',
                name: 'Thinking',
                type: 'select',
                currentValue: p.configId === 'thought_level' ? p.value : 'low',
                options: [
                  { value: 'low', name: 'Low' },
                  { value: 'high', name: 'High' },
                ],
              },
            ],
          },
        });
      } else if (msg.method === 'session/prompt') {
        const p = msg.params as { prompt: Array<Record<string, unknown>> };
        promptsReceived.push(p.prompt);
        server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      } else if (msg.method === 'session/list') {
        void releaseRemoteList.promise.then(() => {
          server.send({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              sessions: [
                {
                  sessionId: 'sess-cached-preview',
                  cwd: tmp,
                  title: 'Cached Title',
                  updatedAt: '2026-11-22T12:00:00Z',
                },
              ],
            },
          });
        });
      } else if (msg.method === 'session/close') {
        if (crashOnNextClose) {
          crashOnNextClose = false;
          server.crash(1);
          return;
        }
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      } else if (msg.method === 'session/load') {
        const sid = (msg.params as { sessionId: string }).sessionId;
        loadedSessionsOnRetry.push(sid);
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: sid, configOptions: [] },
        });
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore,
      configPath: join(tmp, 'config.toml'),
      gitExec: async args => {
        if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${tmp}\n` };
        if (args[0] === 'status') return { exitCode: 0, stdout: ' M a.ts\0' };
        if (args[0] === 'symbolic-ref') return { exitCode: 0, stdout: 'main\n' };
        if (args.includes('--numstat')) return { exitCode: 0, stdout: '1\t0\ta.ts\n' };
        if (args.includes('diff')) return { exitCode: 0, stdout: '@@ -1,1 +1,2 @@\n a\n+b\n' };
        return { exitCode: 0, stdout: '' };
      },
      installSignals: false,
      throttleMs: 5,
      replayDrainQuietMs: 20,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // 1) P1-1: Native `send` event isolation — draft text + image attachment stay untouched!
    controller.store.draft.setText('my unfinished draft');
    controller.store.addAttachment({
      id: 'img-draft-1',
      kind: 'image',
      name: 'draft.png',
      mime: 'image/png',
      base64Data: 'AAAA',
    });
    // Blank native send must be rejected without touching draft or attachments
    host.input.emitTspEvent({ ev: 'send', sf: 'oma', id: EDITOR_NODE_ID, text: '   ' });
    await new Promise(r => setTimeout(r, 30));
    expect(promptsReceived).toHaveLength(0);
    expect(controller.store.draft.text).toBe('my unfinished draft');
    expect(controller.store.getState().pendingAttachments).toHaveLength(1);

    // Standalone non-blank send must NOT include draft image and must preserve draft + attachment
    host.input.emitTspEvent({ ev: 'send', sf: 'oma', id: EDITOR_NODE_ID, text: 'standalone prompt' });
    await waitFor(() => promptsReceived.length === 1);
    expect(promptsReceived[0]!.some(b => b['type'] === 'image')).toBe(false);
    expect(promptsReceived[0]!.some(b => b['type'] === 'text' && b['text'] === 'standalone prompt')).toBe(true);
    expect(controller.store.draft.text).toBe('my unfinished draft');
    expect(controller.store.getState().pendingAttachments).toHaveLength(1);
    controller.store.draft.reset();
    controller.store.clearAttachments();

    // 2) Quoted @mention with spaces resolves standalone (e.g. recalled from history) without attachment sidecar
    await controller.submitInput('Check @"my folder/space note.txt" please');
    await waitFor(() => promptsReceived.length === 2);
    const spacedResBlock = promptsReceived[1]!.find(b => b['type'] === 'resource') as
      | { resource?: { text?: string } }
      | undefined;
    expect(spacedResBlock?.resource?.text).toContain('SPACED_FILE_CONTENT_OK');

    // 3) P2-2: Model picker Esc while highlighting a DIFFERENT model must NOT mutate current model thinking
    await controller.submitInput('/model');
    await waitFor(() => controller.store.getState().picker?.kind === 'model');
    // Move selection to `model-b` (NOT current `model-a`), change thinking to `high`, press Esc
    controller.store.setPickerSelected('model-b');
    controller.store.setModelPickerThinking('high');
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().picker === null);
    expect(configOptionCalls).toHaveLength(0);
    expect(controller.store.getState().controls.currentThoughtLevel).toBe('low');

    // Highlighting the CURRENT model `model-a`, changing thinking to `high`, pressing Esc DOES commit
    await controller.submitInput('/model');
    await waitFor(() => controller.store.getState().picker?.kind === 'model');
    expect(controller.store.getState().picker?.selectedId).toBe('model-a');
    controller.store.setModelPickerThinking('high');
    host.input.emit('\x1b');
    await waitFor(() => controller.store.getState().controls.currentThoughtLevel === 'high');
    expect(configOptionCalls.some(c => c.configId === 'thought_level' && c.value === 'high')).toBe(true);

    // 4) Git overlay passes `wrap` prop directly onto `<diff>` node
    await controller.submitInput('/git');
    await waitFor(() => controller.store.getState().gitOverlay?.diff?.kind === 'diff');
    host.input.emit('w');
    await waitFor(() => controller.store.getState().gitOverlay?.wrap === true);
    const hasWrapSetOp = host.allOps.some(
      op =>
        op[0] === 'set' &&
        typeof op[1] === 'string' &&
        op[1].includes('diff-') &&
        (op[2] as Record<string, unknown>)?.['wrap'] === true
    );
    expect(hasWrapSetOp).toBe(true);
    host.input.emit('q');
    await waitFor(() => controller.store.getState().gitOverlay === null);

    // 5) Progressive /resume displays local cached preview BEFORE remote session/list returns,
    //    AND searches preview body text (`quantum_flux_capacitor`)!
    await controller.submitInput('/resume quantum_flux_capacitor');
    await waitFor(
      () =>
        controller.store.getState().picker?.kind === 'resume' &&
        controller.store.getState().picker?.selectedId === 'sess-cached-preview'
    );
    expect(controller.store.getState().picker?.loading).toBe(true);
    releaseRemoteList.resolve();
    await waitFor(() => controller.store.getState().picker?.loading === false);

    // 6) P1-2: ACP exits during `session/close` of `/resume` -> renderer MUST NOT stay suspended,
    //    crash banner MUST render on wire, and Retry MUST recover last committed session ID (`sess-main-1`)!
    crashOnNextClose = true;
    host.input.emit('\r');
    await waitFor(() => controller.store.getState().connectionStatus === 'crashed');
    expect(controller.scheduler.suspended).toBe(false);
    expect(controller.store.getState().isReplaying).toBe(false);
    const crashNodes = host.findWireNodes(n => n.id.endsWith('crash-banner'));
    expect(crashNodes.length).toBeGreaterThan(0);

    // Trigger Retry button -> reloads `sess-main-1`
    const retryBtn = host.findWireNodes(n => n.id.endsWith('crash-banner.end'));
    expect(retryBtn.length).toBeGreaterThan(0);
    host.input.emitTspEvent({ ev: 'action', sf: 'oma', id: retryBtn[retryBtn.length - 1]!.id, act: 'click' });
    await waitFor(
      () =>
        loadedSessionsOnRetry.includes('sess-main-1') &&
        controller.store.getState().sessionId === 'sess-main-1' &&
        controller.store.getState().connectionStatus === 'ready'
    );
    expect(controller.store.getState().sessionId).toBe('sess-main-1');

    await controller.shutdown({ cleanExit: true });
    await runPromise;

    // -----------------------------------------------------------------------
    // Part B: P1-3 (1-credit Gone filtering before ACK flush) & no-prefs /settings fallback
    // -----------------------------------------------------------------------
    const hostB = new FakeTernHost({
      credits: 1,
      autoAck: true,
      kinds: ['col', 'row', 'text', 'md', 'card', 'button', 'tabs', 'overlay', 'editor', 'status'],
      features: ['blobs', 'settle', 'dock', 'scroll'],
    });
    const sessionB = await createConnectedSession(hostB);
    const acpB = new MockAcpHarness();
    acpB.setHandler((msg, server) => {
      if (msg.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-b', configOptions: [] } });
      } else if (msg.method === 'session/prompt') {
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 'sess-b',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'First reply chunk' } },
          },
        });
        server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const controllerB = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session: sessionB,
      output: hostB.safeOutput,
      acpSpawn: acpB.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions-b') }),
      configPath: join(tmp, 'config-b.toml'),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
    });
    const runB = controllerB.run();
    await controllerB.readyPromise;

    // Verify no-prefs fallback: `/settings` opens fallback card overlay with ZERO `k: 'prefs'` nodes
    expect(controllerB.store.getState().supportsPrefs).toBe(false);
    await controllerB.submitInput('/settings');
    await waitFor(() => controllerB.store.getState().settings !== null);
    expect(hostB.findWireNodes(n => n.k === 'prefs')).toHaveLength(0);
    expect(hostB.findWireNodes(n => n.id === 'layer.settings.fallback-card')).not.toHaveLength(0);
    hostB.input.emit('\x1b');
    await waitFor(() => controllerB.store.getState().settings === null);

    // P1-3: 1-credit flow control + Gone BEFORE ACK flush
    await controllerB.submitInput('hi');
    await waitFor(
      () =>
        controllerB.store.transcript.turns.length === 1 &&
        !controllerB.store.getState().isStreaming &&
        hostB.findWireNodes(n => n.k === 'md' && n.p?.['text'] === 'First reply chunk').length > 0 &&
        !controllerB.surface.blocked
    );
    const replyMdNode = hostB.findWireNodes(
      n => n.k === 'md' && n.p?.['text'] === 'First reply chunk'
    )[0]!;
    const evictedAssistantId = replyMdNode.id.slice(0, replyMdNode.id.lastIndexOf('.'));
    expect(evictedAssistantId.startsWith('main.t0-')).toBe(true);

    // Pause autoAck, send one frame to exhaust the 1 credit, then mutate the evicted turn + trigger Gone BEFORE ACK!
    hostB.setAutoAck(false);
    controllerB.store.pushToast('fill-credit', 'info');
    controllerB.scheduler.renderNow();
    const blockedSeq = controllerB.surface.seq;
    expect(controllerB.surface.blocked).toBe(true);

    // Append text to the soon-to-be-evicted node while blocked, then deliver Gone followed immediately by ACK
    controllerB.store.transcript.turns[0]!.assistantSegments[0]!.text += ' TRAILING_AFTER_GONE';
    controllerB.scheduler.renderNow();

    const opsBeforeGoneAck = hostB.allOps.length;
    hostB.input.emitTspEvent({ ev: 'gone', ids: [evictedAssistantId] });
    hostB.ackFrame('oma', blockedSeq);
    await new Promise(r => setTimeout(r, 30));

    // Re-enable autoAck and render another frame to ensure NO trailing `del` is emitted either!
    hostB.setAutoAck(true);
    controllerB.store.pushToast('after-gone-frame', 'info');
    controllerB.scheduler.renderNow();
    await new Promise(r => setTimeout(r, 30));

    const opsAfterGone = hostB.allOps.slice(opsBeforeGoneAck);
    const offendingOps = opsAfterGone.filter(op => {
      const target = typeof op[1] === 'string' ? op[1] : '';
      return target === evictedAssistantId || target.startsWith(`${evictedAssistantId}.`);
    });
    expect(offendingOps).toHaveLength(0);
    // Semantic transcript history remains intact for `/copy` and `/export`
    expect(controllerB.store.transcript.getAssistantMarkdownByReverseIndex(1)).toContain('First reply chunk');

    await controllerB.shutdown({ cleanExit: true });
    await runB;
  });

  test('OMP parity Round 2 regressions: isolated passthrough send, comma @mention round-trip, suspended ACK guard, /resume fast-fail rejection handling, deferred settleTurn, equal-length tool output update, and per-surface Gone routing', async () => {
    const tmp = makeTempDir();
    writeFileSync(join(tmp, 'a'), 'UNRELATED_FILE_A_CONTENT\n', 'utf8');
    writeFileSync(join(tmp, 'a,b.txt'), 'TARGET_COMMA_FILE_CONTENT\n', 'utf8');

    const host = new FakeTernHost({ credits: 1, autoAck: true });
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    const promptsReceived: Array<Array<Record<string, unknown>>> = [];
    let failNextSessionList = false;
    const holdReplayLoad = Promise.withResolvers<void>();
    let promptSeq = 0;

    acp.setHandler((msg, server) => {
      if (msg.method === 'initialize') {
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
          },
        });
      } else if (msg.method === 'session/new') {
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: { sessionId: 'sess-r2', configOptions: [] },
        });
      } else if (msg.method === 'session/list') {
        if (failNextSessionList) {
          failNextSessionList = false;
          server.send({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'fast session/list failure' },
          });
          return;
        }
        server.send({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessions: [
              {
                sessionId: 'sess-replay-hold',
                cwd: tmp,
                title: 'Held Replay Session',
                updatedAt: '2026-11-22T15:00:00Z',
              },
            ],
          },
        });
      } else if (msg.method === 'session/load') {
        const sid = (msg.params as { sessionId: string }).sessionId;
        server.send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'PARTIAL_REPLAY_MUST_NOT_LEAK_ON_ACK' },
            },
          },
        });
        void holdReplayLoad.promise.then(() => {
          server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: sid, configOptions: [] } });
        });
      } else if (msg.method === 'session/prompt') {
        promptSeq += 1;
        const p = msg.params as { prompt: Array<Record<string, unknown>> };
        promptsReceived.push(p.prompt);
        if (promptSeq === 3) {
          // Turn with tool call whose output will later be replaced with equal-length string
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-r2',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-eqlen',
                title: 'Run check',
                kind: 'execute',
                status: 'completed',
                rawOutput: 'before',
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-r2',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Done turn 3' },
              },
            },
          });
        } else if (promptSeq === 4) {
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-r2',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Turn 4 active' },
              },
            },
          });
        }
        server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const slowPreviewStore = new PreviewStore({ sessionsDir: join(tmp, 'sessions') });
    const origLoadMap = slowPreviewStore.loadMap.bind(slowPreviewStore);
    let delayPreviewLoad = false;
    slowPreviewStore.loadMap = async () => {
      if (delayPreviewLoad) {
        delayPreviewLoad = false;
        await new Promise(r => setTimeout(r, 40));
      }
      return origLoadMap();
    };

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: slowPreviewStore,
      configPath: join(tmp, 'config.toml'),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      installSignals: false,
      throttleMs: 5,
      replayDrainQuietMs: 20,
    });

    const runPromise = controller.run();
    await controller.readyPromise;

    // 1) P1-1: Standalone native `send('/compact')` passthrough MUST preserve draft + image attachment
    controller.store.draft.setText('keep this draft');
    controller.store.addAttachment({
      id: 'img-keep-1',
      kind: 'image',
      name: 'keep.png',
      mime: 'image/png',
      base64Data: 'BBBB',
    });
    host.input.emitTspEvent({ ev: 'send', sf: 'oma', id: EDITOR_NODE_ID, text: '/compact' });
    await waitFor(() => promptsReceived.length === 1);
    expect(promptsReceived[0]!.some(b => b['type'] === 'text' && b['text'] === '/compact')).toBe(true);
    expect(promptsReceived[0]!.some(b => b['type'] === 'image')).toBe(false);
    expect(controller.store.draft.text).toBe('keep this draft');
    expect(controller.store.getState().pendingAttachments).toHaveLength(1);
    controller.store.draft.reset();
    controller.store.clearAttachments();

    // 2) P1-2: `@` completion for `a,b.txt` quotes as `@"a,b.txt"` so submission attaches ONLY `a,b.txt` (never `a`)
    const { applyTriggerReplacement, detectCompletionTrigger } = await import('../src/editor/trigger');
    const trig = detectCompletionTrigger('check @a,b', 10);
    expect(trig?.kind).toBe('file');
    const rep = applyTriggerReplacement('check @a,b', trig!, 'a,b.txt');
    expect(rep.text).toBe('check @"a,b.txt" ');
    await controller.submitInput(rep.text);
    await waitFor(() => promptsReceived.length === 2);
    const resBlocks = promptsReceived[1]!.filter(b => b['type'] === 'resource') as Array<{
      resource?: { text?: string; uri?: string };
    }>;
    expect(resBlocks).toHaveLength(1);
    expect(resBlocks[0]!.resource?.text).toContain('TARGET_COMMA_FILE_CONTENT');
    expect(resBlocks.some(b => b.resource?.text?.includes('UNRELATED_FILE_A_CONTENT'))).toBe(false);

    // 3) P2-2: Historical completed tool output replaced with equal-length string (`before` -> `after!`) MUST re-render
    await controller.submitInput('run tool turn');
    await waitFor(
      () =>
        promptsReceived.length === 3 &&
        !controller.store.getState().isStreaming &&
        !controller.surface.blocked
    );
    await controller.submitInput('next turn to make turn 2 historical');
    await waitFor(
      () =>
        promptsReceived.length === 4 &&
        !controller.store.getState().isStreaming &&
        !controller.surface.blocked
    );
    const opsBeforeEqualReplace = host.allOps.length;
    controller.store.applySessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-eqlen',
      status: 'completed',
      rawOutput: 'after!',
    });
    controller.scheduler.renderNow();
    await waitFor(() => !controller.surface.blocked);
    const opsAfterEqualReplace = JSON.stringify(host.allOps.slice(opsBeforeEqualReplace));
    expect(opsAfterEqualReplace).toContain('after!');

    // 4) P1-4: `/resume` fast ACP failure while preview load is still in flight MUST NOT trigger unhandledRejection
    const unhandledErrors: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandledErrors.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      failNextSessionList = true;
      delayPreviewLoad = true;
      await controller.submitInput('/resume');
      await waitFor(() =>
        Boolean(controller.store.getState().picker?.error?.includes('fast session/list failure'))
      );
      await new Promise(r => setTimeout(r, 30));
      expect(unhandledErrors).toHaveLength(0);
      host.input.emit('\x1b');
      await waitFor(() => controller.store.getState().picker === null);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    // 5) P2-1: `settleTurn` while blocked on 1-credit deferred render MUST settle real `main.t<idx>-*` (never `main.turn-<idx>`)
    await waitFor(() => !controller.surface.blocked);
    host.setAutoAck(false);
    controller.store.pushToast('exhaust-credit-for-settle', 'info');
    controller.scheduler.renderNow();
    const settleBlockedSeq = controller.surface.seq;
    expect(controller.surface.blocked).toBe(true);

    // Add a new turn while blocked, schedule deferred render, and call settleTurn(newTurnIdx) before ACK
    const deferredTurn = controller.store.transcript.beginUserTurn('deferred settle prompt', []);
    controller.store.applySessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Deferred turn body' },
    });
    controller.store.transcript.finishActiveTurn('end_turn');
    controller.scheduler.renderNow();
    controller.scheduler.settleTurn(deferredTurn.index);

    const opsBeforeSettleAck = host.allOps.length;
    host.ackFrame('oma', settleBlockedSeq);
    await new Promise(r => setTimeout(r, 30));
    const settleOps = host.allOps
      .slice(opsBeforeSettleAck)
      .filter(op => op[0] === 'settle')
      .map(op => op[1]);
    expect(settleOps).not.toContain(`main.turn-${deferredTurn.index}`);
    expect(settleOps.some(id => typeof id === 'string' && id.startsWith(`main.t${deferredTurn.index}-`))).toBe(true);

    // 6) P1-3: While blocked on 1 credit with a deferred builder queued, switching session & suspending
    //    replay MUST cancel the old builder so an incoming ACK emits ZERO partial replay frames!
    const currentSeq = controller.surface.seq;
    host.ackFrame('oma', currentSeq);
    await waitFor(() => !controller.surface.blocked);

    // Fill credit again, queue a deferred render, then start `/resume` (which suspends replay)
    controller.store.pushToast('fill-before-resume', 'info');
    controller.scheduler.renderNow();
    const preResumeSeq = controller.surface.seq;
    expect(controller.surface.blocked).toBe(true);
    controller.store.pushToast('queued-deferred-builder', 'info');
    controller.scheduler.renderNow(); // queued as deferred builder on surface

    // Suspend for replay (simulating `/resume` transition) and add partial replayed turn
    controller.scheduler.resetSession();
    controller.scheduler.suspendForReplay();
    controller.store.transcript.clear();
    controller.store.transcript.beginUserTurn('PARTIAL_REPLAY_MUST_NOT_LEAK_ON_ACK', []);

    const opsBeforeSuspendedAck = host.allOps.length;
    host.ackFrame('oma', preResumeSeq);
    await new Promise(r => setTimeout(r, 30));
    const leakedDuringSuspend = JSON.stringify(host.allOps.slice(opsBeforeSuspendedAck));
    expect(leakedDuringSuspend).not.toContain('PARTIAL_REPLAY_MUST_NOT_LEAK_ON_ACK');

    // 7) P2-5: Per-surface `Gone` routing — a `gone` event for surface `other-sf` MUST NOT evict
    //    a same-named node or disable its callback on surface `oma`!
    host.setAutoAck(true);
    controller.scheduler.resumeAfterReplay(false);
    await waitFor(() => !controller.surface.blocked);

    const otherSurface = session.open({ id: 'other-sf', mode: 'inline' });
    let otherClicked = 0;
    otherSurface.render({
      main: (
        <col>
          <button
            key="shared-btn"
            text="Other"
            actions={{ click: 'click' }}
            onClick={() => {
              otherClicked += 1;
            }}
          />
        </col>
      ),
    });
    await waitFor(() => !otherSurface.blocked);

    // Evict `main.shared-btn` ONLY on `oma` — `other-sf`'s `main.shared-btn` callback must remain alive!
    host.input.emitTspEvent({ ev: 'gone', sf: 'oma', ids: ['main.shared-btn'] });
    await new Promise(r => setTimeout(r, 20));
    host.input.emitTspEvent({ ev: 'action', sf: 'other-sf', id: 'main.shared-btn', act: 'click' });
    await waitFor(() => otherClicked === 1);
    expect(otherClicked).toBe(1);

    // 8) P2 (cancelDeferred): cancelling a blocked pending view MUST:
    //    (a) restore event routing to the on-screen `#sent` view (never fire cancelled view's callback), AND
    //    (b) drop queued `settle` ops targeting nodes that were never flushed!
    host.setAutoAck(false);
    let sentBtnClicks = 0;
    let cancelledBtnClicks = 0;
    otherSurface.render({
      main: (
        <col>
          <button
            key="live-btn"
            text="Sent v1"
            actions={{ click: 'click' }}
            onClick={() => {
              sentBtnClicks += 1;
            }}
          />
        </col>
      ),
    });
    const otherSentSeq = otherSurface.seq;
    expect(otherSurface.blocked).toBe(true);

    // Queue an un-flushed replacement view with a DIFFERENT callback + a `settle` for an unsent node
    otherSurface.render({
      main: (
        <col>
          <button
            key="live-btn"
            text="Cancelled v2"
            actions={{ click: 'click' }}
            onClick={() => {
              cancelledBtnClicks += 1;
            }}
          />
          <text key="never-sent" text="ghost" />
        </col>
      ),
    });
    otherSurface.settle('main.never-sent');
    otherSurface.cancelDeferred();

    // Clicking the on-screen button MUST invoke the `#sent` v1 callback, NOT the cancelled v2 callback!
    host.input.emitTspEvent({ ev: 'action', sf: 'other-sf', id: 'main.live-btn', act: 'click' });
    await waitFor(() => sentBtnClicks === 1);
    expect(sentBtnClicks).toBe(1);
    expect(cancelledBtnClicks).toBe(0);

    // Flushing ACK MUST NOT emit `settle main.never-sent`
    const opsBeforeCancelAck = host.allOps.length;
    host.ackFrame('other-sf', otherSentSeq);
    await new Promise(r => setTimeout(r, 25));
    const cancelledSettleOps = host.allOps
      .slice(opsBeforeCancelAck)
      .filter(op => op[0] === 'settle' && op[1] === 'main.never-sent');
    expect(cancelledSettleOps).toHaveLength(0);

    host.setAutoAck(true);
    await otherSurface.close({ keep: false });

    holdReplayLoad.resolve();
    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });

  test('OMP parity Round 3 regressions: leading-@ filename mention isolation and historical tool kind/tookMs metadata update', async () => {
    const tmp = makeTempDir();
    writeFileSync(join(tmp, '@draft.md'), 'AT_PREFIX_DRAFT_CONTENT\n', 'utf8');
    writeFileSync(join(tmp, 'draft.md'), 'PLAIN_DRAFT_MUST_NOT_SEND\n', 'utf8');

    const host = new FakeTernHost();
    const session = await createConnectedSession(host);
    const acp = new MockAcpHarness();

    let clockNow = 10_000;
    const promptsReceived: Array<Array<Record<string, unknown>>> = [];
    let promptCount = 0;

    acp.setHandler((msg, server) => {
      if (msg.method === 'initialize') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
      } else if (msg.method === 'session/new') {
        server.send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-r3', configOptions: [] } });
      } else if (msg.method === 'session/prompt') {
        promptCount += 1;
        const p = msg.params as { prompt: Array<Record<string, unknown>> };
        promptsReceived.push(p.prompt);
        if (promptCount === 2) {
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-r3',
              update: {
                sessionUpdate: 'tool_call',
                toolCallId: 'tc-meta-1',
                title: 'Inspect',
                kind: 'read',
                status: 'completed',
                rawOutput: 'ok',
              },
            },
          });
          server.send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'sess-r3',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Turn 2 done' } },
            },
          });
        }
        server.send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      } else if (msg.id !== undefined) {
        server.send({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    const controller = new AppController({
      cli: parseCliArgs([]),
      config: DEFAULT_CONFIG,
      cwd: tmp,
      session,
      output: host.safeOutput,
      acpSpawn: acp.createSpawnFn(),
      previewStore: new PreviewStore({ sessionsDir: join(tmp, 'sessions') }),
      configPath: join(tmp, 'config.toml'),
      gitExec: async () => ({ exitCode: 128, stdout: '' }),
      now: () => clockNow,
      installSignals: false,
      throttleMs: 5,
    });
    const runPromise = controller.run();
    await controller.readyPromise;

    // 1) P1: Completing `@draft.md` quotes as `@"@draft.md"` so ONLY `@draft.md` is attached (never `draft.md`)
    const { applyTriggerReplacement, detectCompletionTrigger, formatFileMention, extractFileMentions } =
      await import('../src/editor/trigger');
    expect(formatFileMention('@draft.md')).toBe('@"@draft.md"');
    expect(extractFileMentions('check @"@draft.md" now').map(m => m.path)).toEqual(['@draft.md']);

    const trig = detectCompletionTrigger('read @@draft', 12);
    expect(trig?.kind).toBe('file');
    const rep = applyTriggerReplacement('read @@draft', trig!, '@draft.md');
    expect(rep.text).toBe('read @"@draft.md" ');
    await controller.submitInput(rep.text);
    await waitFor(() => promptsReceived.length === 1);
    const resBlocks = promptsReceived[0]!.filter(b => b['type'] === 'resource') as Array<{
      resource?: { text?: string };
    }>;
    expect(resBlocks).toHaveLength(1);
    expect(resBlocks[0]!.resource?.text).toContain('AT_PREFIX_DRAFT_CONTENT');
    expect(resBlocks.some(b => b.resource?.text?.includes('PLAIN_DRAFT_MUST_NOT_SEND'))).toBe(false);

    // 2) P2: Historical completed tool changes kind (`read` -> `search`) and tookMs (`0` -> `1150`) -> MUST re-render!
    await controller.submitInput('turn with read tool');
    await waitFor(() => promptsReceived.length === 2 && !controller.store.getState().isStreaming);
    await controller.submitInput('make previous turn historical');
    await waitFor(() => promptsReceived.length === 3 && !controller.store.getState().isStreaming);

    clockNow = 11_150;
    const opsBeforeMetaUpdate = host.allOps.length;
    controller.store.applySessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-meta-1',
      kind: 'search',
      status: 'completed',
      rawOutput: 'ok',
    });
    // Explicitly update elapsed duration as ACP completion metadata arrives
    const updatedTool = controller.store.transcript.getToolById('tc-meta-1');
    expect(updatedTool?.displayName).toBe('search');
    if (updatedTool) updatedTool.tookMs = 1150;
    controller.scheduler.renderNow();
    await new Promise(r => setTimeout(r, 25));

    const metaUpdateOps = host.allOps.slice(opsBeforeMetaUpdate);
    const serializedMetaOps = JSON.stringify(metaUpdateOps);
    expect(serializedMetaOps).toContain('"name":"search"');
    expect(serializedMetaOps).toContain('"took":1150');

    await controller.shutdown({ cleanExit: true });
    await runPromise;
  });
});
