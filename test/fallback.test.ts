import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AcpChildProcess, AcpSpawnFn } from '../src/acp/client';
import { saveSessionPreview } from '../src/preview/store';
import { getTranscriptPath } from '../src/state/session_metrics';
import {
  CliParseError,
  OMA_VERSION,
  createAcpPlainAdapter,
  formatVersionText,
  parseCliArgs,
  resolveResumeTarget,
  runFallbackAgy,
  runPlainRepl,
  stripOuterQuotes,
  translateFallbackArgs,
  type PlainAcpAdapter,
  type PlainAcpUpdate,
  type PlainPermissionRequest,
} from '../src/app/fallback';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oma-fallback-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('parseCliArgs', () => {
  test('parses empty argv with defaults', () => {
    const opts = parseCliArgs([]);
    expect(opts.continue).toBe(false);
    expect(opts.resume).toBeUndefined();
    expect(opts.resumeKind).toBeUndefined();
    expect(opts.sessions).toBe(false);
    expect(opts.model).toBeUndefined();
    expect(opts.thought).toBeUndefined();
    expect(opts.mode).toBeUndefined();
    expect(opts.addDirs).toEqual([]);
    expect(opts.agyBin).toBeUndefined();
    expect(opts.plain).toBe(false);
    expect(opts.noFallback).toBe(false);
    expect(opts.version).toBe(false);
    expect(opts.help).toBe(false);
    expect(opts.promptParts).toEqual([]);
    expect(opts.initialPrompt).toBeUndefined();
  });

  test('parses all supported flags in space-separated and equals forms', () => {
    const opts = parseCliArgs([
      '-c',
      '--sessions',
      '--model=gemini-4-neon-xhigh',
      '--thought',
      'high',
      '--mode=accept-edits',
      '--add-dir',
      'D:/dir1',
      '--add-dir=D:/dir2',
      '--agy-bin',
      'C:/bin/agy.exe',
      '--plain',
      '--no-fallback',
      'fix',
      'the',
      'bug',
    ]);
    expect(opts.continue).toBe(true);
    expect(opts.sessions).toBe(true);
    expect(opts.model).toBe('gemini-4-neon-xhigh');
    expect(opts.thought).toBe('high');
    expect(opts.mode).toBe('accept-edits');
    expect(opts.addDirs).toEqual(['D:/dir1', 'D:/dir2']);
    expect(opts.agyBin).toBe('C:/bin/agy.exe');
    expect(opts.plain).toBe(true);
    expect(opts.noFallback).toBe(true);
    expect(opts.promptParts).toEqual(['fix', 'the', 'bug']);
    expect(opts.initialPrompt).toBe('fix the bug');
  });

  test('distinguishes -r/--resume, --restore, and --fork', () => {
    const r1 = parseCliArgs(['-r', 'uuid-1']);
    expect(r1.resume).toBe('uuid-1');
    expect(r1.resumeKind).toBe('resume');

    const rConv = parseCliArgs(['--conversation', 'uuid-conv']);
    expect(rConv.resume).toBe('uuid-conv');
    expect(rConv.resumeKind).toBe('resume');

    const rConvEq = parseCliArgs(['--conversation=uuid-conv-eq']);
    expect(rConvEq.resume).toBe('uuid-conv-eq');
    expect(rConvEq.resumeKind).toBe('resume');

    const r2 = parseCliArgs(['--restore=C:/sessions/s1.json']);
    expect(r2.resume).toBe('C:/sessions/s1.json');
    expect(r2.resumeKind).toBe('restore');

    const r3 = parseCliArgs(['--fork', 'uuid-fork']);
    expect(r3.resume).toBe('uuid-fork');
    expect(r3.resumeKind).toBe('fork');

    const rEffort = parseCliArgs(['--effort', 'high']);
    expect(rEffort.thought).toBe('high');
    const rEffortEq = parseCliArgs(['--effort=xhigh']);
    expect(rEffortEq.thought).toBe('xhigh');
    expect(translateFallbackArgs(rEffortEq).args).toEqual(['--effort', 'xhigh']);
  });

  test('handles -- positional delimiter so flag-like words become prompt', () => {
    const opts = parseCliArgs(['--model', 'claude-opus-5-5', '--', '--unknown-flag', '-x']);
    expect(opts.model).toBe('claude-opus-5-5');
    expect(opts.promptParts).toEqual(['--unknown-flag', '-x']);
    expect(opts.initialPrompt).toBe('--unknown-flag -x');
  });

  test('supports --version and --help', () => {
    expect(parseCliArgs(['--version']).version).toBe(true);
    expect(parseCliArgs(['-v']).version).toBe(true);
    expect(parseCliArgs(['--help']).help).toBe(true);
    expect(parseCliArgs(['-h']).help).toBe(true);
    expect(formatVersionText()).toContain(`oma ${OMA_VERSION}`);
  });

  test('throws CliParseError on unknown flags or missing option values', () => {
    expect(() => parseCliArgs(['--does-not-exist'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['--model'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['--thought'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['--effort'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['--mode'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['--resume'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['--conversation'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['--add-dir'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['--plain=true'])).toThrow(CliParseError);
  });
});

describe('resolveResumeTarget & stripOuterQuotes', () => {
  test('strips matching outer single or double quotes', () => {
    expect(stripOuterQuotes(' "C:\\My Sessions\\abc.json" ')).toBe('C:\\My Sessions\\abc.json');
    expect(stripOuterQuotes("'uuid-123'")).toBe('uuid-123');
    expect(stripOuterQuotes('plain-uuid')).toBe('plain-uuid');
  });

  test('parses valid oma anchor JSON file (including paths with spaces and quotes)', () => {
    const dir = makeTempDir();
    const file = join(dir, 'my session anchor.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessionId: 'd9834138-aa41-4c57-8242-dbca52334d8f',
        cwd: 'D:\\Projects\\oh-my-agy',
        title: 'Oh My Agy 设计',
        model: 'gemini-4-neon',
        thoughtLevel: 'high',
      }),
      'utf8'
    );

    const resolved = resolveResumeTarget(`"${file}"`);
    expect(resolved.source).toBe('anchor_file');
    expect(resolved.sessionId).toBe('d9834138-aa41-4c57-8242-dbca52334d8f');
    expect(resolved.cwd).toBe('D:\\Projects\\oh-my-agy');
    expect(resolved.title).toBe('Oh My Agy 设计');
    expect(resolved.model).toBe('gemini-4-neon');
    expect(resolved.thoughtLevel).toBe('high');
  });

  test('parses optional mode field from anchor JSON', () => {
    const dir = makeTempDir();
    const file = join(dir, 'anchor-mode.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        sessionId: 'd9834138-aa41-4c57-8242-dbca52334d8f',
        cwd: dir,
        model: 'gemini-4-carbon',
        thoughtLevel: 'low',
        mode: 'plan',
      }),
      'utf8',
    );
    const resolved = resolveResumeTarget(file);
    expect(resolved.source).toBe('anchor_file');
    expect(resolved.model).toBe('gemini-4-carbon');
    expect(resolved.thoughtLevel).toBe('low');
    expect(resolved.mode).toBe('plan');
  });

  test('returns invalid_anchor for missing or malformed .json anchor files', () => {
    const dir = makeTempDir();
    const missing = join(dir, 'missing.json');
    const resMissing = resolveResumeTarget(missing);
    expect(resMissing.source).toBe('invalid_anchor');
    expect(resMissing.sessionId).toBeUndefined();

    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ invalid json', 'utf8');
    const resBroken = resolveResumeTarget(broken);
    expect(resBroken.source).toBe('invalid_anchor');
    expect(resBroken.sessionId).toBeUndefined();

    const noId = join(dir, 'noid.json');
    writeFileSync(noId, JSON.stringify({ version: 1, cwd: 'D:/a' }), 'utf8');
    const resNoId = resolveResumeTarget(noId);
    expect(resNoId.source).toBe('invalid_anchor');
    expect(resNoId.sessionId).toBeUndefined();
  });

  test('treats non-file raw ID as bare session ID', () => {
    const resolved = resolveResumeTarget('d9834138-aa41-4c57-8242-dbca52334d8f');
    expect(resolved.source).toBe('id');
    expect(resolved.sessionId).toBe('d9834138-aa41-4c57-8242-dbca52334d8f');
  });
});

describe('translateFallbackArgs (DESIGN.md 4.7)', () => {
  test('maps --thought to --effort, filters --mode default, and maps positional prompt to -i', () => {
    const cli = parseCliArgs([
      '--continue',
      '--model',
      'gemini-4-neon',
      '--thought',
      'xhigh',
      '--mode',
      'default',
      '--add-dir',
      'D:/extra1',
      '--add-dir',
      'D:/extra2',
      'explain',
      'this',
      'repo',
    ]);

    const { args, warnings } = translateFallbackArgs(cli);
    expect(warnings).toEqual([]);
    expect(args).toEqual([
      '--continue',
      '--model',
      'gemini-4-neon',
      '--effort',
      'xhigh',
      '--add-dir',
      'D:/extra1',
      '--add-dir',
      'D:/extra2',
      '-i',
      'explain this repo',
    ]);
    expect(args).not.toContain('--mode');
    expect(args).not.toContain('default');
  });

  test('passes through non-default --mode values (accept-edits, auto, plan)', () => {
    for (const mode of ['accept-edits', 'auto', 'plan']) {
      const cli = parseCliArgs(['--mode', mode]);
      const { args } = translateFallbackArgs(cli);
      expect(args).toEqual(['--mode', mode]);
    }
  });

  test('maps --resume, --restore, --fork anchor JSON to --conversation <uuid>', () => {
    const dir = makeTempDir();
    const anchor = join(dir, 'anchor.json');
    writeFileSync(
      anchor,
      JSON.stringify({
        version: 1,
        sessionId: '11111111-2222-3333-4444-555555555555',
        cwd: dir,
      }),
      'utf8'
    );

    for (const flag of ['--resume', '--restore', '--fork']) {
      const cli = parseCliArgs([flag, anchor]);
      const { args, warnings, resolvedResume } = translateFallbackArgs(cli);
      expect(warnings).toEqual([]);
      expect(args).toEqual(['--conversation', '11111111-2222-3333-4444-555555555555']);
      expect(resolvedResume?.source).toBe('anchor_file');
    }
  });

  test('does not pass oma-specific flags (--sessions, --plain, --no-fallback, --agy-bin) to agy', () => {
    const cli = parseCliArgs([
      '--sessions',
      '--no-fallback',
      '--agy-bin',
      '/custom/agy',
      '--thought',
      'low',
    ]);
    const { args } = translateFallbackArgs(cli);
    expect(args).toEqual(['--effort', 'low']);
  });

  test('emits warning and omits --conversation when anchor file is broken', () => {
    const dir = makeTempDir();
    const missing = join(dir, 'nope.json');
    const cli = parseCliArgs(['--restore', missing]);
    const { args, warnings } = translateFallbackArgs(cli);
    expect(args).toEqual([]);
    expect(warnings.length).toBe(1);
  });
});

describe('runFallbackAgy', () => {
  test('spawns configured agy binary with translated args and returns exit code', async () => {
    const captured: { cmd?: string[]; cwd?: string } = {};
    const cli = parseCliArgs([
      '--agy-bin',
      'custom-agy',
      '--thought',
      'high',
      '--mode',
      'default',
      'hello',
      'world',
    ]);

    const exitCode = await runFallbackAgy({
      cli,
      cwd: 'D:/work',
      spawn: (cmd, opts) => {
        captured.cmd = cmd;
        captured.cwd = opts.cwd;
        return { exited: Promise.resolve(42) };
      },
    });

    expect(exitCode).toBe(42);
    expect(captured.cmd).toEqual(['custom-agy', '--effort', 'high', '-i', 'hello world']);
    expect(captured.cwd).toBe('D:/work');
  });
});

describe('runPlainRepl (--plain)', () => {
  test('runs initial prompt, handles tool permission prompt, /new, and /quit', async () => {
    const stdin = new PassThrough();
    let out = '';
    let err = '';
    const stdout = { write: (chunk: string) => { out += chunk; return true; } };
    const stderr = { write: (chunk: string) => { err += chunk; return true; } };

    let updateCb: ((u: PlainAcpUpdate) => void) | undefined;
    let permCb:
      | ((
          req: PlainPermissionRequest
        ) => Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }>)
      | undefined;

    const prompts: string[] = [];
    const permDecisions: unknown[] = [];
    let sessionSeq = 0;
    const closedSessions: string[] = [];

    const adapter: PlainAcpAdapter = {
      async start() {},
      async initialize() {
        return { agentInfo: { name: 'agy', version: '1.5.13' } };
      },
      async newSession() {
        sessionSeq += 1;
        return { sessionId: `sess-${sessionSeq}` };
      },
      async loadSession(id) {
        return { sessionId: id };
      },
      async listSessions() {
        return [];
      },
      async prompt(_sid, text) {
        prompts.push(text);
        updateCb?.({ kind: 'tool', toolTitle: 'run_command', toolStatus: 'in_progress' });
        if (text === 'run cmd' && permCb) {
          const decision = await permCb({
            toolCallId: 'tc-1',
            title: 'Run ls',
            options: [
              { optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'opt-deny', name: 'Deny', kind: 'reject_once' },
            ],
          });
          permDecisions.push(decision);
        }
        updateCb?.({ kind: 'message', text: `reply:${text}` });
        return { stopReason: 'end_turn' };
      },
      async cancel() {},
      async closeSession(sid) {
        closedSessions.push(sid);
      },
      async shutdown() {},
      onUpdate(cb) {
        updateCb = cb;
      },
      onPermission(cb) {
        permCb = cb;
      },
    };

    const cli = parseCliArgs(['--plain', 'initial', 'hello']);
    const runPromise = runPlainRepl({
      cli,
      cwd: 'D:/work',
      adapter,
      stdin,
      stdout,
      stderr,
    });

    stdin.write('run cmd\n');
    stdin.write('y\n');
    stdin.write('/new\n');
    stdin.write('/quit\n');
    stdin.end();

    const code = await runPromise;
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(prompts).toEqual(['initial hello', 'run cmd']);
    expect(permDecisions).toEqual([{ outcome: 'selected', optionId: 'opt-allow' }]);
    expect(closedSessions).toEqual(['sess-1', 'sess-2']);
    expect(out).toContain('reply:initial hello');
    expect(out).toContain('reply:run cmd');
    expect(out).toContain('[new session sess-2]');
  });

  test('carries over CLI and interactive model, thought, and mode across /new and /clear and handles carry-over failures', async () => {
    const stdin = new PassThrough();
    let out = '';
    let err = '';
    const stdout = { write: (chunk: string) => { out += chunk; return true; } };
    const stderr = { write: (chunk: string) => { err += chunk; return true; } };

    let sessionSeq = 0;
    const configCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    let failModelOnSession = '';

    const adapter: PlainAcpAdapter = {
      async start() {},
      async initialize() {
        return { agentInfo: { name: 'agy', version: '1.5.14' } };
      },
      async newSession() {
        sessionSeq += 1;
        return { sessionId: `sess-plain-${sessionSeq}` };
      },
      async loadSession(id) {
        return { sessionId: id };
      },
      async listSessions() {
        return [];
      },
      async prompt() {
        return { stopReason: 'end_turn' };
      },
      async cancel() {},
      async setConfigOption(sid, configId, value) {
        configCalls.push({ sessionId: sid, configId, value });
        if (sid === failModelOnSession && configId === 'model') {
          throw new Error('model temporarily unavailable');
        }
      },
      async closeSession() {},
      async shutdown() {},
      onUpdate() {},
      onPermission() {},
    };

    const cli = parseCliArgs([
      '--plain',
      '--model',
      'gemini-4-carbon',
      '--thought',
      'medium',
      '--mode',
      'plan',
    ]);

    const runPromise = runPlainRepl({
      cli,
      cwd: 'D:/work',
      adapter,
      stdin,
      stdout,
      stderr,
    });

    stdin.write('/new\n');
    stdin.write('/model gemini-4-neon-xhigh\n');
    stdin.write('/mode auto\n');
    stdin.write('/clear\n');
    stdin.write('/thought low\n');
    failModelOnSession = 'sess-plain-4';
    stdin.write('/new\n');
    stdin.write('/quit\n');
    stdin.end();

    const code = await runPromise;
    expect(code).toBe(0);
    expect(configCalls).toEqual([
      // sess-plain-1 initial CLI flags
      { sessionId: 'sess-plain-1', configId: 'model', value: 'gemini-4-carbon' },
      { sessionId: 'sess-plain-1', configId: 'thought_level', value: 'medium' },
      { sessionId: 'sess-plain-1', configId: 'mode', value: 'plan' },
      // /new -> sess-plain-2 replays all three
      { sessionId: 'sess-plain-2', configId: 'model', value: 'gemini-4-carbon' },
      { sessionId: 'sess-plain-2', configId: 'thought_level', value: 'medium' },
      { sessionId: 'sess-plain-2', configId: 'mode', value: 'plan' },
      // interactive changes on sess-plain-2
      { sessionId: 'sess-plain-2', configId: 'model', value: 'gemini-4-neon-xhigh' },
      { sessionId: 'sess-plain-2', configId: 'mode', value: 'auto' },
      // /clear -> sess-plain-3 replays suffix model + mode (no stale medium thought)
      { sessionId: 'sess-plain-3', configId: 'model', value: 'gemini-4-neon-xhigh' },
      { sessionId: 'sess-plain-3', configId: 'mode', value: 'auto' },
      // interactive /thought low on sess-plain-3
      { sessionId: 'sess-plain-3', configId: 'thought_level', value: 'low' },
      // /new -> sess-plain-4 fails model carry-over, skips thought_level, still restores mode
      { sessionId: 'sess-plain-4', configId: 'model', value: 'gemini-4-neon-xhigh' },
      { sessionId: 'sess-plain-4', configId: 'mode', value: 'auto' },
    ]);
    expect(err).toContain('[oma] warning: failed to carry over model "gemini-4-neon-xhigh": model temporarily unavailable');
    expect(out).toContain('[new session sess-plain-2]');
    expect(out).toContain('[new session sess-plain-3]');
    expect(out).toContain('[new session sess-plain-4]');
  });

  test('createAcpPlainAdapter exposes live control state and diff-skips unchanged controls across /new', async () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const setConfigCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    let sessionSeq = 0;

    const buildConfigOptions = (model: string, thought: string, mode: string) => [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: model,
        options: [
          { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
          { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        ],
      },
      {
        id: 'thought_level',
        name: 'Thought Level',
        category: 'thought_level',
        type: 'select',
        currentValue: thought,
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: mode,
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ];

    const spawn: AcpSpawnFn = (): AcpChildProcess => {
      let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const exited = Promise.withResolvers<number>();
      const sessionValues = new Map<string, { model: string; thought: string; mode: string }>();
      let buf = '';

      const send = (payload: Record<string, unknown>) => {
        stdoutController?.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };

      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            stdoutController = controller;
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start() {},
        }),
        exited: exited.promise,
        pid: 4242,
        stdin: {
          write(chunk) {
            buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk);
            for (;;) {
              const nl = buf.indexOf('\n');
              if (nl < 0) break;
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              const msg = JSON.parse(line) as {
                id?: number | string;
                method?: string;
                params?: Record<string, unknown>;
              };
              if (msg.method === 'initialize') {
                send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
              } else if (msg.method === 'session/new') {
                sessionSeq += 1;
                const sid = `sess-acp-${sessionSeq}`;
                const initVals = { model: 'gemini-4-neon', thought: 'high', mode: 'default' };
                sessionValues.set(sid, initVals);
                send({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: {
                    sessionId: sid,
                    configOptions: buildConfigOptions(initVals.model, initVals.thought, initVals.mode),
                  },
                });
              } else if (msg.method === 'session/set_config_option') {
                const p = msg.params as { sessionId: string; configId: string; value: string };
                setConfigCalls.push({ sessionId: p.sessionId, configId: p.configId, value: p.value });
                const cur = sessionValues.get(p.sessionId) ?? {
                  model: 'gemini-4-neon',
                  thought: 'high',
                  mode: 'default',
                };
                if (p.configId === 'model') cur.model = p.value;
                else if (p.configId === 'thought_level') cur.thought = p.value;
                else if (p.configId === 'mode') cur.mode = p.value;
                sessionValues.set(p.sessionId, cur);
                send({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: {
                    configOptions: buildConfigOptions(cur.model, cur.thought, cur.mode),
                  },
                });
              } else if (msg.id !== undefined) {
                send({ jsonrpc: '2.0', id: msg.id, result: {} });
              }
            }
          },
          flush() {},
          end() {
            try {
              stdoutController?.close();
            } catch {}
            exited.resolve(0);
          },
        },
        kill() {
          try {
            stdoutController?.close();
          } catch {}
          exited.resolve(0);
        },
      };
    };

    const adapter = createAcpPlainAdapter({ spawn, cwd: 'D:/work' });
    const stdin = new PassThrough();
    let out = '';
    let err = '';
    const runPromise = runPlainRepl({
      cli: parseCliArgs(['--plain']),
      cwd: 'D:/work',
      adapter,
      stdin,
      stdout: { write: chunk => { out += chunk; return true; } },
      stderr: { write: chunk => { err += chunk; return true; } },
    });

    stdin.write('/thought low\n');
    stdin.write('/new\n');
    stdin.write('/quit\n');
    stdin.end();

    const code = await runPromise;
    expect(code).toBe(0);
    expect(err).toBe('');
    // Since model (`gemini-4-neon`) and mode (`default`) already match new session defaults,
    // only `thought_level=low` is replayed onto `sess-acp-2`.
    expect(setConfigCalls).toEqual([
      { sessionId: 'sess-acp-1', configId: 'thought_level', value: 'low' },
      { sessionId: 'sess-acp-2', configId: 'thought_level', value: 'low' },
    ]);
    expect(adapter.getControlState?.()).toEqual({
      modelId: 'gemini-4-neon',
      supportsThoughtLevel: true,
      thoughtLevel: 'low',
      modeId: 'default',
    });
    expect(out).toContain('[new session sess-acp-2]');
  });

  test('--continue and --resume restore saved controls from anchor JSON and fall back to transcript.jsonl in --plain mode', async () => {
    const tmp = makeTempDir();
    const sessionsDir = join(tmp, 'sessions');
    const brainDir = join(tmp, 'brain');
    await saveSessionPreview(
      {
        sessionId: 'sess-plain-anchor',
        cwd: 'D:/work',
        title: 'Plain Saved Session',
        model: 'gemini-4-carbon',
        thoughtLevel: 'low',
        mode: 'plan',
        preview: [],
      },
      { sessionsDir },
    );

    const transcriptPath = getTranscriptPath('sess-plain-transcript', { baseBrainDir: brainDir });
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-low' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-flash-worker-agy' }),
      ].join('\n') + '\n',
      'utf8',
    );

    // 1) `--continue` restores anchor model, thoughtLevel, and mode; CLI override wins when passed
    const calls1: Array<{ sessionId: string; configId: string; value: string }> = [];
    const makeResumeAdapter = (calls: Array<{ sessionId: string; configId: string; value: string }>): PlainAcpAdapter => ({
      async start() {},
      async initialize() {
        return { agentInfo: { name: 'agy', version: '1.5.14' } };
      },
      async newSession() {
        return { sessionId: 'sess-fallback-new' };
      },
      async loadSession(id) {
        return { sessionId: id };
      },
      async listSessions() {
        return [
          {
            sessionId: 'sess-plain-anchor',
            cwd: 'D:/work',
            title: 'Plain Saved Session',
            updatedAt: '2026-11-23T09:00:00.000Z',
          },
        ];
      },
      async prompt() {
        return { stopReason: 'end_turn' };
      },
      async cancel() {},
      async setConfigOption(sid, configId, value) {
        calls.push({ sessionId: sid, configId, value });
      },
      async closeSession() {},
      async shutdown() {},
      onUpdate() {},
      onPermission() {},
    });

    const stdin1 = new PassThrough();
    stdin1.write('/quit\n');
    stdin1.end();
    expect(
      await runPlainRepl({
        cli: parseCliArgs(['--plain', '-c']),
        cwd: 'D:/work',
        adapter: makeResumeAdapter(calls1),
        stdin: stdin1,
        stdout: { write: () => true },
        stderr: { write: () => true },
        sessionsDir,
        baseBrainDir: brainDir,
      }),
    ).toBe(0);
    expect(calls1).toEqual([
      { sessionId: 'sess-plain-anchor', configId: 'model', value: 'gemini-4-carbon' },
      { sessionId: 'sess-plain-anchor', configId: 'thought_level', value: 'low' },
      { sessionId: 'sess-plain-anchor', configId: 'mode', value: 'plan' },
    ]);

    const callsOverride: Array<{ sessionId: string; configId: string; value: string }> = [];
    const stdinOverride = new PassThrough();
    stdinOverride.write('/quit\n');
    stdinOverride.end();
    expect(
      await runPlainRepl({
        cli: parseCliArgs(['--plain', '-c', '--model', 'gemini-4-neon', '--mode', 'auto']),
        cwd: 'D:/work',
        adapter: makeResumeAdapter(callsOverride),
        stdin: stdinOverride,
        stdout: { write: () => true },
        stderr: { write: () => true },
        sessionsDir,
        baseBrainDir: brainDir,
      }),
    ).toBe(0);
    expect(callsOverride).toEqual([
      { sessionId: 'sess-plain-anchor', configId: 'model', value: 'gemini-4-neon' },
      { sessionId: 'sess-plain-anchor', configId: 'mode', value: 'auto' },
    ]);

    // 2) `--resume` on a transcript-only session via `createAcpPlainAdapter` skips worker model & splits `gemini-4-carbon-low`
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const acpSetCalls: Array<{ sessionId: string; configId: string; value: string }> = [];
    const buildConfigOptions = (model: string, thought: string, mode: string) => [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: model,
        options: [
          { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
          { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        ],
      },
      {
        id: 'thought_level',
        name: 'Thought Level',
        category: 'thought_level',
        type: 'select',
        currentValue: thought,
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: mode,
        options: [
          { value: 'default', name: 'Default' },
          { value: 'plan', name: 'Plan' },
        ],
      },
    ];
    const spawn: AcpSpawnFn = (): AcpChildProcess => {
      let stdoutController: ReadableStreamDefaultController<Uint8Array> | null = null;
      const exited = Promise.withResolvers<number>();
      const sessionValues = new Map<string, { model: string; thought: string; mode: string }>();
      let buf = '';
      const send = (payload: Record<string, unknown>) => {
        stdoutController?.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };
      return {
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            stdoutController = controller;
          },
        }),
        stderr: new ReadableStream<Uint8Array>({ start() {} }),
        exited: exited.promise,
        pid: 4343,
        stdin: {
          write(chunk) {
            buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk);
            for (;;) {
              const nl = buf.indexOf('\n');
              if (nl < 0) break;
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              const msg = JSON.parse(line) as {
                id?: number | string;
                method?: string;
                params?: Record<string, unknown>;
              };
              if (msg.method === 'initialize') {
                send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
              } else if (msg.method === 'session/load') {
                const p = msg.params as { sessionId: string };
                const initVals = { model: 'gemini-4-neon', thought: 'high', mode: 'default' };
                sessionValues.set(p.sessionId, initVals);
                send({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: {
                    sessionId: p.sessionId,
                    configOptions: buildConfigOptions(initVals.model, initVals.thought, initVals.mode),
                  },
                });
              } else if (msg.method === 'session/set_config_option') {
                const p = msg.params as { sessionId: string; configId: string; value: string };
                acpSetCalls.push({ sessionId: p.sessionId, configId: p.configId, value: p.value });
                const cur = sessionValues.get(p.sessionId) ?? {
                  model: 'gemini-4-neon',
                  thought: 'high',
                  mode: 'default',
                };
                if (p.configId === 'model') cur.model = p.value;
                else if (p.configId === 'thought_level') cur.thought = p.value;
                else if (p.configId === 'mode') cur.mode = p.value;
                sessionValues.set(p.sessionId, cur);
                send({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: { configOptions: buildConfigOptions(cur.model, cur.thought, cur.mode) },
                });
              } else if (msg.id !== undefined) {
                send({ jsonrpc: '2.0', id: msg.id, result: {} });
              }
            }
          },
          flush() {},
          end() {
            try {
              stdoutController?.close();
            } catch {}
            exited.resolve(0);
          },
        },
        kill() {
          try {
            stdoutController?.close();
          } catch {}
          exited.resolve(0);
        },
      };
    };

    const acpAdapter = createAcpPlainAdapter({ spawn, cwd: 'D:/work' });
    const stdin2 = new PassThrough();
    stdin2.write('/quit\n');
    stdin2.end();
    expect(
      await runPlainRepl({
        cli: parseCliArgs(['--plain', '--resume', 'sess-plain-transcript']),
        cwd: 'D:/work',
        adapter: acpAdapter,
        stdin: stdin2,
        stdout: { write: () => true },
        stderr: { write: () => true },
        sessionsDir,
        baseBrainDir: brainDir,
      }),
    ).toBe(0);
    expect(acpSetCalls).toEqual([
      { sessionId: 'sess-plain-transcript', configId: 'model', value: 'gemini-4-carbon' },
      { sessionId: 'sess-plain-transcript', configId: 'thought_level', value: 'low' },
    ]);
    expect(acpAdapter.getControlState?.()).toEqual({
      modelId: 'gemini-4-carbon',
      supportsThoughtLevel: true,
      thoughtLevel: 'low',
      modeId: 'default',
    });
  });
});

