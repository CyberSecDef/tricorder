/** Tiny DOM helpers. No framework (§3) — instruments are canvas-heavy and a
 *  VDOM buys nothing against a 60 Hz sensor stream. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else node.setAttribute(k, v === true ? '' : String(v));
  }
  append(node, ...children);
  return node;
}

export function append(parent: Node, ...children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
}

export const clear = (node: Node): void => { while (node.firstChild) node.removeChild(node.firstChild); };

/** A labelled numeric readout. `unit` is rendered small; `note` smaller still. */
export function readout(label: string, opts: { unit?: string; note?: string; wide?: boolean } = {}) {
  const value = el('span', { class: 'ro-value', text: '—' });
  const unit = el('span', { class: 'ro-unit', text: opts.unit ?? '' });
  const note = el('div', { class: 'ro-note', text: opts.note ?? '' });
  const box = el(
    'div',
    { class: `readout${opts.wide ? ' readout--wide' : ''}` },
    el('div', { class: 'ro-label', text: label }),
    el('div', { class: 'ro-line' }, value, unit),
    opts.note !== undefined ? note : null,
  );
  return {
    node: box,
    set(v: string, n?: string) {
      value.textContent = v;
      if (n !== undefined) note.textContent = n;
    },
    setUnit(u: string) { unit.textContent = u; },
    setState(s: 'ok' | 'warn' | 'bad' | 'idle') { box.dataset.state = s; },
  };
}

/**
 * Canvas that keeps its backing store matched to CSS size and devicePixelRatio.
 * iOS resizes the viewport when the URL bar collapses, so this re-measures on
 * resize and orientationchange rather than trusting a start-up measurement.
 */
export function autoCanvas(className = '') {
  const canvas = el('canvas', { class: className });
  const ctx = canvas.getContext('2d')!;
  let w = 0, h = 0, dpr = 1;

  function resize(): boolean {
    const r = canvas.getBoundingClientRect();
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2.5); // cap: fill rate on a phone
    const nw = Math.max(1, Math.round(r.width * nextDpr));
    const nh = Math.max(1, Math.round(r.height * nextDpr));
    if (nw === canvas.width && nh === canvas.height && nextDpr === dpr) return false;
    canvas.width = nw; canvas.height = nh;
    w = r.width; h = r.height; dpr = nextDpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }

  return {
    node: canvas,
    ctx,
    resize,
    get width() { return w; },
    get height() { return h; },
  };
}

export const fmt = (v: number | null | undefined, digits = 2, dash = '—'): string =>
  v === null || v === undefined || !Number.isFinite(v) ? dash : v.toFixed(digits);

/** Section divider: label plus a rule, the standard LCARS panel break. */
export function section(label: string): HTMLElement {
  return el('div', { class: 'sect' },
    el('div', { class: 'sect__label', text: label }),
    el('div', { class: 'sect__rule' }));
}

/**
 * An advisory block. Takes HTML because these carry inline <strong>/<code>;
 * every interpolated value must go through escapeHtml first.
 */
export function notice(kind: 'warn' | 'bad' | 'ok', html: string): HTMLElement {
  const n = el('div', { class: `notice${kind === 'warn' ? '' : ` notice--${kind}`}` });
  n.innerHTML = html;
  return n;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
