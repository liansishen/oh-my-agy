import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { SessionMetricsTracker } from '../src/state/session_metrics';
import { AppStore } from '../src/state/store';
import { HIDE_CURSOR } from '../src/termio/osc';
import { ComposerView } from '../src/ui/ComposerView';
import { InfoOverlayView } from '../src/ui/InfoOverlayView';
import {
  cleanupHarnessTempDirs,
  createTestController,
  makeHarnessTempDir,
  TestTernHost,
  waitFor,
} from './helpers/controller_harness';

afterEach(() => cleanupHarnessTempDirs());

function collectSpanOrText(val: unknown, parts: string[]): void {
  if (typeof val === 'string') {
    parts.push(val);
    return;
  }
  if (Array.isArray(val)) {
    for (const entry of val) {
      if (typeof entry === 'string') parts.push(entry);
      else if (entry && typeof entry === 'object' && typeof (entry as { t?: unknown }).t === 'string') {
        parts.push((entry as { t: string }).t);
      }
    }
  }
}

function collectTreeText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const rec = node as { props?: Record<string, unknown>; children?: unknown[] };
  const parts: string[] = [];
  if (rec.props) {
    collectSpanOrText(rec.props['text'], parts);
    collectSpanOrText(rec.props['label'], parts);
    collectSpanOrText(rec.props['aria'], parts);
    collectSpanOrText(rec.props['spans'], parts);
    if (Array.isArray(rec.props['items'])) {
      for (const kv of rec.props['items']) {
        if (kv && typeof kv === 'object') {
          const kvObj = kv as Record<string, unknown>;
          collectSpanOrText(kvObj['k'], parts);
          collectSpanOrText(kvObj['v'], parts);
        }
      }
    }
  }
  if (Array.isArray(rec.children)) {
    for (const ch of rec.children) parts.push(collectTreeText(ch));
  }
  return parts.join(' ');
}

function findElements(
  node: unknown,
  predicate: (el: { kind: unknown; props: Record<string, unknown> }) => boolean,
): Array<{ kind: unknown; props: Record<string, unknown> }> {
  const out: Array<{ kind: unknown; props: Record<string, unknown> }> = [];
  if (!node || typeof node !== 'object') return out;
  const rec = node as { kind?: unknown; props?: Record<string, unknown>; children?: unknown[] };
  if (rec.kind !== undefined && rec.props && predicate({ kind: rec.kind, props: rec.props })) {
    out.push({ kind: rec.kind, props: rec.props });
  }
  if (Array.isArray(rec.children)) {
    for (const ch of rec.children) out.push(...findElements(ch, predicate));
  }
  return out;
}

describe('Background daemon non-blocking tracking', () => {
  test('treats IsDaemon: true run_command (boolean/string) and schedule as non-blocking daemons in store & UI', () => {
    let clock = 10_000;
    const app = new AppStore({ now: () => (clock += 50) });
    const { transcript } = app;

    transcript.beginUserTurn('Start API server and monitor cron');
    app.setStreaming(true);

    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-daemon-api',
      name: 'run_command',
      kind: 'execute',
      status: 'completed',
      title: 'Start API server',
      args: { CommandLine: 'bun run server.ts', IsDaemon: true },
      rawOutput: { output: 'Tool is running as a background task with task id: sess/task-api' },
    });

    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-daemon-cron',
      name: 'schedule',
      status: 'completed',
      title: 'Monitor cron',
      args: { CronExpression: '*/3 * * * *', IsDaemon: 'true', Prompt: 'Check health' },
      rawOutput: { taskId: 'sess/task-cron', output: 'Scheduled cron sess/task-cron' },
    });

    transcript.finishActiveTurn('end_turn');
    app.setStreaming(false);

    expect(transcript.hasActiveBackgroundTasks()).toBe(false);
    expect(transcript.hasRunningDaemonTasks()).toBe(true);
    expect(app.hasActiveBackgroundTasks()).toBe(false);
    expect(app.isBusy).toBe(false);

    const snap = transcript.getBackgroundJobsSnapshot();
    expect(snap.runningJobCount).toBe(2);
    expect(snap.runningDaemonCount).toBe(2);
    expect(snap.detachedTaskCount).toBe(0);
    expect(snap.hasActiveBackgroundTasks).toBe(false);
    expect(snap.running.every(j => j.isDaemon === true)).toBe(true);
    expect(snap.running.find(j => j.id === 'tc-daemon-cron')?.type).toBe('schedule');

    // Esc / normal cancel preserves daemons; explicit includeDaemons settles them
    expect(transcript.cancelActiveBackgroundTasks('cancelled')).toBe(0);
    expect(transcript.hasRunningDaemonTasks()).toBe(true);

    // ComposerView renders HUD jobs pill (muted) with NO "Background task running…" bar
    const composer = ComposerView({
      state: app.getState(),
      draft: app.draft.getState(),
      plan: null,
      hasTurns: true,
      jobs: snap,
      callbacks: {
        onEdit() {},
        onUndo() {},
        onSend() {},
        onFocus() {},
        onSubmit() {},
        onStop() {},
        onRemoveAttachment() {},
        onOpenPicker() {},
        onOpenContext() {},
        onCycleMode() {},
      },
    });
    const composerText = collectTreeText(composer);
    expect(composerText).not.toContain('Background task running…');
    expect(composerText).toContain('2 daemons running');
    const jobsIcon = findElements(
      composer,
      el => el.kind === 'icon' && el.props['name'] === 'job',
    )[0];
    expect(jobsIcon?.props['tone']).toBe('muted');

    // InfoOverlayView shows Daemon state & Mode fact, omitting Detach button for already-daemon tasks
    const info = app.openInfoOverlay('jobs');
    const overlay = InfoOverlayView({
      state: app.getState(),
      info,
      turns: transcript.turns,
      jobs: snap,
      version: '0.3.2',
      callbacks: { onClose() {}, onDetachJob() {}, onStopJob() {} },
    });
    const overlayText = collectTreeText(overlay);
    expect(overlayText).toContain('Daemon');
    expect(overlayText).toContain('daemon (non-blocking)');
    const detachBtns = findElements(
      overlay,
      el => el.kind === 'button' && Array.isArray(el.props['keys']) && (el.props['keys'] as unknown[]).includes('d'),
    );
    expect(detachBtns).toHaveLength(0);
  });

  test('closes turn on end_turn when remaining in-flight tools are all IsDaemon: true', () => {
    const app = new AppStore();
    const { transcript } = app;

    const turn = transcript.beginUserTurn('Start long-lived daemon');
    transcript.applySessionUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-inflight-daemon',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      title: 'API server',
      rawInput: { CommandLine: 'node server.js', IsDaemon: true },
    });

    const finished = transcript.finishActiveTurn('end_turn', undefined, undefined, {
      preserveInFlightBackgroundTools: true,
    });
    expect(finished?.index).toBe(turn.index);
    expect(finished?.status).toBe('done');
    expect(transcript.activeTurn).toBeUndefined();
    expect(transcript.hasActiveBackgroundTasks()).toBe(false);
    expect(transcript.hasRunningDaemonTasks()).toBe(true);
    expect(transcript.getBackgroundJobsSnapshot().runningDaemonCount).toBe(1);
  });

  test('SessionMetricsTracker detects IsDaemon from PLANNER_RESPONSE.tool_calls and reconciles manage_task list JSON', async () => {
    const tmp = makeHarnessTempDir('oma-daemon-metrics-');
    const transcriptPath = join(tmp, 'transcript.jsonl');
    const lines = [
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Starting API service daemon.',
        tool_calls: [
          {
            name: 'run_command',
            args: {
              CommandLine: '"bun run api.ts"',
              IsDaemon: '"true"',
              toolSummary: '"Start API service"',
            },
          },
        ],
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-25T07:00:00Z',
        content:
          'Created At: 2026-11-25T15:00:00+08:00\nTool is running as a background task with task id: sess-1/task-2\nTask Description: bun run api.ts\nTask logs are available at: file:///tmp/task-2.log\n',
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: '2026-11-25T07:01:00Z',
        content:
          'Created At: 2026-11-25T15:01:00+08:00\nTool is running as a background task with task id: sess-1/task-3\nTask Description: npm run worker\nTask logs are available at: file:///tmp/task-3.log\n',
      }),
    ];
    await Bun.write(transcriptPath, `${lines.join('\n')}\n`);

    const tracker = new SessionMetricsTracker({ transcriptPath });
    await tracker.syncFromTranscript();

    const firstRecords = tracker.getTranscriptBackgroundTasks();
    const apiRec = firstRecords.find(r => r.taskId === 'sess-1/task-2');
    const workerRec = firstRecords.find(r => r.taskId === 'sess-1/task-3');
    expect(apiRec?.isDaemon).toBe(true);
    expect(workerRec?.isDaemon).toBeUndefined();

    const app = new AppStore();
    app.transcript.beginUserTurn('Run API and worker');
    app.transcript.syncTranscriptBackgroundTasks(firstRecords);
    app.transcript.finishActiveTurn('end_turn');
    // Only non-daemon task-3 blocks
    expect(app.transcript.hasActiveBackgroundTasks()).toBe(true);
    expect(app.transcript.getBackgroundJobsSnapshot().runningDaemonCount).toBe(1);

    // manage_task list upgrades task-3 to isDaemon: true in transcript.jsonl (and settles task-2 if absent)
    const listUpdate = JSON.stringify({
      step_index: 4,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      created_at: '2026-11-25T07:02:00Z',
      content:
        'Created At: 2026-11-25T15:02:00+08:00\nYou have 1 background task(s) currently running:\n[{"taskId":"sess-1/task-3","toolName":"run_command","description":"npm run worker","isDaemon":true}]',
    });
    await Bun.write(transcriptPath, `${lines.join('\n')}\n${listUpdate}\n`);
    await tracker.syncFromTranscript();

    const secondRecords = tracker.getTranscriptBackgroundTasks();
    expect(secondRecords.find(r => r.taskId === 'sess-1/task-2')?.status).toBe('completed');
    expect(secondRecords.find(r => r.taskId === 'sess-1/task-3')?.isDaemon).toBe(true);

    app.transcript.syncTranscriptBackgroundTasks(secondRecords);
    expect(app.transcript.hasActiveBackgroundTasks()).toBe(false);
    expect(app.transcript.hasRunningDaemonTasks()).toBe(true);
    const snapAfter = app.transcript.getBackgroundJobsSnapshot();
    expect(snapAfter.runningJobCount).toBe(1);
    expect(snapAfter.runningDaemonCount).toBe(1);
  });

  test('controller emits done + HIDE_CURSOR for IsDaemon: true and allows detaching blocking API server via /jobs', async () => {
    const host = new TestTernHost();
    const rawChunks: string[] = [];
    const decoder = new TextDecoder();
    const origWrite = host.safeOutput.write.bind(host.safeOutput);
    host.safeOutput.write = (data: Uint8Array | string): boolean => {
      rawChunks.push(typeof data === 'string' ? data : decoder.decode(data));
      return origWrite(data);
    };

    const ctx = await createTestController({
      host,
      newSessionId: 'sess-daemon-ctrl',
      onPrompt: (rec, msg, h) => {
        if (rec.text.includes('daemon')) {
          h.sendUpdate(rec.sessionId, {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-api-daemon',
            name: 'run_command',
            kind: 'execute',
            status: 'completed',
            title: 'API Daemon',
            rawInput: { CommandLine: 'bun run api.ts', IsDaemon: true },
            rawOutput: { output: 'Tool is running as a background task with task id: sess-daemon-ctrl/task-1' },
          });
        } else {
          h.sendUpdate(rec.sessionId, {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-api-blocking',
            name: 'run_command',
            kind: 'execute',
            status: 'completed',
            title: 'Blocking API Server',
            rawInput: { CommandLine: 'bun run server.ts', WaitMsBeforeAsync: 500 },
            rawOutput: { output: 'Tool is running as a background task with task id: sess-daemon-ctrl/task-2' },
          });
        }
        h.reply(msg.id, { stopReason: 'end_turn' });
        return true;
      },
    });

    await ctx.boot();

    // 1. Daemon-marked command finishes turn cleanly without sticking in "Background task running…"
    const oscLenBefore = host.osc7501.length;
    const rawLenBefore = rawChunks.join('').length;
    await ctx.controller.submitInput('Start daemon');
    await waitFor(() => host.osc7501.slice(oscLenBefore).includes('state=done'));

    expect(ctx.controller.store.getState().isBusy).toBe(false);
    expect(ctx.controller.store.getState().hasActiveBackgroundTasks).toBe(false);
    expect(ctx.controller.store.transcript.getBackgroundJobsSnapshot().runningDaemonCount).toBe(1);
    expect(rawChunks.join('').slice(rawLenBefore)).toContain(HIDE_CURSOR);

    // 2. Non-daemon background API server starts in blocking mode, then user detaches it in /jobs (`d`)
    await ctx.controller.submitInput('Start blocking server');
    await waitFor(() => ctx.controller.store.getState().hasActiveBackgroundTasks);
    expect(ctx.controller.store.getState().isBusy).toBe(true);

    await ctx.controller.submitInput('/jobs');
    await waitFor(() => ctx.controller.store.getState().infoOverlay?.kind === 'jobs');
    // Select tc-api-blocking (newest job is first by startedAt, or select explicitly)
    ctx.controller.store.setSelectedJobId('tc-api-blocking');
    await ctx.controller.handleKey({ name: 'd', ctrl: false, alt: false, meta: false, shift: false, raw: 'd' } as never);

    await waitFor(() => !ctx.controller.store.getState().isBusy);
    expect(ctx.controller.store.getState().hasActiveBackgroundTasks).toBe(false);
    expect(ctx.controller.store.transcript.getBackgroundJobsSnapshot().runningJobCount).toBe(2);
    expect(ctx.controller.store.transcript.getBackgroundJobsSnapshot().runningDaemonCount).toBe(2);
    expect(host.osc7501[host.osc7501.length - 1]).toBe('state=idle');

    await ctx.shutdown();
  });
});
