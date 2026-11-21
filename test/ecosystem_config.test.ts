import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ui,
  type PickerAction,
  type PickerItem,
  type PickerLevel,
  type PickerProps,
  type PickerScope,
  type SectionProps,
  type StackProps,
  type ToolProps,
} from '@stencil-hq/tern';

import { AcpClient, type AcpChildProcess, type AcpSpawnFn } from '../src/acp/client.ts';
import {
  extractSessionTier,
  type InitializeResult,
  type JsonRpcMessage,
  type SessionMeta,
} from '../src/acp/protocol.ts';
import {
  AGY_SAFE_SETTING_KEYS,
  DEFAULT_AGY_SAFE_SETTINGS,
  getAgySettingsPath,
  loadAgySettings,
  saveAgySettings,
  updateAgySetting,
} from '../src/config/agy_settings.ts';
import {
  DEFAULT_CONFIG,
  formatConfigToml,
  loadConfig,
  MAX_RECENT_MODELS,
  normalizeRecentModels,
  parseConfigToml,
  recordRecentModel,
  saveConfig,
  type OmaConfig,
} from '../src/config/config.ts';
import {
  addMcpServer,
  exportTranscriptMarkdown,
  formatTranscriptMarkdown,
  listAgents,
  listMcpServers,
  listPlugins,
  parseAgentsOutput,
  parseMcpListOutput,
  parsePluginsJsonOutput,
  removeMcpServer,
  scanLocalSkills,
  setMcpServerEnabled,
  setPluginEnabled,
  type ExecCommandFn,
  type ExportableTurn,
} from '../src/ecosystem/cli.ts';
import {
  createOscWriter,
  encodeOscTitle,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from '../src/termio/osc.ts';
import { SafeTermOutput } from '../src/termio/output.ts';

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

// ---------------------------------------------------------------------------
// 1. vendor/tern TSP Props Type & Runtime Passthrough
// ---------------------------------------------------------------------------

describe('vendor/tern TSP props extensions', () => {
  test('accepts and serializes PickerLevel, PickerProps, SectionProps, StackProps, ToolProps extensions', () => {
    const level: PickerLevel = {
      label: 'Thinking',
      icon: 'brain',
      detail: 'google',
      steps: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
      ],
      value: 'high',
      keys: ['left', 'right'],
    };

    const scope: PickerScope = {
      id: 'provider:google',
      label: 'Google',
      mark: { text: 'GO', seed: 'google', icon: 'provider:google' },
    };

    const item: PickerItem = {
      id: 'gemini-4-neon',
      label: 'gemini-4-neon',
      mono: true,
      mark: { text: 'GO', seed: 'google', icon: 'provider:google' },
    };

    const action: PickerAction = {
      id: 'refresh',
      label: 'Refresh',
      head: true,
      icon: 'repeat',
    };

    const pickerProps: PickerProps = {
      size: 'md',
      anchor: 'composer',
      search: 'list',
      density: 'snug',
      scopeStyle: 'rail',
      preview: 'none',
      level,
      scopes: [scope],
      items: [item],
      actions: [action],
    };

    const colProps: StackProps = { folded: true, gap: 'sm' };
    const sectionProps: SectionProps = { head: 'Thinking', collapsible: true, took: 4200 };
    const toolNone: ToolProps = { name: 'read', frame: 'inline', preview: 'none' };
    const toolChildren: ToolProps = { name: 'bash', frame: 'card', preview: 'children' };

    const pickerJson = ui.picker(pickerProps).toJSON();
    expect(pickerJson.p?.['anchor']).toBe('composer');
    expect(pickerJson.p?.['search']).toBe('list');
    expect(pickerJson.p?.['density']).toBe('snug');
    expect(pickerJson.p?.['scopeStyle']).toBe('rail');
    expect(pickerJson.p?.['level'] as unknown).toEqual(level);

    const colJson = ui.col(colProps).toJSON();
    expect(colJson.p?.['folded']).toBe(true);

    const secJson = ui.section(sectionProps).toJSON();
    expect(secJson.p?.['took']).toBe(4200);

    expect(ui.tool(toolNone).toJSON().p?.['preview']).toBe('none');
    expect(ui.tool(toolChildren).toJSON().p?.['preview']).toBe('children');
  });
});

// ---------------------------------------------------------------------------
// 2. OSC Cursor & Title Controls
// ---------------------------------------------------------------------------

describe('src/termio/osc.ts cursor & title sequences', () => {
  test('exports DECTCEM cursor constants and sanitizes OSC 2 title sequences', () => {
    expect(HIDE_CURSOR).toBe('\x1b[?25l');
    expect(SHOW_CURSOR).toBe('\x1b[?25h');

    expect(encodeOscTitle('oma · Antigravity')).toBe('\x1b]2;oma · Antigravity\x1b\\');
    expect(encodeOscTitle('evil\x1b]7501;state=error\x07title\r\n\x00\x9b31m')).toBe(
      '\x1b]2;evil]7501;state=errortitle31m\x1b\\',
    );
    expect(encodeOscTitle('')).toBe('\x1b]2;\x1b\\');
  });

  test('OscWriter hideCursor/showCursor/setTitle stay enabled even when osc7501/reopenAnchor/osc7 are disabled', () => {
    const writes: string[] = [];
    const safeOut = new SafeTermOutput({
      write(data) {
        writes.push(String(data));
      },
    });

    const writer = createOscWriter(safeOut, {
      osc7501: false,
      reopenAnchor: false,
      osc7: false,
    });

    expect(writer.setStatusWorking()).toBe(false);
    expect(writer.setReopenAnchor('/tmp/anchor.json')).toBe(false);
    expect(writer.setWorkingDirectory('/tmp')).toBe(false);

    expect(writer.hideCursor()).toBe(true);
    expect(writer.setTitle('oma · demo')).toBe(true);
    expect(writer.showCursor()).toBe(true);

    expect(writes).toEqual(['\x1b[?25l', '\x1b]2;oma · demo\x1b\\', '\x1b[?25h']);

    safeOut.close();
    expect(writer.hideCursor()).toBe(false);
    expect(writer.showCursor()).toBe(false);
    expect(writer.setTitle('ignored')).toBe(false);
    expect(writes.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 3. ACP Protocol Tier / Auth Capabilities & AcpClient.logout()
// ---------------------------------------------------------------------------

function createMiniMockAcp() {
  const encoder = new TextEncoder();
  let stdoutCtrl!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  let exited = false;
  let buf = '';
  let onMsg: ((msg: JsonRpcMessage) => void) | null = null;
  const sent: JsonRpcMessage[] = [];

  const stdout = new ReadableStream<Uint8Array>({
    start(c) {
      stdoutCtrl = c;
    },
  });
  const exitedPromise = new Promise<number>((r) => {
    resolveExit = r;
  });

  const spawn: AcpSpawnFn = () => {
    const child: AcpChildProcess = {
      pid: 9999,
      stdin: {
        write(chunk) {
          buf += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
          let nl: number;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            const parsed = JSON.parse(line) as JsonRpcMessage;
            sent.push(parsed);
            onMsg?.(parsed);
          }
          return 0;
        },
        flush() {},
        end() {},
      },
      stdout,
      stderr: null,
      exited: exitedPromise,
      kill() {
        if (!exited) {
          exited = true;
          try {
            stdoutCtrl.close();
          } catch {
            // ignore
          }
          resolveExit(0);
        }
      },
    };
    return child;
  };

  return {
    spawn,
    sent,
    onClientMessage(fn: (msg: JsonRpcMessage) => void) {
      onMsg = fn;
    },
    sendFromServer(msg: unknown) {
      if (!exited) {
        stdoutCtrl.enqueue(encoder.encode(`${JSON.stringify(msg)}\n`));
      }
    },
  };
}

describe('ACP tier metadata, auth capabilities & AcpClient.logout()', () => {
  test('extractSessionTier extracts typed AntigravityTierInfo and ignores invalid payloads', () => {
    const meta: SessionMeta = {
      antigravity: {
        tier: {
          id: 'ultra',
          name: ' Google AI Ultra ',
          upgradeUri: 'https://antigravity.google/upgrade',
        },
      },
    };
    expect(extractSessionTier(meta)).toEqual({
      id: 'ultra',
      name: 'Google AI Ultra',
      upgradeUri: 'https://antigravity.google/upgrade',
    });
    expect(extractSessionTier(undefined)).toBeNull();
    expect(extractSessionTier({})).toBeNull();
    expect(extractSessionTier({ antigravity: { tier: {} } })).toBeNull();
  });

  test('AcpClient tracks agentInfo, supportsLogout, currentTier, and sends auth/logout RPC', async () => {
    const mock = createMiniMockAcp();
    const client = new AcpClient({ spawn: mock.spawn });
    client.start();

    expect(client.agentInfo).toBeNull();
    expect(client.supportsLogout).toBe(false);
    expect(client.currentTier).toBeNull();

    mock.onClientMessage((msg) => {
      if (!('id' in msg) || !('method' in msg)) return;
      if (msg.method === 'initialize') {
        const result: InitializeResult = {
          protocolVersion: 1,
          agentInfo: { name: 'agy', version: '1.5.13' },
          agentCapabilities: {
            loadSession: true,
            auth: { logout: {} },
          },
        };
        mock.sendFromServer({ jsonrpc: '2.0', id: msg.id, result });
      } else if (msg.method === 'session/new') {
        mock.sendFromServer({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'sess-tier-1',
            _meta: {
              antigravity: {
                tier: { id: 'ultra', name: 'Google AI Ultra' },
              },
            },
          },
        });
      } else if (msg.method === 'session/load') {
        mock.sendFromServer({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            sessionId: 'sess-tier-2',
            _meta: {
              antigravity: {
                tier: { id: 'pro', name: 'Google AI Pro' },
              },
            },
          },
        });
      } else if (msg.method === 'auth/logout') {
        mock.sendFromServer({ jsonrpc: '2.0', id: msg.id, result: {} });
      }
    });

    await client.initialize();
    expect(client.agentInfo).toEqual({ name: 'agy', version: '1.5.13' });
    expect(client.supportsLogout).toBe(true);

    const created = await client.newSession({ cwd: '/work' });
    expect(created._meta?.antigravity?.tier?.name).toBe('Google AI Ultra');
    expect(client.currentTier).toEqual({ id: 'ultra', name: 'Google AI Ultra' });

    await client.loadSession({ sessionId: 'sess-tier-2', cwd: '/work' });
    expect(client.currentTier).toEqual({ id: 'pro', name: 'Google AI Pro' });

    await client.logout();
    expect(mock.sent.some((m) => 'method' in m && m.method === 'auth/logout')).toBe(true);
    expect(client.currentSessionId).toBeNull();
    expect(client.currentTier).toBeNull();

    await client.close({ timeoutMs: 50 });
    expect(client.agentInfo).toBeNull();
    expect(client.supportsLogout).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. OmaConfig recent_models, formatConfigToml & atomic saveConfig
// ---------------------------------------------------------------------------

describe('src/config/config.ts recent_models & atomic saveConfig', () => {
  test('deduplicates and caps recent_models at 12 entries', () => {
    const many = Array.from({ length: 18 }, (_, i) => `model-${i}`);
    const normalized = normalizeRecentModels(['model-0', '  ', 'model-1', ...many]);
    expect(normalized).toHaveLength(MAX_RECENT_MODELS);
    expect(normalized[0]).toBe('model-0');
    expect(normalized[11]).toBe('model-11');

    const promoted = recordRecentModel(normalized, 'model-5');
    expect(promoted).toHaveLength(MAX_RECENT_MODELS);
    expect(promoted[0]).toBe('model-5');
    expect(promoted.filter((m) => m === 'model-5')).toHaveLength(1);

    const added = recordRecentModel(normalized, 'brand-new');
    expect(added).toHaveLength(MAX_RECENT_MODELS);
    expect(added[0]).toBe('brand-new');
    expect(added.includes('model-11')).toBe(false);
  });

  test('round-trips formatConfigToml -> parseConfigToml and atomically writes via saveConfig', async () => {
    const dir = await makeTempDir('oma-save-cfg-');
    const nestedPath = join(dir, 'nested', 'dir', 'config.toml');

    const custom: OmaConfig = {
      agy_bin: 'C:\\Program Files\\Agy\\agy.exe',
      default_model: 'gemini-4-neon',
      default_thought: 'high',
      default_mode: 'accept-edits',
      recent_models: [
        'gemini-4-neon',
        'claude-opus-5-5',
        'gemini-4-neon',
        'gpt-oss-120b-medium',
      ],
      ui: {
        auto_collapse_thought: false,
        tool_preview_lines: 24,
        osc_7501: true,
        reopen_anchor: false,
      },
      approval: {
        auto_allow_tools: ['read_file', 'list_dir', 'read_file'],
      },
    };

    const toml = formatConfigToml(custom);
    const parsed = parseConfigToml(toml);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.config).toEqual({
      ...custom,
      recent_models: ['gemini-4-neon', 'claude-opus-5-5', 'gpt-oss-120b-medium'],
      approval: { auto_allow_tools: ['read_file', 'list_dir'] },
    });

    const writtenPath = await saveConfig(custom, nestedPath);
    expect(writtenPath).toBe(nestedPath);

    // No leftover temp files
    const entries = await readdir(join(dir, 'nested', 'dir'));
    expect(entries).toEqual(['config.toml']);

    const reloaded = await loadConfig({ path: nestedPath });
    expect(reloaded.exists).toBe(true);
    expect(reloaded.warnings).toEqual([]);
    expect(reloaded.config).toEqual(parsed.config);
    expect(DEFAULT_CONFIG.recent_models).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Agy Settings Safe Allowlist Persistence
// ---------------------------------------------------------------------------

describe('src/config/agy_settings.ts strict safe allowlist persistence', () => {
  test('resolves default path and refuses credential-like paths', () => {
    expect(getAgySettingsPath({ homedir: '/home/alice', platform: 'linux' })).toBe(
      '/home/alice/.gemini/antigravity-cli/settings.json',
    );
    expect(getAgySettingsPath({ homedir: 'C:\\Users\\alice', platform: 'win32' })).toBe(
      'C:\\Users\\alice\\.gemini\\antigravity-cli\\settings.json',
    );

    expect(() => getAgySettingsPath({ path: '/tmp/oauth_creds.json' })).toThrow();
    expect(() => getAgySettingsPath({ path: '/tmp/google_accounts.json' })).toThrow();
    expect(() =>
      getAgySettingsPath({ path: '/tmp/jetski-standalone-oauth-token' }),
    ).toThrow();
    expect(AGY_SAFE_SETTING_KEYS).toEqual([
      'toolPermission',
      'enableTerminalSandbox',
      'allowNonWorkspaceAccess',
      'artifactReviewPolicy',
      'useG1Credits',
    ]);
  });

  test('preserves 100% of unknown keys, ignores non-allowlisted patch keys, and deletes keys reset to defaults', async () => {
    const dir = await makeTempDir('oma-agy-settings-');
    const settingsPath = join(dir, 'settings.json');

    // Missing file returns defaults cleanly
    const missing = await loadAgySettings({ path: settingsPath });
    expect(missing.exists).toBe(false);
    expect(missing.settings).toEqual(DEFAULT_AGY_SAFE_SETTINGS);
    expect(missing.warnings).toEqual([]);

    // Seed file with real-world unknown agy TUI keys
    const originalUnknown = {
      altScreenMode: 'auto',
      contextWindow: '1m',
      model: 'gemini-4-neon',
      permissions: { allow: ['read_file'] },
      statusLine: { type: 'command', command: 'echo hi', enabled: true },
      trustedWorkspaces: ['D:\\Projects\\oh-my-agy'],
      toolPermission: 'strict',
      useG1Credits: true,
    };
    await writeFile(settingsPath, `${JSON.stringify(originalUnknown, null, 2)}\n`, 'utf8');

    const loaded = await loadAgySettings({ path: settingsPath });
    expect(loaded.exists).toBe(true);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.settings).toEqual({
      toolPermission: 'strict',
      enableTerminalSandbox: false,
      allowNonWorkspaceAccess: false,
      artifactReviewPolicy: 'asks-for-review',
      useG1Credits: true,
    });
    expect(loaded.presentKeys).toEqual(['toolPermission', 'useG1Credits']);

    // Update safe keys + attempt to sneak non-allowlisted keys + reset one key to default
    const saved = await saveAgySettings(
      {
        toolPermission: 'request-review', // default -> must be DELETED
        enableTerminalSandbox: true,
        allowNonWorkspaceAccess: true,
        artifactReviewPolicy: 'always-proceed',
        useG1Credits: null, // null -> must be DELETED
        model: 'should-be-ignored',
        apiKey: 'secret-ignored',
      },
      { path: settingsPath },
    );

    expect(saved.updatedKeys).toEqual([
      'enableTerminalSandbox',
      'allowNonWorkspaceAccess',
      'artifactReviewPolicy',
    ]);
    expect(saved.deletedKeys).toEqual(['toolPermission', 'useG1Credits']);
    expect(saved.ignoredKeys).toEqual(['model', 'apiKey']);

    // Verify raw JSON on disk: unknown keys preserved 100%, defaults deleted, ignored keys absent
    const rawOnDisk = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    expect(rawOnDisk['altScreenMode']).toBe('auto');
    expect(rawOnDisk['contextWindow']).toBe('1m');
    expect(rawOnDisk['model']).toBe('gemini-4-neon'); // untouched!
    expect(rawOnDisk['permissions']).toEqual({ allow: ['read_file'] });
    expect(rawOnDisk['statusLine']).toEqual({ type: 'command', command: 'echo hi', enabled: true });
    expect(rawOnDisk['trustedWorkspaces']).toEqual(['D:\\Projects\\oh-my-agy']);
    expect('apiKey' in rawOnDisk).toBe(false);
    expect('toolPermission' in rawOnDisk).toBe(false);
    expect('useG1Credits' in rawOnDisk).toBe(false);
    expect(rawOnDisk['enableTerminalSandbox']).toBe(true);
    expect(rawOnDisk['allowNonWorkspaceAccess']).toBe(true);
    expect(rawOnDisk['artifactReviewPolicy']).toBe('always-proceed');

    // Convenience single-key update & no leftover tmp files
    await updateAgySetting('enableTerminalSandbox', false, { path: settingsPath });
    const afterSingle = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    expect('enableTerminalSandbox' in afterSingle).toBe(false);
    expect(await readdir(dir)).toEqual(['settings.json']);
  });

  test('refuses to overwrite corrupted settings.json on save and warns on load', async () => {
    const dir = await makeTempDir('oma-agy-broken-');
    const settingsPath = join(dir, 'settings.json');
    await writeFile(settingsPath, '{ broken json', 'utf8');

    const loaded = await loadAgySettings({ path: settingsPath });
    expect(loaded.settings).toEqual(DEFAULT_AGY_SAFE_SETTINGS);
    expect(loaded.warnings.length).toBeGreaterThan(0);

    await expect(
      saveAgySettings({ enableTerminalSandbox: true }, { path: settingsPath }),
    ).rejects.toThrow();

    // Original file remains untouched
    expect(await readFile(settingsPath, 'utf8')).toBe('{ broken json');
  });
});

// ---------------------------------------------------------------------------
// 6. Ecosystem CLI Wrappers (MCP / Plugins / Agents / Skills / Export)
// ---------------------------------------------------------------------------

describe('src/ecosystem/cli.ts offline CLI wrappers & parsers', () => {
  test('lists, toggles, adds, and removes MCP servers via injected execCommand', async () => {
    const calls: string[][] = [];
    const execCommand: ExecCommandFn = async (cmd) => {
      calls.push([...cmd]);
      if (cmd[1] === 'mcp' && cmd[2] === 'list') {
        return {
          exitCode: 0,
          stdout: [
            '✓ filesystem (stdio, enabled) - npx -y @modelcontextprotocol/server-filesystem /work',
            '✗ github (disabled) - https://api.github.com/mcp',
          ].join('\n'),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: 'ok\n', stderr: '' };
    };

    const listed = await listMcpServers('/usr/bin/agy', { execCommand });
    expect(listed.ok).toBe(true);
    expect(listed.servers).toEqual([
      {
        name: 'filesystem',
        enabled: true,
        transport: 'stdio',
        target: 'npx -y @modelcontextprotocol/server-filesystem /work',
        status: 'enabled',
        detail: 'npx -y @modelcontextprotocol/server-filesystem /work',
      },
      {
        name: 'github',
        enabled: false,
        transport: 'http',
        target: 'https://api.github.com/mcp',
        status: 'disabled',
        detail: 'https://api.github.com/mcp',
      },
    ]);

    const toggled = await setMcpServerEnabled('/usr/bin/agy', 'github', true, { execCommand });
    expect(toggled.ok).toBe(true);

    const added = await addMcpServer(
      '/usr/bin/agy',
      {
        name: 'fs',
        commandOrUrl: 'npx',
        args: ['-y', '@mcp/fs', '/work'],
        type: 'stdio',
        env: { NODE_ENV: 'production' },
      },
      { execCommand },
    );
    expect(added.ok).toBe(true);

    const removed = await removeMcpServer('/usr/bin/agy', 'fs', { execCommand });
    expect(removed.ok).toBe(true);

    expect(calls).toEqual([
      ['/usr/bin/agy', 'mcp', 'list'],
      ['/usr/bin/agy', 'mcp', 'enable', 'github'],
      [
        '/usr/bin/agy',
        'mcp',
        'add',
        '--type',
        'stdio',
        '--env',
        'NODE_ENV=production',
        'fs',
        '--',
        'npx',
        '-y',
        '@mcp/fs',
        '/work',
      ],
      ['/usr/bin/agy', 'mcp', 'remove', 'fs'],
    ]);

    expect(parseMcpListOutput('No MCP servers configured.\n')).toEqual([]);
  });

  test('lists and toggles plugins via agy plugin list --json', async () => {
    const calls: string[][] = [];
    const execCommand: ExecCommandFn = async (cmd) => {
      calls.push([...cmd]);
      if (cmd[2] === 'list') {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              name: 'code-review',
              version: '1.2.0',
              description: 'Automated PR review',
              enabled: true,
            },
            {
              name: 'legacy-pack',
              version: '0.9.0',
              disabled: true,
            },
          ]),
          stderr: '',
        };
      }
      return { exitCode: 0, stdout: 'disabled\n', stderr: '' };
    };

    const res = await listPlugins('agy', { execCommand });
    expect(res.ok).toBe(true);
    expect(res.plugins).toEqual([
      {
        name: 'code-review',
        version: '1.2.0',
        description: 'Automated PR review',
        enabled: true,
        source: undefined,
        path: undefined,
      },
      {
        name: 'legacy-pack',
        version: '0.9.0',
        description: undefined,
        enabled: false,
        source: undefined,
        path: undefined,
      },
    ]);

    const toggled = await setPluginEnabled('agy', 'code-review', false, { execCommand });
    expect(toggled.ok).toBe(true);
    expect(calls).toEqual([
      ['agy', 'plugin', 'list', '--json'],
      ['agy', 'plugin', 'disable', 'code-review'],
    ]);

    expect(parsePluginsJsonOutput('[]')).toEqual([]);
  });

  test('lists agents from text or JSON output', async () => {
    const execCommand: ExecCommandFn = async () => ({
      exitCode: 0,
      stdout: [
        'Available agents:',
        '  reviewer   Reviews pull requests and diffs',
        '  planner (workspace) - Architectural planning agent',
      ].join('\n'),
      stderr: '',
    });

    const res = await listAgents('agy', { execCommand });
    expect(res.ok).toBe(true);
    expect(res.agents).toEqual([
      { name: 'reviewer', description: 'Reviews pull requests and diffs', source: undefined },
      { name: 'planner', description: 'Architectural planning agent', source: 'workspace' },
    ]);

    expect(parseAgentsOutput('')).toEqual([]);
  });

  test('scanLocalSkills merges workspace, global SKILL.md files and ACP commands by priority', async () => {
    const root = await makeTempDir('oma-skills-');
    const workspaceDir = join(root, 'repo');
    const fakeHome = join(root, 'home');

    // Workspace skill (also shadows global skill with same name)
    const wsSkillDir = join(workspaceDir, '.agents', 'skills', 'deploy-helper');
    await mkdir(wsSkillDir, { recursive: true });
    await writeFile(
      join(wsSkillDir, 'SKILL.md'),
      [
        '---',
        'name: deploy-helper',
        'description: Workspace deploy checklist',
        '---',
        '# Deploy Helper',
        '',
        'Run build and verify artifacts.',
      ].join('\n'),
      'utf8',
    );

    // Global skill (shadowed) + unique global skill
    const globalShadowDir = join(fakeHome, '.gemini', 'config', 'skills', 'deploy-helper');
    const globalOnlyDir = join(fakeHome, '.gemini', 'config', 'skills', 'rust-audit');
    await mkdir(globalShadowDir, { recursive: true });
    await mkdir(globalOnlyDir, { recursive: true });
    await writeFile(
      join(globalShadowDir, 'SKILL.md'),
      '---\nname: deploy-helper\ndescription: Global version\n---\nGlobal body',
      'utf8',
    );
    await writeFile(
      join(globalOnlyDir, 'SKILL.md'),
      '# Rust Audit\n\nInspect unsafe blocks carefully.',
      'utf8',
    );

    const skills = await scanLocalSkills(
      workspaceDir,
      [
        { name: 'deploy-helper', description: 'ACP description', input: { hint: '<env>' } },
        { name: 'run-workflow', description: 'Run Python workflow script' },
      ],
      { homedir: fakeHome },
    );

    expect(skills.map((s) => `${s.source}:${s.name}`)).toEqual([
      'workspace:deploy-helper',
      'global:rust-audit',
      'acp:run-workflow',
    ]);
    expect(skills[0]?.description).toBe('Workspace deploy checklist');
    expect(skills[0]?.inputHint).toBe('<env>');
    expect(skills[0]?.preview).toContain('Run build and verify artifacts.');
    expect(skills[1]?.description).toBe('Inspect unsafe blocks carefully.');
    expect(skills[2]?.filePath).toBeUndefined();
  });

  test('exportTranscriptMarkdown renders full Markdown and writes atomically to default or custom path', async () => {
    const dir = await makeTempDir('oma-export-');
    const turns: ExportableTurn[] = [
      {
        index: 0,
        user: {
          text: 'Inspect `src/index.ts` please.',
          timeLabel: '14:20',
          attachments: [{ kind: 'file', name: 'index.ts', path: 'src/index.ts' }],
        },
        timeline: [
          { kind: 'thought', id: 'th-1' },
          { kind: 'tool', id: 'tc-1' },
          { kind: 'assistant', id: 'as-1' },
          { kind: 'notice', id: 'nt-1' },
        ],
        thoughts: [{ id: 'th-1', text: 'Need to read the file first.', tookMs: 1250 }],
        toolCalls: [
          {
            toolCallId: 'tc-1',
            displayName: 'bash',
            title: 'bun test',
            status: 'done',
            exitCode: 0,
            outputText: '```nested fence```\n12 pass',
            diffs: [{ path: 'src/index.ts', patchText: '+export const ok = true;' }],
          },
        ],
        assistantSegments: [{ id: 'as-1', text: 'All tests passed!' }],
        notices: [{ id: 'nt-1', kind: 'compaction', text: 'Compacted 4 turns.' }],
        assistantText: 'All tests passed!',
        status: 'done',
      },
    ];

    const md = formatTranscriptMarkdown(turns, {
      sessionId: 'sess-exp-1',
      title: 'Fix Cursor & Export',
      model: 'gemini-4-neon',
      thoughtLevel: 'high',
      mode: 'default',
      cwd: dir,
      exportedAt: '2026-11-21T01:30:00.000Z',
    });

    expect(md).toContain('# Fix Cursor & Export');
    expect(md).toContain('`sess-exp-1`');
    expect(md).toContain('Thinking (1.3s)');
    expect(md).toContain('````text'); // fence expanded beyond triple backtick
    expect(md).toContain('All tests passed!');
    expect(md).toContain('> **Compaction**: Compacted 4 turns.');

    // 1. Default path under <dataDir>/exports/<slug>.md
    const defaultExport = await exportTranscriptMarkdown(turns, {
      sessionId: 'sess-exp-1',
      title: 'Fix Cursor & Export',
      dataDir: dir,
      exportedAt: '2026-11-21T01:30:00.000Z',
    });
    expect(defaultExport.path.startsWith(join(dir, 'exports'))).toBe(true);
    expect(defaultExport.path.endsWith('.md')).toBe(true);
    expect(defaultExport.turnCount).toBe(1);
    expect(await readFile(defaultExport.path, 'utf8')).toBe(defaultExport.markdown);

    // 2. Explicit relative path resolved against meta.cwd
    const customExport = await exportTranscriptMarkdown(
      turns,
      { cwd: dir, title: 'Custom' },
      'out/transcript.md',
    );
    expect(customExport.path).toBe(join(dir, 'out', 'transcript.md'));
    expect(await readdir(join(dir, 'out'))).toEqual(['transcript.md']);
  });
});
