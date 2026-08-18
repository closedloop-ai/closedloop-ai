import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LoopCommand } from "@closedloop-ai/loops-api/commands";
import {
  parseSymphonyLoopRequestBody,
  SymphonyLoopRequestValidationError,
} from "../src/server/operations/symphony-loop-request.js";

describe("parseSymphonyLoopRequestBody", () => {
  test("accepts current LoopRequestBody bodies and preserves existing context fields", () => {
    const priorLoopSummaries = [
      { loopId: "prior-loop", summary: "implemented the API route" },
    ];
    const attachments = [
      {
        id: "att-1",
        filename: "screenshot.png",
        signedUrl:
          "https://closedloop-files.s3.us-east-1.amazonaws.com/user/screenshot.png",
        signedUrlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        sizeBytes: 12,
      },
    ];

    const parsed = parseSymphonyLoopRequestBody({
      loopId: "aaaaaaaa-0000-0000-0000-000000000001",
      command: LoopCommand.EvaluatePrd,
      closedLoopAuthToken: "token",
      artifacts: [{ id: "prd-1", type: "PRD", content: "PRD" }],
      priorLoopSummaries,
      attachments,
    });

    assert.deepEqual(parsed.supportingArtifacts, []);
    assert.equal(parsed.codeEvaluationContext, null);
    assert.equal(parsed.priorLoopSummaries, priorLoopSummaries);
    assert.equal(parsed.attachments, attachments);
  });

  test("accepts optional FEA-585 supporting artifacts and code context", () => {
    const parsed = parseSymphonyLoopRequestBody({
      loopId: "bbbbbbbb-0000-0000-0000-000000000002",
      command: LoopCommand.EvaluateCode,
      closedLoopAuthToken: "token",
      artifacts: [
        { id: "plan-1", type: "IMPLEMENTATION_PLAN", content: "Plan" },
      ],
      localRepoPath: "/tmp/example-repo",
      supportingArtifacts: [
        {
          id: "prd-ref",
          type: "PRD",
          title: "Referenced PRD",
          filename: "prd.md",
          content: "# Referenced PRD",
        },
      ],
      codeEvaluationContext: {
        repo: { fullName: "org/repo", branch: "main" },
        localRepoPath: "/tmp/example-repo",
        parentBranchName: "symphony/parent",
        parentSessionId: "session-123",
        artifactSlug: "PLN-573",
        pullRequest: {
          number: 123,
          url: "https://github.com/org/repo/pull/123",
          headBranch: "feature",
          baseBranch: "main",
          headSha: "abc1234",
          repositoryFullName: "org/repo",
        },
      },
    });

    assert.equal(parsed.supportingArtifacts.length, 1);
    assert.equal(parsed.supportingArtifacts[0].id, "prd-ref");
    assert.equal(parsed.codeEvaluationContext?.repo?.fullName, "org/repo");
    assert.equal(parsed.codeEvaluationContext?.pullRequest?.number, 123);
  });

  test("accepts valid branch materialization envelope", () => {
    const parsed = parseSymphonyLoopRequestBody({
      loopId: "eeeeeeee-0000-0000-0000-000000000005",
      command: LoopCommand.Plan,
      closedLoopAuthToken: "token",
      artifacts: [],
      repo: { fullName: "org/repo", branch: "main" },
      branchMaterialization: {
        schemaVersion: 1,
        branches: [
          {
            role: "primary",
            repositoryFullName: "org/repo",
            baseBranch: "main",
            branchName: "symphony/PLN-604",
          },
          {
            role: "additional",
            repositoryFullName: "org/peer",
            baseBranch: "develop",
            branchName: "symphony/PLN-604-peer",
          },
        ],
      },
    });

    assert.equal(parsed.branchMaterialization?.schemaVersion, 1);
    assert.equal(parsed.branchMaterialization?.branches[0].role, "primary");
    assert.equal(
      parsed.branchMaterialization?.branches[1].repositoryFullName,
      "org/peer"
    );
  });

  test("treats null branch materialization as absent", () => {
    const parsed = parseSymphonyLoopRequestBody({
      loopId: "eeeeeeee-0000-0000-0000-000000000009",
      command: LoopCommand.Plan,
      closedLoopAuthToken: "token",
      artifacts: [],
      repo: { fullName: "org/repo", branch: "main" },
      branchMaterialization: null,
    });

    assert.equal(parsed.branchMaterialization, undefined);
  });

  test("rejects malformed new optional fields with clear validation errors", () => {
    assert.throws(
      () =>
        parseSymphonyLoopRequestBody({
          loopId: "cccccccc-0000-0000-0000-000000000003",
          command: LoopCommand.EvaluatePrd,
          closedLoopAuthToken: "token",
          artifacts: [{ type: "PRD", content: "PRD" }],
          supportingArtifacts: [{ id: "missing-content", type: "PRD" }],
        }),
      (err) =>
        err instanceof SymphonyLoopRequestValidationError &&
        err.message.includes("supportingArtifacts is malformed") &&
        err.message.includes("content")
    );

    assert.throws(
      () =>
        parseSymphonyLoopRequestBody({
          loopId: "dddddddd-0000-0000-0000-000000000004",
          command: LoopCommand.EvaluateCode,
          closedLoopAuthToken: "token",
          artifacts: [{ type: "IMPLEMENTATION_PLAN", content: "Plan content" }],
          codeEvaluationContext: {
            pullRequest: { number: "123" },
          },
        }),
      (err) =>
        err instanceof SymphonyLoopRequestValidationError &&
        err.message.includes("codeEvaluationContext is malformed") &&
        err.message.includes("pullRequest.number")
    );
  });

  test("rejects malformed branch materialization envelope", () => {
    assert.throws(
      () =>
        parseSymphonyLoopRequestBody({
          loopId: "ffffffff-0000-0000-0000-000000000006",
          command: LoopCommand.Plan,
          closedLoopAuthToken: "token",
          artifacts: [],
          repo: { fullName: "org/repo", branch: "main" },
          branchMaterialization: {
            schemaVersion: 1,
            branches: [
              {
                role: "primary",
                repositoryFullName: "org/repo",
                baseBranch: "main",
              },
            ],
          },
        }),
      (err) =>
        err instanceof SymphonyLoopRequestValidationError &&
        err.message.includes("branchMaterialization is malformed") &&
        err.message.includes("branchName")
    );
  });

  test("rejects branch materialization entries with malformed repo or ref names", () => {
    assert.throws(
      () =>
        parseSymphonyLoopRequestBody({
          loopId: "ffffffff-0000-0000-0000-000000000007",
          command: LoopCommand.Plan,
          closedLoopAuthToken: "token",
          artifacts: [],
          repo: { fullName: "org/repo", branch: "main" },
          branchMaterialization: {
            schemaVersion: 1,
            branches: [
              {
                role: "primary",
                repositoryFullName: "not-a-full-name",
                baseBranch: "main",
                branchName: "symphony/PLN-604",
              },
            ],
          },
        }),
      (err) =>
        err instanceof SymphonyLoopRequestValidationError &&
        err.message.includes("repositoryFullName")
    );

    assert.throws(
      () =>
        parseSymphonyLoopRequestBody({
          loopId: "ffffffff-0000-0000-0000-000000000008",
          command: LoopCommand.Plan,
          closedLoopAuthToken: "token",
          artifacts: [],
          repo: { fullName: "org/repo", branch: "main" },
          branchMaterialization: {
            schemaVersion: 1,
            branches: [
              {
                role: "primary",
                repositoryFullName: "org/repo",
                baseBranch: "main",
                branchName: "symphony bad branch",
              },
            ],
          },
        }),
      (err) =>
        err instanceof SymphonyLoopRequestValidationError &&
        err.message.includes("branchName")
    );
  });

  // PLN-740 T-4.4: cloudSessionToken is tolerated-but-ignored. The field is
  // still stripped from rawBody for security but not propagated to the return value.
  test("PLN-740 T-4.4: cloudSessionToken is tolerated-but-ignored (stripped from rawBody)", () => {
    const parsed = parseSymphonyLoopRequestBody({
      loopId: "aaaaaaaa-0000-0000-0000-000000000010",
      command: LoopCommand.Plan,
      closedLoopAuthToken: "token",
      artifacts: [],
      repo: { fullName: "org/repo", branch: "main" },
      cloudSessionToken: "  session-tok-abc123  ",
    });

    // cloudSessionToken is no longer propagated to the return type.
    assert.equal(
      (parsed as unknown as Record<string, unknown>).cloudSessionToken,
      undefined,
      "cloudSessionToken must be stripped from the parsed body (PLN-740 T-4.4)"
    );
  });

  test("absent cloud session token: parsed body has no cloudSessionToken field", () => {
    const absent = parseSymphonyLoopRequestBody({
      loopId: "aaaaaaaa-0000-0000-0000-000000000011",
      command: LoopCommand.Plan,
      closedLoopAuthToken: "token",
      artifacts: [],
      repo: { fullName: "org/repo", branch: "main" },
    });
    assert.equal(
      (absent as unknown as Record<string, unknown>).cloudSessionToken,
      undefined
    );
  });

  test("rejects an oversized cloud session token (validation still runs for security)", () => {
    assert.throws(
      () =>
        parseSymphonyLoopRequestBody({
          loopId: "aaaaaaaa-0000-0000-0000-000000000013",
          command: LoopCommand.Plan,
          closedLoopAuthToken: "token",
          artifacts: [],
          repo: { fullName: "org/repo", branch: "main" },
          cloudSessionToken: "x".repeat(4097),
        }),
      (err) =>
        err instanceof SymphonyLoopRequestValidationError &&
        err.message.includes("cloudSessionToken is malformed")
    );
  });

  // ISS-5154: `s3StateKey` names where a crash support bundle is uploaded. A
  // present-but-wrong key used to collapse into omission, at which point
  // handleLoopRequest falls back to `existing.s3StateKey` and a redispatch files
  // this run's bundle under the PRIOR run's key.
  test("accepts the dispatcher's state key for this loop", () => {
    const loopId = "aaaaaaaa-0000-0000-0000-000000000020";
    const parsed = parseSymphonyLoopRequestBody({
      loopId,
      command: LoopCommand.Plan,
      closedLoopAuthToken: "token",
      artifacts: [],
      s3StateKey: `org-1/loops/${loopId}/run-1`,
    });
    assert.equal(parsed.s3StateKey, `org-1/loops/${loopId}/run-1`);
  });

  test("an ABSENT state key stays absent so the gateway keeps the job's existing key", () => {
    const parsed = parseSymphonyLoopRequestBody({
      loopId: "aaaaaaaa-0000-0000-0000-000000000021",
      command: LoopCommand.Plan,
      closedLoopAuthToken: "token",
      artifacts: [],
    });
    assert.equal(
      parsed.s3StateKey,
      undefined,
      "an older dispatcher omits the field entirely — that must not reject"
    );

    const explicitNull = parseSymphonyLoopRequestBody({
      loopId: "aaaaaaaa-0000-0000-0000-000000000022",
      command: LoopCommand.Plan,
      closedLoopAuthToken: "token",
      artifacts: [],
      s3StateKey: null,
    });
    assert.equal(explicitNull.s3StateKey, undefined);
  });

  test("rejects a state key belonging to ANOTHER loop", () => {
    assert.throws(
      () =>
        parseSymphonyLoopRequestBody({
          loopId: "aaaaaaaa-0000-0000-0000-000000000023",
          command: LoopCommand.Plan,
          closedLoopAuthToken: "token",
          artifacts: [],
          s3StateKey: "org-1/loops/aaaaaaaa-0000-0000-0000-000000000099/run-1",
        }),
      (err) =>
        err instanceof SymphonyLoopRequestValidationError &&
        err.message.includes("s3StateKey is malformed") &&
        err.message.includes("aaaaaaaa-0000-0000-0000-000000000099")
    );
  });

  test("rejects whitespace, empty, and non-prefix state keys instead of dropping them", () => {
    const loopId = "aaaaaaaa-0000-0000-0000-000000000024";
    const rejected = [
      `  org-1/loops/${loopId}/run-1`,
      `org-1/loops/${loopId}/run 1`,
      "   ",
      "",
      `org-1/${loopId}/run-1`,
      `org-1/loops/${loopId}`,
      `org-1/loops/${loopId}/${"x".repeat(900)}`,
    ];
    for (const s3StateKey of rejected) {
      assert.throws(
        () =>
          parseSymphonyLoopRequestBody({
            loopId,
            command: LoopCommand.Plan,
            closedLoopAuthToken: "token",
            artifacts: [],
            s3StateKey,
          }),
        (err) =>
          err instanceof SymphonyLoopRequestValidationError &&
          err.message.includes("s3StateKey is malformed"),
        `expected ${JSON.stringify(s3StateKey)} to be rejected at the boundary`
      );
    }
  });

  test("rejects a present state key that cannot be attributed to a loop", () => {
    assert.throws(
      () =>
        parseSymphonyLoopRequestBody({
          command: LoopCommand.Plan,
          closedLoopAuthToken: "token",
          artifacts: [],
          s3StateKey: "org-1/loops/some-loop/run-1",
        }),
      (err) =>
        err instanceof SymphonyLoopRequestValidationError &&
        err.message.includes("loopId is missing")
    );
  });
});
