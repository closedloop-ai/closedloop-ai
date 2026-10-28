/**
 * ISS-8285: the inventory identity a sync writes under.
 *
 * The defect this pins: ISS-8069 projected `componentKind` and
 * `externalComponentId` at the write, so a row stored before that under a value
 * over the byte budget — but inside the former 2704-byte unique tuple — is no
 * longer found by an upsert keyed on the projection. An upsert that finds
 * nothing CREATES, so the next sync mints a SECOND `AgentComponent` beside the
 * existing one, splitting inventory and search from every usage row still
 * attributed to the original.
 */
import { describe, expect, it, vi } from "vitest";
import {
  INDEX_KEY_MAX_BYTES,
  projectIndexKey,
} from "@/lib/index-key-projection";
import {
  resolveStoredComponentIdentity,
  type SyncedComponent,
} from "./component-identity-lookup";

const COMPUTE_TARGET_ID = "target-identity-1";
const OVER_BUDGET_EXTERNAL_ID = "e".repeat(INDEX_KEY_MAX_BYTES + 1);
const PROJECTED_EXTERNAL_ID = projectIndexKey(OVER_BUDGET_EXTERNAL_ID).value;

function buildComponent(
  overrides: Partial<SyncedComponent> = {}
): SyncedComponent {
  return {
    externalId: "skill::my-skill",
    componentKind: "skill",
    componentKey: "my-skill",
    contentHash: null,
    content: null,
    ...overrides,
  } as SyncedComponent;
}

/** A store that holds rows only under the keys it is given. */
function storeHolding(
  rows: ReadonlyArray<{
    componentKind: string;
    externalComponentId: string;
    componentKey: string | null;
  }>
) {
  const findUnique = vi.fn(
    (args: {
      where: {
        computeTargetId_componentKind_externalComponentId: {
          componentKind: string;
          externalComponentId: string;
        };
      };
    }) => {
      const asked =
        args.where.computeTargetId_componentKind_externalComponentId;
      return Promise.resolve(
        rows.find(
          (row) =>
            row.componentKind === asked.componentKind &&
            row.externalComponentId === asked.externalComponentId
        ) ?? null
      );
    }
  );
  return { db: { agentComponent: { findUnique } } as never, findUnique };
}

describe("resolveStoredComponentIdentity", () => {
  it("adopts the identity a legacy row is ALREADY stored under", async () => {
    // The row predates ISS-8069, so it holds the raw external id.
    const legacy = {
      componentKind: "skill",
      externalComponentId: OVER_BUDGET_EXTERNAL_ID,
      componentKey: "legacy-key",
    };
    const { db } = storeHolding([legacy]);

    const identity = await resolveStoredComponentIdentity(
      db,
      COMPUTE_TARGET_ID,
      buildComponent({ externalId: OVER_BUDGET_EXTERNAL_ID })
    );

    // Keying the upsert on this is what makes it an UPDATE of the existing row
    // rather than a second inventory row beside it.
    expect(identity).toEqual(legacy);
  });

  it("keeps the legacy row's componentKey, so its version history is not re-keyed", async () => {
    // `componentKey` is part of the sibling AgentComponentVersion UNIQUE tuple.
    // Writing the projected key here would strand the revisions already
    // recorded under the stored one.
    const { db } = storeHolding([
      {
        componentKind: "skill",
        externalComponentId: OVER_BUDGET_EXTERNAL_ID,
        componentKey: "stored-under-this",
      },
    ]);

    const identity = await resolveStoredComponentIdentity(
      db,
      COMPUTE_TARGET_ID,
      buildComponent({
        externalId: OVER_BUDGET_EXTERNAL_ID,
        componentKey: "whatever-the-payload-says",
      })
    );

    expect(identity.componentKey).toBe("stored-under-this");
  });

  it("falls back to the PROJECTED identity when no row exists yet", async () => {
    const { db, findUnique } = storeHolding([]);

    const identity = await resolveStoredComponentIdentity(
      db,
      COMPUTE_TARGET_ID,
      buildComponent({ externalId: OVER_BUDGET_EXTERNAL_ID })
    );

    expect(identity.externalComponentId).toBe(PROJECTED_EXTERNAL_ID);
    // Both candidates were genuinely probed before concluding it is new.
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it("prefers a PROJECTED row over a legacy raw row when both exist", async () => {
    const { db } = storeHolding([
      {
        componentKind: "skill",
        externalComponentId: PROJECTED_EXTERNAL_ID,
        componentKey: "current",
      },
      {
        componentKind: "skill",
        externalComponentId: OVER_BUDGET_EXTERNAL_ID,
        componentKey: "legacy",
      },
    ]);

    const identity = await resolveStoredComponentIdentity(
      db,
      COMPUTE_TARGET_ID,
      buildComponent({ externalId: OVER_BUDGET_EXTERNAL_ID })
    );

    expect(identity.componentKey).toBe("current");
  });

  it("probes when only componentKey bound, and adopts the stored key", async () => {
    // ISS-8200 (review): `componentKey` is NOT part of the unique this probe
    // searches, but it is an independent wire field capped at 512 CHARACTERS —
    // up to 2048 BYTES of multibyte UTF-8 — so it can bind while both identity
    // halves fit comfortably. Leaving it out of the gate short-circuited such a
    // component and returned a PROJECTED componentKey that no stored row was
    // ever checked against, which callers then write as the key the matched row
    // is already stored under and use as the AgentComponentVersion tuple.
    const { db, findUnique } = storeHolding([
      {
        componentKind: "skill",
        externalComponentId: "skill::my-skill",
        componentKey: "stored-under-this",
      },
    ]);

    const identity = await resolveStoredComponentIdentity(
      db,
      COMPUTE_TARGET_ID,
      buildComponent({ componentKey: "\u00e9".repeat(INDEX_KEY_MAX_BYTES) })
    );

    // Without componentKey in the gate this issues no read at all.
    expect(findUnique).toHaveBeenCalled();
    expect(identity.componentKey).toBe("stored-under-this");
  });

  it("issues NO read at all for an identity inside the byte budget", async () => {
    // Every component in practice. The probe could only re-find the row the
    // upsert's own `where` already names, so paying a point read per component
    // across a 200-component fan-out would be pure overhead.
    const { db, findUnique } = storeHolding([]);

    const identity = await resolveStoredComponentIdentity(
      db,
      COMPUTE_TARGET_ID,
      buildComponent()
    );

    expect(findUnique).not.toHaveBeenCalled();
    expect(identity).toEqual({
      componentKind: "skill",
      externalComponentId: "skill::my-skill",
      componentKey: "my-skill",
    });
  });
});
