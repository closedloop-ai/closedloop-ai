/**
 * @file branch-links-lifecycle-integrity.test.ts
 * @description ISS-7012/ISS-7062 — the WRITE-PATH wiring for
 * `readBranchLifecycleEventsFromMetadata`, the second hand-rolled member-wise
 * JSON-array reader folded onto the canonical `parseJsonArray`.
 *
 * The pure reader is covered directly in `shared.test.ts`. What was covered
 * nowhere is the call site that actually reads PERSISTED data: on a resync,
 * `syncBranchRefs` reads the stored `branchLifecycleEvents` blob, merges the
 * incoming events into it, and writes the result back. Every existing fixture
 * stored a cleanly-parsing blob, so swapping the reader for a raw
 * `existing?.branchLifecycleEvents ?? []` passthrough left the whole suite
 * green — while corrupt members leaked straight into persisted metadata.
 *
 * The discriminating fixture therefore puts a corrupt member in the STORED
 * blob, and asserts the readable history SURVIVES rather than merely that
 * nothing threw.
 *
 * These live in their own file rather than in `branch-links.test.ts` because
 * that file is in the shrink-only grandfather list in `biome.jsonc`.
 */
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionArtifactLinkKind,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import {
  installBranchIngestDb,
  syncBranchRefs,
} from "@/__tests__/support/agent-sessions/branch-ingest.test-harness";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const REPO_FULL_NAME = "acme/web";
const BRANCH_NAME = "feat/x";
/**
 * A producer-local method string with no member in the shared
 * `ArtifactRefMethod` const (the wire field is a free-form `z.string()`),
 * exactly as the sibling `branch-links.test.ts` spells it.
 */
const GIT_PUSH_METHOD = "git_push";

describe("branch lifecycle metadata read integrity (ISS-7012/ISS-7062)", () => {
  it("preserves the readable history when the STORED lifecycle blob holds a corrupt member", async () => {
    const m = installBranchIngestDb({
      branches: [
        {
          artifactId: "branch-x",
          repositoryId: "repo-1",
          branchName: BRANCH_NAME,
        },
      ],
      existingLink: {
        metadata: {
          linkKind: SessionArtifactLinkKind.SessionBranch,
          branchLifecycleEvents: [
            {
              kind: BranchLifecycleBoundaryKind.PrRaised,
              observedAt: "2026-05-20T17:00:00.000Z",
              evidenceId: "desktop-artifact-link:pr-1",
            },
            // Fails the event OBJECT shape (`evidenceId` is `min(1)`). Note an
            // unrecognized `kind` would NOT work here: that field ends in
            // `.catch(UnknownEvidence)`, so version skew degrades rather than
            // failing, and such a member is readable by design.
            {
              kind: BranchLifecycleBoundaryKind.BranchWrite,
              observedAt: "2026-05-20T17:01:00.000Z",
              evidenceId: "",
            },
          ],
        },
      },
    });

    await syncBranchRefs([
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: REPO_FULL_NAME,
        branchName: BRANCH_NAME,
        method: GIT_PUSH_METHOD,
        relation: ArtifactRefRelation.Created,
        observedAt: "2026-05-20T17:03:00.000Z",
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.BranchWrite,
            observedAt: "2026-05-20T17:03:00.000Z",
            evidenceId: "desktop-artifact-link:l-1",
          },
        ],
      },
    ]);

    // The readable STORED event survives beside the incoming one, and only the
    // corrupt member is dropped. An all-or-nothing read would have lost `pr-1`
    // entirely and persisted a history that silently began at `l-1`; a raw
    // passthrough would have written the corrupt member back out.
    const metadata = m.linkRow.mock.calls[0][0].metadata;
    expect(metadata.branchLifecycleEvents).toEqual([
      {
        kind: BranchLifecycleBoundaryKind.PrRaised,
        observedAt: "2026-05-20T17:00:00.000Z",
        evidenceId: "desktop-artifact-link:pr-1",
      },
      {
        kind: BranchLifecycleBoundaryKind.BranchWrite,
        observedAt: "2026-05-20T17:03:00.000Z",
        evidenceId: "desktop-artifact-link:l-1",
      },
    ]);
  });
});
