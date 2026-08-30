/**
 * Instrument 1 — the boot gate (§4).
 *
 * Everything requiring a user gesture happens in one handler behind one
 * button. Camera and mic are deliberately excluded: asking for all three up
 * front looks alarming and invites a denial that cannot be undone from JS.
 */

import { el, append, clear, notice, escapeHtml } from './dom';
import { capabilities, refresh } from '../lib/capabilities';
import { unlock, DENIAL_HELP, type UnlockResult } from '../lib/permissions';
import * as wakelock from '../lib/wakelock';

export async function bootGate(): Promise<UnlockResult> {
  return new Promise((resolve) => {
    const caps = refresh();

    const log = el('div', { class: 'boot__log' });
    const button = el('button', { class: 'engage', type: 'button' }, 'Engage');
    const help = el('div');

    const line = (text: string, cls = '') => {
      append(log, el('div', { class: cls, text }));
    };

    const inner = el(
      'div',
      { class: 'boot__inner' },
      el('div', { class: 'boot__title' }, 'Tricorder'),
      el(
        'div',
        { class: 'boot__sub' },
        'Portable sensor suite · WebKit / iOS\n' +
          'All readings derive from real device measurements. ' +
          'Anything estimated or uncalibrated is labelled as such.',
      ),
      button,
      log,
      help,
    );
    const overlay = el('div', { class: 'boot' }, inner);
    document.body.appendChild(overlay);

    // A non-secure context is the single most common way this app appears
    // broken with no error at all (§6): the events simply never fire.
    if (!caps.secureContext) {
      button.disabled = true;
      append(
        help,
        notice(
          'bad',
          '<strong>Insecure context.</strong> Motion, orientation, geolocation, camera and microphone are all unavailable over plain HTTP on a phone — the APIs do not error, they simply never fire. ' +
            `Reach this page over <code>https://</code> (or <code>http://localhost</code> on a desktop). Current origin: <code>${escapeHtml(location.origin)}</code>`,
        ),
      );
      line('BOOT HALTED — secure context required', 'bad');
      return; // Nothing to unlock; leave the gate up.
    }

    if (!caps.motionGate && !caps.deviceMotion) {
      append(
        help,
        notice('warn', '<strong>No DeviceMotion support detected.</strong> The seismograph and attitude readouts will be unavailable on this browser.'),
      );
    }

    button.addEventListener(
      'click',
      async () => {
        button.disabled = true;
        button.textContent = 'Engaging…';
        clear(log);
        clear(help);

        // No await before this call — the gesture must still be live.
        const result = await unlock();

        line(`motion permission ......... ${result.motion}`, cls(result.motion));
        line(`orientation permission .... ${result.orientation}`, cls(result.orientation));
        line(`audio context ............. ${result.audio}`, cls(result.audio));
        if (result.audioSampleRate) {
          line(`audio sample rate ......... ${result.audioSampleRate} Hz`, 'ok');
        }

        const gotLock = await wakelock.acquire();
        line(
          `screen wake lock .......... ${wakelock.supported() ? (gotLock ? 'held' : 'refused') : 'unavailable'}`,
          wakelock.supported() && gotLock ? 'ok' : 'warn',
        );

        for (const e of result.errors) line(`! ${e}`, 'bad');

        const denied = result.motion === 'denied' || result.orientation === 'denied';
        if (denied) {
          append(help, denialHelp());
          button.disabled = false;
          button.textContent = 'Continue anyway';
          button.onclick = () => { finish(); };
          return;
        }

        finish();

        function finish() {
          overlay.remove();
          resolve(result);
        }
      },
      { once: false },
    );
  });
}

function cls(state: string): string {
  return state === 'granted' ? 'ok' : state === 'denied' ? 'bad' : 'warn';
}


/**
 * There is no API to re-prompt after a denial — recovery means clearing
 * website data, and the path differs per browser (§4). We cannot tell which
 * browser this is without UA sniffing, so show all of them.
 */
function denialHelp(): HTMLElement {
  const items = DENIAL_HELP.map(
    (h) => `<li><strong>${escapeHtml(h.browser)}</strong> — ${escapeHtml(h.steps)}</li>`,
  ).join('');
  return notice(
    'bad',
    `<strong>Permission denied.</strong> iOS cannot re-prompt once denied. To recover:<ul>${items}</ul>`,
  );
}


/** Re-exported so the diagnostics screen can show the same capability set. */
export { capabilities };
