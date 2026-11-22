import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GitExecFn } from '../src/state/git_status';
import {
  buildGitSidebarEntries,
  commitGitChanges,
  formatGitAlternateObjectPath,
  gitFileKey,
  loadGitFileDiff,
  loadGitRepoSnapshot,
  normalizeGitAlternateObjectDirectories,
  parseGitAlternateObjectDirectories,
  parseNumstatMap,
  parsePorcelainV1Z,
  resolveGitRepoRoot,
  resolveGitStageActionPaths,
  stageGitFiles,
  stripGitLineEnding,
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
      ['--literal-pathspecs', 'add', '--', 'src/a.ts'],
      ['reset', 'HEAD'],
      ['add', '-A'],
      ['commit', '-m', 'feat: add git UI', '-m', 'details'],
    ]);
  });

  test('stripGitLineEnding & resolveGitRepoRoot preserve trailing spaces and POSIX trailing CR', async () => {
    expect(stripGitLineEnding('/tmp/dir-with-cr\r\n', 'linux')).toBe('/tmp/dir-with-cr\r');
    expect(stripGitLineEnding('/tmp/project \n', 'linux')).toBe('/tmp/project ');
    expect(stripGitLineEnding('C:\\repo\r\n', 'win32')).toBe('C:\\repo');

    const trailingRoot = path.resolve('/tmp/project ');
    const exec: GitExecFn = async args => {
      if (args[0] === 'rev-parse') {
        return { exitCode: 0, stdout: `${trailingRoot}\n` };
      }
      return { exitCode: 0, stdout: '' };
    };
    const resolved = await resolveGitRepoRoot(path.join(trailingRoot, 'sub'), { exec });
    expect(resolved).toBe(trailingRoot);
  });

  test('real nested git repos: relative GIT_DIR and GIT_WORK_TREE stay pinned to child repo (never pollute parent repo)', async () => {
    const parent = await makeTempDir('oma-parent-repo-');
    const child = path.join(parent, 'child');
    const sub = path.join(child, 'sub');
    await fs.mkdir(sub, { recursive: true });

    const runGit = async (args: string[], cwd: string): Promise<string> => {
      const cleanEnv = { ...process.env };
      delete cleanEnv['GIT_DIR'];
      delete cleanEnv['GIT_WORK_TREE'];
      const proc = Bun.spawn(['git', ...args], { cwd, env: cleanEnv, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`);
      }
      return stdout;
    };

    // Initialize parent repo with an unstaged file
    await runGit(['init'], parent);
    await runGit(['config', 'user.email', 'test@example.com'], parent);
    await runGit(['config', 'user.name', 'Test User'], parent);
    await fs.writeFile(path.join(parent, 'parent.txt'), 'parent-v1\n', 'utf8');
    await runGit(['add', 'parent.txt'], parent);
    await runGit(['commit', '-m', 'parent init'], parent);
    await fs.writeFile(path.join(parent, 'parent.txt'), 'parent-dirty\n', 'utf8');

    // Initialize nested child repo with an unstaged file inside `child/sub`
    await runGit(['init'], child);
    await runGit(['config', 'user.email', 'test@example.com'], child);
    await runGit(['config', 'user.name', 'Test User'], child);
    await fs.writeFile(path.join(sub, 'child.txt'), 'child-v1\n', 'utf8');
    await runGit(['add', 'sub/child.txt'], child);
    await runGit(['commit', '-m', 'child init'], child);
    await fs.writeFile(path.join(sub, 'child.txt'), 'child-dirty\n', 'utf8');

    // Set relative GIT_DIR / GIT_WORK_TREE as if launched from `parent/child/sub`
    const prevGitDir = process.env['GIT_DIR'];
    const prevWorkTree = process.env['GIT_WORK_TREE'];
    process.env['GIT_DIR'] = '../.git';
    process.env['GIT_WORK_TREE'] = '..';
    try {
      const snap = await loadGitRepoSnapshot(sub);
      expect(path.resolve(snap.cwd).toLowerCase()).toBe(path.resolve(child).toLowerCase());
      expect(snap.gitEnv?.['GIT_DIR']).toBeDefined();
      expect(snap.gitEnv?.['GIT_WORK_TREE']).toBeDefined();
      expect(snap.unstaged.some(f => f.path === 'sub/child.txt')).toBe(true);

      const stageAll = await stageGitFiles(snap.cwd, 'all', { gitEnv: snap.gitEnv });
      expect(stageAll.ok).toBe(true);
    } finally {
      if (prevGitDir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = prevGitDir;
      if (prevWorkTree === undefined) delete process.env['GIT_WORK_TREE'];
      else process.env['GIT_WORK_TREE'] = prevWorkTree;
    }

    // Verify child repo staged `sub/child.txt`, while parent repo index remained 100% untouched!
    const childStatus = await runGit(['status', '--porcelain=v1'], child);
    expect(childStatus).toContain('M  sub/child.txt');
    const parentStatus = await runGit(['status', '--porcelain=v1'], parent);
    expect(parentStatus).toContain(' M parent.txt');
    expect(parentStatus).not.toContain('M  parent.txt');
  });

  test('real git repo: relative GIT_INDEX_FILE resolves via Git repo-root semantics & bare repo with GIT_DIR=. is rejected (never treated as work tree)', async () => {
    const repo = await makeTempDir('oma-git-index-');
    const sub = path.join(repo, 'sub');
    await fs.mkdir(sub, { recursive: true });

    const runGit = async (args: string[], cwd: string, extraEnv?: Record<string, string>): Promise<string> => {
      const cleanEnv: Record<string, string | undefined> = { ...process.env, ...(extraEnv ?? {}) };
      if (!extraEnv?.['GIT_DIR']) delete cleanEnv['GIT_DIR'];
      if (!extraEnv?.['GIT_WORK_TREE']) delete cleanEnv['GIT_WORK_TREE'];
      if (!extraEnv?.['GIT_INDEX_FILE']) delete cleanEnv['GIT_INDEX_FILE'];
      const proc = Bun.spawn(['git', ...args], { cwd, env: cleanEnv, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`);
      }
      return stdout;
    };

    await runGit(['init'], repo);
    await runGit(['config', 'user.email', 'test@example.com'], repo);
    await runGit(['config', 'user.name', 'Test User'], repo);
    await fs.writeFile(path.join(repo, 'init.txt'), 'init\n', 'utf8');
    await runGit(['add', 'init.txt'], repo);
    await runGit(['commit', '-m', 'init'], repo);
    await fs.writeFile(path.join(sub, 'next.txt'), 'next-content\n', 'utf8');

    // 1. P1-2: From `repo/sub` with `GIT_INDEX_FILE=selected.index`, native Git writes `repo/selected.index`
    const prevIdx = process.env['GIT_INDEX_FILE'];
    process.env['GIT_INDEX_FILE'] = 'selected.index';
    try {
      const snap = await loadGitRepoSnapshot(sub);
      expect(path.resolve(snap.gitEnv?.['GIT_INDEX_FILE'] ?? '').toLowerCase()).toBe(
        path.resolve(repo, 'selected.index').toLowerCase(),
      );
      const st = await stageGitFiles(snap.cwd, ['sub/next.txt'], { gitEnv: snap.gitEnv });
      expect(st.ok).toBe(true);
    } finally {
      if (prevIdx === undefined) delete process.env['GIT_INDEX_FILE'];
      else process.env['GIT_INDEX_FILE'] = prevIdx;
    }

    // `repo/selected.index` must exist and contain `sub/next.txt`; `repo/sub/selected.index` must NOT exist!
    const rootIdxExists = await fs.stat(path.join(repo, 'selected.index')).then(() => true, () => false);
    const subIdxExists = await fs.stat(path.join(sub, 'selected.index')).then(() => true, () => false);
    expect(rootIdxExists).toBe(true);
    expect(subIdxExists).toBe(false);
    const lsOut = await runGit(['ls-files', '--stage'], repo, {
      GIT_INDEX_FILE: path.join(repo, 'selected.index'),
    });
    expect(lsOut).toContain('sub/next.txt');

    // 2. Bare repo with `GIT_DIR=.` must NOT synthesize `GIT_WORK_TREE` or list `HEAD`/`config` as untracked
    const bare = await makeTempDir('oma-bare-repo-');
    await runGit(['init', '--bare'], bare);
    const prevGitDir = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = '.';
    try {
      let failed = false;
      try {
        await loadGitRepoSnapshot(bare);
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    } finally {
      if (prevGitDir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = prevGitDir;
    }
  });

  test('real git repo: RM unstaged edit, status.renames=copies unstage, and GIT_LITERAL_PATHSPECS=1 env override', async () => {
    const repo = await makeTempDir('oma-real-git-p1-');
    const runGit = async (args: string[], cwd = repo): Promise<string> => {
      const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`);
      }
      return stdout;
    };

    await runGit(['init']);
    await runGit(['config', 'user.email', 'test@example.com']);
    await runGit(['config', 'user.name', 'Test User']);
    await runGit(['config', 'status.renames', 'copies']);

    await fs.writeFile(path.join(repo, 'old.md'), 'original rename text\n', 'utf8');
    await fs.writeFile(
      path.join(repo, 'base.txt'),
      'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n',
      'utf8',
    );
    await runGit(['add', '-A']);
    await runGit(['commit', '-m', 'init']);

    // 1. P1-2a: Staged rename + unstaged edit (`RM`), PLUS recreated `old.md` in working tree.
    // Staging the unstaged `new.md` modification must touch ONLY `new.md`, leaving recreated `old.md` untracked!
    await runGit(['mv', 'old.md', 'new.md']);
    await fs.writeFile(path.join(repo, 'new.md'), 'original rename text\nedited after rename\n', 'utf8');
    await fs.writeFile(path.join(repo, 'old.md'), 'brand new unrelated file\n', 'utf8');

    const snapRM = await loadGitRepoSnapshot(repo);
    const unstagedNew = snapRM.unstaged.find(f => f.path === 'new.md');
    expect(unstagedNew?.kind).toBe('modified');
    expect(unstagedNew?.origPath).toBeUndefined();
    expect(resolveGitStageActionPaths(unstagedNew!, 'stage')).toEqual(['new.md']);

    const stageRes = await stageGitFiles(repo, resolveGitStageActionPaths(unstagedNew!, 'stage'));
    expect(stageRes.ok).toBe(true);
    const snapAfterRMStage = await loadGitRepoSnapshot(repo);
    expect(snapAfterRMStage.unstaged.some(f => f.path === 'old.md' && f.kind === 'untracked')).toBe(true);
    expect(snapAfterRMStage.staged.some(f => f.path === 'old.md')).toBe(false);

    // Clean up RM test files before copy test
    await runGit(['reset', '--hard', 'HEAD']);
    await fs.rm(path.join(repo, 'old.md'), { force: true });
    await runGit(['checkout', '--', 'old.md']);
    await fs.rm(path.join(repo, 'new.md'), { force: true });

    // 2. P1-2b: Copy (`C  copy.txt -> base.txt`) while `base.txt` ALSO has its own staged edit.
    // Unstaging `copy.txt` must NOT unstage `base.txt`'s independent staged modification!
    await fs.writeFile(
      path.join(repo, 'copy.txt'),
      'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(repo, 'base.txt'),
      'line1-edited\nline2\nline3\nline4\nline5\nline6\nline7\nline8\n',
      'utf8',
    );
    await runGit(['add', 'copy.txt', 'base.txt']);

    const snapCopy = await loadGitRepoSnapshot(repo);
    const copyEntry = snapCopy.staged.find(f => f.path === 'copy.txt');
    expect(copyEntry).toBeDefined();
    expect(copyEntry?.kind === 'copied' || copyEntry?.kind === 'added').toBe(true);
    expect(resolveGitStageActionPaths(copyEntry!, 'unstage')).toEqual(['copy.txt']);

    const unstageCopy = await unstageGitFiles(repo, resolveGitStageActionPaths(copyEntry!, 'unstage'));
    expect(unstageCopy.ok).toBe(true);
    const snapAfterCopyUnstage = await loadGitRepoSnapshot(repo);
    expect(snapAfterCopyUnstage.staged.some(f => f.path === 'copy.txt')).toBe(false);
    expect(snapAfterCopyUnstage.staged.some(f => f.path === 'base.txt')).toBe(true);

    // 3. P2-4: Inherited `GIT_LITERAL_PATHSPECS=1` must NOT break staging or unstaging!
    const prevEnv = process.env['GIT_LITERAL_PATHSPECS'];
    process.env['GIT_LITERAL_PATHSPECS'] = '1';
    try {
      const unstageWithEnv = await unstageGitFiles(repo, ['base.txt']);
      expect(unstageWithEnv.ok).toBe(true);
      const snapAfterEnv = await loadGitRepoSnapshot(repo);
      expect(snapAfterEnv.staged.some(f => f.path === 'base.txt')).toBe(false);
      expect(snapAfterEnv.unstaged.some(f => f.path === 'base.txt')).toBe(true);
    } finally {
      if (prevEnv === undefined) delete process.env['GIT_LITERAL_PATHSPECS'];
      else process.env['GIT_LITERAL_PATHSPECS'] = prevEnv;
    }
  });

  test('real git repo: subdirectory operations, literal pathspecs, rename unstage, and untracked symlink safety', async () => {
    const repo = await makeTempDir('oma-real-git-');
    const outsideDir = await makeTempDir('oma-outside-');
    const runGit = async (args: string[], cwd = repo): Promise<string> => {
      const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr}`);
      }
      return stdout;
    };

    await runGit(['init']);
    await runGit(['config', 'user.email', 'test@example.com']);
    await runGit(['config', 'user.name', 'Test User']);

    // Create sub/item.txt, decoy sub/sub/item.txt, glob-like report[1].md & report1.md, and old.md
    await fs.mkdir(path.join(repo, 'sub', 'sub'), { recursive: true });
    await fs.writeFile(path.join(repo, 'sub', 'item.txt'), 'orig-item\n', 'utf8');
    await fs.writeFile(path.join(repo, 'sub', 'sub', 'item.txt'), 'orig-decoy\n', 'utf8');
    await fs.writeFile(path.join(repo, 'report[1].md'), 'bracket-v1\n', 'utf8');
    await fs.writeFile(path.join(repo, 'report1.md'), 'plain-v1\n', 'utf8');
    await fs.writeFile(path.join(repo, 'old.md'), 'rename-body\n', 'utf8');
    await runGit(['add', '-A']);
    await runGit(['commit', '-m', 'initial']);

    // Modify sub/item.txt, sub/sub/item.txt, report[1].md, report1.md
    await fs.writeFile(path.join(repo, 'sub', 'item.txt'), 'changed-item\n', 'utf8');
    await fs.writeFile(path.join(repo, 'sub', 'sub', 'item.txt'), 'changed-decoy\n', 'utf8');
    await fs.writeFile(path.join(repo, 'report[1].md'), 'bracket-v2\n', 'utf8');
    await fs.writeFile(path.join(repo, 'report1.md'), 'plain-v2\n', 'utf8');

    // P1-6: Load snapshot from subdirectory `sub` -> snapshot.cwd resolves to repo root
    const subDir = path.join(repo, 'sub');
    const snap = await loadGitRepoSnapshot(subDir);
    expect(path.resolve(snap.cwd).toLowerCase()).toBe(path.resolve(repo).toLowerCase());

    const subItem = snap.unstaged.find(f => f.path === 'sub/item.txt');
    expect(subItem).toBeDefined();
    const subDiff = await loadGitFileDiff(snap.cwd, subItem!);
    expect(subDiff.kind).toBe('diff');
    expect(subDiff.unifiedDiff).toContain('+changed-item');
    expect(subDiff.unifiedDiff).not.toContain('changed-decoy');

    // Stage sub/item.txt via resolved repo root -> decoy sub/sub/item.txt remains unstaged
    const stageSub = await stageGitFiles(snap.cwd, ['sub/item.txt']);
    expect(stageSub.ok).toBe(true);
    const snapAfterSub = await loadGitRepoSnapshot(subDir);
    expect(snapAfterSub.staged.map(f => f.path)).toEqual(['sub/item.txt']);
    expect(snapAfterSub.unstaged.some(f => f.path === 'sub/sub/item.txt')).toBe(true);

    // P1-7: Stage `report[1].md` literally -> `report1.md` must NOT be staged
    const stageBracket = await stageGitFiles(snap.cwd, ['report[1].md']);
    expect(stageBracket.ok).toBe(true);
    const snapAfterBracket = await loadGitRepoSnapshot(subDir);
    expect(snapAfterBracket.staged.map(f => f.path).sort()).toEqual(['report[1].md', 'sub/item.txt']);
    expect(snapAfterBracket.unstaged.some(f => f.path === 'report1.md')).toBe(true);
    const bracketDiff = await loadGitFileDiff(snap.cwd, {
      path: 'report[1].md',
      kind: 'modified',
      area: 'staged',
    });
    expect(bracketDiff.unifiedDiff).toContain('+bracket-v2');
    expect(bracketDiff.unifiedDiff).not.toContain('plain-v2');

    // P2-1a: Staged rename `old.md -> new.md`, unstaging with [path, origPath] clears index cleanly
    await runGit(['mv', 'old.md', 'new.md']);
    const snapRenamed = await loadGitRepoSnapshot(subDir);
    const renamedEntry = snapRenamed.staged.find(f => f.path === 'new.md');
    expect(renamedEntry?.kind).toBe('renamed');
    expect(renamedEntry?.origPath).toBe('old.md');
    const unstageRename = await unstageGitFiles(snapRenamed.cwd, [
      renamedEntry!.path,
      renamedEntry!.origPath!,
    ]);
    expect(unstageRename.ok).toBe(true);
    const snapAfterUnstage = await loadGitRepoSnapshot(subDir);
    expect(snapAfterUnstage.staged.some(f => f.path === 'old.md' || f.path === 'new.md')).toBe(false);

    // P2-1b: Untracked symlink to outside file previews only the link target, never the external secret
    const secretFile = path.join(outsideDir, 'secret.txt');
    await fs.writeFile(secretFile, 'TOP_SECRET_OUTSIDE_CONTENT\n', 'utf8');
    const linkPath = path.join(repo, 'outside-link');
    let symlinkCreated = false;
    try {
      await fs.symlink(secretFile, linkPath);
      symlinkCreated = true;
    } catch {
      // Skip symlink assertion on Windows environments without symlink privileges
    }
    if (symlinkCreated) {
      const linkDiff = await loadGitFileDiff(snap.cwd, {
        path: 'outside-link',
        kind: 'untracked',
        area: 'unstaged',
      });
      expect(linkDiff.kind).toBe('diff');
      expect(linkDiff.unifiedDiff).toContain(secretFile);
      expect(linkDiff.unifiedDiff).not.toContain('TOP_SECRET_OUTSIDE_CONTENT');
    }
  });

  test('GIT_ALTERNATE_OBJECT_DIRECTORIES preserves C-style quoted paths with delimiters (unit + real git)', async () => {
    // 1. Unit checks for POSIX `:` and Windows `;` quoted entries
    const posixRaw = `"/tmp/alt:one/objects":relative/alt:"rel:two/objects"`;
    expect(parseGitAlternateObjectDirectories(posixRaw, ':').map(e => e.decoded)).toEqual([
      '/tmp/alt:one/objects',
      'relative/alt',
      'rel:two/objects',
    ]);
    expect(normalizeGitAlternateObjectDirectories(posixRaw, '/work/repo', 'linux')).toBe(
      `"/tmp/alt:one/objects":/work/repo/relative/alt:"/work/repo/rel:two/objects"`,
    );

    const winRaw = `"C:\\\\alt;one\\\\objects";"..\\\\rel;two\\\\objects";plain_alt`;
    expect(parseGitAlternateObjectDirectories(winRaw, ';').map(e => e.decoded)).toEqual([
      'C:\\alt;one\\objects',
      '..\\rel;two\\objects',
      'plain_alt',
    ]);
    expect(normalizeGitAlternateObjectDirectories(winRaw, 'D:\\proj\\repo', 'win32')).toBe(
      `"C:\\\\alt;one\\\\objects";"D:\\\\proj\\\\rel;two\\\\objects";D:\\proj\\repo\\plain_alt`,
    );

    // 2. Real Git integration: move repo objects into a directory whose name contains the
    // platform path delimiter (`;` on Windows, `:` on POSIX) and verify loadGitRepoSnapshot
    // reads HEAD commit cleanly for BOTH quoted absolute and quoted relative env entries.
    const root = await makeTempDir('oma-git-alt-odb-');
    const repo = path.join(root, 'repo');
    const sub = path.join(repo, 'sub');
    const dotDotSub = path.join(repo, '..cache');
    await fs.mkdir(sub, { recursive: true });
    await fs.mkdir(dotDotSub, { recursive: true });

    const runGit = async (args: string[], cwd = repo) => {
      const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) {
        throw new Error(`git ${args.join(' ')} failed (${code}): ${err || out}`);
      }
      return out;
    };

    await runGit(['init']);
    await runGit(['config', 'user.name', 'Alt ODB Test']);
    await runGit(['config', 'user.email', 'alt@example.com']);
    await fs.writeFile(path.join(repo, 'hello.txt'), 'world\n', 'utf8');
    await runGit(['add', '.']);
    await runGit(['commit', '-m', 'commit from quoted alternate odb']);

    const delim = path.delimiter;
    const altParent = path.join(root, `alt${delim}quoted`);
    const altObjects = path.join(altParent, 'objects');
    await fs.mkdir(altParent, { recursive: true });
    await fs.cp(path.join(repo, '.git', 'objects'), altObjects, { recursive: true });
    await fs.rm(path.join(repo, '.git', 'objects'), { recursive: true, force: true });
    await fs.mkdir(path.join(repo, '.git', 'objects', 'info'), { recursive: true });
    await fs.mkdir(path.join(repo, '.git', 'objects', 'pack'), { recursive: true });

    const prevAlt = process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
    try {
      // 2a. Quoted absolute path containing delimiter
      process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = formatGitAlternateObjectPath(altObjects, delim);
      const snapAbs = await loadGitRepoSnapshot(sub);
      expect(snapAbs.headCommit?.subject).toBe('commit from quoted alternate odb');

      // 2b. Quoted relative path (relative to repoRoot, matching native git from sub/)
      const relFromRepo = `../alt${delim}quoted/objects`;
      process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = formatGitAlternateObjectPath(relFromRepo, delim);
      const snapRel = await loadGitRepoSnapshot(sub);
      expect(snapRel.headCommit?.subject).toBe('commit from quoted alternate odb');

      // 2c. Legitimate subdir starting with `..` (e.g. `repo/..cache`) must still be
      // recognized as inside `repoRoot`, NOT misclassified as outside via `rel.startsWith('..')`!
      const snapDotDot = await loadGitRepoSnapshot(dotDotSub);
      expect(snapDotDot.headCommit?.subject).toBe('commit from quoted alternate odb');
    } finally {
      if (prevAlt === undefined) delete process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'];
      else process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = prevAlt;
    }
  });
});
