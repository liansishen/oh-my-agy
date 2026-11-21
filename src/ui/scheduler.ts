import type { GoneEvent, Renderable, Surface } from '@stencil-hq/tern';

export type SchedulerSurface = Pick<Surface, 'render' | 'settle' | 'scroll' | 'closed'>;

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
  #settledIds = new Set<string>();
  #evictedIds = new Set<string>();

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
    this.#surface.render(this.#buildView());
  }

  /** Suspends intermediate renders while replaying history during `session/load`. */
  suspendForReplay(): void {
    this.#suspended = true;
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
   * Marks a completed turn (`main.turn-<index>`) as settled so Tern can reduce diff overhead
   * and consider it for scrollback memory eviction.
   */
  settleTurn(turnIndex: number): boolean {
    const id = `main.turn-${turnIndex}`;
    return this.settleNode(id);
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
    this.#settledIds.clear();
    this.#evictedIds.clear();
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
