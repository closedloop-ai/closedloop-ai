import { ArtifactType } from "@repo/api/src/types/artifact";
import { SessionMetadataActivityField } from "@repo/api/src/types/artifact-activity";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { Prisma, TransactionClient } from "@repo/database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captureSystemSessionStatusChange = vi.hoisted(() => vi.fn());
const captureSystemSessionMetadataChange = vi.hoisted(() => vi.fn());
vi.mock("@/lib/artifact-activity-recording", () => ({
  captureSystemSessionStatusChange,
  captureSystemSessionMetadataChange,
}));

import {
  captureCommittedSessionMetadata,
  writeSessionArtifactMetadata,
} from "./session-ingest-metadata-activity";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "55555555-5555-4555-8555-555555555551";
const LINEAGE_PROJECT_ID = "99999999-9999-4999-8999-999999999999";

/**
 * The fill's stored-first operand, and the `$N` the producer's project binds
 * to. Reversing the two operands — `COALESCE($N, a.project_id)` — leaves a
 * statement that still parses, still runs, and re-files the session on every
 * sync, so the order is what has to be pinned.
 */
const PROJECT_FILL_PATTERN =
  /project_id\s*=\s*COALESCE\(\s*a\.project_id\s*,\s*\$(\d+)::uuid\s*\)/;

function fakeTx(
  status: string | null = SESSION_STATUS.INACTIVE,
  projectId: string | null = null
) {
  const $queryRaw = vi.fn().mockResolvedValue([
    {
      artifactId: ARTIFACT_ID,
      status: SESSION_STATUS.ACTIVE,
      projectId: null,
      afterStatus: status,
      afterProjectId: projectId,
    },
  ]);
  const findFirst = vi
    .fn()
    .mockResolvedValue(status === null ? null : { status, projectId });
  const tx = {
    $queryRaw,
    artifact: { findFirst },
  } as unknown as TransactionClient;
  return { tx, $queryRaw, findFirst };
}

describe("Session ingest metadata activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("locks the org-scoped prior Session row before its write", async () => {
    const { tx, $queryRaw } = fakeTx();

    await expect(
      writeSessionArtifactMetadata(tx, {
        organizationId: ORGANIZATION_ID,
        artifactId: ARTIFACT_ID,
        status: SESSION_STATUS.INACTIVE,
        projectId: null,
        name: "Session",
      })
    ).resolves.toEqual({
      artifactId: ARTIFACT_ID,
      status: SESSION_STATUS.ACTIVE,
      projectId: null,
      afterStatus: SESSION_STATUS.INACTIVE,
      afterProjectId: null,
    });
    expect($queryRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [
          ARTIFACT_ID,
          ORGANIZATION_ID,
          ArtifactType.Session,
          SESSION_STATUS.INACTIVE,
          "Session",
          null,
          expect.any(Date),
        ],
      })
    );
  });

  /**
   * ISS-10995 (operator ruling 2026-10-12): ingest FILLS a session's project
   * and never re-files it, so the project a user sets on the Details row
   * survives every later sync.
   *
   * The whole change is one operand swap, and the integration suite that
   * exercises it against real Postgres does not run on a PR
   * (`vitest.config.mts` excludes `*.integration.test.ts`; the
   * `api-integration-tests` job is skipped for `pull_request` and
   * `merge_group`), so the falsifying evidence has to live here.
   */
  it("fills the session's project from the stored value first, never the producer's", async () => {
    const { tx, $queryRaw } = fakeTx();

    await writeSessionArtifactMetadata(tx, {
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
      status: SESSION_STATUS.INACTIVE,
      projectId: LINEAGE_PROJECT_ID,
      name: "Session",
    });

    const statement: Prisma.Sql = $queryRaw.mock.calls[0][0];
    const fill = PROJECT_FILL_PATTERN.exec(statement.text);
    expect(fill).not.toBeNull();
    // The second operand is the producer's id, so the stored one wins when it
    // is present — reversed, lineage would.
    expect(statement.values[Number(fill?.[1]) - 1]).toBe(LINEAGE_PROJECT_ID);
  });

  it("captures the committed write snapshot without another directory read", async () => {
    const projectId = "99999999-9999-4999-8999-999999999999";
    const { tx, findFirst } = fakeTx(SESSION_STATUS.INACTIVE, projectId);
    const prior = {
      artifactId: ARTIFACT_ID,
      status: SESSION_STATUS.ACTIVE,
      projectId: null,
      afterStatus: SESSION_STATUS.INACTIVE,
      afterProjectId: projectId,
    };

    await captureCommittedSessionMetadata(
      tx,
      ORGANIZATION_ID,
      prior,
      ARTIFACT_ID
    );

    expect(findFirst).not.toHaveBeenCalled();
    expect(captureSystemSessionStatusChange).toHaveBeenCalledWith({
      tx,
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
      before: SESSION_STATUS.ACTIVE,
      after: SESSION_STATUS.INACTIVE,
    });
    expect(captureSystemSessionMetadataChange).toHaveBeenCalledWith({
      tx,
      organizationId: ORGANIZATION_ID,
      artifactId: ARTIFACT_ID,
      field: SessionMetadataActivityField.ProjectId,
      before: null,
      after: projectId,
    });
  });

  it("does not compare a replaced or newly created artifact with an old row", async () => {
    const { tx, findFirst } = fakeTx();

    await captureCommittedSessionMetadata(
      tx,
      ORGANIZATION_ID,
      null,
      ARTIFACT_ID
    );
    await captureCommittedSessionMetadata(
      tx,
      ORGANIZATION_ID,
      {
        artifactId: "other-artifact",
        status: SESSION_STATUS.ACTIVE,
        projectId: null,
        afterStatus: SESSION_STATUS.INACTIVE,
        afterProjectId: null,
      },
      ARTIFACT_ID
    );

    expect(findFirst).not.toHaveBeenCalled();
    expect(captureSystemSessionStatusChange).not.toHaveBeenCalled();
    expect(captureSystemSessionMetadataChange).not.toHaveBeenCalled();
  });

  it("fails the ingest transaction if the persisted Session disappears", async () => {
    const { tx } = fakeTx(null);

    await expect(
      captureCommittedSessionMetadata(
        tx,
        ORGANIZATION_ID,
        {
          artifactId: ARTIFACT_ID,
          status: SESSION_STATUS.ACTIVE,
          projectId: null,
          afterStatus: null,
          afterProjectId: null,
        },
        ARTIFACT_ID
      )
    ).rejects.toThrow("ingested Session metadata missing after its write");
  });
});
