import { Node, type GoneEvent, type Renderable, type Surface, type ViewInput } from '@stencil-hq/tern';

function extractMainChildIds(view: Renderable): string[] {
  if (!view || typeof view !== 'object') return [];
  const mainRoot =
    view instanceof Node
      ? view
      : 'main' in (view as ViewInput)
        ? (view as ViewInput).main
        : undefined;
  if (!(mainRoot instanceof Node)) return [];
  const ids: string[] = [];
  mainRoot.children.forEach((child, i) => {
    const key = child.props['key'];
    const name =
      typeof key === 'string' ? key : typeof key === 'number' ? String(key) : String(i);
    ids.push(`main.${name}`);
  });
  return ids;
}

function indexMainChildIdsByTurn(ids: readonly string[]): Map<number, string[]> {
  const byTurn = new Map<number, string[]>();
  for (const id of ids) {
    const match = /^main\.t(\d+)-/.exec(id);
    if (!match) continue;
    const turnIdx = Number(match[1]);
    let bucket = byTurn.get(turnIdx);
    if (!bucket) {
      bucket = [];
      byTurn.set(turnIdx, bucket);
    }
    bucket.push(id);
  }
  return byTurn;
}

export type SchedulerSurface = Pick<Surface, 'render' | 'settle' | 'scroll' | 'closed'> & {
  readonly blocked?: boolean;
  renderDeferred?: (build: () => Renderable | undefined) => void;
  cancelDeferred?: () => void;
  evictNodes?: (ids: readonly string[]) => void;
  resetEvicted?: () => void;
};

export interface RenderSchedulerOptions {
  /** Frame coalescing interval in ms for streaming updates (default: 33ms / ~30fps). */
  throttleMs?: number;
  /** Invoked after a turn subtree is marked settled. */
  onSettled?: (nodeId: string) => void;
  /** Invoked when Tern reports evicted node IDs via GoneEvent. */
  onEvicted?: (nodeIds: readonly string[]) => void;
}

/**
 * 33ms coalescing render scheduler with immediate flush for interactive events,
 * replay suspension during `session/load`, turn settling (`main.turn-<idx>`),
 * and `GoneEvent` eviction tracking.
 */
export class RenderScheduler {
  readonly #surface: SchedulerSurface;
  readonly #buildView: () => Renderable;
  readonly #throttleMs: number;
  readonly #onSettled?: (nodeId: string) => void;
  readonly #onEvicted?: (nodeIds: readonly string[]) => void;

  #timer: ReturnType<typeof setTimeout> | undefined;
  #dirty = false;
  #suspended = false;
  #disposed = false;
  #renderEpoch = 0;
  #hasPendingDeferredRender = false;
  #settledIds = new Set<string>();
  #evictedIds = new Set<string>();
  #pendingSettleTurns = new Set<number>();
  #lastMainChildIds: string[] = [];
  #lastMainChildIdsByTurn = new Map<number, string[]>();

  constructor(
    surface: SchedulerSurface,
    buildView: () => Renderable,
    options: RenderSchedulerOptions = {}
  ) {
    this.#surface = surface;
    this.#buildView = buildView;
    this.#throttleMs = options.throttleMs ?? 33;
    this.#onSettled = options.onSettled;
    this.#onEvicted = options.onEvicted;
  }

  get suspended(): boolean {
    return this.#suspended;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  /** Marks the view dirty and schedules a coalesced render within `throttleMs` (33ms). */
  markDirty(): void {
    if (this.#disposed || this.#surface.closed) return;
    this.#dirty = true;
    if (this.#suspended) return;
    if (this.#timer !== undefined) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#dirty && !this.#suspended && !this.#disposed) {
        this.renderNow();
      }
    }, this.#throttleMs);
  }

  /** Renders immediately without throttling (used for user input & interactive prompts). */
  renderNow(force = false): void {
    if (this.#disposed || this.#surface.closed) return;
    if (this.#suspended && !force) {
      this.#dirty = true;
      return;
    }
    this.#clearTimer();
    this.#dirty = false;
    const epoch = this.#renderEpoch;
    const buildAndIndex = (fromDeferred: boolean): Renderable | undefined => {
      if (this.#disposed || this.#surface.closed) return undefined;
      if (fromDeferred && (this.#suspended || epoch !== this.#renderEpoch)) {
        return undefined;
      }
      this.#hasPendingDeferredRender = false;
      const view = this.#buildView();
      this.#lastMainChildIds = extractMainChildIds(view);
      this.#lastMainChildIdsByTurn = indexMainChildIdsByTurn(this.#lastMainChildIds);
      if (this.#settledIds.size > 0) {
        const present = new Set(this.#lastMainChildIds);
        for (const id of this.#settledIds) {
          if (/^main\.t\d+-/.test(id) && !present.has(id)) {
            this.#settledIds.delete(id);
          }
        }
      }
      this.#flushPendingSettleTurns();
      return view;
    };
    if (!force && this.#surface.blocked && this.#surface.renderDeferred) {
      this.#hasPendingDeferredRender = true;
      this.#surface.renderDeferred(() => buildAndIndex(true));
      return;
    }
    const built = buildAndIndex(false);
    if (built !== undefined) {
      this.#surface.render(built);
    }
  }

  /** Suspends intermediate renders while replaying history during `session/load`. */
  suspendForReplay(): void {
    this.#suspended = true;
    this.#renderEpoch += 1;
    this.#hasPendingDeferredRender = false;
    this.#pendingSettleTurns.clear();
    this.#surface.cancelDeferred?.();
    this.#clearTimer();
  }

  /** Resumes rendering after `session/load`, flushing one complete frame and optionally scrolling to bottom. */
  resumeAfterReplay(scrollToEnd = true): void {
    this.#suspended = false;
    this.renderNow(true);
    if (scrollToEnd && !this.#surface.closed) {
      this.#surface.scroll('main', 'end');
    }
  }

  /**
   * Marks all top-level nodes belonging to a completed turn (`main.t<index>-*`) as settled
   * so Tern can reduce diff overhead and consider them for scrollback memory eviction.
   */
  settleTurn(turnIndex: number): boolean {
    if (this.#disposed || this.#surface.closed) return false;
    // When a deferred render is waiting for flow-control credit, defer turn settlement until
    // the actual frame builds and indexes the turn's `main.t<index>-*` nodes so we never emit
    // a stale fallback `settle main.turn-<index>` for a turn whose real nodes haven't flushed yet.
    if (this.#hasPendingDeferredRender) {
      this.#pendingSettleTurns.add(turnIndex);
      return true;
    }
    return this.#settleIndexedTurn(turnIndex);
  }

  #settleIndexedTurn(turnIndex: number): boolean {
    const matching = this.#lastMainChildIdsByTurn.get(turnIndex);
    if (matching && matching.length > 0) {
      let settledAny = false;
      for (const id of matching) {
        if (this.settleNode(id)) {
          settledAny = true;
        }
      }
      return settledAny;
    }
    return this.settleNode(`main.turn-${turnIndex}`);
  }

  #flushPendingSettleTurns(): void {
    if (this.#pendingSettleTurns.size === 0) return;
    const turns = [...this.#pendingSettleTurns];
    this.#pendingSettleTurns.clear();
    for (const turnIndex of turns) {
      this.#settleIndexedTurn(turnIndex);
    }
  }

  settleNode(nodeId: string): boolean {
    if (this.#disposed || this.#surface.closed) return false;
    if (this.#settledIds.has(nodeId) || this.#evictedIds.has(nodeId)) return false;
    this.#settledIds.add(nodeId);
    this.#surface.settle(nodeId);
    this.#onSettled?.(nodeId);
    return true;
  }

  /** Handles Tern `GoneEvent` for evicted settled turn nodes to prevent ops targeting missing nodes. */
  handleGone(event: GoneEvent): string[] {
    const newlyEvicted: string[] = [];
    for (const id of event.ids) {
      if (!this.#evictedIds.has(id)) {
        this.#evictedIds.add(id);
        this.#settledIds.delete(id);
        newlyEvicted.push(id);
      }
    }
    if (newlyEvicted.length > 0) {
      this.#surface.evictNodes?.(newlyEvicted);
      this.#onEvicted?.(newlyEvicted);
    }
    return newlyEvicted;
  }

  isSettled(nodeId: string): boolean {
    return this.#settledIds.has(nodeId);
  }

  isEvicted(nodeId: string): boolean {
    return this.#evictedIds.has(nodeId);
  }

  getSettledIds(): readonly string[] {
    return [...this.#settledIds];
  }

  getEvictedIds(): readonly string[] {
    return [...this.#evictedIds];
  }

  /** Resets settled/evicted tracking when switching or starting a fresh session. */
  resetSession(): void {
    this.#renderEpoch += 1;
    this.#hasPendingDeferredRender = false;
    this.#pendingSettleTurns.clear();
    this.#settledIds.clear();
    this.#evictedIds.clear();
    this.#surface.cancelDeferred?.();
    this.#surface.resetEvicted?.();
    this.#lastMainChildIds = [];
    this.#lastMainChildIdsByTurn.clear();
  }

  dispose(): void {
    this.#disposed = true;
    this.#renderEpoch += 1;
    this.#hasPendingDeferredRender = false;
    this.#pendingSettleTurns.clear();
    this.#surface.cancelDeferred?.();
    this.#clearTimer();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
