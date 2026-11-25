import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
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
  loadSessionPreview,
  PreviewStore,
  saveSessionPreview,
} from '../src/preview/store';
import { HIDE_CURSOR } from '../src/termio/osc';
import {
  cleanupHarnessTempDirs,
  createTestController,
  makeHarnessTempDir,
  TestTernHost,
  waitFor,
} from './helpers/controller_harness';

afterEach(() => cleanupHarnessTempDirs());

function createTitleCaptureHost() {
  const base = new TestTernHost();
  const oscTitles: string[] = [];
  const rawChunks: string[] = [];
  const decoder = new TextDecoder();
  const origWrite = base.safeOutput.write.bind(base.safeOutput);

  base.safeOutput.write = (data: Uint8Array | string): boolean => {
    const chunk = typeof data === 'string' ? data : decoder.decode(data);
    rawChunks.push(chunk);
    for (const m of chunk.matchAll(/\x1b\]2;([^\x1b\x07]*)(?:\x1b\\|\x07)/g)) {
      oscTitles.push(m[1] ?? '');
    }
    return origWrite(data);
  };

  return {
    base,
    oscTitles,
    getRawStream: () => rawChunks.join(''),
  };
}

describe('PreviewStore titleSource persistence', () => {
  test('saves and loads titleSource for user and auto titles, ignoring invalid or missing values', async () => {
    const tmp = makeHarnessTempDir('oma-title-preview-');
    const sessionsDir = join(tmp, 'sessions');

    await saveSessionPreview(
      {
        sessionId: 'sess-user',
        cwd: tmp,
        title: 'Custom Lock Title',
        titleSource: 'user',
        preview: [],
      },
      { sessionsDir },
    );
    await saveSessionPreview(
      {
        sessionId: 'sess-auto',
        cwd: tmp,
        title: 'Backend Auto Title',
        titleSource: 'auto',
        preview: [],
      },
      { sessionsDir },
    );
    await saveSessionPreview(
      {
        sessionId: 'sess-legacy',
        cwd: tmp,
        title: 'Legacy Title',
        preview: [],
      },
      { sessionsDir },
    );

    const userRec = await loadSessionPreview('sess-user', { sessionsDir });
    const autoRec = await loadSessionPreview('sess-auto', { sessionsDir });
    const legacyRec = await loadSessionPreview('sess-legacy', { sessionsDir });
    expect(userRec?.title).toBe('Custom Lock Title');
    expect(userRec?.titleSource).toBe('user');
    expect(autoRec?.title).toBe('Backend Auto Title');
    expect(autoRec?.titleSource).toBe('auto');
    expect(legacyRec?.title).toBe('Legacy Title');
    expect(legacyRec?.titleSource).toBeUndefined();

    // Invalid titleSource in JSON on disk is ignored gracefully
    await Bun.write(
      join(sessionsDir, 'sess-invalid.json'),
      JSON.stringify({
        version: 1,
        sessionId: 'sess-invalid',
        cwd: tmp,
        title: 'Fallback Title',
        titleSource: 'bogus',
        updatedAt: new Date().toISOString(),
        preview: [],
      }),
    );
    const invalidRec = await loadSessionPreview('sess-invalid', { sessionsDir });
    expect(invalidRec?.title).toBe('Fallback Title');
    expect(invalidRec?.titleSource).toBeUndefined();
  });
});

describe('/rename and /title command registry & dispatch', () => {
  test('registers /rename in EXTRA_BUILTIN_COMMANDS without changing BUILTIN_COMMANDS length', async () => {
    expect(BUILTIN_COMMANDS).toHaveLength(10);
    const renameDef = ALL_BUILTIN_COMMANDS.find(c => c.name === 'rename');
    expect(renameDef).toBeDefined();
    expect(renameDef?.aliases).toContain('title');
    expect(renameDef?.icon).toBe('pen');
    expect(renameDef?.autoExecuteOnEnter).toBe(false);

    const registry = new CommandRegistry();
    expect(registry.resolve('rename')?.builtinId).toBe('rename');
    expect(registry.resolve('title')?.builtinId).toBe('rename');

    const dispatched = dispatchSlashCommand('/title   Focus Session  ', registry);
    expect(dispatched.isCommand).toBe(true);
    if (dispatched.isCommand) {
      expect(dispatched.action).toEqual({ type: 'rename_session', title: 'Focus Session' });
    }

    const calls: string[] = [];
    const executor: CommandActionExecutor = {
      openPicker() {},
      newSession() {},
      setModel() {},
      setThought() {},
      setMode() {},
      openHelp() {},
      quit() {},
      passthroughPrompt() {},
      unknownCommand() {},
      renameSession(title: string) {
        calls.push(title);
      },
    };
    if (dispatched.isCommand) {
      await executeCommandAction(dispatched.action, executor);
    }
    expect(calls).toEqual(['Focus Session']);
  });
});

describe('Controller dynamic OSC terminal title & local /rename', () => {
  test('syncs session_info_update to OSC 2, deduplicates identical titles, supports /rename lock, --reset, and /new', async () => {
    const capture = createTitleCaptureHost();
    const ctx = await createTestController({
      host: capture.base,
      newSessionId: n => `sess-title-${n}`,
    });

    await ctx.boot();
    expect(capture.oscTitles).toEqual(['oma · Antigravity']);

    // 1. Backend pushes auto title -> updates store, OSC 2, and PreviewStore with titleSource='auto'
    ctx.acp.sendUpdate('sess-title-1', {
      sessionUpdate: 'session_info_update',
      title: 'Fix Auth Flow',
    });
    await waitFor(
      async () =>
        ctx.controller.store.getState().sessionTitle === 'Fix Auth Flow' &&
        (await ctx.previewStore.load('sess-title-1'))?.titleSource === 'auto',
    );
    expect(ctx.controller.store.getState().sessionTitleSource).toBe('auto');
    expect(capture.oscTitles).toEqual(['oma · Antigravity', 'Fix Auth Flow']);
    expect((await ctx.previewStore.load('sess-title-1'))?.title).toBe('Fix Auth Flow');

    // Duplicate identical session_info_update does not emit redundant OSC 2 sequence
    ctx.acp.sendUpdate('sess-title-1', {
      sessionUpdate: 'session_info_update',
      title: 'Fix Auth Flow',
    });
    await Bun.sleep(30);
    expect(capture.oscTitles).toEqual(['oma · Antigravity', 'Fix Auth Flow']);

    // 2. /rename locks title locally with control chars stripped
    await ctx.controller.submitInput('/rename Custom\nFocus\x1bTitle');
    expect(ctx.controller.store.getState().sessionTitle).toBe('Custom FocusTitle');
    expect(ctx.controller.store.getState().sessionTitleSource).toBe('user');
    expect(capture.oscTitles).toEqual([
      'oma · Antigravity',
      'Fix Auth Flow',
      'Custom FocusTitle',
    ]);
    const lockedAnchor = await ctx.previewStore.load('sess-title-1');
    expect(lockedAnchor?.title).toBe('Custom FocusTitle');
    expect(lockedAnchor?.titleSource).toBe('user');

    // Subsequent backend auto title update is blocked by user lock, but remembered for --reset
    ctx.acp.sendUpdate('sess-title-1', {
      sessionUpdate: 'session_info_update',
      title: 'Later Backend Summary',
    });
    await Bun.sleep(30);
    expect(ctx.controller.store.getState().sessionTitle).toBe('Custom FocusTitle');
    expect(ctx.controller.store.getState().sessionTitleSource).toBe('user');
    expect(capture.oscTitles[capture.oscTitles.length - 1]).toBe('Custom FocusTitle');

    // 3. /rename --reset unlocks and restores the latest backend auto title
    await ctx.controller.submitInput('/rename --reset');
    expect(ctx.controller.store.getState().sessionTitle).toBe('Later Backend Summary');
    expect(ctx.controller.store.getState().sessionTitleSource).toBe('auto');
    expect(capture.oscTitles[capture.oscTitles.length - 1]).toBe('Later Backend Summary');
    const resetAnchor = await ctx.previewStore.load('sess-title-1');
    expect(resetAnchor?.title).toBe('Later Backend Summary');
    expect(resetAnchor?.titleSource).toBe('auto');

    // 4. /new resets terminal title back to default and clears user lock
    await ctx.controller.submitInput('/title Locked Before New');
    expect(ctx.controller.store.getState().sessionTitleSource).toBe('user');
    await ctx.controller.submitInput('/new');
    await waitFor(() => ctx.controller.store.getState().sessionId === 'sess-title-2');
    expect(ctx.controller.store.getState().sessionTitle).toBeNull();
    expect(ctx.controller.store.getState().sessionTitleSource).toBeNull();
    expect(capture.oscTitles[capture.oscTitles.length - 1]).toBe('oma · Antigravity');

    // Auto updates work again on the fresh session
    ctx.acp.sendUpdate('sess-title-2', {
      sessionUpdate: 'session_info_update',
      title: 'Second Session Topic',
    });
    await waitFor(() => ctx.controller.store.getState().sessionTitle === 'Second Session Topic');
    expect(capture.oscTitles[capture.oscTitles.length - 1]).toBe('Second Session Topic');

    await ctx.shutdown();
  });

  test('preserves user-locked title across --resume replay and prioritizes it in /resume picker', async () => {
    const tmp = makeHarnessTempDir('oma-title-resume-');
    const previewStore = new PreviewStore({ sessionsDir: join(tmp, 'sessions') });
    await previewStore.save({
      sessionId: 'sess-locked',
      cwd: tmp,
      title: 'Pinned User Title',
      titleSource: 'user',
      turnCount: 1,
      preview: [{ role: 'user', text: 'History' }],
    });

    const capture = createTitleCaptureHost();
    const ctx = await createTestController({
      tmp,
      host: capture.base,
      previewStore,
      cliArgs: ['--resume', 'sess-locked'],
      sessions: [
        {
          sessionId: 'sess-locked',
          cwd: tmp,
          title: 'Remote Backend Title',
          updatedAt: '2026-11-25T10:00:00Z',
        },
        {
          sessionId: 'sess-other',
          cwd: tmp,
          title: 'Other Remote Session',
          updatedAt: '2026-11-25T09:00:00Z',
        },
      ],
      replayUpdates: sid =>
        sid === 'sess-locked'
          ? [
              { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'History' } },
              { sessionUpdate: 'session_info_update', title: 'Replayed Backend Title' },
            ]
          : [],
    });

    await ctx.boot();
    expect(ctx.controller.store.getState().sessionId).toBe('sess-locked');
    expect(ctx.controller.store.getState().sessionTitle).toBe('Pinned User Title');
    expect(ctx.controller.store.getState().sessionTitleSource).toBe('user');
    expect(capture.oscTitles[capture.oscTitles.length - 1]).toBe('Pinned User Title');

    // Replayed backend title was still recorded so /rename --reset can restore it
    await ctx.controller.submitInput('/rename --reset');
    expect(ctx.controller.store.getState().sessionTitle).toBe('Replayed Backend Title');
    expect(ctx.controller.store.getState().sessionTitleSource).toBe('auto');

    // Re-lock and verify /resume picker prioritizes local user-locked title over remote title
    await ctx.controller.submitInput('/rename Local Picker Winner');
    await ctx.controller.submitInput('/resume');
    await waitFor(
      () =>
        ctx.controller.store.getState().picker?.kind === 'resume' &&
        !ctx.controller.store.getState().picker?.loading,
    );
    const pickerEntries = ctx.controller.store.getState().picker?.sessions ?? [];
    const lockedEntry = pickerEntries.find(e => e.sessionId === 'sess-locked');
    expect(lockedEntry?.title).toBe('Local Picker Winner');
    ctx.controller.store.closePicker();

    await ctx.shutdown();
  });

  test('re-emits dynamic session title atomically with HIDE_CURSOR after /login resume', async () => {
    const capture = createTitleCaptureHost();
    const ctx = await createTestController({
      host: capture.base,
      newSessionId: 'sess-login-1',
      controllerOptions: {
        runLogin: async () => 0,
      },
    });

    await ctx.boot();
    await ctx.controller.submitInput('/rename Active Before Login');
    const streamLenBeforeLogin = capture.getRawStream().length;

    await ctx.controller.submitInput('/login');
    await waitFor(() => ctx.controller.store.getState().isReady);

    const afterLoginStream = capture.getRawStream().slice(streamLenBeforeLogin);
    expect(afterLoginStream).toContain(`\x1b]2;Active Before Login\x1b\\${HIDE_CURSOR}`);

    await ctx.shutdown();
  });
});
