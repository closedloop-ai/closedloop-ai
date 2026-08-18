/**
 * @file branch-links-prose-evidence.test.ts
 * @description ISS-5764 (review, thadeusb #4723) — cloud-side coverage for
 * `branchRefEvidenceRank`, the guard that stops a PROSE branch mention
 * re-labelling the aggregate a COMMAND established.
 *
 * The regression this pins is the one `branchRefEvidenceRank`'s own docstring
 * describes and nothing executed: `BRANCH_RELATION_PRECEDENCE` ranks
 * `referenced` (3) ABOVE `workspace` (4), which is correct while both are
 * command evidence. The desktop now also mints `referenced` branch refs from
 * prose, so a session that ran `git checkout feat/x` AND wrote "I checked out
 * branch feat/x" had its session→branch link rewritten from
 * `workspace`/`git_checkout` to `referenced`/`branch_mention_in_prose` — a
 * mention overwriting the record of a command the session actually ran.
 *
 * These live in their own file rather than in `branch-links.test.ts` because
 * that file is in the shrink-only grandfather list in `biome.jsonc`.
 */
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installBranchIngestDb,
  syncBranchRefs,
} from "@/__tests__/support/agent-sessions/service.test-harness";

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
 * The desktop extractor's checkout method. It is a producer-local string with
 * no member in the shared `ArtifactRefMethod` const (the wire field is a
 * free-form `z.string()`), so the literal is the contract here — exactly as the
 * sibling `branch-links.test.ts` spells it.
 */
const GIT_CHECKOUT_METHOD = "git_checkout";

function installOneBranch() {
  return installBranchIngestDb({
    branches: [
      {
        artifactId: "branch-x",
        repositoryId: "repo-1",
        branchName: BRANCH_NAME,
      },
    ],
  });
}

function checkoutRef(observedAt: string) {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: REPO_FULL_NAME,
    branchName: BRANCH_NAME,
    method: GIT_CHECKOUT_METHOD,
    relation: ArtifactRefRelation.Workspace,
    observedAt,
  } as const;
}

function proseRef(observedAt: string) {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: REPO_FULL_NAME,
    branchName: BRANCH_NAME,
    method: ArtifactRefMethod.BranchMentionInProse,
    relation: ArtifactRefRelation.Referenced,
    observedAt,
  } as const;
}

describe("branchRefEvidenceRank (ISS-5764 prose demotion)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the command-derived record when a prose mention arrives after it", async () => {
    const m = installOneBranch();

    await syncBranchRefs([
      checkoutRef("2026-05-20T17:01:00.000Z"),
      proseRef("2026-05-20T17:05:00.000Z"),
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.metadata.method).toBe(GIT_CHECKOUT_METHOD);
    expect(arg.create.metadata.relation).toBe(ArtifactRefRelation.Workspace);
    // Recency is a separate axis and still advances — only the evidence
    // election is pinned, so this cannot pass by the merge doing nothing.
    expect(arg.create.metadata.observedAt).toBe("2026-05-20T17:05:00.000Z");
  });

  it("lets the command-derived record overtake a prose mention that arrived first", async () => {
    const m = installOneBranch();

    await syncBranchRefs([
      proseRef("2026-05-20T17:01:00.000Z"),
      checkoutRef("2026-05-20T17:05:00.000Z"),
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.metadata.method).toBe(GIT_CHECKOUT_METHOD);
    expect(arg.create.metadata.relation).toBe(ArtifactRefRelation.Workspace);
  });

  // The other direction: the demotion must not silence prose entirely, or the
  // feature would be inert for a branch the session only ever talked about.
  it("still establishes an aggregate a prose mention is the only evidence for", async () => {
    const m = installOneBranch();

    await syncBranchRefs([proseRef("2026-05-20T17:01:00.000Z")]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.metadata.method).toBe(
      ArtifactRefMethod.BranchMentionInProse
    );
    expect(arg.create.metadata.relation).toBe(ArtifactRefRelation.Referenced);
  });

  // `referenced` outranking `workspace` is deliberate for COMMAND evidence and
  // must survive the prose demotion — otherwise the fix would have been to
  // reorder BRANCH_RELATION_PRECEDENCE, which would regress FEA-2729.
  it("keeps a command-derived `referenced` ref outranking `workspace`", async () => {
    const m = installOneBranch();

    await syncBranchRefs([
      checkoutRef("2026-05-20T17:01:00.000Z"),
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: REPO_FULL_NAME,
        branchName: BRANCH_NAME,
        method: ArtifactRefMethod.GitCommand,
        relation: ArtifactRefRelation.Referenced,
        observedAt: "2026-05-20T17:05:00.000Z",
      },
    ]);

    const arg = m.artifactLinkUpsert.mock.calls[0]?.[0];
    expect(arg.create.metadata.method).toBe(ArtifactRefMethod.GitCommand);
    expect(arg.create.metadata.relation).toBe(ArtifactRefRelation.Referenced);
  });
});
