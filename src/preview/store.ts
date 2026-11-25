import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import type { TodoPhase, TodoTask, TodoTaskStatus } from '../state/todo';

export interface SessionPreviewTurn {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface PersistedSessionTodoState {
  readonly phases: readonly TodoPhase[];
  readonly toolCallCount: number;
  readonly source?: 'auto' | 'user';
}

export interface SessionAnchorRecord {
  readonly version: 1;
  readonly sessionId: string;
  readonly cwd: string;
  readonly title: string;
  readonly model?: string;
  readonly thoughtLevel?: string;
  readonly mode?: string;
  readonly turnCount?: number;
  readonly updatedAt: string;
  readonly preview: readonly SessionPreviewTurn[];
  readonly todoState?: PersistedSessionTodoState;
}

export type SaveSessionPreviewInput = Omit<SessionAnchorRecord, 'version' | 'updatedAt'> & {
  readonly version?: 1;
  readonly updatedAt?: string;
};

export interface DataPathOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly homedir?: string;
  /** Override the sessions directory directly (primarily for tests). */
  readonly sessionsDir?: string;
}

export interface ResolvedSessionRef {
  readonly sessionId: string | null;
  readonly cwd?: string;
  readonly anchor?: SessionAnchorRecord;
  readonly source: 'file' | 'id' | 'missing-file';
  readonly filePath?: string;
}

export type SessionPreviewLoadResult =
  | { readonly status: 'found'; readonly record: SessionAnchorRecord }
  | { readonly status: 'missing' }
  | { readonly status: 'error' };

const MAX_PREVIEW_ENTRIES = 6; // Recent 3 user/assistant turns
const MAX_PREVIEW_TEXT_CHARS = 500;

/**
 * Returns the platform-appropriate `oma` local data directory:
 * - Windows: `%LOCALAPPDATA%\oma`
 * - Linux / macOS: `$XDG_DATA_HOME/oma` (fallback `~/.local/share/oma`)
 */
export function getDataDir(options: Omit<DataPathOptions, 'sessionsDir'> = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? osHomedir();

  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA']?.trim();
    if (localAppData && localAppData.length > 0) {
      return win32.join(localAppData, 'oma');
    }
    return win32.join(home, 'AppData', 'Local', 'oma');
  }

  const xdgData = env['XDG_DATA_HOME']?.trim();
  if (xdgData && xdgData.length > 0) {
    return posix.join(xdgData, 'oma');
  }
  return posix.join(home, '.local', 'share', 'oma');
}

/**
 * Returns the directory where session preview/anchor JSON files are stored.
 */
export function getSessionsDir(options: DataPathOptions = {}): string {
  if (options.sessionsDir) {
    return options.sessionsDir;
  }
  const platform = options.platform ?? process.platform;
  const dataDir = getDataDir(options);
  return platform === 'win32' ? win32.join(dataDir, 'sessions') : posix.join(dataDir, 'sessions');
}

/**
 * Sanitizes a session ID into a safe single filename component, preventing path traversal.
 */
export function sanitizeSessionId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed.length === 0) {
    throw new Error('sessionId cannot be empty');
  }
  const safe = trimmed.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '_');
  if (safe.length === 0 || safe === '.' || safe === '..') {
    throw new Error(`Invalid sessionId "${sessionId}"`);
  }
  return safe;
}

/**
 * Computes the absolute path of `<sessionsDir>/<sessionId>.json`.
 */
export function getSessionFilePath(sessionId: string, options: DataPathOptions = {}): string {
  const dir = getSessionsDir(options);
  const filename = `${sanitizeSessionId(sessionId)}.json`;
  if (options.sessionsDir) {
    return join(dir, filename);
  }
  const platform = options.platform ?? process.platform;
  return platform === 'win32' ? win32.join(dir, filename) : posix.join(dir, filename);
}

function stripOuterQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function truncateText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars - 1)}…`;
}

function normalizePreviewTurns(
  turns: readonly SessionPreviewTurn[] | undefined,
): SessionPreviewTurn[] {
  if (!Array.isArray(turns)) return [];
  const valid: SessionPreviewTurn[] = [];
  for (const entry of turns) {
    if (
      typeof entry === 'object' &&
      entry !== null &&
      (entry.role === 'user' || entry.role === 'assistant') &&
      typeof entry.text === 'string'
    ) {
      const text = truncateText(entry.text, MAX_PREVIEW_TEXT_CHARS);
      if (text.length > 0) {
        valid.push({ role: entry.role, text });
      }
    }
  }
  return valid.length > MAX_PREVIEW_ENTRIES
    ? valid.slice(valid.length - MAX_PREVIEW_ENTRIES)
    : valid;
}

const VALID_TODO_TASK_STATUSES = new Set<TodoTaskStatus>([
  'pending',
  'in_progress',
  'completed',
  'abandoned',
]);

function normalizePersistedTodoState(raw: unknown): PersistedSessionTodoState | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const rec = raw as Record<string, unknown>;
  if (!Array.isArray(rec['phases'])) {
    return undefined;
  }
  const rawCount = rec['toolCallCount'];
  if (typeof rawCount !== 'number' || !Number.isFinite(rawCount) || rawCount < 0) {
    return undefined;
  }

  const phases: TodoPhase[] = [];
  for (const phaseRaw of rec['phases']) {
    if (typeof phaseRaw !== 'object' || phaseRaw === null || Array.isArray(phaseRaw)) {
      return undefined;
    }
    const pObj = phaseRaw as Record<string, unknown>;
    const name = typeof pObj['name'] === 'string' ? pObj['name'].trim() : '';
    if (!name || !Array.isArray(pObj['tasks'])) {
      return undefined;
    }
    const tasks: TodoTask[] = [];
    for (const taskRaw of pObj['tasks']) {
      if (typeof taskRaw !== 'object' || taskRaw === null || Array.isArray(taskRaw)) {
        return undefined;
      }
      const tObj = taskRaw as Record<string, unknown>;
      const content = typeof tObj['content'] === 'string' ? tObj['content'].trim() : '';
      const status = tObj['status'] as TodoTaskStatus;
      if (!content || !VALID_TODO_TASK_STATUSES.has(status)) {
        return undefined;
      }
      const note =
        typeof tObj['note'] === 'string' && tObj['note'].trim().length > 0
          ? tObj['note'].trim()
          : undefined;
      tasks.push({
        content,
        status,
        ...(note !== undefined ? { note } : {}),
      });
    }
    if (tasks.length > 0) {
      phases.push({ name, tasks });
    }
  }

  const rawSource = rec['source'];
  const source: 'auto' | 'user' | undefined =
    rawSource === 'auto' || rawSource === 'user' ? rawSource : undefined;

  return {
    phases,
    toolCallCount: Math.floor(rawCount),
    ...(source !== undefined ? { source } : {}),
  };
}

/**
 * Validates and normalizes an unknown JSON object into a {@link SessionAnchorRecord}.
 * Returns `null` if required fields (`sessionId`) are missing or invalid.
 */
export function parseSessionAnchorJson(raw: unknown): SessionAnchorRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const sessionId = typeof obj['sessionId'] === 'string' ? obj['sessionId'].trim() : '';
  if (sessionId.length === 0) {
    return null;
  }

  const cwd = typeof obj['cwd'] === 'string' ? obj['cwd'] : '';
  const title = typeof obj['title'] === 'string' ? obj['title'] : '';
  const updatedAt =
    typeof obj['updatedAt'] === 'string' && obj['updatedAt'].trim().length > 0
      ? obj['updatedAt']
      : new Date(0).toISOString();

  const model = typeof obj['model'] === 'string' && obj['model'].length > 0 ? obj['model'] : undefined;
  const thoughtLevel =
    typeof obj['thoughtLevel'] === 'string' && obj['thoughtLevel'].length > 0
      ? obj['thoughtLevel']
      : undefined;
  const mode = typeof obj['mode'] === 'string' && obj['mode'].length > 0 ? obj['mode'] : undefined;
  const turnCount =
    typeof obj['turnCount'] === 'number' && Number.isFinite(obj['turnCount']) && obj['turnCount'] >= 0
      ? Math.floor(obj['turnCount'])
      : undefined;

  const preview = normalizePreviewTurns(obj['preview'] as SessionPreviewTurn[] | undefined);
  const todoState = normalizePersistedTodoState(obj['todoState']);

  return {
    version: 1,
    sessionId,
    cwd,
    title,
    ...(model !== undefined ? { model } : {}),
    ...(thoughtLevel !== undefined ? { thoughtLevel } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(turnCount !== undefined ? { turnCount } : {}),
    updatedAt,
    preview,
    ...(todoState !== undefined ? { todoState } : {}),
  };
}

/**
 * Parses a session anchor JSON file from disk. Handles quoted paths and paths
 * containing spaces. Returns `null` on missing or invalid JSON.
 */
export async function parseSessionAnchorFile(filePath: string): Promise<SessionAnchorRecord | null> {
  const cleaned = stripOuterQuotes(filePath);
  if (cleaned.length === 0) return null;
  try {
    const content = await readFile(cleaned, 'utf8');
    return parseSessionAnchorJson(JSON.parse(content));
  } catch {
    return null;
  }
}

/**
 * Synchronous variant of {@link parseSessionAnchorFile}, useful in CLI argument
 * translation (`--resume` / `--restore` / `--fork` fallback paths).
 */
export function parseSessionAnchorFileSync(filePath: string): SessionAnchorRecord | null {
  const cleaned = stripOuterQuotes(filePath);
  if (cleaned.length === 0 || !existsSync(cleaned)) return null;
  try {
    const st = statSync(cleaned);
    if (!st.isFile()) return null;
    const content = readFileSync(cleaned, 'utf8');
    return parseSessionAnchorJson(JSON.parse(content));
  } catch {
    return null;
  }
}

function looksLikeJsonFilePath(input: string): boolean {
  return /\.json$/i.test(input) || /[\\/]/.test(input);
}

/**
 * Resolves a `--resume` / `--restore` / `--fork` argument which may be either
 * an existing anchor JSON file path (possibly quoted with spaces) or a raw session ID.
 */
export async function resolveSessionRef(
  input: string,
  options: DataPathOptions = {},
): Promise<ResolvedSessionRef> {
  const cleaned = stripOuterQuotes(input);
  if (cleaned.length === 0) {
    return { sessionId: null, source: 'missing-file' };
  }

  const anchorFromPath = await parseSessionAnchorFile(cleaned);
  if (anchorFromPath) {
    return {
      sessionId: anchorFromPath.sessionId,
      cwd: anchorFromPath.cwd || undefined,
      anchor: anchorFromPath,
      source: 'file',
      filePath: resolve(cleaned),
    };
  }

  if (looksLikeJsonFilePath(cleaned)) {
    return {
      sessionId: null,
      source: 'missing-file',
      filePath: resolve(cleaned),
    };
  }

  const cached = await loadSessionPreview(cleaned, options);
  return {
    sessionId: cleaned,
    cwd: cached?.cwd || undefined,
    ...(cached ? { anchor: cached } : {}),
    source: 'id',
  };
}

/**
 * Synchronous variant of {@link resolveSessionRef}.
 */
export function resolveSessionRefSync(
  input: string,
  options: DataPathOptions = {},
): ResolvedSessionRef {
  const cleaned = stripOuterQuotes(input);
  if (cleaned.length === 0) {
    return { sessionId: null, source: 'missing-file' };
  }

  const anchorFromPath = parseSessionAnchorFileSync(cleaned);
  if (anchorFromPath) {
    return {
      sessionId: anchorFromPath.sessionId,
      cwd: anchorFromPath.cwd || undefined,
      anchor: anchorFromPath,
      source: 'file',
      filePath: resolve(cleaned),
    };
  }

  if (looksLikeJsonFilePath(cleaned)) {
    return {
      sessionId: null,
      source: 'missing-file',
      filePath: resolve(cleaned),
    };
  }

  let cached: SessionAnchorRecord | null = null;
  try {
    const candidatePath = getSessionFilePath(cleaned, options);
    cached = parseSessionAnchorFileSync(candidatePath);
  } catch {
    cached = null;
  }

  return {
    sessionId: cleaned,
    cwd: cached?.cwd || undefined,
    ...(cached ? { anchor: cached } : {}),
    source: 'id',
  };
}

async function atomicWriteUtf8(targetPath: string, content: string): Promise<void> {
  const tmpPath = `${targetPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, content, 'utf8');
    try {
      await rename(tmpPath, targetPath);
    } catch (err) {
      // On Windows, antivirus/indexers can occasionally hold a brief lock on targetPath.
      const code = (err as { code?: unknown } | null)?.code;
      if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES' || code === 'EEXIST')) {
        await unlink(targetPath).catch(() => {});
        await rename(tmpPath, targetPath);
      } else {
        throw err;
      }
    }
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Atomically writes `<sessionsDir>/<sessionId>.json` and returns its absolute path.
 */
export async function saveSessionPreview(
  input: SaveSessionPreviewInput,
  options: DataPathOptions = {},
): Promise<string> {
  const dir = getSessionsDir(options);
  await mkdir(dir, { recursive: true });

  const filePath = getSessionFilePath(input.sessionId, options);
  const todoState = normalizePersistedTodoState(input.todoState);
  const record: SessionAnchorRecord = {
    version: 1,
    sessionId: input.sessionId.trim(),
    cwd: input.cwd,
    title: input.title,
    ...(input.model ? { model: input.model } : {}),
    ...(input.thoughtLevel ? { thoughtLevel: input.thoughtLevel } : {}),
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.turnCount !== undefined ? { turnCount: Math.max(0, Math.floor(input.turnCount)) } : {}),
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    preview: normalizePreviewTurns(input.preview),
    ...(todoState !== undefined ? { todoState } : {}),
  };

  const payload = `${JSON.stringify(record, null, 2)}\n`;
  await atomicWriteUtf8(filePath, payload);
  return filePath;
}

/**
 * Loads a single cached session preview by session ID.
 */
export async function loadSessionPreview(
  sessionId: string,
  options: DataPathOptions = {},
): Promise<SessionAnchorRecord | null> {
  let filePath: string;
  try {
    filePath = getSessionFilePath(sessionId, options);
  } catch {
    return null;
  }
  return parseSessionAnchorFile(filePath);
}

/**
 * Loads a cached session preview while distinguishing missing files (`ENOENT`)
 * from read or JSON parse errors.
 */
export async function loadSessionPreviewDetailed(
  sessionId: string,
  options: DataPathOptions = {},
): Promise<SessionPreviewLoadResult> {
  let filePath: string;
  try {
    filePath = getSessionFilePath(sessionId, options);
  } catch {
    return { status: 'error' };
  }
  try {
    const content = await readFile(filePath, 'utf8');
    const record = parseSessionAnchorJson(JSON.parse(content));
    return record ? { status: 'found', record } : { status: 'error' };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ENOENT') {
      return { status: 'missing' };
    }
    return { status: 'error' };
  }
}

/**
 * Loads cached previews into a `Map<sessionId, SessionAnchorRecord>` for left-joining
 * with `session/list`. When `sessionIds` is omitted, scans all `.json` files in
 * the sessions directory.
 */
export async function loadSessionPreviewMap(
  sessionIds?: readonly string[],
  options: DataPathOptions = {},
): Promise<Map<string, SessionAnchorRecord>> {
  const result = new Map<string, SessionAnchorRecord>();

  if (sessionIds !== undefined) {
    await Promise.all(
      sessionIds.map(async (id) => {
        const record = await loadSessionPreview(id, options);
        if (record) result.set(record.sessionId, record);
      }),
    );
    return result;
  }

  const dir = getSessionsDir(options);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return result;
  }

  const jsonFiles = entries.filter((name) => name.endsWith('.json'));
  await Promise.all(
    jsonFiles.map(async (name) => {
      const record = await parseSessionAnchorFile(join(dir, name));
      if (record) result.set(record.sessionId, record);
    }),
  );

  return result;
}

/**
 * Deletes a cached session preview file if it exists.
 */
export async function deleteSessionPreview(
  sessionId: string,
  options: DataPathOptions = {},
): Promise<boolean> {
  let filePath: string;
  try {
    filePath = getSessionFilePath(sessionId, options);
  } catch {
    return false;
  }
  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stateful convenience wrapper over the session preview/anchor store functions.
 */
export class PreviewStore {
  readonly #options: DataPathOptions;

  constructor(options: DataPathOptions = {}) {
    this.#options = options;
  }

  get sessionsDir(): string {
    return getSessionsDir(this.#options);
  }

  getFilePath(sessionId: string): string {
    return getSessionFilePath(sessionId, this.#options);
  }

  save(input: SaveSessionPreviewInput): Promise<string> {
    return saveSessionPreview(input, this.#options);
  }

  load(sessionId: string): Promise<SessionAnchorRecord | null> {
    return loadSessionPreview(sessionId, this.#options);
  }

  loadDetailed(sessionId: string): Promise<SessionPreviewLoadResult> {
    return loadSessionPreviewDetailed(sessionId, this.#options);
  }

  loadMap(sessionIds?: readonly string[]): Promise<Map<string, SessionAnchorRecord>> {
    return loadSessionPreviewMap(sessionIds, this.#options);
  }

  delete(sessionId: string): Promise<boolean> {
    return deleteSessionPreview(sessionId, this.#options);
  }

  parseAnchorFile(filePath: string): Promise<SessionAnchorRecord | null> {
    return parseSessionAnchorFile(filePath);
  }

  resolveRef(input: string): Promise<ResolvedSessionRef> {
    return resolveSessionRef(input, this.#options);
  }
}
