import type { PullRequest } from "@octokit/webhooks-types";
import { GitHubPRState } from "@repo/api/src/types/github";
import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  applyPullRequestAction,
  type HandledPullRequestEvent,
} from "./pull-request-action-application";

/**
 * ISS-6319 (batch 3/6). Two independent contracts per site, and both are
 * required:
 *
 * PARITY — the write still targets the same row with the same data, and an
 * ABSENT row still rejects with P2025 rather than resolving as a silent no-op.
 * These hold on unmodified `main` and after the conversion; they are what
 * proves `select:` narrowing did not become an `updateMany` in disguise.
 *
 * NARROWING — every discarded write carries an explicit `select`, so Postgres
 * RETURNINGs one primary-key cell instead of every column. ISS-6227 measured
 * that shape at ~620 B/row + ~270 B per CELL, so a wide row costs real memory
 * even when every column is short or NULL. This fails on `main` by design.
 *
 * The P2025 cases are not ceremony here. `pull-request-handler.ts` documents
 * (FEA-2732) that a `githubId`-keyed update throwing "record to update not
 * found" is what rolls the whole webhook transaction back; that rollback is the
 * repair path for a desktop-synced row whose `githubId` was never stamped.
 * Converting any of these ten sites to `updateMany` would commit the Artifact
 * status change while silently skipping its PullRequestDetail half, leaving a
 * half-applied projection that no retry repairs.
 */

const PR_ARTIFACT_ID = "77777777-7777-4777-8777-777777777777";
const GITHUB_PR_ID = 6319;
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

const NARROWING_METHODS = new Set(["create", "update", "upsert"]);

/** Every action whose branch drives an Artifact + PullRequestDetail write pair. */
const PAIRED_ACTIONS = [
  "opened",
  "edited",
  "closed",
  "reopened",
  "synchronize",
  "converted_to_draft",
  "ready_for_review",
] as const;

describe("applyPullRequestAction discarded writes", () => {
  it.each(
    PAIRED_ACTIONS
  )("PARITY: %s writes the artifact status and its detail row", async (action) => {
    const tx = createRecordingTx();

    await applyPullRequestAction(tx.client, prEvent(action), existingPr());

    const artifactUpdate = tx.only("artifact", "update");
    expect(artifactUpdate.where).toEqual({ id: PR_ARTIFACT_ID });

    const detailUpdate = tx.only("pullRequestDetail", "update");
    expect(detailUpdate.where).toEqual({ githubId: String(GITHUB_PR_ID) });
    expect(detailUpdate.data).toMatchObject({ number: 4242 });
  });

  it.each(
    PAIRED_ACTIONS
  )("PARITY: %s still rejects with P2025 when the artifact row is absent", async (action) => {
    const tx = createRecordingTx({
      reject: { model: "artifact", method: "update" },
    });

    await expect(
      applyPullRequestAction(tx.client, prEvent(action), existingPr())
    ).rejects.toMatchObject({ code: "P2025" });

    // The throw aborts the slice, so the dependent detail write never runs.
    expect(tx.calls("pullRequestDetail", "update")).toHaveLength(0);
  });

  it.each(
    PAIRED_ACTIONS
  )("PARITY: %s still rejects with P2025 when the detail row is absent", async (action) => {
    const tx = createRecordingTx({
      reject: { model: "pullRequestDetail", method: "update" },
    });

    await expect(
      applyPullRequestAction(tx.client, prEvent(action), existingPr())
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it.each(
    PAIRED_ACTIONS
  )("NARROWING: %s RETURNINGs only each row's primary key", async (action) => {
    const tx = createRecordingTx();

    await applyPullRequestAction(tx.client, prEvent(action), existingPr());

    expect(tx.only("artifact", "update").select).toEqual({ id: true });
    // PullRequestDetail is keyed on `id`, NOT `artifactId` — it is the one
    // `*Detail` table that is not class-table-inheritance keyed.
    expect(tx.only("pullRequestDetail", "update").select).toEqual({
      id: true,
    });
    expect(wideWrites(tx)).toEqual([]);
  });

  it("PARITY: closed carries the merged state onto both rows", async () => {
    const tx = createRecordingTx();

    await applyPullRequestAction(tx.client, mergedEvent(), existingPr());

    expect(tx.only("artifact", "update").data).toMatchObject({
      status: GitHubPRState.Merged,
    });
    expect(tx.only("pullRequestDetail", "update").data).toMatchObject({
      prState: GitHubPRState.Merged,
    });
  });

  it("PARITY: synchronize leaves the branchDetail write on updateMany", async () => {
    const tx = createRecordingTx();

    await applyPullRequestAction(
      tx.client,
      prEvent("synchronize"),
      existingPr()
    );

    // Deliberate on `main`: the headSha write reads `.count` to decide whether
    // to invalidate status checks, so a missing row genuinely is acceptable. It
    // stays a batch write and must not be "narrowed" into a throwing update.
    // (`stampBranchFirstPush` issues the second, unrelated `updateMany`.)
    const headShaWrites = tx
      .calls("branchDetail", "updateMany")
      .filter((call) => hasKey(call.data, "headSha"));
    expect(headShaWrites).toHaveLength(1);
    expect(headShaWrites[0].data).toMatchObject({ headSha: HEAD_SHA });
    expect(tx.calls("branchDetail", "update")).toHaveLength(0);
  });
});

type RecordedCall = {
  model: string;
  method: string;
  where?: unknown;
  data?: unknown;
  select?: unknown;
};

type RecordingTxOptions = {
  reject?: { model: string; method: string; code?: string };
};

/**
 * A delegate-shaped recorder. Reads resolve to the "row absent" answer so the
 * production path takes its create branch, and every write records the exact
 * argument object the caller handed Prisma — which is the only thing this
 * ticket changes.
 */
function createRecordingTx(options: RecordingTxOptions = {}) {
  const recorded: RecordedCall[] = [];
  const client = new Proxy(
    {},
    {
      get(_unusedTarget, model: string) {
        return new Proxy(
          {},
          {
            get(_unusedDelegate, method: string) {
              return (args: Record<string, unknown> = {}) => {
                recorded.push({
                  model,
                  method,
                  where: args.where,
                  data: args.data,
                  select: args.select,
                });
                return resolveDelegateCall(model, method, options);
              };
            },
          }
        );
      },
    }
  );

  const calls = (model: string, method: string) =>
    recorded.filter((call) => call.model === model && call.method === method);

  return {
    // Single cast at the fake/production seam; the Proxy answers every delegate.
    client: client as Parameters<typeof applyPullRequestAction>[0],
    all: () => recorded,
    calls,
    only(model: string, method: string) {
      const matches = calls(model, method);
      if (matches.length !== 1) {
        throw new Error(
          `fixture expected exactly one ${model}.${method} call, saw ${matches.length}`
        );
      }
      return matches[0];
    },
  };
}

function resolveDelegateCall(
  model: string,
  method: string,
  options: RecordingTxOptions
): Promise<unknown> {
  const { reject } = options;
  if (reject && reject.model === model && reject.method === method) {
    return Promise.reject(
      new Prisma.PrismaClientKnownRequestError(
        `synthetic ${reject.code ?? "P2025"} for ${model}.${method}`,
        { code: reject.code ?? "P2025", clientVersion: "test" }
      )
    );
  }
  if (method === "findMany") {
    return Promise.resolve([]);
  }
  if (method === "findFirst" || method === "findUnique") {
    return Promise.resolve(null);
  }
  if (method === "updateMany" || method === "deleteMany") {
    return Promise.resolve({ count: 0 });
  }
  if (method === "count") {
    return Promise.resolve(0);
  }
  return Promise.resolve({ id: PR_ARTIFACT_ID });
}

/**
 * The blanket contract, so a write added to this path later cannot quietly
 * reintroduce `RETURNING *` while the per-site assertions above stay green.
 */
function wideWrites(tx: { all: () => RecordedCall[] }): string[] {
  return tx
    .all()
    .filter(
      (call) => NARROWING_METHODS.has(call.method) && call.select === undefined
    )
    .map((call) => `${call.model}.${call.method}`);
}

function hasKey(data: unknown, key: string): boolean {
  return typeof data === "object" && data !== null && key in data;
}

function existingPr() {
  return {
    id: PR_ARTIFACT_ID,
    headSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

function pullRequestPayload(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: GITHUB_PR_ID,
    number: 4242,
    title: "ISS-6319 fixture",
    html_url: "https://github.com/closedloop-ai/symphony-alpha/pull/4242",
    body: null,
    state: "open",
    draft: false,
    merged: false,
    additions: 1,
    deletions: 0,
    changed_files: 1,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    closed_at: null,
    merged_at: null,
    merge_commit_sha: null,
    user: { login: "closedloop-bot" },
    head: { ref: "fix/iss-6319", sha: HEAD_SHA },
    base: { ref: "main" },
    ...overrides,
  } as unknown as PullRequest;
}

function prEvent(
  action: (typeof PAIRED_ACTIONS)[number]
): HandledPullRequestEvent {
  return {
    action,
    pull_request: pullRequestPayload(),
    before: "before-sha",
    after: "after-sha",
  } as unknown as HandledPullRequestEvent;
}

function mergedEvent(): HandledPullRequestEvent {
  return {
    action: "closed",
    pull_request: pullRequestPayload({
      merged: true,
      merged_at: "2026-08-03T00:00:00Z",
      closed_at: "2026-08-03T00:00:00Z",
    } as Partial<PullRequest>),
  } as unknown as HandledPullRequestEvent;
}
