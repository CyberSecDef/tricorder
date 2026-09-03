/**
 * Build provenance, injected by vite.config.ts at build time (§19).
 *
 * Every field is nullable and every consumer must render the unknown case,
 * because all of them come from `git` succeeding in the build directory. A
 * tarball with no `.git` is a legitimate way to build this, and About says
 * "unknown" there rather than inventing a hash.
 */
export interface BuildInfo {
  version: string | null;
  commit: string | null;
  branch: string | null;
  committedAt: string | null;
  /** true = built from a modified tree, so `commit` is not the whole story. */
  dirty: boolean | null;
  builtAt: string;
}

declare const __BUILD__: BuildInfo;

/** Falls back to a fully-unknown record under a bundler that has no define. */
export const BUILD: BuildInfo = typeof __BUILD__ === 'undefined'
  ? { version: null, commit: null, branch: null, committedAt: null, dirty: null,
      builtAt: new Date(0).toISOString() }
  : __BUILD__;
