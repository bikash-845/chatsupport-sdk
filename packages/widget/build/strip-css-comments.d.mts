// Types for the build-time stylesheet transform. Hand-written because the
// implementation is plain ESM that both a Node script (scripts/bundle.mjs)
// and a TypeScript config (tsup.config.ts) have to import without a build
// step of its own; `allowJs` is off across this repo, so tsc needs this file
// to see the module at all.
import type { Plugin } from 'esbuild';

export interface StripResult {
  /** The source with CSS block comments deleted from its template literals. */
  readonly code: string;
  /** Comment blocks deleted. */
  readonly removed: number;
  /** Blocks left in place because deleting them could change the CSS. */
  readonly kept: number;
  /** Source bytes the deletion saved. */
  readonly bytesRemoved: number;
}

export interface StripStats {
  readonly file: string;
  readonly removed: number;
  readonly kept: number;
  readonly bytesRemoved: number;
}

export declare const STYLESHEET_FILTER: RegExp;

export declare function stripCssComments(
  source: string,
  options?: { filename?: string },
): StripResult;

export declare function stripCssCommentsPlugin(options?: {
  onStrip?: (stats: StripStats) => void;
}): Plugin;
