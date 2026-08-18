/**
 * ISS-5255: the LOCAL delivery decision for one invocation generation.
 *
 * The predecessor of the item-cap test here imported
 * `AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS + 1` = 25,001 tool uses
 * through the real SQLite importer purely to make one `>` comparison true. That
 * cost a measured 150s (387s on a slow host, past its own 180s timeout) and took
 * the whole `test:node` runner past its 720s wall-clock cap during the Desktop
 * v0.16.1087 release. Profiling put the cost entirely in per-row SQL — building
 * the 25,001 items in memory takes 2ms — and `buildInvocationSyncParts` is a
 * pure function of the generation, so the decision is exercised directly here.
 *
 * Two of these three outcomes had NO test at all before this file.
 *
 * The dead-letter ROW this decision produces is a separate concern, and it keeps
 * its real-SQLite coverage in `component-invocations-local-projection.test.ts`
 * ("a generation the wire contract rejects is dead-lettered ...").
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS,
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_ITEM_BYTES,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  type AgentComponentInvocationCompleteGeneration,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  type AgentComponentInvocationSyncItem,
} from "@repo/api/src/types/agent-component-invocation";
import { AgentComponentInvocationSyncLocalError } from "../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import { computeAgentComponentInvocationGenerationId } from "../src/main/agent-sync/agent-component-invocation-sync-payload.js";
import { buildInvocationSyncParts } from "../src/main/database/invocation-sync-parts-builder.js";

const NOW = "2026-07-22T17:00:00.000Z";
const SESSION_ID = "session-parts-builder";
const DUPLICATE_INVOCATION_ID = /duplicate invocation id/;
/** The contract detail names the field path the shared boundary rejected. */
const REJECTED_FIELD_PATH = /relationship/;

function syncItem(index: number): AgentComponentInvocationSyncItem {
  return {
    externalInvocationId: `inv_${String(index).padStart(6, "0")}`,
    sourceSessionId: SESSION_ID,
    kind: AgentComponentInvocationKind.Tool,
    componentKey: "Read",
    rawName: "Read",
    normalizedName: "read",
    relationship: AgentComponentInvocationRelationship.Direct,
    invokedAt: NOW,
    sequence: index,
    anchor: {
      kind: AgentComponentInvocationAnchorKind.Timestamp,
      timestamp: NOW,
      ordinal: index,
    },
    providerInvocationId: `toolu_${index}`,
    // A tool-kind invocation cannot carry a definition version, so the shared
    // wire contract requires exactly this pairing: unresolved status with no
    // provenance evidence. Anything else is rejected by the boundary schema.
    status: AgentComponentInvocationAttributionStatus.Unresolved,
    evidenceClass: AgentComponentInvocationEvidenceClass.None,
  };
}

/** A generation carrying an id the builder is not expected to reach. */
const UNREACHED_GENERATION_ID = "0".repeat(64);

function generationWithId(
  items: AgentComponentInvocationSyncItem[],
  externalGenerationId: string
): AgentComponentInvocationCompleteGeneration {
  return {
    externalSessionId: SESSION_ID,
    externalGenerationId,
    sourceUpdatedAt: NOW,
    dataRevision: 7,
    sourceSequence: 0,
    items,
  };
}

/**
 * A generation whose id matches its own canonical items, exactly as
 * `loadAgentComponentInvocationCompleteGeneration` produces it — otherwise the
 * builder would fail the identity check instead of the branch under test.
 *
 * Only usable for item sets the canonicalizer accepts: it shares
 * `canonicalInvocationItems` with the builder, so an over-cap or oversized set
 * throws here first and must use {@link generationWithId} instead.
 */
function generationOf(
  items: AgentComponentInvocationSyncItem[]
): AgentComponentInvocationCompleteGeneration {
  return generationWithId(
    items,
    computeAgentComponentInvocationGenerationId(SESSION_ID, items)
  );
}

function itemsOfSize(count: number): AgentComponentInvocationSyncItem[] {
  return Array.from({ length: count }, (_, i) => syncItem(i));
}

describe("ISS-5255 invocation sync parts builder", () => {
  test("a generation above the item cap resolves the item-limit dead letter", () => {
    // The item-count guard returns before the identity check, so this
    // generation never needs a matching id.
    const built = buildInvocationSyncParts(
      generationWithId(
        itemsOfSize(AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS + 1),
        UNREACHED_GENERATION_ID
      )
    );

    assert.deepEqual(built, {
      parts: [],
      localError:
        AgentComponentInvocationSyncLocalError.GenerationItemLimitExceeded,
      localErrorDetail: null,
    });
  });

  test("a generation exactly at the item cap is built, not dead-lettered", () => {
    const built = buildInvocationSyncParts(
      generationOf(
        itemsOfSize(AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS)
      )
    );

    assert.equal(built.localError, null);
    assert.equal(built.localErrorDetail, null);
    assert.ok(built.parts.length > 0);
    assert.equal(
      built.parts.reduce((total, part) => total + part.items.length, 0),
      AGENT_COMPONENT_INVOCATION_SYNC_MAX_GENERATION_ITEMS
    );
  });

  test("an item over the wire byte limit resolves the wire-limit dead letter", () => {
    const oversized = syncItem(0);
    // Canonicalization rejects the oversized item before the identity check,
    // so this generation never needs a matching id either.
    const built = buildInvocationSyncParts(
      generationWithId(
        [
          {
            ...oversized,
            componentKey: "K".repeat(
              AGENT_COMPONENT_INVOCATION_SYNC_MAX_ITEM_BYTES + 1
            ),
          },
        ],
        UNREACHED_GENERATION_ID
      )
    );

    assert.deepEqual(built.parts, []);
    assert.equal(
      built.localError,
      AgentComponentInvocationSyncLocalError.GenerationWireLimitExceeded
    );
    // The detail is what makes a local dead letter diagnosable without the row.
    assert.equal(typeof built.localErrorDetail, "string");
    assert.ok((built.localErrorDetail ?? "").length > 0);
  });

  test("an item the shared ingest contract rejects resolves the contract dead letter", () => {
    const invalid = {
      ...syncItem(0),
      relationship:
        "not-a-declared-relationship" as AgentComponentInvocationSyncItem["relationship"],
    };
    const built = buildInvocationSyncParts(generationOf([invalid]));

    assert.deepEqual(built.parts, []);
    assert.equal(
      built.localError,
      AgentComponentInvocationSyncLocalError.WirePayloadContractViolation
    );
    assert.match(built.localErrorDetail ?? "", REJECTED_FIELD_PATH);
  });

  test("a failure that is neither limit nor contract propagates instead of dead-lettering", () => {
    // A duplicate invocation id is a plain Error, not one of the two classified
    // local-sync errors, so the builder must rethrow rather than invent a
    // dead-letter reason for it. Built by hand because a duplicate cannot
    // survive `computeAgentComponentInvocationGenerationId`.
    assert.throws(
      () =>
        buildInvocationSyncParts(
          generationWithId([syncItem(0), syncItem(0)], UNREACHED_GENERATION_ID)
        ),
      DUPLICATE_INVOCATION_ID
    );
  });
});
