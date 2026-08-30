/**
 * Refcounted multi-consumer stream. Several instruments read `devicemotion`
 * at once and we only ever want one listener attached (§3), so the underlying
 * source starts on the first subscriber and stops after the last unsubscribes.
 */

export type Unsubscribe = () => void;

export class SensorStream<T> {
  private subs = new Set<(v: T) => void>();
  private stop: (() => void) | null = null;
  private _last: T | null = null;

  constructor(private readonly start: (emit: (v: T) => void) => () => void) {}

  /** Most recent sample, or null if nothing has arrived yet. */
  get last(): T | null { return this._last; }
  get active(): boolean { return this.stop !== null; }
  get subscriberCount(): number { return this.subs.size; }

  subscribe(fn: (v: T) => void): Unsubscribe {
    this.subs.add(fn);
    if (this.subs.size === 1) this.stop = this.start((v) => this.emit(v));
    // Deliver the cached sample so a freshly mounted screen is not blank
    // until the next event — devicemotion is ~60 Hz but geo can be seconds.
    if (this._last !== null) {
      try { fn(this._last); } catch (e) { console.error('[sensor] subscriber threw', e); }
    }
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.subs.delete(fn);
      if (this.subs.size === 0) this.teardown();
    };
  }

  private emit(v: T): void {
    this._last = v;
    for (const fn of this.subs) {
      try { fn(v); } catch (e) { console.error('[sensor] subscriber threw', e); }
    }
  }

  private teardown(): void {
    const s = this.stop;
    this.stop = null;
    s?.();
  }

  /** Drop the cached sample — used when a stream's validity is pose-dependent. */
  forget(): void { this._last = null; }
}
