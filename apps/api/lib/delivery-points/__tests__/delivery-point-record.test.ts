/**
 * THE SEAM TEST (ISS-8399).
 *
 * The claim under test is not "the types compile" — it is that a provider which
 * is NOT Pensero can reach persistence without touching Pensero code. So this
 * file deliberately imports nothing from `@repo/pensero`: no contract, no row
 * type, no extractor, no interaction join. Everything it hands the store it
 * builds from our own stored vocabulary.
 *
 * If `DeliveryPointWrite` is ever changed back to carrying a `ResolvedDeliveryRow`
 * (or any other provider's own row), this file stops compiling — which is the
 * failure mode a rationale in a docstring cannot give you.
 *
 * WHAT THIS DOES NOT CLAIM. A genuinely new provider still needs two things
 * this test cannot fabricate: a `DeliveryPointProvider` enum member to be stored
 * as, and an entry in `DELIVERY_PROVIDER_BINDINGS`. That is by design — the
 * exhaustive `Record<NumeratorProvider, …>` makes both a compile error rather
 * than a silent gap — but it means the write below is stored under the one
 * association provider that exists today. The Pensero-shaped thing here is the
 * enum member, not the payload, and the payload is what the seam is about.
 */

import { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/database")>();
  const mocked = Object.assign(vi.fn(), { tx: vi.fn() });
  return { ...actual, withDb: mocked };
});

import {
  DeliveryContributorRole,
  DeliveryItemType,
  DeliveryMatchOutcome,
  withDb,
} from "@repo/database";
import type { DeliveryMatchTarget } from "../delivery-point-matcher";
import type { NormalizedDeliveryPoint } from "../delivery-point-record";
import { persistDeliveryPoints } from "../delivery-point-store";

const ORG = "org-1";

/** The refusal names the reason, so the message is part of the assertion. */
const DERIVED_PROVIDER_RE = /derived/;

/**
 * A record from a hypothetical story-point provider. Note what is absent: any
 * provider-side vocabulary. `itemType` and `role` are OUR enums, so this
 * provider never has to learn Pensero's `pull_request_review` / `creator`
 * spellings in order to say what its record is.
 */
const STORY_POINT_RECORD: NormalizedDeliveryPoint = {
  providerItemId: "JIRA-STORY-991",
  providerInteractionId: null,
  itemType: DeliveryItemType.TICKET,
  rawItemType: "Story",
  role: DeliveryContributorRole.ASSIGNEE,
  rawRole: "assignee",
  points: 8,
  deliveredOn: "2026-08-02",
  title: "ISS-4881: Add a widget export contract",
  providerPersonId: "acct-77",
  personEmail: "daveth.oakhurst@closedloop.ai",
};

const MATCHED_TARGET: DeliveryMatchTarget = {
  outcome: DeliveryMatchOutcome.MATCHED,
  repositoryFullName: "closedloop-ai/closedloop-ai",
  pullRequestNumber: 4228,
  pullRequestDetailId: "prd-4228",
  branchArtifactId: "art-branch-4228",
  artifacts: [],
};

type Upserted = {
  providerItemId: string;
  itemType: DeliveryItemType;
  role: DeliveryContributorRole;
  points: number;
  personEmail: string;
  title: string;
  providerInteractionId: string | null;
};

let upserts: Upserted[] = [];

function makeFakeDb() {
  return {
    deliveryPoint: {
      upsert: (args: {
        where: {
          organizationId_provider_providerItemId: { providerItemId: string };
        };
        create: Record<string, unknown>;
      }) => {
        upserts.push(args.create as unknown as Upserted);
        return Promise.resolve({
          id: `dp-${args.where.organizationId_provider_providerItemId.providerItemId}`,
        });
      },
    },
    deliveryPointArtifact: {
      deleteMany: () => Promise.resolve({ count: 0 }),
      createMany: ({ data }: { data: unknown[] }) =>
        Promise.resolve({ count: data.length }),
    },
  };
}

describe("the delivery-point store accepts a record no provider package produced", () => {
  beforeEach(() => {
    upserts = [];
    vi.clearAllMocks();
    const db = makeFakeDb();
    vi.mocked(withDb.tx).mockImplementation((callback) =>
      Promise.resolve(callback(db as never))
    );
  });

  it("persists a hand-built record with no provider row behind it", async () => {
    const result = await persistDeliveryPoints(ORG, NumeratorProvider.Pensero, [
      { point: STORY_POINT_RECORD, target: MATCHED_TARGET, userId: "user-1" },
    ]);

    expect(result.rowsWritten).toBe(1);
    expect(upserts).toEqual([
      expect.objectContaining({
        providerItemId: "JIRA-STORY-991",
        itemType: DeliveryItemType.TICKET,
        rawItemType: "Story",
        role: DeliveryContributorRole.ASSIGNEE,
        rawRole: "assignee",
        points: 8,
        personEmail: "daveth.oakhurst@closedloop.ai",
        providerInteractionId: null,
      }),
    ]);
  });

  it("stores a measured zero from that record as a measured zero", async () => {
    await persistDeliveryPoints(ORG, NumeratorProvider.Pensero, [
      {
        point: { ...STORY_POINT_RECORD, points: 0 },
        target: MATCHED_TARGET,
        userId: null,
      },
    ]);
    expect(upserts[0].points).toBe(0);
  });

  it("refuses a DERIVED provider rather than pretending to have stored it", async () => {
    await expect(
      persistDeliveryPoints(ORG, NumeratorProvider.Loc, [
        { point: STORY_POINT_RECORD, target: MATCHED_TARGET, userId: null },
      ])
    ).rejects.toThrow(DERIVED_PROVIDER_RE);
    expect(upserts).toEqual([]);
  });
});
