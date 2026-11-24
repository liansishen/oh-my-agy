import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_CONFIG,
  formatDefaultConfigToml,
  getConfigDir,
  getConfigPath,
  loadConfig,
  loadConfigSync,
  parseConfigToml,
} from '../src/config/config.ts';
import {
  fuzzyMatchFile,
  searchIndexedFiles,
  WorkspaceFileIndexer,
  type IndexedFile,
} from '../src/filesearch/indexer.ts';
import {
  deleteSessionPreview,
  getDataDir,
  getSessionFilePath,
  getSessionsDir,
  loadSessionPreview,
  loadSessionPreviewMap,
  parseSessionAnchorFile,
  parseSessionAnchorFileSync,
  PreviewStore,
  resolveSessionRef,
  resolveSessionRefSync,
  sanitizeSessionId,
  saveSessionPreview,
} from '../src/preview/store.ts';
import {
  isClipboardAvailable,
  isPngBytes,
  isRemoteSshSession,
  isRemoteSshWithoutDisplay,
  readClipboardImage,
  readClipboardText,
  writeClipboardText,
} from '../src/termio/clipboard.ts';
import {
  createOscWriter,
  encodeClearReopenAnchor,
  encodeOsc1337UserVar,
  encodeOsc7,
  encodeOsc7501,
  encodeOsc7501Blocked,
  encodeOsc7501Clear,
  encodeOsc7501Done,
  encodeOsc7501Error,
  encodeOsc7501Idle,
  encodeOsc7501Working,
  encodeReopenAnchor,
} from '../src/termio/osc.ts';
import { SafeTermOutput, type RawTermTarget } from '../src/termio/output.ts';

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('SafeTermOutput', () => {
  test('forwards isTTY/columns, writes atomically, and drops writes after close()', () => {
    const chunks: (string | Uint8Array)[] = [];
    const target: RawTermTarget = {
      isTTY: true,
      columns: 120,
      write(data) {
        chunks.push(data);
        return true;
      },
    };

    const out = new SafeTermOutput(target);
    expect(out.isTTY).toBe(true);
    expect(out.columns).toBe(120);
    expect(out.closed).toBe(false);

    expect(out.write('\x1b_tsp;{"v":1}\x1b\\')).toBe(true);
    expect(out.writeAtomic('\x1b]7501;', 'state=working', '\x1b\\')).toBe(true);
    expect(out.write(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(out.write('')).toBe(true); // empty no-op does not emit chunk

    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe('\x1b_tsp;{"v":1}\x1b\\');
    expect(chunks[1]).toBe('\x1b]7501;state=working\x1b\\');
    expect(chunks[2]).toEqual(new Uint8Array([1, 2, 3]));

    out.close();
    expect(out.closed).toBe(true);
    expect(out.write('after-close')).toBe(false);
    expect(out.writeAtomic('a', 'b')).toBe(false);
    expect(chunks.length).toBe(3);
  });

  test('auto-closes without throwing on EPIPE / closed stream errors', () => {
    const target: RawTermTarget = {
      write() {
        const err = new Error('broken pipe') as Error & { code: string };
        err.code = 'EPIPE';
        throw err;
      },
    };

    const out = new SafeTermOutput(target);
    expect(out.write('hello')).toBe(false);
    expect(out.closed).toBe(true);
    expect(out.write('again')).toBe(false);
  });
});

describe('OSC 7501 / OSC 1337 / OSC 7 encoding & OscWriter', () => {
  test('encodes all 6 OSC 7501 states with strict colon separator and ST terminator', () => {
    expect(encodeOsc7501Idle()).toBe('\x1b]7501;state=idle\x1b\\');
    expect(encodeOsc7501Working()).toBe('\x1b]7501;state=working\x1b\\');
    expect(encodeOsc7501Blocked('permission')).toBe('\x1b]7501;state=blocked:kind=permission\x1b\\');
    expect(encodeOsc7501Blocked('question')).toBe('\x1b]7501;state=blocked:kind=question\x1b\\');
    expect(encodeOsc7501Blocked('auth')).toBe('\x1b]7501;state=blocked:kind=auth\x1b\\');
    expect(encodeOsc7501Done()).toBe('\x1b]7501;state=done\x1b\\');
    expect(encodeOsc7501Error()).toBe('\x1b]7501;state=error\x1b\\');
    expect(encodeOsc7501Clear()).toBe('\x1b]7501;state=clear\x1b\\');

    // Sanitizes injected colons/semicolons/control chars in blocked kind
    expect(encodeOsc7501({ state: 'blocked', kind: 'auth;evil:x\n' })).toBe(
      '\x1b]7501;state=blocked:kind=authevilx\x1b\\',
    );
  });

  test('encodes OSC 1337 SetUserVar reopen anchor and clear sequences', () => {
    expect(encodeOsc1337UserVar('omp_restore', '1')).toBe('\x1b]1337;SetUserVar=omp_restore=MQ==\x07');
    expect(encodeOsc1337UserVar('omp_restore', '')).toBe('\x1b]1337;SetUserVar=omp_restore=\x07');

    const anchorPath = 'C:\\Users\\demo\\AppData\\Local\\oma\\sessions\\abc-123.json';
    const expectedB64 = Buffer.from(anchorPath, 'utf8').toString('base64');
    expect(encodeReopenAnchor(anchorPath)).toBe(
      `\x1b]1337;SetUserVar=omp_restore=MQ==\x07\x1b]1337;SetUserVar=omp_session_file=${expectedB64}\x07`,
    );
    expect(encodeClearReopenAnchor()).toBe(
      '\x1b]1337;SetUserVar=omp_restore=\x07\x1b]1337;SetUserVar=omp_session_file=\x07',
    );
  });

  test('encodes OSC 7 URIs for Windows and POSIX paths with spaces', () => {
    expect(encodeOsc7('D:\\Projects\\oh my agy', 'devbox')).toBe(
      '\x1b]7;file://devbox/D:/Projects/oh%20my%20agy\x1b\\',
    );
    expect(encodeOsc7('/home/alice/my repo', 'linux-host')).toBe(
      '\x1b]7;file://linux-host/home/alice/my%20repo\x1b\\',
    );
  });

  test('OscWriter respects feature toggles and SafeTermOutput close guard', () => {
    const writes: string[] = [];
    const safeOut = new SafeTermOutput({
      write(data) {
        writes.push(String(data));
      },
    });

    const writer = createOscWriter(safeOut, {
      osc7501: true,
      reopenAnchor: false,
      osc7: true,
      hostname: 'host1',
    });

    expect(writer.setStatusIdle()).toBe(true);
    expect(writer.setStatusWorking()).toBe(true);
    expect(writer.setStatusBlocked('permission')).toBe(true);
    expect(writer.setStatusDone()).toBe(true);
    expect(writer.setStatusError()).toBe(true);
    expect(writer.setStatusClear()).toBe(true);
    expect(writer.setReopenAnchor('/tmp/a.json')).toBe(false);
    expect(writer.clearReopenAnchor()).toBe(false);
    expect(writer.setWorkingDirectory('/workspace')).toBe(true);

    expect(writes).toEqual([
      '\x1b]7501;state=idle\x1b\\',
      '\x1b]7501;state=working\x1b\\',
      '\x1b]7501;state=blocked:kind=permission\x1b\\',
      '\x1b]7501;state=done\x1b\\',
      '\x1b]7501;state=error\x1b\\',
      '\x1b]7501;state=clear\x1b\\',
      '\x1b]7;file://host1/workspace\x1b\\',
    ]);

    safeOut.close();
    expect(writer.setStatusWorking()).toBe(false);
    expect(writes.length).toBe(7);
  });
});

describe('clipboard environment detection & graceful degradation', () => {
  test('validates PNG magic header bytes', () => {
    const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const invalidBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(isPngBytes(validPng)).toBe(true);
    expect(isPngBytes(invalidBytes)).toBe(false);
    expect(isPngBytes(new Uint8Array([0x89, 0x50]))).toBe(false);
  });

  test('detects pure SSH headless Linux sessions and degrades cleanly to null/false', async () => {
    const sshHeadlessEnv = { SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22' };
    const sshX11Env = { SSH_CONNECTION: '10.0.0.1 12345 10.0.0.2 22', DISPLAY: ':10.0' };

    expect(isRemoteSshSession(sshHeadlessEnv)).toBe(true);
    expect(isRemoteSshWithoutDisplay(sshHeadlessEnv, 'linux')).toBe(true);
    expect(isClipboardAvailable(sshHeadlessEnv, 'linux')).toBe(false);

    expect(isRemoteSshWithoutDisplay(sshX11Env, 'linux')).toBe(false);
    expect(isClipboardAvailable(sshX11Env, 'linux')).toBe(true);

    expect(
      await readClipboardImage({ env: sshHeadlessEnv, platform: 'linux' }),
    ).toBeNull();
    expect(
      await readClipboardText({ env: sshHeadlessEnv, platform: 'linux' }),
    ).toBeNull();
    expect(
      await writeClipboardText('hello', { env: sshHeadlessEnv, platform: 'linux' }),
    ).toBe(false);
  });
});

describe('config.toml loading, defaults, and validation', () => {
  test('computes Windows and POSIX config paths correctly', () => {
    expect(
      getConfigPath({ platform: 'win32', env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' } }),
    ).toBe('C:\\Users\\alice\\AppData\\Roaming\\oma\\config.toml');

    expect(
      getConfigDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/alice/.xdg' }, homedir: '/home/alice' }),
    ).toBe('/home/alice/.xdg/oma');

    expect(
      getConfigPath({ platform: 'darwin', env: {}, homedir: '/Users/alice' }),
    ).toBe('/Users/alice/.config/oma/config.toml');
  });

  test('parses valid config.toml and default template with zero warnings', () => {
    const parsedDefault = parseConfigToml(formatDefaultConfigToml());
    expect(parsedDefault.warnings).toEqual([]);
    expect(parsedDefault.config).toEqual(DEFAULT_CONFIG);

    const customToml = `
agy_bin = "C:\\\\Tools\\\\agy.exe"
default_model = "gemini-4-neon"
default_thought = "high"
default_mode = "accept-edits"

[ui]
auto_collapse_thought = false
tool_preview_lines = 16
osc_7501 = false
reopen_anchor = true

[approval]
auto_allow_tools = ["read_file", "list_dir", "read_file", "  "]
`;
    const parsed = parseConfigToml(customToml);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config).toEqual({
      agy_bin: 'C:\\Tools\\agy.exe',
      default_model: 'gemini-4-neon',
      default_thought: 'high',
      default_mode: 'accept-edits',
      recent_models: [],
      ui: {
        auto_collapse_thought: false,
        collapse_compacted: true,
        tool_display: 'all',
        tool_preview_lines: 16,
        todo_provider: 'mcp',
        osc_7501: false,
        reopen_anchor: true,
      },
      approval: {
        auto_allow_tools: ['read_file', 'list_dir'],
      },
    });

    const offTodo = parseConfigToml('[ui]\ntodo_provider = "off"\n');
    expect(offTodo.warnings).toEqual([]);
    expect(offTodo.config.ui.todo_provider).toBe('off');

    const nativeTodo = parseConfigToml('[ui]\ntodo_provider = "native"\n');
    expect(nativeTodo.warnings).toEqual([]);
    expect(nativeTodo.config.ui.todo_provider).toBe('native');

    const badTodoProvider = parseConfigToml('[ui]\ntodo_provider = "other"\n');
    expect(badTodoProvider.config.ui.todo_provider).toBe('mcp');
    expect(badTodoProvider.warnings).toContain(
      'ui.todo_provider: unrecognized value "other" (expected off|mcp|native), using "mcp"',
    );
  });

  test('validates malformed fields, clamps bounds, and survives broken TOML', async () => {
    const badFields = parseConfigToml(`
agy_bin = 123
default_mode = "yolo"
extra_field = true

[ui]
auto_collapse_thought = "yes"
tool_preview_lines = 999

[approval]
auto_allow_tools = "not-an-array"
`);
    expect(badFields.config.agy_bin).toBe('');
    expect(badFields.config.ui.auto_collapse_thought).toBe(true);
    expect(badFields.config.ui.tool_preview_lines).toBe(200);
    expect(badFields.config.approval.auto_allow_tools).toEqual([]);
    expect(badFields.warnings.length).toBeGreaterThanOrEqual(5);

    const brokenToml = parseConfigToml('[ui\nbroken = ');
    expect(brokenToml.config).toEqual(DEFAULT_CONFIG);
    expect(brokenToml.warnings.length).toBe(1);

    const dir = await makeTempDir('oma-cfg-');
    const missing = await loadConfig({ path: join(dir, 'missing.toml') });
    expect(missing.exists).toBe(false);
    expect(missing.config).toEqual(DEFAULT_CONFIG);
    expect(missing.warnings).toEqual([]);

    const cfgPath = join(dir, 'config.toml');
    await writeFile(cfgPath, 'default_model = "claude-opus-5-5"\n[ui]\ntool_preview_lines = 12\n');
    const loadedAsync = await loadConfig({ path: cfgPath });
    const loadedSync = loadConfigSync({ path: cfgPath });
    expect(loadedAsync.exists).toBe(true);
    expect(loadedAsync.config.default_model).toBe('claude-opus-5-5');
    expect(loadedAsync.config.ui.tool_preview_lines).toBe(12);
    expect(loadedSync.config).toEqual(loadedAsync.config);
  });
});

describe('session preview & reopen anchor store', () => {
  test('computes Windows and POSIX data/sessions paths and sanitizes IDs', () => {
    expect(
      getSessionsDir({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\alice\\AppData\\Local' },
      }),
    ).toBe('C:\\Users\\alice\\AppData\\Local\\oma\\sessions');

    expect(
      getDataDir({ platform: 'linux', env: {}, homedir: '/home/alice' }),
    ).toBe('/home/alice/.local/share/oma');

    expect(
      getSessionFilePath('abc-123', {
        platform: 'linux',
        env: { XDG_DATA_HOME: '/data' },
      }),
    ).toBe('/data/oma/sessions/abc-123.json');

    expect(sanitizeSessionId('../escape/id:1')).not.toContain('/');
    expect(sanitizeSessionId('../escape/id:1')).not.toContain('..');
  });

  test('atomically writes, reads, truncates previews, and resolves anchor refs', async () => {
    const sessionsDir = await makeTempDir('oma-sessions-');
    const store = new PreviewStore({ sessionsDir });

    const longText = 'x'.repeat(600);
    const savedPath = await store.save({
      sessionId: 'd9834138-aa41-4c57-8242-dbca52334d8f',
      cwd: 'D:\\Projects\\oh-my-agy',
      title: 'Oh My Agy 设计',
      model: 'gemini-4-neon',
      thoughtLevel: 'high',
      mode: 'default',
      turnCount: 4,
      updatedAt: '2026-11-20T22:40:00+08:00',
      preview: [
        { role: 'user', text: 't1' },
        { role: 'assistant', text: 'a1' },
        { role: 'user', text: 't2' },
        { role: 'assistant', text: 'a2' },
        { role: 'user', text: 't3' },
        { role: 'assistant', text: 'a3' },
        { role: 'user', text: 't4' },
        { role: 'assistant', text: longText },
      ],
    });

    // No leftover .tmp files
    const entries = await readdir(sessionsDir);
    expect(entries).toEqual(['d9834138-aa41-4c57-8242-dbca52334d8f.json']);

    const loaded = await loadSessionPreview('d9834138-aa41-4c57-8242-dbca52334d8f', { sessionsDir });
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.title).toBe('Oh My Agy 设计');
    expect(loaded!.preview.length).toBe(6); // kept most recent 6 entries
    expect(loaded!.preview[0]?.text).toBe('t2');
    expect(loaded!.preview[5]?.text.length).toBe(500);
    expect(loaded!.preview[5]?.text.endsWith('…')).toBe(true);

    // Quoted path with spaces support
    const spaceDir = await makeTempDir('oma anchor dir ');
    const spacedPath = await saveSessionPreview(
      {
        sessionId: 'sess-space',
        cwd: '/work/repo',
        title: 'Spaced Path',
        preview: [{ role: 'user', text: 'hello' }],
      },
      { sessionsDir: spaceDir },
    );

    const parsedAsync = await parseSessionAnchorFile(`"${spacedPath}"`);
    const parsedSync = parseSessionAnchorFileSync(`'${spacedPath}'`);
    expect(parsedAsync?.sessionId).toBe('sess-space');
    expect(parsedSync?.sessionId).toBe('sess-space');

    const refFromFile = await resolveSessionRef(`"${savedPath}"`, { sessionsDir });
    expect(refFromFile.source).toBe('file');
    expect(refFromFile.sessionId).toBe('d9834138-aa41-4c57-8242-dbca52334d8f');
    expect(refFromFile.cwd).toBe('D:\\Projects\\oh-my-agy');

    const refFromId = resolveSessionRefSync('d9834138-aa41-4c57-8242-dbca52334d8f', { sessionsDir });
    expect(refFromId.source).toBe('id');
    expect(refFromId.anchor?.model).toBe('gemini-4-neon');

    const refMissing = await resolveSessionRef(join(sessionsDir, 'nope.json'), { sessionsDir });
    expect(refMissing.source).toBe('missing-file');
    expect(refMissing.sessionId).toBeNull();

    const map = await loadSessionPreviewMap(undefined, { sessionsDir });
    expect(map.size).toBe(1);
    expect(map.get('d9834138-aa41-4c57-8242-dbca52334d8f')?.turnCount).toBe(4);

    expect(await deleteSessionPreview('d9834138-aa41-4c57-8242-dbca52334d8f', { sessionsDir })).toBe(true);
    expect(await store.load('d9834138-aa41-4c57-8242-dbca52334d8f')).toBeNull();
  });
});

describe('workspace file indexer & fuzzy search', () => {
  test('scans cwd asynchronously while ignoring .git, node_modules, dist, vendor', async () => {
    const root = await makeTempDir('oma-fs-');
    await mkdir(join(root, 'src', 'termio'), { recursive: true });
    await mkdir(join(root, 'src', 'config'), { recursive: true });
    await mkdir(join(root, '.git', 'objects'), { recursive: true });
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await mkdir(join(root, 'vendor', 'tern'), { recursive: true });

    await writeFile(join(root, 'README.md'), '# hello');
    await writeFile(join(root, 'src', 'termio', 'osc.ts'), '');
    await writeFile(join(root, 'src', 'termio', 'output.ts'), '');
    await writeFile(join(root, 'src', 'config', 'config.ts'), '');
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main');
    await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), '');
    await writeFile(join(root, 'dist', 'oma.exe'), '');
    await writeFile(join(root, 'vendor', 'tern', 'index.ts'), '');

    const indexer = new WorkspaceFileIndexer(root);
    const files = await indexer.start();
    expect(indexer.status).toBe('ready');

    const relPaths = files.map((f) => f.relPath);
    expect(relPaths).toEqual([
      'README.md',
      'src/config/config.ts',
      'src/termio/osc.ts',
      'src/termio/output.ts',
    ]);

    const matches = indexer.search('osc');
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]?.file.relPath).toBe('src/termio/osc.ts');
    // Highlight spans must point directly at "osc" in "src/termio/osc.ts"
    expect(matches[0]?.hits).toEqual([[11, 14]]);

    // Refresh picks up newly added files
    await writeFile(join(root, 'src', 'termio', 'clipboard.ts'), '');
    await indexer.refresh();
    expect(indexer.search('clip')[0]?.file.relPath).toBe('src/termio/clipboard.ts');
    indexer.dispose();
  });

  test('ranks exact/prefix filename matches ahead of scattered directory matches', () => {
    const sample: IndexedFile[] = [
      { relPath: 'docs/other/sample_config_notes.md', absPath: '/a', name: 'sample_config_notes.md', dir: 'docs/other' },
      { relPath: 'src/config/config.ts', absPath: '/b', name: 'config.ts', dir: 'src/config' },
      { relPath: 'src/app/controller_file_graph.ts', absPath: '/c', name: 'controller_file_graph.ts', dir: 'src/app' },
      { relPath: 'config.toml', absPath: '/d', name: 'config.toml', dir: '' },
    ];

    const ranked = searchIndexedFiles(sample, 'config.ts', 10);
    expect(ranked[0]?.file.relPath).toBe('src/config/config.ts');

    const rankedPrefix = searchIndexedFiles(sample, 'cfg', 10);
    // All matching items have valid in-bounds non-overlapping highlight spans
    for (const m of rankedPrefix) {
      for (const [start, end] of m.hits) {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeGreaterThan(start);
        expect(end).toBeLessThanOrEqual(m.file.relPath.length);
      }
    }

    expect(fuzzyMatchFile('zzz_no_match', sample[0]!)).toBeNull();
  });

  test('respects maxFiles truncation guard and handles corrupted anchor JSON gracefully', async () => {
    const root = await makeTempDir('oma-limit-');
    await writeFile(join(root, 'a.ts'), '');
    await writeFile(join(root, 'b.ts'), '');
    await writeFile(join(root, 'c.ts'), '');
    await writeFile(join(root, 'broken.json'), '{not valid json');

    const indexer = new WorkspaceFileIndexer(root, { maxFiles: 2 });
    const files = await indexer.start();
    expect(files.length).toBe(2);
    expect(indexer.truncated).toBe(true);

    expect(await parseSessionAnchorFile(join(root, 'broken.json'))).toBeNull();
    expect(parseSessionAnchorFileSync(join(root, 'broken.json'))).toBeNull();
  });
});
