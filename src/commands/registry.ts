/**
 * Slash command registry: built-in `oma` P0/P1 commands (with aliases, semantic
 * Tern icons & live status keys) merged with dynamic ACP `available_commands_update`
 * commands, plus UTF-16 fuzzy matching & highlight hit ranges (DESIGN.md 4.4.1).
 */

export type CommandSource = 'oma' | 'agy';

export type BuiltinCommandId =
  | 'resume'
  | 'new'
  | 'model'
  | 'thought'
  | 'thinking'
  | 'mode'
  | 'copy'
  | 'log'
  | 'compact'
  | 'help'
  | 'quit'
  | 'board'
  | 'settings'
  | 'status'
  | 'mcp'
  | 'plugins'
  | 'skills'
  | 'agents'
  | 'context'
  | 'usage'
  | 'permissions'
  | 'login'
  | 'logout'
  | 'export'
  | 'jobs'
  | 'git'
  | 'todo'
  | 'rename';

export interface AcpAvailableCommandLike {
  readonly name: string;
  readonly description?: string;
  readonly input?: { readonly hint?: string } | null;
}

export interface SlashCommandDef {
  /** Canonical command name without leading '/'. */
  readonly name: string;
  /** Aliases without leading '/'. */
  readonly aliases: readonly string[];
  readonly description: string;
  readonly source: CommandSource;
  /** Semantic Tern `IconName` displayed in `/` completion popup & help. */
  readonly icon?: string;
  /** Optional dynamic state key rendered on the right side of `/` completion rows. */
  readonly statusKey?: string;
  /** True when a dynamic ACP command represents a collapsible skill. */
  readonly isSkill?: boolean;
  /** Optional parameter hint shown in completion & /help, e.g. "[query]". */
  readonly argHint?: string;
  /** Whether this command accepts optional or required arguments. */
  readonly takesArgs: boolean;
  /** Whether pressing Enter in the `/` completion popup should execute immediately. */
  readonly autoExecuteOnEnter: boolean;
  /** Built-in id if handled locally (note: `compact` is built-in but passthrough to ACP). */
  readonly builtinId?: BuiltinCommandId;
  /** True when the command should be sent as a normal `session/prompt` to `agy acp`. */
  readonly passthrough?: boolean;
}

export type HighlightRange = readonly [number, number];

export interface FuzzyMatchResult {
  readonly score: number;
  /** Merged UTF-16 half-open `[start, end)` hit ranges within the matched string. */
  readonly hits: readonly HighlightRange[];
}

export interface CommandSearchMatch {
  readonly command: SlashCommandDef;
  readonly score: number;
  /** UTF-16 hit ranges relative to `command.name` (without leading '/'). */
  readonly nameHits: readonly HighlightRange[];
  /** UTF-16 hit ranges relative to `/${command.name}` (with leading '/'). */
  readonly labelHits: readonly HighlightRange[];
  /** Alias matched when query matched via alias instead of primary name. */
  readonly matchedAlias?: string;
}

/**
 * Core 10 built-in commands kept in `BUILTIN_COMMANDS` for backward compatibility.
 * Full P0/P1 built-in set is exported via `ALL_BUILTIN_COMMANDS` and loaded by
 * `new CommandRegistry()` by default.
 */
export const BUILTIN_COMMANDS: readonly SlashCommandDef[] = [
  {
    name: 'resume',
    aliases: ['r', 'sessions', 'switch', 'conversation'],
    description: 'Open session picker with search & conversation preview',
    source: 'oma',
    icon: 'history',
    argHint: '[query]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'resume',
  },
  {
    name: 'new',
    aliases: ['clear'],
    description: 'Close current session and start a new conversation',
    source: 'oma',
    icon: 'plus',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'new',
  },
  {
    name: 'model',
    aliases: ['m'],
    description: 'Switch model (or open model picker)',
    source: 'oma',
    icon: 'model',
    statusKey: 'model',
    argHint: '[name]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'model',
  },
  {
    name: 'thought',
    aliases: ['t', 'effort'],
    description: 'Switch reasoning depth (thought_level)',
    source: 'oma',
    icon: 'gauge',
    statusKey: 'thought',
    argHint: '[level]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'thought',
  },
  {
    name: 'mode',
    aliases: [],
    description: 'Switch permission mode',
    source: 'oma',
    icon: 'shield',
    statusKey: 'mode',
    argHint: '[mode]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'mode',
  },
  {
    name: 'copy',
    aliases: [],
    description: 'Copy assistant reply [n] as Markdown to clipboard (default: latest)',
    source: 'oma',
    icon: 'copy',
    argHint: '[n]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'copy',
  },
  {
    name: 'log',
    aliases: [],
    description: 'Inspect sanitized ACP JSON-RPC & Tern error traffic',
    source: 'oma',
    icon: 'terminal',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'log',
  },
  {
    name: 'compact',
    aliases: [],
    description: 'Compact conversation context via agy acp',
    source: 'oma',
    icon: 'compress',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'compact',
    passthrough: true,
  },
  {
    name: 'help',
    aliases: ['?'],
    description: 'Show keyboard shortcuts and available commands',
    source: 'oma',
    icon: 'keyboard',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'help',
  },
  {
    name: 'quit',
    aliases: ['exit'],
    description: 'Clear reopen anchor and exit oma cleanly',
    source: 'oma',
    icon: 'power',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'quit',
  },
];

/**
 * Additional P0/P1 built-in commands appended to default `CommandRegistry` instances
 * (without shadowing `agy`'s `/swarm` passthrough command).
 */
export const EXTRA_BUILTIN_COMMANDS: readonly SlashCommandDef[] = [
  {
    name: 'settings',
    aliases: ['config'],
    description: 'Open interactive settings panel',
    source: 'oma',
    icon: 'settings',
    statusKey: 'settings',
    argHint: '[page]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'settings',
  },
  {
    name: 'status',
    aliases: [],
    description: 'Show connection, account tier, model & session status',
    source: 'oma',
    icon: 'activity',
    statusKey: 'status',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'status',
  },
  {
    name: 'context',
    aliases: [],
    description: 'Inspect context window usage and token breakdown',
    source: 'oma',
    icon: 'context',
    statusKey: 'context',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'context',
  },
  {
    name: 'usage',
    aliases: ['quota'],
    description: 'Show subscription tier & session usage summary',
    source: 'oma',
    icon: 'stats',
    statusKey: 'usage',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'usage',
  },
  {
    name: 'mcp',
    aliases: [],
    description: 'Manage MCP servers (list, enable, disable)',
    source: 'oma',
    icon: 'mcp',
    statusKey: 'mcp',
    argHint: '[args]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'mcp',
  },
  {
    name: 'plugins',
    aliases: ['plugin'],
    description: 'Manage installed Antigravity plugins',
    source: 'oma',
    icon: 'package',
    statusKey: 'plugins',
    argHint: '[args]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'plugins',
  },
  {
    name: 'skills',
    aliases: [],
    description: 'Browse and preview available skills',
    source: 'oma',
    icon: 'skill',
    statusKey: 'skills',
    argHint: '[query]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'skills',
  },
  {
    name: 'agents',
    aliases: ['agent'],
    description: 'Inspect custom agents and active subagents',
    source: 'oma',
    icon: 'agents',
    statusKey: 'agents',
    argHint: '[query]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'agents',
  },
  {
    name: 'permissions',
    aliases: [],
    description: 'Manage tool permission rules in settings',
    source: 'oma',
    icon: 'shield',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'permissions',
  },
  {
    name: 'login',
    aliases: [],
    description: 'Authenticate or switch Antigravity account',
    source: 'oma',
    icon: 'signIn',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'login',
  },
  {
    name: 'logout',
    aliases: [],
    description: 'Sign out of current Antigravity session',
    source: 'oma',
    icon: 'signOut',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'logout',
  },
  {
    name: 'export',
    aliases: [],
    description: 'Export current conversation transcript as Markdown',
    source: 'oma',
    icon: 'export',
    argHint: '[path]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'export',
  },
  {
    name: 'board',
    aliases: [],
    description: 'Open Swarm Board (alias of /swarm board)',
    source: 'oma',
    icon: 'users',
    statusKey: 'board',
    argHint: '[query]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'board',
  },
  {
    name: 'git',
    aliases: [],
    description: 'Open Git UI (split diff viewer, staging, commit)',
    source: 'oma',
    icon: 'git-branch',
    statusKey: 'git',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'git',
  },
  {
    name: 'thinking',
    aliases: [],
    description: 'Toggle live thinking stream display (on/off, synced with agy settings)',
    source: 'oma',
    icon: 'brain',
    statusKey: 'thinking',
    argHint: '[on|off]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'thinking',
  },
  {
    name: 'jobs',
    aliases: ['tasks'],
    description: 'Inspect running and recent background jobs',
    source: 'oma',
    icon: 'jobs',
    statusKey: 'jobs',
    takesArgs: false,
    autoExecuteOnEnter: true,
    builtinId: 'jobs',
  },
  {
    name: 'todo',
    aliases: [],
    description:
      'Manage session todo list (expand, collapse, append, start, done, drop, rm, copy, export, import, edit)',
    source: 'oma',
    icon: 'check',
    argHint: '[subcommand]',
    takesArgs: true,
    autoExecuteOnEnter: true,
    builtinId: 'todo',
  },
  {
    name: 'rename',
    aliases: ['title'],
    description: 'Rename current session title locally (/rename --reset restores auto title)',
    source: 'oma',
    icon: 'pen',
    argHint: '<title | --reset>',
    takesArgs: true,
    autoExecuteOnEnter: false,
    builtinId: 'rename',
  },
];

export const ALL_BUILTIN_COMMANDS: readonly SlashCommandDef[] = [
  ...BUILTIN_COMMANDS,
  ...EXTRA_BUILTIN_COMMANDS,
];

/**
 * Semantic Tern `IconName` table for known non-skill ACP passthrough commands.
 * Any other dynamic ACP command is classified as a collapsible skill (`icon: 'skill'`).
 */
const ACP_NON_SKILL_COMMAND_ICONS: Readonly<Record<string, string>> = {
  goal: 'goal',
  plan: 'plan',
  'grill-me': 'question',
  boost: 'bolt',
  teamwork: 'users',
  swarm: 'users',
  learn: 'lightbulb',
  schedule: 'timer',
  browser: 'globe',
  compact: 'compress',
};

function stripLeadingSlash(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
}

/**
 * Resolve the semantic Tern `IconName` for a dynamic ACP command.
 */
export function resolveAcpCommandIcon(name: string): string {
  const key = stripLeadingSlash(name).toLowerCase();
  return ACP_NON_SKILL_COMMAND_ICONS[key] ?? 'skill';
}

/**
 * Determine whether a dynamic ACP command should be treated as a skill
 * (eligible to collapse under the `skill:` row in `/` completion).
 */
export function isAcpSkillCommand(name: string): boolean {
  const key = stripLeadingSlash(name).toLowerCase();
  if (!key) return false;
  if (key.startsWith('skill:')) return true;
  return !(key in ACP_NON_SKILL_COMMAND_ICONS);
}

function mergeRanges(indices: readonly number[]): HighlightRange[] {
  if (indices.length === 0) return [];
  const merged: Array<[number, number]> = [];
  let start = indices[0]!;
  let end = start + 1;

  for (let i = 1; i < indices.length; i++) {
    const idx = indices[i]!;
    if (idx === end) {
      end = idx + 1;
    } else {
      merged.push([start, end]);
      start = idx;
      end = idx + 1;
    }
  }
  merged.push([start, end]);
  return merged;
}

function isWordBoundary(text: string, idx: number): boolean {
  if (idx === 0) return true;
  const prev = text[idx - 1];
  return prev === '-' || prev === '_' || prev === '/' || prev === ' ' || prev === '.' || prev === ':';
}

/**
 * Case-insensitive fuzzy subsequence matcher producing merged UTF-16 `[start, end)` hit ranges.
 */
export function fuzzyMatchText(target: string, rawQuery: string): FuzzyMatchResult | null {
  const query = rawQuery.trim().toLowerCase();
  if (query.length === 0) {
    return { score: 0, hits: [] };
  }

  const lower = target.toLowerCase();

  // Exact match
  if (lower === query) {
    return {
      score: 1000,
      hits: [[0, target.length]],
    };
  }

  // Exact prefix match
  if (lower.startsWith(query)) {
    return {
      score: 800 - (target.length - query.length),
      hits: [[0, query.length]],
    };
  }

  // Contiguous substring match
  const substrIdx = lower.indexOf(query);
  if (substrIdx !== -1) {
    const boundaryBonus = isWordBoundary(target, substrIdx) ? 80 : 0;
    return {
      score: 500 + boundaryBonus - substrIdx * 3 - (target.length - query.length),
      hits: [[substrIdx, substrIdx + query.length]],
    };
  }

  // Ordered subsequence match with boundary & adjacency bonuses
  const matchedIndices: number[] = [];
  let score = 200;
  let ti = 0;
  let prevMatch = -2;

  for (let qi = 0; qi < query.length; qi++) {
    const qch = query[qi]!;
    // Prefer a word-boundary hit when available
    let found = -1;
    let firstAny = -1;
    for (let j = ti; j < lower.length; j++) {
      if (lower[j] === qch) {
        if (firstAny === -1) firstAny = j;
        if (j === prevMatch + 1 || isWordBoundary(target, j)) {
          found = j;
          break;
        }
      }
    }
    if (found === -1) found = firstAny;
    if (found === -1) return null;

    matchedIndices.push(found);
    if (found === prevMatch + 1) {
      score += 25;
    } else if (isWordBoundary(target, found)) {
      score += 18;
    } else {
      score -= Math.min(12, found - ti);
    }

    prevMatch = found;
    ti = found + 1;
  }

  // Penalize overly long non-matching tails
  score -= target.length - query.length;

  return {
    score,
    hits: mergeRanges(matchedIndices),
  };
}

function shiftHits(hits: readonly HighlightRange[], offset: number): HighlightRange[] {
  return hits.map(([start, end]) => [start + offset, end + offset] as const);
}

export class CommandRegistry {
  private readonly _builtins: readonly SlashCommandDef[];
  private _acpCommands: SlashCommandDef[] = [];
  private _merged: SlashCommandDef[] = [];
  private readonly _lookup = new Map<string, SlashCommandDef>();

  constructor(builtins: readonly SlashCommandDef[] = ALL_BUILTIN_COMMANDS) {
    this._builtins = builtins;
    this.rebuild();
  }

  /**
   * Replace the dynamic ACP commands from `available_commands_update`.
   */
  setAcpCommands(commands: readonly AcpAvailableCommandLike[]): void {
    const next: SlashCommandDef[] = [];
    const seen = new Set<string>();

    for (const raw of commands) {
      const name = stripLeadingSlash(raw.name);
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const hint = raw.input?.hint?.trim();
      const takesArgs = Boolean(hint && hint.length > 0);
      const isSkill = isAcpSkillCommand(name);
      next.push({
        name,
        aliases: [],
        description: raw.description?.trim() || `ACP command /${name}`,
        source: 'agy',
        icon: resolveAcpCommandIcon(name),
        isSkill,
        ...(hint ? { argHint: hint } : {}),
        takesArgs,
        autoExecuteOnEnter: !takesArgs,
        passthrough: true,
      });
    }

    this._acpCommands = next;
    this.rebuild();
  }

  getAll(): readonly SlashCommandDef[] {
    return this._merged;
  }

  getBuiltins(): readonly SlashCommandDef[] {
    return this._builtins;
  }

  getAcpCommands(): readonly SlashCommandDef[] {
    return this._acpCommands;
  }

  /**
   * Return dynamic ACP commands classified as skills (non-conflicting with built-ins).
   */
  getAcpSkillCommands(): readonly SlashCommandDef[] {
    return this._merged.filter((cmd) => cmd.source === 'agy' && cmd.isSkill === true);
  }

  /**
   * Resolve a command by exact name or alias (case-insensitive, optional leading '/').
   */
  resolve(nameOrAlias: string): SlashCommandDef | undefined {
    const key = stripLeadingSlash(nameOrAlias).toLowerCase();
    if (!key) return undefined;
    return this._lookup.get(key);
  }

  /**
   * Fuzzy search all registered commands (built-in `oma` + dynamic `agy`),
   * returning matches sorted by relevance with UTF-16 highlight hit ranges.
   */
  search(rawQuery: string, limit?: number): CommandSearchMatch[] {
    const query = stripLeadingSlash(rawQuery).toLowerCase();

    if (query.length === 0) {
      const all: CommandSearchMatch[] = this._merged.map((command, idx) => ({
        command,
        score: (command.source === 'oma' ? 1000 : 500) - idx,
        nameHits: [],
        labelHits: [],
      }));
      return limit !== undefined ? all.slice(0, Math.max(0, limit)) : all;
    }

    const matches: CommandSearchMatch[] = [];

    for (const command of this._merged) {
      const sourceBonus = command.source === 'oma' ? 40 : 0;

      // 1. Primary command name match
      const nameMatch = fuzzyMatchText(command.name, query);
      let bestScore = nameMatch ? nameMatch.score + sourceBonus + 100 : -Infinity;
      let bestNameHits: readonly HighlightRange[] = nameMatch ? nameMatch.hits : [];
      let matchedAlias: string | undefined;

      // 2. Alias match
      for (const alias of command.aliases) {
        const aliasMatch = fuzzyMatchText(alias, query);
        if (aliasMatch) {
          const aliasScore = aliasMatch.score + sourceBonus + 80;
          if (aliasScore > bestScore) {
            bestScore = aliasScore;
            bestNameHits = [];
            matchedAlias = alias;
          }
        }
      }

      // 3. Description substring fallback
      if (bestScore === -Infinity && command.description.toLowerCase().includes(query)) {
        bestScore = 50 + sourceBonus;
        bestNameHits = [];
      }

      if (bestScore > -Infinity) {
        matches.push({
          command,
          score: bestScore,
          nameHits: bestNameHits,
          labelHits: shiftHits(bestNameHits, 1),
          ...(matchedAlias !== undefined ? { matchedAlias } : {}),
        });
      }
    }

    matches.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.command.source !== b.command.source) {
        return a.command.source === 'oma' ? -1 : 1;
      }
      return a.command.name.localeCompare(b.command.name);
    });

    return limit !== undefined ? matches.slice(0, Math.max(0, limit)) : matches;
  }

  private rebuild(): void {
    this._lookup.clear();
    const merged: SlashCommandDef[] = [];
    const acpByName = new Map<string, SlashCommandDef>();
    for (const cmd of this._acpCommands) {
      acpByName.set(cmd.name.toLowerCase(), cmd);
    }

    // 1. Built-in `oma` commands always take precedence on name/alias lookup
    for (const builtin of this._builtins) {
      const acpCounterpart = acpByName.get(builtin.name.toLowerCase());
      const def: SlashCommandDef =
        builtin.passthrough && acpCounterpart
          ? {
              ...builtin,
              description: acpCounterpart.description || builtin.description,
              ...(acpCounterpart.argHint ? { argHint: acpCounterpart.argHint } : {}),
            }
          : builtin;

      merged.push(def);
      this._lookup.set(def.name.toLowerCase(), def);
      for (const alias of def.aliases) {
        const aliasKey = alias.toLowerCase();
        if (!this._lookup.has(aliasKey)) {
          this._lookup.set(aliasKey, def);
        }
      }
    }

    // 2. Append non-conflicting dynamic `agy` commands
    for (const acpCmd of this._acpCommands) {
      const key = acpCmd.name.toLowerCase();
      if (this._lookup.has(key)) continue;
      merged.push(acpCmd);
      this._lookup.set(key, acpCmd);
    }

    this._merged = merged;
  }
}
