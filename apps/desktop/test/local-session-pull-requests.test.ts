import assert from "node:assert/strict";
import { test } from "node:test";
import {
  collectSessionPrEvidence,
  resolveSessionPrAdmissionIdentity,
  SessionPrRelationType,
  toSessionPrEvidenceRecords,
} from "@repo/api/src/types/session-artifact-link";
import { SessionPrLifecycleStatus } from "@repo/lib/session-trace/derivation";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  localSessionHasPr,
  localSessionPullRequests,
} from "../src/main/session/local-session-pull-requests.js";

const REPO_A = "acme/repo-a";
const REPO_B = "acme/repo-b";

function session(
  overrides: Partial<SyncedAgentSession> & { externalSessionId: string }
): SyncedAgentSession {
  return {
    name: `Session ${overrides.externalSessionId}`,
    status: "completed",
    harness: "claude",
    cwd: `/tmp/${overrides.externalSessionId}`,
    model: "gpt-test",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T01:00:00.000Z",
    endedAt: "2026-01-01T02:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

// FEA-4188 (Codex reviewer): SQLite-hydrated sessions emit the SAME created PR
// in BOTH `session.prs` (repo-stripped, number-only) and `session.prRefs`.
// Suppressing an orphaned CREATED write must drop the legacy `prs` twin too, or
// the invariant stays broken for the real production data shape.
test("orphaned CREATED write is suppressed from BOTH prs and prRefs", () => {
  const s = session({
    externalSessionId: "orphan-both",
    branch: null,
    attribution: { repositoryFullName: REPO_A },
    prs: [{ num: 42, title: "old", status: SessionPrLifecycleStatus.Unknown }],
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 42,
        relationType: SessionPrRelationType.Created,
      },
    ],
  });

  assert.deepEqual(localSessionPullRequests(s), []);
  assert.equal(localSessionHasPr(s), false);
});

// A resolved branch that belongs to repo A must NOT un-orphan a CREATED PR write
// for repo B (wongk reviewer: hasResolvedBranch was session-wide).
test("repo-A branch does not vouch for a CREATED write in repo B", () => {
  const s = session({
    externalSessionId: "cross-repo",
    branch: "feat/in-repo-a",
    attribution: { repositoryFullName: REPO_A },
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 1,
        relationType: SessionPrRelationType.Created,
      },
      {
        repositoryFullName: REPO_B,
        prNumber: 2,
        relationType: SessionPrRelationType.Created,
      },
    ],
  });

  const prs = localSessionPullRequests(s);
  // Only the repo-A created write (matching the resolved branch's repo) renders.
  assert.deepEqual(
    prs.map((pr) => pr.num),
    [1]
  );
});

// Repo-scoped identity: repo-a#42 and repo-b#42 are distinct PRs and must both
// render (number-only identity would collapse them — wongk reviewer +
// apps/desktop/AGENTS.md).
test("same PR number in two repos renders as two distinct rows", () => {
  const s = session({
    externalSessionId: "same-number-two-repos",
    branch: null,
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 42,
        relationType: SessionPrRelationType.Referenced,
      },
      {
        repositoryFullName: REPO_B,
        prNumber: 42,
        relationType: SessionPrRelationType.Referenced,
      },
    ],
  });

  const prs = localSessionPullRequests(s);
  assert.equal(prs.length, 2);
  assert.deepEqual(prs.map((pr) => pr.title).sort(), [
    `${REPO_A}#42`,
    `${REPO_B}#42`,
  ]);
});

// A duplicate artifact-link ref for the same repo+number folds to one row.
test("duplicate refs for the same repo+number fold to one row", () => {
  const s = session({
    externalSessionId: "dup-same-repo",
    branch: null,
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 7,
        relationType: SessionPrRelationType.Referenced,
      },
      {
        repositoryFullName: REPO_A,
        prNumber: 7,
        relationType: SessionPrRelationType.Referenced,
      },
    ],
  });

  assert.equal(localSessionPullRequests(s).length, 1);
});

// ISS-4922 (wongk review): dedup keys on the SHARED `sessionPrIdentityKey`, which
// runs the repo through `normalizeRepoFullName`. A trim/lowercase-only key made
// `acme/repo-a.git#7` and `acme/repo-a#7` two identities here while the admission
// gate treated them as ONE — so the same PR rendered twice.
test("ISS-4922: refs whose repo differs only by .git / slash wrapping fold to one row", () => {
  const s = session({
    externalSessionId: "dup-repo-spelling",
    branch: null,
    prRefs: [
      {
        repositoryFullName: `${REPO_A}.git`,
        prNumber: 7,
        relationType: SessionPrRelationType.Referenced,
      },
      {
        repositoryFullName: `/${REPO_A}/`,
        prNumber: 7,
        relationType: SessionPrRelationType.Referenced,
      },
      {
        repositoryFullName: REPO_A,
        prNumber: 7,
        relationType: SessionPrRelationType.Referenced,
      },
    ],
  });

  assert.equal(localSessionPullRequests(s).length, 1);
});

// The same normalization governs the FEA-4188 branch-repo check: a resolved
// branch in `acme/repo-a` still vouches for a CREATED write spelled
// `acme/repo-a.git`, which a bare lowercase comparison called cross-repo and
// suppressed.
test("ISS-4922: a .git-suffixed CREATED ref is vouched for by the same repo's branch", () => {
  const s = session({
    externalSessionId: "branch-repo-spelling",
    branch: "feat/in-repo-a",
    attribution: { repositoryFullName: REPO_A },
    prRefs: [
      {
        repositoryFullName: `${REPO_A}.git`,
        prNumber: 11,
        relationType: SessionPrRelationType.Created,
      },
    ],
  });

  assert.deepEqual(
    localSessionPullRequests(s).map((pr) => pr.num),
    [11]
  );
});

// The legacy `prs` row (repo-less) and a same-number ref are two views of one PR
// — render once, preferring the legacy lifecycle row.
test("legacy prs row and same-number ref fold to one row", () => {
  const s = session({
    externalSessionId: "legacy-and-ref",
    branch: "feat/x",
    attribution: { repositoryFullName: REPO_A },
    prs: [
      { num: 9, title: "lifecycle", status: SessionPrLifecycleStatus.Open },
    ],
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 9,
        relationType: SessionPrRelationType.Created,
      },
    ],
  });

  const prs = localSessionPullRequests(s);
  assert.equal(prs.length, 1);
  assert.equal(prs[0]?.num, 9);
  // Legacy lifecycle row wins over the ref view.
  assert.equal(prs[0]?.status, SessionPrLifecycleStatus.Open);
});

// A REFERENCED ref is a mention, not an authored write — never gated on a branch.
test("REFERENCED ref renders without a resolved branch", () => {
  const s = session({
    externalSessionId: "referenced-no-branch",
    branch: null,
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 100,
        relationType: SessionPrRelationType.Referenced,
      },
    ],
  });

  assert.equal(localSessionPullRequests(s).length, 1);
});

// When the branch repository is unknown (no attribution repo), fall back to the
// session-wide "has a branch" signal rather than over-suppressing a CREATED ref.
test("unknown branch repo falls back to session-wide branch presence", () => {
  const s = session({
    externalSessionId: "unknown-branch-repo",
    branch: "feat/x",
    // No attribution.repositoryFullName — branch repo is unknown.
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 5,
        relationType: SessionPrRelationType.Created,
      },
    ],
  });

  assert.equal(localSessionPullRequests(s).length, 1);
});

// ---------------------------------------------------------------------------
// ISS-4922 — the Authored gate, and the cross-lane parity it exists to hold.
//
// The Local lane and the cloud projection must admit the SAME PRs. These tests
// pin the rendered pill. ISS-6588 removed the divergence's other half — the
// FEA-3551 abandoned→Completed rescue, which read `prsCount`/`prsMerged` off
// this same set — so its case went with it rather than being kept as a test
// whose two arms had come to pass for the same unrelated reason.
// ---------------------------------------------------------------------------

const GATE_ON = true;
const GATE_OFF = false;

/** A session whose only PR evidence is a non-authoring ref. */
function referencedOnlySession(): SyncedAgentSession {
  return session({
    externalSessionId: "iss4922-referenced-only",
    branch: null,
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 99,
        relationType: SessionPrRelationType.Referenced,
      },
    ],
  });
}

test("ISS-4922: the gate is OFF by default, preserving the pre-gate pill", () => {
  const s = referencedOnlySession();
  // No explicit argument: the default resolver is unregistered in tests, so it
  // fails closed to OFF and today's behavior is reproduced exactly.
  assert.equal(localSessionPullRequests(s).length, 1);
  assert.equal(localSessionPullRequests(s, GATE_OFF).length, 1);
  assert.equal(localSessionHasPr(s, GATE_OFF), true);
});

test("ISS-4922: gate ON drops a REFERENCED-only ref, matching the cloud", () => {
  const s = referencedOnlySession();
  assert.deepEqual(localSessionPullRequests(s, GATE_ON), []);
  assert.equal(localSessionHasPr(s, GATE_ON), false);
});

test("ISS-4922: gate ON drops a REVIEWED-only ref (a reviewer authored no PR)", () => {
  const s = session({
    externalSessionId: "iss4922-reviewed-only",
    branch: null,
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 12,
        relationType: SessionPrRelationType.Reviewed,
      },
    ],
  });

  assert.deepEqual(localSessionPullRequests(s, GATE_ON), []);
});

test("ISS-4922: gate ON keeps an authored CREATED ref", () => {
  const s = session({
    externalSessionId: "iss4922-created",
    branch: "feat/x",
    attribution: { repositoryFullName: REPO_A },
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 5,
        relationType: SessionPrRelationType.Created,
      },
    ],
  });

  assert.deepEqual(
    localSessionPullRequests(s, GATE_ON).map((pr) => pr.num),
    [5]
  );
});

test("ISS-4922: gate ON drops the legacy blob twin an adjudicating ref rejects", () => {
  // The SQLite-hydrated session emits the same PR in BOTH `prs` (repo-stripped)
  // and `prRefs`. Suppressing only the ref half would leave the legacy row
  // rendering and matching the "Has PR" filter — the exact ISS-4768 phantom.
  const s = session({
    externalSessionId: "iss4922-legacy-twin",
    branch: null,
    attribution: { repositoryFullName: REPO_A },
    prs: [
      {
        num: 99,
        title: "Referenced PR",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ],
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 99,
        relationType: SessionPrRelationType.Referenced,
      },
    ],
  });

  assert.deepEqual(localSessionPullRequests(s, GATE_ON), []);
});

test("ISS-4922: gate ON KEEPS a legacy PR no ref adjudicates (incomplete evidence)", () => {
  // Absent evidence is incomplete, not exculpatory — the desktop producer caps
  // the blob and `prRefs` independently, so a genuinely authored PR can arrive
  // with its ref capped out. Graceful degradation, never silent deletion.
  const s = session({
    externalSessionId: "iss4922-unadjudicated-legacy",
    branch: null,
    attribution: { repositoryFullName: REPO_A },
    prs: [
      {
        num: 1234,
        title: "Uncorroborated PR",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ],
    prRefs: [
      {
        repositoryFullName: REPO_A,
        prNumber: 99,
        relationType: SessionPrRelationType.Referenced,
      },
    ],
  });

  assert.deepEqual(
    localSessionPullRequests(s, GATE_ON).map((pr) => pr.num),
    [1234]
  );
});

// PARITY GUARD. The Local lane must not re-derive the admission rule: for every
// relation type, its verdict must equal the SHARED adjudicator's verdict over
// the SAME normalized evidence — the identical function the cloud projection
// calls in `apps/api/app/agent-sessions/service/session-pr-status.ts`. A future
// change that narrows or widens one lane alone fails here.
test("ISS-4922: the Local lane's verdict matches the shared adjudicator for every relation type", () => {
  for (const relationType of [
    SessionPrRelationType.Created,
    SessionPrRelationType.Referenced,
    SessionPrRelationType.Reviewed,
  ]) {
    const refs = [
      {
        repositoryFullName: REPO_A,
        prNumber: 77,
        relationType,
      },
    ];
    const s = session({
      externalSessionId: `iss4922-parity-${relationType}`,
      branch: "feat/x",
      attribution: { repositoryFullName: REPO_A },
      prs: [
        { num: 77, title: "PR 77", status: SessionPrLifecycleStatus.Unknown },
      ],
      prRefs: refs,
    });

    const sharedVerdict = resolveSessionPrAdmissionIdentity(
      { prNumber: 77, repositoryFullName: REPO_A },
      collectSessionPrEvidence(toSessionPrEvidenceRecords(refs))
    );
    const laneAdmitted = localSessionPullRequests(s, GATE_ON).length > 0;

    assert.equal(
      laneAdmitted,
      sharedVerdict !== null,
      `Local lane and the shared gate disagree for relationType=${relationType}`
    );
  }
});
