import type { DocsHelpCorpusCopy } from "../lib/docs-help-labels";
import type { DocsHelpSource } from "../lib/docs-help-source";
import type { SlugifyHeading } from "./help-reader";

/**
 * The public contract of `HelpSurfaceV2` (ISS-10005).
 *
 * EVERY PROP IS REQUIRED, by design. ISS-9218 exists because an omitted optional
 * prop renders no control and looks identical to a surface that never had one.
 * With nothing optional, `tsc` fails an under-wired host, there is nothing for
 * `surface-capability-kind.ts` to classify and no `notSupported` to hide behind
 * — which is why no capability ledger accompanies this surface.
 */
export type HelpSurfaceV2Props = {
  /** What this host's docs bundle and its local index can currently say. */
  source: DocsHelpSource;
  /**
   * ISS-10006 — the three sentences naming where THIS host's docs come from.
   *
   * Required, like everything else here: a default would have shipped desktop's
   * "isn't available offline" to a browser, which is the exact shape of silent
   * host-specific claim this contract's all-required rule exists to prevent.
   */
  corpusCopy: DocsHelpCorpusCopy;
  /**
   * The host's heading slug, bound to ITS bundle generator.
   *
   * Host-owned for the same reason `ACTIVITY_COVERAGE_AXIS_LABELS` stayed with
   * the Diagnostics host in ISS-10004: moving it destroys the only test keeping
   * it honest. `docs-slug-parity.test.ts` runs under plain `node:test` against
   * the generator's `.mjs`, which cannot reach a `packages/app` module.
   */
  slugifyHeading: SlugifyHeading;
};
