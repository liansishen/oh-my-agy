import pkg from '../../package.json';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { AcpClient, type AcpClientOptions } from '../acp/client';
import {
  applyModelSelection,
  clampThoughtLevelForChoices,
  extractSessionControlState,
  resolveModeSelection,
  resolveModelSelection,
  resolveThoughtLevel,
  splitModelThoughtSuffix,
  type SessionControlContext,
} from '../acp/model';
import { normalizeDisplayPath, sameDir } from '../acp/path';
import {
  extractContentText,
  extractNoticeText,
  isRequestPermissionRequest,
  type RequestPermissionResult,
  type SessionUpdateParams,
} from '../acp/protocol';
import { loadSessionPreview } from '../preview/store';
import { readTranscriptModelCandidates } from '../state/session_metrics';

export const OMA_VERSION: string = pkg.version;

export type ResumeKind = 'resume' | 'restore' | 'fork';

export interface CliOptions {
  continue: boolean;
  resume?: string;
  resumeKind?: ResumeKind;
  sessions: boolean;
  model?: string;
  thought?: string;
  mode?: string;
  addDirs: string[];
  agyBin?: string;
  plain: boolean;
  noFallback: boolean;
  version: boolean;
  help: boolean;
  promptParts: string[];
  initialPrompt?: string;
}

export class CliParseError extends Error {
  override name = 'CliParseError';
}

export interface ResolvedResumeTarget {
  sessionId?: string;
  cwd?: string;
  title?: string;
  model?: string;
  thoughtLevel?: string;
  mode?: string;
  source: 'id' | 'anchor_file' | 'invalid_anchor';
  rawInput: string;
  anchorPath?: string;
  error?: string;
}

export interface FallbackTranslation {
  args: string[];
  warnings: string[];
  resolvedResume?: ResolvedResumeTarget;
}

export function stripOuterQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    continue: false,
    sessions: false,
    addDirs: [],
    plain: false,
    noFallback: false,
    version: false,
    help: false,
    promptParts: [],
  };

  let positionalOnly = false;

  const takeValue = (flag: string, inlineValue: string | undefined, index: number): [string, number] => {
    if (inlineValue !== undefined) {
      return [inlineValue, index];
    }
    const next = argv[index + 1];
    if (next === undefined) {
      throw new CliParseError(`Option ${flag} requires a value`);
    }
    return [next, index + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (positionalOnly) {
      options.promptParts.push(arg);
      continue;
    }

    if (arg === '--') {
      positionalOnly = true;
      continue;
    }

    if (!arg.startsWith('-') || arg === '-') {
      options.promptParts.push(arg);
      continue;
    }

    let flag = arg;
    let inlineValue: string | undefined;
    if (arg.startsWith('--') || arg.startsWith('-r=')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flag = arg.slice(0, eq);
        inlineValue = arg.slice(eq + 1);
      }
    }

    switch (flag) {
      case '-c':
      case '--continue':
        if (inlineValue !== undefined) {
          throw new CliParseError(`Option ${flag} does not accept a value`);
        }
        options.continue = true;
        break;
      case '-r':
      case '--resume': {
        const [val, nextIdx] = takeValue(flag, inlineValue, i);
        options.resume = val;
        options.resumeKind = 'resume';
        i = nextIdx;
        break;
      }
      case '--restore': {
        const [val, nextIdx] = takeValue(flag, inlineValue, i);
        options.resume = val;
        options.resumeKind = 'restore';
        i = nextIdx;
        break;
      }
      case '--fork': {
        const [val, nextIdx] = takeValue(flag, inlineValue, i);
        options.resume = val;
        options.resumeKind = 'fork';
        i = nextIdx;
        break;
      }
      case '--sessions':
        if (inlineValue !== undefined) {
          throw new CliParseError(`Option ${flag} does not accept a value`);
        }
        options.sessions = true;
        break;
      case '--model': {
        const [val, nextIdx] = takeValue(flag, inlineValue, i);
        options.model = val;
        i = nextIdx;
        break;
      }
      case '--thought': {
        const [val, nextIdx] = takeValue(flag, inlineValue, i);
        options.thought = val;
        i = nextIdx;
        break;
      }
      case '--mode': {
        const [val, nextIdx] = takeValue(flag, inlineValue, i);
        options.mode = val;
        i = nextIdx;
        break;
      }
      case '--add-dir': {
        const [val, nextIdx] = takeValue(flag, inlineValue, i);
        options.addDirs.push(val);
        i = nextIdx;
        break;
      }
      case '--agy-bin': {
        const [val, nextIdx] = takeValue(flag, inlineValue, i);
        options.agyBin = val;
        i = nextIdx;
        break;
      }
      case '--plain':
        if (inlineValue !== undefined) {
          throw new CliParseError(`Option ${flag} does not accept a value`);
        }
        options.plain = true;
        break;
      case '--no-fallback':
        if (inlineValue !== undefined) {
          throw new CliParseError(`Option ${flag} does not accept a value`);
        }
        options.noFallback = true;
        break;
      case '--version':
      case '-v':
        if (inlineValue !== undefined) {
          throw new CliParseError(`Option ${flag} does not accept a value`);
        }
        options.version = true;
        break;
      case '--help':
      case '-h':
        if (inlineValue !== undefined) {
          throw new CliParseError(`Option ${flag} does not accept a value`);
        }
        options.help = true;
        break;
      default:
        throw new CliParseError(`Unknown option: ${arg}`);
    }
  }

  if (options.promptParts.length > 0) {
    options.initialPrompt = options.promptParts.join(' ');
  }

  return options;
}

export function resolveResumeTarget(raw: string): ResolvedResumeTarget {
  const cleaned = stripOuterQuotes(raw);
  if (!cleaned) {
    return {
      source: 'invalid_anchor',
      rawInput: raw,
      error: 'Empty resume target',
    };
  }

  let isExistingFile = false;
  try {
    isExistingFile = existsSync(cleaned) && statSync(cleaned).isFile();
  } catch {
    isExistingFile = false;
  }

  if (isExistingFile) {
    try {
      const content = readFileSync(cleaned, 'utf8');
      const parsed: unknown = JSON.parse(content);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
          source: 'invalid_anchor',
          rawInput: raw,
          anchorPath: cleaned,
          error: 'Anchor file does not contain a JSON object',
        };
      }
      const obj = parsed as Record<string, unknown>;
      const sessionId = typeof obj['sessionId'] === 'string' ? obj['sessionId'].trim() : '';
      if (!sessionId) {
        return {
          source: 'invalid_anchor',
          rawInput: raw,
          anchorPath: cleaned,
          error: 'Anchor JSON missing valid sessionId',
        };
      }
      return {
        sessionId,
        cwd: typeof obj['cwd'] === 'string' ? obj['cwd'] : undefined,
        title: typeof obj['title'] === 'string' ? obj['title'] : undefined,
        model: typeof obj['model'] === 'string' ? obj['model'] : undefined,
        thoughtLevel: typeof obj['thoughtLevel'] === 'string' ? obj['thoughtLevel'] : undefined,
        mode: typeof obj['mode'] === 'string' ? obj['mode'] : undefined,
        source: 'anchor_file',
        rawInput: raw,
        anchorPath: cleaned,
      };
    } catch (err) {
      return {
        source: 'invalid_anchor',
        rawInput: raw,
        anchorPath: cleaned,
        error: `Failed to parse anchor JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (cleaned.toLowerCase().endsWith('.json')) {
    return {
      source: 'invalid_anchor',
      rawInput: raw,
      anchorPath: cleaned,
      error: `Anchor file not found: ${cleaned}`,
    };
  }

  return {
    sessionId: cleaned,
    source: 'id',
    rawInput: raw,
  };
}

export function translateFallbackArgs(
  options: CliOptions,
  resolveAnchor: (raw: string) => ResolvedResumeTarget = resolveResumeTarget
): FallbackTranslation {
  const args: string[] = [];
  const warnings: string[] = [];
  let resolvedResume: ResolvedResumeTarget | undefined;

  if (options.resume !== undefined) {
    resolvedResume = resolveAnchor(options.resume);
    if (resolvedResume.sessionId) {
      args.push('--conversation', resolvedResume.sessionId);
    } else {
      warnings.push(
        resolvedResume.error ?? `Unable to resolve session target: ${options.resume}`
      );
    }
  } else if (options.continue) {
    args.push('--continue');
  }

  if (options.model !== undefined && options.model.trim() !== '') {
    args.push('--model', options.model.trim());
  }

  if (options.thought !== undefined && options.thought.trim() !== '') {
    args.push('--effort', options.thought.trim());
  }

  if (options.mode !== undefined) {
    const mode = options.mode.trim();
    if (mode !== '' && mode !== 'default') {
      args.push('--mode', mode);
    }
  }

  for (const dir of options.addDirs) {
    if (dir.trim() !== '') {
      args.push('--add-dir', dir);
    }
  }

  if (options.initialPrompt !== undefined && options.initialPrompt.trim() !== '') {
    args.push('-i', options.initialPrompt);
  }

  return { args, warnings, resolvedResume };
}

export function formatVersionText(): string {
  const runtime = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
  return `oma ${OMA_VERSION} (${runtime}, ${process.platform}-${process.arch})`;
}

export function formatHelpText(): string {
  return [
    'Usage: oma [flags] [initial prompt...]',
    '       oma update [--check] [--force] [--version <tag>]',
    '',
    'Commands:',
    '  update                      Check for and install the latest oma release from GitHub',
    '',
    'Flags:',
    '  -c, --continue              Continue the most recent session in current directory',
    '  -r, --resume <id|file>      Resume a session by ID or oma anchor JSON file',
    '      --restore <id|file>     Alias for --resume (Tern reopen plugin compatibility)',
    '      --fork <id|file>        Tern pane fork compatibility (loads original session safely)',
    '      --sessions              Open /resume session picker immediately on startup',
    '      --model <model>         Initial model (base name or full ID with thought suffix)',
    '      --thought <level>       Initial thought level (low|medium|high|xhigh|max)',
    '      --mode <mode>           Initial permission mode (default|accept-edits|auto|plan)',
    '      --add-dir <dir>         Add extra workspace directory (repeatable)',
    '      --agy-bin <path>        Override agy executable path (default: agy from PATH)',
    '      --plain                 Force plain text line-based REPL mode (no TSP)',
    '      --no-fallback           Fail instead of falling back to native agy outside Tern',
    '  -v, --version               Print oma version and build info',
    '  -h, --help                  Show this help message',
  ].join('\n');
}

export interface FallbackSpawnResult {
  exited: Promise<number>;
}

export type FallbackSpawnFn = (
  cmd: string[],
  opts: { stdin: 'inherit'; stdout: 'inherit'; stderr: 'inherit'; cwd?: string }
) => FallbackSpawnResult;

export interface RunFallbackOptions {
  cli: CliOptions;
  configAgyBin?: string;
  cwd?: string;
  spawn?: FallbackSpawnFn;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  resolveAnchor?: (raw: string) => ResolvedResumeTarget;
}

export async function runFallbackAgy(opts: RunFallbackOptions): Promise<number> {
  const agyBin = opts.cli.agyBin?.trim() || opts.configAgyBin?.trim() || 'agy';
  const translation = translateFallbackArgs(opts.cli, opts.resolveAnchor);
  const stderr = opts.stderr ?? process.stderr;

  for (const warning of translation.warnings) {
    stderr.write(`[oma] warning: ${warning}\n`);
  }

  const spawnFn: FallbackSpawnFn =
    opts.spawn ??
    ((cmd, spawnOpts) =>
      Bun.spawn(cmd, {
        stdin: spawnOpts.stdin,
        stdout: spawnOpts.stdout,
        stderr: spawnOpts.stderr,
        cwd: spawnOpts.cwd,
      }));

  const targetCwd =
    opts.cwd ??
    (translation.resolvedResume?.cwd && existsSync(translation.resolvedResume.cwd)
      ? translation.resolvedResume.cwd
      : undefined);

  try {
    const proc = spawnFn([agyBin, ...translation.args], {
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      cwd: targetCwd,
    });
    return await proc.exited;
  } catch (err) {
    stderr.write(
      `[oma] failed to launch native agy (${agyBin}): ${err instanceof Error ? err.message : String(err)}\n`
    );
    return 1;
  }
}

export interface PlainSessionControlState {
  readonly modelId: string | null;
  readonly supportsThoughtLevel: boolean;
  readonly thoughtLevel: string | null;
  readonly modeId: string | null;
}

export interface PlainAcpAdapter {
  start(): Promise<void>;
  initialize(): Promise<{ agentInfo?: { name?: string; version?: string } }>;
  newSession(cwd: string): Promise<{ sessionId: string }>;
  loadSession(sessionId: string, cwd: string): Promise<{ sessionId: string }>;
  listSessions(): Promise<Array<{ sessionId: string; cwd?: string; title?: string; updatedAt?: string }>>;
  prompt(sessionId: string, text: string): Promise<{ stopReason?: string }>;
  cancel(sessionId: string): Promise<void>;
  getControlState?(): PlainSessionControlState;
  resolveSelectableModel?(
    candidates: readonly string[]
  ): { readonly modelId: string; readonly thoughtLevel?: string } | null;
  setConfigOption?(sessionId: string, configId: string, value: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  shutdown(): Promise<void>;
  onUpdate(cb: (update: PlainAcpUpdate) => void): void;
  onPermission(
    cb: (req: PlainPermissionRequest) => Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }>
  ): void;
}

export interface PlainAcpUpdate {
  kind: 'thought' | 'message' | 'tool' | 'notice';
  text?: string;
  toolTitle?: string;
  toolStatus?: string;
}

export interface PlainPermissionRequest {
  toolCallId: string;
  title?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface RunPlainReplOptions {
  cli: CliOptions;
  cwd: string;
  adapter: PlainAcpAdapter;
  stdin?: NodeJS.ReadableStream;
  stdout?: Pick<NodeJS.WriteStream, 'write'>;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
  sameDir?: (a: string, b: string) => boolean;
  sessionsDir?: string;
  baseBrainDir?: string;
}

export async function runPlainRepl(opts: RunPlainReplOptions): Promise<number> {
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const sameDirFn =
    opts.sameDir ??
    ((a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase());

  const rl = createInterface({ input: stdin, output: undefined, terminal: false });
  const lineQueue: string[] = [];
  let lineWaiter: ((line: string | null) => void) | undefined;
  let stdinEnded = false;

  rl.on('line', line => {
    if (lineWaiter) {
      const resolve = lineWaiter;
      lineWaiter = undefined;
      resolve(line);
    } else {
      lineQueue.push(line);
    }
  });
  rl.on('close', () => {
    stdinEnded = true;
    if (lineWaiter) {
      const resolve = lineWaiter;
      lineWaiter = undefined;
      resolve(null);
    }
  });

  const readLine = (): Promise<string | null> => {
    const queued = lineQueue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (stdinEnded) return Promise.resolve(null);
    return new Promise(resolve => {
      lineWaiter = resolve;
    });
  };

  let sessionId = '';
  let inPrompt = false;
  let pendingPermCancel: (() => void) | undefined;
  let closed = false;

  const cleanup = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    rl.close();
    if (pendingPermCancel) {
      pendingPermCancel();
      pendingPermCancel = undefined;
    }
    if (sessionId) {
      await opts.adapter.closeSession(sessionId).catch(() => {});
    }
    await opts.adapter.shutdown().catch(() => {});
  };

  const onSigInt = (): void => {
    if (inPrompt && sessionId) {
      if (pendingPermCancel) {
        pendingPermCancel();
        pendingPermCancel = undefined;
      }
      void opts.adapter.cancel(sessionId).catch(() => {});
      stdout.write('\n[cancelled]\n');
    } else {
      void cleanup().finally(() => process.exit(0));
    }
  };
  process.on('SIGINT', onSigInt);

  try {
    await opts.adapter.start();
    const init = await opts.adapter.initialize();
    const agentLabel = init.agentInfo?.name
      ? `${init.agentInfo.name}${init.agentInfo.version ? ` ${init.agentInfo.version}` : ''}`
      : 'agy';

    let replayMuted = false;
    opts.adapter.onUpdate(u => {
      if (replayMuted) return;
      if (u.kind === 'message' && u.text) {
        stdout.write(u.text);
      } else if (u.kind === 'tool' && u.toolTitle) {
        stdout.write(`\n[tool:${u.toolStatus ?? 'update'}] ${u.toolTitle}\n`);
      } else if (u.kind === 'notice' && u.text) {
        stdout.write(`\n[notice] ${u.text}\n`);
      }
    });

    opts.adapter.onPermission(async req => {
      stdout.write(`\n[permission] ${req.title ?? req.toolCallId}\n`);
      stdout.write('Allow? [y] allow / [a] always / [n] deny: ');
      const decision = await new Promise<string | null>(resolve => {
        pendingPermCancel = () => resolve(null);
        void readLine().then(ans => {
          pendingPermCancel = undefined;
          resolve(ans);
        });
      });
      if (decision === null) return { outcome: 'cancelled' };
      const key = decision.trim().toLowerCase();
      const allowOnce = req.options.find(o => o.kind === 'allow_once') ?? req.options[0];
      const allowAlways = req.options.find(o => o.kind === 'allow_always') ?? allowOnce;
      const rejectOnce =
        req.options.find(o => o.kind === 'reject_once') ??
        req.options.find(o => o.kind === 'reject_always');

      if (key === 'a' && allowAlways) {
        return { outcome: 'selected', optionId: allowAlways.optionId };
      }
      if (key === 'y' && allowOnce) {
        return { outcome: 'selected', optionId: allowOnce.optionId };
      }
      if (rejectOnce) {
        return { outcome: 'selected', optionId: rejectOnce.optionId };
      }
      return { outcome: 'cancelled' };
    });

    let resumedFromSession = false;
    let resumeAnchorHint: { model?: string; thoughtLevel?: string; mode?: string } | undefined;

    if (opts.cli.resume) {
      const target = resolveResumeTarget(opts.cli.resume);
      if (opts.cli.resumeKind === 'fork') {
        stderr.write('[oma] notice: --fork is not supported by agy acp; loading original session.\n');
      }
      if (target.sessionId) {
        replayMuted = true;
        const loaded = await opts.adapter.loadSession(target.sessionId, target.cwd ?? opts.cwd);
        replayMuted = false;
        sessionId = loaded.sessionId;
        resumedFromSession = true;
        resumeAnchorHint = {
          ...(target.model ? { model: target.model } : {}),
          ...(target.thoughtLevel ? { thoughtLevel: target.thoughtLevel } : {}),
          ...(target.mode ? { mode: target.mode } : {}),
        };
      } else {
        stderr.write(`[oma] warning: ${target.error ?? 'invalid anchor'}; creating new session.\n`);
        const created = await opts.adapter.newSession(opts.cwd);
        sessionId = created.sessionId;
      }
    } else if (opts.cli.continue) {
      const sessions = await opts.adapter.listSessions().catch(() => []);
      const matching = sessions
        .filter(s => s.cwd && sameDirFn(s.cwd, opts.cwd))
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      const latest = matching[0];
      if (latest) {
        replayMuted = true;
        const loaded = await opts.adapter.loadSession(latest.sessionId, opts.cwd);
        replayMuted = false;
        sessionId = loaded.sessionId;
        resumedFromSession = true;
      } else {
        const created = await opts.adapter.newSession(opts.cwd);
        sessionId = created.sessionId;
      }
    } else {
      const created = await opts.adapter.newSession(opts.cwd);
      sessionId = created.sessionId;
    }

    let selectedModel: string | undefined;
    let selectedThought: string | undefined;
    let selectedMode: string | undefined;

    if (opts.adapter.setConfigOption) {
      let initialModel = opts.cli.model?.trim() || undefined;
      let initialThought = opts.cli.thought?.trim() || undefined;
      let initialMode = opts.cli.mode?.trim() || undefined;

      if (resumedFromSession) {
        const stored = await loadSessionPreview(
          sessionId,
          opts.sessionsDir ? { sessionsDir: opts.sessionsDir } : {}
        ).catch(() => null);
        let savedModel = resumeAnchorHint?.model?.trim() || stored?.model?.trim() || undefined;
        let savedThought = resumeAnchorHint?.model?.trim()
          ? (resumeAnchorHint.thoughtLevel?.trim() || undefined)
          : (resumeAnchorHint?.thoughtLevel?.trim() || stored?.thoughtLevel?.trim() || undefined);
        const savedMode = resumeAnchorHint?.mode?.trim() || stored?.mode?.trim() || undefined;

        if (!savedModel) {
          const candidates = await readTranscriptModelCandidates(
            sessionId,
            opts.baseBrainDir ? { baseBrainDir: opts.baseBrainDir } : {}
          );
          if (opts.adapter.resolveSelectableModel) {
            const resolved = opts.adapter.resolveSelectableModel(candidates);
            if (resolved) {
              savedModel = resolved.modelId;
              if (!savedThought && resolved.thoughtLevel) {
                savedThought = resolved.thoughtLevel;
              }
            }
          } else if (candidates[0]) {
            savedModel = candidates[0];
          }
        }

        initialModel = initialModel || savedModel;
        initialThought = initialThought || (opts.cli.model?.trim() ? undefined : savedThought);
        initialMode = initialMode || savedMode;
      }

      let modelFailed = false;
      if (initialModel) {
        const curControls = opts.adapter.getControlState?.();
        if (curControls && curControls.modelId === initialModel) {
          selectedModel = initialModel;
        } else {
          await opts.adapter
            .setConfigOption(sessionId, 'model', initialModel)
            .then(() => {
              selectedModel = initialModel;
            })
            .catch(() => {
              modelFailed = true;
            });
        }
      }
      if (!modelFailed && initialThought) {
        const afterModel = opts.adapter.getControlState?.();
        if (afterModel && afterModel.supportsThoughtLevel && afterModel.thoughtLevel === initialThought) {
          selectedThought = initialThought;
        } else if (!afterModel || afterModel.supportsThoughtLevel) {
          await opts.adapter
            .setConfigOption(sessionId, 'thought_level', initialThought)
            .then(() => {
              selectedThought = initialThought;
            })
            .catch(() => {});
        }
      }
      if (initialMode) {
        const afterThought = opts.adapter.getControlState?.();
        if (afterThought && afterThought.modeId === initialMode) {
          selectedMode = initialMode;
        } else {
          await opts.adapter
            .setConfigOption(sessionId, 'mode', initialMode)
            .then(() => {
              selectedMode = initialMode;
            })
            .catch(() => {});
        }
      }
    }

    stdout.write(`oma ${OMA_VERSION} (--plain) connected to ${agentLabel} [session ${sessionId}]\n`);
    stdout.write('Type a prompt, or /new, /help, /quit.\n');

    const runTurn = async (text: string): Promise<void> => {
      inPrompt = true;
      try {
        await opts.adapter.prompt(sessionId, text);
        stdout.write('\n');
      } finally {
        inPrompt = false;
      }
    };

    if (opts.cli.initialPrompt) {
      stdout.write(`> ${opts.cli.initialPrompt}\n`);
      await runTurn(opts.cli.initialPrompt);
    }

    for (;;) {
      stdout.write('> ');
      const line = await readLine();
      if (line === null) break;
      const trimmed = line.trim();
      if (!trimmed) continue;

      if (trimmed === '/quit' || trimmed === '/exit') {
        break;
      }
      if (trimmed === '/help') {
        stdout.write('Commands: /new, /model <id>, /thought <level>, /mode <mode>, /quit\n');
        continue;
      }
      if (trimmed === '/new' || trimmed === '/clear') {
        const prevControls = opts.adapter.getControlState?.();
        const carryModel = prevControls ? (prevControls.modelId ?? undefined) : selectedModel;
        const carryThought = prevControls
          ? prevControls.supportsThoughtLevel
            ? (prevControls.thoughtLevel ?? undefined)
            : undefined
          : selectedThought;
        const carryMode = prevControls ? (prevControls.modeId ?? undefined) : selectedMode;

        await opts.adapter.closeSession(sessionId).catch(() => {});
        const created = await opts.adapter.newSession(opts.cwd);
        sessionId = created.sessionId;

        if (opts.adapter.setConfigOption) {
          let modelFailed = false;
          const afterNew = opts.adapter.getControlState?.();
          if (carryModel && (!afterNew || afterNew.modelId !== carryModel)) {
            try {
              await opts.adapter.setConfigOption(sessionId, 'model', carryModel);
            } catch (err) {
              modelFailed = true;
              stderr.write(
                `[oma] warning: failed to carry over model "${carryModel}": ${
                  err instanceof Error ? err.message : String(err)
                }\n`
              );
            }
          }
          if (!modelFailed && carryThought) {
            const afterModel = opts.adapter.getControlState?.();
            if (
              !afterModel ||
              (afterModel.supportsThoughtLevel && afterModel.thoughtLevel !== carryThought)
            ) {
              try {
                await opts.adapter.setConfigOption(sessionId, 'thought_level', carryThought);
              } catch (err) {
                stderr.write(
                  `[oma] warning: failed to carry over thought level "${carryThought}": ${
                    err instanceof Error ? err.message : String(err)
                  }\n`
                );
              }
            }
          }
          if (carryMode) {
            const afterThought = opts.adapter.getControlState?.();
            if (!afterThought || afterThought.modeId !== carryMode) {
              try {
                await opts.adapter.setConfigOption(sessionId, 'mode', carryMode);
              } catch (err) {
                stderr.write(
                  `[oma] warning: failed to carry over mode "${carryMode}": ${
                    err instanceof Error ? err.message : String(err)
                  }\n`
                );
              }
            }
          }
        }

        stdout.write(`[new session ${sessionId}]\n`);
        continue;
      }
      if (trimmed.startsWith('/model ') && opts.adapter.setConfigOption) {
        const value = trimmed.slice(7).trim();
        if (value) {
          await opts.adapter.setConfigOption(sessionId, 'model', value);
          selectedModel = value;
          if (splitModelThoughtSuffix(value)) {
            selectedThought = undefined;
          }
          stdout.write('[model updated]\n');
        }
        continue;
      }
      if (trimmed.startsWith('/thought ') && opts.adapter.setConfigOption) {
        const value = trimmed.slice(9).trim();
        if (value) {
          await opts.adapter.setConfigOption(sessionId, 'thought_level', value);
          selectedThought = value;
          stdout.write('[thought_level updated]\n');
        }
        continue;
      }
      if (trimmed.startsWith('/mode ') && opts.adapter.setConfigOption) {
        const value = trimmed.slice(6).trim();
        if (value) {
          await opts.adapter.setConfigOption(sessionId, 'mode', value);
          selectedMode = value;
          stdout.write('[mode updated]\n');
        }
        continue;
      }

      await runTurn(trimmed);
    }

    return 0;
  } catch (err) {
    stderr.write(`[oma] plain mode error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    process.off('SIGINT', onSigInt);
    await cleanup();
  }
}

export function createAcpPlainAdapter(options: {
  agyBin?: string;
  addDirs?: readonly string[];
  cwd?: string;
  spawn?: AcpClientOptions['spawn'];
}): PlainAcpAdapter {
  let updateCb: ((update: PlainAcpUpdate) => void) | undefined;
  let permCb:
    | ((
        req: PlainPermissionRequest
      ) => Promise<{ outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }>)
    | undefined;
  let controlContext: SessionControlContext = {};

  const extraArgs: string[] = [];
  for (const dir of options.addDirs ?? []) {
    if (dir.trim()) {
      extraArgs.push('--add-dir', dir);
    }
  }

  const client = new AcpClient({
    agyBin: options.agyBin,
    extraArgs,
    cwd: options.cwd,
    spawn: options.spawn,
    onUpdate: (params: SessionUpdateParams) => {
      const u = params.update;
      switch (u.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = extractContentText(u.content);
          if (text) updateCb?.({ kind: 'message', text });
          break;
        }
        case 'agent_thought_chunk': {
          const text = extractContentText(u.content);
          if (text) updateCb?.({ kind: 'thought', text });
          break;
        }
        case 'tool_call':
        case 'tool_call_update': {
          const title = normalizeDisplayPath(u.title ?? u.name ?? u.toolCallId);
          updateCb?.({ kind: 'tool', toolTitle: title, toolStatus: u.status });
          break;
        }
        case 'config_option_update': {
          controlContext = { ...controlContext, configOptions: u.configOptions };
          break;
        }
        case 'current_mode_update': {
          if (controlContext.modes) {
            controlContext = {
              ...controlContext,
              modes: { ...controlContext.modes, currentModeId: u.currentModeId },
            };
          }
          break;
        }
        case 'compaction_update':
        case 'compaction_summary_chunk':
        case 'notice': {
          const text = extractNoticeText(u);
          if (text) updateCb?.({ kind: 'notice', text });
          break;
        }
        default:
          break;
      }
    },
    onServerRequest: async req => {
      if (isRequestPermissionRequest(req)) {
        if (!permCb) {
          const res: RequestPermissionResult = { outcome: { outcome: 'cancelled' } };
          return res;
        }
        const outcome = await permCb({
          toolCallId: req.params.toolCall.toolCallId,
          title: req.params.toolCall.title
            ? normalizeDisplayPath(req.params.toolCall.title)
            : req.params.toolCall.name,
          options: req.params.options,
        });
        const res: RequestPermissionResult = { outcome };
        return res;
      }
      return { action: 'cancel' };
    },
  });

  return {
    async start() {
      client.start();
    },
    async initialize() {
      const res = await client.initialize({
        protocolVersion: 1,
        clientInfo: { name: 'oma', version: OMA_VERSION },
        clientCapabilities: {},
      });
      return { agentInfo: res.agentInfo };
    },
    async newSession(cwd) {
      const res = await client.newSession({ cwd, mcpServers: [] });
      controlContext = {
        configOptions: res.configOptions,
        models: res.models,
        modes: res.modes,
      };
      return { sessionId: res.sessionId };
    },
    async loadSession(sessionId, cwd) {
      const res = await client.loadSession({ sessionId, cwd, mcpServers: [] });
      controlContext = {
        configOptions: res.configOptions,
        models: res.models,
        modes: res.modes,
      };
      return { sessionId: res.sessionId };
    },
    async listSessions() {
      const list = await client.listAllSessions();
      return list.map(s => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
        title: s.title ?? undefined,
        updatedAt: s.updatedAt ?? undefined,
      }));
    },
    async prompt(sessionId, text) {
      const res = await client.prompt({
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      return { stopReason: res.stopReason };
    },
    async cancel(sessionId) {
      await client.cancel(sessionId);
    },
    getControlState() {
      const controls = extractSessionControlState(controlContext);
      return {
        modelId: controls.currentModelId,
        supportsThoughtLevel: controls.supportsThoughtLevel,
        thoughtLevel: controls.currentThoughtLevel,
        modeId: controls.currentModeId,
      };
    },
    resolveSelectableModel(candidates) {
      if (extractSessionControlState(controlContext).availableModels.length === 0) {
        return null;
      }
      for (const candidate of candidates) {
        const resolved = resolveModelSelection(candidate, controlContext);
        if (
          resolved &&
          resolved.matchKind !== 'fuzzy_config_model' &&
          resolved.matchKind !== 'legacy_fuzzy'
        ) {
          return {
            modelId: resolved.modelId,
            ...(resolved.thoughtLevel ? { thoughtLevel: resolved.thoughtLevel } : {}),
          };
        }
      }
      return null;
    },
    async setConfigOption(sessionId, configId, value) {
      if (configId === 'model') {
        const resolved = resolveModelSelection(value, controlContext);
        if (resolved) {
          const applied = await applyModelSelection(client, sessionId, resolved);
          if (applied.configOptions) {
            controlContext = { ...controlContext, configOptions: applied.configOptions };
          } else if (controlContext.models) {
            controlContext = {
              ...controlContext,
              models: { ...controlContext.models, currentModelId: applied.appliedModelId },
            };
          }
          return;
        }
      }
      if (configId === 'thought_level') {
        const resolved = resolveThoughtLevel(value, controlContext.configOptions);
        const targetValue = resolved.ok
          ? resolved.value
          : resolved.reason === 'invalid'
            ? clampThoughtLevelForChoices(
                value,
                extractSessionControlState(controlContext).availableThoughtLevels
              )
            : undefined;
        if (targetValue) {
          const res = await client.setConfigOption({
            sessionId,
            configId: 'thought_level',
            value: targetValue,
          });
          controlContext = { ...controlContext, configOptions: res.configOptions };
        }
        return;
      }
      if (configId === 'mode') {
        const resolved = resolveModeSelection(value, controlContext);
        if (resolved) {
          if (resolved.strategy === 'config_option') {
            const res = await client.setConfigOption({
              sessionId,
              configId: 'mode',
              value: resolved.modeId,
            });
            controlContext = { ...controlContext, configOptions: res.configOptions };
          } else {
            await client.setMode({ sessionId, modeId: resolved.modeId });
            if (controlContext.modes) {
              controlContext = {
                ...controlContext,
                modes: { ...controlContext.modes, currentModeId: resolved.modeId },
              };
            }
          }
        }
        return;
      }
      const res = await client.setConfigOption({ sessionId, configId, value });
      controlContext = { ...controlContext, configOptions: res.configOptions };
    },
    async closeSession(sessionId) {
      await client.closeSession(sessionId);
    },
    async shutdown() {
      await client.close();
    },
    onUpdate(cb) {
      updateCb = cb;
    },
    onPermission(cb) {
      permCb = cb;
    },
  };
}

export { sameDir as plainSameDir };

