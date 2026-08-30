/**
 * Screen wake lock. iOS 16.4+ only, and iOS silently drops the lock when the
 * tab is backgrounded — so we re-acquire on visibilitychange (§4, §9).
 * Absent in older WebKit; degrade silently.
 */

let sentinel: any = null;
let wanted = false;
let listening = false;

export const supported = (): boolean => 'wakeLock' in navigator;
export const held = (): boolean => sentinel !== null && !sentinel.released;

export async function acquire(): Promise<boolean> {
  wanted = true;
  attachListener();
  return request();
}

export async function release(): Promise<void> {
  wanted = false;
  const s = sentinel;
  sentinel = null;
  if (s) { try { await s.release(); } catch { /* already gone */ } }
}

async function request(): Promise<boolean> {
  if (!supported() || !wanted || held()) return held();
  try {
    sentinel = await (navigator as any).wakeLock.request('screen');
    sentinel.addEventListener?.('release', () => { sentinel = null; });
    return true;
  } catch {
    sentinel = null;
    return false;
  }
}

function attachListener(): void {
  if (listening) return;
  listening = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && wanted) void request();
  });
}
