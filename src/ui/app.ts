/**
 * Application shell and router.
 *
 * Enforces the rule from §9: only one instrument is active at a time. Switching
 * screens fully unmounts the old one before mounting the new, so the camera,
 * mic, audio nodes, listeners and animation frames it held are all released.
 * The camera + ML model + audio worklet running together would thermally
 * throttle the phone, and a leaked stream leaves the privacy indicator lit.
 */

import { el, append, clear } from './dom';
import type { Instrument } from './screen';
import * as wakelock from '../lib/wakelock';
import { resumeAudio } from '../lib/permissions';

export interface NavEntry {
  id: string;
  short: string;
  milestone: string;
  create: () => Instrument;
}

export class App {
  private stage!: HTMLElement;
  private title!: HTMLElement;
  private subtitle!: HTMLElement;
  private status!: HTMLElement;
  private rail!: HTMLElement;
  private current: Instrument | null = null;
  /** Guards against a fast double-tap mounting two screens concurrently. */
  private switching: Promise<void> = Promise.resolve();

  constructor(private readonly entries: NavEntry[]) {}

  mount(root: HTMLElement): void {
    clear(root);

    this.title = el('div', { class: 'bar__title', text: 'Tricorder' });
    this.subtitle = el('div', { class: 'bar__sub', text: '' });

    const header = el(
      'div',
      { class: 'bar' },
      el('div', { class: 'elbow elbow--tl' }),
      el('div', { class: 'bar__fill' }, this.subtitle, this.title),
      el('div', { class: 'blocks' },
        el('div', { class: 'block', text: '01' }),
        el('div', { class: 'block', text: '02' }),
        el('div', { class: 'block', text: 'LCARS' })),
    );

    this.rail = el('nav', { class: 'rail' });
    this.stage = el('div', { class: 'stage' });

    this.status = el('div', { class: 'bar__title', style: 'font-size:12px;letter-spacing:.1em', text: '' });
    const footer = el(
      'div',
      { class: 'bar', style: '--bar-h:30px;min-height:30px' },
      el('div', { class: 'bar__fill', style: 'background:var(--lc-rust)' }, this.status),
    );

    // The footer sits in a column BESIDE the rail rather than beneath it, so
    // the rail runs the full height of the screen and its rust block reaches
    // the bottom edge uninterrupted. Stacking the footer under both would put
    // a 4px gap across the rail and break that column in two.
    const main = el('div', { class: 'main' }, this.stage, footer);
    const body = el('div', { class: 'body' }, this.rail, main);

    append(root, header, body);
    this.buildRail();

    // iOS suspends the AudioContext and drops the wake lock on background.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void resumeAudio();
    });

    window.addEventListener('hashchange', () => this.route());
    this.route();
  }

  private buildRail(): void {
    clear(this.rail);
    this.entries.forEach((entry, i) => {
      const btn = el(
        'button',
        { class: 'rail__btn', type: 'button', 'data-id': entry.id },
        el('div', { class: 'rail__num', text: String(i + 1).padStart(2, '0') }),
        el('div', { class: 'rail__label', text: entry.short }),
        el('div', { class: 'rail__ms', text: entry.milestone }),
      );
      btn.addEventListener('click', () => { location.hash = `#/${entry.id}`; });
      append(this.rail, btn);
    });
    append(this.rail, el('div', { class: 'rail__spacer' }));
  }

  private route(): void {
    const id = location.hash.replace(/^#\/?/, '') || this.entries[0].id;
    const entry = this.entries.find((e) => e.id === id) ?? this.entries[0];
    this.switchTo(entry);
  }

  private switchTo(entry: NavEntry): void {
    // Serialise switches. build() is async (the mic screen awaits
    // getUserMedia), so two rapid taps could otherwise both mount.
    this.switching = this.switching.then(async () => {
      if (this.current?.id === entry.id) return;

      if (this.current) {
        await this.current.unmount();
        this.current = null;
      }
      clear(this.stage);

      const inst = entry.create();
      this.current = inst;

      this.title.textContent = inst.title;
      this.subtitle.textContent = inst.subtitle;
      this.status.textContent = `HOLDS: ${inst.resources.toUpperCase()}`;

      for (const b of this.rail.querySelectorAll<HTMLButtonElement>('.rail__btn')) {
        b.setAttribute('aria-current', String(b.dataset.id === entry.id));
      }

      try {
        await inst.mount(this.stage);
      } catch (e) {
        console.error(`[app] ${entry.id} failed to mount`, e);
        const box = el('div', { class: 'stage__scroll' });
        const n = el('div', { class: 'notice notice--bad' });
        n.textContent = `Instrument failed to start: ${e instanceof Error ? e.message : String(e)}`;
        append(box, n);
        append(this.stage, box);
      }

      // Keep the screen alive while an instrument is running (§9).
      void wakelock.acquire();
    });
  }
}
