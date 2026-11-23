import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  dispatchSlashCommand,
  executeCommandAction,
  parseCopyReverseIndex,
  parseSettingsPageArg,
  parseSlashInput,
  type CommandActionExecutor,
} from '../src/commands/handlers';
import {
  ALL_BUILTIN_COMMANDS,
  BUILTIN_COMMANDS,
  CommandRegistry,
  fuzzyMatchText,
  isAcpSkillCommand,
  resolveAcpCommandIcon,
} from '../src/commands/registry';
import {
  clampUtf16Offset,
  DraftEngine,
  nextCodePointOffset,
  prevCodePointOffset,
} from '../src/editor/draft';
import { InputHistory } from '../src/editor/history';
import { applyTriggerReplacement, detectCompletionTrigger } from '../src/editor/trigger';
import {
  ApprovalQueue,
  mapPermissionOptions,
  matchToolRule,
  type PermissionResponsePayload,
} from '../src/state/approval';
import {
  AppStore,
  COMPLETION_LIST_PREFIX,
  EDITOR_NODE_ID,
  formatContextUsage,
  inferModelProvider,
  MAX_COMPLETION_ITEMS,
  SETTINGS_NODE_PREFIX,
} from '../src/state/store';
import { sanitizeTrafficPayload, TrafficBuffer } from '../src/state/traffic';
import {
  buildElicitationContent,
  buildQuestionCardFromElicitation,
  formatFullLocalTime,
  formatTurnTime,
  LONG_RUNNING_TOOL_THRESHOLD_MS,
  TranscriptStore,
} from '../src/state/transcript';
import {
  createOscWriter,
  encodeTitleAndHideCursor,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from '../src/termio/osc';
import { SafeTermOutput } from '../src/termio/output';

// ---------------------------------------------------------------------------
// 1. DraftEngine: UTF-16 Key Track, CJK, Multi-line, Emoji Surrogate Pairs
// ---------------------------------------------------------------------------

describe('DraftEngine (Key track & UTF-16 surrogate safety)', () => {
  test('handles CJK, ASCII, IME multi-char commits and surrogate-pair emojis without splitting', () => {
    const engine = new DraftEngine();

    // Insert Chinese + Emoji (😀 is 2 UTF-16 code units, 🚀 is 2 UTF-16 code units)
    expect(engine.handleKey({ name: '你', text: '你好' })).toEqual({ handled: true, changed: true });
    expect(engine.handleKey({ name: '😀', text: '😀' })).toEqual({ handled: true, changed: true });
    expect(engine.handleKey({ name: 'a', text: 'A' })).toEqual({ handled: true, changed: true });
    expect(engine.handleKey({ name: '🚀', text: '🚀' })).toEqual({ handled: true, changed: true });

    expect(engine.text).toBe('你好😀A🚀');
    // UTF-16 lengths: 你(1) 好(1) 😀(2) A(1) 🚀(2) = 7
    expect(engine.text.length).toBe(7);
    expect(engine.cursor).toBe(7);

    // Move left across 🚀 (7 -> 5), A (5 -> 4), 😀 (4 -> 2)
    engine.handleKey({ name: 'left' });
    expect(engine.cursor).toBe(5);
    engine.handleKey({ name: 'left' });
    expect(engine.cursor).toBe(4);
    engine.handleKey({ name: 'left' });
    expect(engine.cursor).toBe(2);

    // Move right across 😀 (2 -> 4)
    engine.handleKey({ name: 'right' });
    expect(engine.cursor).toBe(4);

    // Backspace deletes whole surrogate pair 😀 (not half!)
    engine.handleKey({ name: 'backspace' });
    expect(engine.text).toBe('你好A🚀');
    expect(engine.cursor).toBe(2);

    // Move right past 'A' (2 -> 3), Delete removes whole 🚀 (3..5)
    engine.handleKey({ name: 'right' });
    expect(engine.cursor).toBe(3);
    engine.handleKey({ name: 'delete' });
    expect(engine.text).toBe('你好A');
    expect(engine.cursor).toBe(3);

    // Verify UTF-16 clamp helpers never land inside a surrogate pair
    const s = 'a𠀀b'; // 𠀀 occupies indices 1..2
    expect(s.length).toBe(4);
    expect(clampUtf16Offset(s, 2, 'left')).toBe(1);
    expect(clampUtf16Offset(s, 2, 'right')).toBe(3);
    expect(prevCodePointOffset(s, 3)).toBe(1);
    expect(nextCodePointOffset(s, 1)).toBe(3);
  });

  test('supports Shift+Enter/Alt+Enter newlines, Home/End, Ctrl+A/E, word nav/delete, Up/Down lines, and paste', () => {
    const engine = new DraftEngine();
    engine.insertText('hello world');

    // Shift+Enter & Alt+Enter insert newline; plain Enter passes through
    expect(engine.handleKey({ name: 'enter' })).toEqual({ handled: false, changed: false });
    expect(engine.handleKey({ name: 'enter', shift: true })).toEqual({ handled: true, changed: true });
    engine.insertText('第二行 foo_bar');
    expect(engine.handleKey({ name: 'enter', alt: true })).toEqual({ handled: true, changed: true });
    engine.insertText('line3');

    expect(engine.text).toBe('hello world\n第二行 foo_bar\nline3');

    // Home / End / Ctrl+A / Ctrl+E operate on current logical line
    engine.handleKey({ name: 'a', ctrl: true });
    expect(engine.cursor).toBe('hello world\n第二行 foo_bar\n'.length);
    engine.handleKey({ name: 'e', ctrl: true });
    expect(engine.cursor).toBe(engine.text.length);

    // Down on last line passes through for history navigation
    expect(engine.handleKey({ name: 'down' })).toEqual({ handled: false, changed: false });

    // Up moves across logical lines; Up on first line passes through
    expect(engine.handleKey({ name: 'up' })).toEqual({ handled: true, changed: true });
    expect(engine.handleKey({ name: 'up' })).toEqual({ handled: true, changed: true });
    expect(engine.handleKey({ name: 'up' })).toEqual({ handled: false, changed: false });

    // Home / End on first line
    engine.handleKey({ name: 'home' });
    expect(engine.cursor).toBe(0);
    engine.handleKey({ name: 'right', ctrl: true });
    expect(engine.cursor).toBe(5); // after "hello"
    engine.handleKey({ name: 'right', ctrl: true });
    expect(engine.cursor).toBe(11); // after "world"
    engine.handleKey({ name: 'left', ctrl: true });
    expect(engine.cursor).toBe(6); // start of "world"

    // Ctrl+Delete removes "world"
    engine.handleKey({ name: 'delete', ctrl: true });
    expect(engine.text.startsWith('hello \n')).toBe(true);

    // Ctrl+Backspace removes "hello "
    engine.handleKey({ name: 'backspace', ctrl: true });
    expect(engine.text.startsWith('\n')).toBe(true);

    // Bracketed paste normalizes CRLF -> LF
    engine.handleKey({ name: 'paste', text: 'A\r\nB\rC' });
    expect(engine.text.startsWith('A\nB\nC\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. DraftEngine: EditEvent Track & Strict `len` Guard + Undo Stack
// ---------------------------------------------------------------------------

describe('DraftEngine (EditEvent track & Undo coalescing/limit)', () => {
  test('applies valid EditEvent selection replacement and cursor-only move', () => {
    const engine = new DraftEngine({ initialText: '你好😀世界', initialCursor: 6 });
    expect(engine.text.length).toBe(6);

    // Replace "😀" (UTF-16 range [2, 4)) with "🚀!"
    const accepted = engine.applyEdit({
      from: 2,
      to: 4,
      text: '🚀!',
      cursor: 5,
      len: 6,
    });
    expect(accepted).toBe(true);
    expect(engine.text).toBe('你好🚀!世界');
    expect(engine.cursor).toBe(5);
    expect(engine.undoDepth).toBe(1);

    // Click cursor move (from === to, text === ''): accepted without pushing undo
    const moved = engine.applyEdit({
      from: 2,
      to: 2,
      text: '',
      cursor: 2,
      len: engine.text.length,
    });
    expect(moved).toBe(true);
    expect(engine.cursor).toBe(2);
    expect(engine.undoDepth).toBe(1);

    // Undo restores previous text & cursor
    expect(engine.undo()).toBe(true);
    expect(engine.text).toBe('你好😀世界');
    expect(engine.cursor).toBe(6);
    expect(engine.undoDepth).toBe(0);
  });

  test('strictly ignores EditEvent when e.len !== text.length (keys in flight)', () => {
    const engine = new DraftEngine({ initialText: 'hello', initialCursor: 5 });

    // Stale EditEvent with len=4 while text.length=5 must be completely ignored
    const staleShort = engine.applyEdit({
      from: 0,
      to: 4,
      text: 'REPLACED',
      cursor: 8,
      len: 4,
    });
    expect(staleShort).toBe(false);
    expect(engine.text).toBe('hello');
    expect(engine.cursor).toBe(5);
    expect(engine.undoDepth).toBe(0);

    // Stale EditEvent with len=6 must also be strictly ignored
    const staleLong = engine.applyEdit({
      from: 0,
      to: 5,
      text: '',
      cursor: 0,
      len: 6,
    });
    expect(staleLong).toBe(false);
    expect(engine.text).toBe('hello');
    expect(engine.cursor).toBe(5);
    expect(engine.undoDepth).toBe(0);
  });

  test('coalesces continuous single-char typing within 500ms, splits after 500ms, and enforces 200-step undo cap', () => {
    let clock = 1000;
    const engine = new DraftEngine({ now: () => clock });

    // Type "abc" within 500ms -> 1 coalesced undo step
    engine.handleKey({ name: 'a', text: 'a' });
    clock += 200;
    engine.handleKey({ name: 'b', text: 'b' });
    clock += 300; // exactly 500ms since 'b' -> still coalesced
    engine.handleKey({ name: 'c', text: 'c' });
    expect(engine.text).toBe('abc');
    expect(engine.undoDepth).toBe(1);

    // Wait 501ms -> starts a new undo group
    clock += 501;
    engine.handleKey({ name: 'd', text: 'd' });
    expect(engine.text).toBe('abcd');
    expect(engine.undoDepth).toBe(2);

    // EditEvent is always its own atomic undo step
    engine.applyEdit({ from: 4, to: 4, text: 'e', cursor: 5, len: 4 });
    expect(engine.text).toBe('abcde');
    expect(engine.undoDepth).toBe(3);

    expect(engine.undo()).toBe(true);
    expect(engine.text).toBe('abcd');
    expect(engine.undo()).toBe(true);
    expect(engine.text).toBe('abc');
    expect(engine.undo()).toBe(true);
    expect(engine.text).toBe('');
    expect(engine.undo()).toBe(false);

    // 200-step cap verification
    const capped = new DraftEngine({ now: () => (clock += 1000) });
    for (let i = 0; i < 215; i++) {
      capped.insertText('x', { coalesce: false });
    }
    expect(capped.text.length).toBe(215);
    expect(capped.undoDepth).toBe(200);

    let undoCount = 0;
    while (capped.undo()) {
      undoCount++;
    }
    expect(undoCount).toBe(200);
    expect(capped.text.length).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 3. InputHistory: Up/Down navigation & JSONL persistence
// ---------------------------------------------------------------------------

describe('InputHistory', () => {
  test('persists to JSONL, skips malformed lines, navigates Up/Down and restores stashed draft', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'oma-history-'));
    const filePath = path.join(tmpDir, 'history.jsonl');

    try {
      const h1 = new InputHistory({ filePath });
      expect(await h1.push('   ')).toBe(false);
      expect(await h1.push('first prompt', 'D:\\repo')).toBe(true);
      expect(await h1.push('first prompt')).toBe(false); // dedupe consecutive
      expect(await h1.push('second 中文 prompt')).toBe(true);

      // Inject a corrupted JSONL line to verify tolerant loading
      const existing = await readFile(filePath, 'utf8');
      await writeFile(filePath, `${existing}not-json-line\n`, 'utf8');

      const h2 = new InputHistory({ filePath });
      await h2.load();
      expect(h2.length).toBe(2);

      // Up/Down navigation preserves unsent draft
      expect(h2.previous('wip draft')).toBe('second 中文 prompt');
      expect(h2.previous('second 中文 prompt')).toBe('first prompt');
      expect(h2.previous('first prompt')).toBeNull();
      expect(h2.next()).toBe('second 中文 prompt');
      expect(h2.next()).toBe('wip draft');
      expect(h2.next()).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Trigger detection & replacement
// ---------------------------------------------------------------------------

describe('Completion trigger detection & replacement', () => {
  test('detects `/` slash commands and `@` file triggers without false positives on emails', () => {
    expect(detectCompletionTrigger('/', 1)).toEqual({
      kind: 'slash',
      start: 0,
      end: 1,
      query: '',
      raw: '/',
    });
    expect(detectCompletionTrigger('/res', 4)).toEqual({
      kind: 'slash',
      start: 0,
      end: 4,
      query: 'res',
      raw: '/res',
    });
    // Once space follows command name, no longer in slash command name trigger
    expect(detectCompletionTrigger('/model gemini', 13)).toBeNull();
    // Second line starting with '/' should not trigger slash completion
    expect(detectCompletionTrigger('line1\n/etc/hosts', 16)).toBeNull();

    // `@file` trigger at start, after whitespace, after punctuation, and after slash command
    expect(detectCompletionTrigger('@src/app', 8)).toEqual({
      kind: 'file',
      start: 0,
      end: 8,
      query: 'src/app',
      raw: '@src/app',
    });
    const zhFileInput = '请检查 @src/editor/dr';
    expect(detectCompletionTrigger(zhFileInput, zhFileInput.length)).toEqual({
      kind: 'file',
      start: 4,
      end: zhFileInput.length,
      query: 'src/editor/dr',
      raw: '@src/editor/dr',
    });
    expect(detectCompletionTrigger('/plan (@README', 14)).toEqual({
      kind: 'file',
      start: 7,
      end: 14,
      query: 'README',
      raw: '@README',
    });
    // Emails must NOT trigger `@` file completion
    expect(detectCompletionTrigger('contact user@example.com', 24)).toBeNull();

    // Replacement helper
    const trig = detectCompletionTrigger('check @src/ed here', 13)!;
    const replaced = applyTriggerReplacement('check @src/ed here', trig, 'src/editor/draft.ts');
    expect(replaced.text).toBe('check @src/editor/draft.ts here');
    expect(replaced.cursor).toBe(26);
  });
});

// ---------------------------------------------------------------------------
// 5. TrafficBuffer: ring overflow, sanitization & JSONL export
// ---------------------------------------------------------------------------

describe('TrafficBuffer', () => {
  test('sanitizes sensitive fields, truncates large payloads, enforces ring cap and exports JSONL', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'oma-traffic-'));
    const outPath = path.join(tmpDir, 'traffic.jsonl');

    try {
      const sanitized = sanitizeTrafficPayload({
        authorization: 'Bearer secret-xyz',
        apiKey: 'sk-1234',
        nested: {
          access_token: 'tok-999',
          data: 'A'.repeat(300),
          safe: 'ok',
        },
      }) as Record<string, unknown>;

      expect(sanitized.authorization).toBe('[REDACTED]');
      expect(sanitized.apiKey).toBe('[REDACTED]');
      const nested = sanitized.nested as Record<string, unknown>;
      expect(nested.access_token).toBe('[REDACTED]');
      expect(String(nested.data)).toContain('[BINARY_OR_BASE64');
      expect(nested.safe).toBe('ok');

      const buf = new TrafficBuffer({ maxEntries: 3 });
      buf.recordRpcOut({ jsonrpc: '2.0', id: 1, method: 'initialize' });
      buf.recordRpcIn({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
      buf.recordStderr('warning: slow response');
      buf.recordTernError({ id: 'main.turn-0', message: 'unknown node' });

      expect(buf.size).toBe(3);
      expect(buf.totalRecorded).toBe(4);
      expect(buf.list().map((e) => e.seq)).toEqual([2, 3, 4]);
      expect(buf.list({ direction: 'tern-error' })).toHaveLength(1);

      const written = await buf.exportToFile(outPath);
      expect(written).toBe(3);
      const lines = (await readFile(outPath, 'utf8')).trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(JSON.parse(lines[2]!).direction).toBe('tern-error');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. ApprovalQueue: auto_allow_tools rules, option mapping, batch cancel
// ---------------------------------------------------------------------------

describe('ApprovalQueue', () => {
  test('matches exact, wildcard, and boundary-safe prefix rules without false positives', () => {
    expect(matchToolRule('read_file', 'read_file')).toBe(true);
    expect(matchToolRule('read_file', 'read')).toBe(true);
    expect(matchToolRule('read_file', 'read_*')).toBe(true);
    expect(matchToolRule('mcp_github_list_prs', 'mcp_github_')).toBe(true);
    // Must not falsely match unrelated word sharing letters without boundary
    expect(matchToolRule('ready_to_delete', 'read')).toBe(false);
    expect(matchToolRule('run_command', 'read_file')).toBe(false);
  });

  test('auto-allows matching tools immediately and queues others with proper option mapping & cancelAll', () => {
    const responses: Array<{ id: string | number; res: PermissionResponsePayload }> = [];
    const queue = new ApprovalQueue({ autoAllowTools: ['read_file', 'mcp_docs_*'] });

    // 1. Auto-allowed tool
    const autoRes = queue.enqueue(
      10,
      {
        sessionId: 's1',
        toolCall: { toolCallId: 'tc-read', name: 'read_file', kind: 'read', title: 'Read README.md' },
        options: [
          { optionId: 'opt-once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'opt-deny', name: 'Reject', kind: 'reject_once' },
        ],
      },
      (res) => responses.push({ id: 10, res }),
    );
    expect(autoRes.autoAllowed).toBe(true);
    expect(queue.size).toBe(0);
    expect(responses[0]).toEqual({
      id: 10,
      res: { outcome: { outcome: 'selected', optionId: 'opt-once' } },
    });

    // 2. Manual approval WITHOUT allow_always
    const q1 = queue.enqueue(
      11,
      {
        sessionId: 's1',
        toolCall: { toolCallId: 'tc-bash-1', name: 'run_command', kind: 'execute', title: 'Run git status' },
        options: [
          { optionId: 'o1', name: 'Allow', kind: 'allow_once' },
          { optionId: 'r1', name: 'Deny', kind: 'reject_once' },
        ],
      },
      (res) => responses.push({ id: 11, res }),
    );
    expect(q1.autoAllowed).toBe(false);
    if (!q1.autoAllowed) {
      expect(q1.item.mapped.ask.always).toBe(false);
    }
    // Pressing 'always' when no allow_always exists must return null and keep item queued
    expect(queue.decide('always')).toBeNull();
    expect(queue.size).toBe(1);

    // 3. Manual approval WITH allow_always
    const mappedWithAlways = mapPermissionOptions([
      { optionId: 'o2', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'r2', name: 'Reject', kind: 'reject_once' },
    ]);
    expect(mappedWithAlways.ask.always).toBe('Always allow');

    queue.enqueue(
      12,
      {
        sessionId: 's1',
        toolCall: { toolCallId: 'tc-bash-2', name: 'run_command', kind: 'execute' },
        options: [
          { optionId: 'o2', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'r2', name: 'Reject', kind: 'reject_once' },
        ],
      },
      (res) => responses.push({ id: 12, res }),
    );
    expect(queue.size).toBe(2);

    // Decide second item explicitly via toolCallId with 'always'
    const decided = queue.decide('always', { toolCallId: 'tc-bash-2' });
    expect(decided?.decision).toBe('always');
    expect(decided?.optionId).toBe('a2');
    expect(queue.size).toBe(1);

    // Batch cancel remaining items (Esc / shutdown race)
    const cancelled = queue.cancelAll();
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.toolCallId).toBe('tc-bash-1');
    expect(queue.size).toBe(0);
    expect(responses[responses.length - 1]).toEqual({
      id: 11,
      res: { outcome: { outcome: 'cancelled' } },
    });
  });
});

// ---------------------------------------------------------------------------
// 7. CommandRegistry & Handlers: merging, fuzzy matching, hits, dispatch
// ---------------------------------------------------------------------------

describe('CommandRegistry & Handlers', () => {
  test('merges 10 built-in commands with ACP available_commands_update and produces UTF-16 hits', () => {
    const registry = new CommandRegistry();
    expect(BUILTIN_COMMANDS).toHaveLength(10);

    // Aliases resolve properly
    expect(registry.resolve('/r')?.name).toBe('resume');
    expect(registry.resolve('sessions')?.name).toBe('resume');
    expect(registry.resolve('/clear')?.name).toBe('new');
    expect(registry.resolve('m')?.name).toBe('model');
    expect(registry.resolve('thinking')?.name).toBe('thinking');
    expect(registry.resolve('t')?.name).toBe('thought');
    expect(registry.resolve('?')?.name).toBe('help');
    expect(registry.resolve('exit')?.name).toBe('quit');

    // Merge ACP dynamic commands (including overlapping `compact` and `help`)
    registry.setAcpCommands([
      { name: 'compact', description: 'Server compaction description' },
      { name: 'help', description: 'Should not override built-in help' },
      { name: 'plan', description: 'Step-by-step planning', input: { hint: '[goal]' } },
      { name: 'grill-me', description: 'Interactive design interview' },
    ]);

    const all = registry.getAll();
    expect(all.filter((c) => c.name === 'compact')).toHaveLength(1);
    expect(registry.resolve('compact')?.source).toBe('oma');
    expect(registry.resolve('compact')?.description).toBe('Server compaction description');
    expect(registry.resolve('help')?.source).toBe('oma');
    expect(registry.resolve('plan')?.source).toBe('agy');
    expect(registry.resolve('plan')?.autoExecuteOnEnter).toBe(false);
    expect(registry.resolve('grill-me')?.source).toBe('agy');
    expect(registry.resolve('grill-me')?.autoExecuteOnEnter).toBe(true);

    // Fuzzy match & UTF-16 hit ranges
    const resMatches = registry.search('res');
    expect(resMatches[0]?.command.name).toBe('resume');
    expect(resMatches[0]?.nameHits).toEqual([[0, 3]]);
    expect(resMatches[0]?.labelHits).toEqual([[1, 4]]);

    const gmMatches = registry.search('gm');
    expect(gmMatches[0]?.command.name).toBe('grill-me');
    expect(gmMatches[0]?.nameHits).toEqual([
      [0, 1],
      [6, 7],
    ]);

    const fuzzy = fuzzyMatchText('grill-me', 'gme');
    expect(fuzzy).not.toBeNull();
    expect(fuzzy?.hits).toEqual([
      [0, 1],
      [6, 8],
    ]);
  });

  test('dispatches all 10 built-in commands, ACP passthrough commands, and unknown commands', async () => {
    const registry = new CommandRegistry();
    registry.setAcpCommands([{ name: 'plan', description: 'Create plan' }]);

    expect(parseSlashInput('hello world')).toBeNull();
    expect(dispatchSlashCommand('hello world', registry).isCommand).toBe(false);

    const log: string[] = [];
    const executor: CommandActionExecutor = {
      openPicker: (p, q) => {
        log.push(`picker:${p}:${q}`);
      },
      newSession: () => {
        log.push('new');
      },
      setModel: (q) => {
        log.push(`model:${q}`);
      },
      setThought: (l) => {
        log.push(`thought:${l}`);
      },
      setMode: (m) => {
        log.push(`mode:${m}`);
      },
      copyLastReply: () => {
        log.push('copy');
      },
      openHelp: () => {
        log.push('help');
      },
      quit: () => {
        log.push('quit');
      },
      passthroughPrompt: (text, cmd, src) => {
        log.push(`pass:${src}:${cmd}:${text}`);
      },
      unknownCommand: (cmd) => {
        log.push(`unknown:${cmd}`);
      },
    };

    const inputs = [
      '/r my query',
      '/clear',
      '/m',
      '/model gemini-4-neon-xhigh',
      '/t',
      '/thought high',
      '/mode',
      '/mode auto',
      '/copy',
      '/log stderr',
      '/compact',
      '/?',
      '/exit',
      '/plan build feature',
      '/nonexistent',
    ];

    for (const input of inputs) {
      const res = dispatchSlashCommand(input, registry);
      expect(res.isCommand).toBe(true);
      if (res.isCommand) {
        await executeCommandAction(res.action, executor);
      }
    }

    expect(log).toEqual([
      'picker:resume:my query',
      'new',
      'picker:model:',
      'model:gemini-4-neon-xhigh',
      'picker:thought:',
      'thought:high',
      'picker:mode:',
      'mode:auto',
      'copy',
      'picker:log:stderr',
      'pass:oma:compact:/compact',
      'help',
      'quit',
      'pass:agy:plan:/plan build feature',
      'unknown:nonexistent',
    ]);
  });

  test('routes /thinking [on|off] to set_thinking_display while keeping /thinking <level> backward compatible', async () => {
    const registry = new CommandRegistry();
    const events: string[] = [];
    const executor: CommandActionExecutor = {
      openPicker: () => {},
      newSession: () => {},
      setModel: () => {},
      setThought: (l) => {
        events.push(`thought:${l}`);
      },
      setThinkingDisplay: (m) => {
        events.push(`thinking:${m}`);
      },
      setMode: () => {},
      copyLastReply: () => {},
      openHelp: () => {},
      quit: () => {},
      passthroughPrompt: () => {},
      unknownCommand: () => {},
    };

    for (const input of ['/thinking', '/thinking on', '/thinking off', '/thinking true', '/thinking false', '/thinking high']) {
      const res = dispatchSlashCommand(input, registry);
      expect(res.isCommand).toBe(true);
      if (res.isCommand) {
        await executeCommandAction(res.action, executor);
      }
    }

    expect(events).toEqual([
      'thinking:toggle',
      'thinking:on',
      'thinking:off',
      'thinking:on',
      'thinking:off',
      'thought:high',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8. TranscriptStore & AppStore: ACP updates, swarm/subagent, settle/Gone, focus
// ---------------------------------------------------------------------------

describe('TranscriptStore & AppStore', () => {
  test('consumes ACP session/update stream: thoughts, tool status, exit_code, diffs, swarm/subagent, plan, notices, settle & GoneEvent', () => {
    let clock = 10_000;
    const store = new TranscriptStore({ now: () => (clock += 100) });

    const turn0 = store.beginUserTurn('Analyze repo');
    expect(turn0.nodeId).toBe('main.turn-0');

    // Thought streaming opens by default, auto-collapses when assistant text begins
    store.applySessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Step 1...' },
    });
    expect(turn0.thoughts).toHaveLength(1);
    expect(turn0.thoughts[0]?.open).toBe(true);
    expect(turn0.thoughts[0]?.status).toBe('running');

    // run_command tool call -> pending -> in_progress -> completed with exit_code
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-cmd',
      name: 'run_command',
      kind: 'execute',
      status: 'pending',
      title: 'Run tests',
      args: { CommandLine: 'bun test' },
    });
    expect(store.getToolById('tc-cmd')?.displayName).toBe('bash');
    expect(store.getToolById('tc-cmd')?.targetKind).toBe('command');
    expect(store.getToolById('tc-cmd')?.status).toBe('pending');

    store.applySessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-cmd',
      status: 'in_progress',
    });
    expect(store.getToolById('tc-cmd')?.status).toBe('running');

    store.applySessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-cmd',
      status: 'completed',
      rawOutput: { output: 'all passed', exit_code: 0 },
    });
    expect(store.getToolById('tc-cmd')?.status).toBe('done');
    expect(store.getToolById('tc-cmd')?.exitCode).toBe(0);
    expect(store.getToolById('tc-cmd')?.outputText).toBe('all passed');

    // edit_file with diff content
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-edit',
      name: 'edit_file',
      kind: 'edit',
      status: 'completed',
      title: 'File /D:/Projects/oh-my-agy/README.md',
      content: [
        {
          type: 'diff',
          path: '/D:/Projects/oh-my-agy/README.md',
          oldText: 'old',
          newText: 'new',
        },
      ],
    });
    const editTool = store.getToolById('tc-edit')!;
    expect(editTool.displayName).toBe('edit');
    expect(editTool.diffs).toHaveLength(1);
    expect(editTool.diffs[0]?.newText).toBe('new');

    // Permission arriving before tool_call creates placeholder card with status='ask'
    const mappedAsk = mapPermissionOptions([
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ]);
    const permTool = store.attachPermissionRequest(
      99,
      { toolCallId: 'tc-early-perm', name: 'run_command', kind: 'execute', title: 'rm -rf tmp' },
      mappedAsk,
    );
    expect(permTool.status).toBe('ask');
    expect(permTool.awaitingPermission).toBe(true);
    store.resolvePermissionOnTool('tc-early-perm', 'denied');
    expect(permTool.status).toBe('cancelled');
    expect(permTool.approved).toBe('denied');

    // Swarm (sharded tasks) & invoke_subagent semantic parsing
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-swarm',
      name: 'swarm',
      status: 'in_progress',
      args: {
        action: 'add',
        name: 'worker',
        brief: 'Implement slice',
        tasks: ['module A', 'module B'],
      },
    });
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-sub',
      name: 'invoke_subagent',
      status: 'completed',
      args: { name: 'reviewer', task: 'Review PR' },
    });
    expect(turn0.agents.map((a) => `${a.kind}:${a.name}:${a.status}`)).toEqual([
      'swarm:worker-1:running',
      'swarm:worker-2:running',
      'subagent:reviewer:done',
    ]);

    // Plan update & removal
    store.applySessionUpdate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Write code', status: 'completed', priority: 'high' },
        { content: 'Run tests', status: 'in_progress' },
        { content: 'Ship', status: 'pending' },
      ],
    });
    expect(store.plan?.entries.map((e) => e.status)).toEqual(['done', 'active', 'pending']);
    store.applySessionUpdate({ sessionUpdate: 'plan_removed' });
    expect(store.plan).toBeNull();

    // Compaction & Notice & Unknown update tolerance
    store.applySessionUpdate({ sessionUpdate: 'compaction_update', status: 'running', text: 'Compacting...' });
    store.applySessionUpdate({ sessionUpdate: 'compaction_summary_chunk', text: 'Summary part 1' });
    store.applySessionUpdate({ sessionUpdate: 'notice', level: 'warning', message: 'Quota low' });
    const unknownOut = store.applySessionUpdate({ sessionUpdate: 'future_experimental_event', foo: 1 });
    expect(unknownOut.handled).toBe(false);
    expect(unknownOut.unknownUpdateType).toBe('future_experimental_event');
    expect(turn0.notices).toHaveLength(2);
    expect(turn0.notices[0]?.summaryText).toBe('Summary part 1');

    // Assistant text chunk finishes & auto-collapses thought block
    store.applySessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Done!' },
    });
    expect(turn0.thoughts[0]?.status).toBe('done');
    expect(turn0.thoughts[0]?.open).toBe(false);
    expect(store.getLastAssistantMarkdown()).toBe('Done!');
    store.finishActiveTurn('end_turn');

    // Settle & GoneEvent eviction tracking
    expect(store.markSettled(0)).toBe(true);
    expect(store.settledTurnIds.has('main.turn-0')).toBe(true);
    expect(turn0.settled).toBe(true);

    const evicted = store.markEvicted(['main.turn-0']);
    expect(evicted).toEqual(['main.turn-0']);
    expect(store.evictedTurnIds.has('main.turn-0')).toBe(true);
    expect(store.settledTurnIds.has('main.turn-0')).toBe(false);
    expect(store.getVisibleTurns()).toHaveLength(0);
  });

  test('converts elicitation/create schema into question items and typed response content', () => {
    const card = buildQuestionCardFromElicitation(
      42,
      {
        mode: 'form',
        message: 'Confirm settings',
        requestedSchema: {
          type: 'object',
          required: ['env', 'confirm'],
          properties: {
            env: { type: 'string', title: 'Target Env', enum: ['dev', 'prod'] },
            tags: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] } },
            confirm: { type: 'boolean', title: 'Proceed?' },
            retries: { type: 'integer', title: 'Retries' },
          },
        },
      },
      () => {},
    );

    expect(card.items).toHaveLength(4);
    expect(card.items[0]?.fieldType).toBe('single');
    expect(card.items[1]?.multi).toBe(true);
    expect(card.items[2]?.choices?.map((c) => c.label)).toEqual(['Yes', 'No']);
    expect(card.items[3]?.other).not.toBe(false);

    card.answers['env'] = 'prod';
    card.answers['tags'] = ['a', 'c'];
    card.answers['confirm'] = 'true';
    card.otherDrafts['retries'] = '3';

    expect(buildElicitationContent(card)).toEqual({
      env: 'prod',
      tags: ['a', 'c'],
      confirm: true,
      retries: 3,
    });
  });

  test('AppStore manages focus state machine, completion popup node IDs, dynamic configOptions, usage & toasts', () => {
    const app = new AppStore({ cwd: 'D:\\Projects\\oh-my-agy' });

    // Initial state: editor focus, not ready yet (typeahead=true, sendable=false)
    expect(app.getState().isReady).toBe(false);
    expect(app.getState().focusMode).toBe('editor');
    expect(app.getState().desiredSurfaceFocus).toBe(EDITOR_NODE_ID);

    // Session snapshot with model + thought_level + mode
    app.applySessionSnapshot({
      sessionId: 'sess-1',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'gemini-4-neon',
          options: [
            { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
            { value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator Neon' },
          ],
        },
        {
          id: 'thought_level',
          name: 'Thought',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'default',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'auto', name: 'Auto' },
          ],
        },
      ],
    });
    app.setConnectionStatus('ready');

    expect(app.getState().isReady).toBe(true);
    expect(app.getState().controls.supportsThoughtLevel).toBe(true);
    expect(app.getState().controls.currentThoughtLevel).toBe('high');

    // Switching to Orchestrator removes thought_level dynamically
    app.applySessionUpdate({
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'gemini-pro-orchestrator-neon',
          options: [{ value: 'gemini-pro-orchestrator-neon', name: 'Orchestrator Neon' }],
        },
      ],
    });
    expect(app.getState().controls.supportsThoughtLevel).toBe(false);
    expect(app.getState().controls.currentThoughtLevel).toBeNull();

    // Usage update & formatting
    app.applySessionUpdate({
      sessionUpdate: 'usage_update',
      used: 14_000,
      size: 1_000_000,
    });
    expect(formatContextUsage(app.getState().usage)).toBe('14k / 1M (1.4%)');

    // Slash completion popup produces full TSP node ID `${COMPLETION_LIST_PREFIX}<key>`
    app.draft.setText('/res');
    const comp = app.refreshCompletion();
    expect(comp.open).toBe(true);
    expect(comp.selectedNodeId).toBe(`${COMPLETION_LIST_PREFIX}cmd_resume`);

    // Esc dismisses without immediately reopening on identical trigger
    expect(app.dismissCompletion()).toBe(true);
    expect(app.refreshCompletion().open).toBe(false);

    // Typing more reopens and Enter accepts with autoExecute=true
    app.draft.setText('/cop');
    app.refreshCompletion();
    const accepted = app.acceptCompletion({ viaKey: 'enter' });
    expect(accepted?.item.value).toBe('copy');
    expect(accepted?.autoExecute).toBe(true);
    expect(app.draft.text).toBe('/copy');

    // File completion accepts WorkspaceFileIndexer FileSearchMatch shape directly
    app.draft.setText('check @src/ed');
    const fileComp = app.refreshCompletion(() => [
      {
        file: {
          relPath: 'src/editor/draft.ts',
          absPath: 'D:\\Projects\\oh-my-agy\\src\\editor\\draft.ts',
          name: 'draft.ts',
          dir: 'src/editor',
        },
        score: 900,
        hits: [[0, 6]],
      },
    ]);
    expect(fileComp.open).toBe(true);
    expect(fileComp.items[0]?.value).toBe('src/editor/draft.ts');
    expect(fileComp.items[0]?.absPath).toBe('D:\\Projects\\oh-my-agy\\src\\editor\\draft.ts');
    expect(fileComp.selectedNodeId).toBe(`${COMPLETION_LIST_PREFIX}file_0_src_editor_draft_ts`);
    const fileAccepted = app.acceptCompletion({ viaKey: 'tab' });
    expect(fileAccepted?.autoExecute).toBe(false);
    expect(app.draft.text).toBe('check @src/editor/draft.ts ');

    // Modal picker steals surface focus -> null; FocusEvent ignored while modal open; closing restores EDITOR_NODE_ID
    app.openPicker('resume', { initialQuery: 'abc' });
    expect(app.getState().focusMode).toBe('picker');
    expect(app.getState().picker?.query).toBe('abc');
    expect(app.getState().desiredSurfaceFocus).toBeNull();
    expect(app.handleSurfaceFocusEvent(EDITOR_NODE_ID)).toBeNull();

    expect(app.togglePickerScope()).toBe('all-folders');
    expect(app.closePicker()).toBe(true);
    expect(app.getState().focusMode).toBe('editor');
    expect(app.getState().desiredSurfaceFocus).toBe(EDITOR_NODE_ID);

    // Help overlay also releases editor focus
    app.openHelp();
    expect(app.getState().focusMode).toBe('help');
    expect(app.getState().desiredSurfaceFocus).toBeNull();
    app.closeHelp();
    expect(app.getState().desiredSurfaceFocus).toBe(EDITOR_NODE_ID);

    // Toast seq increments monotonically even for identical messages
    const t1 = app.pushToast('Copied', 'success');
    const t2 = app.pushToast('Copied', 'success');
    expect(t2.seq).toBe(t1.seq + 1);
  });
});

// ---------------------------------------------------------------------------
// 9. P0/P1 Commands, Semantic Icons, Routing, Transcript Analytics & AppStore
// ---------------------------------------------------------------------------

describe('P0/P1 commands, semantic icons, completion popup & state machine', () => {
  test('registers all P0/P1 built-ins, aliases, icons and resolves ACP command icons & skills', () => {
    const registry = new CommandRegistry();
    expect(ALL_BUILTIN_COMMANDS.length).toBeGreaterThanOrEqual(23);

    // P0/P1 aliases
    expect(registry.resolve('config')?.name).toBe('settings');
    expect(registry.resolve('effort')?.name).toBe('thought');
    expect(registry.resolve('switch')?.name).toBe('resume');
    expect(registry.resolve('conversation')?.name).toBe('resume');
    expect(registry.resolve('plugin')?.name).toBe('plugins');
    expect(registry.resolve('agent')?.name).toBe('agents');
    expect(registry.resolve('quota')?.name).toBe('usage');

    // Semantic icons on built-ins
    const expectedBuiltinIcons: Record<string, string> = {
      settings: 'settings',
      status: 'activity',
      thought: 'gauge',
      resume: 'history',
      mcp: 'mcp',
      plugins: 'package',
      skills: 'skill',
      agents: 'agents',
      context: 'context',
      usage: 'stats',
      permissions: 'shield',
      login: 'signIn',
      logout: 'signOut',
      export: 'export',
      copy: 'copy',
      new: 'plus',
      model: 'model',
      mode: 'shield',
      compact: 'compress',
      log: 'terminal',
      help: 'keyboard',
      quit: 'power',
      board: 'users',
    };
    for (const [cmdName, expectedIcon] of Object.entries(expectedBuiltinIcons)) {
      expect(registry.resolve(cmdName)?.icon).toBe(expectedIcon);
    }

    // Dynamic ACP icons & skill classification
    expect(resolveAcpCommandIcon('goal')).toBe('goal');
    expect(resolveAcpCommandIcon('plan')).toBe('plan');
    expect(resolveAcpCommandIcon('grill-me')).toBe('question');
    expect(resolveAcpCommandIcon('boost')).toBe('bolt');
    expect(resolveAcpCommandIcon('teamwork')).toBe('users');
    expect(resolveAcpCommandIcon('swarm')).toBe('users');
    expect(resolveAcpCommandIcon('learn')).toBe('lightbulb');
    expect(resolveAcpCommandIcon('schedule')).toBe('timer');
    expect(resolveAcpCommandIcon('browser')).toBe('globe');
    expect(resolveAcpCommandIcon('antigravity-guide')).toBe('skill');
    expect(resolveAcpCommandIcon('run-workflow')).toBe('skill');

    expect(isAcpSkillCommand('goal')).toBe(false);
    expect(isAcpSkillCommand('swarm')).toBe(false);
    expect(isAcpSkillCommand('antigravity-guide')).toBe(true);
    expect(isAcpSkillCommand('agy-customizations')).toBe(true);

    registry.setAcpCommands([
      { name: 'goal', description: 'Run a goal' },
      { name: 'swarm', description: 'Run swarm' },
      { name: 'antigravity-guide', description: 'Guide skill' },
      { name: 'run-workflow', description: 'Workflow skill' },
    ]);
    expect(registry.resolve('goal')?.icon).toBe('goal');
    expect(registry.resolve('goal')?.isSkill).toBe(false);
    expect(registry.resolve('antigravity-guide')?.icon).toBe('skill');
    expect(registry.resolve('antigravity-guide')?.isSkill).toBe(true);
    expect(registry.getAcpSkillCommands().map((s) => s.name)).toEqual([
      'antigravity-guide',
      'run-workflow',
    ]);
  });

  test('dispatches all P0/P1 command actions, /permissions, /copy [n], and /swarm routing', async () => {
    const registry = new CommandRegistry();
    registry.setAcpCommands([
      { name: 'swarm', description: 'Coordinate swarm' },
      { name: 'antigravity-guide', description: 'Guide skill' },
    ]);

    expect(parseSettingsPageArg('perm')).toBe('permissions');
    expect(parseSettingsPageArg('ui')).toBe('interface');
    expect(parseSettingsPageArg('unknown')).toBeUndefined();

    expect(parseCopyReverseIndex('')).toBe(1);
    expect(parseCopyReverseIndex('3')).toBe(3);
    expect(parseCopyReverseIndex('0')).toBe(1);
    expect(parseCopyReverseIndex('abc')).toBe(1);

    const events: string[] = [];
    const executor: CommandActionExecutor = {
      openPicker: (p, q) => {
        events.push(`picker:${p}:${q}`);
      },
      openSwarmBoard: (q) => {
        events.push(`board:${q}`);
      },
      openSettings: (page) => {
        events.push(`settings:${page ?? 'default'}`);
      },
      openStatus: () => {
        events.push('status');
      },
      openContext: () => {
        events.push('context');
      },
      openUsage: () => {
        events.push('usage');
      },
      openMcp: (args) => {
        events.push(`mcp:${args ?? ''}`);
      },
      openPlugins: (args) => {
        events.push(`plugins:${args ?? ''}`);
      },
      openSkills: (q) => {
        events.push(`skills:${q ?? ''}`);
      },
      openAgents: (q) => {
        events.push(`agents:${q ?? ''}`);
      },
      login: () => {
        events.push('login');
      },
      logout: () => {
        events.push('logout');
      },
      exportTranscript: (p) => {
        events.push(`export:${p ?? ''}`);
      },
      copyLastAssistant: (idx) => {
        events.push(`copy:${idx ?? 1}`);
      },
      newSession: () => {
        events.push('new');
      },
      setModel: (q) => {
        events.push(`model:${q}`);
      },
      setThought: (l) => {
        events.push(`thought:${l}`);
      },
      setMode: (m) => {
        events.push(`mode:${m}`);
      },
      openHelp: () => {
        events.push('help');
      },
      quit: () => {
        events.push('quit');
      },
      passthroughPrompt: (text, cmd, src) => {
        events.push(`pass:${src}:${cmd}:${text}`);
      },
      unknownCommand: (cmd) => {
        events.push(`unknown:${cmd}`);
      },
    };

    const inputs = [
      '/settings',
      '/config interface',
      '/permissions',
      '/status',
      '/context',
      '/usage',
      '/quota',
      '/mcp list',
      '/plugin enable foo',
      '/skills guide',
      '/agent reviewer',
      '/login',
      '/logout',
      '/export ./out.md',
      '/copy',
      '/copy 2',
      '/effort xhigh',
      '/switch recent',
      '/conversation old',
      '/board worker',
      '/swarm board filter-x',
      '/swarm',
      '/swarm refactor the auth layer',
      '/skill:antigravity-guide how to setup',
    ];

    for (const input of inputs) {
      const res = dispatchSlashCommand(input, registry);
      expect(res.isCommand).toBe(true);
      if (res.isCommand) {
        await executeCommandAction(res.action, executor);
      }
    }

    expect(events).toEqual([
      'settings:default',
      'settings:interface',
      'settings:permissions',
      'status',
      'context',
      'usage',
      'usage',
      'mcp:list',
      'plugins:enable foo',
      'skills:guide',
      'agents:reviewer',
      'login',
      'logout',
      'export:./out.md',
      'copy:1',
      'copy:2',
      'thought:xhigh',
      'picker:resume:recent',
      'picker:resume:old',
      'board:worker',
      'board:filter-x',
      'pass:agy:swarm:/swarm',
      'pass:agy:swarm:/swarm refactor the auth layer',
      'pass:agy:antigravity-guide:/antigravity-guide how to setup',
    ]);
  });

  test('TranscriptStore supports /copy [n], estimateContextBreakdown, tookMs, createdAt & global collapse toggles', () => {
    let clock = new Date(2026, 4, 15, 14, 5, 9).getTime();
    const store = new TranscriptStore({ now: () => clock });

    const t0 = store.beginUserTurn('First question');
    expect(t0.createdAt).toBe(clock);
    expect(t0.user?.createdAt).toBe(clock);
    expect(formatTurnTime(clock, false)).toBe('14:05');
    expect(formatTurnTime(clock, true)).toBe('2:05 PM');
    expect(formatFullLocalTime(clock, false)).toBe('2026-05-15 14:05:09');

    store.applySessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Reasoning about step 1' },
    });
    clock += 2500;
    store.applySessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Answer one' },
    });
    expect(t0.thoughts[0]?.tookMs).toBe(2500);
    store.finishActiveTurn('end_turn');

    clock += 1000;
    const t1 = store.beginUserTurn('Second question with tool');
    store.applySessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        name: 'read_file',
        kind: 'read',
        status: 'completed',
        title: 'Read README.md',
        rawOutput: { output: 'Project documentation content here' },
      },
      { expandAllTools: true },
    );
    expect(t1.toolCalls[0]?.collapsed).toBe(false);

    store.applySessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Answer two' },
    });
    store.finishActiveTurn('end_turn');

    // /copy [n] reverse index lookup
    expect(store.getAssistantMarkdownByReverseIndex(1)).toBe('Answer two');
    expect(store.getAssistantMarkdownByReverseIndex(2)).toBe('Answer one');
    expect(store.getAssistantMarkdownByReverseIndex(3)).toBeNull();
    expect(store.getAssistantMarkdownByReverseIndex(0)).toBeNull();

    // Context breakdown estimation
    const breakdown = store.estimateContextBreakdown({ used: 1200, size: 100_000 });
    expect(breakdown.turnCount).toBe(2);
    expect(breakdown.userChars).toBeGreaterThan(0);
    expect(breakdown.assistantChars).toBeGreaterThan(0);
    expect(breakdown.thoughtChars).toBeGreaterThan(0);
    expect(breakdown.toolChars).toBeGreaterThan(0);
    expect(breakdown.totalEstimatedTokens).toBeGreaterThan(0);
    expect(breakdown.reportedUsedTokens).toBe(1200);
    expect(breakdown.contextWindowSize).toBe(100_000);
    expect(breakdown.usedPercent).toBe(1.2);
    expect(breakdown.categories.map((c) => c.category)).toEqual([
      'user',
      'assistant',
      'thought',
      'tool',
    ]);

    // Global thinking & tool collapse helpers (aligned with omp: expandAllTools is decoupled from thoughts)
    const thought0 = t0.thoughts[0]!;
    expect(store.isThoughtOpen(thought0, { showThinking: false, expandAllTools: true })).toBe(false);
    expect(store.isThoughtOpen(thought0, { showThinking: true, expandAllTools: true })).toBe(false);
    store.toggleThought(thought0.id, true);
    expect(store.isThoughtOpen(thought0, { showThinking: true, expandAllTools: false })).toBe(true);
    expect(store.isToolCollapsed(t1.toolCalls[0]!, false)).toBe(false);
    store.setAllToolsCollapsed(true);
    expect(t1.toolCalls[0]?.collapsed).toBe(true);
  });

  test('AppStore renders Figure 3 completion popup (10 rows, no leading /, semantic icons, live values, skill: collapse/expand, folder vs file)', () => {
    const app = new AppStore({ cwd: 'D:\\Projects\\oh-my-agy' });
    app.setAgentInitializeInfo(
      { name: 'agy', version: '1.5.13' },
      { image: true },
      { supportsLogout: true },
    );
    app.applySessionSnapshot({
      sessionId: 's-1',
      tier: { name: 'Google AI Ultra', id: 'ultra' },
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'gemini-4-neon',
          options: [
            { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
            { value: 'claude-4-sonnet', name: 'Claude 4 Sonnet' },
          ],
        },
        {
          id: 'thought_level',
          name: 'Thought',
          type: 'select',
          currentValue: 'high',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'high', name: 'High' },
          ],
        },
        {
          id: 'mode',
          name: 'Mode',
          type: 'select',
          currentValue: 'auto',
          options: [
            { value: 'default', name: 'Default' },
            { value: 'auto', name: 'Auto' },
          ],
        },
      ],
    });
    app.updateUsage(25_000, 1_000_000);
    app.setActiveSwarmCount(3);
    app.commands.setAcpCommands([
      { name: 'goal', description: 'Run a goal' },
      { name: 'antigravity-guide', description: 'Antigravity docs skill' },
      { name: 'run-workflow', description: 'Workflow orchestrator skill' },
    ]);

    // Bare `/` -> max 10 items, collapsed `skill:` row at top, no leading `/` on labels
    app.draft.setText('/');
    const rootComp = app.refreshCompletion();
    expect(rootComp.open).toBe(true);
    expect(rootComp.items).toHaveLength(MAX_COMPLETION_ITEMS);
    expect(MAX_COMPLETION_ITEMS).toBe(10);
    expect(rootComp.items.every((i) => !i.label.startsWith('/'))).toBe(true);

    const skillGroup = rootComp.items[0]!;
    expect(skillGroup.label).toBe('skill:');
    expect(skillGroup.icon).toBe('skill');
    expect(skillGroup.statusValue).toBe('2 skills');
    expect(skillGroup.isSkillGroup).toBe(true);

    // Accepting `skill:` expands to sub-skills without trailing space
    const expanded = app.acceptCompletion({ viaKey: 'enter' });
    expect(expanded?.autoExecute).toBe(false);
    expect(app.draft.text).toBe('/skill:');
    const skillPopup = app.getState().completion;
    expect(skillPopup.open).toBe(true);
    expect(skillPopup.items.map((i) => i.label)).toEqual([
      'skill:antigravity-guide',
      'skill:run-workflow',
    ]);
    expect(skillPopup.items[0]?.icon).toBe('skill');

    // Dynamic right-side status values
    app.draft.setText('/model');
    expect(app.refreshCompletion().items[0]?.statusValue).toBe('Gemini 4 Neon');
    app.draft.setText('/thought');
    expect(app.refreshCompletion().items[0]?.statusValue).toBe('High');
    app.draft.setText('/mode');
    expect(app.refreshCompletion().items[0]?.statusValue).toBe('Auto');
    app.draft.setText('/context');
    expect(app.refreshCompletion().items[0]?.statusValue).toBe('25k / 1M (2.5%)');
    app.draft.setText('/settings');
    expect(app.refreshCompletion().items[0]?.statusValue).toBe('config.toml');
    app.draft.setText('/board');
    expect(app.refreshCompletion().items[0]?.statusValue).toBe('3 active');
    app.draft.setText('/status');
    expect(app.refreshCompletion().items[0]?.statusValue).toBe('Google AI Ultra');

    // File completion distinguishes folder vs file icons
    app.draft.setText('@src');
    const fileComp = app.refreshCompletion(() => [
      { path: 'src/ui/', isDirectory: true, hits: [[0, 3]] },
      { path: 'src/state/store.ts', hits: [[0, 3]] },
    ]);
    expect(fileComp.items[0]?.icon).toBe('folder');
    expect(fileComp.items[0]?.isDirectory).toBe(true);
    expect(fileComp.items[1]?.icon).toBe('file');
    expect(fileComp.items[1]?.isDirectory).toBe(false);
  });

  test('AppStore manages SettingsPanelState, aside focus coexistence, InfoOverlay, model picker slider, recentModels & provider inference', () => {
    // Provider inference
    expect(inferModelProvider('gemini-4-neon')).toBe('google');
    expect(inferModelProvider('gemini-pro-orchestrator-neon')).toBe('google');
    expect(inferModelProvider('orchestrator')).toBe('google');
    expect(inferModelProvider('claude-4.5-opus')).toBe('anthropic');
    expect(inferModelProvider('gpt-5.2-codex')).toBe('openai');
    expect(inferModelProvider('o3-mini')).toBe('openai');
    expect(inferModelProvider('o4-high')).toBe('openai');
    expect(inferModelProvider('grok-4')).toBe('xai');
    expect(inferModelProvider('custom-local-model')).toBe('antigravity');

    const app = new AppStore({
      supportsAside: true,
      hour12: true,
      recentModels: ['gemini-4-neon', 'claude-4-sonnet'],
    });
    expect(app.getState().hour12).toBe(true);
    expect(app.getState().supportsAside).toBe(true);
    expect(app.getState().showThinking).toBe(true);
    expect(app.getState().expandAllTools).toBe(false);

    // Recent models dedupe & 12-item cap
    for (let i = 0; i < 15; i++) {
      app.recordRecentModel(`model-${i}`);
    }
    expect(app.getState().recentModels).toHaveLength(12);
    expect(app.getState().recentModels[0]).toBe('model-14');

    // Settings panel + aside focus coexistence
    app.openSettings({
      page: 'permissions',
      agySettings: { toolPermission: 'ask', enableTerminalSandbox: true },
      dirtyCount: 2,
    });
    expect(app.getState().focusMode).toBe('settings');
    expect(app.getState().settings?.page).toBe('permissions');
    expect(app.getState().settings?.dirtyCount).toBe(2);
    expect(app.getState().settings?.agySettings.enableTerminalSandbox).toBe(true);

    // Clicking editor while aside is supported transfers focus back to editor
    expect(app.handleSurfaceFocusEvent(EDITOR_NODE_ID)).toBe(EDITOR_NODE_ID);
    expect(app.getState().focusMode).toBe('editor');
    expect(app.getState().settings).not.toBeNull();

    // Clicking settings aside panel returns focus to settings
    expect(app.handleSurfaceFocusEvent(`${SETTINGS_NODE_PREFIX}.page`)).toBeNull();
    expect(app.getState().focusMode).toBe('settings');

    // Non-aside mode forces modal settings focus
    app.setSupportsAside(false);
    expect(app.handleSurfaceFocusEvent(EDITOR_NODE_ID)).toBeNull();
    expect(app.getState().focusMode).toBe('settings');
    expect(app.closeSettings()).toBe(true);
    expect(app.getState().focusMode).toBe('editor');

    // Info overlay
    app.openInfoOverlay('context', { configPath: '/tmp/config.toml' });
    expect(app.getState().focusMode).toBe('info');
    expect(app.getState().infoOverlay?.kind).toBe('context');
    expect(app.getState().infoOverlay?.contextBreakdown).toBeDefined();
    expect(app.closeInfoOverlay()).toBe(true);
    expect(app.getState().focusMode).toBe('editor');

    // Compact model picker + inline thinking slider state
    app.applySessionSnapshot({
      sessionId: 's-2',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          currentValue: 'gemini-4-neon',
          options: [
            { value: 'gemini-4-neon', name: 'Gemini 4 Neon' },
            { value: 'claude-4-opus', name: 'Claude 4 Opus' },
          ],
        },
        {
          id: 'thought_level',
          name: 'Thought',
          type: 'select',
          currentValue: 'low',
          options: [
            { value: 'low', name: 'Low' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    });
    app.openPicker('model');
    expect(app.getState().picker?.modelPickerThinking).toBe('low');
    expect(app.stepModelPickerThinking(1)).toBe('medium');
    expect(app.getState().picker?.modelPickerThinkingDirty).toBe(true);
    expect(app.togglePickerScope()).toBe('provider:google');
    expect(app.togglePickerScope()).toBe('provider:anthropic');
    expect(app.togglePickerScope()).toBe('all');
    app.closePicker();

    // Ecosystem pickers (mcp / plugins / skills / agents)
    app.openPicker('mcp');
    expect(app.getState().picker?.loading).toBe(true);
    app.setMcpServers([{ name: 'github', enabled: true, transport: 'stdio' }]);
    expect(app.getState().picker?.loading).toBe(false);
    expect(app.getState().picker?.selectedId).toBe('github');

    app.openPicker('plugins');
    app.setPlugins([{ name: 'superpowers', enabled: true, version: '1.0.0' }]);
    expect(app.getState().picker?.selectedId).toBe('superpowers');

    app.openPicker('skills');
    app.setSkills([{ name: 'antigravity-guide', description: 'Guide', source: 'acp' }]);
    expect(app.getState().picker?.selectedId).toBe('antigravity-guide');

    app.openPicker('agents');
    app.setAgents([{ id: 'reviewer', name: 'Reviewer', kind: 'custom' }]);
    expect(app.getState().picker?.selectedId).toBe('reviewer');

    // Global thinking / tools toggles
    expect(app.toggleShowThinking()).toBe(false);
    expect(app.toggleExpandAllTools()).toBe(true);
  });

  test('TranscriptStore freezes ThoughtBlock timers across tool calls, alternating thoughts, plan/compaction/notice, finish/cancel/error & session/load replay', () => {
    let clock = 100_000;
    const store = new TranscriptStore({ now: () => clock });

    // 1. thought1 -> tool_call -> tool_call_update -> thought2 -> agent_message_chunk
    const turn0 = store.beginUserTurn('Investigate and fix');
    store.applySessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'First thought...' },
    });
    expect(turn0.thoughts).toHaveLength(1);
    expect(turn0.thoughts[0]?.status).toBe('running');
    expect(turn0.thoughts[0]?.endedAt).toBeUndefined();

    // Advance 1200ms then invoke a tool -> thought1 MUST immediately stop and freeze
    clock += 1200;
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-run-1',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      title: 'Run tests',
      args: { CommandLine: 'bun test' },
    });
    expect(turn0.thoughts[0]?.status).toBe('done');
    expect(turn0.thoughts[0]?.endedAt).toBe(101_200);
    expect(turn0.thoughts[0]?.tookMs).toBe(1200);
    expect(turn0.thoughts[0]?.open).toBe(false);

    // Advance 3000ms while tool runs & completes -> thought1 stays frozen
    clock += 3000;
    store.applySessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-run-1',
      status: 'completed',
      rawOutput: { output: 'ok', exit_code: 0 },
    });
    expect(turn0.thoughts[0]?.tookMs).toBe(1200);
    expect(turn0.thoughts[0]?.endedAt).toBe(101_200);
    expect(turn0.toolCalls[0]?.tookMs).toBe(3000);

    // Second thought starts at 104_200, runs for 800ms, then agent_message_chunk closes it
    store.applySessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Second thought...' },
    });
    expect(turn0.thoughts).toHaveLength(2);
    expect(turn0.thoughts[1]?.status).toBe('running');
    expect(turn0.thoughts[1]?.startedAt).toBe(104_200);

    clock += 800;
    store.applySessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'All fixed!' },
    });
    expect(turn0.thoughts[0]?.status).toBe('done');
    expect(turn0.thoughts[0]?.tookMs).toBe(1200);
    expect(turn0.thoughts[1]?.status).toBe('done');
    expect(turn0.thoughts[1]?.endedAt).toBe(105_000);
    expect(turn0.thoughts[1]?.tookMs).toBe(800);
    expect(turn0.thoughts[1]?.open).toBe(false);

    clock += 500;
    store.finishActiveTurn('end_turn');
    expect(turn0.thoughts[0]?.tookMs).toBe(1200);
    expect(turn0.thoughts[1]?.tookMs).toBe(800);

    // 2. thought -> plan / compaction / notice / permission all freeze running thoughts
    clock += 1000;
    const turn1 = store.beginUserTurn('Check interrupts');
    store.applySessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Before plan' },
    });
    clock += 400;
    store.applySessionUpdate({
      sessionUpdate: 'plan',
      entries: [{ content: 'Step A', status: 'in_progress' }],
    });
    expect(turn1.thoughts[0]?.status).toBe('done');
    expect(turn1.thoughts[0]?.tookMs).toBe(400);

    store.applySessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Before compaction' },
    });
    clock += 600;
    store.applySessionUpdate({
      sessionUpdate: 'compaction_update',
      status: 'running',
      text: 'Compacting...',
    });
    expect(turn1.thoughts[1]?.status).toBe('done');
    expect(turn1.thoughts[1]?.tookMs).toBe(600);

    store.applySessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Before permission' },
    });
    clock += 350;
    const mappedAsk = mapPermissionOptions([
      { optionId: 'a', name: 'Allow', kind: 'allow_once' },
      { optionId: 'd', name: 'Deny', kind: 'reject_once' },
    ]);
    store.attachPermissionRequest(
      77,
      { toolCallId: 'tc-perm-freeze', name: 'run_command', kind: 'execute', title: 'echo hi' },
      mappedAsk,
    );
    expect(turn1.thoughts[2]?.status).toBe('done');
    expect(turn1.thoughts[2]?.tookMs).toBe(350);

    // Denying permission also freezes tool endedAt & tookMs
    clock += 250;
    const deniedTool = store.resolvePermissionOnTool('tc-perm-freeze', 'denied');
    expect(deniedTool?.status).toBe('cancelled');
    expect(deniedTool?.endedAt).toBe(clock);
    expect(deniedTool?.tookMs).toBe(250);

    // 3. thought -> finishActiveTurn('end_turn') with an unclosed running tool also freezes both
    store.applySessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Final thought before turn end' },
    });
    clock += 900;
    store.finishActiveTurn('end_turn');
    expect(turn1.thoughts[3]?.status).toBe('done');
    expect(turn1.thoughts[3]?.tookMs).toBe(900);
    expect(turn1.thoughts.every((th) => th.status === 'done' && th.endedAt !== undefined && th.tookMs !== undefined)).toBe(true);

    // 4. thought -> cancelTurn (finishActiveTurn('cancelled'))
    clock += 1000;
    const turn2 = store.beginUserTurn('Cancel mid-thought');
    store.applySessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Will be cancelled...' },
    });
    clock += 1500;
    store.finishActiveTurn('cancelled');
    expect(turn2.status).toBe('cancelled');
    expect(turn2.thoughts[0]?.status).toBe('done');
    expect(turn2.thoughts[0]?.endedAt).toBe(clock);
    expect(turn2.thoughts[0]?.tookMs).toBe(1500);

    // 5. thought -> error turn with lingering running tool & subagent
    clock += 1000;
    const turn3 = store.beginUserTurn('Error mid-swarm');
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-err-swarm',
      name: 'swarm',
      status: 'in_progress',
      args: { action: 'add', name: 'helper', brief: 'Do work' },
    });
    store.applySessionUpdate({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking before crash...' },
    });
    clock += 700;
    store.finishActiveTurn(undefined, 'error', 'network error');
    expect(turn3.status).toBe('error');
    expect(turn3.thoughts[0]?.status).toBe('done');
    expect(turn3.thoughts[0]?.tookMs).toBe(700);
    expect(turn3.toolCalls[0]?.status).toBe('error');
    expect(turn3.toolCalls[0]?.endedAt).toBe(clock);
    expect(turn3.agents[0]?.status).toBe('failed');
    expect(turn3.agents[0]?.endedAt).toBe(clock);

    // 6. session/load replay -> finalizeReplayedTurns freezes all thoughts & tools
    const replayStore = new TranscriptStore({ now: () => clock });
    replayStore.applySessionUpdate(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Replayed prompt' } },
      { isReplaying: true },
    );
    replayStore.applySessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Replayed thought 1' } },
      { isReplaying: true },
    );
    clock += 500;
    replayStore.applySessionUpdate(
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-replay',
        name: 'run_command',
        kind: 'execute',
        status: 'in_progress',
        title: 'echo replay',
      },
      { isReplaying: true },
    );
    clock += 300;
    replayStore.applySessionUpdate(
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Replayed thought 2' } },
      { isReplaying: true },
    );
    clock += 200;
    replayStore.finalizeReplayedTurns();

    const replayedTurn = replayStore.turns[0]!;
    expect(replayedTurn.status).toBe('done');
    expect(replayedTurn.replayed).toBe(true);
    expect(replayedTurn.thoughts).toHaveLength(2);
    for (const th of replayedTurn.thoughts) {
      expect(th.status).toBe('done');
      expect(th.endedAt).toBeDefined();
      expect(th.replayed).toBe(true);
      // Replayed thoughts must NOT synthesize fake wall-clock durations (avoids `Thought for 0ms`)
      expect(th.tookMs).toBeUndefined();
      expect(th.open).toBe(false);
    }
    expect(replayedTurn.toolCalls[0]?.status).toBe('done');
    expect(replayedTurn.toolCalls[0]?.endedAt).toBeDefined();
    expect(replayedTurn.toolCalls[0]?.replayed).toBe(true);
    expect(replayedTurn.toolCalls[0]?.tookMs).toBeUndefined();
  });

  test('TranscriptStore.getBackgroundJobsSnapshot, /jobs (/tasks) dispatch, and AppStore jobs overlay state', async () => {
    let clock = 200_000;
    const app = new AppStore({ now: () => clock });
    const { transcript } = app;

    // Empty session -> zero counts
    const emptySnap = transcript.getBackgroundJobsSnapshot();
    expect(emptySnap.running).toHaveLength(0);
    expect(emptySnap.recent).toHaveLength(0);
    expect(emptySnap.all).toHaveLength(0);
    expect(emptySnap.runningJobCount).toBe(0);
    expect(emptySnap.runningAgentCount).toBe(0);
    expect(emptySnap.inspectableAgentCount).toBe(0);

    // /jobs and /tasks dispatch to open_jobs
    const jobsRes = dispatchSlashCommand('/jobs', app.commands);
    expect(jobsRes.isCommand).toBe(true);
    if (jobsRes.isCommand) {
      expect(jobsRes.action).toEqual({ type: 'open_jobs' });
    }
    const tasksRes = dispatchSlashCommand('/tasks', app.commands);
    expect(tasksRes.isCommand).toBe(true);
    if (tasksRes.isCommand) {
      expect(tasksRes.action).toEqual({ type: 'open_jobs' });
      let openedJobs = 0;
      await executeCommandAction(tasksRes.action, {
        openPicker: () => {},
        openJobs: () => {
          openedJobs += 1;
        },
        newSession: () => {},
        setModel: () => {},
        setThought: () => {},
        setMode: () => {},
        openHelp: () => {},
        quit: () => {},
        passthroughPrompt: () => {},
        unknownCommand: () => {},
      });
      expect(openedJobs).toBe(1);
    }

    // Start active turn with bash, schedule, run_workflow, manage_task, read_file (non-job), invoke_subagent & swarm
    transcript.beginUserTurn('Run background jobs');
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-bash-1',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      title: 'Run tests',
      args: { CommandLine: 'bun test --watch' },
    });
    clock += 100;
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-sched-1',
      name: 'schedule',
      status: 'in_progress',
      title: 'Schedule check',
      args: { CronExpression: '*/5 * * * *', Prompt: 'Poll status' },
    });
    clock += 100;
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-wf-1',
      name: 'run_workflow',
      status: 'in_progress',
      title: 'Workflow fanout',
      args: { Description: 'Audit modules' },
    });
    clock += 100;
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-bg-1',
      name: 'manage_task',
      status: 'in_progress',
      title: 'Inspect daemon',
      args: { Action: 'status', TaskId: 'task-42' },
    });
    // Non-background file read must NOT enter background jobs
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-read-1',
      name: 'read_file',
      kind: 'read',
      status: 'in_progress',
      title: 'Read README',
      locations: [{ path: 'README.md' }],
    });
    // Subagent and Swarm MUST be counted in runningAgentCount / inspectableAgentCount, NOT runningJobCount
    clock += 100;
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-sub-1',
      name: 'invoke_subagent',
      status: 'in_progress',
      args: { name: 'auditor', task: 'Check security', model: 'gemini-4-neon' },
    });
    clock += 100;
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-swarm-1',
      name: 'swarm',
      status: 'in_progress',
      args: { action: 'add', name: 'worker', brief: 'Build feature', n: 2 },
    });

    const activeSnap = transcript.getBackgroundJobsSnapshot();
    expect(activeSnap.runningJobCount).toBe(4);
    expect(activeSnap.runningSubagentCount).toBe(1);
    expect(activeSnap.runningSwarmAgentCount).toBe(2);
    expect(activeSnap.runningAgentCount).toBe(3);
    expect(activeSnap.inspectableAgentCount).toBe(3);
    expect(activeSnap.running).toHaveLength(7);
    expect(activeSnap.recent).toHaveLength(0);
    expect(activeSnap.running.some((j) => j.id === 'tc-read-1')).toBe(false);
    expect(activeSnap.runningJobSummaries).toHaveLength(4);
    expect(activeSnap.running.find((j) => j.id === 'tc-bash-1')?.type).toBe('bash');
    expect(activeSnap.running.find((j) => j.id === 'tc-sched-1')?.type).toBe('schedule');
    expect(activeSnap.running.find((j) => j.id === 'tc-wf-1')?.type).toBe('workflow');
    expect(activeSnap.running.find((j) => j.id === 'tc-bg-1')?.type).toBe('task');
    expect(activeSnap.running.find((j) => j.toolCallId === 'tc-sub-1')?.agentId).toBeDefined();

    // Slash completion shows live `4 running` right-hand status for `/jobs`
    app.draft.setText('/job');
    const comp = app.refreshCompletion();
    const jobsItem = comp.items.find((i) => i.value === 'jobs');
    expect(jobsItem?.icon).toBe('jobs');
    expect(jobsItem?.statusValue).toBe('4 running');

    // Open jobs info overlay -> defaults to newest job, allows switching selection, and restores focus on close
    const overlay = app.openInfoOverlay('jobs');
    expect(overlay.kind).toBe('jobs');
    expect(overlay.selectedJobId).toBe(activeSnap.all[0]?.id);
    expect(app.getState().focusMode).toBe('info');
    expect(app.getState().desiredSurfaceFocus).toBeNull();

    app.setSelectedJobId('tc-bash-1');
    expect(app.getState().infoOverlay?.selectedJobId).toBe('tc-bash-1');

    // Completing bash tool moves it to recent with exact tookMs and decrements runningJobCount
    clock += 1500;
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-bash-1',
      status: 'completed',
      rawOutput: { output: 'all tests passed', exit_code: 0 },
    });
    const midSnap = transcript.getBackgroundJobsSnapshot();
    expect(midSnap.runningJobCount).toBe(3);
    const doneBash = midSnap.recent.find((j) => j.id === 'tc-bash-1');
    expect(doneBash?.status).toBe('completed');
    expect(doneBash?.exitCode).toBe(0);
    expect(doneBash?.tookMs).toBe(2000);
    expect(doneBash?.outputText).toBe('all tests passed');

    // Finishing turn settles every remaining running job & agent so runningJobCount & runningAgentCount hit 0
    clock += 500;
    transcript.finishActiveTurn('end_turn');
    const settledSnap = transcript.getBackgroundJobsSnapshot();
    expect(settledSnap.running).toHaveLength(0);
    expect(settledSnap.runningJobCount).toBe(0);
    expect(settledSnap.runningAgentCount).toBe(0);
    expect(settledSnap.inspectableAgentCount).toBe(3);
    expect(settledSnap.recent).toHaveLength(7);
    for (const job of settledSnap.recent) {
      expect(job.status).not.toBe('running');
      expect(job.endedAt).toBeDefined();
      expect(job.tookMs).toBeDefined();
    }

    // Closing overlay restores EDITOR_NODE_ID focus and `/jobs` completion clears `N running`
    expect(app.closeInfoOverlay()).toBe(true);
    expect(app.getState().desiredSurfaceFocus).toBe(EDITOR_NODE_ID);
    app.draft.setText('/job');
    const compAfter = app.refreshCompletion();
    expect(compAfter.items.find((i) => i.value === 'jobs')?.statusValue).toBeUndefined();
  });

  test('tracks detached background tasks across end_turn (run_command, invoke_subagent, schedule, run_workflow) and settles via manage_task / notice / cancel', () => {
    let clock = 300_000;
    const app = new AppStore({ now: () => (clock += 100) });
    const { transcript } = app;

    expect(app.hasActiveBackgroundTasks()).toBe(false);
    expect(app.isBusy).toBe(false);

    // Turn spawns a background bash command, an async subagent, a scheduled timer, and a background workflow
    transcript.beginUserTurn('Start background jobs');
    app.setStreaming(true);

    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-bg-bash',
      name: 'run_command',
      kind: 'execute',
      status: 'completed',
      title: 'Start dev server',
      args: { CommandLine: 'bun run dev', WaitMsBeforeAsync: 500 },
      rawOutput: { output: 'Tool is running as a background task with task id: sess/task-101' },
    });

    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-bg-sub',
      name: 'invoke_subagent',
      status: 'completed',
      args: { name: 'explorer', task: 'Inspect codebase' },
      rawOutput: { conversationId: 'conv-sub-202', status: 'running' },
    });

    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-bg-sched',
      name: 'schedule',
      status: 'completed',
      args: { DurationSeconds: 60, Prompt: 'Check build status' },
      rawOutput: { taskId: 'sched-303', output: 'Scheduled timer taskId: sched-303' },
    });

    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-bg-wf',
      name: 'run_workflow',
      status: 'completed',
      args: { Description: 'Fan-out lint' },
      rawOutput: { output: 'Workflow running in the background with TaskId: wf-404' },
    });

    // Main turn finishes (`end_turn`), yet all 4 detached background tasks remain active!
    transcript.finishActiveTurn('end_turn');
    app.setStreaming(false);

    expect(app.getState().isStreaming).toBe(false);
    expect(transcript.hasActiveBackgroundTasks()).toBe(true);
    expect(app.hasActiveBackgroundTasks()).toBe(true);
    expect(app.isBusy).toBe(true);
    expect(app.getState().isBusy).toBe(true);

    const bgSnap = transcript.getBackgroundJobsSnapshot();
    expect(bgSnap.detachedTaskCount).toBe(4);
    expect(bgSnap.hasActiveBackgroundTasks).toBe(true);
    expect(bgSnap.runningJobCount).toBe(3); // bash + schedule + workflow (excludes subagent)
    expect(bgSnap.runningSubagentCount).toBe(1);
    expect(bgSnap.running).toHaveLength(4);

    // 1. Settle bash task via `manage_task` status=DONE
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-mt-1',
      name: 'manage_task',
      status: 'completed',
      args: { Action: 'status', TaskId: 'sess/task-101' },
      rawOutput: { output: 'Task: sess/task-101\nStatus: DONE\n' },
    });
    expect(transcript.getBackgroundJobsSnapshot().detachedTaskCount).toBe(3);

    // 2. Kill schedule task via `manage_task` Action=kill
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-mt-2',
      name: 'manage_task',
      status: 'completed',
      args: { Action: 'kill', TaskId: 'sched-303' },
      rawOutput: { output: 'Killed task sched-303' },
    });
    expect(transcript.getBackgroundJobsSnapshot().detachedTaskCount).toBe(2);

    // 3. Subagent finishes via incoming notice mentioning conversationId
    transcript.applySessionUpdate({
      sessionUpdate: 'notice',
      level: 'info',
      message: 'Subagent conv-sub-202 finished with summary.',
    });
    expect(transcript.getBackgroundJobsSnapshot().detachedTaskCount).toBe(1);
    expect(app.isBusy).toBe(true);

    // 4. User manually cancels remaining background task (e.g. clicking Stop / pressing Esc)
    const cancelledCount = transcript.cancelActiveBackgroundTasks('cancelled');
    expect(cancelledCount).toBe(1);
    expect(transcript.hasActiveBackgroundTasks()).toBe(false);
    expect(app.isBusy).toBe(false);
    expect(app.getState().isBusy).toBe(false);
    expect(transcript.getBackgroundJobsSnapshot().running).toHaveLength(0);
    expect(transcript.getBackgroundJobsSnapshot().detachedTaskCount).toBe(0);

    // 5. Standard ACP `tool_call` WITHOUT `name` (only `title: 'manage_task'` + `rawInput`) MUST settle detached tasks
    transcript.beginUserTurn('Start ACP title-only background command');
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-bg-acp-42',
      kind: 'execute',
      status: 'completed',
      title: 'run_command',
      rawInput: { CommandLine: 'bun run watch', WaitMsBeforeAsync: 500 },
      rawOutput: { output: 'Tool is running as a background task with task id: bg-task-42' },
    });
    transcript.finishActiveTurn('end_turn');
    expect(transcript.hasActiveBackgroundTasks()).toBe(true);
    expect(app.isBusy).toBe(true);
    expect(transcript.getBackgroundJobsSnapshot().runningJobCount).toBe(1);

    // Settle via standard ACP `tool_call` with NO `name` field, only `title: 'manage_task'` and `rawInput`
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-mt-acp-kill',
      status: 'completed',
      title: 'manage_task',
      rawInput: { Action: 'kill', TaskId: 'bg-task-42' },
      rawOutput: { output: 'Task bg-task-42 killed.' },
    });
    expect(transcript.hasActiveBackgroundTasks()).toBe(false);
    expect(app.isBusy).toBe(false);
    expect(transcript.getBackgroundJobsSnapshot().runningJobCount).toBe(0);
    expect(transcript.getBackgroundJobsSnapshot().detachedTaskCount).toBe(0);
  });

  test('AppStore manages live swarm snapshot, isBusy, bee blobs, and dedicated Swarm Board overlay state', () => {
    const app = new AppStore();

    expect(app.getState().hasSwarm).toBe(false);
    expect(app.getState().isSwarmWorking).toBe(false);
    expect(app.getState().swarmWorkingNames).toEqual([]);
    expect(app.getState().isBusy).toBe(false);
    expect(app.getState().swarmBoardOpen).toBe(false);

    app.setBeeBlobs({
      hud: 'blob-hud',
      active: 'blob-active',
      sleep: 'blob-sleep',
      byMember: {
        coordinator: { active: 'blob-coord-a', sleep: 'blob-coord-s' },
      },
    });
    expect(app.getState().beeHudBlobId).toBe('blob-hud');
    expect(app.getState().beeMemberBlobs?.coordinator?.active).toBe('blob-coord-a');

    const snapshotActive = {
      sessionId: 'sess-swarm',
      swarmDir: '/tmp/swarm',
      title: 'Live Swarm',
      meta: { version: 1, backend: 'local', swarmId: 'sess-swarm', createdAt: '' },
      members: [
        { name: 'coordinator', role: 'coordinator', status: 'waiting' as const, killed: false, messageCount: 1, lastMessageSeq: 1 },
        { name: 'alpha', role: 'worker', status: 'working' as const, killed: false, messageCount: 1, lastMessageSeq: 2 },
        { name: 'beta', role: 'worker', status: 'killed' as const, killed: true, messageCount: 0 },
      ],
      memberByName: {
        coordinator: { name: 'coordinator', role: 'coordinator', status: 'waiting' as const, killed: false, messageCount: 1, lastMessageSeq: 1 },
        alpha: { name: 'alpha', role: 'worker', status: 'working' as const, killed: false, messageCount: 1, lastMessageSeq: 2 },
        beta: { name: 'beta', role: 'worker', status: 'killed' as const, killed: true, messageCount: 0 },
      },
      messageCounts: { coordinator: 1, alpha: 1 },
      messages: [
        { seq: 1, agent: 'coordinator', text: '@alpha start work', time: '2026-11-21 12:00:00', badges: [], mentions: ['alpha'], summary: '@alpha start work' },
        { seq: 2, agent: 'alpha', text: '@coordinator working on slice', time: '2026-11-21 12:01:00', badges: [], mentions: ['coordinator'], summary: '@coordinator working on slice' },
      ],
      latestSeq: 2,
      counts: {
        totalMembers: 3,
        activeMembers: 2,
        workingMembers: 1,
        waitingMembers: 1,
        stoppedMembers: 0,
        killedMembers: 1,
        totalMessages: 2,
        skippedCorruptLines: 0,
      },
      isSwarmActive: true,
      workingMembers: ['alpha'],
      loadedAt: 1000,
    };

    // Background snapshot updates persistent swarm state & keeps isBusy=true even when isStreaming=false
    app.setSwarmSnapshot(snapshotActive);
    expect(app.getState().hasSwarm).toBe(true);
    expect(app.getState().isSwarmWorking).toBe(true);
    expect(app.getState().swarmWorkingNames).toEqual(['alpha']);
    expect(app.getState().isStreaming).toBe(false);
    expect(app.getState().isBusy).toBe(true);

    // Open dedicated Swarm Board overlay -> focusMode='swarm', desiredSurfaceFocus=null, selects latest post #2 (top of descending list)
    app.openSwarmBoard();
    expect(app.getState().swarmBoardOpen).toBe(true);
    expect(app.getState().focusMode).toBe('swarm');
    expect(app.getState().desiredSurfaceFocus).toBeNull();
    expect(app.getFilteredSwarmPosts().map((p) => p.seq)).toEqual([2, 1]);
    expect(app.getState().swarmBoardSelectedSeq).toBe(2);
    expect(app.getState().swarmBoardFollow).toBe(true);

    // Move selection down in descending list -> selects #1 and pauses follow
    expect(app.moveSwarmPostSelection(1)).toBe(1);
    expect(app.getState().swarmBoardSelectedSeq).toBe(1);
    expect(app.getState().swarmBoardFollow).toBe(false);

    // Toggle agent filter to `alpha` -> filters posts to [#2] and selects #2; toggle again clears filter
    expect(app.toggleSwarmAgentFilter('alpha')).toBe('alpha');
    expect(app.getFilteredSwarmPosts().map((p) => p.seq)).toEqual([2]);
    expect(app.getState().swarmBoardSelectedSeq).toBe(2);
    expect(app.toggleSwarmAgentFilter('alpha')).toBeNull();
    expect(app.getFilteredSwarmPosts().map((p) => p.seq)).toEqual([2, 1]);

    // Query search filters posts
    app.setSwarmBoardQuery('start work');
    expect(app.getFilteredSwarmPosts().map((p) => p.seq)).toEqual([1]);
    app.setSwarmBoardQuery('');

    // Re-enable follow snaps back to latest post #2
    expect(app.toggleSwarmBoardFollow()).toBe(true);
    expect(app.getState().swarmBoardSelectedSeq).toBe(2);

    // Close board restores editor focus
    expect(app.closeSwarmBoard()).toBe(true);
    expect(app.getState().focusMode).toBe('editor');
    expect(app.getState().desiredSurfaceFocus).toBe(EDITOR_NODE_ID);

    // Swarm settles -> isSwarmWorking and isBusy return to false while hasSwarm stays true
    app.setSwarmSnapshot({
      ...snapshotActive,
      isSwarmActive: false,
      workingMembers: [],
      counts: { ...snapshotActive.counts, workingMembers: 0, waitingMembers: 2 },
    });
    expect(app.getState().hasSwarm).toBe(true);
    expect(app.getState().isSwarmWorking).toBe(false);
    expect(app.getState().isBusy).toBe(false);

    // Session reset clears all swarm state
    app.resetSessionState();
    expect(app.getState().hasSwarm).toBe(false);
    expect(app.getState().swarmSnapshot).toBeNull();
    expect(app.getState().swarmBoardOpen).toBe(false);
  });

  test('OscWriter & SafeTermOutput enforce DECTCEM cursor-hidden guard, throttling, title+hide atomicity, and clean restore', () => {
    let clock = 10_000;
    const chunks: string[] = [];
    const safeOut = new SafeTermOutput(
      {
        write(data) {
          chunks.push(String(data));
          return true;
        },
      },
      { now: () => clock },
    );
    const osc = createOscWriter(safeOut, { now: () => clock });

    // Before arming, reassertCursorHidden is a no-op
    expect(osc.cursorHidden).toBe(false);
    expect(osc.reassertCursorHidden({ force: true })).toBe(false);
    expect(chunks).toHaveLength(0);

    // Arm via hideCursor()
    expect(osc.hideCursor()).toBe(true);
    expect(osc.cursorHidden).toBe(true);
    expect(chunks).toEqual([HIDE_CURSOR]);

    // Within throttle window (200ms) -> suppressed unless force: true
    clock += 50;
    expect(osc.reassertCursorHidden()).toBe(false);
    expect(osc.reassertCursorHidden({ force: true })).toBe(true);
    expect(chunks).toEqual([HIDE_CURSOR, HIDE_CURSOR]);

    // Past throttle window -> emits again
    clock += 250;
    expect(osc.reassertCursorHidden()).toBe(true);
    expect(chunks).toHaveLength(3);

    // Atomic setTitleAndHideCursor combines OSC 2 + DECTCEM hide
    expect(encodeTitleAndHideCursor('oma · Antigravity')).toBe(
      '\x1b]2;oma · Antigravity\x1b\\\x1b[?25l',
    );
    expect(osc.setTitleAndHideCursor('oma · Antigravity')).toBe(true);
    expect(chunks[chunks.length - 1]).toBe('\x1b]2;oma · Antigravity\x1b\\\x1b[?25l');

    // showCursor disarms guard and emits SHOW_CURSOR
    expect(osc.showCursor()).toBe(true);
    expect(osc.cursorHidden).toBe(false);
    expect(chunks[chunks.length - 1]).toBe(SHOW_CURSOR);
    clock += 500;
    expect(osc.reassertCursorHidden({ force: true })).toBe(false);

    // SafeTermOutput direct cursor guard mirrors the same contract and stops on close()
    const beforeDirect = chunks.length;
    expect(safeOut.setCursorHidden(true)).toBe(true);
    expect(safeOut.cursorHidden).toBe(true);
    expect(safeOut.reassertCursorHidden()).toBe(false);
    clock += 250;
    expect(safeOut.reassertCursorHidden()).toBe(true);
    expect(safeOut.setCursorHidden(false)).toBe(true);
    expect(safeOut.cursorHidden).toBe(false);
    expect(chunks.slice(beforeDirect)).toEqual([HIDE_CURSOR, HIDE_CURSOR, SHOW_CURSOR]);

    safeOut.close();
    expect(safeOut.reassertCursorHidden({ force: true })).toBe(false);
  });

  test('detects >10s background handoff despite log keywords / exit_code=0, classifies MCP commands, and promotes slow generic tools >= 10s', () => {
    let clock = 500_000;
    const store = new TranscriptStore({ now: () => clock });
    store.beginUserTurn('Test background task edge cases');

    // 1. Handed-off `run_command` whose Task Description & Log output contain `completed`/`finished`/`cancelled`
    // AND whose rawOutput includes default `exit_code: 0` MUST NOT be dropped!
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-log-words',
      name: 'run_command',
      kind: 'execute',
      status: 'completed',
      title: 'echo step completed && sleep 13',
      args: { CommandLine: 'echo step completed && sleep 13', WaitMsBeforeAsync: 10000 },
      rawOutput: {
        exit_code: 0,
        output: [
          'Created At: 2026-11-23T11:35:28+08:00',
          'Tool is running as a background task with task id: sess-1/task-log-words',
          'Task Description: echo step completed && sleep 13',
          'Task logs are available at: file:///tmp/task-log-words.log',
          'Log output:',
          'step completed',
          'previous sub-step finished and cancelled old cache',
        ].join('\n'),
      },
    });
    expect(store.hasActiveBackgroundTasks()).toBe(true);
    expect(store.getToolById('tc-log-words')?.backgroundRunning).toBe(true);
    expect(store.getToolById('tc-log-words')?.backgroundTaskId).toBe('sess-1/task-log-words');
    expect(store.getBackgroundJobsSnapshot().detachedTaskCount).toBe(1);
    expect(store.completeBackgroundTask('sess-1/task-log-words', 'completed')).toBe(true);
    expect(store.getToolById('tc-log-words')?.backgroundRunning).toBe(false);

    // 2. Non-bash generic tool handoff (`kind: 'other'`) + MCP command tools + non-command read/edit guard
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-mcp-1',
      name: 'onessh:exec',
      kind: 'other',
      status: 'in_progress',
      title: 'onessh:exec',
    });
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-mcp-2',
      name: 'mcp__onessh__exec_many',
      kind: 'other',
      status: 'in_progress',
      title: 'mcp__onessh__exec_many',
    });
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-mcp-3',
      name: 'call_mcp_tool',
      kind: 'other',
      status: 'in_progress',
      title: 'call_mcp_tool',
      rawInput: { ServerName: 'onessh', ToolName: 'job_start' },
    });
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-cmd-field',
      kind: 'other',
      status: 'in_progress',
      title: 'custom command wrapper',
      rawInput: { CommandLine: 'cargo test --all', WaitMsBeforeAsync: 10000 },
    });
    // Non-command file tools mentioning `bash`/`shell` in path must stay excluded
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-read-bash',
      name: 'read_file',
      kind: 'read',
      status: 'in_progress',
      title: 'read_file /tmp/bash',
    });
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-edit-shell',
      name: 'edit_file',
      kind: 'edit',
      status: 'in_progress',
      title: 'Edit src/shell.ts',
    });

    const mcpSnap = store.getBackgroundJobsSnapshot();
    expect(mcpSnap.runningJobCount).toBe(4);
    expect(mcpSnap.running.some(j => j.id === 'tc-mcp-1' && j.type === 'bash')).toBe(true);
    expect(mcpSnap.running.some(j => j.id === 'tc-mcp-2' && j.type === 'bash')).toBe(true);
    expect(mcpSnap.running.some(j => j.id === 'tc-mcp-3' && j.type === 'task')).toBe(true);
    expect(mcpSnap.running.some(j => j.id === 'tc-cmd-field' && j.type === 'bash')).toBe(true);
    expect(mcpSnap.running.some(j => j.id === 'tc-read-bash' || j.id === 'tc-edit-shell')).toBe(false);

    // Finish MCP/command/file tools cleanly
    for (const id of ['tc-mcp-1', 'tc-mcp-2', 'tc-mcp-3', 'tc-cmd-field', 'tc-read-bash', 'tc-edit-shell']) {
      store.applySessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' });
    }
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(0);

    // 3. Unclassified slow tool (`search_web` with `kind: 'search'`) stays hidden at <10s and promotes at >=10s
    const slowStart = clock;
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-slow-search',
      name: 'search_web',
      kind: 'search',
      status: 'in_progress',
      title: 'Long search query',
    });
    clock = slowStart + LONG_RUNNING_TOOL_THRESHOLD_MS - 1;
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(0);

    clock = slowStart + LONG_RUNNING_TOOL_THRESHOLD_MS;
    const promoted = store.getBackgroundJobsSnapshot();
    expect(promoted.runningJobCount).toBe(1);
    expect(promoted.running[0]?.id).toBe('tc-slow-search');
    expect(promoted.running[0]?.type).toBe('task');

    // Also survives end_turn while >=10s and settles cleanly on completion
    store.finishActiveTurn('end_turn', undefined, undefined, { preserveInFlightBackgroundTools: true });
    expect(store.hasActiveBackgroundTasks()).toBe(true);
    expect(store.getToolById('tc-slow-search')?.backgroundRunning).toBe(true);

    store.applySessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-slow-search', status: 'completed' });
    expect(store.hasActiveBackgroundTasks()).toBe(false);
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(0);
    expect(store.getToolById('tc-slow-search')?.backgroundRunning).toBe(false);

    // 4. Generic fallback handoff when an unclassified tool returns authoritative background output
    store.beginUserTurn('Generic background handoff');
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-generic-bg',
      name: 'custom_runner',
      kind: 'other',
      status: 'completed',
      title: 'Custom long runner',
      rawOutput: {
        exit_code: 0,
        output: 'Tool is running as a background task with task id: sess-1/task-gen-1\nLog output:\nstep completed',
      },
    });
    expect(store.hasActiveBackgroundTasks()).toBe(true);
    expect(store.getBackgroundJobsSnapshot().detachedTaskCount).toBe(1);
    expect(store.getToolById('tc-generic-bg')?.backgroundRunning).toBe(true);
  });

  test('guards against zombie background tasks from stdout keywords, ACP/transcript races, and synchronous tools', () => {
    let clock = 800_000;
    const store = new TranscriptStore({ now: () => clock });
    store.beginUserTurn('Verify zombie task prevention');

    // 1. Completed run_command whose Command output contains background phrasing (with or without exit_code)
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-stdout-fp-1',
      name: 'run_command',
      kind: 'execute',
      status: 'completed',
      title: 'rg background task src/',
      rawOutput: {
        exit_code: 0,
        output: [
          'Command exited with code 0.',
          '',
          'Command output:',
          'Tool is running as a background task with task id: fake/task-1',
        ].join('\n'),
      },
    });
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-stdout-fp-2',
      name: 'run_command',
      kind: 'execute',
      status: 'completed',
      title: 'cat probe.log',
      rawOutput: {
        output: [
          'Command exited with code 0.',
          '',
          'Command output:',
          'Tool is running as a background task with task id: fake/task-2',
        ].join('\n'),
      },
    });
    // Completed read_file & MCP onessh:exec mentioning background task / job_id in body
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-read-fp',
      name: 'read_file',
      kind: 'read',
      status: 'completed',
      title: 'read_file transcript.ts',
      rawOutput: {
        output: [
          'Created At: 2026-11-23T11:30:00+08:00',
          'Completed At: 2026-11-23T11:30:01+08:00',
          'Tool is running as a background task with task id: fake/task-3',
        ].join('\n'),
      },
    });
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-mcp-fp',
      name: 'onessh:exec',
      kind: 'other',
      status: 'completed',
      title: 'onessh:exec',
      rawOutput: {
        output: 'systemctl status ok; background process healthy; job_id: 99',
      },
    });
    expect(store.getBackgroundJobsSnapshot().detachedTaskCount).toBe(0);
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(0);

    // 2a. ACP tool_call_update(completed) finishes BEFORE transcript RUNNING record syncs -> no phantom synthetic entry
    const fastStart = clock;
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-race-fast',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      title: 'bun test fast',
      args: { CommandLine: 'bun test fast', WaitMsBeforeAsync: 10000 },
    });
    clock = fastStart + 10_500;
    store.applySessionUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-race-fast',
      status: 'completed',
      rawOutput: { output: 'Command exited with code 0.\n', exit_code: 0 },
    });
    expect(
      store.syncTranscriptBackgroundTasks([
        {
          taskId: 'sess-race/task-1',
          stepIndex: 10,
          description: 'bun test fast',
          startedAt: fastStart + 10_000,
          status: 'running',
        },
      ]),
    ).toBe(false);
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(0);

    // 2b. Synthetic `transcript:<taskId>` settles when matching ACP tool resolves late
    const lateStart = clock;
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-race-late',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      title: 'bun run build',
      args: { CommandLine: 'bun run build', WaitMsBeforeAsync: 10000 },
    });
    // Temporarily settle end_turn without preserveInFlight or imagine synthetic existed on another turn
    store.beginUserTurn('Separate turn while transcript task runs');
    expect(
      store.syncTranscriptBackgroundTasks([
        {
          taskId: 'sess-race/task-2',
          stepIndex: 11,
          description: 'bun run build-late',
          startedAt: lateStart + 20_000,
          status: 'running',
        },
      ]),
    ).toBe(true);
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(1);
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-late-acp',
      name: 'run_command',
      kind: 'execute',
      status: 'completed',
      title: 'bun run build-late',
      args: { CommandLine: 'bun run build-late' },
      rawOutput: { output: 'Command exited with code 0.\n', exit_code: 0 },
    });
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(0);

    // 2c. Unlabeled running detached task binds rec.taskId instead of creating duplicate synthetic task
    store.beginUserTurn('Unlabeled detached task test');
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-unlabeled',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      title: 'sleep 25',
      args: { CommandLine: 'sleep 25', WaitMsBeforeAsync: 10000 },
    });
    store.finishActiveTurn('end_turn', undefined, undefined, { preserveInFlightBackgroundTools: true });
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(1);
    store.syncTranscriptBackgroundTasks([
      {
        taskId: 'sess-race/task-3',
        stepIndex: 12,
        description: 'sleep 25',
        status: 'running',
      },
    ]);
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(1);
    expect(store.getToolById('tc-unlabeled')?.backgroundTaskId).toBe('sess-race/task-3');
    store.completeBackgroundTask('sess-race/task-3', 'cancelled');
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(0);

    // 3. Synchronous tools (>=10s) close cleanly at end_turn; speculative task without taskId closes on next beginUserTurn
    const syncStart = clock;
    store.beginUserTurn('Synchronous slow tools');
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-sync-manage',
      name: 'manage_task',
      status: 'in_progress',
      title: 'manage_task',
    });
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-sync-edit',
      name: 'edit_file',
      kind: 'edit',
      status: 'in_progress',
      title: 'edit_file',
    });
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-sync-plan',
      name: 'exit_plan_mode',
      status: 'in_progress',
      title: 'exit_plan_mode',
    });
    clock = syncStart + LONG_RUNNING_TOOL_THRESHOLD_MS + 5_000;
    store.finishActiveTurn('end_turn', undefined, undefined, { preserveInFlightBackgroundTools: true });
    expect(store.hasActiveBackgroundTasks()).toBe(false);
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(0);

    // Speculative `awaitingToolCompletion` entry without taskId/conversationId closes when next turn begins
    store.beginUserTurn('Interrupted bash turn');
    store.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-speculative',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      title: 'echo hanging',
      args: { CommandLine: 'echo hanging' },
    });
    store.finishActiveTurn('end_turn', undefined, undefined, { preserveInFlightBackgroundTools: true });
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(1);
    store.beginUserTurn('Next interactive turn');
    expect(store.getBackgroundJobsSnapshot().runningJobCount).toBe(0);
    expect(store.getToolById('tc-speculative')?.backgroundRunning).toBe(false);
  });
});
