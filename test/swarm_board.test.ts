import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  dispatchSlashCommand,
  executeCommandAction,
  type CommandActionExecutor,
} from '../src/commands/handlers';
import {
  ALL_BUILTIN_COMMANDS,
  BUILTIN_COMMANDS,
  CommandRegistry,
} from '../src/commands/registry';
import {
  deriveMemberStatus,
  extractMessageBadges,
  extractMessageMentions,
  getSwarmDir,
  loadSwarmBoard,
  summarizeMessageLine,
  watchSwarmBoard,
  type SwarmBoardSnapshot,
} from '../src/swarm/board';

const tempDirs: string[] = [];

async function makeTempDir(prefix = 'oma-swarm-test-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 2000,
  stepMs = 15,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(stepMs);
  }
  return predicate();
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 1. Path Resolution
// ---------------------------------------------------------------------------

describe('getSwarmDir', () => {
  test('resolves default path under ~/.gemini/antigravity-cli/brain/<sessionId>/.system_generated/swarm', () => {
    const sid = 'ac73f856-71b0-476d-983c-56ab011979a3';
    const expected = path.join(
      os.homedir(),
      '.gemini',
      'antigravity-cli',
      'brain',
      sid,
      '.system_generated',
      'swarm',
    );
    expect(getSwarmDir(sid)).toBe(expected);
  });

  test('respects override precedence: swarmDir > baseBrainDir > appDataDir > geminiDir', () => {
    const sid = 'session-123';
    const customSwarm = path.join(os.tmpdir(), 'custom-swarm');
    const customBrain = path.join(os.tmpdir(), 'custom-brain');
    const customAppData = path.join(os.tmpdir(), 'custom-appdata');
    const customGemini = path.join(os.tmpdir(), 'custom-gemini');

    expect(
      getSwarmDir(sid, {
        swarmDir: customSwarm,
        baseBrainDir: customBrain,
        appDataDir: customAppData,
        geminiDir: customGemini,
      }),
    ).toBe(path.resolve(customSwarm));

    expect(getSwarmDir(sid, { baseBrainDir: customBrain })).toBe(
      path.join(path.resolve(customBrain), sid, '.system_generated', 'swarm'),
    );

    expect(getSwarmDir(sid, { appDataDir: customAppData })).toBe(
      path.join(path.resolve(customAppData), 'brain', sid, '.system_generated', 'swarm'),
    );

    expect(getSwarmDir(sid, { geminiDir: customGemini })).toBe(
      path.join(
        path.resolve(customGemini),
        'antigravity-cli',
        'brain',
        sid,
        '.system_generated',
        'swarm',
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Real agy Swarm File Parsing & Fault Tolerance
// ---------------------------------------------------------------------------

describe('loadSwarmBoard', () => {
  test('parses real agy swarm.json, members.json, and board.jsonl format with sorting and counts', async () => {
    const brainDir = await makeTempDir();
    const sessionId = 'ac73f856-71b0-476d-983c-56ab011979a3';
    const swarmDir = getSwarmDir(sessionId, { baseBrainDir: brainDir });
    await fs.mkdir(swarmDir, { recursive: true });

    await fs.writeFile(
      path.join(swarmDir, 'swarm.json'),
      JSON.stringify({
        version: 1,
        backend: 'local',
        swarm_id: sessionId,
        created_at: '2026-11-20T15:22:53Z',
      }),
      'utf8',
    );

    await fs.writeFile(
      path.join(swarmDir, 'members.json'),
      JSON.stringify(
        {
          title: 'Oh My Agy (oma) Swarm Board',
          members: {
            'old-worker': {
              conversation_id: 'conv-old',
              role: 'worker',
              desired_state: 'KILLED',
              desired_model: 'gemini-4-neon-xhigh',
              applied_model: 'gemini-4-neon-xhigh',
              workspace_mode: 'inherit',
              phase: 'KILLED',
              wake_mode: 'working',
              wait_since: 10,
              last_read_seq: 10,
              last_nudged_seq: 10,
              last_park_blocked_seq: 0,
              killed: true,
              model: 'gemini-4-neon-xhigh',
            },
            'paused-worker': {
              conversation_id: 'conv-paused',
              role: 'worker',
              desired_state: 'STOPPED',
              phase: 'STOPPED',
              wake_mode: 'mentions',
              killed: false,
              model: 'gemini-4-neon-high',
            },
            'swarm-ui': {
              conversation_id: 'conv-ui',
              role: 'worker',
              desired_state: 'RUNNING',
              desired_model: 'gemini-4-neon-high',
              applied_model: 'gemini-4-neon-high',
              workspace_mode: 'inherit',
              phase: 'RUNNING',
              wake_mode: 'mentions',
              wait_since: 3,
              last_read_seq: 3,
              last_nudged_seq: 3,
              last_park_blocked_seq: 0,
              killed: false,
              model: 'gemini-4-neon-high',
            },
            'swarm-data': {
              conversation_id: 'conv-data',
              role: 'worker',
              desired_state: 'RUNNING',
              desired_model: 'gemini-4-neon-high',
              applied_model: 'gemini-4-neon-high',
              workspace_mode: 'inherit',
              phase: 'RUNNING',
              wake_mode: 'working',
              wait_since: 2,
              last_read_seq: 3,
              last_nudged_seq: 3,
              last_park_blocked_seq: 0,
              killed: false,
              model: 'gemini-4-neon-high',
            },
            coordinator: {
              conversation_id: sessionId,
              role: 'coordinator',
              desired_state: 'RUNNING',
              desired_model: 'gemini-4-neon-xhigh',
              applied_model: 'gemini-4-neon-xhigh',
              workspace_mode: 'inherit',
              phase: 'RUNNING',
              wake_mode: 'mentions',
              wait_since: 3,
              last_read_seq: 3,
              last_nudged_seq: 3,
              last_park_blocked_seq: 0,
              killed: false,
              model: 'gemini-4-neon-xhigh',
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    // Deliberately write out-of-order seqs to verify ascending sorting
    const boardLines = [
      JSON.stringify({
        seq: 3,
        agent: 'swarm-data',
        text: '@swarm-ui @swarm-verifier [done] Data layer landed.',
        time: '2026-11-21 00:52:00',
        request_id: 'req-3',
      }),
      JSON.stringify({
        seq: 1,
        agent: 'coordinator',
        text: '@swarm-data Build `src/swarm/board.ts` and reply with `[done]` when finished.',
        time: '2026-11-21 00:47:36',
        kind: 'brief',
        request_id: 'req-1',
      }),
      JSON.stringify({
        seq: 2,
        agent: 'old-worker',
        text: '[blocked] Waiting for schema confirmation.',
        time: '2026-11-21 00:49:10',
      }),
    ];
    await fs.writeFile(path.join(swarmDir, 'board.jsonl'), `${boardLines.join('\n')}\n`, 'utf8');

    const snapshot = await loadSwarmBoard(sessionId, { baseBrainDir: brainDir });
    expect(snapshot).not.toBeNull();
    if (!snapshot) return;

    expect(snapshot.sessionId).toBe(sessionId);
    expect(snapshot.swarmDir).toBe(swarmDir);
    expect(snapshot.title).toBe('Oh My Agy (oma) Swarm Board');
    expect(snapshot.meta).toEqual({
      version: 1,
      backend: 'local',
      swarmId: sessionId,
      createdAt: '2026-11-20T15:22:53Z',
    });

    // Member sorting: coordinator first -> working -> waiting -> stopped -> killed
    expect(snapshot.members.map((m) => `${m.name}:${m.status}`)).toEqual([
      'coordinator:waiting',
      'swarm-data:working',
      'swarm-ui:waiting',
      'paused-worker:stopped',
      'old-worker:killed',
    ]);

    expect(snapshot.memberByName['swarm-data']?.model).toBe('gemini-4-neon-high');
    expect(snapshot.memberByName['swarm-data']?.messageCount).toBe(1);
    expect(snapshot.memberByName['swarm-data']?.lastMessageSeq).toBe(3);
    expect(snapshot.memberByName['swarm-data']?.lastMessageTime).toBe('2026-11-21 00:52:00');
    expect(snapshot.memberByName['swarm-ui']?.messageCount).toBe(0);
    expect(snapshot.memberByName['old-worker']?.killed).toBe(true);

    // Messages sorted by ascending seq
    expect(snapshot.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(snapshot.latestSeq).toBe(3);

    // Message #1 had `[done]` inside backticks — must NOT be misclassified as a done badge
    expect(snapshot.messages[0]?.kind).toBe('brief');
    expect(snapshot.messages[0]?.badges).toEqual([]);
    expect(snapshot.messages[0]?.mentions).toEqual(['swarm-data']);

    // Message #2 has [blocked]
    expect(snapshot.messages[1]?.badges.map((b) => b.tag)).toEqual(['blocked']);

    // Message #3 has real [done] + two mentions
    expect(snapshot.messages[2]?.badges.map((b) => `${b.tag}:${b.tone}`)).toEqual(['done:success']);
    expect(snapshot.messages[2]?.mentions).toEqual(['swarm-ui', 'swarm-verifier']);

    // Counts & active status
    expect(snapshot.counts).toEqual({
      totalMembers: 5,
      activeMembers: 3,
      workingMembers: 1,
      waitingMembers: 2,
      stoppedMembers: 1,
      killedMembers: 1,
      totalMessages: 3,
      skippedCorruptLines: 0,
    });
    expect(snapshot.isSwarmActive).toBe(true);
    expect(snapshot.workingMembers).toEqual(['swarm-data']);
  });

  test('returns null when swarm directory or core metadata files are missing', async () => {
    const brainDir = await makeTempDir();

    // Non-existent session dir
    expect(await loadSwarmBoard('missing-session', { baseBrainDir: brainDir })).toBeNull();

    // Empty sessionId without swarmDir override
    expect(await loadSwarmBoard('   ', { baseBrainDir: brainDir })).toBeNull();

    // Empty swarm dir with no files
    const emptyDir = getSwarmDir('empty-session', { baseBrainDir: brainDir });
    await fs.mkdir(emptyDir, { recursive: true });
    expect(await loadSwarmBoard('empty-session', { baseBrainDir: brainDir })).toBeNull();

    // Corrupt swarm.json and missing members.json
    await fs.writeFile(path.join(emptyDir, 'swarm.json'), '{not-valid-json', 'utf8');
    expect(await loadSwarmBoard('empty-session', { baseBrainDir: brainDir })).toBeNull();
  });

  test('safely skips corrupt JSONL lines and handles UTF-8 BOM without crashing', async () => {
    const swarmDir = await makeTempDir();
    await fs.writeFile(
      path.join(swarmDir, 'swarm.json'),
      JSON.stringify({ version: 1, backend: 'local', swarm_id: 's-corrupt', created_at: '' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Corrupt Line Tolerance',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'working', killed: false },
        },
      }),
      'utf8',
    );

    const mixedBoard = [
      '\uFEFF{"seq":1,"agent":"coordinator","text":"Valid first line","time":"2026-11-21 00:00:01"}',
      '{truncated json line',
      '   ',
      '[1, 2, 3]',
      '{"seq":"not-a-number","agent":"coordinator","text":"bad seq"}',
      '{"seq":2,"agent":"","text":"missing agent"}',
      '{"seq":3,"agent":"coordinator","text":"[stall] Recovered after corrupt lines","time":"2026-11-21 00:00:05"}',
    ].join('\n');
    await fs.writeFile(path.join(swarmDir, 'board.jsonl'), mixedBoard, 'utf8');

    const snapshot = await loadSwarmBoard('s-corrupt', { swarmDir });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.messages.map((m) => m.seq)).toEqual([1, 3]);
    expect(snapshot?.counts.totalMessages).toBe(2);
    expect(snapshot?.counts.skippedCorruptLines).toBe(4);
    expect(snapshot?.messages[1]?.badges.map((b) => b.tag)).toEqual(['stall']);
  });

  test('deriveMemberStatus handles all status combinations accurately', () => {
    expect(deriveMemberStatus({ killed: true, phase: 'RUNNING' })).toBe('killed');
    expect(deriveMemberStatus({ phase: 'KILLED', wake_mode: 'working' })).toBe('killed');
    expect(deriveMemberStatus({ desired_state: 'KILLED' })).toBe('killed');
    expect(deriveMemberStatus({ phase: 'STOPPED', killed: false })).toBe('stopped');
    expect(deriveMemberStatus({ phase: 'RUNNING', wake_mode: 'mentions', killed: false })).toBe('waiting');
    expect(deriveMemberStatus({ phase: 'RUNNING', desired_state: 'RUNNING', wake_mode: 'anything', killed: false })).toBe('waiting');
    expect(deriveMemberStatus({ phase: 'RUNNING', wake_mode: 'all', killed: false })).toBe('waiting');
    expect(deriveMemberStatus({ phase: 'RUNNING', wake_mode: 'working', killed: false })).toBe('working');
    expect(deriveMemberStatus({ status: 'waiting' })).toBe('waiting');
  });

  test('monitor parked with wake_mode=anything is waiting and coordinator-only working does not trigger isSwarmActive', async () => {
    const swarmDir = await makeTempDir();
    await fs.writeFile(
      path.join(swarmDir, 'swarm.json'),
      JSON.stringify({ version: 1, backend: 'local', swarm_id: 's-monitor', created_at: '' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Monitor Waiting Check',
        members: {
          coordinator: {
            role: 'coordinator',
            desired_state: 'RUNNING',
            phase: 'RUNNING',
            wake_mode: 'working',
            killed: false,
          },
          monitor: {
            role: 'worker',
            desired_state: 'RUNNING',
            phase: 'RUNNING',
            wake_mode: 'anything',
            killed: false,
          },
        },
      }),
      'utf8',
    );

    const snapshot = await loadSwarmBoard('s-monitor', { swarmDir });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.memberByName['monitor']?.status).toBe('waiting');
    expect(snapshot?.memberByName['coordinator']?.status).toBe('working');
    expect(snapshot?.counts.waitingMembers).toBe(1);
    expect(snapshot?.isSwarmActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Badge, Mention & Summary Helpers
// ---------------------------------------------------------------------------

describe('Swarm message text helpers', () => {
  test('extractMessageBadges detects [done]/[stall]/[quota]/[blocked] while ignoring code spans & links', () => {
    const badges = extractMessageBadges(
      '@coordinator [done] [QUOTA] [blocked] [stall] `[error]` ```\n[wip]\n``` [info](https://example.com)',
    );
    expect(badges.map((b) => `${b.tag}:${b.tone}`)).toEqual([
      'done:success',
      'quota:warning',
      'blocked:danger',
      'stall:warning',
    ]);

    // Deduplication
    expect(extractMessageBadges('[done] finished [DONE] again').map((b) => b.tag)).toEqual(['done']);
  });

  test('extractMessageMentions extracts unique @mentions and ignores emails and code spans', () => {
    const mentions = extractMessageMentions(
      '@swarm-ui @swarm-verifier contact user@example.com or `@ignored` and @SWARM-UI again',
    );
    expect(mentions).toEqual(['swarm-ui', 'swarm-verifier']);
  });

  test('summarizeMessageLine collapses whitespace, pairs mention-only header lines, and preserves UTF-16 surrogates', () => {
    expect(summarizeMessageLine('\n\n  ### Heading   text  \nSecond line')).toBe('Heading text');
    expect(summarizeMessageLine('@coordinator\n[done] Task finished')).toBe(
      '@coordinator [done] Task finished',
    );

    // Surrogate pair safety (🚀 is 2 UTF-16 code units)
    const emojiLine = 'Hello 🚀🚀🚀🚀 world';
    const truncated = summarizeMessageLine(emojiLine, 8);
    expect(truncated.endsWith('…')).toBe(true);
    // Ensure no lone high surrogate at cut point
    const beforeEllipsis = truncated.charCodeAt(truncated.length - 2);
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Incremental Polling Watcher & Timer Cleanup
// ---------------------------------------------------------------------------

describe('watchSwarmBoard', () => {
  test('detects board.jsonl & members.json changes incrementally and stops cleanly with no further callbacks', async () => {
    const swarmDir = await makeTempDir();
    const sessionId = 'watch-session';

    await fs.writeFile(
      path.join(swarmDir, 'swarm.json'),
      JSON.stringify({ version: 1, backend: 'local', swarm_id: sessionId, created_at: '2026-11-21T00:00:00Z' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Watch Test',
        members: {
          worker: { role: 'worker', phase: 'RUNNING', wake_mode: 'working', killed: false },
        },
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(swarmDir, 'board.jsonl'),
      `${JSON.stringify({ seq: 1, agent: 'worker', text: 'Initial post', time: '2026-11-21 00:00:01' })}\n`,
      'utf8',
    );

    const events: Array<SwarmBoardSnapshot | null> = [];
    const watcher = watchSwarmBoard(
      sessionId,
      (snap) => {
        events.push(snap);
      },
      { swarmDir, intervalMs: 30 },
    );

    try {
      expect(watcher.stopped).toBe(false);

      // No file modification -> should NOT emit spurious updates
      await Bun.sleep(90);
      expect(events).toHaveLength(0);

      // Append a new board message -> should trigger onChange
      await fs.appendFile(
        path.join(swarmDir, 'board.jsonl'),
        `${JSON.stringify({ seq: 2, agent: 'worker', text: '[done] Second post', time: '2026-11-21 00:00:05' })}\n`,
        'utf8',
      );
      const gotMsgUpdate = await waitUntil(() => events.length >= 1, 1500);
      expect(gotMsgUpdate).toBe(true);
      expect(events[events.length - 1]?.messages).toHaveLength(2);
      expect(events[events.length - 1]?.latestSeq).toBe(2);

      // Update members.json -> should trigger another onChange
      const prevCount = events.length;
      await fs.writeFile(
        path.join(swarmDir, 'members.json'),
        JSON.stringify({
          title: 'Watch Test Updated',
          members: {
            worker: { role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
          },
        }),
        'utf8',
      );
      const gotMemberUpdate = await waitUntil(() => events.length > prevCount, 1500);
      expect(gotMemberUpdate).toBe(true);
      expect(events[events.length - 1]?.title).toBe('Watch Test Updated');
      expect(events[events.length - 1]?.memberByName['worker']?.status).toBe('waiting');

      // refreshNow(true) forces an immediate emit even without file edits
      const beforeForce = events.length;
      const forced = await watcher.refreshNow(true);
      expect(forced?.messages).toHaveLength(2);
      expect(events.length).toBe(beforeForce + 1);

      // Idempotent stop() releases timer and prevents future notifications
      watcher.stop();
      watcher.stop();
      expect(watcher.stopped).toBe(true);

      const countAtStop = events.length;
      await fs.appendFile(
        path.join(swarmDir, 'board.jsonl'),
        `${JSON.stringify({ seq: 3, agent: 'worker', text: 'After stop', time: '2026-11-21 00:00:10' })}\n`,
        'utf8',
      );
      await Bun.sleep(100);
      expect(events.length).toBe(countAtStop);
    } finally {
      watcher.stop();
    }
  });

  test('emitInitial: true delivers initial snapshot immediately', async () => {
    const swarmDir = await makeTempDir();
    const events: Array<SwarmBoardSnapshot | null> = [];
    const watcher = watchSwarmBoard(
      'empty-watch',
      (snap) => events.push(snap),
      { swarmDir, intervalMs: 50, emitInitial: true },
    );

    try {
      const ok = await waitUntil(() => events.length === 1, 1000);
      expect(ok).toBe(true);
      expect(events[0]).toBeNull();
    } finally {
      watcher.stop();
    }
  });

  test('detects swarm directory created after watch starts and tracks isSwarmActive -> false transition', async () => {
    const brainDir = await makeTempDir();
    const sessionId = 'late-swarm-session';
    const swarmDir = getSwarmDir(sessionId, { baseBrainDir: brainDir });

    const events: Array<SwarmBoardSnapshot | null> = [];
    const watcher = watchSwarmBoard(
      sessionId,
      (snap) => events.push(snap),
      { baseBrainDir: brainDir, intervalMs: 30, emitInitial: true },
    );

    try {
      // Directory does not exist yet -> initial emit is null, no spurious repeats
      expect(await waitUntil(() => events.length === 1, 1000)).toBe(true);
      expect(events[0]).toBeNull();
      await Bun.sleep(90);
      expect(events).toHaveLength(1);

      // Now `/swarm` creates the directory and writes swarm metadata + working worker
      await fs.mkdir(swarmDir, { recursive: true });
      await fs.writeFile(
        path.join(swarmDir, 'swarm.json'),
        JSON.stringify({ version: 1, backend: 'local', swarm_id: sessionId, created_at: '2026-11-21T12:00:00Z' }),
        'utf8',
      );
      await fs.writeFile(
        path.join(swarmDir, 'members.json'),
        JSON.stringify({
          title: 'Late Created Swarm',
          members: {
            coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
            worker1: { role: 'worker', phase: 'RUNNING', wake_mode: 'working', killed: false },
          },
        }),
        'utf8',
      );

      expect(await waitUntil(() => events.some((e) => e !== null), 1500)).toBe(true);
      const activeSnap = events[events.length - 1]!;
      expect(activeSnap.title).toBe('Late Created Swarm');
      expect(activeSnap.isSwarmActive).toBe(true);
      expect(activeSnap.workingMembers).toEqual(['worker1']);

      // All workers finish and park as waiting -> isSwarmActive flips to false
      const prevLen = events.length;
      await fs.writeFile(
        path.join(swarmDir, 'members.json'),
        JSON.stringify({
          title: 'Late Created Swarm',
          members: {
            coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
            worker1: { role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
          },
        }),
        'utf8',
      );

      expect(await waitUntil(() => events.length > prevLen, 1500)).toBe(true);
      const idleSnap = events[events.length - 1]!;
      expect(idleSnap.isSwarmActive).toBe(false);
      expect(idleSnap.workingMembers).toEqual([]);
    } finally {
      watcher.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Command Registry & `/swarm board` vs `/swarm <task>` Precision Routing
// ---------------------------------------------------------------------------

describe('Swarm command routing & registry integration', () => {
  test('registers /board in default CommandRegistry without breaking BUILTIN_COMMANDS or shadowing agy /swarm', () => {
    expect(BUILTIN_COMMANDS).toHaveLength(10);
    expect(ALL_BUILTIN_COMMANDS.some((c) => c.name === 'board')).toBe(true);
    expect(ALL_BUILTIN_COMMANDS.some((c) => c.name === 'swarm')).toBe(false);

    const registry = new CommandRegistry();
    expect(registry.resolve('board')?.source).toBe('oma');
    expect(registry.resolve('/board')?.builtinId).toBe('board');

    // Completion search finds /board
    const boardMatches = registry.search('board');
    expect(boardMatches[0]?.command.name).toBe('board');
    expect(boardMatches[0]?.nameHits).toEqual([[0, 5]]);

    // Dynamic `agy` /swarm command merges cleanly without conflict
    registry.setAcpCommands([
      {
        name: 'swarm',
        description: 'Spawn and coordinate a multi-agent swarm',
        input: { hint: '<task>' },
      },
    ]);
    const swarmDef = registry.resolve('swarm');
    expect(swarmDef?.source).toBe('agy');
    expect(swarmDef?.passthrough).toBe(true);
    expect(registry.resolve('board')?.source).toBe('oma');
  });

  test('intercepts /swarm board [query] and /board [query] locally as open_swarm_board', async () => {
    const registry = new CommandRegistry();
    registry.setAcpCommands([{ name: 'swarm', description: 'Run swarm' }]);

    const cases: Array<[string, { type: 'open_swarm_board'; query?: string }]> = [
      ['/swarm board', { type: 'open_swarm_board' }],
      ['/swarm board verifier', { type: 'open_swarm_board', query: 'verifier' }],
      ['/SWARM   BOARD   swarm-ui [done]', { type: 'open_swarm_board', query: 'swarm-ui [done]' }],
      ['/board', { type: 'open_swarm_board' }],
      ['/board coordinator', { type: 'open_swarm_board', query: 'coordinator' }],
      ['/BOARD   [stall]', { type: 'open_swarm_board', query: '[stall]' }],
    ];

    const executed: string[] = [];
    const executor: CommandActionExecutor = {
      openPicker: () => {},
      openSwarmBoard: (query) => {
        executed.push(query);
      },
      newSession: () => {},
      setModel: () => {},
      setThought: () => {},
      setMode: () => {},
      copyLastReply: () => {},
      openHelp: () => {},
      quit: () => {},
      passthroughPrompt: () => {
        throw new Error('Must not passthrough /swarm board or /board');
      },
      unknownCommand: () => {
        throw new Error('Must not treat /swarm board or /board as unknown');
      },
    };

    for (const [input, expectedAction] of cases) {
      const res = dispatchSlashCommand(input, registry);
      expect(res.isCommand).toBe(true);
      if (!res.isCommand) continue;
      expect(res.action).toEqual(expectedAction);
      await executeCommandAction(res.action, executor);
    }

    expect(executed).toEqual(['', 'verifier', 'swarm-ui [done]', '', 'coordinator', '[stall]']);
  });

  test('NEVER intercepts /swarm or /swarm <task> — always passes through to agy acp (with or without ACP registration)', () => {
    // Test BOTH before and after `setAcpCommands` registers `/swarm`
    const registries = [new CommandRegistry(), new CommandRegistry()];
    registries[1]!.setAcpCommands([{ name: 'swarm', description: 'Run swarm', input: { hint: '<task>' } }]);

    const passthroughInputs: Array<[string, string]> = [
      ['/swarm', '/swarm'],
      ['/swarm 开始实装', '/swarm 开始实装'],
      ['/swarm 帮我写代码', '/swarm 帮我写代码'],
      ['/swarm boarding pass feature', '/swarm boarding pass feature'],
      ['/swarm board-fix layout bug', '/swarm board-fix layout bug'],
      ['/swarm status', '/swarm status'],
      ['/SWARM   multi-line\ntask prompt', '/swarm multi-line\ntask prompt'],
    ];

    for (const registry of registries) {
      for (const [input, expectedText] of passthroughInputs) {
        const res = dispatchSlashCommand(input, registry);
        expect(res.isCommand).toBe(true);
        if (!res.isCommand) continue;
        expect(res.action).toEqual({
          type: 'passthrough_prompt',
          text: expectedText,
          commandName: 'swarm',
          source: 'agy',
        });
      }
    }
  });

  test('parses plan.json into Swarm Overview (goal, done/working/blocked counts, up to 6 threads) and watches plan.json updates', async () => {
    const baseBrainDir = await makeTempDir('oma-swarm-overview-');
    const sessionId = 'sess-overview';
    const swarmDir = getSwarmDir(sessionId, { baseBrainDir });
    await fs.mkdir(swarmDir, { recursive: true });

    await fs.writeFile(
      path.join(swarmDir, 'swarm.json'),
      JSON.stringify({ version: 1, backend: 'acp', swarm_id: 'sw-ov', created_at: '2026-11-23T00:00:00Z' }),
      'utf8',
    );
    await fs.writeFile(
      path.join(swarmDir, 'members.json'),
      JSON.stringify({
        title: 'Release Hardening',
        members: {
          coordinator: { role: 'coordinator', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
          'api-dev': { role: 'worker', phase: 'RUNNING', wake_mode: 'none', killed: false },
          'ui-dev': { role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
          'qa-verify': { role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
          'docs-dev': { role: 'worker', phase: 'RUNNING', wake_mode: 'mentions', killed: false },
        },
      }),
      'utf8',
    );
    await fs.writeFile(
      path.join(swarmDir, 'board.jsonl'),
      [
        JSON.stringify({ seq: 1, agent: 'ui-dev', text: '[done] UI overview finished', time: '2026-11-23 00:01:00' }),
        JSON.stringify({ seq: 2, agent: 'qa-verify', text: '[blocked] Waiting on test fixture', time: '2026-11-23 00:02:00' }),
      ].join('\n') + '\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(swarmDir, 'plan.json'),
      JSON.stringify({
        goal: {
          title: 'Ship agy 1.5.14 parity',
          line: 'Align Swarm Overview, Orchestrator planner capsule, and /thinking stream.',
        },
        tasks: {
          'api-dev': 'Wire controller & ACP handlers',
          'ui-dev': 'Build Swarm Overview pane',
          'qa-verify': 'Run E2E verification',
          'docs-dev': 'Update docs',
        },
        threads: [
          { id: 't1', title: 'Backend', goal: 'Controller + Store', tasks: ['api-dev'] },
          { id: 't2', title: 'Frontend', goal: 'Overview UI', tasks: ['ui-dev'] },
          { id: 't3', title: 'QA', goal: 'Verify regressions', tasks: ['qa-verify'] },
          { id: 't4', title: 'Docs', goal: 'Notes', tasks: ['docs-dev'] },
          { id: 't5', title: 'Extra 5', goal: 'Five', tasks: [] },
          { id: 't6', title: 'Extra 6', goal: 'Six', tasks: [] },
          { id: 't7', title: 'Overflow 7', goal: 'Should cap at 6', tasks: [] },
        ],
      }),
      'utf8',
    );

    const snap = await loadSwarmBoard(sessionId, { baseBrainDir });
    expect(snap).not.toBeNull();
    expect(snap!.overview).toBeDefined();
    expect(snap!.overview!.goalTitle).toBe('Ship agy 1.5.14 parity');
    expect(snap!.overview!.goalLine).toContain('Orchestrator planner capsule');
    expect(snap!.overview!.totalTasks).toBe(4);
    expect(snap!.overview!.doneCount).toBe(1);
    expect(snap!.overview!.workingCount).toBe(1);
    expect(snap!.overview!.blockedCount).toBe(1);
    expect(snap!.overview!.threads).toHaveLength(6);
    expect(snap!.overview!.threads[0]!.status).toBe('working');
    expect(snap!.overview!.threads[1]!.status).toBe('done');
    expect(snap!.overview!.threads[2]!.status).toBe('blocked');
    expect(snap!.overview!.threads[3]!.status).toBe('waiting');

    // watchSwarmBoard must detect plan.json edits
    const events: SwarmBoardSnapshot[] = [];
    const watcher = watchSwarmBoard(
      sessionId,
      (s) => {
        if (s) events.push(s);
      },
      { baseBrainDir, intervalMs: 30, emitInitial: true },
    );
    try {
      expect(await waitUntil(() => events.length >= 1, 1500)).toBe(true);
      const countBefore = events.length;
      await fs.writeFile(
        path.join(swarmDir, 'plan.json'),
        JSON.stringify({
          goal: { title: 'Updated Goal Title', line: 'Updated line' },
          tasks: { 'ui-dev': 'Done' },
          threads: [{ id: 't2', title: 'Frontend', goal: 'Done', tasks: ['ui-dev'] }],
        }),
        'utf8',
      );
      expect(await waitUntil(() => events.length > countBefore, 1500)).toBe(true);
      expect(events[events.length - 1]!.overview?.goalTitle).toBe('Updated Goal Title');
    } finally {
      watcher.stop();
    }
  });
});
