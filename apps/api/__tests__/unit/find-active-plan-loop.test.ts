/**
 * Unit tests for `loopsService.findOperationallyActiveLoop` — UX-facing
 * predicate. Excludes orphan-shaped rows so silently-failed dispatches do not
 * block retries.
 *
 *   RUNNING                                → blocks
 *   CLAIMED with containerId               → blocks
 *   CLAIMED with null containerId          → never blocks
 *   PENDING with null containerId, < 30s   → blocks
 *   PENDING with null containerId, > 30s   → does not block
 *   PENDING with non-null containerId      → does not block
 *
 * The broader index-blocking query used by the P2002 catch path is exercised
 * indirectly via `loops-service-concurrent-limit.test.ts > P2002 backstop`.
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
  repoFindMany: vi.fn(),
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

import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import type { Loop as PrismaLoop } from "@repo/database";
import { beforeEach, describe, expect, it } from "vitest";
import { loopsService } from "@/app/loops/service";
import { buildPrismaLoop } from "../fixtures/loop";

const ORG_ID = "org-1";
const ARTIFACT_ID = "artifact-1";

function callOperational(command: LoopCommand = LoopCommand.Plan) {
  return loopsService.findOperationallyActiveLoop(ARTIFACT_ID, command, ORG_ID);
}

describe("loopsService.findOperationallyActiveLoop", () => {
  beforeEach(() => resetLoopsServiceHandles(handles));

  describe("active-loop matches", () => {
    it.each<[string, Partial<PrismaLoop>]>([
      [LoopStatus.Running, { status: LoopStatus.Running }],
      [
        "CLAIMED with containerId",
        { status: LoopStatus.Claimed, containerId: "container-abc" },
      ],
      [
        "PENDING with null containerId, < 30s",
        {
          status: LoopStatus.Pending,
          containerId: null,
          createdAt: new Date(Date.now() - 5000),
        },
      ],
    ])("returns the loop when status is %s", async (_label, overrides) => {
      handles.loopFindFirst.mockResolvedValue(buildPrismaLoop(overrides));

      const result = await callOperational();

      expect(result).not.toBeNull();
      expect(result?.id).toBe("loop-1");
      expect(result?.status).toBe(overrides.status);
    });
  });

  describe("query shape", () => {
    it("scopes by artifactId, command, organizationId and includes the staleness OR", async () => {
      await callOperational(LoopCommand.Execute);

      const { where } = handles.loopFindFirst.mock.calls[0][0] as {
        where: Record<string, unknown> & { OR: Record<string, unknown>[] };
      };

      expect(where).toMatchObject({
        artifactId: ARTIFACT_ID,
        command: LoopCommand.Execute,
        organizationId: ORG_ID,
      });

      expect(where.OR).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: LoopStatus.Running }),
          expect.objectContaining({
            status: LoopStatus.Claimed,
            containerId: expect.objectContaining({ not: null }),
          }),
          expect.objectContaining({
            status: LoopStatus.Pending,
            containerId: null,
            createdAt: expect.objectContaining({ gte: expect.any(Date) }),
          }),
        ])
      );
    });
  });
});
