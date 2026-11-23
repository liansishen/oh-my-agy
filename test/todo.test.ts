import { afterEach, describe, expect, test } from 'bun:test';
import { EmbeddedTodoMcpServer, type TodoServerUpdateEvent } from '../src/mcp/todo_server';
import {
  applyTodoOperation,
  areAllTodosFinished,
  extractUserTodoSyncReminderFromText,
  findTodoPhaseFuzzy,
  findTodoTaskFuzzy,
  formatTodoMarkdown,
  formatUserTodoSyncReminder,
  isOmaTodoToolName,
  mapTodoPhasesToChecklist,
  OMA_TODO_EXPOSED_TOOL_NAME,
  OMA_TODO_SYSTEM_PROMPT_APPEND,
  OMA_TODO_TOOL_DESCRIPTION,
  parseTodoMarkdown,
  type TodoPhase,
} from '../src/state/todo';

describe('todo state machine', () => {
  test('recognizes embedded todo tool name variants strictly without bare todo collision', () => {
    expect(isOmaTodoToolName(OMA_TODO_EXPOSED_TOOL_NAME)).toBe(true);
    expect(isOmaTodoToolName('oma_todo:todo')).toBe(true);
    expect(isOmaTodoToolName('oma_todo/todo')).toBe(true);
    expect(isOmaTodoToolName('oma_todo__todo')).toBe(true);
    expect(isOmaTodoToolName(undefined, 'Run mcp_oma_todo_todo')).toBe(true);
    expect(isOmaTodoToolName('todo')).toBe(false);
    expect(isOmaTodoToolName(undefined, 'Todo')).toBe(false);
    expect(isOmaTodoToolName('run_command', 'Run echo todo')).toBe(false);
  });

  test('supports multi-phase init, start, done auto-advance across phases, drop, rm, and view', () => {
    const initRes = applyTodoOperation([], {
      op: 'init',
      list: [
        { phase: 'Foundation', items: ['Scaffold schema', 'Wire store'] },
        { phase: 'UI', items: ['Render HUD', 'Add tests'] },
      ],
      toolSummary: 'Initialize plan',
    });
    expect(initRes.isError).toBe(false);
    expect(initRes.phases).toHaveLength(2);
    expect(initRes.phases[0]?.tasks[0]?.status).toBe('in_progress');
    expect(initRes.phases[0]?.tasks[1]?.status).toBe('pending');
    expect(initRes.text).toContain('Overall: 0/4 done, 4 open.');

    // Complete first task -> auto-advances to second task
    const done1 = applyTodoOperation(initRes.phases, { op: 'done', task: 'Scaffold schema' });
    expect(done1.isError).toBe(false);
    expect(done1.completedTasks).toEqual([{ phase: 'Foundation', content: 'Scaffold schema' }]);
    expect(done1.phases[0]?.tasks[0]?.status).toBe('completed');
    expect(done1.phases[0]?.tasks[1]?.status).toBe('in_progress');

    // Explicitly start a later task -> demotes current active task
    const started = applyTodoOperation(done1.phases, {
      op: 'start',
      task: 'Add tests',
      note: 'verifying',
    });
    expect(started.isError).toBe(false);
    expect(started.phases[0]?.tasks[1]?.status).toBe('pending');
    expect(started.phases[1]?.tasks[1]?.status).toBe('in_progress');
    expect(started.phases[1]?.tasks[1]?.note).toBe('verifying');

    // View preserves state
    const viewed = applyTodoOperation(started.phases, { op: 'view' });
    expect(viewed.isError).toBe(false);
    expect(viewed.phases).toEqual(started.phases);
    expect(viewed.text).toContain('Remaining items (3):');

    // Finish phase 1 + drop last item -> auto-advances across phases cleanly
    const done2 = applyTodoOperation(started.phases, { op: 'done', task: ['Wire store', 'Add tests'] });
    expect(done2.phases[1]?.tasks[0]?.status).toBe('in_progress');

    const dropped = applyTodoOperation(done2.phases, { op: 'drop', task: 'Render HUD' });
    expect(areAllTodosFinished(dropped.phases)).toBe(true);
    expect(dropped.text).toContain('Remaining items: none.');

    // Remove a whole phase cleanly
    const removedPhase = applyTodoOperation(dropped.phases, { op: 'rm', phase: 'UI' });
    expect(removedPhase.isError).toBe(false);
    expect(removedPhase.phases.map(p => p.name)).toEqual(['Foundation']);
  });

  test('validates invalid arguments, duplicate items, and task-N synthetic ID errors', () => {
    const init = applyTodoOperation([], { op: 'init', items: ['Step 1', 'Step 2'] });
    expect(init.phases[0]?.name).toBe('Todos');
    expect(init.phases[0]?.tasks[0]?.status).toBe('in_progress');

    const badId = applyTodoOperation(init.phases, { op: 'done', task: 'task-1' });
    expect(badId.isError).toBe(true);
    expect(badId.text).toContain('Tasks are referenced by content, not by IDs');

    const arrayStart = applyTodoOperation(init.phases, { op: 'start', task: ['Step 1', 'Step 2'] });
    expect(arrayStart.isError).toBe(true);
    expect(arrayStart.text).toContain('single task');

    const dupAppend = applyTodoOperation(init.phases, { op: 'append', items: ['Step 1'] });
    expect(dupAppend.isError).toBe(true);
    expect(dupAppend.text).toContain('Duplicate task');

    const badOp = applyTodoOperation(init.phases, { op: 'bogus' });
    expect(badOp.isError).toBe(true);

    // done / drop support `items` alias and phase completion skips already-finished entries
    const doneViaItems = applyTodoOperation(init.phases, { op: 'done', items: ['Step 1'] });
    expect(doneViaItems.isError).toBe(false);
    expect(doneViaItems.phases[0]?.tasks[0]?.status).toBe('completed');

    const droppedPre = applyTodoOperation(init.phases, { op: 'drop', task: 'Step 1' });
    const phaseDone = applyTodoOperation(droppedPre.phases, { op: 'done', phase: 'Todos' });
    expect(phaseDone.isError).toBe(false);
    expect(phaseDone.phases[0]?.tasks[0]?.status).toBe('abandoned');
    expect(phaseDone.phases[0]?.tasks[1]?.status).toBe('completed');
  });

  test('round-trips Markdown, rejects duplicate Markdown tasks, strips reminders, and numbers non-empty checklist phases only', () => {
    const sample: TodoPhase[] = [
      {
        name: 'Setup',
        tasks: [
          { content: 'Create module', status: 'completed' },
          { content: 'Deprecated stub', status: 'abandoned' },
        ],
      },
      {
        name: 'Build',
        tasks: [
          { content: 'Implement server', status: 'in_progress', note: 'http' },
          { content: 'Write tests', status: 'pending' },
        ],
      },
    ];

    const md = formatTodoMarkdown(sample);
    expect(md).toContain('# Setup');
    expect(md).toContain('- [x] Create module');
    expect(md).toContain('- [-] Deprecated stub');
    expect(md).toContain('- [/] Implement server');
    expect(md).toContain('- [ ] Write tests');

    const parsed = parseTodoMarkdown(md);
    expect(parsed.errors).toEqual([]);
    expect(parsed.phases[0]?.tasks[0]?.status).toBe('completed');
    expect(parsed.phases[0]?.tasks[1]?.status).toBe('abandoned');
    expect(parsed.phases[1]?.tasks[0]?.status).toBe('in_progress');
    expect(parsed.phases[1]?.tasks[1]?.status).toBe('pending');

    const dupParsed = parseTodoMarkdown('# P1\n- [ ] Dup task\n# P2\n- [ ] Dup task\n');
    expect(dupParsed.errors.length).toBeGreaterThan(0);
    expect(dupParsed.errors[0]).toContain('duplicate task');

    expect(findTodoPhaseFuzzy(sample, 'bui')?.name).toBe('Build');
    expect(findTodoTaskFuzzy(sample, 'server')?.task.content).toBe('Implement server');

    const collapsed = mapTodoPhasesToChecklist(sample, { expanded: false });
    expect(collapsed[0]?.collapsed).toBe(true);
    expect(collapsed[0]?.items[1]?.status).toBe('dropped');
    expect(collapsed[1]?.collapsed).toBeUndefined();
    expect(collapsed[1]?.items[0]?.status).toBe('active');
    expect(collapsed[1]?.items[0]?.note).toBe('http');

    const withEmptyPhase = mapTodoPhasesToChecklist([
      { name: 'Empty', tasks: [] },
      { name: 'Only', tasks: [{ content: 'Do work', status: 'pending' }] },
    ]);
    expect(withEmptyPhase).toHaveLength(1);
    expect(withEmptyPhase[0]?.title).toBe('Only');

    const expanded = mapTodoPhasesToChecklist(sample, { expanded: true });
    expect(expanded[0]?.collapsed).toBeUndefined();

    const clearedReminder = formatUserTodoSyncReminder('/todo rm (all)', [], true);
    expect(clearedReminder).toContain('<system-reminder>');
    expect(clearedReminder).toContain('cleared the previous todo list');
    expect(clearedReminder).toContain('only create a new todo list if starting a new multi-step task');

    const extractedCleared = extractUserTodoSyncReminderFromText(
      `${clearedReminder}\n\nContinue task`
    );
    expect(extractedCleared.hasReminder).toBe(true);
    expect(extractedCleared.strippedText).toBe('Continue task');
    expect(extractedCleared.phases).toEqual([]);

    const unrelated = '<system-reminder>\nOther note\n</system-reminder>\nUser prompt';
    const extractedOther = extractUserTodoSyncReminderFromText(unrelated);
    expect(extractedOther.hasReminder).toBe(false);
    expect(extractedOther.strippedText).toBe(unrelated);

    const trailingReminder = formatUserTodoSyncReminder('/todo done', sample, false);
    const extractedTrailing = extractUserTodoSyncReminderFromText(
      `/plan build feature\n\n${trailingReminder}`
    );
    expect(extractedTrailing.hasReminder).toBe(true);
    expect(extractedTrailing.strippedText).toBe('/plan build feature');
    expect(extractedTrailing.phases).toEqual(parsed.phases);
  });
});

describe('EmbeddedTodoMcpServer', () => {
  const servers: EmbeddedTodoMcpServer[] = [];

  afterEach(() => {
    while (servers.length > 0) {
      servers.pop()?.dispose();
    }
  });

  test('enforces secret token path, declares antigravity/alwaysLoad, and isolates sessions', async () => {
    const events: TodoServerUpdateEvent[] = [];
    const server = new EmbeddedTodoMcpServer({
      version: '0.2.0-test',
      onTodoChanged: event => events.push(event),
    });
    servers.push(server);

    const cfg = server.getMcpServerConfig();
    expect(cfg.type).toBe('http');
    expect(cfg.name).toBe('oma_todo');
    expect(typeof cfg.url).toBe('string');
    const url = new URL(cfg.url!);

    // Wrong path / well-known probes rejected with 404
    const wrongTokenRes = await fetch(`http://127.0.0.1:${url.port}/mcp/wrong`, {
      method: 'POST',
      body: '{}',
    });
    expect(wrongTokenRes.status).toBe(404);

    const wellKnownRes = await fetch(`http://127.0.0.1:${url.port}/.well-known/oauth-protected-resource`);
    expect(wellKnownRes.status).toBe(404);

    // server/discover -> -32601
    const discoverRes = await fetch(cfg.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
    });
    expect(discoverRes.status).toBe(200);
    const discoverJson = (await discoverRes.json()) as { error?: { code?: number } };
    expect(discoverJson.error?.code).toBe(-32601);

    // notifications/initialized -> 202
    const notifRes = await fetch(cfg.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
    });
    expect(notifRes.status).toBe(202);

    // tools/list includes alwaysLoad and readOnlyHint
    const listRes = await fetch(cfg.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    const listJson = (await listRes.json()) as {
      result: {
        tools: Array<{
          name: string;
          description?: string;
          annotations?: { readOnlyHint?: boolean };
          _meta?: Record<string, unknown>;
        }>;
      };
    };
    expect(listJson.result.tools).toHaveLength(1);
    expect(listJson.result.tools[0]?.name).toBe('todo');
    expect(listJson.result.tools[0]?.description).toBe(OMA_TODO_TOOL_DESCRIPTION);
    expect(OMA_TODO_TOOL_DESCRIPTION).toContain('parallel tool-call batch');
    expect(OMA_TODO_TOOL_DESCRIPTION).toContain('3+ steps');
    expect(OMA_TODO_SYSTEM_PROMPT_APPEND.startsWith('<todo_tracking>\n')).toBe(true);
    expect(OMA_TODO_SYSTEM_PROMPT_APPEND.endsWith('\n</todo_tracking>')).toBe(true);
    expect(OMA_TODO_SYSTEM_PROMPT_APPEND).toContain('3+ steps');
    expect(OMA_TODO_SYSTEM_PROMPT_APPEND).toContain('Mid-turn escalation');
    expect(OMA_TODO_SYSTEM_PROMPT_APPEND).toContain('Follow-up turns');
    expect(OMA_TODO_SYSTEM_PROMPT_APPEND).toContain('Batch `op="init"` in parallel');
    expect(listJson.result.tools[0]?.annotations?.readOnlyHint).toBe(true);
    expect(listJson.result.tools[0]?._meta?.['antigravity/alwaysLoad']).toBe(true);

    // tools/call tracks session by root_conversation_id
    const callRes = await fetch(cfg.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          _meta: {
            'antigravity.google/root_conversation_id': 'sess-a',
            'antigravity.google/conversation_id': 'sess-a',
          },
          name: 'todo',
          arguments: {
            op: 'init',
            list: [{ phase: 'Core', items: ['Task 1', 'Task 2'] }],
            toolSummary: 'Ignored summary',
          },
        },
      }),
    });
    const callJson = (await callRes.json()) as { result: { content: Array<{ text: string }> } };
    expect(callJson.result.content[0]?.text).toContain('Overall: 0/2 done, 2 open.');
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe('sess-a');
    expect(server.getPhases('sess-a')).toHaveLength(1);
    expect(server.getPhases('sess-b')).toHaveLength(0);

    server.clearSession('sess-a');
    expect(server.getPhases('sess-a')).toHaveLength(0);

    // Subagent calls carrying a distinct conversation_id must stay isolated from root_conversation_id
    await fetch(cfg.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          _meta: {
            'antigravity.google/root_conversation_id': 'sess-root',
            'antigravity.google/conversation_id': 'sess-root',
          },
          name: 'todo',
          arguments: { op: 'init', items: ['Root task'] },
        },
      }),
    });
    await fetch(cfg.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          _meta: {
            'antigravity.google/root_conversation_id': 'sess-root',
            'antigravity.google/conversation_id': 'sess-sub-1',
          },
          name: 'todo',
          arguments: { op: 'init', items: ['Subagent task'] },
        },
      }),
    });
    expect(server.getPhases('sess-root')[0]?.tasks[0]?.content).toBe('Root task');
    expect(server.getPhases('sess-sub-1')[0]?.tasks[0]?.content).toBe('Subagent task');
  });
});
