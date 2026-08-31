/**
 * Target platform.
 *
 * The handoff was written defensively against unknown iOS versions, so several
 * of its capabilities carry version gates: Wake Lock 16.4+, WebGPU 26+,
 * AudioWorklet 14.5+, getUserMedia in WKWebView 14.3+. We now target iOS 26+,
 * which clears every one of those.
 *
 * This does NOT mean we stop feature-detecting. §1 is still right: the reason
 * to detect is that Chrome and Edge on iOS are WKWebView, and what WebKit
 * exposes to an embedded web view is not guaranteed to match what Safari
 * exposes at the same OS version. A version floor tells us what SHOULD be
 * present; detection tells us what IS. Where they disagree, that is a finding
 * worth surfacing rather than a shrug — see the diagnostics screen.
 */

export const TARGET = {
  os: 'iOS 26+',
  /** Verified against this device. Update as the test matrix grows. */
  testedOn: 'iPhone, iOS 26.6.1, Chrome',
  /** Capabilities the target floor guarantees, at least in Safari. */
  expected: {
    wakeLock: true,   // 16.4+
    // Safari 26+ has it on by default, and §11 q.6 is now answered: it is
    // also present in Chrome on iOS 26, so WKWebView exposes it too.
    webgpu: true,
    audioWorklet: true, // 14.5+
    mediaDevices: true, // WKWebView 14.3+
  },
} as const;

export type ExpectedCapability = keyof typeof TARGET.expected;
