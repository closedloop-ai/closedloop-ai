import type { PackAnalyticsResponse } from "@repo/api/src/types/analytics";
import { resolveLocPerDollar } from "@repo/api/src/utils/loc-per-dollar";
import { ipcMain, type WebContents } from "electron";
import { z } from "zod";
import { PACK_ANALYTICS_IPC_CHANNEL } from "../../shared/pack-analytics-channel.js";
import { unwrapApiEnvelope } from "../util/api-response-utils.js";
import { fetchJsonAndParse } from "../util/fetch-json-and-parse.js";

/**
 * Desktop-team overlay bridge: the renderer asks main for a pack's org-wide
 * analytics; main calls the cloud with the signed-in device token (renderers
 * have no cloud REST access). Mirrors the distributions-client auth pattern.
 */

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The wire shape, declared `satisfies Record<keyof PackAnalyticsResponse, …>`
 * (wongk, #5096 review).
 *
 * ISS-6462 was this boundary silently DROPPING an optional field the contract
 * already carried: Zod strips what the schema does not declare, so the renderer
 * received a response whose disclosure had been deleted in transit and printed a
 * capped scan as an exact count. Nothing failed — not the producer's tests, not
 * `tsc`, not the parse. The `satisfies` below makes the next optional field a
 * COMPILE error here instead: adding one to `PackAnalyticsResponse` without a
 * key in this shape no longer typechecks, and the excess-property check on the
 * same annotation catches a key this contract does not have.
 *
 * `keyof` includes the contract's OPTIONAL members, so the legacy aliases
 * (`klocPerDollar`, `klocDelta`) and `mergedPrsTruncated` are all required to be
 * present here — which is exactly the set a version-skewed producer can send.
 */
const packAnalyticsShape = {
  packId: z.string(),
  invocations: z.number(),
  sessions: z.number(),
  // ISS-4667: the cloud now sends LOC/$ under `locPerDollar`. A cloud instance
  // that predates ISS-4667 sends KLOC/$ under `klocPerDollar` and omits the
  // canonical field, so BOTH are optional here and the transform below picks
  // the canonical one — scaling the legacy value instead of handing the
  // renderer a figure a thousand times too small (or failing the whole parse
  // and blanking the overlay).
  locPerDollar: z.number().nullable().optional(),
  klocPerDollar: z.number().nullable().optional(),
  owners: z.array(z.string()),
  deviceCount: z.number(),
  // Comparison-based delivery metrics (FEA-2923 Performance tab). Deltas are
  // nullable (no baseline); quality is computed server-side but hidden in the UI.
  //
  // Version-skew tolerance: these fields were added after the desktop-team
  // overlay first shipped, so an older/skewed cloud response can OMIT them
  // entirely. Each is `.nullable().default(...)` (not merely `.nullable()`) so a
  // MISSING (undefined) field parses to the same empty value a present-but-null
  // field would — `null` for scalars, `[]` for the trend — rather than failing
  // the whole parse and dropping the response to the `null` sentinel. The
  // `.default(...)` also keeps the parsed output non-optional, so the result
  // still satisfies the required `CohortDeliveryMetrics` shape of
  // `PackAnalyticsResponse` with no `undefined` leaking to the renderer.
  //
  // ISS-4667: `locDelta` is the renamed `klocDelta`. A percentage lift is
  // unit-free, so a skewed cloud's `klocDelta` carries the same number and is
  // read as a straight fallback (no scaling).
  locDelta: z.number().nullable().optional(),
  klocDelta: z.number().nullable().optional(),
  successRate: z.number().nullable().default(null),
  successDelta: z.number().nullable().default(null),
  tokenEfficiencyDelta: z.number().nullable().default(null),
  efficiencyTrend: z.array(z.number()).default([]),
  mergedPrs: z.number().nullable().default(null),
  // ISS-6462: NO `.default(false)`, unlike its neighbours. The other
  // skew-sensitive fields have an empty value that means the same thing a
  // missing one does; this one does not. A cloud predating the disclosure
  // omits the flag while applying the very same `COHORT_SCAN_CAP`, so
  // defaulting the omission to `false` would make the renderer's tile assert
  // full-cohort coverage precisely when it cannot. Absence stays absent, and
  // `resolveMergedPrsCoverage` reads it as unknown.
  //
  // `.nullish()`, not `.optional()`: every sibling here tolerates an explicit
  // `null`, and a producer that serializes this absent optional as `null`
  // would otherwise fail the WHOLE parse and drop the response to the null
  // sentinel — blanking the entire overlay over one advisory field. Folded
  // back to `undefined` so both spellings of "not declared" reach the
  // renderer as the one unknown state the contract has.
  //
  // `.catch(undefined)` (wongk, #5096 review) extends that from `null` to
  // EVERY unusable value: a string, a number, a future tri-state spelling. All
  // of them are "this response does not declare its coverage", and none is
  // worth blanking the overlay for — the web path already treats anything
  // other than `true`/`false` as unknown (`resolveMergedPrsCoverage`), so
  // failing the whole parse here would make one advisory field louder than the
  // eleven real metrics beside it. Unusable degrades exactly like omission.
  mergedPrsTruncated: z
    .boolean()
    .nullish()
    .transform((value) => value ?? undefined)
    .catch(undefined),
  qualityScore: z.number().nullable().default(null),
  qualityDelta: z.number().nullable().default(null),
} satisfies Record<keyof PackAnalyticsResponse, z.ZodType>;

const packAnalyticsSchema = z.object(packAnalyticsShape).transform(
  ({
    locPerDollar,
    klocPerDollar,
    locDelta,
    klocDelta,
    ...rest
  }): PackAnalyticsResponse => ({
    ...rest,
    locPerDollar: resolveLocPerDollar(locPerDollar, klocPerDollar),
    // ISS-4667: a present canonical `locDelta` is authoritative — including an
    // explicit `null`, which is the producer's "not computable". Only an
    // OMITTED canonical field (`undefined`) falls back to the legacy
    // `klocDelta`, mirroring `resolveLocPerDollar`. A plain `??` would revive a
    // stale `klocDelta` from a mixed payload whenever the canonical delta was
    // legitimately null.
    locDelta: locDelta === undefined ? (klocDelta ?? null) : locDelta,
  })
);

export type PackAnalyticsIpcDeps = {
  getAccessToken: () => Promise<string | null>;
  getApiOrigin: () => string | undefined;
  isTrustedSender: (sender: WebContents) => boolean;
};

export function registerPackAnalyticsIpc(deps: PackAnalyticsIpcDeps): void {
  ipcMain.handle(
    PACK_ANALYTICS_IPC_CHANNEL,
    async (event, packId: unknown): Promise<PackAnalyticsResponse | null> => {
      if (!deps.isTrustedSender(event.sender)) {
        throw new Error("untrusted sender");
      }
      if (typeof packId !== "string" || packId.length === 0) {
        return null;
      }

      let token: string | null = null;
      try {
        token = await deps.getAccessToken();
      } catch {
        return null;
      }
      const apiOrigin = deps.getApiOrigin();
      if (!(token && apiOrigin)) {
        return null;
      }

      return fetchJsonAndParse(
        `/agent-components/pack/${encodeURIComponent(packId)}`,
        packAnalyticsSchema,
        {
          apiOrigin,
          token,
          unwrap: unwrapApiEnvelope,
          sentinel: null,
          timeoutMs: REQUEST_TIMEOUT_MS,
        }
      );
    }
  );
}
