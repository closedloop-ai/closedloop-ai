/**
 * ISS-7536 — the two `createLink` failures that must not reach the generic
 * catch as 500s: a self-link, and a repeat of an existing
 * `@@unique([sourceId, targetId, linkType])` row.
 *
 * Self-links are rejected at two layers because the layers see different
 * inputs. Zod compares the RAW body, so it only catches a literal string
 * match; a slug and the UUID it resolves to are different strings there and
 * collapse onto one id only after `resolveArtifactIdentifier`. The service
 * check is the one that actually closes the hole — the aliased case below goes
 * red if it is removed, while every Zod case stays green.
 */
import { LinkType } from "@repo/api/src/types/artifact";
import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PRODUCES admission reads the organization graph and placement state, which
// this suite's database fake does not model; its own coverage is the
// produces-cycle-admission integration suite.
vi.mock("@/app/artifact-links/produces-link-admission", () => ({
  refuseProducesLinkCycle: vi.fn(async () => null),
  refuseProducesLinkDepth: vi.fn(async () => null),
}));

const mocks = vi.hoisted(() => ({
  artifactFindFirst: vi.fn(),
  artifactFindMany: vi.fn(),
  executeRaw: vi.fn(),
  linkCreate: vi.fn(),
  linkAggregate: vi.fn(),
  withDb: Object.assign(vi.fn(), {
    tx: vi.fn(),
    inTransaction: vi.fn(() => false),
  }),
}));

vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  return { ...actual, withDb: mocks.withDb };
});

import { SELF_ARTIFACT_LINK_MESSAGE } from "../link-messages";
import { artifactLinksService } from "../service";
import { createArtifactLinkValidator } from "../validators";

const ORG = "org-1";
const ARTIFACT_UUID = "6f1c0c2e-0000-7000-8000-000000000001";
const OTHER_UUID = "6f1c0c2e-0000-7000-8000-000000000002";

const UNIQUE_INDEX_NAME = "artifact_links_source_id_target_id_link_type_key";

function prismaError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Prisma error ${code}`), { code });
}

/** The documented Prisma shape: the constraint arrives on `meta.target`. */
function metaTargetError(target: unknown): Error {
  return Object.assign(prismaError("P2002"), { meta: { target } });
}

/**
 * The shape `@prisma/adapter-pg` 7.8 actually emits — copied from a real
 * duplicate insert in the integration suite. `meta.target` is absent entirely,
 * which is why the service consults a second extractor.
 */
function driverAdapterError(
  constraint: { fields: string[] } | { index: string }
): Error {
  return Object.assign(prismaError("P2002"), {
    meta: {
      modelName: "ArtifactLink",
      driverAdapterError: {
        name: "DriverAdapterError",
        message: "UniqueConstraintViolation",
        cause: {
          originalCode: "23505",
          kind: "UniqueConstraintViolation",
          constraint,
        },
      },
    },
  });
}

describe("createArtifactLinkValidator — self-link refine", () => {
  it("rejects an identical UUID on both sides, naming targetId", () => {
    const result = createArtifactLinkValidator.safeParse({
      sourceId: ARTIFACT_UUID,
      targetId: ARTIFACT_UUID,
      linkType: LinkType.Produces,
    });

    expect(result.success).toBe(false);
    const issue = result.error?.issues.find(
      (candidate) => candidate.message === SELF_ARTIFACT_LINK_MESSAGE
    );
    expect(issue?.path).toEqual(["targetId"]);
    expect(issue?.code).toBe("custom");
  });

  it("rejects an identical slug on both sides", () => {
    const result = createArtifactLinkValidator.safeParse({
      sourceId: "PRD-42",
      targetId: "PRD-42",
      linkType: LinkType.RelatesTo,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      SELF_ARTIFACT_LINK_MESSAGE
    );
  });

  it("accepts two distinct endpoints", () => {
    const result = createArtifactLinkValidator.safeParse({
      sourceId: ARTIFACT_UUID,
      targetId: OTHER_UUID,
      linkType: LinkType.Produces,
    });

    expect(result.success).toBe(true);
  });

  it("cannot see a slug aliased onto its own UUID — the service gate's reason to exist", () => {
    const result = createArtifactLinkValidator.safeParse({
      sourceId: "PRD-42",
      targetId: ARTIFACT_UUID,
      linkType: LinkType.Produces,
    });

    expect(result.success).toBe(true);
  });
});

describe("artifactLinksService.createLink — ISS-7536 guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.artifactFindFirst.mockResolvedValue({ id: ARTIFACT_UUID });
    mocks.artifactFindMany.mockResolvedValue([
      { id: ARTIFACT_UUID, projectId: "project-1" },
      { id: OTHER_UUID, projectId: "project-1" },
    ]);
    mocks.linkAggregate.mockResolvedValue({ _max: { sortOrder: null } });
    const fakeClient = {
      $executeRaw: mocks.executeRaw,
      artifact: {
        findFirst: mocks.artifactFindFirst,
        findMany: mocks.artifactFindMany,
      },
      artifactLink: {
        aggregate: mocks.linkAggregate,
        create: mocks.linkCreate,
      },
    };
    mocks.withDb.mockImplementation((cb: (client: unknown) => unknown) =>
      cb(fakeClient)
    );
    mocks.withDb.tx.mockImplementation((cb: (client: unknown) => unknown) =>
      cb(fakeClient)
    );
  });

  it("rejects resolved-equal endpoints as BadRequest without reading or writing", async () => {
    const result = await artifactLinksService.createLink(ORG, {
      sourceId: ARTIFACT_UUID,
      targetId: ARTIFACT_UUID,
      linkType: LinkType.Produces,
    });

    expect(result).toEqual({ ok: false, error: Status.BadRequest });
    expect(mocks.linkCreate).not.toHaveBeenCalled();
    // Ahead of the endpoint reads: nothing is disclosed by rejecting two
    // identical ids, so the two org lookups are never issued.
    expect(mocks.artifactFindFirst).not.toHaveBeenCalled();
  });

  // apps/api/AGENTS.md requires handling BOTH the constraint-name string and
  // the field/column array shapes an adapter may report in `meta.target`, with
  // a test per shape. The real shape this adapter emits is pinned separately by
  // the integration suite.
  it.each([
    {
      label: "meta.target index name",
      error: metaTargetError(UNIQUE_INDEX_NAME),
    },
    {
      label: "meta.target model-field array",
      error: metaTargetError(["sourceId", "targetId", "linkType"]),
    },
    {
      label: "meta.target column array",
      error: metaTargetError(["source_id", "target_id", "link_type"]),
    },
    {
      label: "meta.target array carrying the index name",
      error: metaTargetError([UNIQUE_INDEX_NAME]),
    },
    {
      label: "driver-adapter constraint.fields",
      error: driverAdapterError({
        fields: ["source_id", "target_id", "link_type"],
      }),
    },
    {
      label: "driver-adapter constraint.index",
      error: driverAdapterError({ index: UNIQUE_INDEX_NAME }),
    },
  ])(
    "maps a duplicate-row P2002 reported as a $label to Conflict",
    async ({ error }) => {
      mocks.linkCreate.mockRejectedValue(error);

      const result = await artifactLinksService.createLink(ORG, {
        sourceId: ARTIFACT_UUID,
        targetId: OTHER_UUID,
        linkType: LinkType.Produces,
      });

      expect(result).toEqual({ ok: false, error: Status.Conflict });
    }
  );

  it.each([
    { label: "a single field of this index", target: ["target_id"] },
    {
      label: "an equal-length index swapping one of its columns",
      target: ["organization_id", "source_id", "link_type"],
    },
    {
      label: "a strict superset of this index",
      target: ["source_id", "target_id", "link_type", "organization_id"],
    },
    { label: "an unrelated index name", target: "artifacts_slug_key" },
  ])("re-throws a P2002 whose target is only $label", async ({ target }) => {
    // Partial overlap is NOT this constraint. Classifying it as one would
    // tell the caller a link already exists when a different unique failed.
    mocks.linkCreate.mockRejectedValue(metaTargetError(target));

    await expect(
      artifactLinksService.createLink(ORG, {
        sourceId: ARTIFACT_UUID,
        targetId: OTHER_UUID,
        linkType: LinkType.Produces,
      })
    ).rejects.toThrow("Prisma error P2002");
  });

  it("re-throws a P2002 raised by a different constraint", async () => {
    // Reporting an unrelated unique violation as "this link already exists"
    // would tell the caller to stop retrying a write that never conflicted on
    // the link.
    mocks.linkCreate.mockRejectedValue(metaTargetError("artifacts_slug_key"));

    await expect(
      artifactLinksService.createLink(ORG, {
        sourceId: ARTIFACT_UUID,
        targetId: OTHER_UUID,
        linkType: LinkType.Produces,
      })
    ).rejects.toThrow("Prisma error P2002");
  });

  it("re-throws a non-P2002 Prisma failure rather than reporting a Conflict", async () => {
    mocks.linkCreate.mockRejectedValue(prismaError("P2003"));

    await expect(
      artifactLinksService.createLink(ORG, {
        sourceId: ARTIFACT_UUID,
        targetId: OTHER_UUID,
        linkType: LinkType.Produces,
      })
    ).rejects.toThrow("Prisma error P2003");
  });

  it("returns the written link on the success path", async () => {
    const createdAt = new Date("2026-08-22T00:00:00.000Z");
    mocks.linkCreate.mockResolvedValue({
      id: "link-1",
      organizationId: ORG,
      sourceId: ARTIFACT_UUID,
      targetId: OTHER_UUID,
      linkType: LinkType.Produces,
      metadata: null,
      createdAt,
    });
    // The PRODUCES target is not a branch, so no evidence is derived.
    mocks.artifactFindFirst.mockResolvedValue(null);

    const result = await artifactLinksService.createLink(ORG, {
      sourceId: ARTIFACT_UUID,
      targetId: OTHER_UUID,
      linkType: LinkType.Produces,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: "link-1",
        organizationId: ORG,
        sourceId: ARTIFACT_UUID,
        targetId: OTHER_UUID,
        linkType: LinkType.Produces,
        metadata: null,
        createdAt,
      },
    });
  });
});
