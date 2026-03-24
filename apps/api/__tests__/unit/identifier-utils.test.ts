import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall } from "../utils/db-helpers";

vi.mock("server-only", () => ({}));
vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  Prisma: { DbNull: "DbNull" },
}));

import { EntityType } from "@repo/api/src/types/entity-link";
import {
  isUuid,
  resolveArtifactId,
  resolveEntityLinkIdentifier,
  resolveFeatureId,
  resolveProjectId,
  resolveWorkstreamId,
  uuidOrSlug,
} from "../../lib/identifier-utils";

describe("isUuid", () => {
  it("returns true for a valid UUID v4", () => {
    expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("returns true for a valid UUID v7", () => {
    expect(isUuid("01932b3a-7e4d-7c8f-9a1b-2c3d4e5f6a7b")).toBe(true);
  });

  it("returns true for uppercase UUID", () => {
    expect(isUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
  });

  it("returns false for typed slugs", () => {
    expect(isUuid("PRD-42")).toBe(false);
    expect(isUuid("FEAT-1")).toBe(false);
    expect(isUuid("PROJ-123")).toBe(false);
    expect(isUuid("WORK-5")).toBe(false);
    expect(isUuid("PLAN-7")).toBe(false);
  });

  it("returns false for nanoid slugs", () => {
    expect(isUuid("m4e8g7k2j9h5b3")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isUuid("")).toBe(false);
  });

  it("returns false for partial UUIDs", () => {
    expect(isUuid("550e8400-e29b-41d4")).toBe(false);
  });
});

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
    for (const slug of ["PROJ-1", "WORK-99", "PRD-42", "PLAN-7", "FEAT-123"]) {
      expect(schema.safeParse(slug).success).toBe(true);
    }
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

describe("resolveArtifactId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns UUID directly when input is a UUID", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = await resolveArtifactId(uuid, "org-1");
    expect(result).toBe(uuid);
  });

  it("queries by slug when input is not a UUID", async () => {
    const mockDb = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({ id: "resolved-uuid" }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveArtifactId("PRD-42", "org-1");
    expect(result).toBe("resolved-uuid");
    expect(mockDb.artifact.findUnique).toHaveBeenCalledWith({
      where: {
        organizationId_slug: { organizationId: "org-1", slug: "PRD-42" },
      },
      select: { id: true },
    });
  });

  it("returns null when slug not found", async () => {
    const mockDb = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveArtifactId("PRD-999", "org-1");
    expect(result).toBeNull();
  });
});

describe("resolveFeatureId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns UUID directly when input is a UUID", async () => {
    const uuid = "01932b3a-7e4d-7c8f-9a1b-2c3d4e5f6a7b";
    const result = await resolveFeatureId(uuid, "org-1");
    expect(result).toBe(uuid);
  });

  it("queries by slug when input is not a UUID", async () => {
    const mockDb = {
      feature: {
        findUnique: vi.fn().mockResolvedValue({ id: "feature-uuid" }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveFeatureId("FEAT-42", "org-1");
    expect(result).toBe("feature-uuid");
  });
});

describe("resolveProjectId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns UUID directly when input is a UUID", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = await resolveProjectId(uuid, "org-1");
    expect(result).toBe(uuid);
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

describe("resolveWorkstreamId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns UUID directly when input is a UUID", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = await resolveWorkstreamId(uuid, "org-1");
    expect(result).toBe(uuid);
  });

  it("queries by slug when input is not a UUID", async () => {
    const mockDb = {
      workstream: {
        findUnique: vi.fn().mockResolvedValue({ id: "ws-uuid" }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveWorkstreamId("WORK-5", "org-1");
    expect(result).toBe("ws-uuid");
  });
});

describe("resolveEntityLinkIdentifier", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves artifact slug via resolveArtifactId", async () => {
    const mockDb = {
      artifact: {
        findUnique: vi.fn().mockResolvedValue({ id: "art-uuid" }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveEntityLinkIdentifier(
      "PRD-1",
      "org-1",
      EntityType.Artifact
    );
    expect(result).toBe("art-uuid");
  });

  it("resolves feature slug via resolveFeatureId", async () => {
    const mockDb = {
      feature: {
        findUnique: vi.fn().mockResolvedValue({ id: "feature-uuid" }),
      },
    };
    mockWithDbCall(mockDb);

    const result = await resolveEntityLinkIdentifier(
      "FEAT-42",
      "org-1",
      EntityType.Feature
    );
    expect(result).toBe("feature-uuid");
  });

  it("returns UUID directly for ExternalLink when input is a UUID", async () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = await resolveEntityLinkIdentifier(
      uuid,
      "org-1",
      EntityType.ExternalLink
    );
    expect(result).toBe(uuid);
  });

  it("returns null for ExternalLink when input is not a UUID", async () => {
    const result = await resolveEntityLinkIdentifier(
      "not-a-uuid",
      "org-1",
      EntityType.ExternalLink
    );
    expect(result).toBeNull();
  });
});
