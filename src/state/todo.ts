export const OMA_TODO_MCP_SERVER_NAME = 'oma_todo';
export const OMA_TODO_TOOL_NAME = 'todo';
export const OMA_TODO_EXPOSED_TOOL_NAME = `mcp_${OMA_TODO_MCP_SERVER_NAME}_${OMA_TODO_TOOL_NAME}`;
export const TODO_AUTO_CLEAR_DELAY_MS = 60_000;

export const OMA_TODO_TOOL_DESCRIPTION = [
  'Write or update the session todo list displayed live in the user HUD (ops: init, start, done, drop, append, rm, view).',
  'NEVER spend a separate turn on this tool: emit it in the same parallel tool-call batch alongside your next real tool call (`init` beside your first read/search/command, `done`/`start` beside the next action or verification).',
  'Before or as soon as work involves 3+ steps/tool calls, multi-file changes, build/test/deploy flows, multi-source investigation, or multi-item requests, call `init` (and `init` mid-turn whenever a task expands beyond 2 steps). List every requested item separately.',
  'Reference tasks verbatim by exact task text, NEVER synthetic IDs (like task-1). Lost text: call `view`, never guess.',
  'After each completed step, mark it `done` immediately alongside the next tool call. Auto-advance keeps one task `in_progress` in phase order.',
].join('\n');

export const OMA_TODO_SYSTEM_PROMPT_APPEND = [
  '<todo_tracking>',
  `You have the mandatory session progress tracker \`${OMA_TODO_EXPOSED_TOOL_NAME}\`, which renders live phases and checklist status above the user HUD.`,
  '',
  'When to call:',
  `- MUST call \`${OMA_TODO_EXPOSED_TOOL_NAME}\` with \`op="init"\` for any task expected to take 3+ steps or tool calls — including coding, refactoring, debugging, config/version updates, build/test/deployment, multi-source research, plan execution, or multi-item requests.`,
  '- Mid-turn escalation: if a task starts as a quick check and expands beyond 2 tool calls, call `op="init"` alongside your next tool call.',
  '- Follow-up turns: when the previous list is finished or empty and the user sends a new multi-step request, call `op="init"` to start a fresh list.',
  '- Skip ONLY for single-turn answers, translations, or 1–2 step read-only lookups.',
  '',
  'How to call (zero extra turns):',
  '- NEVER spend a turn calling only this tool. Batch `op="init"` in parallel alongside your first `read_file`/`run_command`/`search_web` call, and batch `op="done"`/`op="start"` alongside the next action or verification call.',
  '- Use `list: [{ phase, items }]` (or flat `items: [...]`) for `init`; list every user-requested item separately.',
  '- Always reference tasks verbatim by their exact task text (never synthetic IDs like `task-1`); if unsure, call `op="view"`.',
  '- Keep at most one task `in_progress` at a time (`done` auto-advances to the next pending task), and mark all remaining tasks `done` or `drop` before finishing.',
  '</todo_tracking>',
].join('\n');

export const TODO_HELP_TEXT = [
  'Usage: /todo [subcommand] [args]',
  '  /todo                              Show current todos',
  '  /todo edit                         Open todos in $EDITOR',
  '  /todo copy                         Copy todos as Markdown to clipboard',
  '  /todo expand                       Show every phase and task in the HUD',
  '  /todo collapse                     Restore the collapsed completed-phase HUD view',
  '  /todo export [<path>]              Write todos to file (default: TODO.md)',
  '  /todo import [<path>]              Replace todos from file (default: TODO.md)',
  '  /todo append [<phase>] <task...>   Append a task (quote a new phase: /todo append "Phase" task)',
  '  /todo start  <task>                Mark task in_progress (fuzzy content match)',
  '  /todo done   [<task|phase>]        Mark task/phase/all completed',
  '  /todo drop   [<task|phase>]        Mark task/phase/all abandoned',
  '  /todo rm     [<task|phase>]        Remove task/phase/all (alias: clear)',
].join('\n');

export type TodoTaskStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned';
export type TodoChecklistStatus = 'pending' | 'active' | 'done' | 'dropped';
export type TodoOp = 'init' | 'start' | 'done' | 'rm' | 'drop' | 'append' | 'view';

export interface TodoTask {
  content: string;
  status: TodoTaskStatus;
  note?: string;
}

export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

export interface TodoChecklistItem {
  readonly id: string;
  readonly text: string;
  readonly note?: string;
  readonly status: TodoChecklistStatus;
}

export interface TodoChecklistPhase {
  readonly id: string;
  readonly title: string;
  readonly items: readonly TodoChecklistItem[];
  readonly collapsed?: boolean;
}

export interface TodoCompletedDelta {
  readonly phase: string;
  readonly content: string;
}

export interface TodoOperationResult {
  readonly op: TodoOp;
  readonly phases: TodoPhase[];
  readonly errors: string[];
  readonly isError: boolean;
  readonly completedTasks: TodoCompletedDelta[];
  readonly text: string;
}

const VALID_OPS = new Set<TodoOp>(['init', 'start', 'done', 'rm', 'drop', 'append', 'view']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseStringOrArray(value: unknown): { readonly values: string[]; readonly invalid: boolean } {
  if (value === undefined) return { values: [], invalid: false };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? { values: [trimmed], invalid: false } : { values: [], invalid: true };
  }
  if (Array.isArray(value)) {
    const values: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        return { values: [], invalid: true };
      }
      values.push(entry.trim());
    }
    return { values, invalid: false };
  }
  return { values: [], invalid: true };
}

/**
 * Recognizes tool calls targeting `oma`'s embedded `todo` MCP tool regardless of ACP
 * transport formatting (`mcp_oma_todo_todo`, `oma_todo:todo`, or `"Run mcp_oma_todo_todo"`).
 * Bare `'todo'` is excluded so external third-party MCP tools keep normal permission & rendering flow.
 */
export function isOmaTodoToolName(rawName?: string, title?: string): boolean {
  const n = rawName?.trim().toLowerCase() ?? '';
  if (
    n === OMA_TODO_EXPOSED_TOOL_NAME ||
    n === `${OMA_TODO_MCP_SERVER_NAME}:${OMA_TODO_TOOL_NAME}` ||
    n === `${OMA_TODO_MCP_SERVER_NAME}/${OMA_TODO_TOOL_NAME}` ||
    n === `${OMA_TODO_MCP_SERVER_NAME}__${OMA_TODO_TOOL_NAME}`
  ) {
    return true;
  }
  const t = title?.trim().toLowerCase() ?? '';
  return (
    t === OMA_TODO_EXPOSED_TOOL_NAME ||
    t === `run ${OMA_TODO_EXPOSED_TOOL_NAME}` ||
    t === `${OMA_TODO_MCP_SERVER_NAME}:${OMA_TODO_TOOL_NAME}` ||
    t === `${OMA_TODO_MCP_SERVER_NAME}/${OMA_TODO_TOOL_NAME}` ||
    t === `${OMA_TODO_MCP_SERVER_NAME}__${OMA_TODO_TOOL_NAME}`
  );
}

export function isTodoTaskFinished(task: Pick<TodoTask, 'status'>): boolean {
  return task.status === 'completed' || task.status === 'abandoned';
}

export function areAllTodosFinished(phases: readonly TodoPhase[]): boolean {
  let count = 0;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      count += 1;
      if (!isTodoTaskFinished(task)) {
        return false;
      }
    }
  }
  return count > 0;
}

export function cloneTodoPhases(phases: readonly TodoPhase[]): TodoPhase[] {
  return phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task) => ({
      content: task.content,
      status: task.status,
      ...(task.note !== undefined ? { note: task.note } : {}),
    })),
  }));
}

/**
 * Ensures at most one task is `in_progress` across all phases; if none is active,
 * auto-advances the earliest `pending` task to `in_progress` (matching `omp`).
 */
export function normalizeSingleInProgress(phases: TodoPhase[]): void {
  const flat = phases.flatMap((phase) => phase.tasks);
  if (flat.length === 0) return;

  const active = flat.filter((task) => task.status === 'in_progress');
  if (active.length > 1) {
    for (const extra of active.slice(1)) {
      extra.status = 'pending';
    }
  }
  if (active.length > 0) return;

  const firstPending = flat.find((task) => task.status === 'pending');
  if (firstPending) {
    firstPending.status = 'in_progress';
  }
}

export function findExactTask(
  phases: TodoPhase[],
  content: string,
): { phase: TodoPhase; task: TodoTask } | undefined {
  for (const phase of phases) {
    const task = phase.tasks.find((item) => item.content === content);
    if (task) {
      return { phase, task };
    }
  }
  return undefined;
}

function formatMissingTaskError(phases: readonly TodoPhase[], target: string): string {
  if (/^task-\d+$/i.test(target)) {
    return `Task "${target}" not found. Tasks are referenced by content, not by IDs — pass the task's full text from the previous result.`;
  }
  const total = phases.reduce((sum, phase) => sum + phase.tasks.length, 0);
  const hint = total === 0 ? ' (todo list is empty — was it replaced or not yet created?)' : '';
  return `Task "${target}" not found.${hint}`;
}

function collectCompletedDelta(
  before: readonly TodoPhase[],
  after: readonly TodoPhase[],
): TodoCompletedDelta[] {
  const prevStatus = new Map<string, TodoTaskStatus>();
  for (const phase of before) {
    for (const task of phase.tasks) {
      prevStatus.set(`${phase.name}\u0000${task.content}`, task.status);
    }
  }
  const completed: TodoCompletedDelta[] = [];
  for (const phase of after) {
    for (const task of phase.tasks) {
      if (task.status !== 'completed') continue;
      const prior = prevStatus.get(`${phase.name}\u0000${task.content}`);
      if (prior && prior !== 'completed') {
        completed.push({ phase: phase.name, content: task.content });
      }
    }
  }
  return completed;
}

export function formatTodoResult(
  phases: readonly TodoPhase[],
  errors: readonly string[] = [],
  isView = false,
): string {
  const flat = phases.flatMap((phase) => phase.tasks);
  if (flat.length === 0) {
    if (errors.length > 0) {
      return `Errors: ${errors.join('; ')}`;
    }
    return isView ? 'Todo list is empty.' : 'Todo list cleared.';
  }

  const openPhases = phases
    .map((phase) => ({
      name: phase.name,
      tasks: phase.tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress'),
    }))
    .filter((phase) => phase.tasks.length > 0);
  const remaining = openPhases.flatMap((phase) =>
    phase.tasks.map((task) => ({ ...task, phase: phase.name })),
  );

  let activeIdx = phases.findIndex((phase) =>
    phase.tasks.some((task) => task.status === 'in_progress'),
  );
  if (activeIdx === -1) {
    activeIdx = phases.findIndex((phase) =>
      phase.tasks.some((task) => task.status === 'pending'),
    );
  }
  if (activeIdx === -1) {
    activeIdx = phases.length - 1;
  }

  const activePhase = phases[activeIdx]!;
  const activeDoneCount = activePhase.tasks.filter(isTodoTaskFinished).length;
  const doneCount = flat.filter(isTodoTaskFinished).length;
  const hasLaterWork = phases.some(
    (phase, idx) => idx > activeIdx && phase.tasks.some(isTodoTaskFinished),
  );

  const lines: string[] = [];
  if (errors.length > 0) {
    lines.push(`Errors: ${errors.join('; ')}`);
  }
  if (remaining.length === 0) {
    lines.push('Remaining items: none.');
  } else {
    lines.push(`Remaining items (${remaining.length}):`);
    for (const item of remaining) {
      lines.push(`  - ${item.content} [${item.status}] (${item.phase})`);
    }
  }

  lines.push(`Overall: ${doneCount}/${flat.length} done, ${remaining.length} open.`);
  lines.push(
    `Active phase ${activeIdx + 1}/${phases.length} "${activePhase.name}" (${activeDoneCount}/${activePhase.tasks.length})${
      hasLaterWork
        ? ' — the in-progress pointer auto-advances to the earliest open task on each completion, so it can sit behind out-of-order work (nothing was un-completed).'
        : '.'
    }`,
  );

  for (const phase of phases) {
    lines.push(`  ${phase.name}:`);
    for (const task of phase.tasks) {
      const box = task.status === 'completed' ? '[X]' : '[ ]';
      const suffix =
        task.status === 'in_progress'
          ? ' (in progress)'
          : task.status === 'abandoned'
            ? ' (dropped)'
            : '';
      lines.push(`    - ${box} ${task.content}${suffix}`);
    }
  }

  return lines.join('\n');
}

function buildErrorResult(
  op: TodoOp,
  current: TodoPhase[],
  errors: string[],
): TodoOperationResult {
  return {
    op,
    phases: current,
    errors,
    isError: true,
    completedTasks: [],
    text: formatTodoResult(current, errors, op === 'view'),
  };
}

/**
 * Pure reducer applying one `todo` tool invocation against the session's current phases.
 * Boundary-validates untrusted `rawArgs` from ACP / MCP callers.
 */
export function applyTodoOperation(
  current: readonly TodoPhase[],
  rawArgs: unknown,
): TodoOperationResult {
  const baseline = cloneTodoPhases(current);
  if (!isRecord(rawArgs)) {
    const errors = ['Invalid todo arguments: expected an object with "op".'];
    return buildErrorResult('view', baseline, errors);
  }

  const rawOp = typeof rawArgs.op === 'string' ? rawArgs.op.trim().toLowerCase() : '';
  if (!VALID_OPS.has(rawOp as TodoOp)) {
    const errors = [
      `Invalid todo op ${JSON.stringify(rawArgs.op ?? null)}. Expected one of: init, start, done, rm, drop, append, view.`,
    ];
    return buildErrorResult('view', baseline, errors);
  }

  const op = rawOp as TodoOp;
  if (op === 'view') {
    return {
      op,
      phases: baseline,
      errors: [],
      isError: false,
      completedTasks: [],
      text: formatTodoResult(baseline, [], true),
    };
  }

  const note = nonEmptyString(rawArgs.note);
  const errors: string[] = [];
  let next = cloneTodoPhases(baseline);

  if (op === 'init') {
    const rebuilt: TodoPhase[] = [];
    const seenPhases = new Set<string>();
    const seenTasks = new Set<string>();

    if (Array.isArray(rawArgs.list) && rawArgs.list.length > 0) {
      for (const entry of rawArgs.list) {
        if (!isRecord(entry)) {
          errors.push('Invalid list phase entry in init operation.');
          continue;
        }
        const phaseName = nonEmptyString(entry.phase);
        if (!phaseName) {
          errors.push('Missing phase name in init list.');
          continue;
        }
        if (seenPhases.has(phaseName)) {
          errors.push(`Duplicate phase "${phaseName}" in init list.`);
          continue;
        }
        const itemsParsed = parseStringOrArray(entry.items);
        if (itemsParsed.invalid || !Array.isArray(entry.items) || itemsParsed.values.length === 0) {
          errors.push(`Phase "${phaseName}" needs at least one task item.`);
          continue;
        }
        seenPhases.add(phaseName);
        const tasks: TodoTask[] = [];
        for (const content of itemsParsed.values) {
          if (seenTasks.has(content)) {
            errors.push(`Duplicate task "${content}" in init list.`);
            continue;
          }
          seenTasks.add(content);
          tasks.push({ content, status: 'pending' });
        }
        if (tasks.length > 0) {
          rebuilt.push({ name: phaseName, tasks });
        }
      }
    } else if (Array.isArray(rawArgs.items) && rawArgs.items.length > 0) {
      const itemsParsed = parseStringOrArray(rawArgs.items);
      if (itemsParsed.invalid || itemsParsed.values.length === 0) {
        errors.push('Invalid items array for init operation.');
      } else {
        const phaseName = nonEmptyString(rawArgs.phase) ?? 'Todos';
        const tasks: TodoTask[] = [];
        for (const content of itemsParsed.values) {
          if (seenTasks.has(content)) {
            errors.push(`Duplicate task "${content}" in init list.`);
            continue;
          }
          seenTasks.add(content);
          tasks.push({ content, status: 'pending' });
        }
        if (tasks.length > 0) {
          rebuilt.push({ name: phaseName, tasks });
        }
      }
    } else {
      errors.push('Missing list for init operation');
    }

    if (errors.length > 0) {
      return buildErrorResult(op, baseline, errors);
    }
    normalizeSingleInProgress(rebuilt);
    next = rebuilt;
  } else if (op === 'append') {
    const itemsParsed =
      rawArgs.items !== undefined
        ? parseStringOrArray(rawArgs.items)
        : parseStringOrArray(rawArgs.task);
    if (itemsParsed.invalid || itemsParsed.values.length === 0) {
      return buildErrorResult(op, baseline, ['Missing items for append operation']);
    }

    const phaseArg = nonEmptyString(rawArgs.phase);
    let targetPhase: TodoPhase;
    if (phaseArg) {
      const existingPhase =
        next.find((p) => p.name === phaseArg) ?? findTodoPhaseFuzzy(next, phaseArg);
      if (existingPhase) {
        targetPhase = existingPhase;
      } else {
        targetPhase = { name: phaseArg, tasks: [] };
        next.push(targetPhase);
      }
    } else {
      const lastPhase = next[next.length - 1];
      if (lastPhase) {
        targetPhase = lastPhase;
      } else {
        targetPhase = { name: 'Todos', tasks: [] };
        next.push(targetPhase);
      }
    }

    for (const content of itemsParsed.values) {
      if (findExactTask(next, content)) {
        errors.push(`Duplicate task "${content}".`);
        continue;
      }
      targetPhase.tasks.push({
        content,
        status: 'pending',
        ...(note !== undefined ? { note } : {}),
      });
    }
    if (errors.length > 0) {
      return buildErrorResult(op, baseline, errors);
    }
    normalizeSingleInProgress(next);
  } else if (op === 'start') {
    if (Array.isArray(rawArgs.task)) {
      return buildErrorResult(op, baseline, [
        'start takes a single task: only one task can be in progress',
      ]);
    }
    const target = nonEmptyString(rawArgs.task);
    if (!target) {
      return buildErrorResult(op, baseline, ['Missing task content']);
    }
    const found = findExactTask(next, target);
    if (!found) {
      return buildErrorResult(op, baseline, [formatMissingTaskError(next, target)]);
    }
    for (const phase of next) {
      for (const item of phase.tasks) {
        if (item.status === 'in_progress' && item !== found.task) {
          item.status = 'pending';
        }
      }
    }
    found.task.status = 'in_progress';
    if (note !== undefined) {
      found.task.note = note;
    }
  } else if (op === 'done' || op === 'drop') {
    const nextStatus: TodoTaskStatus = op === 'done' ? 'completed' : 'abandoned';
    const targetsRaw = rawArgs.task !== undefined ? rawArgs.task : rawArgs.items;
    const taskParsed = parseStringOrArray(targetsRaw);
    const phaseArg = nonEmptyString(rawArgs.phase);
    if (taskParsed.invalid) {
      return buildErrorResult(op, baseline, [`${op} received invalid task target`]);
    }

    if (taskParsed.values.length > 0) {
      for (const content of taskParsed.values) {
        const found = findExactTask(next, content);
        if (!found) {
          errors.push(formatMissingTaskError(next, content));
          continue;
        }
        found.task.status = nextStatus;
        if (note !== undefined) {
          found.task.note = note;
        }
      }
    } else if (phaseArg) {
      const targetPhase = next.find((p) => p.name === phaseArg) ?? findTodoPhaseFuzzy(next, phaseArg);
      if (!targetPhase) {
        errors.push(`Phase "${phaseArg}" not found.`);
      } else {
        for (const item of targetPhase.tasks) {
          if (isTodoTaskFinished(item)) continue;
          item.status = nextStatus;
          if (note !== undefined) {
            item.note = note;
          }
        }
      }
    } else {
      errors.push(`${op} needs a task, items or a phase`);
    }

    if (errors.length > 0) {
      return buildErrorResult(op, baseline, errors);
    }
    normalizeSingleInProgress(next);
  } else if (op === 'rm') {
    const targetsRaw = rawArgs.task !== undefined ? rawArgs.task : rawArgs.items;
    const taskParsed = parseStringOrArray(targetsRaw);
    const phaseArg = nonEmptyString(rawArgs.phase);
    if (taskParsed.invalid) {
      return buildErrorResult(op, baseline, ['rm received invalid task target']);
    }

    if (taskParsed.values.length > 0) {
      for (const content of taskParsed.values) {
        const found = findExactTask(next, content);
        if (!found) {
          errors.push(formatMissingTaskError(next, content));
          continue;
        }
        found.phase.tasks = found.phase.tasks.filter((item) => item !== found.task);
      }
      next = next.filter((phase) => phase.tasks.length > 0);
    } else if (phaseArg) {
      const targetPhase = next.find((p) => p.name === phaseArg) ?? findTodoPhaseFuzzy(next, phaseArg);
      if (!targetPhase) {
        errors.push(`Phase "${phaseArg}" not found.`);
      } else {
        next = next.filter((phase) => phase !== targetPhase);
      }
    } else {
      errors.push('rm needs a task, items or a phase');
    }

    if (errors.length > 0) {
      return buildErrorResult(op, baseline, errors);
    }
    normalizeSingleInProgress(next);
  }

  const completedTasks = collectCompletedDelta(baseline, next);
  return {
    op,
    phases: next,
    errors: [],
    isError: false,
    completedTasks,
    text: formatTodoResult(next, [], false),
  };
}

const MARKDOWN_CHECKBOX_BY_STATUS: Readonly<Record<TodoTaskStatus, string>> = {
  pending: ' ',
  in_progress: '/',
  completed: 'x',
  abandoned: '-',
};

const STATUS_BY_MARKDOWN_MARKER: Readonly<Record<string, TodoTaskStatus>> = {
  ' ': 'pending',
  '': 'pending',
  x: 'completed',
  X: 'completed',
  '/': 'in_progress',
  '>': 'in_progress',
  '-': 'abandoned',
  '~': 'abandoned',
};

export function formatTodoMarkdown(phases: readonly TodoPhase[]): string {
  if (phases.length === 0) {
    return '# Todos\n';
  }
  const lines: string[] = [];
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]!;
    if (i > 0) lines.push('');
    lines.push(`# ${phase.name}`);
    for (const task of phase.tasks) {
      lines.push(`- [${MARKDOWN_CHECKBOX_BY_STATUS[task.status]}] ${task.content}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function parseTodoMarkdown(markdown: string): { phases: TodoPhase[]; errors: string[] } {
  const errors: string[] = [];
  const phases: TodoPhase[] = [];
  const seenTasks = new Set<string>();
  let currentPhase: TodoPhase | undefined;

  const lines = markdown.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) continue;

    const headingMatch = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
    if (headingMatch) {
      currentPhase = { name: headingMatch[1]!.trim(), tasks: [] };
      phases.push(currentPhase);
      continue;
    }

    const itemMatch = /^[-*+]\s*\\?\[(.?)\\?\]\s+(.+?)\s*$/.exec(trimmed);
    if (itemMatch) {
      if (!currentPhase) {
        currentPhase = { name: 'Todos', tasks: [] };
        phases.push(currentPhase);
      }
      const marker = itemMatch[1] ?? '';
      const status = STATUS_BY_MARKDOWN_MARKER[marker];
      if (!status) {
        errors.push(`Line ${i + 1}: unknown status marker "[${marker}]" (use [ ], [x], [/], [-])`);
        continue;
      }
      const content = itemMatch[2]!.trim();
      if (seenTasks.has(content)) {
        errors.push(`Line ${i + 1}: duplicate task "${content}"`);
        continue;
      }
      seenTasks.add(content);
      currentPhase.tasks.push({
        content,
        status,
      });
      continue;
    }

    errors.push(`Line ${i + 1}: unrecognized syntax "${trimmed}"`);
  }

  const nonEmpty = phases.filter((phase) => phase.tasks.length > 0);
  normalizeSingleInProgress(nonEmpty);
  return { phases: nonEmpty, errors };
}

export function findTodoPhaseFuzzy<T extends { name: string }>(
  phases: readonly T[],
  query: string,
): T | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;

  const exact = phases.find((p) => p.name.toLowerCase() === needle);
  if (exact) return exact;

  const prefix = phases.filter((p) => p.name.toLowerCase().startsWith(needle));
  if (prefix.length === 1) return prefix[0];

  const sub = phases.filter((p) => p.name.toLowerCase().includes(needle));
  if (sub.length === 1) return sub[0];

  return undefined;
}

export function findTodoTaskFuzzy(
  phases: readonly TodoPhase[],
  query: string,
): { phase: TodoPhase; task: TodoTask } | undefined {
  const needle = query.trim().toLowerCase();
  if (!needle) return undefined;

  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.content.toLowerCase() === needle) {
        return { phase, task };
      }
    }
  }

  const matches: Array<{ phase: TodoPhase; task: TodoTask }> = [];
  for (const phase of phases) {
    for (const task of phase.tasks) {
      if (task.content.toLowerCase().includes(needle)) {
        matches.push({ phase, task });
      }
    }
  }
  if (matches.length === 1) return matches[0];

  const openMatches = matches.filter(
    (entry) => entry.task.status === 'in_progress' || entry.task.status === 'pending',
  );
  if (openMatches.length === 1) return openMatches[0];

  return undefined;
}

export function formatPhaseDisplayTitle(rawName: string): string {
  return rawName
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

export function formatUserTodoSyncReminder(
  reason: string,
  phases: readonly TodoPhase[],
  removed = false,
): string {
  const rendered = phases.length === 0 ? '(empty)' : formatTodoMarkdown(phases).trimEnd();
  const lines = ['<system-reminder>', `The user manually modified the todo list (${reason}).`];
  if (removed) {
    lines.push(
      phases.length === 0
        ? 'The user cleared the previous todo list. Do NOT re-add those old cleared items; for the current turn, only create a new todo list if starting a new multi-step task or the user asks.'
        : 'The user intentionally removed the entries no longer shown below. Do NOT re-add those removed items unless the user explicitly asks.',
    );
  }
  lines.push('Current todo list:', '', rendered, '</system-reminder>');
  return lines.join('\n');
}

export interface ExtractedUserTodoSyncReminder {
  readonly strippedText: string;
  readonly hasReminder: boolean;
  readonly phases?: TodoPhase[];
}

const LEADING_OMA_TODO_REMINDER_RE =
  /^\s*<system-reminder>\r?\nThe user manually modified the todo list \([^\r\n]*\)\.\r?\n[\s\S]*?Current todo list:\r?\n\r?\n([\s\S]*?)\r?\n<\/system-reminder>[ \t]*(?:\r?\n)*/;

/**
 * Strip leading `oma`-injected `<system-reminder>` todo-sync blocks from replayed
 * `user_message_chunk` text and recover their embedded Markdown todo snapshot.
 */
export function extractUserTodoSyncReminderFromText(
  text: string,
): ExtractedUserTodoSyncReminder {
  let remaining = text;
  let hasReminder = false;
  let latestPhases: TodoPhase[] | undefined;

  while (true) {
    const match = LEADING_OMA_TODO_REMINDER_RE.exec(remaining);
    if (!match) break;
    hasReminder = true;
    const body = (match[1] ?? '').trim();
    if (body === '(empty)') {
      latestPhases = [];
    } else {
      const parsed = parseTodoMarkdown(body);
      if (parsed.errors.length === 0) {
        latestPhases = parsed.phases;
      }
    }
    remaining = remaining.slice(match[0].length);
  }

  return {
    strippedText: remaining,
    hasReminder,
    ...(latestPhases !== undefined ? { phases: latestPhases } : {}),
  };
}

export function mapTodoStatusToChecklist(status: TodoTaskStatus): TodoChecklistStatus {
  switch (status) {
    case 'completed':
      return 'done';
    case 'abandoned':
      return 'dropped';
    case 'in_progress':
      return 'active';
    case 'pending':
    default:
      return 'pending';
  }
}

export function mapTodoPhasesToChecklist(
  phases: readonly TodoPhase[],
  options: { readonly expanded?: boolean } = {},
): TodoChecklistPhase[] {
  const expanded = options.expanded === true;
  const nonEmpty = phases.filter((phase) => phase.tasks.length > 0);
  return nonEmpty.map((phase, pIdx) => ({
    id: `p${pIdx}`,
    title: nonEmpty.length > 1 ? `${pIdx + 1}. ${phase.name}` : phase.name,
    ...(expanded || !phase.tasks.every(isTodoTaskFinished) ? {} : { collapsed: true }),
    items: phase.tasks.map((task, tIdx) => ({
      id: `p${pIdx}.${tIdx}`,
      text: task.content,
      ...(task.note !== undefined ? { note: task.note } : {}),
      status: mapTodoStatusToChecklist(task.status),
    })),
  }));
}
