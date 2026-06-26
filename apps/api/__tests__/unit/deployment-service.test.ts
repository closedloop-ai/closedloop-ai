import { Status } from "@repo/api/src/types/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockWithDbCall, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

import { ArtifactType } from "@repo/database";
import {
  deploymentService,
  type RecordDeploymentInput,
} from "@/app/deployments/deployment-service";

const ORG_ID = "org-1";
const PROJECT_ID = "proj-1";
const PREVIEW_URL = "https://preview-abc123.vercel.app";

function baseInput(
  overrides: Partial<RecordDeploymentInput> = {}
): RecordDeploymentInput {
  return {
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    state: "success",
    externalUrl: PREVIEW_URL,
    title: "Preview for feature branch",
    ...overrides,
  };
}

describe("deploymentService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("recordDeployment", () => {
    it("rejects a null projectId — only SESSION artifacts may be projectless", async () => {
      // No DB mock on purpose: the guard must fail before any query runs.
      const result = await deploymentService.recordDeployment(
        baseInput({ projectId: null })
      );

      expect(result).toEqual({ ok: false, error: Status.BadRequest });
    });

    it("creates a new artifact + detail when no row exists for externalUrl", async () => {
      const created = { id: "dep-1", deployment: { artifactId: "dep-1" } };
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue(created),
          update: vi.fn(),
        },
      };
      mockWithDbTx(mockDb);

      const result = await deploymentService.recordDeployment(
        baseInput({
          environment: "preview",
          ref: "refs/heads/feature",
          sha: "abc123",
          production: false,
          transient: true,
        })
      );

      expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          type: ArtifactType.DEPLOYMENT,
          externalUrl: PREVIEW_URL,
        },
        select: { id: true },
      });
      expect(mockDb.artifact.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          type: ArtifactType.DEPLOYMENT,
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          name: "Preview for feature branch",
          status: "success",
          externalUrl: PREVIEW_URL,
          deployment: {
            create: expect.objectContaining({
              environment: "preview",
              ref: "refs/heads/feature",
              sha: "abc123",
              transient: true,
              production: false,
            }),
          },
        }),
        include: { deployment: true },
      });
      expect(mockDb.artifact.update).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, value: created });
    });

    it("updates the existing artifact when one matches externalUrl", async () => {
      const updated = { id: "dep-99", deployment: { artifactId: "dep-99" } };
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: "dep-99" }),
          create: vi.fn(),
          update: vi.fn().mockResolvedValue(updated),
        },
      };
      mockWithDbTx(mockDb);

      const result = await deploymentService.recordDeployment(
        baseInput({ state: "failure", environment: "preview" })
      );

      expect(mockDb.artifact.create).not.toHaveBeenCalled();
      expect(mockDb.artifact.update).toHaveBeenCalledWith({
        where: { id: "dep-99" },
        data: expect.objectContaining({
          name: "Preview for feature branch",
          status: "failure",
          project: { connect: { id: PROJECT_ID } },
          deployment: {
            update: expect.objectContaining({ environment: "preview" }),
          },
        }),
        include: { deployment: true },
      });
      expect(result).toEqual({ ok: true, value: updated });
    });

    it("connects branchArtifact when branchArtifactId is supplied", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "dep-1", deployment: null }),
        },
      };
      mockWithDbTx(mockDb);

      await deploymentService.recordDeployment(
        baseInput({ branchArtifactId: "pr-1" })
      );

      const data = mockDb.artifact.create.mock.calls[0][0].data;
      expect(data.deployment.create.branchArtifact).toEqual({
        connect: { id: "pr-1" },
      });
    });

    it("disconnects branchArtifact on update when set to null", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: "dep-99" }),
          update: vi.fn().mockResolvedValue({ id: "dep-99", deployment: null }),
        },
      };
      mockWithDbTx(mockDb);

      await deploymentService.recordDeployment(
        baseInput({ branchArtifactId: null })
      );

      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data.deployment.update.branchArtifact).toEqual({
        disconnect: true,
      });
    });

    it("omits branchArtifact on update when field is undefined", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: "dep-99" }),
          update: vi.fn().mockResolvedValue({ id: "dep-99", deployment: null }),
        },
      };
      mockWithDbTx(mockDb);

      await deploymentService.recordDeployment(baseInput());

      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data.deployment.update).not.toHaveProperty("branchArtifact");
    });
  });

  describe("findById", () => {
    it("returns the artifact + detail when present in the org", async () => {
      const found = { id: "dep-1", deployment: { artifactId: "dep-1" } };
      const mockDb = {
        artifact: { findFirst: vi.fn().mockResolvedValue(found) },
      };
      mockWithDbCall(mockDb);

      const result = await deploymentService.findById("dep-1", ORG_ID);

      expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
        where: {
          id: "dep-1",
          organizationId: ORG_ID,
          type: ArtifactType.DEPLOYMENT,
        },
        include: { deployment: true },
      });
      expect(result).toBe(found);
    });

    it("returns null when no row matches in the org", async () => {
      const mockDb = {
        artifact: { findFirst: vi.fn().mockResolvedValue(null) },
      };
      mockWithDbCall(mockDb);

      const result = await deploymentService.findById("missing", ORG_ID);

      expect(result).toBeNull();
    });
  });

  describe("list", () => {
    it("scopes to organizationId and DEPLOYMENT type, ordered desc by createdAt", async () => {
      const mockDb = {
        artifact: { findMany: vi.fn().mockResolvedValue([]) },
      };
      mockWithDbCall(mockDb);

      await deploymentService.list({ organizationId: ORG_ID });

      expect(mockDb.artifact.findMany).toHaveBeenCalledWith({
        where: { organizationId: ORG_ID, type: ArtifactType.DEPLOYMENT },
        include: { deployment: true },
        orderBy: { createdAt: "desc" },
      });
    });

    it("forwards optional projectId, workstreamId, and state filters", async () => {
      const mockDb = {
        artifact: { findMany: vi.fn().mockResolvedValue([]) },
      };
      mockWithDbCall(mockDb);

      await deploymentService.list({
        organizationId: ORG_ID,
        projectId: PROJECT_ID,
        state: "success",
      });

      expect(mockDb.artifact.findMany).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          type: ArtifactType.DEPLOYMENT,
          projectId: PROJECT_ID,
          status: "success",
        },
        include: { deployment: true },
        orderBy: { createdAt: "desc" },
      });
    });
  });

  describe("delete", () => {
    it("returns Result.ok when the row was deleted", async () => {
      const mockDb = {
        artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      };
      mockWithDbCall(mockDb);

      const result = await deploymentService.delete("dep-1", ORG_ID);

      expect(mockDb.artifact.deleteMany).toHaveBeenCalledWith({
        where: {
          id: "dep-1",
          organizationId: ORG_ID,
          type: ArtifactType.DEPLOYMENT,
        },
      });
      expect(result).toEqual({ ok: true, value: undefined });
    });

    it("returns Status.NotFound when no deployment artifact matches in the org", async () => {
      const mockDb = {
        artifact: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      };
      mockWithDbCall(mockDb);

      const result = await deploymentService.delete("missing", ORG_ID);

      expect(result).toEqual({ ok: false, error: Status.NotFound });
    });
  });

  describe("findByExternalUrl", () => {
    it("queries artifact.findFirst with externalUrl + type filter", async () => {
      const artifact = { id: "dep-1", deployment: {} };
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(artifact),
        },
      };
      mockWithDbCall(mockDb);

      const result = await deploymentService.findByExternalUrl(
        PREVIEW_URL,
        ORG_ID
      );

      expect(mockDb.artifact.findFirst).toHaveBeenCalledWith({
        where: {
          organizationId: ORG_ID,
          type: ArtifactType.DEPLOYMENT,
          externalUrl: PREVIEW_URL,
        },
        include: { deployment: true },
      });
      expect(result).toBe(artifact);
    });

    it("returns null when no artifact matches", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      mockWithDbCall(mockDb);

      const result = await deploymentService.findByExternalUrl(
        PREVIEW_URL,
        ORG_ID
      );

      expect(result).toBeNull();
    });
  });
});
