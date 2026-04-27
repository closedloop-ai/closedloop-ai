import { beforeEach, describe, expect, it, vi } from "vitest";
import { asTx, mockWithDbCall, mockWithDbTx } from "../utils/db-helpers";

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    PULL_REQUEST: "PULL_REQUEST",
    DEPLOYMENT: "DEPLOYMENT",
  },
}));

import { ArtifactType } from "@repo/database";
import {
  deploymentService,
  type RecordDeploymentInput,
} from "@/lib/services/deployment-service";

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
          workstreamId: null,
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
      expect(result).toBe(created);
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
      expect(result).toBe(updated);
    });

    it("connects pullRequestArtifact when pullRequestArtifactId is supplied", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "dep-1", deployment: null }),
        },
      };
      mockWithDbTx(mockDb);

      await deploymentService.recordDeployment(
        baseInput({ pullRequestArtifactId: "pr-1" })
      );

      const data = mockDb.artifact.create.mock.calls[0][0].data;
      expect(data.deployment.create.pullRequestArtifact).toEqual({
        connect: { id: "pr-1" },
      });
    });

    it("disconnects pullRequestArtifact on update when set to null", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: "dep-99" }),
          update: vi.fn().mockResolvedValue({ id: "dep-99", deployment: null }),
        },
      };
      mockWithDbTx(mockDb);

      await deploymentService.recordDeployment(
        baseInput({ pullRequestArtifactId: null })
      );

      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data.deployment.update.pullRequestArtifact).toEqual({
        disconnect: true,
      });
    });

    it("omits pullRequestArtifact on update when field is undefined", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: "dep-99" }),
          update: vi.fn().mockResolvedValue({ id: "dep-99", deployment: null }),
        },
      };
      mockWithDbTx(mockDb);

      await deploymentService.recordDeployment(baseInput());

      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data.deployment.update).not.toHaveProperty("pullRequestArtifact");
    });

    it("disconnects workstream on update when workstreamId is null", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: "dep-99" }),
          update: vi.fn().mockResolvedValue({ id: "dep-99", deployment: null }),
        },
      };
      mockWithDbTx(mockDb);

      await deploymentService.recordDeployment(
        baseInput({ workstreamId: null })
      );

      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data.workstream).toEqual({ disconnect: true });
    });

    it("connects workstream on update when workstreamId is set", async () => {
      const mockDb = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue({ id: "dep-99" }),
          update: vi.fn().mockResolvedValue({ id: "dep-99", deployment: null }),
        },
      };
      mockWithDbTx(mockDb);

      await deploymentService.recordDeployment(
        baseInput({ workstreamId: "ws-1" })
      );

      const data = mockDb.artifact.update.mock.calls[0][0].data;
      expect(data.workstream).toEqual({ connect: { id: "ws-1" } });
    });

    it("uses the supplied tx instead of opening withDb.tx", async () => {
      const mockTx = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockResolvedValue({ id: "dep-1", deployment: null }),
        },
      };
      const { withDb } = await import("@repo/database");
      const txSpy = withDb.tx as unknown as ReturnType<typeof vi.fn>;

      await deploymentService.recordDeployment(baseInput(), asTx(mockTx));

      expect(txSpy).not.toHaveBeenCalled();
      expect(mockTx.artifact.create).toHaveBeenCalled();
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

    it("uses the supplied tx instead of withDb", async () => {
      const mockTx = {
        artifact: {
          findFirst: vi.fn().mockResolvedValue(null),
        },
      };
      const { withDb } = await import("@repo/database");
      const dbSpy = withDb as unknown as ReturnType<typeof vi.fn>;

      await deploymentService.findByExternalUrl(
        PREVIEW_URL,
        ORG_ID,
        asTx(mockTx)
      );

      expect(dbSpy).not.toHaveBeenCalled();
      expect(mockTx.artifact.findFirst).toHaveBeenCalled();
    });
  });

  describe("updateState", () => {
    it("updates only the artifact.status field", async () => {
      const mockDb = {
        artifact: {
          update: vi.fn().mockResolvedValue({ id: "dep-1", status: "error" }),
        },
      };
      mockWithDbTx(mockDb);

      await deploymentService.updateState("dep-1", "error");

      expect(mockDb.artifact.update).toHaveBeenCalledWith({
        where: { id: "dep-1" },
        data: { status: "error" },
      });
    });

    it("uses the supplied tx instead of opening withDb.tx", async () => {
      const mockTx = {
        artifact: {
          update: vi.fn().mockResolvedValue({ id: "dep-1", status: "success" }),
        },
      };
      const { withDb } = await import("@repo/database");
      const txSpy = withDb.tx as unknown as ReturnType<typeof vi.fn>;

      await deploymentService.updateState("dep-1", "success", asTx(mockTx));

      expect(txSpy).not.toHaveBeenCalled();
      expect(mockTx.artifact.update).toHaveBeenCalled();
    });
  });
});
