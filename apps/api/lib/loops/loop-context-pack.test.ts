/**
 * Unit tests for loop-context-pack.ts — additionalRepos pass-through.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

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

import type { AdditionalRepoRefWithToken } from "@repo/api/src/types/loop";
import { LoopCommand } from "@repo/api/src/types/loop";
import { buildContextPackInMemory } from "@/lib/loops/loop-context-pack";

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

describe("buildContextPackInMemory — additionalRepos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes additionalRepos through when non-empty, and coerces empty to undefined", async () => {
    const additionalRepos: AdditionalRepoRefWithToken[] = [
      { fullName: "org/repo-b", branch: "main", githubToken: "ghp_token_b" },
      { fullName: "org/repo-c", branch: "feature/x" },
    ];

    const withRepos = await buildContextPackInMemory(
      BASE_LOOP,
      "org-1",
      undefined,
      undefined,
      additionalRepos
    );
    expect(withRepos.additionalRepos).toEqual(additionalRepos);

    const withEmpty = await buildContextPackInMemory(
      BASE_LOOP,
      "org-1",
      undefined,
      undefined,
      []
    );
    expect(withEmpty.additionalRepos).toBeUndefined();
  });
});
