import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  CliParseError,
  OMA_VERSION,
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

    const r2 = parseCliArgs(['--restore=C:/sessions/s1.json']);
    expect(r2.resume).toBe('C:/sessions/s1.json');
    expect(r2.resumeKind).toBe('restore');

    const r3 = parseCliArgs(['--fork', 'uuid-fork']);
    expect(r3.resume).toBe('uuid-fork');
    expect(r3.resumeKind).toBe('fork');
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
    expect(() => parseCliArgs(['--mode'])).toThrow(CliParseError);
    expect(() => parseCliArgs(['--resume'])).toThrow(CliParseError);
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
});

