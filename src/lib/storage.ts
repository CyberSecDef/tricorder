/** localStorage with a namespace and a try/catch — Safari private mode throws. */

const NS = 'tricorder:';

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(NS + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function save(key: string, value: unknown): void {
  try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch { /* full or blocked */ }
}

export function remove(key: string): void {
  try { localStorage.removeItem(NS + key); } catch { /* ignore */ }
}
