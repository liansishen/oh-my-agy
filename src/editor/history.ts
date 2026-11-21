/**
 * Local prompt input history with Up/Down navigation and JSONL persistence.
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface HistoryEntry {
  readonly text: string;
  readonly ts: string;
  readonly cwd?: string;
}

export interface InputHistoryOptions {
  readonly filePath?: string;
  readonly maxEntries?: number;
  readonly now?: () => Date;
}

const DEFAULT_MAX_ENTRIES = 500;

export function getDefaultHistoryPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'oma', 'history.jsonl');
  }
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(xdgData, 'oma', 'history.jsonl');
}

export class InputHistory {
  private readonly _filePath: string;
  private readonly _maxEntries: number;
  private readonly _now: () => Date;
  private _entries: HistoryEntry[] = [];

  /** -1 means not currently navigating history */
  private _navIndex = -1;
  private _savedDraft = '';
  private _writesSinceCompact = 0;

  constructor(options: InputHistoryOptions = {}) {
    this._filePath = options.filePath ?? getDefaultHistoryPath();
    this._maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this._now = options.now ?? (() => new Date());
  }

  get filePath(): string {
    return this._filePath;
  }

  get length(): number {
    return this._entries.length;
  }

  get isNavigating(): boolean {
    return this._navIndex !== -1;
  }

  list(): readonly HistoryEntry[] {
    return this._entries;
  }

  /**
   * Load persisted JSONL history from disk. Missing or malformed lines are tolerated.
   */
  async load(): Promise<void> {
    try {
      const content = await readFile(this._filePath, 'utf8');
      const parsed: HistoryEntry[] = [];
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as Partial<HistoryEntry>;
          if (typeof obj.text === 'string' && obj.text.trim().length > 0) {
            parsed.push({
              text: obj.text,
              ts: typeof obj.ts === 'string' ? obj.ts : '',
              ...(typeof obj.cwd === 'string' ? { cwd: obj.cwd } : {}),
            });
          }
        } catch {
          // Ignore malformed JSONL line
        }
      }
      this._entries = parsed.slice(-this._maxEntries);
      this.resetNavigation();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        this._entries = [];
        this.resetNavigation();
        return;
      }
      // Best-effort load: keep empty history on unexpected I/O error
      this._entries = [];
      this.resetNavigation();
    }
  }

  /**
   * Record a submitted input and persist it to JSONL.
   */
  async push(text: string, cwd?: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed) return false;

    this.resetNavigation();

    const last = this._entries[this._entries.length - 1];
    if (last && last.text === text) {
      return false;
    }

    const entry: HistoryEntry = {
      text,
      ts: this._now().toISOString(),
      ...(cwd ? { cwd } : {}),
    };

    this._entries.push(entry);
    let trimmedOverflow = false;
    if (this._entries.length > this._maxEntries) {
      this._entries = this._entries.slice(-this._maxEntries);
      trimmedOverflow = true;
    }

    try {
      await mkdir(path.dirname(this._filePath), { recursive: true });
      this._writesSinceCompact++;
      if (trimmedOverflow && this._writesSinceCompact >= 25) {
        await this.compact();
      } else {
        await appendFile(this._filePath, `${JSON.stringify(entry)}\n`, 'utf8');
      }
    } catch {
      // Persistence failure should never break interactive prompt submission
    }

    return true;
  }

  /**
   * Rewrite the JSONL file to keep only the retained in-memory entries.
   */
  async compact(): Promise<void> {
    await mkdir(path.dirname(this._filePath), { recursive: true });
    const data = this._entries.map((e) => JSON.stringify(e)).join('\n');
    await writeFile(this._filePath, data.length > 0 ? `${data}\n` : '', 'utf8');
    this._writesSinceCompact = 0;
  }

  /**
   * Navigate backward (Up) to an older history entry.
   * Returns the entry text, or null if history is empty / already at oldest entry.
   */
  previous(currentDraft: string): string | null {
    if (this._entries.length === 0) return null;

    if (this._navIndex === -1) {
      this._savedDraft = currentDraft;
      this._navIndex = this._entries.length - 1;
      return this._entries[this._navIndex]?.text ?? null;
    }

    if (this._navIndex <= 0) {
      return null;
    }

    this._navIndex--;
    return this._entries[this._navIndex]?.text ?? null;
  }

  /**
   * Navigate forward (Down) to a newer entry or restore the stashed draft.
   * Returns the next text, or null if not navigating history.
   */
  next(): string | null {
    if (this._navIndex === -1) return null;

    if (this._navIndex < this._entries.length - 1) {
      this._navIndex++;
      return this._entries[this._navIndex]?.text ?? null;
    }

    const restored = this._savedDraft;
    this.resetNavigation();
    return restored;
  }

  resetNavigation(): void {
    this._navIndex = -1;
    this._savedDraft = '';
  }
}
