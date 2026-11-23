import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  areGitStatusEqual,
  parseGitPorcelainV2,
  probeGitStatus,
  type GitExecFn,
  type GitStatusSnapshot,
} from '../src/state/git_status';
import {
  areSessionMetricsEqual,
  estimateTextTokens,
  formatTokenMetricsText,
  formatTpsText,
  getTranscriptPath,
  readTranscriptModelCandidates,
  SessionMetricsTracker,
  type SessionMetricsSnapshot,
} from '../src/state/session_metrics';
import { TranscriptStore } from '../src/state/transcript';
import { AppStore } from '../src/state/store';

// ---------------------------------------------------------------------------
// 1. Path resolution & Formatting helpers
// ---------------------------------------------------------------------------

describe('getTranscriptPath & formatters', () => {
  test('resolves default and overridden agy transcript.jsonl paths', () => {
    const defPath = getTranscriptPath('sess-123');
    expect(defPath).toBe(
      path.join(
        os.homedir(),
        '.gemini',
        'antigravity-cli',
        'brain',
        'sess-123',
        '.system_generated',
        'logs',
        'transcript.jsonl',
      ),
    );

    const byBrain = getTranscriptPath('sess-123', { baseBrainDir: '/tmp/my-brain' });
    expect(byBrain).toBe(
      path.join(
        path.resolve('/tmp/my-brain'),
        'sess-123',
        '.system_generated',
        'logs',
        'transcript.jsonl',
      ),
    );

    const byDirect = getTranscriptPath('sess-123', {
      baseBrainDir: '/tmp/ignored',
      transcriptPath: '/tmp/custom/transcript.jsonl',
    });
    expect(byDirect).toBe(path.resolve('/tmp/custom/transcript.jsonl'));
  });

  test('formats TPS and token telemetry strings cleanly', () => {
    expect(formatTpsText(null)).toBeNull();
    expect(formatTpsText(undefined)).toBeNull();
    expect(formatTpsText(0)).toBeNull();
    expect(formatTpsText(-5)).toBeNull();
    expect(formatTpsText(Number.NaN)).toBeNull();
    expect(formatTpsText(86.44)).toBe('86.4 tok/s');
    expect(formatTpsText(4.2)).toBe('4.2 tok/s');
    expect(formatTpsText(24.5)).toBe('24.5 tok/s');
    expect(formatTpsText(125.6)).toBe('126 tok/s');

    expect(formatTokenMetricsText(null)).toBeNull();
    expect(
      formatTokenMetricsText({
        totalInputTokens: 0,
        totalUncachedInputTokens: 0,
        totalCacheReadTokens: 0,
        totalOutputTokens: 0,
        cacheHitPercent: null,
        responseCount: 0,
        currentTps: null,
        isStreamingTps: false,
      }),
    ).toBeNull();

    expect(
      formatTokenMetricsText({
        totalInputTokens: 1_200_000,
        totalUncachedInputTokens: 132_000,
        totalCacheReadTokens: 1_068_000,
        totalOutputTokens: 45_000,
        cacheHitPercent: 89,
        responseCount: 12,
        currentTps: 86.4,
        isStreamingTps: false,
      }),
    ).toBe('↑1.2M(89%) ↓45k');

    // Output-only record without cache hit rate
    expect(
      formatTokenMetricsText({
        totalInputTokens: 0,
        totalUncachedInputTokens: 0,
        totalCacheReadTokens: 0,
        totalOutputTokens: 320,
        cacheHitPercent: null,
        responseCount: 1,
        currentTps: null,
        isStreamingTps: false,
      }),
    ).toBe('↑0 ↓320');
  });

  test('estimates ASCII and CJK/emoji tokens accurately', () => {
    expect(estimateTextTokens('')).toBe(0);
    // 12 ASCII chars -> 3 tokens
    expect(estimateTextTokens('hello world!')).toBeCloseTo(3, 5);
    // 3 CJK chars -> 2 tokens (3 / 1.5)
    expect(estimateTextTokens('你好啊')).toBeCloseTo(2, 5);
    // Surrogate-pair emoji counts as 1 non-ASCII code point -> 1 / 1.5
    expect(estimateTextTokens('🚀')).toBeCloseTo(1 / 1.5, 5);
  });
});

// ---------------------------------------------------------------------------
// 2. SessionMetricsTracker: Real agy transcript.jsonl incremental tailing
// ---------------------------------------------------------------------------

describe('SessionMetricsTracker (transcript.jsonl incremental tailing)', () => {
  test('parses real agy transcript.jsonl schema, tails incrementally by byte offset, handles partial UTF-8 lines, corrupt JSON, and truncation', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'oma-metrics-'));
    const sessionId = 'session-real-agy';
    const transcriptFile = getTranscriptPath(sessionId, { baseBrainDir: tmpDir });
    await mkdir(path.dirname(transcriptFile), { recursive: true });

    try {
      const tracker = new SessionMetricsTracker({ baseBrainDir: tmpDir });
      tracker.setSession(sessionId);

      // Missing file returns empty snapshot without throwing
      const emptySnap = await tracker.syncFromTranscript();
      expect(emptySnap.totalInputTokens).toBe(0);
      expect(emptySnap.cacheHitPercent).toBeNull();
      expect(emptySnap.responseCount).toBe(0);

      // Step 1: Write real agy transcript lines (USER_INPUT + PLANNER_RESPONSE + GENERIC + PLANNER_RESPONSE)
      const initialLines = [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-11-20T15:03:59Z',
          content: '<USER_REQUEST>\n分析代码\n</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-20T15:03:59Z',
          model: 'gemini-4-hydrogen-medium',
          input_tokens: 9898,
          cache_read_tokens: 0,
          output_tokens: 239,
          thinking: 'Initial assessment...',
        }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          created_at: '2026-11-20T15:04:03Z',
          content: 'Command output...',
        }),
        JSON.stringify({
          step_index: 3,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-11-20T15:04:04Z',
          model: 'gemini-4-hydrogen-medium',
          input_tokens: 2679,
          cache_read_tokens: 7844,
          output_tokens: 815,
          content: '已完成分析',
        }),
      ];
      await writeFile(transcriptFile, `${initialLines.join('\n')}\n`, 'utf8');

      const s1 = await tracker.syncFromTranscript();
      expect(s1.responseCount).toBe(2);
      expect(s1.totalUncachedInputTokens).toBe(9898 + 2679);
      expect(s1.totalCacheReadTokens).toBe(7844);
      expect(s1.totalInputTokens).toBe(9898 + 2679 + 7844);
      expect(s1.totalOutputTokens).toBe(239 + 815);
      expect(s1.cacheHitPercent).toBeCloseTo((7844 / (9898 + 2679 + 7844)) * 100, 6);

      // Step 2: Re-syncing unchanged file does not double-count
      const s1Repeat = await tracker.syncFromTranscript();
      expect(s1Repeat).toEqual(s1);

      // Step 3: Append a corrupt JSON line + a partial UTF-8 line split mid-character
      const fullNextLine = JSON.stringify({
        step_index: 4,
        source: 'SYSTEM',
        type: 'CHECKPOINT',
        status: 'DONE',
        input_tokens: 1000,
        cache_read_tokens: 9000,
        output_tokens: 500,
        content: '中文压缩摘要测试',
      });
      const fullNextBuf = Buffer.from(`${fullNextLine}\n`, 'utf8');
      // Split right inside the UTF-8 bytes of '中'
      const zhPos = fullNextBuf.indexOf(Buffer.from('中文', 'utf8'));
      const splitPoint = zhPos + 1;
      const corruptPlusFirstHalf = Buffer.concat([
        Buffer.from('{"broken_json": [1, 2\n', 'utf8'),
        fullNextBuf.subarray(0, splitPoint),
      ]);
      await appendFile(transcriptFile, corruptPlusFirstHalf);

      const s2 = await tracker.syncFromTranscript();
      // Corrupt line skipped, incomplete line buffered in remainder
      expect(s2.responseCount).toBe(2);
      expect(s2.totalOutputTokens).toBe(239 + 815);

      // Step 4: Append second half of the split UTF-8 line
      await appendFile(transcriptFile, fullNextBuf.subarray(splitPoint));

      const s3 = await tracker.syncFromTranscript();
      expect(s3.responseCount).toBe(3);
      expect(s3.totalUncachedInputTokens).toBe(9898 + 2679 + 1000);
      expect(s3.totalCacheReadTokens).toBe(7844 + 9000);
      expect(s3.totalInputTokens).toBe(9898 + 2679 + 1000 + 7844 + 9000);
      expect(s3.totalOutputTokens).toBe(239 + 815 + 500);

      // Step 5: Truncate & rewrite with smaller content -> tracker resets offset=0 and re-reads
      const truncatedLine = JSON.stringify({
        step_index: 0,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        input_tokens: 200,
        cache_read_tokens: 800,
        output_tokens: 50,
      });
      await writeFile(transcriptFile, `${truncatedLine}\n`, 'utf8');

      const s4 = await tracker.syncFromTranscript();
      expect(s4.responseCount).toBe(1);
      expect(s4.totalUncachedInputTokens).toBe(200);
      expect(s4.totalCacheReadTokens).toBe(800);
      expect(s4.totalInputTokens).toBe(1000);
      expect(s4.totalOutputTokens).toBe(50);
      expect(s4.cacheHitPercent).toBeCloseTo(80, 6);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('computes 3s sliding window streaming TPS and calibrates with real output_tokens after endStreamTurn', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'oma-tps-'));
    const sessionId = 'session-tps';
    const transcriptFile = getTranscriptPath(sessionId, { baseBrainDir: tmpDir });
    await mkdir(path.dirname(transcriptFile), { recursive: true });

    try {
      let clock = 10_000;
      const tracker = new SessionMetricsTracker({
        baseBrainDir: tmpDir,
        now: () => clock,
      });
      tracker.setSession(sessionId);

      // Existing baseline response before current turn
      await writeFile(
        transcriptFile,
        `${JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          input_tokens: 1000,
          cache_read_tokens: 0,
          output_tokens: 100,
        })}\n`,
        'utf8',
      );
      await tracker.syncFromTranscript();
      expect(tracker.getSnapshot().totalOutputTokens).toBe(100);
      expect(tracker.getSnapshot().currentTps).toBeNull();

      // Start streaming turn at t = 10_000
      tracker.beginStreamTurn();

      // Chunk at t = 10_050 (< 100ms elapsed): avoids artificial TPS spike
      clock = 10_050;
      const early = tracker.recordStreamText('a'.repeat(40)); // 10 est tokens
      expect(early.currentTps).toBeNull();
      expect(early.isStreamingTps).toBe(false);

      // Chunk at t = 11_000 (1.0s elapsed): 10 + 30 = 40 est tokens / 1.0s = 40 tok/s
      clock = 11_000;
      const mid = tracker.recordStreamText('b'.repeat(120)); // 30 est tokens
      expect(mid.isStreamingTps).toBe(true);
      expect(mid.currentTps).toBeCloseTo(40, 5);

      // Advance past 3s window to t = 14_000 (4.0s elapsed):
      // Cutoff is 11_000 -> sample at 10_050 (10 tok) is pruned; sample at 11_000 (30 tok) stays;
      // add 45 CJK chars = 30 est tokens -> total 60 est tokens over 3.0s window = 20 tok/s
      clock = 14_000;
      const slid = tracker.recordStreamText('中'.repeat(45)); // 30 est tokens
      expect(slid.isStreamingTps).toBe(true);
      expect(slid.currentTps).toBeCloseTo(20, 5);

      // End streaming turn at t = 14_000 (total turn duration = 4.0s)
      const ended = tracker.endStreamTurn();
      expect(ended.isStreamingTps).toBe(false);
      expect(ended.currentTps).toBeCloseTo(20, 5);

      // agy flushes authoritative output_tokens = 240 for this turn -> calibrated TPS = 240 / 4.0s = 60 tok/s
      await appendFile(
        transcriptFile,
        `${JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          input_tokens: 500,
          cache_read_tokens: 1500,
          output_tokens: 240,
        })}\n`,
        'utf8',
      );
      const calibrated = await tracker.syncFromTranscript();
      expect(calibrated.totalOutputTokens).toBe(340);
      expect(calibrated.isStreamingTps).toBe(false);
      expect(calibrated.currentTps).toBeCloseTo(60, 5);

      // Very short turn (< 100ms) must NOT produce bogus calibration
      clock = 20_000;
      tracker.beginStreamTurn();
      clock = 20_050;
      tracker.recordStreamText('fast');
      tracker.endStreamTurn();
      await appendFile(
        transcriptFile,
        `${JSON.stringify({
          step_index: 3,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          input_tokens: 100,
          cache_read_tokens: 1900,
          output_tokens: 50,
        })}\n`,
        'utf8',
      );
      const afterShortTurn = await tracker.syncFromTranscript();
      expect(afterShortTurn.totalOutputTokens).toBe(390);
      // Preserves previous valid calibrated TPS (60) rather than overwriting with 50 / 0.05 = 1000
      expect(afterShortTurn.currentTps).toBeCloseTo(60, 5);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('resets counters, byte offsets, remainder, and TPS on setSession() and reset()', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'oma-sess-switch-'));
    const fileA = getTranscriptPath('sess-a', { baseBrainDir: tmpDir });
    const fileB = getTranscriptPath('sess-b', { baseBrainDir: tmpDir });
    await mkdir(path.dirname(fileA), { recursive: true });
    await mkdir(path.dirname(fileB), { recursive: true });

    try {
      await writeFile(
        fileA,
        `${JSON.stringify({
          type: 'PLANNER_RESPONSE',
          input_tokens: 500,
          cache_read_tokens: 500,
          output_tokens: 100,
        })}\n{"partial":true`,
        'utf8',
      );
      await writeFile(
        fileB,
        `${JSON.stringify({
          type: 'PLANNER_RESPONSE',
          input_tokens: 100,
          cache_read_tokens: 900,
          output_tokens: 40,
        })}\n`,
        'utf8',
      );

      let clock = 1000;
      const tracker = new SessionMetricsTracker({ baseBrainDir: tmpDir, now: () => clock });
      tracker.setSession('sess-a');
      const snapA = await tracker.syncFromTranscript();
      expect(snapA.totalInputTokens).toBe(1000);
      expect(snapA.totalOutputTokens).toBe(100);

      tracker.beginStreamTurn();
      clock = 2000;
      tracker.recordStreamText('x'.repeat(80));
      expect(tracker.getSnapshot().currentTps).toBeCloseTo(20, 5);

      // Switch to session B: old partial remainder, offsets, counters & TPS are completely cleared
      tracker.setSession('sess-b');
      expect(tracker.getSnapshot()).toEqual({
        totalInputTokens: 0,
        totalUncachedInputTokens: 0,
        totalCacheReadTokens: 0,
        totalOutputTokens: 0,
        cacheHitPercent: null,
        responseCount: 0,
        currentTps: null,
        isStreamingTps: false,
      });

      const snapB = await tracker.syncFromTranscript();
      expect(snapB.totalInputTokens).toBe(1000);
      expect(snapB.cacheHitPercent).toBeCloseTo(90, 5);
      expect(snapB.totalOutputTokens).toBe(40);
      expect(snapB.responseCount).toBe(1);

      // reset() clears stats while keeping session B bound so re-syncing reads from offset 0 again
      tracker.reset();
      expect(tracker.getSnapshot().responseCount).toBe(0);
      const snapBAgain = await tracker.syncFromTranscript();
      expect(snapBAgain.totalOutputTokens).toBe(40);

      // setSession(null) detaches completely
      tracker.setSession(null);
      expect(tracker.transcriptPath).toBeNull();
      const detached = await tracker.syncFromTranscript();
      expect(detached.responseCount).toBe(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test('guards TPS against resumed history backfill, multi-step calibration reuse, implicit burst spikes, and tool wait distortion', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'oma-tps-guard-'));
    const sessionId = 'session-tps-guard';
    const transcriptFile = getTranscriptPath(sessionId, { baseBrainDir: tmpDir });
    await mkdir(path.dirname(transcriptFile), { recursive: true });

    try {
      let clock = 50_000;
      const tracker = new SessionMetricsTracker({ baseBrainDir: tmpDir, now: () => clock });
      tracker.setSession(sessionId);

      // 1. Historical multi-response transcript (50,000 output tokens) read from offset 0
      //    AFTER a short turn ends must NOT produce a 50,000 / 1s = 50,000 tok/s spike!
      const histLines = Array.from({ length: 25 }, (_, i) =>
        JSON.stringify({
          step_index: i,
          type: 'PLANNER_RESPONSE',
          input_tokens: 1000,
          cache_read_tokens: 4000,
          output_tokens: 2000,
        }),
      );
      await writeFile(transcriptFile, `${histLines.join('\n')}\n`, 'utf8');

      tracker.beginStreamTurn();
      clock = 51_000;
      tracker.recordStreamText('a'.repeat(160)); // 40 est tokens / 1s = 40 tok/s
      tracker.endStreamTurn();
      const afterBackfill = await tracker.syncFromTranscript();
      expect(afterBackfill.totalOutputTokens).toBe(50_000);
      expect(afterBackfill.currentTps).toBeCloseTo(40, 5);

      // 2. One-shot post-turn calibration: once calibrated, subsequent appended responses
      //    within 15s must NOT accumulate against the old turn's short duration!
      clock = 60_000;
      tracker.beginStreamTurn();
      clock = 61_000;
      tracker.recordStreamText('b'.repeat(120)); // 30 est tok/s
      tracker.endStreamTurn();
      await appendFile(
        transcriptFile,
        `${JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 100, output_tokens: 50 })}\n`,
        'utf8',
      );
      const cal1 = await tracker.syncFromTranscript();
      expect(cal1.currentTps).toBeCloseTo(50, 5);

      // Another 3000-token response arrives 2s later while idle -> must NOT overwrite 50 tok/s with 3050 tok/s!
      clock = 63_000;
      await appendFile(
        transcriptFile,
        `${JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 100, output_tokens: 3000 })}\n`,
        'utf8',
      );
      const afterSecondAppend = await tracker.syncFromTranscript();
      expect(afterSecondAppend.currentTps).toBeCloseTo(50, 5);

      // 3. Implicit background wakeup burst chunk (< 500ms) must NOT flash huge tok/s
      clock = 70_000;
      tracker.recordStreamText('中'.repeat(600)); // 400 est tokens at t=0
      clock = 70_120;
      const burstSnap = tracker.recordStreamText('中'.repeat(600)); // 800 tokens in 120ms = 6667 tok/s if unguarded!
      expect(burstSnap.currentTps).toBeCloseTo(50, 5);
      tracker.endStreamTurn();

      // 4. Authoritative outputTokens + pauseForTools/resumeAfterTools excludes tool wait time
      clock = 80_000;
      tracker.beginStreamTurn();
      clock = 81_000; // 1s generation
      tracker.pauseForTools();
      clock = 91_000; // 10s tool execution (must be excluded)
      tracker.resumeAfterTools();
      clock = 92_000; // +1s generation -> total active gen = 2.0s
      const authEnded = tracker.endStreamTurn({ authoritativeOutputTokens: 160 });
      expect(authEnded.currentTps).toBeCloseTo(80, 5); // 160 / 2.0s = 80 tok/s
      expect(authEnded.isStreamingTps).toBe(false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Git status parser & prober
// ---------------------------------------------------------------------------

describe('parseGitPorcelainV2 & probeGitStatus', () => {
  test('parses clean branch, dirty states, ahead/behind, slash branch names, and detached HEAD', () => {
    const cleanOut = [
      '# branch.oid 0123456789abcdef0123456789abcdef01234567',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +0 -0',
    ].join('\n');

    expect(parseGitPorcelainV2(cleanOut)).toEqual({
      branch: 'main',
      detached: false,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      isDirty: false,
    });

    const dirtyOut = [
      '# branch.oid 1111222233334444555566667777888899990000',
      '# branch.head feat/status-bar',
      '# branch.upstream origin/feat/status-bar',
      '# branch.ab +3 -2',
      // staged only (M.)
      '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
      // both staged & unstaged (MM)
      '1 MM N... 100644 100644 100644 aaa bbb src/b.ts',
      // unstaged only (.M)
      '1 .M N... 100644 100644 100644 aaa bbb src/c.ts',
      // renamed in index (R.)
      '2 R. N... 100644 100644 100644 aaa bbb R100 src/new.ts\tsrc/old.ts',
      // unmerged conflict (UU)
      'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.ts',
      // untracked files
      '? src/untracked1.ts',
      '? src/untracked2.ts',
      // ignored entry (must NOT count as dirty)
      '! dist/ignored.bin',
    ].join('\n');

    expect(parseGitPorcelainV2(dirtyOut)).toEqual({
      branch: 'feat/status-bar',
      detached: false,
      ahead: 3,
      behind: 2,
      staged: 3, // M., MM, R.
      unstaged: 3, // MM, .M, u UU
      untracked: 2,
      isDirty: true,
    });

    // Detached HEAD uses 7-char short OID
    const detachedOut = [
      '# branch.oid abcdef1234567890abcdef1234567890abcdef12',
      '# branch.head (detached)',
    ].join('\n');

    expect(parseGitPorcelainV2(detachedOut)).toEqual({
      branch: 'abcdef1',
      detached: true,
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      isDirty: false,
    });

    // Initial repo without commits
    const initialOut = ['# branch.oid (initial)', '# branch.head main'].join('\n');
    expect(parseGitPorcelainV2(initialOut)?.branch).toBe('main');

    // Invalid / empty output -> null
    expect(parseGitPorcelainV2('')).toBeNull();
    expect(parseGitPorcelainV2('fatal: not a git repository')).toBeNull();
  });

  test('probeGitStatus supports injected exec, handles errors/non-zero/timeouts, and probes real dirs safely', async () => {
    let seenArgs: readonly string[] = [];
    const okExec: GitExecFn = async (args) => {
      seenArgs = args;
      return {
        exitCode: 0,
        stdout: '# branch.oid 1234567890abcdef\n# branch.head dev\n# branch.ab +1 -0\n? foo.ts\n',
      };
    };

    const parsed = await probeGitStatus('D:\\fake-repo', { exec: okExec });
    expect(seenArgs).toEqual(['status', '--porcelain=v2', '--branch']);
    expect(parsed).toEqual({
      branch: 'dev',
      detached: false,
      ahead: 1,
      behind: 0,
      staged: 0,
      unstaged: 0,
      untracked: 1,
      isDirty: true,
    });

    // Non-zero exit code -> null
    const failExec: GitExecFn = async () => ({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
    });
    expect(await probeGitStatus('D:\\not-a-repo', { exec: failExec })).toBeNull();

    // Thrown error -> null
    const throwExec: GitExecFn = async () => {
      throw new Error('ENOENT git');
    };
    expect(await probeGitStatus('D:\\missing', { exec: throwExec })).toBeNull();

    // Hung command exceeding timeoutMs -> null
    const hangExec: GitExecFn = () => new Promise(() => {});
    expect(await probeGitStatus('D:\\slow-repo', { exec: hangExec, timeoutMs: 30 })).toBeNull();

    // Empty cwd -> null
    expect(await probeGitStatus('   ', { exec: okExec })).toBeNull();

    // Real non-Git temp directory -> null
    const nonGitDir = await mkdtemp(path.join(os.tmpdir(), 'oma-nongit-'));
    try {
      const realNonGit = await probeGitStatus(nonGitDir);
      expect(realNonGit).toBeNull();
    } finally {
      await rm(nonGitDir, { recursive: true, force: true });
    }

    // Real temporary Git repository smoke test (if git is installed in PATH)
    let hasGit = false;
    try {
      execFileSync('git', ['--version'], { stdio: 'ignore' });
      hasGit = true;
    } catch {
      hasGit = false;
    }

    if (hasGit) {
      const gitDir = await mkdtemp(path.join(os.tmpdir(), 'oma-realgit-'));
      try {
        execFileSync('git', ['init', '-b', 'main'], { cwd: gitDir, stdio: 'ignore' });
        await writeFile(path.join(gitDir, 'README.md'), 'hello\n', 'utf8');
        const probed = await probeGitStatus(gitDir);
        expect(probed).not.toBeNull();
        expect(probed?.branch).toBe('main');
        expect(probed?.untracked).toBe(1);
        expect(probed?.isDirty).toBe(true);
      } finally {
        await rm(gitDir, { recursive: true, force: true });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 4. AppStore integration: setSessionMetrics, setGitStatus, dedupe & reset
// ---------------------------------------------------------------------------

describe('AppStore sessionMetrics & gitStatus state management', () => {
  test('updates state, skips redundant emit() when unchanged, and resets sessionMetrics on resetSessionState()', () => {
    const store = new AppStore({ cwd: 'D:\\Projects\\oh-my-agy' });
    let emitCount = 0;
    store.subscribe(() => {
      emitCount += 1;
    });

    expect(store.getState().sessionMetrics).toBeNull();
    expect(store.getState().gitStatus).toBeNull();

    // Setting null -> null skips emit
    store.setSessionMetrics(null);
    store.setGitStatus(null);
    expect(emitCount).toBe(0);

    const metrics: SessionMetricsSnapshot = {
      totalInputTokens: 20_000,
      totalUncachedInputTokens: 4_000,
      totalCacheReadTokens: 16_000,
      totalOutputTokens: 1_200,
      cacheHitPercent: 80,
      responseCount: 3,
      currentTps: 65.5,
      isStreamingTps: true,
    };

    store.setSessionMetrics(metrics);
    expect(emitCount).toBe(1);
    expect(store.getState().sessionMetrics).toEqual(metrics);

    // Identical value (different object reference) skips emit
    store.setSessionMetrics({ ...metrics });
    expect(emitCount).toBe(1);
    expect(areSessionMetricsEqual(metrics, { ...metrics })).toBe(true);

    // Changing one field emits
    store.setSessionMetrics({ ...metrics, isStreamingTps: false });
    expect(emitCount).toBe(2);
    expect(store.getState().sessionMetrics?.isStreamingTps).toBe(false);

    const git: GitStatusSnapshot = {
      branch: 'main',
      detached: false,
      ahead: 2,
      behind: 0,
      staged: 1,
      unstaged: 0,
      untracked: 0,
      isDirty: true,
    };

    store.setGitStatus(git);
    expect(emitCount).toBe(3);
    expect(store.getState().gitStatus).toEqual(git);

    // Identical git snapshot skips emit
    store.setGitStatus({ ...git });
    expect(emitCount).toBe(3);
    expect(areGitStatusEqual(git, { ...git })).toBe(true);

    // resetSessionState resets sessionMetrics to null while preserving gitStatus
    store.resetSessionState();
    expect(store.getState().sessionMetrics).toBeNull();
    expect(store.getState().gitStatus).toEqual(git);
  });
});

// ---------------------------------------------------------------------------
// 5. readTranscriptModelCandidates: Tail model extraction from transcript.jsonl
// ---------------------------------------------------------------------------

describe('readTranscriptModelCandidates', () => {
  test('reads newest-to-oldest deduplicated model IDs, handles missing files, and scans only the tail on large transcripts', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'oma-model-scan-'));
    try {
      expect(await readTranscriptModelCandidates('missing-sess', { baseBrainDir: tmpDir })).toEqual([]);
      expect(await readTranscriptModelCandidates('   ', { baseBrainDir: tmpDir })).toEqual([]);

      const sessA = 'sess-models-a';
      const pathA = getTranscriptPath(sessA, { baseBrainDir: tmpDir });
      await mkdir(path.dirname(pathA), { recursive: true });
      await writeFile(
        pathA,
        [
          JSON.stringify({ type: 'USER_INPUT', content: 'hi' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-4-carbon-low' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-pro-orchestrator-neon' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-flash-worker-agy' }),
          '{broken json',
          JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-pro-orchestrator-neon' }),
          JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-flash-worker-agy' }),
        ].join('\n') + '\n',
        'utf8',
      );
      expect(await readTranscriptModelCandidates(sessA, { baseBrainDir: tmpDir })).toEqual([
        'gemini-flash-worker-agy',
        'gemini-pro-orchestrator-neon',
        'gemini-4-carbon-low',
      ]);

      // Large transcript (> 512 KiB): only tail window is scanned and partial leading line is dropped
      const sessLarge = 'sess-models-large';
      const pathLarge = getTranscriptPath(sessLarge, { baseBrainDir: tmpDir });
      await mkdir(path.dirname(pathLarge), { recursive: true });
      const oldLine = `${JSON.stringify({
        type: 'PLANNER_RESPONSE',
        model: 'old-early-model',
        content: 'x'.repeat(2048),
      })}\n`;
      const fillerLine = `${JSON.stringify({
        type: 'GENERIC',
        content: 'y'.repeat(16_384),
      })}\n`;
      const tailLine1 = `${JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-4-neon-xhigh' })}\n`;
      const tailLine2 = `${JSON.stringify({ type: 'PLANNER_RESPONSE', model: 'gemini-4-hydrogen-high' })}\n`;
      await writeFile(
        pathLarge,
        oldLine + fillerLine.repeat(36) + tailLine1 + tailLine2,
        'utf8',
      );
      expect(await readTranscriptModelCandidates(sessLarge, { baseBrainDir: tmpDir })).toEqual([
        'gemini-4-hydrogen-high',
        'gemini-4-neon-xhigh',
      ]);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('SessionMetricsTracker compaction CHECKPOINT tracking & TranscriptStore alignment', () => {
  test('extracts CHECKPOINT <summary>, counts USER_INPUT turns, handles incremental/truncation/reset, and aligns with TranscriptStore', async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'oma-checkpoint-test-'));
    try {
      const sessionId = 'sess-checkpoint-1';
      const transcriptFile = getTranscriptPath(sessionId, { baseBrainDir: tmpDir });
      await mkdir(path.dirname(transcriptFile), { recursive: true });

      const userLine = (step: number, text: string, source = 'USER_EXPLICIT') =>
        JSON.stringify({
          type: 'USER_INPUT',
          source,
          step_index: step,
          content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`,
        });
      const checkpointLine = (
        step: number,
        opts: { status?: string; content: string; inTok?: number; cacheTok?: number; outTok?: number },
      ) =>
        JSON.stringify({
          type: 'CHECKPOINT',
          source: 'SYSTEM',
          status: opts.status ?? 'DONE',
          step_index: step,
          created_at: `2026-11-23T10:00:0${step}Z`,
          input_tokens: opts.inTok ?? 500,
          cache_read_tokens: opts.cacheTok ?? 12000,
          output_tokens: opts.outTok ?? 350,
          content: opts.content,
        });

      // Turn 0, Turn 1, then IN_PROGRESS checkpoint (ignored), then internal subagent input (ignored), then Turn 2 (/compact) + DONE checkpoint
      await writeFile(
        transcriptFile,
        [
          userLine(0, 'Hello project'),
          JSON.stringify({ type: 'PLANNER_RESPONSE', input_tokens: 100, output_tokens: 20 }),
          userLine(2, 'Inspect codebase'),
          JSON.stringify({ type: 'USER_INPUT', source: 'SYSTEM_SUBAGENT', step_index: 3, content: 'internal helper' }),
          checkpointLine(4, { status: 'IN_PROGRESS', content: '<summary>\npartial\n</summary>' }),
          userLine(5, '/compact'),
          checkpointLine(6, {
            content:
              '# Resuming from a compaction\n\n<summary>\n## Summary\nKept key architecture decisions.\n</summary>\n\n# Conversation Logs',
            inTok: 400,
            cacheTok: 15000,
            outTok: 280,
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      const tracker = new SessionMetricsTracker({ baseBrainDir: tmpDir, sessionId });
      await tracker.syncFromTranscript();

      const firstCp = tracker.getLatestCheckpoint();
      expect(firstCp).toEqual({
        stepIndex: 6,
        userInputsBefore: 3,
        precededByCompactCommand: true,
        summaryText: '## Summary\nKept key architecture decisions.',
        createdAt: '2026-11-23T10:00:06Z',
        tokensBefore: 15400,
        summaryTokens: 280,
      });

      // Incrementally append Turn 3 (auto-compaction without /compact command, no <summary> tags -> trimmed raw fallback)
      await appendFile(
        transcriptFile,
        [
          userLine(7, 'Continue implementing tests'),
          checkpointLine(9, {
            content: '  Plain fallback compaction summary  ',
            inTok: 200,
            cacheTok: 8000,
            outTok: 190,
          }),
        ].join('\n') + '\n',
        'utf8',
      );

      await tracker.syncFromTranscript();
      const secondCp = tracker.getLatestCheckpoint();
      expect(secondCp).toEqual({
        stepIndex: 9,
        userInputsBefore: 4,
        precededByCompactCommand: false,
        summaryText: 'Plain fallback compaction summary',
        createdAt: '2026-11-23T10:00:09Z',
        tokensBefore: 8200,
        summaryTokens: 190,
      });

      // Apply onto TranscriptStore: 4 turns, boundary advances to Turn 3, idempotent on re-apply
      const store = new TranscriptStore({ now: () => 1_700_000_000_000 });
      store.beginUserTurn('Hello project');
      store.finishActiveTurn('end_turn');
      store.beginUserTurn('Inspect codebase');
      store.finishActiveTurn('end_turn');
      store.beginUserTurn('/compact');
      store.finishActiveTurn('end_turn');
      store.beginUserTurn('Continue implementing tests');
      store.finishActiveTurn('end_turn');

      expect(store.applyTranscriptCompactionCheckpoint(firstCp!)).toBe(true);
      expect(store.compactedBeforeTurnIndex).toBe(2);
      expect(store.getVisibleTranscriptSlice(true).hiddenCompactedTurnCount).toBe(2);
      expect(store.getVisibleTranscriptSlice(true).turns.map(t => t.index)).toEqual([2, 3]);
      // Idempotent on same checkpoint
      expect(store.applyTranscriptCompactionCheckpoint(firstCp!)).toBe(false);

      // Advancing to second checkpoint hides Turns 0..2
      expect(store.applyTranscriptCompactionCheckpoint(secondCp!)).toBe(true);
      expect(store.compactedBeforeTurnIndex).toBe(3);
      expect(store.getVisibleTranscriptSlice(true).hiddenCompactedTurnCount).toBe(3);
      expect(store.getVisibleTranscriptSlice(true).turns.map(t => t.index)).toEqual([3]);

      // Disabling collapseCompacted reveals all 4 turns without mutating underlying turns
      expect(store.getVisibleTranscriptSlice(false).turns.map(t => t.index)).toEqual([0, 1, 2, 3]);
      expect(store.getVisibleTranscriptSlice(false).hasCompactedHistory).toBe(false);

      // File truncation resets checkpoint state cleanly
      await writeFile(
        transcriptFile,
        userLine(0, 'Fresh after truncate') + '\n',
        'utf8',
      );
      await tracker.syncFromTranscript();
      expect(tracker.getLatestCheckpoint()).toBeNull();

      // Re-add checkpoint, then verify reset() and setSession() clear it
      await appendFile(
        transcriptFile,
        checkpointLine(1, { content: '<summary>Reloaded</summary>' }) + '\n',
        'utf8',
      );
      await tracker.syncFromTranscript();
      expect(tracker.getLatestCheckpoint()?.summaryText).toBe('Reloaded');
      tracker.reset();
      expect(tracker.getLatestCheckpoint()).toBeNull();
      tracker.setSession(null);
      expect(tracker.getLatestCheckpoint()).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
