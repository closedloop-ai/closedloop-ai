/**
 * Unit tests for `loopsService.findActiveLoopForDocumentAndCommand`.
 *
 * Staleness rules (encoded in the `OR` predicate the query builds):
 *  - RUNNING                                → blocks
 *  - CLAIMED with containerId               → blocks
 *  - CLAIMED with null containerId          → never blocks
 *  - PENDING with null containerId, < 30s   → blocks
 *  - PENDING with null containerId, > 30s   → does not block
 */

import { vi } from "vitest";
import {
  databaseModuleMock,
  dbUtilsModuleMock,
  docPrServiceModuleMock,
  githubModuleMock,
  type LoopsServiceHandles,
  logModuleMock,
  resetLoopsServiceHandles,
  uploadedArtifactsModuleMock,
} from "../fixtures/loops-service-mocks";

const handles = vi.hoisted<LoopsServiceHandles>(() => ({
  loopCreate: vi.fn(),
  loopCount: vi.fn(),
  loopFindFirst: vi.fn(),
  loopFindUnique: vi.fn(),
  loopUpdateMany: vi.fn(),
  orgFindUnique: vi.fn(),
}));

vi.mock("@repo/database", () => databaseModuleMock(handles));
vi.mock("@repo/github", () => githubModuleMock());
vi.mock("@repo/observability/log", () => logModuleMock());
vi.mock("@/lib/db-utils", () => dbUtilsModuleMock());
vi.mock("@/app/documents/document-pull-request-service", () =>
  docPrServiceModuleMock()
);
vi.mock("@/lib/loops/uploaded-plan-artifacts", () =>
  uploadedArtifactsModuleMock()
);

import { LoopCommand } from "@repo/api/src/types/loop";
import { beforeEach, describe, expect, it } from "vitest";
import { loopsService } from "@/app/loops/service";
import { buildPrismaLoop } from "../fixtures/loop";

const ORG_ID = "org-1";
const ARTIFACT_ID = "artifact-1";

function callFind(command: LoopCommand = LoopCommand.Plan) {
  return loopsService.findActiveLoopForDocumentAndCommand(
    ARTIFACT_ID,
    command,
    ORG_ID
  );
}

describe("loopsService.findActiveLoopForDocumentAndCommand", () => {
  beforeEach(() => resetLoopsServiceHandles(handles));

  describe("active-loop matches", () => {
    it.each<[string, Record<string, unknown>]>([
      ["RUNNING", { status: "RUNNING" }],
      [
        "CLAIMED with containerId",
        { status: "CLAIMED", containerId: "container-abc" },
      ],
      [
        "PENDING with null containerId, < 30s",
        {
          status: "PENDING",
          containerId: null,
          createdAt: new Date(Date.now() - 5000),
        },
      ],
    ])("returns the loop when status is %s", async (_label, overrides) => {
      handles.loopFindFirst.mockResolvedValue(buildPrismaLoop(overrides));

      const result = await callFind();

      expect(result).not.toBeNull();
      expect(result?.id).toBe("loop-1");
      expect(result?.status).toBe(overrides.status);
    });
  });

  it("returns null when findFirst finds no matching row", async () => {
    handles.loopFindFirst.mockResolvedValue(null);
    expect(await callFind()).toBeNull();
  });

  describe("query shape", () => {
    it("scopes by artifactId, command, organizationId and includes the staleness OR", async () => {
      await callFind(LoopCommand.Execute);

      const { where } = handles.loopFindFirst.mock.calls[0][0] as {
        where: Record<string, unknown> & { OR: Record<string, unknown>[] };
      };

      expect(where).toMatchObject({
        artifactId: ARTIFACT_ID,
        command: "EXECUTE",
        organizationId: ORG_ID,
      });

      expect(where.OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "RUNNING" }),
          expect.objectContaining({
            status: "CLAIMED",
            containerId: expect.objectContaining({ not: null }),
          }),
          expect.objectContaining({
            status: "PENDING",
            containerId: null,
            createdAt: expect.objectContaining({ gte: expect.any(Date) }),
          }),
        ])
      );
    });
  });
});
