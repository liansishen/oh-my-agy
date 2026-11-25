import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AvailableCommand } from '../acp/protocol.ts';
import { getDataDir } from '../preview/store.ts';

// ---------------------------------------------------------------------------
// Subprocess execution abstraction (supports offline injection in tests)
// ---------------------------------------------------------------------------

export interface ExecCommandOptions {
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
}

export interface ExecCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type ExecCommandFn = (
  cmd: readonly string[],
  options?: ExecCommandOptions,
) => Promise<ExecCommandResult>;

export interface EcosystemCliOptions {
  readonly execCommand?: ExecCommandFn;
  readonly cwd?: string;
  readonly env?: Record<string, string | undefined>;
  readonly timeoutMs?: number;
}

const DEFAULT_EXEC_TIMEOUT_MS = 10_000;

export async function defaultExecCommand(
  cmd: readonly string[],
  options: ExecCommandOptions = {},
): Promise<ExecCommandResult> {
  if (cmd.length === 0) {
    return { exitCode: 1, stdout: '', stderr: 'Empty command' };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([...cmd], {
      cwd: options.cwd,
      env: options.env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { exitCode: 127, stdout: '', stderr: message };
  }

  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {
            // already exited
          }
        }, timeoutMs)
      : undefined;

  try {
    const stdoutPromise =
      proc.stdout && typeof proc.stdout !== 'number'
        ? new Response(proc.stdout).text()
        : Promise.resolve('');
    const stderrPromise =
      proc.stderr && typeof proc.stderr !== 'number'
        ? new Response(proc.stderr).text()
        : Promise.resolve('');

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      stdoutPromise,
      stderrPromise,
    ]);

    if (timedOut) {
      return {
        exitCode: 124,
        stdout,
        stderr: stderr
          ? `${stderr}\nCommand timed out after ${timeoutMs}ms`
          : `Command timed out after ${timeoutMs}ms`,
      };
    }

    return { exitCode, stdout, stderr };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveBin(agyBin?: string): string {
  const trimmed = agyBin?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : 'agy';
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

// ---------------------------------------------------------------------------
// MCP Servers (`agy mcp list/enable/disable/add/remove`)
// ---------------------------------------------------------------------------

export interface McpServerItem {
  readonly name: string;
  readonly enabled: boolean;
  readonly transport?: 'stdio' | 'http' | 'sse' | (string & {});
  readonly target?: string;
  readonly status?: string;
  readonly detail?: string;
}

export interface ListMcpServersResult {
  readonly ok: boolean;
  readonly servers: McpServerItem[];
  readonly rawOutput: string;
  readonly error?: string;
}

export interface EcosystemActionResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface AddMcpServerInput {
  readonly name: string;
  readonly commandOrUrl: string;
  readonly args?: readonly string[];
  readonly type?: 'stdio' | 'http';
  readonly env?: Readonly<Record<string, string>> | readonly string[];
  readonly headers?: Readonly<Record<string, string>> | readonly string[];
}

function inferTransportFromTarget(target?: string): 'stdio' | 'http' | undefined {
  if (!target) return undefined;
  if (/^https?:\/\//i.test(target.trim())) return 'http';
  return 'stdio';
}

function normalizeMcpObject(nameFallback: string, obj: Record<string, unknown>): McpServerItem | null {
  const rawName = typeof obj['name'] === 'string' && obj['name'].trim() ? obj['name'].trim() : nameFallback;
  if (!rawName) return null;

  let enabled = true;
  if (typeof obj['enabled'] === 'boolean') {
    enabled = obj['enabled'];
  } else if (typeof obj['disabled'] === 'boolean') {
    enabled = !obj['disabled'];
  } else if (typeof obj['status'] === 'string') {
    enabled = !/disabled|off|inactive/i.test(obj['status']);
  }

  const url = typeof obj['url'] === 'string' ? obj['url'].trim() : undefined;
  const command = typeof obj['command'] === 'string' ? obj['command'].trim() : undefined;
  const args = Array.isArray(obj['args'])
    ? obj['args'].filter((a): a is string => typeof a === 'string')
    : [];
  const target =
    url ||
    (command ? [command, ...args].join(' ') : undefined) ||
    (typeof obj['target'] === 'string' ? obj['target'].trim() : undefined);

  const rawType = typeof obj['type'] === 'string' ? obj['type'].trim() : undefined;
  const transport = rawType || inferTransportFromTarget(target);
  const status =
    typeof obj['status'] === 'string'
      ? obj['status'].trim()
      : enabled
        ? 'enabled'
        : 'disabled';
  const detail =
    typeof obj['detail'] === 'string'
      ? obj['detail'].trim()
      : typeof obj['description'] === 'string'
        ? obj['description'].trim()
        : target;

  return {
    name: rawName,
    enabled,
    transport,
    target,
    status,
    detail,
  };
}

/**
 * Parses `agy mcp list` stdout across JSON, tabular, bulleted, and plain-text formats.
 */
export function parseMcpListOutput(stdout: string): McpServerItem[] {
  const clean = stripAnsi(stdout).trim();
  if (clean.length === 0 || /^no mcp servers configured\.?$/i.test(clean)) {
    return [];
  }

  // 1. JSON array or map
  if (clean.startsWith('[') || clean.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(clean);
      if (Array.isArray(parsed)) {
        const items: McpServerItem[] = [];
        for (const entry of parsed) {
          if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
            const item = normalizeMcpObject('', entry as Record<string, unknown>);
            if (item) items.push(item);
          }
        }
        return items;
      }
      if (typeof parsed === 'object' && parsed !== null) {
        const rec = parsed as Record<string, unknown>;
        if (Array.isArray(rec['servers'])) {
          return parseMcpListOutput(JSON.stringify(rec['servers']));
        }
        const items: McpServerItem[] = [];
        for (const [k, v] of Object.entries(rec)) {
          if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
            const item = normalizeMcpObject(k, v as Record<string, unknown>);
            if (item) items.push(item);
          }
        }
        return items;
      }
    } catch {
      // Fall through to text line parser
    }
  }

  // 2. Text / table output
  const lines = clean.split(/\r?\n/);
  const servers: McpServerItem[] = [];
  const seen = new Set<string>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (/^[-─═]+$/.test(line)) continue;
    if (/^(name|server)\s+(type|transport|status|command|url)/i.test(line)) continue;
    if (/^configured mcp servers:?$/i.test(line)) continue;
    if (/^no mcp servers/i.test(line)) continue;

    // Strip leading status glyphs / bullets
    let rest = line;
    let enabledHint: boolean | undefined;
    const glyphMatch = /^([✓✔●◉✓]|[✗✘×○◯]|[-*•])\s+(.+)$/.exec(rest);
    if (glyphMatch) {
      const glyph = glyphMatch[1]!;
      rest = glyphMatch[2]!.trim();
      if (/[✗✘×○◯]/.test(glyph)) enabledHint = false;
      else if (/[✓✔●◉]/.test(glyph)) enabledHint = true;
    }

    let name = '';
    let detail = '';
    let status: string | undefined;
    let transport: string | undefined;

    // Pattern A: `name (disabled) - cmd` or `name [enabled]: cmd`
    const annotatedMatch =
      /^([A-Za-z0-9._/@-]+)\s*(?:\(([^)]+)\)|\[([^\]]+)\])?\s*(?:[:—–-]\s*(.*))?$/.exec(
        rest,
      );
    // Pattern B: multi-space tabular columns `name   stdio   enabled   npx ...`
    const colParts = rest.split(/\s{2,}/).map((p) => p.trim()).filter(Boolean);

    if (colParts.length >= 2 && !rest.includes(': ')) {
      name = colParts[0]!;
      const tailCols = colParts.slice(1);
      const targetParts: string[] = [];
      for (const col of tailCols) {
        if (/^(enabled|disabled|active|inactive|connected|disconnected|error)$/i.test(col)) {
          status = col.toLowerCase();
          enabledHint = !/^(disabled|inactive)$/i.test(col);
        } else if (/^(stdio|http|sse)$/i.test(col)) {
          transport = col.toLowerCase();
        } else {
          targetParts.push(col);
        }
      }
      detail = targetParts.join(' ');
    } else if (annotatedMatch) {
      name = annotatedMatch[1]!;
      const tag = (annotatedMatch[2] ?? annotatedMatch[3] ?? '').trim();
      detail = (annotatedMatch[4] ?? '').trim();
      if (tag) {
        for (const token of tag.split(/[,/\s]+/).filter(Boolean)) {
          if (/^(enabled|disabled|active|inactive|connected|disconnected)$/i.test(token)) {
            status = token.toLowerCase();
            enabledHint = !/^(disabled|inactive)$/i.test(token);
          } else if (/^(stdio|http|sse)$/i.test(token)) {
            transport = token.toLowerCase();
          }
        }
      }
    } else {
      const firstSpace = rest.indexOf(' ');
      if (firstSpace === -1) {
        name = rest;
      } else {
        name = rest.slice(0, firstSpace);
        detail = rest.slice(firstSpace + 1).trim();
      }
    }

    if (!name || seen.has(name)) continue;
    seen.add(name);

    const disabledInDetail = /\bdisabled\b/i.test(detail);
    const enabled = enabledHint ?? !disabledInDetail;
    const resolvedTransport = transport ?? inferTransportFromTarget(detail);

    servers.push({
      name,
      enabled,
      transport: resolvedTransport,
      target: detail || undefined,
      status: status ?? (enabled ? 'enabled' : 'disabled'),
      detail: detail || undefined,
    });
  }

  return servers;
}

export async function listMcpServers(
  agyBin?: string,
  options: EcosystemCliOptions = {},
): Promise<ListMcpServersResult> {
  const exec = options.execCommand ?? defaultExecCommand;
  const bin = resolveBin(agyBin);
  const res = await exec([bin, 'mcp', 'list'], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });

  if (res.exitCode !== 0) {
    return {
      ok: false,
      servers: [],
      rawOutput: res.stdout,
      error: res.stderr.trim() || res.stdout.trim() || `agy mcp list exited with code ${res.exitCode}`,
    };
  }

  return {
    ok: true,
    servers: parseMcpListOutput(res.stdout),
    rawOutput: res.stdout,
  };
}

export async function setMcpServerEnabled(
  agyBin: string | undefined,
  name: string,
  enabled: boolean,
  options: EcosystemCliOptions = {},
): Promise<EcosystemActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'MCP server name is required',
      error: 'MCP server name is required',
    };
  }
  const exec = options.execCommand ?? defaultExecCommand;
  const bin = resolveBin(agyBin);
  const sub = enabled ? 'enable' : 'disable';
  const res = await exec([bin, 'mcp', sub, trimmedName], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });

  return {
    ok: res.exitCode === 0,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    error:
      res.exitCode === 0
        ? undefined
        : res.stderr.trim() || res.stdout.trim() || `agy mcp ${sub} failed (${res.exitCode})`,
  };
}

export async function addMcpServer(
  agyBin: string | undefined,
  input: AddMcpServerInput,
  options: EcosystemCliOptions = {},
): Promise<EcosystemActionResult> {
  const name = input.name.trim();
  const commandOrUrl = input.commandOrUrl.trim();
  if (!name || !commandOrUrl) {
    const error = 'MCP server name and commandOrUrl are required';
    return { ok: false, exitCode: 1, stdout: '', stderr: error, error };
  }

  const bin = resolveBin(agyBin);
  // Flags MUST come before <name> per `agy mcp add --help`
  const cmd: string[] = [bin, 'mcp', 'add'];
  if (input.type) {
    cmd.push('--type', input.type);
  }
  if (input.env) {
    if (Array.isArray(input.env)) {
      for (const pair of input.env) {
        if (pair.trim()) cmd.push('--env', pair.trim());
      }
    } else {
      for (const [k, v] of Object.entries(input.env)) {
        if (k.trim()) cmd.push('--env', `${k.trim()}=${v}`);
      }
    }
  }
  if (input.headers) {
    if (Array.isArray(input.headers)) {
      for (const h of input.headers) {
        if (h.trim()) cmd.push('--header', h.trim());
      }
    } else {
      for (const [k, v] of Object.entries(input.headers)) {
        if (k.trim()) cmd.push('--header', `${k.trim()}: ${v}`);
      }
    }
  }

  cmd.push(name);
  const args = input.args ?? [];
  const needsDoubleDash =
    commandOrUrl.startsWith('-') || args.some((a) => a.startsWith('-'));
  if (needsDoubleDash) {
    cmd.push('--');
  }
  cmd.push(commandOrUrl, ...args);

  const exec = options.execCommand ?? defaultExecCommand;
  const res = await exec(cmd, {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });

  return {
    ok: res.exitCode === 0,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    error:
      res.exitCode === 0
        ? undefined
        : res.stderr.trim() || res.stdout.trim() || `agy mcp add failed (${res.exitCode})`,
  };
}

export async function removeMcpServer(
  agyBin: string | undefined,
  name: string,
  options: EcosystemCliOptions = {},
): Promise<EcosystemActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'MCP server name is required',
      error: 'MCP server name is required',
    };
  }
  const exec = options.execCommand ?? defaultExecCommand;
  const bin = resolveBin(agyBin);
  const res = await exec([bin, 'mcp', 'remove', trimmedName], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });

  return {
    ok: res.exitCode === 0,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    error:
      res.exitCode === 0
        ? undefined
        : res.stderr.trim() || res.stdout.trim() || `agy mcp remove failed (${res.exitCode})`,
  };
}

// ---------------------------------------------------------------------------
// Plugins (`agy plugin list --json` / `enable` / `disable`)
// ---------------------------------------------------------------------------

export interface PluginItem {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  readonly enabled: boolean;
  readonly source?: string;
  readonly path?: string;
}

export interface ListPluginsResult {
  readonly ok: boolean;
  readonly plugins: PluginItem[];
  readonly rawOutput: string;
  readonly error?: string;
}

function normalizePluginEntry(entry: unknown, fallbackName = ''): PluginItem | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return null;
  }
  const rec = entry as Record<string, unknown>;
  const name =
    (typeof rec['name'] === 'string' && rec['name'].trim()) ||
    (typeof rec['id'] === 'string' && rec['id'].trim()) ||
    fallbackName;
  if (!name) return null;

  let enabled = true;
  if (typeof rec['enabled'] === 'boolean') {
    enabled = rec['enabled'];
  } else if (typeof rec['disabled'] === 'boolean') {
    enabled = !rec['disabled'];
  } else if (typeof rec['status'] === 'string') {
    enabled = !/disabled|off|inactive/i.test(rec['status']);
  }

  const version = typeof rec['version'] === 'string' ? rec['version'].trim() || undefined : undefined;
  const description =
    typeof rec['description'] === 'string' ? rec['description'].trim() || undefined : undefined;
  const source =
    typeof rec['source'] === 'string'
      ? rec['source'].trim() || undefined
      : typeof rec['marketplace'] === 'string'
        ? rec['marketplace'].trim() || undefined
        : undefined;
  const path =
    typeof rec['path'] === 'string'
      ? rec['path'].trim() || undefined
      : typeof rec['dir'] === 'string'
        ? rec['dir'].trim() || undefined
        : undefined;

  return { name, version, description, enabled, source, path };
}

export function parsePluginsJsonOutput(stdout: string): PluginItem[] {
  const clean = stripAnsi(stdout).trim();
  if (clean.length === 0) return [];
  const parsed: unknown = JSON.parse(clean);
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => normalizePluginEntry(item))
      .filter((item): item is PluginItem => item !== null);
  }
  if (typeof parsed === 'object' && parsed !== null) {
    const rec = parsed as Record<string, unknown>;
    if (Array.isArray(rec['plugins'])) {
      return rec['plugins']
        .map((item) => normalizePluginEntry(item))
        .filter((item): item is PluginItem => item !== null);
    }
    const items: PluginItem[] = [];
    for (const [k, v] of Object.entries(rec)) {
      const normalized = normalizePluginEntry(v, k);
      if (normalized) items.push(normalized);
    }
    return items;
  }
  return [];
}

export async function listPlugins(
  agyBin?: string,
  options: EcosystemCliOptions = {},
): Promise<ListPluginsResult> {
  const exec = options.execCommand ?? defaultExecCommand;
  const bin = resolveBin(agyBin);
  const res = await exec([bin, 'plugin', 'list', '--json'], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });

  if (res.exitCode !== 0) {
    return {
      ok: false,
      plugins: [],
      rawOutput: res.stdout,
      error:
        res.stderr.trim() ||
        res.stdout.trim() ||
        `agy plugin list --json exited with code ${res.exitCode}`,
    };
  }

  try {
    return {
      ok: true,
      plugins: parsePluginsJsonOutput(res.stdout),
      rawOutput: res.stdout,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      plugins: [],
      rawOutput: res.stdout,
      error: `Failed to parse agy plugin list --json: ${message}`,
    };
  }
}

export async function setPluginEnabled(
  agyBin: string | undefined,
  name: string,
  enabled: boolean,
  options: EcosystemCliOptions = {},
): Promise<EcosystemActionResult> {
  const trimmedName = name.trim();
  if (!trimmedName) {
    return {
      ok: false,
      exitCode: 1,
      stdout: '',
      stderr: 'Plugin name is required',
      error: 'Plugin name is required',
    };
  }
  const exec = options.execCommand ?? defaultExecCommand;
  const bin = resolveBin(agyBin);
  const sub = enabled ? 'enable' : 'disable';
  const res = await exec([bin, 'plugin', sub, trimmedName], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });

  return {
    ok: res.exitCode === 0,
    exitCode: res.exitCode,
    stdout: res.stdout,
    stderr: res.stderr,
    error:
      res.exitCode === 0
        ? undefined
        : res.stderr.trim() || res.stdout.trim() || `agy plugin ${sub} failed (${res.exitCode})`,
  };
}

// ---------------------------------------------------------------------------
// Agents (`agy agent`)
// ---------------------------------------------------------------------------

export interface AgentItem {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
  readonly detail?: string;
}

export interface ListAgentsResult {
  readonly ok: boolean;
  readonly agents: AgentItem[];
  readonly rawOutput: string;
  readonly error?: string;
}

export function parseAgentsOutput(stdout: string): AgentItem[] {
  const clean = stripAnsi(stdout).trim();
  if (clean.length === 0 || /^no (custom )?agents/i.test(clean)) {
    return [];
  }

  if (clean.startsWith('[') || clean.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(clean);
      const list = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { agents?: unknown }).agents)
          ? ((parsed as { agents: unknown[] }).agents)
          : null;
      if (list) {
        const out: AgentItem[] = [];
        for (const item of list) {
          if (typeof item === 'string' && item.trim()) {
            out.push({ name: item.trim() });
          } else if (typeof item === 'object' && item !== null) {
            const rec = item as Record<string, unknown>;
            const name = typeof rec['name'] === 'string' ? rec['name'].trim() : '';
            if (!name) continue;
            out.push({
              name,
              description:
                typeof rec['description'] === 'string' ? rec['description'].trim() : undefined,
              source: typeof rec['source'] === 'string' ? rec['source'].trim() : undefined,
              detail: typeof rec['path'] === 'string' ? rec['path'].trim() : undefined,
            });
          }
        }
        return out;
      }
    } catch {
      // Fall through to text parser
    }
  }

  const agents: AgentItem[] = [];
  const seen = new Set<string>();
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (/^[-─═]+$/.test(line)) continue;
    if (/^(available agents|agents):?$/i.test(line)) continue;
    if (/^name\s+description/i.test(line)) continue;

    const withoutBullet = line.replace(/^[-*•]\s+/, '').trim();
    let name = '';
    let description: string | undefined;
    let source: string | undefined;

    const cols = withoutBullet.split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 2) {
      name = cols[0]!;
      description = cols.slice(1).join(' · ');
    } else {
      const sepMatch = /^([A-Za-z0-9._/@-]+)(?:\s+\(([^)]+)\))?\s*(?:[:—–-]\s*(.*))?$/.exec(
        withoutBullet,
      );
      if (sepMatch) {
        name = sepMatch[1]!;
        source = sepMatch[2]?.trim() || undefined;
        description = sepMatch[3]?.trim() || undefined;
      } else {
        name = withoutBullet;
      }
    }

    if (!name || seen.has(name)) continue;
    seen.add(name);
    agents.push({ name, description, source });
  }

  return agents;
}

export async function listAgents(
  agyBin?: string,
  options: EcosystemCliOptions = {},
): Promise<ListAgentsResult> {
  const exec = options.execCommand ?? defaultExecCommand;
  const bin = resolveBin(agyBin);
  const res = await exec([bin, 'agent'], {
    cwd: options.cwd,
    env: options.env,
    timeoutMs: options.timeoutMs,
  });

  if (res.exitCode !== 0) {
    return {
      ok: false,
      agents: [],
      rawOutput: res.stdout,
      error: res.stderr.trim() || res.stdout.trim() || `agy agent exited with code ${res.exitCode}`,
    };
  }

  return {
    ok: true,
    agents: parseAgentsOutput(res.stdout),
    rawOutput: res.stdout,
  };
}

// ---------------------------------------------------------------------------
// Local & ACP Skills (`scanLocalSkills`)
// ---------------------------------------------------------------------------

export type SkillSource = 'workspace' | 'global' | 'acp';

export interface SkillItem {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  readonly filePath?: string;
  readonly content?: string;
  readonly preview?: string;
  readonly inputHint?: string;
}

export interface ScanLocalSkillsOptions {
  readonly homedir?: string;
  readonly maxPreviewChars?: number;
  readonly workspaceSkillsDir?: string;
  readonly globalSkillsDir?: string;
  readonly agentsGlobalSkillsDir?: string;
}

interface ParsedSkillFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly body: string;
}

function unquoteYamlValue(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseSkillMarkdown(rawText: string): ParsedSkillFrontmatter {
  const normalized = rawText.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { body: normalized.trim() };
  }
  const endIdx = normalized.indexOf('\n---', 4);
  if (endIdx === -1) {
    return { body: normalized.trim() };
  }

  const headerBlock = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 4).replace(/^\n+/, '').trim();
  let name: string | undefined;
  let description: string | undefined;

  for (const line of headerBlock.split('\n')) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const val = unquoteYamlValue(match[2]!);
    if (!val) continue;
    if (key === 'name' && !name) name = val;
    if (key === 'description' && !description) description = val;
  }

  return { name, description, body };
}

function extractFirstSummaryLine(body: string): string {
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('```')) continue;
    return line.length > 140 ? `${line.slice(0, 139)}…` : line;
  }
  return '';
}

async function scanSkillsDirectory(
  rootDir: string,
  source: 'workspace' | 'global',
  maxPreviewChars: number,
): Promise<SkillItem[]> {
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: SkillItem[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const skillFile = join(rootDir, entry.name, 'SKILL.md');
    let content: string;
    try {
      content = await readFile(skillFile, 'utf8');
    } catch {
      continue;
    }

    const parsed = parseSkillMarkdown(content);
    const name = parsed.name || entry.name;
    const description = parsed.description || extractFirstSummaryLine(parsed.body) || `${source} skill`;
    const previewSource = parsed.body || content.trim();
    const preview =
      previewSource.length > maxPreviewChars
        ? `${previewSource.slice(0, maxPreviewChars - 1)}…`
        : previewSource;

    results.push({
      name,
      description,
      source,
      filePath: skillFile,
      content,
      preview,
    });
  }

  return results;
}

const SOURCE_PRIORITY: Record<SkillSource, number> = {
  workspace: 0,
  global: 1,
  acp: 2,
};

/**
 * Merges ACP `available_commands_update` commands with read-only local skills from
 * `<cwd>/.agents/skills/<name>/SKILL.md`, `~/.gemini/config/skills/<name>/SKILL.md`,
 * and `~/.agents/skills/<name>/SKILL.md`.
 */
export async function scanLocalSkills(
  cwd: string,
  acpCommands: readonly AvailableCommand[] = [],
  options: ScanLocalSkillsOptions = {},
): Promise<SkillItem[]> {
  const home = options.homedir ?? osHomedir();
  const maxPreviewChars = options.maxPreviewChars ?? 4000;
  const workspaceDir = options.workspaceSkillsDir ?? join(cwd, '.agents', 'skills');
  const globalDir = options.globalSkillsDir ?? join(home, '.gemini', 'config', 'skills');
  const agentsGlobalDir =
    options.agentsGlobalSkillsDir ??
    (options.globalSkillsDir !== undefined && options.homedir === undefined
      ? undefined
      : join(home, '.agents', 'skills'));

  const [workspaceSkills, globalSkills, agentsGlobalSkills] = await Promise.all([
    scanSkillsDirectory(workspaceDir, 'workspace', maxPreviewChars),
    scanSkillsDirectory(globalDir, 'global', maxPreviewChars),
    agentsGlobalDir
      ? scanSkillsDirectory(agentsGlobalDir, 'global', maxPreviewChars)
      : Promise.resolve([]),
  ]);

  const byName = new Map<string, SkillItem>();

  // Priority: workspace > ~/.gemini/config/skills > ~/.agents/skills > acp
  for (const item of [...workspaceSkills, ...globalSkills, ...agentsGlobalSkills]) {
    const key = item.name.toLowerCase();
    if (!byName.has(key)) {
      byName.set(key, item);
    }
  }

  for (const cmd of acpCommands) {
    const rawName = cmd.name?.trim().replace(/^\//, '');
    if (!rawName) continue;
    const key = rawName.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      byName.set(key, {
        ...existing,
        description: existing.description || cmd.description?.trim() || '',
        inputHint: existing.inputHint ?? cmd.input?.hint,
      });
    } else {
      byName.set(key, {
        name: rawName,
        description: cmd.description?.trim() || '',
        source: 'acp',
        inputHint: cmd.input?.hint,
      });
    }
  }

  return Array.from(byName.values()).sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source];
    const pb = SOURCE_PRIORITY[b.source];
    if (pa !== pb) return pa - pb;
    return a.name.localeCompare(b.name);
  });
}

// ---------------------------------------------------------------------------
// Transcript Markdown Export (`exportTranscriptMarkdown`)
// ---------------------------------------------------------------------------

export interface ExportableAttachment {
  readonly kind: 'image' | 'file';
  readonly name: string;
  readonly path?: string;
}

export interface ExportableUserMessage {
  readonly text: string;
  readonly timestamp?: number;
  readonly timeLabel?: string;
  readonly attachments?: readonly ExportableAttachment[];
}

export interface ExportableThought {
  readonly id: string;
  readonly text: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly tookMs?: number;
}

export interface ExportableToolDiff {
  readonly path: string;
  readonly oldText?: string | null;
  readonly newText?: string;
  readonly patchText?: string;
}

export interface ExportableToolCall {
  readonly toolCallId: string;
  readonly displayName?: string;
  readonly rawName?: string;
  readonly title?: string;
  readonly target?: string;
  readonly status?: string;
  readonly exitCode?: number;
  readonly outputText?: string;
  readonly diffs?: readonly ExportableToolDiff[];
}

export interface ExportableAssistantSegment {
  readonly id: string;
  readonly text: string;
}

export interface ExportableNotice {
  readonly id: string;
  readonly kind?: string;
  readonly level?: string;
  readonly text?: string;
  readonly summaryText?: string;
}

export interface ExportableTimelineRef {
  readonly kind: 'thought' | 'tool' | 'assistant' | 'notice';
  readonly id: string;
}

export interface ExportableTurn {
  readonly index?: number;
  readonly user?: ExportableUserMessage;
  readonly timeline?: readonly ExportableTimelineRef[];
  readonly thoughts?: readonly ExportableThought[];
  readonly toolCalls?: readonly ExportableToolCall[];
  readonly assistantSegments?: readonly ExportableAssistantSegment[];
  readonly notices?: readonly ExportableNotice[];
  readonly assistantText?: string;
  readonly status?: string;
  readonly errorMessage?: string;
  readonly startedAt?: number;
  readonly endedAt?: number;
}

export interface ExportTranscriptMeta {
  readonly sessionId?: string | null;
  readonly title?: string | null;
  readonly cwd?: string;
  readonly model?: string | null;
  readonly thoughtLevel?: string | null;
  readonly mode?: string | null;
  readonly exportedAt?: Date | string | number;
  readonly dataDir?: string;
}

export interface ExportTranscriptResult {
  readonly path: string;
  readonly markdown: string;
  readonly turnCount: number;
  readonly byteLength: number;
}

function formatExportTimestamp(input?: Date | string | number): string {
  const date =
    input instanceof Date
      ? input
      : typeof input === 'number' || typeof input === 'string'
        ? new Date(input)
        : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function slugifyFilename(raw: string): string {
  const cleaned = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9\u4e00-\u9fff_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return cleaned || 'session';
}

function chooseFence(content: string): string {
  let maxTicks = 2;
  const matches = content.match(/`+/g);
  if (matches) {
    for (const m of matches) {
      if (m.length > maxTicks) maxTicks = m.length;
    }
  }
  return '`'.repeat(maxTicks + 1);
}

function renderThoughtMd(thought: ExportableThought): string {
  const text = thought.text.trim();
  if (!text) return '';
  const ms =
    typeof thought.tookMs === 'number'
      ? thought.tookMs
      : thought.startedAt && thought.endedAt && thought.endedAt >= thought.startedAt
        ? thought.endedAt - thought.startedAt
        : undefined;
  const durationLabel =
    ms !== undefined ? ` (${ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`})` : '';
  return `<details>\n<summary>Thinking${durationLabel}</summary>\n\n${text}\n\n</details>`;
}

function renderToolCallMd(tool: ExportableToolCall): string {
  const label = tool.displayName || tool.rawName || 'tool';
  const titlePart = tool.title ? ` — ${tool.title}` : tool.target ? ` — ${tool.target}` : '';
  const statusMeta: string[] = [];
  if (tool.status) statusMeta.push(`status: ${tool.status}`);
  if (tool.exitCode !== undefined) statusMeta.push(`exit: ${tool.exitCode}`);

  const lines: string[] = [`#### Tool: \`${label}\`${titlePart}`];
  if (statusMeta.length > 0) {
    lines.push(`_${statusMeta.join(' · ')}_`);
  }

  const output = tool.outputText?.trim();
  if (output) {
    const fence = chooseFence(output);
    lines.push('', `${fence}text`, output, fence);
  }

  if (tool.diffs && tool.diffs.length > 0) {
    for (const diff of tool.diffs) {
      const body = diff.patchText?.trim() || diff.newText?.trim();
      if (!body) continue;
      const fence = chooseFence(body);
      lines.push('', `Diff: \`${diff.path}\``, `${fence}diff`, body, fence);
    }
  }

  return lines.join('\n');
}

function renderNoticeMd(notice: ExportableNotice): string {
  const text = (notice.text || notice.summaryText || '').trim();
  if (!text) return '';
  const prefix = notice.kind === 'compaction' ? 'Compaction' : notice.level?.toUpperCase() || 'NOTE';
  return `> **${prefix}**: ${text}`;
}

/**
 * Formats conversation turns and session metadata into a standalone Markdown document.
 */
export function formatTranscriptMarkdown(
  turns: readonly ExportableTurn[],
  meta: ExportTranscriptMeta = {},
): string {
  const title = meta.title?.trim() || 'Antigravity Session Transcript';
  const exportedIso = formatExportTimestamp(meta.exportedAt);

  const lines: string[] = [`# ${title}`, ''];
  const metaRows: string[] = [];
  if (meta.sessionId) metaRows.push(`- **Session ID**: \`${meta.sessionId}\``);
  if (meta.model) metaRows.push(`- **Model**: \`${meta.model}\``);
  if (meta.thoughtLevel) metaRows.push(`- **Thinking**: \`${meta.thoughtLevel}\``);
  if (meta.mode) metaRows.push(`- **Mode**: \`${meta.mode}\``);
  if (meta.cwd) metaRows.push(`- **Working Directory**: \`${meta.cwd}\``);
  metaRows.push(`- **Exported At**: ${exportedIso}`);
  metaRows.push(`- **Turns**: ${turns.length}`);
  lines.push(...metaRows, '');

  if (turns.length === 0) {
    lines.push('_No turns recorded in this session._', '');
    return lines.join('\n');
  }

  turns.forEach((turn, idx) => {
    const turnNumber = typeof turn.index === 'number' ? turn.index + 1 : idx + 1;
    lines.push('---', '', `## Turn ${turnNumber}`, '');

    if (turn.user) {
      const timeSuffix = turn.user.timeLabel ? ` (${turn.user.timeLabel})` : '';
      lines.push(`### User${timeSuffix}`, '');
      if (turn.user.text.trim()) {
        lines.push(turn.user.text.trim(), '');
      }
      if (turn.user.attachments && turn.user.attachments.length > 0) {
        lines.push('**Attachments:**');
        for (const att of turn.user.attachments) {
          const detail = att.path ? ` (\`${att.path}\`)` : '';
          lines.push(`- [${att.kind}] ${att.name}${detail}`);
        }
        lines.push('');
      }
    }

    const thoughtsById = new Map((turn.thoughts ?? []).map((t) => [t.id, t]));
    const toolsById = new Map((turn.toolCalls ?? []).map((t) => [t.toolCallId, t]));
    const segmentsById = new Map((turn.assistantSegments ?? []).map((s) => [s.id, s]));
    const noticesById = new Map((turn.notices ?? []).map((n) => [n.id, n]));

    const bodyBlocks: string[] = [];
    if (turn.timeline && turn.timeline.length > 0) {
      for (const ref of turn.timeline) {
        if (ref.kind === 'thought') {
          const t = thoughtsById.get(ref.id);
          if (t) {
            const md = renderThoughtMd(t);
            if (md) bodyBlocks.push(md);
          }
        } else if (ref.kind === 'tool') {
          const tool = toolsById.get(ref.id);
          if (tool) bodyBlocks.push(renderToolCallMd(tool));
        } else if (ref.kind === 'assistant') {
          const seg = segmentsById.get(ref.id);
          if (seg && seg.text.trim()) {
            bodyBlocks.push(seg.text.trim());
          }
        } else if (ref.kind === 'notice') {
          const notice = noticesById.get(ref.id);
          if (notice) {
            const md = renderNoticeMd(notice);
            if (md) bodyBlocks.push(md);
          }
        }
      }
    } else {
      for (const t of turn.thoughts ?? []) {
        const md = renderThoughtMd(t);
        if (md) bodyBlocks.push(md);
      }
      for (const tool of turn.toolCalls ?? []) {
        bodyBlocks.push(renderToolCallMd(tool));
      }
      if (turn.assistantText && turn.assistantText.trim()) {
        bodyBlocks.push(turn.assistantText.trim());
      } else {
        for (const seg of turn.assistantSegments ?? []) {
          if (seg.text.trim()) bodyBlocks.push(seg.text.trim());
        }
      }
      for (const notice of turn.notices ?? []) {
        const md = renderNoticeMd(notice);
        if (md) bodyBlocks.push(md);
      }
    }

    if (bodyBlocks.length > 0) {
      lines.push('### Assistant', '');
      for (const block of bodyBlocks) {
        lines.push(block, '');
      }
    }

    if (turn.errorMessage && turn.errorMessage.trim()) {
      lines.push(`> **Error**: ${turn.errorMessage.trim()}`, '');
    } else if (turn.status === 'cancelled') {
      lines.push('_Turn cancelled._', '');
    }
  });

  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Exports a session transcript as a Markdown file to `targetPath` or
 * `<dataDir>/exports/<slug>.md` atomically.
 */
export async function exportTranscriptMarkdown(
  turns: readonly ExportableTurn[],
  meta: ExportTranscriptMeta = {},
  targetPath?: string,
): Promise<ExportTranscriptResult> {
  const markdown = formatTranscriptMarkdown(turns, meta);

  let resolvedPath: string;
  const trimmedTarget = targetPath?.trim();
  if (trimmedTarget) {
    resolvedPath =
      isAbsolute(trimmedTarget) || !meta.cwd
        ? resolve(trimmedTarget)
        : resolve(meta.cwd, trimmedTarget);
  } else {
    const baseDir = meta.dataDir ?? getDataDir();
    const exportsDir = join(baseDir, 'exports');
    const stamp = formatExportTimestamp(meta.exportedAt)
      .replace(/[:.]/g, '-')
      .replace(/T/, '_')
      .slice(0, 19);
    const slugSource = meta.title?.trim() || meta.sessionId?.trim() || 'session';
    const slug = `${slugifyFilename(slugSource)}-${stamp}`;
    resolvedPath = join(exportsDir, `${slug}.md`);
  }

  await mkdir(dirname(resolvedPath), { recursive: true });
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}`;
  const tmpPath = `${resolvedPath}.${nonce}.tmp`;
  try {
    await writeFile(tmpPath, markdown, 'utf8');
    await rename(tmpPath, resolvedPath);
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  }

  return {
    path: resolvedPath,
    markdown,
    turnCount: turns.length,
    byteLength: Buffer.byteLength(markdown, 'utf8'),
  };
}
