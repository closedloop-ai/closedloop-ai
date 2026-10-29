/**
 * @file session-artifact-markers-build.test.ts
 * @description ISS-7570 unit coverage for the two exports of
 * `src/main/session/session-artifact-markers.ts` — the commit/PR timeline dots.
 *
 * Deliberately NOT named `session-artifact-markers.test.ts`: that name is
 * already taken by a real-boundary suite for `artifact-link-backfill.ts` which
 * never imports this module.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { SessionMarker } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  type ArtifactMarkerLinkRow,
  type BuildArtifactSessionMarkersInput,
  buildArtifactSessionMarkers,
  mergeSessionMarkers,
} from "../src/main/session/session-artifact-markers.js";

const SESSION_START = "2026-06-22T10:00:00.000Z";
const SESSION_QUARTER = "2026-06-22T10:15:00.000Z";
const SESSION_MID = "2026-06-22T10:30:00.000Z";
const SESSION_END = "2026-06-22T11:00:00.000Z";
const BEFORE_SESSION = "2026-06-22T09:00:00.000Z";
const AFTER_SESSION = "2026-06-22T12:00:00.000Z";
const SHA = "abc1234567890";

const TIMELINE_ROWS = [
  { createdAt: SESSION_START },
  { createdAt: SESSION_MID },
  { createdAt: SESSION_END },
];

describe("buildArtifactSessionMarkers — commit gating", () => {
  it("emits a commit marker only for relation=created with a non-empty sha", () => {
    const markers = build({
      links: [
        commitLink({ sha: SHA, artifact_committed_at: SESSION_MID }),
        commitLink({
          relation: "referenced",
          sha: "referenced0000",
          artifact_committed_at: SESSION_MID,
        }),
        commitLink({
          relation: null,
          sha: "nullrelation00",
          artifact_committed_at: SESSION_MID,
        }),
        commitLink({ sha: null, artifact_committed_at: SESSION_MID }),
        commitLink({ sha: "   ", artifact_committed_at: SESSION_MID }),
      ],
    });

    assert.equal(markers.length, 1);
    assert.equal(markers[0].kind, "commit");
    assert.equal(markers[0].label, "abc1234");
  });

  it("fails closed when every candidate timestamp is absent or unparseable", () => {
    const markers = build({
      links: [
        commitLink({ sha: SHA }),
        commitLink({
          sha: "def1234567890",
          artifact_committed_at: "not-a-date",
          link_observed_at: "",
          artifact_last_seen_at: null,
        }),
      ],
    });

    assert.deepEqual(markers, []);
  });

  it("ignores artifact_observed_at, which is not a candidate timestamp", () => {
    const markers = build({
      links: [commitLink({ sha: SHA, artifact_observed_at: SESSION_MID })],
    });

    assert.deepEqual(markers, []);
  });

  it("prefers the title as label and clamps it to the shared marker limit", () => {
    const markers = build({
      links: [
        commitLink({
          sha: SHA,
          title: "  Implement marker helper  ",
          artifact_committed_at: SESSION_MID,
        }),
        commitLink({
          sha: "def1234567890",
          title: "x".repeat(420),
          artifact_committed_at: SESSION_MID,
        }),
        commitLink({
          sha: "0123456789abc",
          title: "   ",
          artifact_committed_at: SESSION_MID,
        }),
      ],
    });

    const labels = markers.map((marker) => marker.label);
    assert.ok(labels.includes("Implement marker helper"));
    assert.ok(labels.includes("0123456"));
    const clamped = labels.find((label) => label.startsWith("xxx"));
    assert.equal(clamped?.length, 300);
  });
});

describe("buildArtifactSessionMarkers — FEA-3329 commit timestamp precedence", () => {
  it("uses artifact_committed_at when all three candidates are present", () => {
    const [marker] = build({
      links: [
        commitLink({
          sha: SHA,
          artifact_committed_at: SESSION_QUARTER,
          link_observed_at: SESSION_MID,
          artifact_last_seen_at: SESSION_END,
        }),
      ],
    });

    assert.equal(marker.t, SESSION_QUARTER);
  });

  it("falls back to link_observed_at only when artifact_committed_at is absent", () => {
    const [marker] = build({
      links: [
        commitLink({
          sha: SHA,
          artifact_committed_at: null,
          link_observed_at: SESSION_MID,
          artifact_last_seen_at: SESSION_END,
        }),
      ],
    });

    assert.equal(marker.t, SESSION_MID);
  });

  it("falls back to artifact_last_seen_at only when the first two are absent", () => {
    const [marker] = build({
      links: [
        commitLink({
          sha: SHA,
          artifact_committed_at: null,
          link_observed_at: null,
          artifact_last_seen_at: SESSION_END,
        }),
      ],
    });

    assert.equal(marker.t, SESSION_END);
  });

  it("skips an unparseable higher-precedence candidate rather than failing closed", () => {
    const [marker] = build({
      links: [
        commitLink({
          sha: SHA,
          artifact_committed_at: "definitely-not-a-date",
          link_observed_at: SESSION_MID,
        }),
      ],
    });

    assert.equal(marker.t, SESSION_MID);
  });

  it("echoes the source timestamp string verbatim instead of re-serializing it", () => {
    const [marker] = build({
      links: [
        commitLink({ sha: SHA, artifact_committed_at: "2026-06-22T10:30:00Z" }),
      ],
    });

    assert.equal(marker.t, "2026-06-22T10:30:00Z");
  });
});

describe("buildArtifactSessionMarkers — PR gating", () => {
  it("accepts relation created and workspace, and rejects any other relation", () => {
    const markers = build({
      links: [
        prLink({ pr_number: 1, pr_opened_at: SESSION_MID }),
        prLink({
          pr_number: 2,
          relation: "workspace",
          pr_opened_at: SESSION_MID,
        }),
        prLink({
          pr_number: 3,
          relation: "referenced",
          pr_opened_at: SESSION_MID,
        }),
        prLink({ pr_number: 4, relation: null, pr_opened_at: SESSION_MID }),
      ],
    });

    assert.deepEqual(
      markers.map((marker) => marker.label),
      ["PR #1 opened", "PR #2 opened"]
    );
  });

  it("requires a non-empty repo_full_name", () => {
    const markers = build({
      links: [
        prLink({ repo_full_name: null, pr_opened_at: SESSION_MID }),
        prLink({ repo_full_name: "   ", pr_opened_at: SESSION_MID }),
      ],
    });

    assert.deepEqual(markers, []);
  });

  // The gate is `pr_number == null`, mirroring the projection's
  // `pr_number IS NOT NULL` (database/sync-source.ts). Pinned so a refactor to
  // a truthiness check cannot silently start dropping rows. Not a claim that
  // `#0` is a legitimate PR number — rejecting that belongs upstream.
  it("gates pr_number on presence, not truthiness", () => {
    const markers = build({
      links: [
        prLink({ pr_number: null, pr_opened_at: SESSION_MID }),
        prLink({ pr_number: 0, pr_opened_at: SESSION_MID }),
      ],
    });

    assert.deepEqual(
      markers.map((marker) => marker.label),
      ["PR #0 opened"]
    );
  });

  it("routes an unknown target_kind through the PR gate, which rejects it", () => {
    const markers = build({
      links: [
        linkRow({
          target_kind: "branch",
          sha: SHA,
          pr_number: 9,
          artifact_committed_at: SESSION_MID,
          pr_opened_at: SESSION_MID,
        }),
      ],
    });

    assert.deepEqual(markers, []);
  });

  it("clamps an overlong PR label to the shared marker limit", () => {
    const [marker] = build({
      links: [
        prLink({
          pr_number: 12,
          title: "y".repeat(420),
          pr_opened_at: SESSION_MID,
        }),
      ],
    });

    assert.equal(marker.label.length, 300);
    assert.ok(marker.label.startsWith("PR #12 opened: yyy"));
  });

  it("appends the title to the label when one is present", () => {
    const [marker] = build({
      links: [
        prLink({
          pr_number: 12,
          title: "  Add markers  ",
          pr_opened_at: SESSION_MID,
        }),
      ],
    });

    assert.equal(marker.label, "PR #12 opened: Add markers");
  });
});

describe("buildArtifactSessionMarkers — PR timestamp fallback", () => {
  it("uses pr_opened_at when the PR has been enriched", () => {
    const [marker] = build({
      links: [
        prLink({
          pr_opened_at: SESSION_QUARTER,
          link_observed_at: SESSION_END,
          artifact_last_seen_at: SESSION_END,
        }),
      ],
    });

    assert.equal(marker.t, SESSION_QUARTER);
  });

  it("falls back to the session end anchor, not to import timestamps", () => {
    const [marker] = build({
      links: [
        prLink({
          pr_opened_at: null,
          link_observed_at: SESSION_QUARTER,
          artifact_committed_at: SESSION_QUARTER,
          artifact_last_seen_at: SESSION_QUARTER,
        }),
      ],
    });

    assert.equal(marker.t, SESSION_END);
    assert.equal(marker.x, 100);
  });

  it("drops the PR marker when the session has no finite end anchor", () => {
    const markers = build({
      endedAt: null,
      updatedAt: null,
      links: [prLink({ pr_opened_at: null })],
    });

    assert.deepEqual(markers, []);
  });
});

describe("buildArtifactSessionMarkers — FEA-3427 endMs anchor", () => {
  it("lets endMs win over endedAt for both the x scale and the PR fallback", () => {
    const markers = build({
      endMs: Date.parse(SESSION_MID),
      endedAt: SESSION_END,
      links: [
        commitLink({ sha: SHA, artifact_committed_at: SESSION_QUARTER }),
        prLink({ pr_number: 7, pr_opened_at: null }),
      ],
    });

    const commit = markerOfKind(markers, "commit");
    const pr = markerOfKind(markers, "pr");
    assert.equal(commit.x, 50);
    assert.equal(pr.t, SESSION_MID);
  });

  it("falls back to endedAt when endMs is present but not finite", () => {
    const markers = build({
      endMs: Number.NaN,
      endedAt: SESSION_END,
      links: [
        commitLink({ sha: SHA, artifact_committed_at: SESSION_QUARTER }),
        prLink({ pr_number: 7, pr_opened_at: null }),
      ],
    });

    assert.equal(markerOfKind(markers, "commit").x, 25);
    assert.equal(markerOfKind(markers, "pr").t, SESSION_END);
  });

  it("falls back to updatedAt when endedAt is absent and endMs is omitted", () => {
    const markers = build({
      endedAt: null,
      updatedAt: SESSION_MID,
      links: [commitLink({ sha: SHA, artifact_committed_at: SESSION_QUARTER })],
    });

    assert.equal(markers[0].x, 50);
  });
});

describe("buildArtifactSessionMarkers — x coordinate", () => {
  it("clamps to [0, 100] around the session span", () => {
    const markers = build({
      links: [
        commitLink({
          sha: "aaa0000000000",
          artifact_committed_at: BEFORE_SESSION,
        }),
        commitLink({
          sha: "bbb0000000000",
          artifact_committed_at: SESSION_MID,
        }),
        commitLink({
          sha: "ccc0000000000",
          artifact_committed_at: AFTER_SESSION,
        }),
      ],
    });

    assert.deepEqual(
      markers.map((marker) => marker.x),
      [0, 50, 100]
    );
  });

  it("rounds to two decimal places", () => {
    const [marker] = build({
      links: [
        commitLink({
          sha: SHA,
          artifact_committed_at: "2026-06-22T10:00:01.000Z",
        }),
      ],
    });

    assert.equal(marker.x, 0.03);
  });

  it("uses the 1ms duration fallback when the end anchor precedes the start", () => {
    const markers = build({
      startedAt: SESSION_END,
      endedAt: SESSION_START,
      links: [
        commitLink({
          sha: "aaa0000000000",
          artifact_committed_at: SESSION_END,
        }),
        commitLink({
          sha: "bbb0000000000",
          artifact_committed_at: "2026-06-22T11:00:00.001Z",
        }),
        commitLink({
          sha: "ccc0000000000",
          artifact_committed_at: "2026-06-22T10:59:59.999Z",
        }),
      ],
    });

    assert.deepEqual(
      markers.map((marker) => marker.x),
      [0, 0, 100]
    );
  });

  it("pins x at 0 when the session has no parseable start", () => {
    const [marker] = build({
      startedAt: null,
      links: [commitLink({ sha: SHA, artifact_committed_at: SESSION_MID })],
    });

    assert.equal(marker.x, 0);
  });
});

describe("buildArtifactSessionMarkers — dedup and ordering", () => {
  it("keeps the earliest candidate when two links share an identity", () => {
    const markers = build({
      links: [
        commitLink({
          sha: SHA,
          title: "later",
          artifact_committed_at: SESSION_MID,
        }),
        commitLink({
          sha: SHA,
          title: "earlier",
          artifact_committed_at: SESSION_QUARTER,
        }),
      ],
    });

    assert.equal(markers.length, 1);
    assert.equal(markers[0].label, "earlier");
    assert.equal(markers[0].t, SESSION_QUARTER);
  });

  it("keeps the earliest candidate when two PR links share an identity", () => {
    const markers = build({
      links: [
        prLink({ pr_number: 12, title: "later", pr_opened_at: SESSION_MID }),
        prLink({
          pr_number: 12,
          title: "earlier",
          pr_opened_at: SESSION_QUARTER,
        }),
      ],
    });

    assert.equal(markers.length, 1);
    assert.equal(markers[0].label, "PR #12 opened: earlier");
    assert.equal(markers[0].t, SESSION_QUARTER);
  });

  it("treats the same sha under different repos as distinct commits", () => {
    const markers = build({
      links: [
        commitLink({
          sha: SHA,
          repo_full_name: "acme/app",
          artifact_committed_at: SESSION_MID,
        }),
        commitLink({
          sha: SHA,
          repo_full_name: null,
          artifact_committed_at: SESSION_MID,
        }),
      ],
    });

    assert.equal(markers.length, 2);
  });

  // ISS-7570: an ASYMMETRY, pinned as the shipped behavior rather than endorsed.
  // The commit identity is built from the trimmed repo; the PR identity is built
  // from the raw column even though the PR gate validates the trimmed value, so
  // one padded row splits into a second PR dot. Changing that is a production
  // fix, not a test edit — this case is the tripwire that will surface it.
  it("normalizes the repo for the commit identity but not for the PR identity", () => {
    const commits = build({
      links: [
        commitLink({
          sha: SHA,
          repo_full_name: "acme/app",
          title: "earlier",
          artifact_committed_at: SESSION_QUARTER,
        }),
        commitLink({
          sha: SHA,
          repo_full_name: "  acme/app  ",
          title: "later",
          artifact_committed_at: SESSION_MID,
        }),
      ],
    });
    const prs = build({
      links: [
        prLink({ repo_full_name: "acme/app", pr_opened_at: SESSION_QUARTER }),
        prLink({ repo_full_name: "  acme/app  ", pr_opened_at: SESSION_MID }),
      ],
    });

    assert.equal(commits.length, 1);
    assert.equal(prs.length, 2);
  });

  it("orders by timestamp and breaks ties on identity", () => {
    const markers = build({
      links: [
        commitLink({
          sha: "bbb0000000000",
          title: "b",
          artifact_committed_at: SESSION_MID,
        }),
        commitLink({
          sha: "aaa0000000000",
          title: "a",
          artifact_committed_at: SESSION_MID,
        }),
        commitLink({
          sha: "ccc0000000000",
          title: "c",
          artifact_committed_at: SESSION_QUARTER,
        }),
      ],
    });

    assert.deepEqual(
      markers.map((marker) => marker.label),
      ["c", "a", "b"]
    );
  });

  // The contract is that the builder's internal bookkeeping does not leak, not
  // that `SessionMarker` has exactly five keys — it already carries an optional
  // `illustrative`, so an exact key list would break on a future public field
  // for the wrong reason.
  it("strips the internal candidate fields from every emitted marker", () => {
    const [marker] = build({
      links: [commitLink({ sha: SHA, artifact_committed_at: SESSION_MID })],
    });
    const keys = Object.keys(marker);

    assert.ok(!keys.includes("identity"));
    assert.ok(!keys.includes("timestampMs"));
    for (const required of ["kind", "label", "t", "tl", "x"]) {
      assert.ok(keys.includes(required), `missing public field ${required}`);
    }
  });
});

describe("buildArtifactSessionMarkers — nearest timeline index", () => {
  it("anchors to the closest timeline row", () => {
    const [marker] = build({
      links: [
        commitLink({
          sha: SHA,
          artifact_committed_at: "2026-06-22T10:20:00.000Z",
        }),
      ],
    });

    assert.equal(marker.tl, 1);
  });

  it("keeps the earliest row when two are equidistant", () => {
    const [marker] = build({
      links: [commitLink({ sha: SHA, artifact_committed_at: SESSION_QUARTER })],
    });

    assert.equal(marker.tl, 0);
  });

  it("skips unparseable rows without shifting the surviving indices", () => {
    const [marker] = build({
      timelineRows: [
        { createdAt: "not-a-date" },
        { createdAt: SESSION_START },
        { createdAt: SESSION_END },
      ],
      links: [
        commitLink({
          sha: SHA,
          artifact_committed_at: "2026-06-22T10:55:00.000Z",
        }),
      ],
    });

    assert.equal(marker.tl, 2);
  });

  it("anchors every marker at tl 0 when the timeline is empty", () => {
    const markers = build({
      timelineRows: [],
      links: [
        commitLink({
          sha: "aaa0000000000",
          artifact_committed_at: SESSION_QUARTER,
        }),
        commitLink({
          sha: "bbb0000000000",
          artifact_committed_at: SESSION_END,
        }),
      ],
    });

    assert.deepEqual(
      markers.map((marker) => marker.tl),
      [0, 0]
    );
  });

  it("anchors every marker at tl 0 when no timeline row is parseable", () => {
    const [marker] = build({
      timelineRows: [{ createdAt: "not-a-date" }, { createdAt: "" }],
      links: [commitLink({ sha: SHA, artifact_committed_at: SESSION_END })],
    });

    assert.equal(marker.tl, 0);
  });
});

describe("mergeSessionMarkers", () => {
  it("keeps trace and artifact markers that do not collide", () => {
    const merged = mergeSessionMarkers(
      [marker({ kind: "prompt", label: "Prompt", tl: 0, t: SESSION_START })],
      [marker({ kind: "commit", label: "Fix bug", tl: 1, t: SESSION_MID })]
    );

    assert.deepEqual(
      merged.map((entry) => entry.label),
      ["Prompt", "Fix bug"]
    );
  });

  it("drops an artifact marker whose kind and label match a trace marker", () => {
    const merged = mergeSessionMarkers(
      [marker({ kind: "commit", label: "Fix bug", tl: 5 })],
      [marker({ kind: "commit", label: "Fix bug", tl: 2 })]
    );

    assert.equal(merged.length, 1);
    assert.equal(merged[0].tl, 5);
  });

  it("keeps an artifact marker that shares a trace label but not its kind", () => {
    const merged = mergeSessionMarkers(
      [marker({ kind: "prompt", label: "Same label", tl: 0 })],
      [marker({ kind: "commit", label: "Same label", tl: 7 })]
    );

    assert.equal(merged.length, 2);
  });

  it("keeps an artifact marker that shares a trace kind but not its label or anchor", () => {
    const merged = mergeSessionMarkers(
      [marker({ kind: "commit", label: "Trace commit", tl: 0 })],
      [marker({ kind: "commit", label: "Artifact commit", tl: 7 })]
    );

    assert.equal(merged.length, 2);
  });

  it("drops an artifact marker sharing a timeline anchor with the same trace kind", () => {
    const merged = mergeSessionMarkers(
      [marker({ kind: "pr", label: "PR #1 opened", tl: 3 })],
      [marker({ kind: "pr", label: "PR #2 opened", tl: 3 })]
    );

    assert.deepEqual(
      merged.map((entry) => entry.label),
      ["PR #1 opened"]
    );
  });

  it("keeps an artifact marker of a different kind at the same anchor", () => {
    const merged = mergeSessionMarkers(
      [marker({ kind: "commit", label: "Fix bug", tl: 3 })],
      [marker({ kind: "pr", label: "PR #2 opened", tl: 3 })]
    );

    assert.equal(merged.length, 2);
  });

  it("applies the anchor rule only to commit and pr markers", () => {
    const merged = mergeSessionMarkers(
      [marker({ kind: "prompt", label: "First prompt", tl: 3 })],
      [marker({ kind: "prompt", label: "Second prompt", tl: 3 })]
    );

    assert.equal(merged.length, 2);
  });

  it("orders by timeline anchor, then timestamp, then trace first", () => {
    const merged = mergeSessionMarkers(
      [
        marker({ kind: "prompt", label: "trace-tl2", tl: 2, t: SESSION_MID }),
        marker({ kind: "fail", label: "trace-tl0", tl: 0, t: SESSION_START }),
      ],
      [
        marker({
          kind: "commit",
          label: "artifact-tl2",
          tl: 2,
          t: SESSION_MID,
        }),
        marker({
          kind: "pr",
          label: "artifact-tl1",
          tl: 1,
          t: SESSION_QUARTER,
        }),
      ]
    );

    assert.deepEqual(
      merged.map((entry) => entry.label),
      ["trace-tl0", "artifact-tl1", "trace-tl2", "artifact-tl2"]
    );
  });

  it("lets an earlier timestamp outrank trace-first within one anchor", () => {
    const merged = mergeSessionMarkers(
      [marker({ kind: "prompt", label: "trace-late", tl: 2, t: SESSION_MID })],
      [
        marker({
          kind: "commit",
          label: "artifact-early",
          tl: 2,
          t: SESSION_QUARTER,
        }),
      ]
    );

    assert.deepEqual(
      merged.map((entry) => entry.label),
      ["artifact-early", "trace-late"]
    );
  });

  it("sorts markers with a non-finite anchor or unparseable timestamp last", () => {
    const merged = mergeSessionMarkers(
      [
        marker({
          kind: "prompt",
          label: "no-anchor",
          tl: Number.NaN,
          t: SESSION_START,
        }),
        marker({ kind: "fail", label: "bad-time", tl: 4, t: "not-a-date" }),
        marker({ kind: "fail", label: "good-time", tl: 4, t: SESSION_START }),
      ],
      []
    );

    assert.deepEqual(
      merged.map((entry) => entry.label),
      ["good-time", "bad-time", "no-anchor"]
    );
  });

  it("preserves input order for trace markers that tie on every key", () => {
    const merged = mergeSessionMarkers(
      [
        marker({ kind: "fail", label: "first", tl: 1, t: SESSION_MID }),
        marker({ kind: "fail", label: "second", tl: 1, t: SESSION_MID }),
      ],
      []
    );

    assert.deepEqual(
      merged.map((entry) => entry.label),
      ["first", "second"]
    );
  });

  it("returns an empty list when both inputs are empty", () => {
    assert.deepEqual(mergeSessionMarkers([], []), []);
  });
});

describe("buildArtifactSessionMarkers + mergeSessionMarkers", () => {
  it("merges derived artifact markers into a trace marker list", () => {
    const artifactMarkers = build({
      links: [
        commitLink({
          sha: SHA,
          title: "Implement marker helper",
          artifact_committed_at: SESSION_MID,
        }),
        prLink({ pr_number: 12, pr_opened_at: SESSION_END }),
      ],
    });

    const merged = mergeSessionMarkers(
      [marker({ kind: "prompt", label: "Kickoff", tl: 0, t: SESSION_START })],
      artifactMarkers
    );

    assert.deepEqual(
      merged.map((entry) => entry.label),
      ["Kickoff", "Implement marker helper", "PR #12 opened"]
    );
  });

  it("collapses distinct artifact markers onto a trace anchor when the timeline is empty", () => {
    const artifactMarkers = build({
      timelineRows: [],
      links: [
        commitLink({
          sha: "aaa0000000000",
          artifact_committed_at: SESSION_QUARTER,
        }),
        commitLink({
          sha: "bbb0000000000",
          artifact_committed_at: SESSION_MID,
        }),
      ],
    });
    assert.equal(artifactMarkers.length, 2);

    const merged = mergeSessionMarkers(
      [
        marker({
          kind: "commit",
          label: "Trace commit",
          tl: 0,
          t: SESSION_START,
        }),
      ],
      artifactMarkers
    );

    assert.deepEqual(
      merged.map((entry) => entry.label),
      ["Trace commit"]
    );
  });
});

function linkRow(
  overrides: Partial<ArtifactMarkerLinkRow> = {}
): ArtifactMarkerLinkRow {
  return {
    target_kind: "commit",
    relation: "created",
    repo_full_name: "acme/app",
    pr_number: null,
    sha: null,
    title: null,
    link_observed_at: null,
    artifact_committed_at: null,
    artifact_observed_at: null,
    artifact_last_seen_at: null,
    pr_opened_at: null,
    ...overrides,
  };
}

function commitLink(
  overrides: Partial<ArtifactMarkerLinkRow> = {}
): ArtifactMarkerLinkRow {
  return linkRow({ target_kind: "commit", ...overrides });
}

function prLink(
  overrides: Partial<ArtifactMarkerLinkRow> = {}
): ArtifactMarkerLinkRow {
  return linkRow({ target_kind: "pull_request", pr_number: 12, ...overrides });
}

function build(
  overrides: Partial<BuildArtifactSessionMarkersInput> = {}
): SessionMarker[] {
  return buildArtifactSessionMarkers({
    startedAt: SESSION_START,
    endedAt: SESSION_END,
    updatedAt: null,
    links: [],
    timelineRows: TIMELINE_ROWS,
    ...overrides,
  });
}

function marker(overrides: Partial<SessionMarker> = {}): SessionMarker {
  return {
    kind: "commit",
    x: 0,
    t: SESSION_START,
    label: "marker",
    tl: 0,
    ...overrides,
  };
}

function markerOfKind(
  markers: readonly SessionMarker[],
  kind: SessionMarker["kind"]
): SessionMarker {
  const found = markers.find((entry) => entry.kind === kind);
  if (!found) {
    throw new Error(`expected a ${kind} marker`);
  }
  return found;
}
