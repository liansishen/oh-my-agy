import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GitExecFn } from '../src/state/git_status';
import {
  buildGitSidebarEntries,
  commitGitChanges,
  gitFileKey,
  loadGitFileDiff,
  loadGitRepoSnapshot,
  parseNumstatMap,
  parsePorcelainV1Z,
  stageGitFiles,
  unstageGitFiles,
} from '../src/state/git_tui';

const tempDirs: string[] = [];

async function makeTempDir(prefix = 'oma-git-tui-test-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe('git_tui parsing & tree helpers', () => {
  test('parsePorcelainV1Z parses unstaged, staged, untracked, renamed, and conflicted entries', () => {
    const raw = [
      ' M src/a.ts',
      'M  src/b.ts',
      'MM src/both.ts',
      '?? new/file.txt',
      'R  src/renamed.ts',
      'src/old.ts',
      'UU conflict.ts',
      '',
    ].join('\0');

    const { unstaged, staged } = parsePorcelainV1Z(raw);
    expect(unstaged.map(f => `${f.path}:${f.kind}`)).toEqual([
      'conflict.ts:conflicted',
      'new/file.txt:untracked',
      'src/a.ts:modified',
      'src/both.ts:modified',
    ]);
    expect(staged.map(f => `${f.path}:${f.kind}:${f.origPath ?? ''}`)).toEqual([
      'src/b.ts:modified:',
      'src/both.ts:modified:',
      'src/renamed.ts:renamed:src/old.ts',
    ]);
  });

  test('parseNumstatMap parses standard, binary, and rename numstats', () => {
    const map = parseNumstatMap(
      [
        '12\t4\tsrc/a.ts',
        '-\t-\tassets/logo.png',
        '3\t1\tsrc/{old.ts => new.ts}',
      ].join('\n'),
    );
    expect(map.get('src/a.ts')).toEqual({ additions: 12, deletions: 4 });
    expect(map.get('assets/logo.png')).toEqual({ additions: 0, deletions: 0 });
    expect(map.get('src/new.ts')).toEqual({ additions: 3, deletions: 1 });
  });

  test('buildGitSidebarEntries supports flat path mode and collapsible folder tree mode', () => {
    const files = [
      { path: 'README.md', kind: 'modified' as const, area: 'unstaged' as const },
      { path: 'src/ui/a.tsx', kind: 'modified' as const, area: 'unstaged' as const },
      { path: 'src/ui/b.tsx', kind: 'added' as const, area: 'unstaged' as const },
    ];
    const flat = buildGitSidebarEntries(files, 'unstaged', 'path', {});
    expect(flat.map(e => e.key)).toEqual([
      gitFileKey('unstaged', 'README.md'),
      gitFileKey('unstaged', 'src/ui/a.tsx'),
      gitFileKey('unstaged', 'src/ui/b.tsx'),
    ]);

    const tree = buildGitSidebarEntries(files, 'unstaged', 'tree', {});
    expect(tree.map(e => `${e.kind}:${e.depth}:${e.dirName ?? e.file?.path}`)).toEqual([
      'dir:0:src',
      'dir:1:ui',
      'file:2:src/ui/a.tsx',
      'file:2:src/ui/b.tsx',
      'file:0:README.md',
    ]);

    const folded = buildGitSidebarEntries(files, 'unstaged', 'tree', {
      'unstaged:dir:src/ui': true,
    });
    expect(folded.map(e => `${e.kind}:${e.dirName ?? e.file?.path}`)).toEqual([
      'dir:src',
      'dir:ui',
      'file:README.md',
    ]);
  });
});

describe('git_tui repository snapshot, diff, and actions', () => {
  test('loadGitRepoSnapshot loads dirty and clean HEAD repositories cleanly', async () => {
    const dirtyExec: GitExecFn = async args => {
      if (args[0] === 'status') {
        return { exitCode: 0, stdout: ' M src/app.ts\0A  src/new.ts\0' };
      }
      if (args[0] === 'symbolic-ref') {
        return { exitCode: 0, stdout: 'main\n' };
      }
      if (args[0] === 'log') {
        return {
          exitCode: 0,
          stdout: 'abcdef1234567890\x1fabcdef1\x1fInitial commit\x1f\x1fAlice\x1falice@example.com\x1f2026-11-22T00:00:00Z\x1f',
        };
      }
      if (args[0] === 'diff' && args[1] === '--numstat') {
        return { exitCode: 0, stdout: '5\t2\tsrc/app.ts\n' };
      }
      if (args[0] === 'diff' && args[1] === '--cached') {
        return { exitCode: 0, stdout: '10\t0\tsrc/new.ts\n' };
      }
      return { exitCode: 0, stdout: '' };
    };

    const dirtySnap = await loadGitRepoSnapshot('/repo', { exec: dirtyExec });
    expect(dirtySnap.clean).toBe(false);
    expect(dirtySnap.branch).toBe('main');
    expect(dirtySnap.unstaged).toEqual([
      { path: 'src/app.ts', kind: 'modified', area: 'unstaged', additions: 5, deletions: 2 },
    ]);
    expect(dirtySnap.staged).toEqual([
      { path: 'src/new.ts', kind: 'added', area: 'staged', additions: 10, deletions: 0 },
    ]);

    const cleanExec: GitExecFn = async args => {
      if (args[0] === 'status') return { exitCode: 0, stdout: '' };
      if (args[0] === 'symbolic-ref') return { exitCode: 0, stdout: 'main\n' };
      if (args[0] === 'log') {
        return {
          exitCode: 0,
          stdout: 'abcdef1234567890\x1fabcdef1\x1fInitial commit\x1fBody text\x1fAlice\x1falice@example.com\x1f2026-11-22T00:00:00Z\x1f',
        };
      }
      if (args[0] === 'show' && args.includes('--name-status')) {
        return { exitCode: 0, stdout: 'A\tREADME.md\n' };
      }
      if (args[0] === 'show' && args.includes('--numstat')) {
        return { exitCode: 0, stdout: '20\t0\tREADME.md\n' };
      }
      return { exitCode: 0, stdout: '' };
    };

    const cleanSnap = await loadGitRepoSnapshot('/repo', { exec: cleanExec });
    expect(cleanSnap.clean).toBe(true);
    expect(cleanSnap.headCommit?.shortSha).toBe('abcdef1');
    expect(cleanSnap.headCommit?.files).toEqual([
      { path: 'README.md', kind: 'added', area: 'commit', additions: 20, deletions: 0 },
    ]);
  });

  test('loadGitFileDiff synthesizes unified diff for untracked text files and parses git diff hunks', async () => {
    const tmp = await makeTempDir();
    await fs.writeFile(path.join(tmp, 'hello.txt'), 'line 1\nline 2\n', 'utf8');

    const untrackedDiff = await loadGitFileDiff(tmp, {
      path: 'hello.txt',
      kind: 'untracked',
      area: 'unstaged',
    });
    expect(untrackedDiff.kind).toBe('diff');
    expect(untrackedDiff.additions).toBe(2);
    expect(untrackedDiff.deletions).toBe(0);
    expect(untrackedDiff.unifiedDiff).toBe('@@ -0,0 +1,2 @@\n+line 1\n+line 2');

    const mockExec: GitExecFn = async () => ({
      exitCode: 0,
      stdout: [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,2 @@',
        '-const x = 1;',
        '+const x = 2;',
        ' export { x };',
      ].join('\n'),
    });

    const modDiff = await loadGitFileDiff(
      tmp,
      { path: 'src/a.ts', kind: 'modified', area: 'unstaged' },
      { exec: mockExec },
    );
    expect(modDiff.kind).toBe('diff');
    expect(modDiff.additions).toBe(1);
    expect(modDiff.deletions).toBe(1);
    expect(modDiff.unifiedDiff.startsWith('@@ -1,2 +1,2 @@')).toBe(true);
  });

  test('stage, unstage, and commit execute expected git commands safely', async () => {
    const calls: string[][] = [];
    const exec: GitExecFn = async args => {
      calls.push([...args]);
      return { exitCode: 0, stdout: '' };
    };

    const s1 = await stageGitFiles('/repo', ['src/a.ts'], { exec });
    expect(s1.ok).toBe(true);
    const u1 = await unstageGitFiles('/repo', 'all', { exec });
    expect(u1.ok).toBe(true);
    const cFail = await commitGitChanges('/repo', { summary: '   ' }, { exec });
    expect(cFail.ok).toBe(false);
    const cOk = await commitGitChanges(
      '/repo',
      { summary: 'feat: add git UI', body: 'details', stageAllIfEmpty: true },
      { exec },
    );
    expect(cOk.ok).toBe(true);

    expect(calls).toEqual([
      ['add', '--', 'src/a.ts'],
      ['reset', 'HEAD'],
      ['add', '-A'],
      ['commit', '-m', 'feat: add git UI', '-m', 'details'],
    ]);
  });
});
