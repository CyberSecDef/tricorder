/**
 * What is in this barcode, and is any of it trying to trick you?
 *
 * A scanned payload is attacker-controlled text. This module never renders,
 * navigates, fetches or executes anything - it only classifies and describes,
 * so the UI can show a person what they are actually holding. Keeping it free
 * of DOM makes it testable, which matters more than usual here: the whole
 * value of this instrument is that its description is trustworthy.
 *
 * Every character class below is written with \u escapes rather than literals.
 * Source containing invisible characters is exactly the problem this file
 * exists to detect, and it has no business demonstrating it.
 */

export type PayloadKind =
  | 'url' | 'wifi' | 'vcard' | 'mailto' | 'tel' | 'sms' | 'geo' | 'calendar' | 'text';

export interface PayloadAnalysis {
  kind: PayloadKind;
  /** Human label for the kind. */
  label: string;
  /** Key fields worth showing as a table, in order. */
  fields: Array<[string, string]>;
  /** Things a person should know before acting on this. Most severe first. */
  warnings: string[];
  /** True when the text contains characters that make it display deceptively. */
  deceptive: boolean;
}

/**
 * Characters that change how following text is DISPLAYED without being visible
 * themselves. U+202E in particular reverses rendering order, and is a
 * long-standing way to make one string look like another - including making a
 * hostile domain look like a familiar one.
 */
const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/;
/** Zero-width joiners and spaces, soft hyphen, byte-order mark. */
const INVISIBLES = /[\u200B-\u200D\uFEFF\u00AD]/;
/** C0 and C1 controls, excluding the tab and newlines that are legitimate. */
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
/** All of the above, for the display escaper. */
const ALL_HIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u00AD\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;

/** Schemes that DO something when opened, rather than merely going somewhere. */
const DANGEROUS_SCHEMES = ['javascript', 'data', 'vbscript', 'file', 'blob'];

export function analyse(text: string): PayloadAnalysis {
  const warnings: string[] = [];
  const deceptive = BIDI_CONTROLS.test(text) || INVISIBLES.test(text) || CONTROLS.test(text);

  if (BIDI_CONTROLS.test(text)) {
    warnings.push('Contains bidirectional text controls, which change how the rest of the text is displayed without being visible themselves. This is a known way to disguise one string as another.');
  }
  if (INVISIBLES.test(text)) {
    warnings.push('Contains zero-width or invisible characters. Two payloads that look identical may not be.');
  }
  if (CONTROLS.test(text)) {
    warnings.push('Contains control characters, which are not printable and may be an attempt to confuse whatever reads this.');
  }

  const t = text.trim();
  const upper = t.toUpperCase();

  if (upper.startsWith('WIFI:')) {
    const f = parseSemicolonPairs(t.slice(5));
    const auth = f.T || 'nopass';
    const out: PayloadAnalysis = {
      kind: 'wifi', label: 'Wi-Fi network', deceptive,
      fields: [
        ['Network (SSID)', f.S ?? '(none)'],
        ['Security', auth === 'nopass' ? 'OPEN - no encryption' : auth],
        ['Password', f.P ? f.P : '(none)'],
        ['Hidden', f.H === 'true' ? 'yes' : 'no'],
      ],
      warnings,
    };
    if (auth === 'nopass') out.warnings.push('This network is open. Traffic on it can be read by anyone in range.');
    return out;
  }

  if (upper.startsWith('BEGIN:VCARD') || upper.startsWith('MECARD:')) {
    return {
      kind: 'vcard', label: 'Contact card', deceptive,
      fields: [['Lines', String(t.split(/\r?\n/).filter(Boolean).length)]],
      warnings,
    };
  }
  if (upper.startsWith('BEGIN:VEVENT') || upper.startsWith('BEGIN:VCALENDAR')) {
    return { kind: 'calendar', label: 'Calendar event', deceptive, fields: [], warnings };
  }

  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(t);
  if (schemeMatch) {
    const scheme = schemeMatch[1].toLowerCase();

    if (scheme === 'mailto') {
      return { kind: 'mailto', label: 'Email address', deceptive,
        fields: [['To', t.slice(7).split('?')[0]]], warnings };
    }
    if (scheme === 'tel') {
      return { kind: 'tel', label: 'Phone number', deceptive, fields: [['Number', t.slice(4)]], warnings };
    }
    if (scheme === 'smsto' || scheme === 'sms') {
      return { kind: 'sms', label: 'Text message', deceptive,
        fields: [['To', t.slice(scheme.length + 1).split(':')[0]]], warnings };
    }
    if (scheme === 'geo') {
      return { kind: 'geo', label: 'Geographic location', deceptive,
        fields: [['Coordinates', t.slice(4)]], warnings };
    }
    if (DANGEROUS_SCHEMES.includes(scheme)) {
      warnings.unshift('Uses the "' + scheme + ':" scheme, which executes or embeds content rather than pointing at a page. There is very little legitimate reason for a printed code to contain this.');
      return { kind: 'url', label: scheme + ': payload', deceptive, fields: [['Scheme', scheme]], warnings };
    }
    if (scheme === 'http' || scheme === 'https') {
      return analyseUrl(t, warnings, deceptive);
    }
    warnings.push('Uses the "' + scheme + ':" scheme, which would hand this to another app rather than opening a web page.');
    return { kind: 'url', label: scheme + ': link', deceptive, fields: [['Scheme', scheme]], warnings };
  }

  // A bare domain with no scheme still reads as a link to most people.
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(t) && !t.includes(' ')) {
    return analyseUrl('https://' + t, [
      'Written without a scheme. Shown here as https, but a reader could equally treat it as http.',
      ...warnings,
    ], deceptive);
  }

  return { kind: 'text', label: 'Plain text', deceptive, fields: [], warnings };
}

function analyseUrl(raw: string, warnings: string[], deceptive: boolean): PayloadAnalysis {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: 'text', label: 'Plain text', deceptive, fields: [], warnings };
  }

  const host = u.hostname;

  if (u.username || u.password) {
    warnings.unshift('Contains embedded credentials before the host, which is a classic way to make a link appear to point somewhere it does not.');
  }
  // Punycode is legitimate, and it is also how a lookalike domain hides: the
  // rendered form can be visually identical to a familiar name.
  if (/(^|\.)xn--/i.test(host)) {
    warnings.unshift('The domain is punycode-encoded, so it contains non-ASCII characters. It may render to look identical to a familiar name while being an entirely different domain.');
  }
  if (u.protocol === 'http:') {
    warnings.push('Uses plain http, so anything sent to or from this address travels unencrypted.');
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    warnings.push('Points at a raw IP address rather than a name.');
  }
  if (raw.length > 300) {
    warnings.push('Unusually long, which makes the real destination hard to read at a glance.');
  }

  const fields: Array<[string, string]> = [
    ['Scheme', u.protocol.replace(':', '')],
    ['Host', host],
  ];
  if (u.port) fields.push(['Port', u.port]);
  if (u.pathname && u.pathname !== '/') fields.push(['Path', u.pathname]);
  if (u.search) fields.push(['Query', u.search.slice(1)]);

  return { kind: 'url', label: 'Web address', deceptive, fields, warnings };
}

/** `K:value;` pairs with backslash escaping, as used by WIFI: and MECARD:. */
function parseSemicolonPairs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = '', val = '', inVal = false, esc = false;
  for (const ch of s) {
    if (esc) { if (inVal) val += ch; else key += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === ':' && !inVal) { inVal = true; continue; }
    if (ch === ';') { if (key) out[key.toUpperCase()] = val; key = ''; val = ''; inVal = false; continue; }
    if (inVal) val += ch; else key += ch;
  }
  if (key) out[key.toUpperCase()] = val;
  return out;
}

/**
 * Render invisible and control characters visibly.
 *
 * The payload is shown so a person can judge it, and a character that alters
 * the rendering of everything after it defeats that completely. Replacing them
 * with a visible marker is the only honest way to display the string.
 */
export function makeVisible(text: string): string {
  return text.replace(ALL_HIDDEN, (c) =>
    '<U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0') + '>');
}
