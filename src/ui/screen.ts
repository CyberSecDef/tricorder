/**
 * The screen lifecycle: activate → acquire → run → release (§3, §9).
 *
 * This is the core abstraction of the app. Most resource-leak bugs here will
 * be a missed release path, so releasing is not something an instrument is
 * trusted to remember — everything it acquires is registered with the base
 * class and torn down automatically, in reverse order, on unmount.
 */

import type { SensorStream, Unsubscribe } from '../sensors/stream';

export abstract class Instrument {
  abstract readonly id: string;
  abstract readonly title: string;
  /** Shown under the title in the header. */
  readonly subtitle: string = '';
  /** Rendered in the status strip so the user knows what this screen holds. */
  readonly resources: string = '';

  protected root!: HTMLElement;
  private disposers: Array<() => void> = [];
  private frames = new Set<number>();
  private mounted = false;

  /** Build the DOM. Async so a screen can acquire the camera or mic first. */
  protected abstract build(root: HTMLElement): void | Promise<void>;

  async mount(root: HTMLElement): Promise<void> {
    this.root = root;
    this.mounted = true;
    await this.build(root);
  }

  async unmount(): Promise<void> {
    this.mounted = false;
    for (const id of this.frames) cancelAnimationFrame(id);
    this.frames.clear();
    // Reverse order: a subscription registered after a stream handle should
    // come down before it.
    for (const d of this.disposers.reverse()) {
      try { d(); } catch (e) { console.error(`[${this.id}] cleanup threw`, e); }
    }
    this.disposers = [];
  }

  protected get isMounted(): boolean { return this.mounted; }

  /** Register any teardown callback. */
  protected onCleanup(fn: () => void): void { this.disposers.push(fn); }

  /** Subscribe to a sensor stream; unsubscribed automatically on unmount. */
  protected sub<T>(stream: SensorStream<T>, fn: (v: T) => void): Unsubscribe {
    const un = stream.subscribe(fn);
    this.onCleanup(un);
    return un;
  }

  /** addEventListener that is removed automatically on unmount. */
  protected listen<T extends EventTarget>(
    target: T,
    type: string,
    fn: EventListener,
    opts?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn, opts);
    this.onCleanup(() => target.removeEventListener(type, fn, opts));
  }

  /** setInterval that is cleared automatically on unmount. */
  protected every(ms: number, fn: () => void): void {
    const id = window.setInterval(fn, ms);
    this.onCleanup(() => window.clearInterval(id));
  }

  /**
   * A render loop tied to this screen's lifetime. The callback receives
   * seconds since the previous frame. Stops on unmount, and pauses itself
   * while the document is hidden so a backgrounded tab burns nothing.
   */
  protected loop(fn: (dt: number) => void): void {
    let last = performance.now();
    const step = (now: number) => {
      if (!this.mounted) return;
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      if (document.visibilityState === 'visible') {
        try { fn(dt); } catch (e) { console.error(`[${this.id}] frame threw`, e); }
      }
      const id = requestAnimationFrame(step);
      this.frames.add(id);
    };
    const id = requestAnimationFrame(step);
    this.frames.add(id);
  }
}

/** Factory registration, so main.ts does not import every instrument eagerly. */
export interface InstrumentEntry {
  id: string;
  title: string;
  /** Short label for the nav rail. */
  short: string;
  /** Milestone tag shown in the nav; instruments beyond M1 render as stubs. */
  create: () => Instrument;
}
