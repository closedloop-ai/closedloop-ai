/**
 * ISS-9434 gauge 10. PLN-1978 §4 declined the CHECK constraint on
 * `artifacts.status`, so this predicate is the only thing standing between the
 * next cross-vocabulary write and nobody noticing. Every case below is a real
 * shape the audit found or a mutation that would make the gauge lie.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  DocumentStatus,
  DocumentType,
  DocumentTypeAlias,
  IssueStatus,
} from "@repo/api/src/types/document";
import { GitHubPRState } from "@repo/api/src/types/github-status";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeploymentState } from "@/app/deployments/deployment-state";

const { mockWithDb } = vi.hoisted(() => ({ mockWithDb: vi.fn() }));

vi.mock("@repo/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("@repo/database")>();
  return { ...original, withDb: mockWithDb };
});

import {
  checkOffVocabularyArtifactStatuses,
  isOffVocabularyArtifactStatus,
} from "./artifact-status-conformance";

type Group = {
  type: string;
  subtype: string | null;
  status: string;
  artifact_count: bigint;
};

function group(
  type: string,
  subtype: string | null,
  status: string,
  artifactCount = 1
): Group {
  return {
    type,
    subtype,
    status,
    artifact_count: BigInt(artifactCount),
  };
}

function runCheckOver(rows: Group[]) {
  const db = { $queryRaw: vi.fn().mockResolvedValue(rows) };
  mockWithDb.mockImplementation((fn: (db: unknown) => unknown) => fn(db));
  return checkOffVocabularyArtifactStatuses();
}

describe("isOffVocabularyArtifactStatus", () => {
  it("accepts each type's own vocabulary", () => {
    const conforming = [
      {
        type: ArtifactType.Document,
        subtype: DocumentType.Prd,
        status: DocumentStatus.Draft,
      },
      {
        type: ArtifactType.Document,
        subtype: DocumentType.Feature,
        status: IssueStatus.Done,
      },
      // A stray canonical `ISSUE` subtype takes the Issue lifecycle, not the
      // Document one — the same discriminator the validators use.
      {
        type: ArtifactType.Document,
        subtype: DocumentTypeAlias.Issue,
        status: IssueStatus.InProgress,
      },
      { type: ArtifactType.Branch, subtype: null, status: GitHubPRState.Open },
      {
        type: ArtifactType.Deployment,
        subtype: null,
        status: DeploymentState.Success,
      },
      {
        type: ArtifactType.Session,
        subtype: null,
        status: SESSION_STATUS.ACTIVE,
      },
    ];

    for (const row of conforming) {
      expect(isOffVocabularyArtifactStatus(row)).toBe(false);
    }
  });

  it("reports FEA-1837's exact shape: a FEATURE carrying a DocumentStatus member", () => {
    expect(
      isOffVocabularyArtifactStatus({
        type: ArtifactType.Document,
        subtype: DocumentType.Feature,
        status: DocumentStatus.Obsolete,
      })
    ).toBe(true);
  });

  it("reports an IssueStatus member on a Document subtype", () => {
    expect(
      isOffVocabularyArtifactStatus({
        type: ArtifactType.Document,
        subtype: DocumentType.ImplementationPlan,
        status: IssueStatus.Backlog,
      })
    ).toBe(true);
  });

  it("reports the lowercase branch spelling the dev seed writes", () => {
    expect(
      isOffVocabularyArtifactStatus({
        type: ArtifactType.Branch,
        subtype: null,
        status: GitHubPRState.Open.toLowerCase(),
      })
    ).toBe(true);
  });

  it("reports the live legacy `waiting` session population rather than blessing it", () => {
    // Migration 20260817120000 deliberately left these rows in place and
    // PLN-1978 §6 records the population as unmeasured. Admitting `waiting` into
    // the SESSION vocabulary would make the one instrument that can size it
    // report zero.
    expect(
      isOffVocabularyArtifactStatus({
        type: ArtifactType.Session,
        subtype: null,
        status: "waiting",
      })
    ).toBe(true);
  });

  it("accepts a non-success provider deployment state, not just success", () => {
    // A named member rather than a loop over DEPLOYMENT_STATE_OPTIONS: iterating
    // the same constant the vocabulary map returns is true by construction, so it
    // passed even under the one mutation the full provider set exists to prevent
    // — a set shrunk to `success` alone would have run a single green case.
    expect(
      isOffVocabularyArtifactStatus({
        type: ArtifactType.Deployment,
        subtype: null,
        status: DeploymentState.Failure,
      })
    ).toBe(false);
  });

  it("reports an artifact type outside the enum instead of skipping it", () => {
    expect(
      isOffVocabularyArtifactStatus({
        type: "WORKSTREAM",
        subtype: null,
        status: DocumentStatus.Draft,
      })
    ).toBe(true);
  });

  it("reports an empty status", () => {
    expect(
      isOffVocabularyArtifactStatus({
        type: ArtifactType.Session,
        subtype: null,
        status: "",
      })
    ).toBe(true);
  });

  it("cannot be satisfied by an inherited Object.prototype key", () => {
    expect(
      isOffVocabularyArtifactStatus({
        type: "constructor",
        subtype: null,
        status: DocumentStatus.Draft,
      })
    ).toBe(true);
  });
});

describe("checkOffVocabularyArtifactStatuses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("counts only the off-vocabulary groups", async () => {
    const result = await runCheckOver([
      group(ArtifactType.Document, DocumentType.Prd, DocumentStatus.Draft, 500),
      group(ArtifactType.Session, null, SESSION_STATUS.ACTIVE, 4000),
      group(
        ArtifactType.Document,
        DocumentType.Feature,
        DocumentStatus.Obsolete,
        1
      ),
      group(ArtifactType.Branch, null, "open", 7),
    ]);

    expect(result.count).toBe(8);
    // Rarest first: the singleton outranks the seven-row group. See
    // `compareByRarestFirst` — a big group already moves `count`, a singleton
    // can only ever surface here.
    expect(result.byStatus).toEqual([
      {
        type: ArtifactType.Document,
        subtype: DocumentType.Feature,
        status: DocumentStatus.Obsolete,
        artifactCount: 1,
      },
      {
        type: ArtifactType.Branch,
        subtype: null,
        status: "open",
        artifactCount: 7,
      },
    ]);
  });

  it("reports zero for a wholly conforming table", async () => {
    const result = await runCheckOver([
      group(
        ArtifactType.Document,
        DocumentType.Prd,
        DocumentStatus.Approved,
        9
      ),
      group(ArtifactType.Deployment, null, DeploymentState.Success, 3),
    ]);

    expect(result).toEqual({ count: 0, byStatus: [] });
  });

  it("sums EVERY off-vocabulary group even though the label breakdown is bounded", async () => {
    // 12 distinct violating spellings, one row each. A `slice` applied before
    // the sum would report 10.
    const rows = Array.from({ length: 12 }, (_, index) =>
      group(ArtifactType.Session, null, `legacy-${index}`, 1)
    );

    const result = await runCheckOver(rows);

    expect(result.count).toBe(12);
    expect(result.byStatus).toHaveLength(10);
  });

  it("keeps a singleton in the breakdown when a tolerated population competes for the slots", async () => {
    // The shape this gauge exists for. FEA-1837 was ONE row; the tolerated
    // legacy `waiting` session population is large and permanent. Under a
    // biggest-first sort the singleton is the first row evicted once ten groups
    // exist, and a total moving N -> N+1 is invisible to an anomaly monitor —
    // so the one row the gauge is for would never be reported anywhere.
    const rows = [
      group(ArtifactType.Session, null, "waiting", 50_000),
      ...Array.from({ length: 10 }, (_, index) =>
        group(ArtifactType.Session, null, `bulk-${index}`, 500 + index)
      ),
      group(
        ArtifactType.Document,
        DocumentType.Feature,
        DocumentStatus.Obsolete,
        1
      ),
    ];

    const result = await runCheckOver(rows);

    expect(result.byStatus).toHaveLength(10);
    expect(result.byStatus[0]).toEqual({
      type: ArtifactType.Document,
      subtype: DocumentType.Feature,
      status: DocumentStatus.Obsolete,
      artifactCount: 1,
    });
    // The tolerated population is the LAST thing to earn a slot, not the first.
    expect(result.byStatus.some((entry) => entry.status === "waiting")).toBe(
      false
    );
  });
});
