import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TodoProvider } from '../src/config/config';
import { PreviewStore, type PersistedSessionTodoState } from '../src/preview/store';
import {
  callTodoMcp,
  cleanupHarnessTempDirs,
  createTestController,
  DEFAULT_TEST_CONFIG_OPTIONS,
  makeHarnessTempDir,
  waitFor,
} from './helpers/controller_harness';

afterEach(() => cleanupHarnessTempDirs());

const mcpTool = (id: string, status: string, rawInput: Record<string, unknown>) => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  name: 'mcp_oma_todo_todo',
  status,
  rawInput,
});

const userMsg = (text = 'History') => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });

async function changeTodoProviderInSettings(
  ctx: Awaited<ReturnType<typeof createTestController>>,
  next: TodoProvider,
): Promise<void> {
  await ctx.controller.submitInput('/settings interface');
  await waitFor(() => Boolean(ctx.controller.store.getState().settings));
  ctx.testHost!.input.emitTspEvent({ ev: 'change', sf: 'oma', id: 'layer.settings', item: 'ui.todo_provider', value: next });
  await waitFor(() => ctx.controller.config.ui.todo_provider === next);
  ctx.controller.store.closeSettings();
}

describe('Controller session & todo P1 regression matrix', () => {
  // 1. Todo Anchor Reconciliation Matrix
  const anchorSpecs: Array<{
    label: string;
    anchorTodoState: PersistedSessionTodoState;
    replayOps: Array<Record<string, unknown>>;
    expected: {
      replayed: number;
      persisted: number;
      tasks: string[];
      user: boolean;
      reminder: string | null;
      source: 'user' | 'auto';
      secondFull: boolean;
    };
  }> = [
    {
      label: 'user override survives partial replay and preserves anchor count floor across re-resume',
      anchorTodoState: {
        phases: [{ name: 'Manual', tasks: [{ content: 'Preserved manual edit', status: 'in_progress' }] }],
        toolCallCount: 2,
        source: 'user',
      },
      replayOps: [
        mcpTool('tc-1', 'completed', { op: 'init', items: ['Task 1'] }),
        mcpTool('tc-view', 'completed', { op: 'view' }),
        mcpTool('tc-fail', 'failed', { op: 'append', task: 'Failed' }),
        mcpTool('tc-inflight', 'in_progress', { op: 'append', task: 'Task 2' }),
      ],
      expected: { replayed: 1, persisted: 2, tasks: ['Preserved manual edit'], user: true, reminder: 'Preserved manual edit', source: 'user', secondFull: true },
    },
    {
      label: 'explicit user clear (phases: []) survives replay count drop and sends clear reminder',
      anchorTodoState: { phases: [], toolCallCount: 2, source: 'user' },
      replayOps: [mcpTool('tc-1', 'completed', { op: 'init', items: ['Task 1'] }), mcpTool('tc-2', 'failed', { op: 'append', task: 'Task 2' })],
      expected: { replayed: 1, persisted: 2, tasks: [], user: true, reminder: 'cleared the previous todo list', source: 'user', secondFull: false },
    },
    {
      label: 'zero-call explicit user clear restores empty state without sending redundant reminder',
      anchorTodoState: { phases: [], toolCallCount: 0, source: 'user' },
      replayOps: [],
      expected: { replayed: 0, persisted: 0, tasks: [], user: true, reminder: null, source: 'user', secondFull: false },
    },
    {
      label: 'user anchor matching replayed phases keeps user provenance without sending duplicate reminder',
      anchorTodoState: { phases: [{ name: 'Todos', tasks: [{ content: 'Same A', status: 'in_progress' }] }], toolCallCount: 2, source: 'user' },
      replayOps: [mcpTool('tc-1', 'completed', { op: 'init', items: ['Same A'] }), mcpTool('tc-2', 'failed', { op: 'append', task: 'Dropped B' })],
      expected: { replayed: 1, persisted: 2, tasks: ['Same A'], user: true, reminder: null, source: 'user', secondFull: false },
    },
    {
      label: 'stale over-counted auto anchor adopts replayed transcript without resurrecting failed task',
      anchorTodoState: {
        phases: [{ name: 'Todos', tasks: [{ content: 'Keep', status: 'in_progress' }, { content: 'Stale failed task', status: 'pending' }] }],
        toolCallCount: 2,
        source: 'auto',
      },
      replayOps: [mcpTool('tc-1', 'completed', { op: 'init', items: ['Keep'] }), mcpTool('tc-2', 'failed', { op: 'append', task: 'Stale failed task' })],
      expected: { replayed: 1, persisted: 1, tasks: ['Keep'], user: false, reminder: null, source: 'auto', secondFull: false },
    },
    {
      label: 'legacy anchor without source (over-counted) adopts replayed transcript as auto',
      anchorTodoState: {
        phases: [{ name: 'Todos', tasks: [{ content: 'Task A', status: 'in_progress' }, { content: 'Legacy B', status: 'pending' }] }],
        toolCallCount: 2,
      },
      replayOps: [mcpTool('tc-1', 'completed', { op: 'init', items: ['Task A'] }), mcpTool('tc-2', 'failed', { op: 'append', task: 'Legacy B' })],
      expected: { replayed: 1, persisted: 1, tasks: ['Task A'], user: false, reminder: null, source: 'auto', secondFull: false },
    },
    {
      label: 'legacy anchor without source (equal count) adopts latest replayed init as auto',
      anchorTodoState: { phases: [{ name: 'Todos', tasks: [{ content: 'Task A', status: 'in_progress' }] }], toolCallCount: 2 },
      replayOps: [mcpTool('tc-1', 'completed', { op: 'init', items: ['Task A'] }), mcpTool('tc-2', 'completed', { op: 'init', items: ['Task B'] })],
      expected: { replayed: 2, persisted: 2, tasks: ['Task B'], user: false, reminder: null, source: 'auto', secondFull: false },
    },
  ];

  test.each(anchorSpecs)('$label', async spec => {
    const tmp = makeHarnessTempDir();
    const previewStore = new PreviewStore({ sessionsDir: join(tmp, 'sessions') });
    const sessionId = 'sess-matrix';
    await previewStore.save({ sessionId, cwd: tmp, title: spec.label, turnCount: 1, preview: [{ role: 'user', text: 'History' }], todoState: spec.anchorTodoState });

    const ctx = await createTestController({
      tmp,
      previewStore,
      cliArgs: ['--resume', sessionId],
      todoProvider: 'mcp',
      replayUpdates: () => [userMsg(), ...spec.replayOps],
    });
    await ctx.boot();

    expect(ctx.controller.store.transcript.todoToolCallCount).toBe(spec.expected.replayed);
    expect(ctx.controller.store.transcript.persistedTodoToolCallCount).toBe(spec.expected.persisted);
    expect(ctx.controller.store.transcript.hasUserTodoOverride).toBe(spec.expected.user);
    expect(ctx.controller.store.transcript.todoPhases.flatMap(p => p.tasks.map(t => t.content))).toEqual(spec.expected.tasks);

    if (spec.expected.secondFull) {
      await ctx.shutdown();
      const afterPartial = await previewStore.load(sessionId);
      expect(afterPartial?.todoState?.toolCallCount).toBe(2);
      expect(afterPartial?.todoState?.source).toBe('user');

      const ctxFull = await createTestController({
        tmp,
        previewStore,
        cliArgs: ['--resume', sessionId],
        todoProvider: 'mcp',
        replayUpdates: () => [userMsg(), mcpTool('tc-1', 'completed', { op: 'init', items: ['Task 1'] }), mcpTool('tc-2', 'completed', { op: 'append', task: 'Task 2' })],
      });
      await ctxFull.boot();
      expect(ctxFull.controller.store.transcript.todoToolCallCount).toBe(2);
      expect(ctxFull.controller.store.transcript.hasUserTodoOverride).toBe(true);
      expect(ctxFull.controller.store.transcript.todoPhases.flatMap(p => p.tasks.map(t => t.content))).toEqual(spec.expected.tasks);
      await ctxFull.controller.submitInput('Follow-up prompt');
      await waitFor(() => ctxFull.acp.sentPrompts.length === 1 && !ctxFull.controller.store.getState().isStreaming);
      expect(ctxFull.acp.sentPrompts[0]?.text).toContain(spec.expected.reminder!);
      await ctxFull.shutdown();
      return;
    }

    await ctx.controller.submitInput('Follow-up prompt');
    await waitFor(() => ctx.acp.sentPrompts.length === 1 && !ctx.controller.store.getState().isStreaming);
    if (spec.expected.reminder) {
      expect(ctx.acp.sentPrompts[0]?.text).toContain('<system-reminder>');
      expect(ctx.acp.sentPrompts[0]?.text).toContain(spec.expected.reminder);
    } else {
      expect(ctx.acp.sentPrompts[0]?.text.includes('<system-reminder>')).toBe(false);
    }

    await ctx.shutdown();
    const persisted = await previewStore.load(sessionId);
    expect(persisted?.todoState?.source).toBe(spec.expected.source);
    expect(persisted?.todoState?.toolCallCount).toBe(spec.expected.persisted);
  });

  test('invalidates stale user anchor on replay/post-ready count overflow while protecting live user edits and late carry-over updates', async () => {
    const tmp = makeHarnessTempDir();
    const previewStore = new PreviewStore({ sessionsDir: join(tmp, 'sessions') });
    const oldAnchor: PersistedSessionTodoState = {
      phases: [{ name: 'Todos', tasks: [{ content: 'Old User Override', status: 'in_progress' }] }],
      toolCallCount: 1,
      source: 'user',
    };

    const sessStartup = 'sess-overflow-startup';
    await previewStore.save({ sessionId: sessStartup, cwd: tmp, title: 'Startup Overflow', thoughtLevel: 'low', turnCount: 1, preview: [{ role: 'user', text: 'History' }], todoState: oldAnchor });
    let setConfigEntered = false;
    const setConfigGate = Promise.withResolvers<void>();
    const ctx1 = await createTestController({
      tmp,
      previewStore,
      cliArgs: ['--resume', sessStartup],
      todoProvider: 'mcp',
      replayUpdates: () => [userMsg(), mcpTool('tc-1', 'completed', { op: 'init', items: ['Task 1'] }), mcpTool('tc-2', 'in_progress', { op: 'append', task: 'Task 2' })],
      onRpc: (msg, h) => {
        if (msg.method === 'session/set_config_option') {
          setConfigEntered = true;
          void setConfigGate.promise.then(() => h.reply(msg.id, { configOptions: DEFAULT_TEST_CONFIG_OPTIONS }));
          return true;
        }
      },
    });
    ctx1.start();
    await waitFor(() => setConfigEntered);
    ctx1.acp.sendUpdate(sessStartup, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'completed' });
    setConfigGate.resolve();
    await ctx1.controller.readyPromise;
    await waitFor(() => ctx1.controller.store.getState().isReady && !ctx1.controller.store.getState().isReplaying);

    expect(ctx1.controller.store.transcript.todoToolCallCount).toBe(2);
    expect(ctx1.controller.store.transcript.hasUserTodoOverride).toBe(false);
    expect(ctx1.controller.store.transcript.todoPhases.flatMap(p => p.tasks.map(t => t.content))).toEqual(['Task 1', 'Task 2']);
    expect((await callTodoMcp(ctx1.acp.mcpUrls[0]!, { op: 'view' })).text).toContain('Task 2');
    await ctx1.controller.submitInput('After startup overflow');
    await waitFor(() => ctx1.acp.sentPrompts.length === 1 && !ctx1.controller.store.getState().isStreaming);
    expect(ctx1.acp.sentPrompts[0]?.text.includes('<system-reminder>')).toBe(false);
    await ctx1.shutdown();
    expect((await previewStore.load(sessStartup))?.todoState?.source).toBe('auto');

    for (const withLiveEdit of [false, true]) {
      const sid = withLiveEdit ? 'sess-post-ready-edited' : 'sess-post-ready-stale';
      await previewStore.save({ sessionId: sid, cwd: tmp, title: sid, turnCount: 1, preview: [{ role: 'user', text: 'History' }], todoState: oldAnchor });
      const ctx = await createTestController({
        tmp,
        previewStore,
        cliArgs: ['--resume', sid],
        todoProvider: 'mcp',
        replayUpdates: () => [userMsg(), mcpTool('tc-1', 'completed', { op: 'init', items: ['Task 1'] }), mcpTool('tc-2', 'in_progress', { op: 'append', task: 'Task 2' })],
      });
      await ctx.boot();
      if (withLiveEdit) await ctx.controller.submitInput('/todo append Live Manual');
      ctx.acp.sendUpdate(sid, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'completed' });
      await waitFor(() => ctx.controller.store.transcript.todoToolCallCount === 2);

      if (withLiveEdit) {
        expect(ctx.controller.store.transcript.hasUserTodoOverride).toBe(true);
        expect(ctx.controller.store.transcript.todoPhases.flatMap(p => p.tasks.map(t => t.content))).toEqual(['Old User Override', 'Live Manual']);
        await waitFor(async () => (await previewStore.load(sid))?.todoState?.toolCallCount === 2);
        expect((await previewStore.load(sid))?.todoState?.source).toBe('user');
      } else {
        expect(ctx.controller.store.transcript.hasUserTodoOverride).toBe(false);
        expect(ctx.controller.store.transcript.todoPhases.flatMap(p => p.tasks.map(t => t.content))).toEqual(['Task 1', 'Task 2']);
        await waitFor(async () => (await previewStore.load(sid))?.todoState?.source === 'auto');
      }
      await ctx.shutdown();
    }
  });

  test('preserves user todoState across native/off modes, handles same-session provider reload & rollback, external/corrupt anchors, and cross-epoch reminders', async () => {
    const tmp = makeHarnessTempDir();
    const previewStore = new PreviewStore({ sessionsDir: join(tmp, 'sessions') });
    const sessionId = 'sess-cross-provider';
    const userState: PersistedSessionTodoState = {
      phases: [{ name: 'Manual', tasks: [{ content: 'Saved Manual Task', status: 'in_progress' }] }],
      toolCallCount: 1,
      source: 'user',
    };
    await previewStore.save({ sessionId, cwd: tmp, title: 'Cross Provider', turnCount: 1, preview: [{ role: 'user', text: 'History' }], todoState: userState });

    let failLoadOnce = false;
    const offCtx = await createTestController({
      tmp,
      previewStore,
      cliArgs: ['--resume', sessionId],
      todoProvider: 'off',
      sessions: [{ sessionId, cwd: tmp, title: 'Cross Provider', updatedAt: '2026-11-24T12:00:00.000Z' }],
      replayUpdates: () => [userMsg(), mcpTool('tc-1', 'completed', { op: 'init', items: ['Old Init'] })],
      onRpc: (msg, h) => {
        if (msg.method === 'session/load' && failLoadOnce) {
          failLoadOnce = false;
          h.replyError(msg.id, -32000, 'transient reload failure');
          return true;
        }
      },
    });
    await offCtx.boot();
    expect(offCtx.controller.committedSessionTodoProvider).toBe('off');

    await changeTodoProviderInSettings(offCtx, 'mcp');
    await offCtx.controller.submitInput('/todo append Blocked before reload');
    expect(offCtx.controller.store.getState().activeToast?.text).toContain('MCP todo is not active in this session yet');

    failLoadOnce = true;
    await offCtx.controller.submitInput('/resume');
    await waitFor(() => offCtx.controller.store.getState().picker?.kind === 'resume' && !offCtx.controller.store.getState().picker?.loading);
    offCtx.controller.store.setPickerSelected(sessionId);
    offCtx.host.input.emit('\r');
    await waitFor(() => Boolean(offCtx.controller.store.getState().activeToast?.text.includes('restored previous session')) && offCtx.controller.store.getState().isReady);
    expect(offCtx.controller.committedSessionTodoProvider).toBe('off');

    await offCtx.controller.submitInput('/resume');
    await waitFor(() => offCtx.controller.store.getState().picker?.kind === 'resume' && !offCtx.controller.store.getState().picker?.loading);
    offCtx.controller.store.setPickerSelected(sessionId);
    offCtx.host.input.emit('\r');
    await waitFor(() => offCtx.controller.committedSessionTodoProvider === 'mcp' && offCtx.controller.activeTodoRouteSessionId === sessionId && offCtx.controller.store.getState().isReady);
    expect(offCtx.controller.store.transcript.todoPhases.flatMap(p => p.tasks.map(t => t.content))).toEqual(['Saved Manual Task']);
    await offCtx.shutdown();

    const sessNativeEvict = 'sess-native-evict';
    await previewStore.save({ sessionId: sessNativeEvict, cwd: tmp, title: 'Native Evict', turnCount: 1, preview: [{ role: 'user', text: 'History' }], todoState: userState });
    const natCtx = await createTestController({
      tmp,
      previewStore,
      cliArgs: ['--resume', sessNativeEvict],
      todoProvider: 'native',
      replayUpdates: () => [userMsg(), mcpTool('tc-1', 'completed', { op: 'init', items: ['Task A'] }), mcpTool('tc-2', 'in_progress', { op: 'start', task: 'Task A' })],
    });
    await natCtx.boot();
    natCtx.acp.sendUpdate(sessNativeEvict, { sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'completed' });
    await waitFor(async () => (await previewStore.load(sessNativeEvict))?.todoState?.source === 'auto');
    expect((await previewStore.load(sessNativeEvict))?.todoState?.toolCallCount).toBe(2);
    await natCtx.shutdown();

    for (const extCase of ['missing', 'local_empty', 'local_corrupt'] as const) {
      const sid = `sess-ext-${extCase}`;
      const extPath = join(tmp, `${sid}-external.json`);
      await Bun.write(extPath, JSON.stringify({ version: 1, sessionId: sid, cwd: tmp, title: sid, updatedAt: '2026-11-24T20:00:00.000Z', preview: [], todoState: userState }));
      if (extCase === 'local_empty') await previewStore.save({ sessionId: sid, cwd: tmp, title: sid, turnCount: 1, preview: [] });
      else if (extCase === 'local_corrupt') {
        mkdirSync(previewStore.sessionsDir, { recursive: true });
        await Bun.write(previewStore.getFilePath(sid), '{ broken json');
      }
      const extCtx = await createTestController({ tmp, previewStore, cliArgs: ['--resume', extPath], todoProvider: 'mcp', replayUpdates: () => [userMsg()] });
      await extCtx.boot();
      if (extCase === 'missing') {
        expect(extCtx.controller.store.transcript.hasUserTodoOverride).toBe(true);
        expect(extCtx.controller.store.transcript.todoPhases[0]?.tasks[0]?.content).toBe('Saved Manual Task');
      } else {
        expect(extCtx.controller.store.transcript.hasUserTodoOverride).toBe(false);
        expect(extCtx.controller.store.transcript.todoPhases).toEqual([]);
      }
      await extCtx.shutdown();
    }

    for (const sid of ['sess-rem-a', 'sess-rem-b']) {
      await previewStore.save({ sessionId: sid, cwd: tmp, title: sid, turnCount: 1, preview: [{ role: 'user', text: 'History' }], todoState: userState });
    }
    let resolvePromptA!: () => void;
    const remCtx = await createTestController({
      tmp,
      previewStore,
      cliArgs: ['--resume', 'sess-rem-a'],
      todoProvider: 'mcp',
      sessions: [
        { sessionId: 'sess-rem-a', cwd: tmp, title: 'A', updatedAt: '2026-11-24T12:00:00.000Z' },
        { sessionId: 'sess-rem-b', cwd: tmp, title: 'B', updatedAt: '2026-11-24T12:01:00.000Z' },
      ],
      replayUpdates: sid => [userMsg(), mcpTool(`tc-${sid}`, 'completed', { op: 'init', items: ['Old'] })],
      onPrompt: (rec, msg, h) => {
        if (rec.sessionId === 'sess-rem-a') {
          resolvePromptA = () => h.reply(msg.id, { stopReason: 'end_turn' });
          return true;
        }
      },
    });
    await remCtx.boot();
    void remCtx.controller.submitInput('Pending on A');
    await waitFor(() => Boolean(resolvePromptA));

    await remCtx.controller.submitInput('/resume');
    await waitFor(() => remCtx.controller.store.getState().picker?.kind === 'resume' && !remCtx.controller.store.getState().picker?.loading);
    remCtx.controller.store.setPickerSelected('sess-rem-b');
    remCtx.host.input.emit('\r');
    await waitFor(() => remCtx.controller.store.getState().sessionId === 'sess-rem-b' && remCtx.controller.store.getState().isReady);

    resolvePromptA();
    await remCtx.controller.submitInput('Prompt on B');
    await waitFor(() => remCtx.acp.sentPrompts.length === 2 && !remCtx.controller.store.getState().isStreaming);
    expect(remCtx.acp.sentPrompts[1]?.text).toContain('Saved Manual Task');
    await remCtx.shutdown();
  });

  // 2. Session Lifecycle, Carry-Over Controls, Crash Retry & Logout Matrix
  test('blocks premature /new during startup, gates actions during control carry-over, commits route before first isReady, and rolls back failed switches', async () => {
    const tmp = makeHarnessTempDir();
    const previewStore = new PreviewStore({ sessionsDir: join(tmp, 'sessions') });
    await previewStore.save({ sessionId: 'sess-gone', cwd: tmp, title: 'Deleted Session', turnCount: 1, preview: [{ role: 'user', text: 'Gone' }] });

    let holdStartupNew = true;
    const startupNewGate = Promise.withResolvers<void>();
    let holdSetConfig = false;
    let setConfigEntered = false;
    const setConfigGate = Promise.withResolvers<void>();

    const ctx = await createTestController({
      tmp,
      previewStore,
      todoProvider: 'mcp',
      sessions: [
        { sessionId: 'sess-gone', cwd: tmp, title: 'Deleted Session', updatedAt: '2026-11-24T12:00:00.000Z' },
        { sessionId: 'sess-new-1', cwd: tmp, title: 'Session 1', updatedAt: '2026-11-24T12:01:00.000Z' },
      ],
      onRpc: (msg, h) => {
        if (msg.method === 'session/new' && holdStartupNew) {
          holdStartupNew = false;
          h.newCount += 1;
          const url = (msg.params?.['mcpServers'] as Array<{ url?: string }> | undefined)?.[0]?.url;
          if (url) h.mcpUrls.push(url);
          void startupNewGate.promise.then(() => h.reply(msg.id, { sessionId: 'sess-new-1', configOptions: DEFAULT_TEST_CONFIG_OPTIONS }));
          return true;
        }
        if (msg.method === 'session/set_config_option' && holdSetConfig) {
          setConfigEntered = true;
          void setConfigGate.promise.then(() => h.reply(msg.id, { configOptions: DEFAULT_TEST_CONFIG_OPTIONS }));
          return true;
        }
        if (msg.method === 'session/load' && String(msg.params?.['sessionId'] ?? '') === 'sess-gone') {
          h.replyError(msg.id, -32002, 'Session not found');
          return true;
        }
      },
    });

    ctx.start();
    await waitFor(() => ctx.acp.newCount === 1);
    expect(ctx.controller.store.getState().connectionStatus).toBe('initializing');
    await ctx.controller.submitInput('/new');
    expect(ctx.acp.newCount).toBe(1);
    expect(ctx.controller.store.getState().activeToast?.text).toContain('initializing');

    startupNewGate.resolve();
    await ctx.controller.readyPromise;
    await waitFor(() => ctx.controller.store.getState().isReady);

    await ctx.controller.submitInput('/thought low');
    holdSetConfig = true;
    let routeAtFirstReady: string | null | undefined;
    let providerAtFirstReady: string | null | undefined;
    const unsub = ctx.controller.store.subscribe(() => {
      const s = ctx.controller.store.getState();
      if (routeAtFirstReady === undefined && s.isReady && s.sessionId === 'sess-new-2') {
        routeAtFirstReady = ctx.controller.activeTodoRouteSessionId;
        providerAtFirstReady = ctx.controller.committedSessionTodoProvider;
      }
    });

    const newPromise = ctx.controller.submitInput('/new');
    await waitFor(() => setConfigEntered);
    expect(ctx.controller.store.getState().isCreatingSession).toBe(true);
    expect(ctx.controller.store.getState().isReady).toBe(false);

    await ctx.controller.submitInput('Premature prompt');
    expect(ctx.acp.sentPrompts).toHaveLength(0);
    expect(ctx.controller.store.getState().activeToast?.text).toBe('Session is not ready yet');
    expect((await callTodoMcp(ctx.acp.mcpUrls[1]!, { op: 'init', items: ['Premature'] })).isError).toBe(true);

    setConfigGate.resolve();
    holdSetConfig = false;
    await newPromise;
    unsub();
    expect(routeAtFirstReady).toBe('sess-new-2');
    expect(providerAtFirstReady).toBe('mcp');

    await ctx.controller.submitInput('/resume');
    await waitFor(() => ctx.controller.store.getState().picker?.kind === 'resume' && !ctx.controller.store.getState().picker?.loading);
    ctx.controller.store.setPickerSelected('sess-gone');
    ctx.host.input.emit('\r');
    await waitFor(() => !existsSync(previewStore.getFilePath('sess-gone')) && ctx.controller.store.getState().sessionId === 'sess-new-2' && ctx.controller.store.getState().isReady);
    await ctx.shutdown();
  });

  test('recovers committed session+cwd after cross-cwd mid-resume crash, clears streaming/questions on crash without transient isReady, and coalesces reconnects', async () => {
    const tmp = makeHarnessTempDir();
    const dirA = join(tmp, 'dir-a');
    const dirB = join(tmp, 'dir-b');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const previewStore = new PreviewStore({ sessionsDir: join(tmp, 'sessions') });
    await previewStore.save({ sessionId: 'sess-dir-b', cwd: dirB, title: 'Dir B', thoughtLevel: 'low', turnCount: 1, preview: [{ role: 'user', text: 'B' }] });

    const recordedLoads: Array<{ sessionId: string; cwd?: string }> = [];
    let crashOnSetConfig = false;

    const ctx = await createTestController({
      tmp,
      cwd: dirA,
      previewStore,
      todoProvider: 'mcp',
      newSessionId: 'sess-dir-a',
      sessions: [{ sessionId: 'sess-dir-b', cwd: dirB, title: 'Dir B', updatedAt: '2026-11-24T12:00:00.000Z' }],
      onPrompt: (_rec, _msg, h) => {
        h.send({
          jsonrpc: '2.0',
          id: 909,
          method: 'elicitation/create',
          params: { mode: 'form', message: 'Pick option', requestedSchema: { type: 'object', properties: { choice: { type: 'string', title: 'Choice', enum: ['A', 'B'] } } } },
        });
        return true;
      },
      onRpc: (msg, h) => {
        if (msg.method === 'session/load') {
          const p = (msg.params ?? {}) as { sessionId: string; cwd?: string; mcpServers?: Array<{ url?: string }> };
          recordedLoads.push({ sessionId: p.sessionId, cwd: p.cwd });
          if (p.mcpServers?.[0]?.url) h.mcpUrls.push(p.mcpServers[0].url);
          if (p.sessionId === 'sess-dir-b') crashOnSetConfig = true;
          h.reply(msg.id, { sessionId: p.sessionId, configOptions: DEFAULT_TEST_CONFIG_OPTIONS });
          return true;
        }
        if (msg.method === 'session/set_config_option' && crashOnSetConfig) {
          crashOnSetConfig = false;
          h.crash(1);
          return true;
        }
      },
    });
    await ctx.boot();

    let observedTransientReady = false;
    const unsubMidResume = ctx.controller.store.subscribe(() => {
      const s = ctx.controller.store.getState();
      if (s.sessionId === 'sess-dir-b' && s.isReady) observedTransientReady = true;
    });

    await ctx.controller.submitInput('/resume');
    await waitFor(() => ctx.controller.store.getState().picker?.kind === 'resume' && !ctx.controller.store.getState().picker?.loading);
    ctx.host.input.emit('\t');
    await waitFor(() => ctx.controller.store.getState().picker?.scope === 'all-folders');
    ctx.controller.store.setPickerSelected('sess-dir-b');
    ctx.host.input.emit('\r');
    await waitFor(() => ctx.controller.store.getState().connectionStatus === 'crashed');
    unsubMidResume();
    expect(observedTransientReady).toBe(false);

    const retryBtn = ctx.testHost!.findWireNodes(n => n.id.endsWith('crash-banner.end')).at(-1)!;
    ctx.testHost!.input.emitTspEvent({ ev: 'action', sf: 'oma', id: retryBtn.id, act: 'click' });
    await waitFor(() => ctx.controller.store.getState().isReady && ctx.controller.store.getState().sessionId === 'sess-dir-a');
    expect(ctx.controller.store.getState().cwd).toBe(dirA);
    expect(recordedLoads).toEqual([{ sessionId: 'sess-dir-b', cwd: dirB }, { sessionId: 'sess-dir-a', cwd: dirA }]);

    const activeUrl = ctx.acp.mcpUrls.at(-1)!;
    const streamTask = ctx.controller.submitInput('Stream then crash');
    await waitFor(() => ctx.controller.store.getState().isStreaming && ctx.controller.store.getState().activeQuestion !== null);
    let readyDuringCrash = false;
    const unsubCrash = ctx.controller.store.subscribe(() => {
      if (ctx.controller.store.getState().isReady) readyDuringCrash = true;
    });
    ctx.acp.crash(1);
    await waitFor(() => ctx.controller.store.getState().connectionStatus === 'crashed');
    await streamTask;
    unsubCrash();
    expect(readyDuringCrash).toBe(false);
    expect(ctx.controller.activeTodoRouteSessionId).toBeNull();
    expect((await callTodoMcp(activeUrl, { op: 'view' })).status).toBe(404);

    const spawnsBefore = ctx.acp.spawnCount;
    await ctx.controller.submitInput('/settings interface');
    await waitFor(() => Boolean(ctx.controller.store.getState().settings));
    ctx.testHost!.input.emitTspEvent({ ev: 'action', sf: 'oma', id: 'layer.settings', act: 'reconnect' });
    ctx.testHost!.input.emitTspEvent({ ev: 'action', sf: 'oma', id: 'layer.settings', act: 'reconnect' });
    await waitFor(() => ctx.controller.store.getState().isReady);
    expect(ctx.acp.spawnCount).toBe(spawnsBefore + 1);
    await ctx.shutdown();
  });

  test('handles /logout across steady-state failure, transition/startup cancellation, failed-logout recovery, and pre-dispatch prompt abort', async () => {
    const tmp = makeHarnessTempDir();
    const notePath = join(tmp, 'note.txt');
    await Bun.write(notePath, 'Attachment text');
    let failLogout = true;
    let logoutEntered = false;
    let releaseLogout!: () => void;

    const steadyCtx = await createTestController({
      tmp,
      todoProvider: 'mcp',
      newSessionId: 'sess-steady',
      onRpc: (msg, h) => {
        if (msg.method === 'auth/logout') {
          logoutEntered = true;
          releaseLogout = () => (failLogout ? h.replyError(msg.id, -32603, 'logout rpc failed') : h.reply(msg.id, {}));
          return true;
        }
      },
    });
    await steadyCtx.boot();
    steadyCtx.controller.store.addAttachment({ id: 'att-1', kind: 'file', name: 'note.txt', ext: '.txt', mime: 'text/plain', path: 'note.txt', uri: `file://${notePath}` });

    let triggeredMidBuild = false;
    const unsub = steadyCtx.controller.store.subscribe(() => {
      if (steadyCtx.controller.store.getState().isStreaming && !triggeredMidBuild) {
        triggeredMidBuild = true;
        void steadyCtx.controller.submitInput('/logout').then(() => steadyCtx.host.input.emit('\r'));
      }
    });

    await steadyCtx.controller.submitInput('Prompt interrupted before wire');
    await waitFor(() => logoutEntered);
    unsub();
    await waitFor(() => !steadyCtx.controller.store.getState().isStreaming);
    expect(steadyCtx.acp.sentPrompts).toHaveLength(0);
    expect(steadyCtx.controller.store.transcript.turns.at(-1)?.status).toBe('cancelled');

    releaseLogout();
    await waitFor(() => steadyCtx.controller.store.getState().toasts.some(t => t.text.includes('Failed to sign out')));
    expect(steadyCtx.controller.store.getState().sessionId).toBe('sess-steady');
    expect(steadyCtx.controller.store.getState().isReady).toBe(true);
    expect(steadyCtx.controller.activeTodoRouteSessionId).toBe('sess-steady');
    expect(steadyCtx.acp.loadCount).toBe(0);

    await steadyCtx.controller.submitInput('Follow-up after failed logout');
    await waitFor(() => steadyCtx.acp.sentPrompts.length === 1 && !steadyCtx.controller.store.getState().isStreaming);

    let holdSecondNew = true;
    let secondNewEntered = false;
    const secondNewGate = Promise.withResolvers<void>();
    steadyCtx.acp.setHandler((msg, h) => {
      if (msg.method === 'session/new' && holdSecondNew) {
        holdSecondNew = false;
        secondNewEntered = true;
        void secondNewGate.promise.then(() => h.reply(msg.id, { sessionId: 'sess-discarded', configOptions: DEFAULT_TEST_CONFIG_OPTIONS }));
        return;
      }
      if (msg.method === 'session/load') {
        const p = (msg.params ?? {}) as { sessionId: string; mcpServers?: Array<{ url?: string }> };
        if (p.mcpServers?.[0]?.url) h.mcpUrls.push(p.mcpServers[0].url);
        h.reply(msg.id, { sessionId: p.sessionId, configOptions: DEFAULT_TEST_CONFIG_OPTIONS });
        return;
      }
      if (msg.method === 'auth/logout') {
        if (failLogout) h.replyError(msg.id, -32000, 'logout failed on /new');
        else h.reply(msg.id, {});
        return;
      }
      if (msg.method === 'session/close') {
        h.reply(msg.id, {});
        if (h.shuttingDown) h.crash(0);
        return;
      }
      h.reply(msg.id, {});
    });

    const newTask = steadyCtx.controller.submitInput('/new');
    await waitFor(() => secondNewEntered);
    await steadyCtx.controller.submitInput('/logout');
    await waitFor(() => steadyCtx.controller.store.getState().infoOverlay?.kind === 'logout_confirm');
    steadyCtx.host.input.emit('\r');
    secondNewGate.resolve();
    await newTask;
    await waitFor(() => steadyCtx.controller.store.getState().isReady && steadyCtx.controller.store.getState().sessionId === 'sess-steady');
    expect(steadyCtx.controller.activeTodoRouteSessionId).toBe('sess-steady');

    failLogout = false;
    const lastUrl = steadyCtx.acp.mcpUrls.at(-1)!;
    await steadyCtx.controller.submitInput('/logout');
    await waitFor(() => steadyCtx.controller.store.getState().infoOverlay?.kind === 'logout_confirm');
    steadyCtx.host.input.emit('\r');
    await waitFor(() => steadyCtx.controller.store.getState().connectionStatus === 'auth_required');
    expect((await callTodoMcp(lastUrl, { op: 'view' })).status).toBe(404);
    await steadyCtx.shutdown();

    let firstPrefsEntered = false;
    const firstPrefsGate = Promise.withResolvers<void>();
    const cliCtx = await createTestController({
      tmp,
      cliArgs: ['Initial CLI hello'],
      config: { default_thought: 'low' },
      todoProvider: 'mcp',
      onRpc: (msg, h) => {
        if (msg.method === 'session/set_config_option' && !firstPrefsEntered) {
          firstPrefsEntered = true;
          void firstPrefsGate.promise.then(() => h.reply(msg.id, { configOptions: DEFAULT_TEST_CONFIG_OPTIONS }));
          return true;
        }
        if (msg.method === 'auth/logout') {
          h.replyError(msg.id, -32000, 'startup logout failed');
          return true;
        }
      },
    });
    cliCtx.start();
    await waitFor(() => firstPrefsEntered);
    await cliCtx.controller.submitInput('/logout');
    await waitFor(() => cliCtx.controller.store.getState().infoOverlay?.kind === 'logout_confirm');
    cliCtx.host.input.emit('\r');
    await waitFor(() => cliCtx.controller.store.getState().isReady && cliCtx.acp.sentPrompts.length === 1 && !cliCtx.controller.store.getState().isStreaming);
    expect(cliCtx.acp.loadCount).toBe(0);
    expect(cliCtx.acp.sentPrompts[0]?.text).toBe('Initial CLI hello');
    firstPrefsGate.resolve();
    await cliCtx.shutdown();
  });

  // 3. MCP Route Isolation, Settings Survival, Async /todo edit & Save Chains
  test('isolates oma_todo MCP routes across slow ReadableStream /new transitions, keeps active MCP alive on settings change, and re-validates /todo edit', async () => {
    const tmp = makeHarnessTempDir();
    let editorEntered = false;
    let resolveEditor: ((val: string | null) => void) | null = null;
    let closeEntered = false;
    const closeGate = Promise.withResolvers<void>();
    let holdNextClose = false;

    const ctx = await createTestController({
      tmp,
      todoProvider: 'mcp',
      controllerOptions: {
        editTodoExternal: async () => {
          editorEntered = true;
          return new Promise<string | null>(r => {
            resolveEditor = r;
          });
        },
      },
      onRpc: (msg, h) => {
        if (msg.method === 'session/close' && holdNextClose && !h.shuttingDown) {
          holdNextClose = false;
          closeEntered = true;
          void closeGate.promise.then(() => h.reply(msg.id, {}));
          return true;
        }
      },
    });
    await ctx.boot();
    const oldUrl = ctx.acp.mcpUrls[0]!;

    const encoder = new TextEncoder();
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'todo', arguments: { op: 'init', items: ['Stale slow task'] } } });
    const splitAt = Math.floor(payload.length / 2);
    let streamCtrl!: ReadableStreamDefaultController<Uint8Array>;
    let sentFirst = false;
    const firstPulled = Promise.withResolvers<void>();
    const slowBody = new ReadableStream<Uint8Array>({
      start(c) {
        streamCtrl = c;
      },
      pull(c) {
        if (!sentFirst) {
          sentFirst = true;
          c.enqueue(encoder.encode(payload.slice(0, splitAt)));
          firstPulled.resolve();
        }
      },
    });

    holdNextClose = true;
    const slowReq = fetch(oldUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: slowBody });
    await firstPulled.promise;
    await Bun.sleep(15);

    const switchTask = ctx.controller.submitInput('/new');
    await waitFor(() => closeEntered);
    expect((await callTodoMcp(oldUrl, { op: 'init', items: ['Mid-switch'] })).status).toBe(404);
    closeGate.resolve();
    await switchTask;
    await waitFor(() => ctx.controller.store.getState().sessionId === 'sess-new-2' && ctx.controller.store.getState().isReady);

    streamCtrl.enqueue(encoder.encode(payload.slice(splitAt)));
    streamCtrl.close();
    expect((await slowReq).status).toBe(404);
    expect(ctx.controller.store.transcript.todoPhases).toEqual([]);
    const newUrl = ctx.acp.mcpUrls[1]!;
    expect((await callTodoMcp(newUrl, { op: 'view' })).text).toContain('empty');

    await ctx.controller.submitInput('/todo append Active MCP task');
    const conflictEdit = ctx.controller.submitInput('/todo edit');
    await waitFor(() => editorEntered);
    await ctx.controller.submitInput('/todo append Concurrent task');
    resolveEditor!('# Todos\n- [ ] Stale editor overwrite\n');
    editorEntered = false;
    await conflictEdit;
    expect(ctx.controller.store.getState().activeToast?.text).toContain('Todos changed while editor was open');

    await changeTodoProviderInSettings(ctx, 'native');
    expect((await callTodoMcp(newUrl, { op: 'view' })).text).toContain('Concurrent task');

    const offEdit = ctx.controller.submitInput('/todo edit');
    await waitFor(() => editorEntered);
    await changeTodoProviderInSettings(ctx, 'off');
    resolveEditor!('# Todos\n- [ ] Replaced while off\n');
    await offEdit;
    expect(ctx.controller.store.getState().activeToast?.text).toContain('Todo tracking is Off');
    expect(ctx.controller.store.transcript.todoPhases.flatMap(p => p.tasks.map(t => t.content))).toEqual(['Active MCP task', 'Concurrent task']);
    await ctx.shutdown();
  });

  test('serializes queued #anchorSaveChains writes across immediate /quit and /new without losing manual todo edits', async () => {
    for (const transition of ['quit', 'new'] as const) {
      const tmp = makeHarnessTempDir();
      const previewStore = new PreviewStore({ sessionsDir: join(tmp, 'sessions') });
      const origSave = previewStore.save.bind(previewStore);
      let blockNextSave = false;
      const firstSaveEntered = Promise.withResolvers<void>();
      const firstSaveGate = Promise.withResolvers<void>();
      previewStore.save = async input => {
        if (blockNextSave && input.sessionId === 'sess-new-1') {
          blockNextSave = false;
          firstSaveEntered.resolve();
          await firstSaveGate.promise;
        }
        return origSave(input);
      };

      const ctx = await createTestController({ tmp, previewStore, todoProvider: 'mcp' });
      await ctx.boot();

      blockNextSave = true;
      await ctx.controller.submitInput('/todo append "Phase 1" First queued');
      await firstSaveEntered.promise;
      await ctx.controller.submitInput('/todo append "Phase 1" Second queued');

      if (transition === 'quit') {
        const quitTask = ctx.shutdown();
        firstSaveGate.resolve();
        await quitTask;
      } else {
        const newTask = ctx.controller.submitInput('/new');
        await waitFor(() => ctx.controller.store.getState().sessionId === 'sess-new-2' && ctx.controller.store.getState().isReady);
        firstSaveGate.resolve();
        await newTask;
        await waitFor(async () => (await previewStore.load('sess-new-1'))?.todoState?.phases[0]?.tasks.length === 2);
        await ctx.shutdown();
      }

      const saved = await previewStore.load('sess-new-1');
      expect(saved?.todoState?.phases[0]?.tasks.map(t => t.content)).toEqual(['First queued', 'Second queued']);
    }
  });
});
