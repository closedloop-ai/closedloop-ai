/**
 * ISS-5274 keys-covered guard for the definition wire contract.
 *
 * The definition payload crosses a process boundary (compute worker → main →
 * db-host) through `packScanWorkerResponseSchema`. `z.object` STRIPS unknown
 * keys, so a field added to the canonical `DiscoveredDefinition` /
 * `DefinitionVariants` that the schema was never taught would be silently
 * dropped on the way to the db-host — and the in-process fallback path, which
 * skips the schema entirely, would never see it. That is the FEA-3701 failure
 * mode; these `@ts-expect-error` directives are what make it a compile error.
 *
 * Both guards are anchored on the CANONICAL types, not on the inferred wire
 * types: keying them on the wire type would be tautological (the wire type IS
 * the schema's output, so it can never disagree with itself).
 *
 * This directory is compiled by `typecheck:type-tests`, so a directive that
 * stops being needed fails the build — which is the point.
 */

import type { z } from "zod";
import type {
  DefinitionVariants,
  DiscoveredDefinition,
} from "../src/main/packs/definition-variant-fold.js";

type DiscoveredDefinitionShape = Record<
  keyof DiscoveredDefinition,
  z.ZodTypeAny
>;
type DefinitionWireShape = Record<
  keyof Omit<DefinitionVariants, "seenHashes">,
  z.ZodTypeAny
>;

declare const anySchema: z.ZodTypeAny;

// A leaf shape missing `content` is not total over `DiscoveredDefinition`. If
// this stops erroring, the guard in `pack-scan-worker-protocol.ts` has stopped
// being total and a new definition field can be dropped in transit.
// @ts-expect-error - omits every DiscoveredDefinition field except `kind`
export const incompleteDiscoveredDefinition: DiscoveredDefinitionShape = {
  kind: anySchema,
};

// A container shape missing `variants` would ship only the display row and
// silently discard every retained distinct-content variant body.
// @ts-expect-error - omits `variants`
export const incompleteDefinitionWire: DefinitionWireShape = {
  primary: anySchema,
};

// `keyof` includes OPTIONAL members, so the guard also fires for a newly-added
// optional field such as `projectPath` — the case most likely to be forgotten
// because it is conditionally emitted.
// @ts-expect-error - omits the optional `projectPath`
export const missingOptionalField: DiscoveredDefinitionShape = {
  kind: anySchema,
  externalId: anySchema,
  name: anySchema,
  installPath: anySchema,
  content: anySchema,
  harness: anySchema,
};
