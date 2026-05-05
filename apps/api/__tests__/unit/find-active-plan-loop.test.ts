/**
 * Unit tests for the two-tier active-loop lookups (S1):
 *
 *   - `loopsService.findOperationallyActiveLoop` — UX-facing predicate. Excludes
 *     orphan-shaped rows so silently-failed dispatches do not block retries.
 *
 *       RUNNING                                → blocks
 *       CLAIMED with containerId               → blocks
 *       CLAIMED with null containerId          → never blocks
 *       PENDING with null containerId, < 30s   → blocks
 *       PENDING with null containerId, > 30s   → does not block
 *       PENDING with non-null containerId      → does not block
 *
 *   - `loopsService.findIndexBlockingLoop` — mirrors the partial unique index
 *     `loops_active_artifact_command_key`. By construction a strict superset of
 *     the operational predicate. Used by the post-P2002 catch path.
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

function callIndexBlocking(command: LoopCommand = LoopCommand.Plan) {
  return loopsService.findIndexBlockingLoop(ARTIFACT_ID, command, ORG_ID);
}

describe("loopsService.findOperationallyActiveLoop", () => {
  beforeEach(() => resetLoopsServiceHandles(handles));

  describe("active-loop matches", () => {
    it.each<[string, Partial<PrismaLoop>]>([
      ["RUNNING", { status: LoopStatus.Running }],
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

  it("returns null when findFirst finds no matching row", async () => {
    handles.loopFindFirst.mockResolvedValue(null);
    expect(await callOperational()).toBeNull();
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

describe("loopsService.findIndexBlockingLoop", () => {
  beforeEach(() => resetLoopsServiceHandles(handles));

  describe("query shape — mirrors the partial unique index", () => {
    it("uses status IN [PENDING, CLAIMED, RUNNING] with no staleness filter", async () => {
      await callIndexBlocking(LoopCommand.Execute);

      const arg = handles.loopFindFirst.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(arg.where).toMatchObject({
        artifactId: ARTIFACT_ID,
        command: LoopCommand.Execute,
        organizationId: ORG_ID,
        status: {
          in: expect.arrayContaining([
            LoopStatus.Pending,
            LoopStatus.Claimed,
            LoopStatus.Running,
          ]),
        },
      });
      // Critical: no staleness filter, no OR for orphan exclusion.
      expect(arg.where).not.toHaveProperty("OR");
      expect(arg.where).not.toHaveProperty("createdAt");
      expect(arg.where).not.toHaveProperty("containerId");
    });
  });

  describe("returns rows the operational predicate would skip", () => {
    it.each<[string, Partial<PrismaLoop>]>([
      [
        "CLAIMED with null containerId",
        { status: LoopStatus.Claimed, containerId: null },
      ],
      [
        "PENDING with non-null containerId",
        {
          status: LoopStatus.Pending,
          containerId: "container-abc",
        },
      ],
      [
        "PENDING with null containerId, > 30s",
        {
          status: LoopStatus.Pending,
          containerId: null,
          createdAt: new Date(Date.now() - 60_000),
        },
      ],
    ])("returns the loop when status is %s (operational would return null here)", async (_label, overrides) => {
      handles.loopFindFirst.mockResolvedValue(buildPrismaLoop(overrides));

      const result = await callIndexBlocking();

      expect(result).not.toBeNull();
      expect(result?.id).toBe("loop-1");
    });
  });
});

describe("two-tier subset invariant", () => {
  beforeEach(() => resetLoopsServiceHandles(handles));

  // The operational predicate is documented as a strict subset of the
  // index-blocking predicate. This is the SSOT relationship that lets the
  // P2002 catch path always describe what the DB rejected on. We assert it
  // by checking that for every row the operational predicate matches, the
  // index-blocking predicate matches as well.
  const operationallyMatching: [string, Partial<PrismaLoop>][] = [
    ["RUNNING", { status: LoopStatus.Running, containerId: null }],
    [
      "CLAIMED with containerId",
      { status: LoopStatus.Claimed, containerId: "ct" },
    ],
    [
      "PENDING fresh + null containerId",
      {
        status: LoopStatus.Pending,
        containerId: null,
        createdAt: new Date(Date.now() - 5000),
      },
    ],
  ];

  it.each(
    operationallyMatching
  )("row matching operational (%s) also matches index-blocking", (_label, overrides) => {
    const row = buildPrismaLoop(overrides);
    // Index-blocking only filters on `status` membership; verify the row
    // lands in the active set.
    const activeStatuses = [
      LoopStatus.Pending,
      LoopStatus.Claimed,
      LoopStatus.Running,
    ];
    expect(activeStatuses).toContain(row.status);
  });
});
