import { describe, expect, it } from "vitest";
import {
  ArtifactSubtype,
  DocumentStatus,
  FeatureStatus,
} from "../../../../generated/client";
import { deterministicUuid } from "../../helpers";
import {
  detectOrgConflicts,
  SeedOrgPreflightStatus,
} from "../../non-empty-org-guard";
import { BASELINE_ORG_ID } from "../fixtures/baseline-org";
import {
  type AnyDelegate,
  buildSeedOwnedOrgMock,
  seedBranchArtifactRow,
  seedDeploymentArtifactRow,
  seedDocumentArtifactRow,
  seedFeatureArtifactRow,
  seedScaledDocumentArtifactRow,
  seedSessionArtifactRow,
  seedTemplateArtifactRow,
} from "../fixtures/org-guard-mocks";

/*
 * The per-model "is this row seed-owned?" predicates, split from
 * non-empty-org-guard.test.ts (which owns conflict detection and was already
 * near the 500-line smell).
 *
 * What these predicates gate is NOT `--reset`: `seed.ts` short-circuits the
 * preflight to `Clean` without calling `detectOrgConflicts` when
 * `reset.requested` is true. They gate seeding INTO a non-empty org. A
 * `Conflicted` verdict makes `seed.ts` throw unless the operator sets
 * `SEED_FORCE_OVERWRITE=1`; a `SeedOwned` verdict silently allows the run as an
 * idempotent re-seed.
 *
 * The asymmetry matters. A false negative merely asks the operator for the
 * force flag. A false POSITIVE lets the seed upsert over real customer rows
 * with no flag and no prompt. So each test below takes an otherwise-seed-owned
 * org and makes exactly one row unrecognisable, asserting the guard drops to
 * Conflicted rather than SeedOwned.
 */

async function detect(prisma: unknown) {
  return await detectOrgConflicts(
    prisma as Parameters<typeof detectOrgConflicts>[0],
    BASELINE_ORG_ID
  );
}

/** The seed-owned org, with one model's findMany swapped for `rows`. */
async function withRows(model: string, rows: unknown[], count?: number) {
  const prisma = buildSeedOwnedOrgMock();
  const p = prisma as AnyDelegate;
  p[model].findMany.mockResolvedValue(rows);
  p[model].count.mockResolvedValue(count ?? rows.length);
  return await detect(prisma);
}

describe("seed ownership — projects", () => {
  it("recognises a scaled seed project by its numbered slug", async () => {
    const result = await withRows("project", [
      {
        id: deterministicUuid(`project:${BASELINE_ORG_ID}:scaled-7`),
        slug: "scaled-seed-project-7",
      },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.SeedOwned);
  });

  it("REFUSES a project row with no slug", async () => {
    // A slug-less project cannot be proven seed-created, so it must not be
    // treated as safe to wipe.
    const result = await withRows("project", [
      { id: deterministicUuid("whatever"), slug: null },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("REFUSES a seed-looking slug whose id is not the derived one", async () => {
    // The slug alone is not the proof — the id must equal the deterministic
    // uuid the seed would have minted. A user-created project that happens to
    // be named `platform-foundation` must not qualify.
    const result = await withRows("project", [
      {
        id: deterministicUuid("some-other-derivation"),
        slug: "platform-foundation",
      },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("REFUSES a slug that resembles the scaled pattern but does not match it", async () => {
    const result = await withRows("project", [
      {
        id: deterministicUuid(`project:${BASELINE_ORG_ID}:scaled-x`),
        slug: "scaled-seed-project-x",
      },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });
});

/*
 * An artifact slug is customer-visible and customer-settable, so the slug alone
 * proves nothing: `seed-doc-<anything>` is a name any real row can carry. Only
 * the id proves ownership, because the seed derives every artifact id from a
 * fixed key via `deterministicUuid`. These cases therefore always pair a slug
 * with an id, and the counterexamples hold the slug seed-shaped while moving
 * the id — the exact false positive a prefix-only predicate would wave through.
 */
describe("seed ownership — artifacts", () => {
  it.each([
    ["document", seedDocumentArtifactRow(DocumentStatus.DRAFT)],
    [
      "document with an underscore status",
      seedDocumentArtifactRow(DocumentStatus.IN_REVIEW),
    ],
    ["feature", seedFeatureArtifactRow(FeatureStatus.IN_PROGRESS)],
    ["template", seedTemplateArtifactRow(ArtifactSubtype.PRD)],
    ["scaled document", seedScaledDocumentArtifactRow(4)],
    ["branch", seedBranchArtifactRow()],
    ["deployment", seedDeploymentArtifactRow()],
    ["session", seedSessionArtifactRow()],
  ])("recognises the seed's own %s artifact", async (_label, row) => {
    const result = await withRows("artifact", [row]);

    expect(result.status).toBe(SeedOrgPreflightStatus.SeedOwned);
  });

  it("REFUSES an artifact row with no slug", async () => {
    const result = await withRows("artifact", [
      { id: deterministicUuid("a"), slug: null },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("REFUSES an artifact whose slug carries no seed prefix", async () => {
    const result = await withRows("artifact", [
      { id: deterministicUuid("a"), slug: "customer-authored-doc" },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("REFUSES a seed-shaped slug whose id is not the derived one", async () => {
    // The false positive this predicate exists to stop: a real customer row
    // that happens to be named like a seed row. Same slug the seed would mint,
    // foreign id — a prefix-only check would classify it SeedOwned and let the
    // seed upsert over it without SEED_FORCE_OVERWRITE.
    const result = await withRows("artifact", [
      {
        ...seedDocumentArtifactRow(DocumentStatus.DRAFT),
        id: deterministicUuid("customer-authored-artifact"),
      },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("REFUSES a customer artifact named seed-doc-anything", async () => {
    // The reviewer's example, verbatim. It carries the seed prefix and no
    // status maps to it, so the derivation cannot be satisfied by a real row.
    const result = await withRows("artifact", [
      { id: deterministicUuid("customer-doc"), slug: "seed-doc-anything" },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("REFUSES a singleton slug carrying another org's id prefix", async () => {
    const result = await withRows("artifact", [
      { ...seedBranchArtifactRow(), slug: "seed-branch-deadbeef" },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });
});

/*
 * The guard recovers an artifact's id key by inverting the seed's slug: it
 * re-substitutes `_` for the `-` the seed wrote. That inverse is only total
 * while no status or subtype value contains a literal `-`. Driving the real
 * enums here means a future member that breaks it fails this suite rather than
 * silently demoting a legitimately seeded org to Conflicted.
 */
describe("seed ownership — artifact id derivation covers every enum member", () => {
  it.each(
    Object.values(DocumentStatus)
  )("recognises the seed document artifact for DocumentStatus.%s", async (status) => {
    const result = await withRows("artifact", [
      seedDocumentArtifactRow(status),
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.SeedOwned);
  });

  it.each(
    Object.values(FeatureStatus)
  )("recognises the seed feature artifact for FeatureStatus.%s", async (status) => {
    const result = await withRows("artifact", [seedFeatureArtifactRow(status)]);

    expect(result.status).toBe(SeedOrgPreflightStatus.SeedOwned);
  });

  it.each(
    Object.values(ArtifactSubtype).filter(
      (subtype) =>
        subtype !== ArtifactSubtype.TEMPLATE &&
        subtype !== ArtifactSubtype.ISSUE
    )
  )("recognises the seed template artifact for ArtifactSubtype.%s", async (subtype) => {
    const result = await withRows("artifact", [
      seedTemplateArtifactRow(subtype),
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.SeedOwned);
  });
});

describe("seed ownership — loops", () => {
  it.each([
    "Generate an implementation plan for X",
    "Execute the approved implementation plan",
    "Discuss architectural trade-offs for Y",
    "Evaluate the PRD against the rubric",
    "Generate implementation plan for event streaming",
    "Execute the webhook delivery system",
    "Discuss design options for the observability stack",
    "Execute the billing integration",
  ])("recognises the seed loop prompt %#", async (prompt) => {
    const result = await withRows("loop", [
      { id: deterministicUuid("l"), prompt },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.SeedOwned);
  });

  it("REFUSES a loop with a null prompt", async () => {
    const result = await withRows("loop", [
      { id: deterministicUuid("l"), prompt: null },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("REFUSES a loop with an empty prompt", async () => {
    const result = await withRows("loop", [
      { id: deterministicUuid("l"), prompt: "" },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("REFUSES a real user prompt", async () => {
    const result = await withRows("loop", [
      { id: deterministicUuid("l"), prompt: "Fix the checkout bug" },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });
});

describe("seed ownership — comments", () => {
  it.each([
    "Seed baseline comment",
    "Scaled seed comment 3",
    "Initial feedback on this document.",
    "Follow-up: looks good after review.",
    "Liveblocks collaborative comment.",
    "Resolved the concern mentioned above.",
    "GitHub PR review comment — naming",
  ])("recognises the seed comment text %#", async (plainText) => {
    const result = await withRows("comment", [
      { id: deterministicUuid("c"), plainText },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.SeedOwned);
  });

  it("REFUSES a comment with null text", async () => {
    const result = await withRows("comment", [
      { id: deterministicUuid("c"), plainText: null },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("REFUSES a genuine user comment", async () => {
    const result = await withRows("comment", [
      { id: deterministicUuid("c"), plainText: "Can we ship this Friday?" },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });
});

describe("seed ownership — custom fields", () => {
  it.each([
    "Notes",
    "Story Points",
    "Team",
    "Labels",
    "Target Date",
    "Reviewers",
  ])("recognises the seed custom field %s", async (name) => {
    const result = await withRows("customField", [
      { id: deterministicUuid("f"), name },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.SeedOwned);
  });

  it("REFUSES a custom field the seed never creates", async () => {
    const result = await withRows("customField", [
      { id: deterministicUuid("f"), name: "Customer Tier" },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("REFUSES a custom field with no name", async () => {
    const result = await withRows("customField", [
      { id: deterministicUuid("f"), name: null },
    ]);

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });
});

describe("seed ownership — row-count agreement", () => {
  it("REFUSES when the sample is shorter than the counted rows", async () => {
    // Every predicate also requires rows.length === count. A sample that does
    // not cover the whole population cannot prove the unsampled remainder is
    // seed-owned, so the guard must fail closed rather than extrapolate.
    const result = await withRows(
      "customField",
      [{ id: deterministicUuid("f"), name: "Notes" }],
      2
    );

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });

  it("REFUSES when the artifact sample is shorter than the counted rows", async () => {
    // Artifacts are the one model sampled with a `take` (SEED_OWNED_SAMPLE_LIMIT),
    // so this is the model where an under-covering sample is actually reachable.
    const result = await withRows(
      "artifact",
      [seedDocumentArtifactRow(DocumentStatus.DRAFT)],
      2
    );

    expect(result.status).toBe(SeedOrgPreflightStatus.Conflicted);
  });
});
