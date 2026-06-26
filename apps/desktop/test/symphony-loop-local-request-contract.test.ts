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
});
