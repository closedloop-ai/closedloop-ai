// The run point read and writes behind the never-scheduled auto-recovery
// (ISS-11040). Payloads are literal, trimmed from a real
// `GET /repos/closedloop-ai/closedloop-ai/actions/runs/35950581835` on
// 2026-09-24 — GitHub's shape is the truth here, not ours.

import { describe, expect, it } from "vitest";
import { UNNAMED_WORKFLOW } from "../never-scheduled-runs";
import {
  cancelWorkflowRun,
  getWorkflowRunState,
  listRunsOnHead,
  rerunWorkflowRun,
} from "../workflow-run-recovery";
import { createOctokitMock } from "./never-scheduled-runs-fixtures";

const OWNER = "closedloop-ai";
const REPO = "closedloop-ai";
const RUN_ID = 35_950_581_835;

const QUEUED_RUN = {
  id: RUN_ID,
  name: "PR Tests",
  status: "queued",
  conclusion: null,
  run_attempt: 1,
  head_sha: "1796934b2137c8f95d7f00c624d0865e9d315c76",
  event: "pull_request",
  run_started_at: "2026-09-24T03:13:57Z",
};

describe("getWorkflowRunState", () => {
  it("reads the live status and attempt of the named run", async () => {
    const { octokit, request } = createOctokitMock();
    request.mockResolvedValue({ status: 200, data: QUEUED_RUN });

    await expect(
      getWorkflowRunState(octokit, OWNER, REPO, RUN_ID)
    ).resolves.toEqual({ status: "queued", runAttempt: 1 });
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/actions/runs/{run_id}",
      { owner: OWNER, repo: REPO, run_id: RUN_ID }
    );
  });

  it("is unreadable, not attempt 1, when GitHub omits run_attempt", async () => {
    const { octokit, request } = createOctokitMock();
    const { run_attempt: _omitted, ...withoutAttempt } = QUEUED_RUN;
    request.mockResolvedValue({ status: 200, data: withoutAttempt });

    await expect(
      getWorkflowRunState(octokit, OWNER, REPO, RUN_ID)
    ).resolves.toBeNull();
  });

  it("is unreadable when the request fails", async () => {
    const { octokit, request } = createOctokitMock();
    request.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    await expect(
      getWorkflowRunState(octokit, OWNER, REPO, RUN_ID)
    ).resolves.toBeNull();
  });
});

describe("the writes", () => {
  it("cancels and re-runs the named run on their own endpoints", async () => {
    const { octokit, request } = createOctokitMock();
    request.mockResolvedValue({ status: 202, data: {} });

    await expect(
      cancelWorkflowRun(octokit, OWNER, REPO, RUN_ID)
    ).resolves.toEqual({ ok: true });
    await expect(
      rerunWorkflowRun(octokit, OWNER, REPO, RUN_ID)
    ).resolves.toEqual({ ok: true });
    expect(request.mock.calls).toEqual([
      [
        "POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel",
        { owner: OWNER, repo: REPO, run_id: RUN_ID },
      ],
      [
        "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
        { owner: OWNER, repo: REPO, run_id: RUN_ID },
      ],
    ]);
  });

  it("reports a refusal with GitHub's status and message", async () => {
    const { octokit, request } = createOctokitMock();
    request.mockRejectedValue(
      Object.assign(new Error("Failed to cancel workflow run"), {
        status: 500,
      })
    );

    await expect(
      cancelWorkflowRun(octokit, OWNER, REPO, RUN_ID)
    ).resolves.toEqual({
      ok: false,
      detail: "HTTP 500: Failed to cancel workflow run",
    });
  });
});

describe("write failure detail", () => {
  it("carries the bare message when the rejection has no numeric status", async () => {
    const { octokit, request } = createOctokitMock();
    request.mockRejectedValue(new Error("socket hang up"));

    await expect(
      rerunWorkflowRun(octokit, OWNER, REPO, RUN_ID)
    ).resolves.toEqual({ ok: false, detail: "socket hang up" });
  });

  it("stringifies a non-Error rejection and prefixes its numeric status", async () => {
    const { octokit, request } = createOctokitMock();
    request.mockRejectedValueOnce("plain failure");
    request.mockRejectedValueOnce({ status: 403 });

    await expect(
      cancelWorkflowRun(octokit, OWNER, REPO, RUN_ID)
    ).resolves.toEqual({ ok: false, detail: "plain failure" });
    // pins current behavior; looks odd because a non-Error object rejection
    // prints as "[object Object]" instead of its fields.
    await expect(
      cancelWorkflowRun(octokit, OWNER, REPO, RUN_ID)
    ).resolves.toEqual({ ok: false, detail: "HTTP 403: [object Object]" });
  });
});

describe("listRunsOnHead", () => {
  it("asks for every run on one head and reads what supersession is judged on", async () => {
    const { octokit, request } = createOctokitMock();
    request.mockResolvedValue({
      status: 200,
      data: {
        total_count: 1,
        workflow_runs: [
          {
            ...QUEUED_RUN,
            workflow_id: 225_768_743,
            run_number: 31_906,
            status: "completed",
            conclusion: "cancelled",
          },
        ],
      },
    });

    await expect(
      listRunsOnHead(octokit, OWNER, REPO, QUEUED_RUN.head_sha)
    ).resolves.toEqual([
      {
        id: RUN_ID,
        workflowId: 225_768_743,
        runNumber: 31_906,
        workflow: "PR Tests",
        runAttempt: 1,
        conclusion: "cancelled",
      },
    ]);
    expect(request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/actions/runs",
      {
        owner: OWNER,
        repo: REPO,
        head_sha: QUEUED_RUN.head_sha,
        per_page: 100,
      }
    );
  });

  it("reads a page with a run missing its workflow id as unreadable", async () => {
    const { octokit, request } = createOctokitMock();
    request.mockResolvedValue({
      status: 200,
      data: {
        total_count: 1,
        workflow_runs: [{ ...QUEUED_RUN, run_number: 31_906 }],
      },
    });

    await expect(
      listRunsOnHead(octokit, OWNER, REPO, QUEUED_RUN.head_sha)
    ).resolves.toBeNull();
  });

  it("names a run with a null workflow name as unnamed", async () => {
    const { octokit, request } = createOctokitMock();
    request.mockResolvedValue({
      status: 200,
      data: {
        total_count: 1,
        workflow_runs: [
          {
            ...QUEUED_RUN,
            name: null,
            workflow_id: 225_768_743,
            run_number: 31_906,
          },
        ],
      },
    });

    const runs = await listRunsOnHead(
      octokit,
      OWNER,
      REPO,
      QUEUED_RUN.head_sha
    );

    expect(runs?.map((run) => run.workflow)).toEqual([UNNAMED_WORKFLOW]);
  });

  it("reads the head runs as unreadable when the request fails", async () => {
    const { octokit, request } = createOctokitMock();
    request.mockRejectedValue(new Error("boom"));

    await expect(
      listRunsOnHead(octokit, OWNER, REPO, QUEUED_RUN.head_sha)
    ).resolves.toBeNull();
  });
});
