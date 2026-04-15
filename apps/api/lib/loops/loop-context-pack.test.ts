/**
 * Unit tests for loop-context-pack.ts
 *
 * Covers:
 * - buildContextPackInMemory(): additionalRepos included when provided, omitted when not
 * - buildContextPackInMemory(): other ContextPack fields remain correct when additionalRepos is set
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (must come before imports) ---

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/artifacts/artifact-version-service", () => ({
  artifactVersionService: {
    getLatest: vi.fn().mockResolvedValue(null),
    getByVersion: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/app/artifacts/service", () => ({
  artifactsService: {
    findByIdSimple: vi.fn().mockResolvedValue(null),
    findOrgTemplate: vi.fn().mockResolvedValue(null),
    ensureDefaultTemplates: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/app/artifacts/attachments-service", () => ({
  ATTACHMENT_SIGNED_URL_MAX_FILES: 20,
  attachmentsService: {
    listWithSignedUrlsByArtifact: vi.fn().mockResolvedValue([]),
    listWithSignedUrlsByFeature: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock("@/app/features/service", () => ({
  featuresService: {
    findById: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/app/loops/service", () => ({
  loopsService: {
    findById: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock("@/lib/loops/loop-commands", () => ({
  getCommandHandler: vi.fn().mockReturnValue(undefined),
}));

vi.mock("@/lib/loops/loop-state", () => ({
  downloadMetadata: vi.fn().mockResolvedValue(null),
  uploadContextPack: vi.fn().mockResolvedValue("s3://mock-key"),
}));

// --- Imports (after mocks) ---

import type { AdditionalRepoRefWithToken } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import { buildContextPackInMemory } from "@/lib/loops/loop-context-pack";

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const BASE_LOOP = {
  id: "loop-1",
  userId: "user-1",
  command: LoopCommand.Plan,
  prompt: null,
  artifactId: null,
  artifactVersion: null,
  parentLoopId: null,
  repo: null,
  contextRefs: null,
};

// ---------------------------------------------------------------------------
// buildContextPackInMemory — additionalRepos
// ---------------------------------------------------------------------------

describe("buildContextPackInMemory — additionalRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("includes additionalRepos in ContextPack when provided with entries", async () => {
    const additionalRepos: AdditionalRepoRefWithToken[] = [
      { fullName: "org/repo-b", branch: "main", githubToken: "ghp_token_b" },
      { fullName: "org/repo-c", branch: "feature/x" },
    ];

    const pack = await buildContextPackInMemory(
      BASE_LOOP,
      "org-1",
      undefined,
      undefined,
      additionalRepos
    );

    expect(pack.additionalRepos).toEqual(additionalRepos);
    expect(pack.additionalRepos).toHaveLength(2);
  });

  it("omits additionalRepos from ContextPack when not provided (undefined)", async () => {
    const pack = await buildContextPackInMemory(BASE_LOOP, "org-1");

    expect(pack.additionalRepos).toBeUndefined();
  });

  it("omits additionalRepos from ContextPack when passed as empty array", async () => {
    const pack = await buildContextPackInMemory(
      BASE_LOOP,
      "org-1",
      undefined,
      undefined,
      []
    );

    expect(pack.additionalRepos).toBeUndefined();
  });

  it("preserves githubToken on each additionalRepo entry in the returned pack", async () => {
    const additionalRepos: AdditionalRepoRefWithToken[] = [
      { fullName: "acme/backend", branch: "main", githubToken: "ghp_secret" },
    ];

    const pack = await buildContextPackInMemory(
      BASE_LOOP,
      "org-1",
      undefined,
      undefined,
      additionalRepos
    );

    expect(pack.additionalRepos?.[0].githubToken).toBe("ghp_secret");
  });

  it("additionalRepo entries without tokens are preserved as-is", async () => {
    const additionalRepos: AdditionalRepoRefWithToken[] = [
      { fullName: "org/repo-no-token", branch: "develop" },
    ];

    const pack = await buildContextPackInMemory(
      BASE_LOOP,
      "org-1",
      undefined,
      undefined,
      additionalRepos
    );

    expect(pack.additionalRepos?.[0]).toEqual({
      fullName: "org/repo-no-token",
      branch: "develop",
    });
    expect(pack.additionalRepos?.[0].githubToken).toBeUndefined();
  });

  it("secrets field is still populated alongside additionalRepos", async () => {
    const secrets = { anthropicApiKey: "sk-ant-key", githubToken: "ghp_main" };
    const additionalRepos: AdditionalRepoRefWithToken[] = [
      { fullName: "org/repo-b", branch: "main", githubToken: "ghp_b" },
    ];

    const pack = await buildContextPackInMemory(
      BASE_LOOP,
      "org-1",
      secrets,
      undefined,
      additionalRepos
    );

    expect(pack.secrets).toEqual(secrets);
    expect(pack.additionalRepos).toHaveLength(1);
  });
});
