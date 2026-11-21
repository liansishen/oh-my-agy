/**
 * Slash command parser & dispatcher providing a clean Action/Effect interface
 * for `src/app/controller.ts` (DESIGN.md 4.4.1).
 */

import type { CommandRegistry, SlashCommandDef } from './registry';

export type SettingsPageId = 'session' | 'interface' | 'defaults' | 'permissions' | 'ecosystem';

export interface ParsedSlashInput {
  /** Command token without leading '/'. */
  readonly name: string;
  /** Trimmed argument substring following the command token. */
  readonly argsText: string;
  /** Whitespace-split argument tokens (respecting simple quotes). */
  readonly args: readonly string[];
  /** Original raw input string. */
  readonly raw: string;
}

export type PickerCommandKind =
  | 'resume'
  | 'model'
  | 'thought'
  | 'mode'
  | 'log'
  | 'mcp'
  | 'plugins'
  | 'skills'
  | 'agents';

export type CommandAction =
  | { readonly type: 'open_picker'; readonly picker: PickerCommandKind; readonly initialQuery: string }
  | { readonly type: 'open_swarm_board'; readonly query?: string }
  | { readonly type: 'open_settings'; readonly page?: SettingsPageId }
  | { readonly type: 'open_status' }
  | { readonly type: 'open_context' }
  | { readonly type: 'open_usage' }
  | { readonly type: 'open_jobs' }
  | { readonly type: 'open_mcp'; readonly args?: string }
  | { readonly type: 'open_plugins'; readonly args?: string }
  | { readonly type: 'open_skills'; readonly query?: string }
  | { readonly type: 'open_agents'; readonly query?: string }
  | { readonly type: 'login' }
  | { readonly type: 'logout' }
  | { readonly type: 'export_transcript'; readonly path?: string }
  | { readonly type: 'copy_last_assistant'; readonly index?: number }
  | { readonly type: 'new_session' }
  | { readonly type: 'set_model'; readonly query: string }
  | { readonly type: 'set_thought'; readonly level: string }
  | { readonly type: 'set_mode'; readonly mode: string }
  | { readonly type: 'open_help' }
  | { readonly type: 'quit' }
  | {
      readonly type: 'passthrough_prompt';
      readonly text: string;
      readonly commandName: string;
      readonly source: 'oma' | 'agy';
    }
  | {
      readonly type: 'unknown_command';
      readonly commandName: string;
      readonly rawText: string;
      readonly suggestions: readonly string[];
    };

export type CommandDispatchResult =
  | { readonly isCommand: false }
  | {
      readonly isCommand: true;
      readonly parsed: ParsedSlashInput;
      readonly command?: SlashCommandDef;
      readonly action: CommandAction;
    };

export interface CommandActionExecutor {
  openPicker(picker: PickerCommandKind, initialQuery: string): void | Promise<void>;
  openSwarmBoard?(query: string): void | Promise<void>;
  openSettings?(page?: SettingsPageId): void | Promise<void>;
  openStatus?(): void | Promise<void>;
  openContext?(): void | Promise<void>;
  openUsage?(): void | Promise<void>;
  openJobs?(): void | Promise<void>;
  openMcp?(args?: string): void | Promise<void>;
  openPlugins?(args?: string): void | Promise<void>;
  openSkills?(query?: string): void | Promise<void>;
  openAgents?(query?: string): void | Promise<void>;
  login?(): void | Promise<void>;
  logout?(): void | Promise<void>;
  exportTranscript?(path?: string): void | Promise<void>;
  copyLastAssistant?(index?: number): void | Promise<void>;
  /** Legacy alias kept for compatibility when `copyLastAssistant` is not provided. */
  copyLastReply?(index?: number): void | Promise<void>;
  newSession(): void | Promise<void>;
  setModel(query: string): void | Promise<void>;
  setThought(level: string): void | Promise<void>;
  setMode(mode: string): void | Promise<void>;
  openHelp(): void | Promise<void>;
  quit(): void | Promise<void>;
  passthroughPrompt(text: string, commandName: string, source: 'oma' | 'agy'): void | Promise<void>;
  unknownCommand(
    commandName: string,
    rawText: string,
    suggestions: readonly string[],
  ): void | Promise<void>;
}

function splitArgs(argsText: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < argsText.length; i++) {
    const ch = argsText[i]!;
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = '';
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

/**
 * Parse an optional `/settings [page]` argument into a canonical `SettingsPageId`.
 */
export function parseSettingsPageArg(raw: string): SettingsPageId | undefined {
  const token = raw.trim().toLowerCase();
  if (!token) return undefined;
  switch (token) {
    case 'session':
    case 'model':
      return 'session';
    case 'interface':
    case 'ui':
    case 'appearance':
      return 'interface';
    case 'defaults':
    case 'default':
      return 'defaults';
    case 'permissions':
    case 'permission':
    case 'perm':
    case 'approval':
      return 'permissions';
    case 'ecosystem':
    case 'eco':
    case 'mcp':
    case 'plugins':
    case 'skills':
      return 'ecosystem';
    default:
      return undefined;
  }
}

/**
 * Parse `/copy [n]` argument into a 1-based reverse index (default `1`).
 */
export function parseCopyReverseIndex(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 1;
  if (!/^\d+$/.test(trimmed)) return 1;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * Parse a raw input string into a slash command if it starts with `/`.
 * Returns null for ordinary chat messages (including `/` alone or `/ foo`).
 */
export function parseSlashInput(raw: string): ParsedSlashInput | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('/')) return null;

  // Match `/<cmd>` followed by optional whitespace + rest (may span multiple lines for passthrough commands)
  const match = /^\/([^\s]+)([\s\S]*)$/.exec(trimmed);
  if (!match) return null;

  const name = match[1] ?? '';
  if (!name) return null;

  const argsText = (match[2] ?? '').trim();
  return {
    name,
    argsText,
    args: argsText.length > 0 ? splitArgs(argsText) : [],
    raw: trimmed,
  };
}

/**
 * Dispatch a raw input line against the command registry into a typed `CommandAction`.
 */
export function dispatchSlashCommand(
  rawInput: string,
  registry: CommandRegistry,
): CommandDispatchResult {
  const parsed = parseSlashInput(rawInput);
  if (!parsed) {
    return { isCommand: false };
  }

  // Precise `/swarm` routing:
  // - `/swarm board [query]` -> local `open_swarm_board` action
  // - `/swarm` or `/swarm <anything else>` -> ALWAYS passthrough untouched to `agy acp`
  if (parsed.name.toLowerCase() === 'swarm') {
    const boardMatch = /^board(?:\s+([\s\S]*))?$/i.exec(parsed.argsText);
    if (boardMatch) {
      const query = (boardMatch[1] ?? '').trim();
      const boardCmd = registry.resolve('board');
      return {
        isCommand: true,
        parsed,
        ...(boardCmd ? { command: boardCmd } : {}),
        action:
          query.length > 0
            ? { type: 'open_swarm_board', query }
            : { type: 'open_swarm_board' },
      };
    }

    const swarmCmd = registry.resolve('swarm');
    const canonicalText =
      parsed.argsText.length > 0 ? `/swarm ${parsed.argsText}` : '/swarm';
    return {
      isCommand: true,
      parsed,
      ...(swarmCmd ? { command: swarmCmd } : {}),
      action: {
        type: 'passthrough_prompt',
        text: canonicalText,
        commandName: 'swarm',
        source: 'agy',
      },
    };
  }

  // Support `/skill:<name>` invocation syntax by unwrapping to the underlying ACP skill command
  let command = registry.resolve(parsed.name);
  if (!command && parsed.name.toLowerCase().startsWith('skill:')) {
    const skillName = parsed.name.slice('skill:'.length).trim();
    if (skillName.length > 0) {
      command = registry.resolve(skillName);
    }
  }

  if (!command) {
    const suggestions = registry
      .search(parsed.name, 3)
      .map((m) => `/${m.command.name}`);
    return {
      isCommand: true,
      parsed,
      action: {
        type: 'unknown_command',
        commandName: parsed.name,
        rawText: parsed.raw,
        suggestions,
      },
    };
  }

  // Dynamic ACP command or built-in passthrough (`/compact`)
  if (command.passthrough || !command.builtinId) {
    const canonicalText =
      parsed.argsText.length > 0 ? `/${command.name} ${parsed.argsText}` : `/${command.name}`;
    return {
      isCommand: true,
      parsed,
      command,
      action: {
        type: 'passthrough_prompt',
        text: canonicalText,
        commandName: command.name,
        source: command.source,
      },
    };
  }

  const action = buildBuiltinAction(command.builtinId, parsed);
  return {
    isCommand: true,
    parsed,
    command,
    action,
  };
}

function buildBuiltinAction(
  builtinId: NonNullable<SlashCommandDef['builtinId']>,
  parsed: ParsedSlashInput,
): CommandAction {
  switch (builtinId) {
    case 'resume':
      return { type: 'open_picker', picker: 'resume', initialQuery: parsed.argsText };
    case 'new':
      return { type: 'new_session' };
    case 'model':
      return parsed.argsText.length > 0
        ? { type: 'set_model', query: parsed.argsText }
        : { type: 'open_picker', picker: 'model', initialQuery: '' };
    case 'thought':
      return parsed.argsText.length > 0
        ? { type: 'set_thought', level: parsed.argsText }
        : { type: 'open_picker', picker: 'thought', initialQuery: '' };
    case 'mode':
      return parsed.argsText.length > 0
        ? { type: 'set_mode', mode: parsed.argsText }
        : { type: 'open_picker', picker: 'mode', initialQuery: '' };
    case 'copy':
      return {
        type: 'copy_last_assistant',
        index: parseCopyReverseIndex(parsed.argsText),
      };
    case 'log':
      return { type: 'open_picker', picker: 'log', initialQuery: parsed.argsText };
    case 'compact':
      return {
        type: 'passthrough_prompt',
        text: parsed.argsText.length > 0 ? `/compact ${parsed.argsText}` : '/compact',
        commandName: 'compact',
        source: 'oma',
      };
    case 'help':
      return { type: 'open_help' };
    case 'quit':
      return { type: 'quit' };
    case 'board':
      return parsed.argsText.length > 0
        ? { type: 'open_swarm_board', query: parsed.argsText }
        : { type: 'open_swarm_board' };
    case 'settings': {
      const page = parseSettingsPageArg(parsed.args[0] ?? parsed.argsText);
      return page ? { type: 'open_settings', page } : { type: 'open_settings' };
    }
    case 'permissions':
      return { type: 'open_settings', page: 'permissions' };
    case 'status':
      return { type: 'open_status' };
    case 'context':
      return { type: 'open_context' };
    case 'usage':
      return { type: 'open_usage' };
    case 'mcp':
      return parsed.argsText.length > 0
        ? { type: 'open_mcp', args: parsed.argsText }
        : { type: 'open_mcp' };
    case 'plugins':
      return parsed.argsText.length > 0
        ? { type: 'open_plugins', args: parsed.argsText }
        : { type: 'open_plugins' };
    case 'skills':
      return parsed.argsText.length > 0
        ? { type: 'open_skills', query: parsed.argsText }
        : { type: 'open_skills' };
    case 'agents':
      return parsed.argsText.length > 0
        ? { type: 'open_agents', query: parsed.argsText }
        : { type: 'open_agents' };
    case 'login':
      return { type: 'login' };
    case 'logout':
      return { type: 'logout' };
    case 'export':
      return parsed.argsText.length > 0
        ? { type: 'export_transcript', path: parsed.args[0] ?? parsed.argsText }
        : { type: 'export_transcript' };
    case 'jobs':
      return { type: 'open_jobs' };
  }
}

/**
 * Helper to execute a resolved `CommandAction` against a controller-supplied executor.
 */
export async function executeCommandAction(
  action: CommandAction,
  executor: CommandActionExecutor,
): Promise<void> {
  switch (action.type) {
    case 'open_picker':
      await executor.openPicker(action.picker, action.initialQuery);
      return;
    case 'open_swarm_board':
      await executor.openSwarmBoard?.(action.query ?? '');
      return;
    case 'open_settings':
      await executor.openSettings?.(action.page);
      return;
    case 'open_status':
      await executor.openStatus?.();
      return;
    case 'open_context':
      await executor.openContext?.();
      return;
    case 'open_usage':
      await executor.openUsage?.();
      return;
    case 'open_jobs':
      await executor.openJobs?.();
      return;
    case 'open_mcp':
      await executor.openMcp?.(action.args);
      return;
    case 'open_plugins':
      await executor.openPlugins?.(action.args);
      return;
    case 'open_skills':
      await executor.openSkills?.(action.query);
      return;
    case 'open_agents':
      await executor.openAgents?.(action.query);
      return;
    case 'login':
      await executor.login?.();
      return;
    case 'logout':
      await executor.logout?.();
      return;
    case 'export_transcript':
      await executor.exportTranscript?.(action.path);
      return;
    case 'copy_last_assistant':
      if (executor.copyLastAssistant) {
        await executor.copyLastAssistant(action.index);
      } else {
        await executor.copyLastReply?.(action.index);
      }
      return;
    case 'new_session':
      await executor.newSession();
      return;
    case 'set_model':
      await executor.setModel(action.query);
      return;
    case 'set_thought':
      await executor.setThought(action.level);
      return;
    case 'set_mode':
      await executor.setMode(action.mode);
      return;
    case 'open_help':
      await executor.openHelp();
      return;
    case 'quit':
      await executor.quit();
      return;
    case 'passthrough_prompt':
      await executor.passthroughPrompt(action.text, action.commandName, action.source);
      return;
    case 'unknown_command':
      await executor.unknownCommand(action.commandName, action.rawText, action.suggestions);
      return;
  }
}

/**
 * Whether accepting this command in the `/` completion popup with `Enter`
 * should immediately submit/execute rather than leaving the cursor for arguments.
 */
export function shouldAutoExecuteOnEnter(command: SlashCommandDef): boolean {
  return command.autoExecuteOnEnter;
}
