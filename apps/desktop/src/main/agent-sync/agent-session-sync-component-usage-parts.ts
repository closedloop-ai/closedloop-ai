/**
 * @file agent-session-sync-component-usage-parts.ts
 * @description ISS-6884's component-usage pagination units, gathered in one
 * place: the fold-family groups the packer walks, the WIRE-identity groups the
 * parity guard measures against, and the subset a single part can actually
 * carry. Extracted from `agent-session-sync-payload.ts` (ISS-9859) to keep that
 * file under the 1,000-line ceiling.
 */
import type { SyncedComponentUsage } from "@repo/api/src/types/agent-session";
import { MAX_SYNCED_COMPONENT_USAGE } from "@repo/api/src/types/agent-session";
import { remainingChunkByteBudget } from "./agent-session-sync-chunk-packer.js";
import {
  componentUsageMergeKey,
  componentUsageWireKey,
  groupComponentUsageByComponent,
} from "./agent-session-sync-component-usage-identity.js";
import type { SyncPayloadSizer } from "./agent-session-sync-compression.js";
import type { SyncedAgentSession } from "./agent-session-sync-contract.js";

export type ComponentUsageParts = {
  /** Pagination units: whole (kind,key) fold families. */
  foldUnits: SyncedComponentUsage[][];
  /**
   * ISS-6884 (codex review): the parity baseline is grouped on the WIRE
   * identity, not the fold-family one. See `boundedComponentUsageRetry`.
   */
  wireUnits: SyncedComponentUsage[][];
  /** The fold units one part can carry, by both row count and bytes. */
  sendableUnits: SyncedComponentUsage[][];
};

const NO_COMPONENT_USAGE_PARTS: ComponentUsageParts = {
  foldUnits: [],
  wireUnits: [],
  sendableUnits: [],
};

/**
 * Group this session's component usage for a paginated split, or nothing when
 * the set rides the base whole.
 *
 * ISS-6884: a unit no single part can carry is dropped HERE, before paginating.
 * The packer ABORTS its scan on an item that fits no chunk of its own — correct
 * for events, which then dead-letter — so leaving such a unit in the list would
 * permanently strand every unit ordered after it. Skipping it is the same
 * skip-and-continue the reader applies to its own row cap. Both ceilings have to
 * be checked: the reader bounds a group by ROWS and nothing bounds its BYTES,
 * and the fused command/skill unit is bounded by neither.
 */
export function collectComponentUsageParts(input: {
  session: SyncedAgentSession;
  paginate: boolean;
  buildComponentUsageChunk: (
    slice: SyncedComponentUsage[][]
  ) => SyncedAgentSession;
  maxBytes: number;
  sizer: SyncPayloadSizer;
  maxDecompressedBytes: number;
}): ComponentUsageParts {
  if (!input.paginate) {
    return NO_COMPONENT_USAGE_PARTS;
  }
  const foldUnits = groupComponentUsageByComponent(
    input.session.components,
    componentUsageMergeKey
  );
  const unitBudget = remainingChunkByteBudget(
    input.buildComponentUsageChunk([]),
    input.maxBytes,
    input.sizer,
    input.maxDecompressedBytes
  );
  return {
    foldUnits,
    wireUnits: groupComponentUsageByComponent(
      input.session.components,
      componentUsageWireKey
    ),
    sendableUnits: foldUnits.filter(
      (unit) =>
        unit.length <= MAX_SYNCED_COMPONENT_USAGE &&
        Buffer.byteLength(JSON.stringify(unit)) <= unitBudget
    ),
  };
}
