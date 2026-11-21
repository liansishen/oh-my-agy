/**
 * In-memory ring buffer recording sanitized ACP JSON-RPC traffic,
 * stderr diagnostics, and Tern ErrorEvents for `/log` inspection & JSONL export.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type TrafficDirection = 'out' | 'in' | 'stderr' | 'tern-error' | 'system';

export interface TrafficEntry {
  readonly seq: number;
  readonly timestamp: string;
  readonly direction: TrafficDirection;
  readonly method?: string;
  readonly rpcId?: string | number;
  readonly summary: string;
  readonly payload?: unknown;
}

export interface TrafficFilter {
  readonly direction?: TrafficDirection | 'all';
  readonly query?: string;
  readonly limit?: number;
}

export interface TrafficBufferOptions {
  readonly maxEntries?: number;
  readonly maxStringLength?: number;
  readonly now?: () => Date;
}

const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_STRING_LENGTH = 4096;
const MAX_SANITIZE_DEPTH = 6;
const MAX_ARRAY_PREVIEW = 50;

const SENSITIVE_KEY_RE =
  /(?:^|[_-])(token|secret|password|passwd|authorization|auth_?header|api[_-]?key|credential|cookie|bearer|private[_-]?key)(?:$|[_-])/i;

const BINARY_DATA_KEY_RE = /^(data|base64|bytes)$/i;

export function sanitizeTrafficPayload(
  value: unknown,
  maxStringLength = DEFAULT_MAX_STRING_LENGTH,
  depth = 0,
  keyHint?: string,
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    if (keyHint && SENSITIVE_KEY_RE.test(keyHint)) {
      return '[REDACTED]';
    }
    if (keyHint && BINARY_DATA_KEY_RE.test(keyHint) && value.length > 128) {
      return `[BINARY_OR_BASE64 len=${value.length}]`;
    }
    if (value.length > maxStringLength) {
      return `${value.slice(0, maxStringLength)}... [truncated ${value.length - maxStringLength} chars]`;
    }
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Uint8Array) {
    return `[Uint8Array len=${value.byteLength}]`;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitizeTrafficPayload(value.message, maxStringLength, depth + 1),
    };
  }

  if (depth >= MAX_SANITIZE_DEPTH) {
    return '[MaxDepth]';
  }

  if (Array.isArray(value)) {
    const sliced = value.slice(0, MAX_ARRAY_PREVIEW);
    const sanitized = sliced.map((item) =>
      sanitizeTrafficPayload(item, maxStringLength, depth + 1),
    );
    if (value.length > MAX_ARRAY_PREVIEW) {
      sanitized.push(`[+${value.length - MAX_ARRAY_PREVIEW} more items]`);
    }
    return sanitized;
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeTrafficPayload(v, maxStringLength, depth + 1, k);
      }
    }
    return out;
  }

  return String(value);
}

function summarizeRpcMessage(direction: 'out' | 'in', msg: unknown): {
  method?: string;
  rpcId?: string | number;
  summary: string;
} {
  if (!msg || typeof msg !== 'object') {
    return { summary: `${direction === 'out' ? 'C->S' : 'S->C'} ${String(msg)}` };
  }
  const rec = msg as Record<string, unknown>;
  const method = typeof rec.method === 'string' ? rec.method : undefined;
  const rpcId =
    typeof rec.id === 'string' || typeof rec.id === 'number' ? rec.id : undefined;

  const arrow = direction === 'out' ? 'C->S' : 'S->C';

  if (method) {
    // Include sessionUpdate kind for session/update notifications
    let extra = '';
    if (method === 'session/update' && rec.params && typeof rec.params === 'object') {
      const update = (rec.params as Record<string, unknown>).update;
      if (update && typeof update === 'object') {
        const updateKind = (update as Record<string, unknown>).sessionUpdate;
        if (typeof updateKind === 'string') {
          extra = ` (${updateKind})`;
        }
      }
    }
    const idTag = rpcId !== undefined ? ` #${rpcId}` : '';
    return {
      method,
      rpcId,
      summary: `${arrow} ${method}${idTag}${extra}`,
    };
  }

  if (rpcId !== undefined) {
    if ('error' in rec && rec.error && typeof rec.error === 'object') {
      const errObj = rec.error as Record<string, unknown>;
      const code = errObj.code ?? '?';
      const errMsg = typeof errObj.message === 'string' ? errObj.message : 'error';
      return {
        rpcId,
        summary: `${arrow} response #${rpcId} ERROR(${code}): ${errMsg}`,
      };
    }
    return {
      rpcId,
      summary: `${arrow} response #${rpcId} ok`,
    };
  }

  return { summary: `${arrow} json-rpc` };
}

export class TrafficBuffer {
  private readonly _maxEntries: number;
  private readonly _maxStringLength: number;
  private readonly _now: () => Date;

  private _ring: Array<TrafficEntry | undefined>;
  private _head = 0;
  private _size = 0;
  private _nextSeq = 1;

  constructor(options: TrafficBufferOptions = {}) {
    this._maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this._maxStringLength = Math.max(64, options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH);
    this._now = options.now ?? (() => new Date());
    this._ring = new Array<TrafficEntry | undefined>(this._maxEntries);
  }

  get size(): number {
    return this._size;
  }

  get capacity(): number {
    return this._maxEntries;
  }

  get totalRecorded(): number {
    return this._nextSeq - 1;
  }

  push(input: {
    direction: TrafficDirection;
    summary: string;
    method?: string;
    rpcId?: string | number;
    payload?: unknown;
  }): TrafficEntry {
    const entry: TrafficEntry = {
      seq: this._nextSeq++,
      timestamp: this._now().toISOString(),
      direction: input.direction,
      ...(input.method !== undefined ? { method: input.method } : {}),
      ...(input.rpcId !== undefined ? { rpcId: input.rpcId } : {}),
      summary: input.summary,
      ...(input.payload !== undefined
        ? { payload: sanitizeTrafficPayload(input.payload, this._maxStringLength) }
        : {}),
    };

    const writePos = (this._head + this._size) % this._maxEntries;
    if (this._size < this._maxEntries) {
      this._ring[writePos] = entry;
      this._size++;
    } else {
      this._ring[this._head] = entry;
      this._head = (this._head + 1) % this._maxEntries;
    }

    return entry;
  }

  recordRpc(direction: 'out' | 'in', message: unknown): TrafficEntry {
    const meta = summarizeRpcMessage(direction, message);
    return this.push({
      direction,
      method: meta.method,
      rpcId: meta.rpcId,
      summary: meta.summary,
      payload: message,
    });
  }

  recordRpcOut(message: unknown): TrafficEntry {
    return this.recordRpc('out', message);
  }

  recordRpcIn(message: unknown): TrafficEntry {
    return this.recordRpc('in', message);
  }

  recordStderr(chunk: string): TrafficEntry {
    const trimmed = chunk.trim();
    const firstLine = trimmed.split(/\r?\n/)[0] ?? '';
    const summary = firstLine.length > 120 ? `stderr: ${firstLine.slice(0, 120)}...` : `stderr: ${firstLine}`;
    return this.push({
      direction: 'stderr',
      summary,
      payload: trimmed,
    });
  }

  recordTernError(error: { code?: string; message?: string; id?: string; detail?: unknown } | string): TrafficEntry {
    if (typeof error === 'string') {
      return this.push({
        direction: 'tern-error',
        summary: `tern-error: ${error}`,
        payload: { message: error },
      });
    }
    const code = error.code ? `[${error.code}] ` : '';
    const node = error.id ? ` (${error.id})` : '';
    const msg = error.message ?? 'unknown tern error';
    return this.push({
      direction: 'tern-error',
      summary: `tern-error: ${code}${msg}${node}`,
      payload: error,
    });
  }

  recordSystem(summary: string, payload?: unknown): TrafficEntry {
    return this.push({
      direction: 'system',
      summary,
      payload,
    });
  }

  /**
   * Return retained entries in chronological order (oldest -> newest).
   */
  list(filter: TrafficFilter = {}): TrafficEntry[] {
    const results: TrafficEntry[] = [];
    const dir = filter.direction && filter.direction !== 'all' ? filter.direction : null;
    const query = filter.query?.trim().toLowerCase() ?? '';

    for (let i = 0; i < this._size; i++) {
      const entry = this._ring[(this._head + i) % this._maxEntries];
      if (!entry) continue;
      if (dir && entry.direction !== dir) continue;
      if (query) {
        const haystack = [
          entry.summary,
          entry.method ?? '',
          entry.direction,
          entry.payload !== undefined ? JSON.stringify(entry.payload) : '',
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(query)) continue;
      }
      results.push(entry);
    }

    if (filter.limit !== undefined && filter.limit >= 0 && results.length > filter.limit) {
      return results.slice(-filter.limit);
    }
    return results;
  }

  get(seq: number): TrafficEntry | undefined {
    for (let i = 0; i < this._size; i++) {
      const entry = this._ring[(this._head + i) % this._maxEntries];
      if (entry && entry.seq === seq) return entry;
    }
    return undefined;
  }

  getLatest(count = 50): TrafficEntry[] {
    return this.list({ limit: count });
  }

  toJsonl(filter: TrafficFilter = {}): string {
    const items = this.list(filter);
    if (items.length === 0) return '';
    return `${items.map((item) => JSON.stringify(item)).join('\n')}\n`;
  }

  async exportToFile(filePath: string, filter: TrafficFilter = {}): Promise<number> {
    const items = this.list(filter);
    await mkdir(path.dirname(filePath), { recursive: true });
    const content = items.length > 0 ? `${items.map((item) => JSON.stringify(item)).join('\n')}\n` : '';
    await writeFile(filePath, content, 'utf8');
    return items.length;
  }

  clear(): void {
    this._ring = new Array<TrafficEntry | undefined>(this._maxEntries);
    this._head = 0;
    this._size = 0;
  }
}
