import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: "DbNull" },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

import {
  resolveArtifactIdentifier,
  resolveDocumentId,
  resolveProjectId,
  uuidOrSlug,
} from "../../lib/identifier-utils";

describe("uuidOrSlug", () => {
  const schema = uuidOrSlug();

  it("accepts a UUID", () => {
    const result = schema.safeParse("550e8400-e29b-41d4-a716-446655440000");
    expect(result.success).toBe(true);
  });

  it("accepts a typed slug", () => {
    const result = schema.safeParse("PRD-42");
    expect(result.success).toBe(true);
  });

  it("accepts a nanoid slug", () => {
    const result = schema.safeParse("m4e8g7k2j9h5b3");
    expect(result.success).toBe(true);
  });

  it("accepts all typed slug prefixes", () => {
    // FEA-4137: ISS- (canonical Issue) and FEA- (compat alias) both accepted.
    for (const slug of [
      "PRO-1",
      "WRK-99",
      "PRD-42",
      "PLN-7",
      "FEA-123",
      "ISS-123",
    ]) {
      expect(schema.safeParse(slug).success).toBe(true);
    }
  });

  it("accepts a DOC-* slug (ISS-10984)", () => {
    expect(schema.safeParse("DOC-39").success).toBe(true);
  });

  it("rejects empty string", () => {
    const result = schema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("rejects arbitrary strings that are not UUID or slug", () => {
    expect(schema.safeParse("hello world").success).toBe(false);
    expect(
      schema.safeParse("some random string that is too long").success
    ).toBe(false);
    expect(schema.safeParse("INVALID-42").success).toBe(false);
    expect(schema.safeParse("short").success).toBe(false);
  });

  it("rejects slug-like strings with wrong prefix", () => {
    expect(schema.safeParse("FOO-42").success).toBe(false);
    expect(schema.safeParse("BAR-1").success).toBe(false);
  });

  it("rejects typed slug without number", () => {
    expect(schema.safeParse("PRD-").success).toBe(false);
    expect(schema.safeParse("PRD-abc").success).toBe(false);
  });
});

describe("resolveDocumentId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ISS-6988: this case previously asserted the UUID was handed straight back
  // with no query at all. The expectation changed because the behavior did —
  // the UUID branch now proves org membership before returning, so what it must
  // assert is the org predicate reaching the `where`, not the passthrough.
  it("confirms a UUID belongs to the org before returning it", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const findFirst = vi.fn().mockResolvedValue({ id: uuid });
    mockWithDbCall({ artifact: { findFirst } });

    const result = await resolveDocumentId(uuid, "org-1");

    expect(result).toBe(uuid);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: uuid, organizationId: "org-1" },
      select: { id: true },
    });
  });

  it("returns null for a UUID that resolves to no row in the org", async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    mockWithDbCall({ artifact: { findFirst } });

    const result = await resolveDocumentId(
      "550e8400-e29b-41d4-a716-446655440000",
      "org-1"
    );

    expect(result).toBeNull();
  });

  // A Branch/PR artifact UUID reaches this resolver on live paths (see
  // `/documents/[id]/threads`), so the UUID branch must not narrow on `type` —
  // that would 404 a row the caller can legitimately address.
  it("does not constrain artifact type on the UUID branch", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const findFirst = vi.fn().mockResolvedValue({ id: uuid });
    mockWithDbCall({ artifact: { findFirst } });

    await resolveDocumentId(uuid, "org-1");

    const [{ where }] = findFirst.mock.calls[0] as [{ where: object }];
    expect(where).not.toHaveProperty("type");
  });

  it("queries by slug when input is not a UUID", async () => {
    const mockDb = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue({ id: "resolved-uuid" }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveDocumentId("PRD-42", "org-1");
    expect(result).toBe("resolved-uuid");
    // A prefix with no alias expands to just its own slug.
    expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        slug: { in: ["PRD-42"] },
        type: "DOCUMENT",
      },
      select: { id: true },
    });
  });

  // FEA-4137: an incoming ISS-### slug must resolve an existing row stored as
  // FEA-### (and vice-versa) — the resolver tries every alias slug for the same
  // numeric identity, so old FEA links keep resolving after the rename.
  it("resolves an ISS- slug against both ISS- and FEA- rows (compat alias)", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "issue-uuid" });
    mockWithDbCall({ artifact: { findFirst } });

    const result = await resolveDocumentId("ISS-592", "org-1");

    expect(result).toBe("issue-uuid");
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        slug: { in: ["ISS-592", "FEA-592"] },
        type: "DOCUMENT",
      },
      select: { id: true },
    });
  });

  it("still resolves a legacy FEA- slug (expands to include ISS-)", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "issue-uuid" });
    mockWithDbCall({ artifact: { findFirst } });

    const result = await resolveDocumentId("FEA-1", "org-1");

    expect(result).toBe("issue-uuid");
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        organizationId: "org-1",
        slug: { in: ["FEA-1", "ISS-1"] },
        type: "DOCUMENT",
      },
      select: { id: true },
    });
  });

  it("returns null when slug not found", async () => {
    const mockDb = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveDocumentId("PRD-999", "org-1");
    expect(result).toBeNull();
  });
});

describe("resolveProjectId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ISS-7447: the UUID branch used to return the input unverified. It now
  // resolves through the same org-scoped existence check the slug branch does,
  // so these two cases pin the `where` the resolver actually issues rather than
  // only the value it hands back — a passthrough would satisfy the first case's
  // return value alone.
  it("confirms a UUID against the caller's org before returning it (ISS-7447)", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const findFirst = vi.fn().mockResolvedValue({ id: uuid });
    mockWithDbCall({ project: { findFirst } });

    const result = await resolveProjectId(uuid, "org-1");

    expect(result).toBe(uuid);
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: uuid, organizationId: "org-1" },
      select: { id: true },
    });
  });

  it("returns null for a UUID naming no project in the caller's org (ISS-7447)", async () => {
    mockWithDbCall({ project: { findFirst: vi.fn().mockResolvedValue(null) } });

    await expect(
      resolveProjectId("550e8400-e29b-41d4-a716-446655440000", "org-1")
    ).resolves.toBeNull();
  });

  it("queries by slug when input is not a UUID", async () => {
    const mockDb = {
      project: {
        findUnique: vi.fn().mockResolvedValue({ id: "proj-uuid" }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveProjectId("PROJ-1", "org-1");
    expect(result).toBe("proj-uuid");
  });
});

describe("resolveArtifactIdentifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves document slug via artifact lookup", async () => {
    const mockDb = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue({ id: "art-uuid" }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveArtifactIdentifier("PRD-1", "org-1");
    expect(result).toBe("art-uuid");
  });

  it("returns UUID directly when input is a UUID and artifact exists", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const mockDb = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue({ id: uuid }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveArtifactIdentifier(uuid, "org-1");
    expect(result).toBe(uuid);
  });

  it("returns null when UUID is not found in org", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const mockDb = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveArtifactIdentifier(uuid, "org-1");
    expect(result).toBeNull();
  });

  it("returns null when slug cannot be resolved", async () => {
    const mockDb = {
      artifact: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveArtifactIdentifier("PRD-999", "org-1");
    expect(result).toBeNull();
  });
});
