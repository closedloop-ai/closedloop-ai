import {
  BranchViewLocalErrorCode,
  BranchViewLocalGatewayPath,
  BranchViewLocalHeader,
  BranchViewLocalOperationId,
} from "@repo/api/src/types/branch-view-local";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  analytics: { isFeatureEnabled: vi.fn() },
  computeTargetsService: { findAccessibleById: vi.fn() },
  desktopCommandFindUnique: vi.fn(),
  resolvePrContext: vi.fn(),
  usersService: { findById: vi.fn() },
}));

vi.mock("server-only", () => ({}));

vi.mock("@repo/analytics/server", () => ({
  analytics: mocks.analytics,
}));

vi.mock("@repo/database", () => ({
  withDb: (fn: (db: unknown) => unknown) =>
    fn({ desktopCommand: { findUnique: mocks.desktopCommandFindUnique } }),
}));

vi.mock("@/app/compute-targets/service", () => ({
  computeTargetsService: mocks.computeTargetsService,
}));

vi.mock("@/app/users/service", () => ({
  usersService: mocks.usersService,
}));

vi.mock("@/lib/resolve-pr-context", () => ({
  resolvePrContext: mocks.resolvePrContext,
}));

import {
  authorizeBranchViewLocalEventRead,
  classifyBranchViewLocalCommand,
  isStoredBranchViewLocalCommand,
  stampBranchViewLocalCommandMetadata,
  validateBranchViewLocalAccess,
} from "@/lib/branch-view-local-authorization";

describe("validateBranchViewLocalAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.analytics.isFeatureEnabled.mockResolvedValue(true);
    mocks.usersService.findById.mockResolvedValue({
      id: "user-1",
      active: true,
      githubUsername: "octocat",
    });
  });

  it("returns StaleProof without metadata or compute-target lookup when default resolver fails", async () => {
    mocks.resolvePrContext.mockResolvedValueOnce(null);

    const result = await validateBranchViewLocalAccess({
      userId: "user-1",
      organizationId: "org-1",
      computeTargetId: "target-1",
      externalLinkId: "branch-artifact-1",
      repoFullName: "acme/repo",
      headBranch: "feature/stale",
      prNumber: 42,
      operationPath: BranchViewLocalGatewayPath.CommitPush,
    });

    expect(result).toEqual({
      ok: false,
      status: 403,
      code: BranchViewLocalErrorCode.StaleProof,
      error: BranchViewLocalErrorCode.StaleProof,
    });
    expect(mocks.resolvePrContext).toHaveBeenCalledWith(
      "branch-artifact-1",
      "org-1"
    );
    expect(
      mocks.computeTargetsService.findAccessibleById
    ).not.toHaveBeenCalled();
    expect("metadataHeaders" in result).toBe(false);
  });
});

/**
 * ISS-5291: the rest of the Branch View local-command authorization boundary.
 *
 * Every `deny` here is a distinct security outcome, and the module's whole job is
 * to keep them distinct — a caller who is merely not the PR author must not be
 * treated the same as one whose feature flag is off, and neither may reach the
 * Desktop gateway. The cases below drive each denial through the real predicate
 * rather than asserting the shape of `deny` itself, so a reordered or widened
 * guard fails here instead of in production.
 *
 * `authorizeBranchViewLocalEventRead` is the replay half of that boundary and was
 * previously unreached by any test: it re-checks a *stored* proof on a command
 * that was authorized earlier, which is the one path where a stale or forged
 * header set could grant access to a request nobody re-validated.
 */

const AUTHORIZED_USER_ID = "user-1";
const AUTHORIZED_ORG_ID = "org-1";
const COMPUTE_TARGET_ID = "target-1";
const EXTERNAL_LINK_ID = "branch-artifact-1";
const COMMAND_ID = "command-1";

/** A PR context whose identity matches {@link validInput} exactly. */
function matchingPrContext() {
  return {
    externalLink: { createdBy: { githubUsername: "octocat" } },
    owner: "acme",
    repo: "repo",
    pullNumber: 42,
    gitHubPullRequest: { number: 42, headBranch: "feature/local" },
    branch: { branchName: "feature/local" },
  };
}

function validInput() {
  return {
    userId: AUTHORIZED_USER_ID,
    organizationId: AUTHORIZED_ORG_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    externalLinkId: EXTERNAL_LINK_ID,
    repoFullName: "acme/repo",
    headBranch: "feature/local",
    prNumber: 42,
    operationPath: BranchViewLocalGatewayPath.CommitPush,
  };
}

/** The header set a successful `validateBranchViewLocalAccess` stamps. */
function storedProofHeaders(over: Record<string, string> = {}) {
  return {
    [BranchViewLocalHeader.Operation]: "1",
    [BranchViewLocalHeader.ExternalLinkId]: EXTERNAL_LINK_ID,
    [BranchViewLocalHeader.RepoFullName]: "acme/repo",
    [BranchViewLocalHeader.HeadBranch]: "feature/local",
    [BranchViewLocalHeader.PrNumber]: "42",
    [BranchViewLocalHeader.AuthorizedUserId]: AUTHORIZED_USER_ID,
    [BranchViewLocalHeader.AuthorizedOrgId]: AUTHORIZED_ORG_ID,
    ...over,
  };
}

function happyPathMocks() {
  mocks.analytics.isFeatureEnabled.mockResolvedValue(true);
  mocks.usersService.findById.mockResolvedValue({
    id: AUTHORIZED_USER_ID,
    active: true,
    githubUsername: "octocat",
  });
  mocks.resolvePrContext.mockResolvedValue(matchingPrContext());
  mocks.computeTargetsService.findAccessibleById.mockResolvedValue({
    id: COMPUTE_TARGET_ID,
    isOnline: true,
  });
}

describe("validateBranchViewLocalAccess — the denial ladder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPathMocks();
  });

  it("authorizes a matching author, context, and online target", async () => {
    const result = await validateBranchViewLocalAccess(validInput());

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected authorization to succeed");
    }
    // The metadata is the proof a later event-read replays, so its exact
    // contents are the contract — not an implementation detail.
    expect(result.metadataHeaders).toEqual(storedProofHeaders());
  });

  it("denies an unrecognized operation path before touching any service", async () => {
    const result = await validateBranchViewLocalAccess({
      ...validInput(),
      operationPath: "/api/gateway/git/something-else",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: BranchViewLocalErrorCode.AuthorizationRequired,
    });
    // Ordering matters: an unknown path must not cost a user lookup, and must
    // not disclose whether the user or the branch exists.
    expect(mocks.usersService.findById).not.toHaveBeenCalled();
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
  });

  it("denies a deactivated user", async () => {
    mocks.usersService.findById.mockResolvedValue({
      id: AUTHORIZED_USER_ID,
      active: false,
      githubUsername: "octocat",
    });

    const result = await validateBranchViewLocalAccess(validInput());

    expect(result).toMatchObject({
      code: BranchViewLocalErrorCode.AuthorizationRequired,
    });
  });

  it("denies when the feature flag is off, and does not resolve the branch", async () => {
    mocks.analytics.isFeatureEnabled.mockResolvedValue(false);

    const result = await validateBranchViewLocalAccess(validInput());

    expect(result).toMatchObject({
      status: 403,
      code: BranchViewLocalErrorCode.FeatureDisabled,
    });
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
  });

  it("denies when the flag lookup throws rather than failing open", async () => {
    mocks.analytics.isFeatureEnabled.mockRejectedValue(
      new Error("posthog down")
    );

    const result = await validateBranchViewLocalAccess(validInput());

    // A gate that spawns local processes must fail CLOSED when it cannot read
    // its own flag. This is the branch that would silently invert if the catch
    // were ever changed to return the previous value.
    expect(result).toMatchObject({
      code: BranchViewLocalErrorCode.FeatureDisabled,
    });
  });

  it.each([
    ["the PR has no recorded author", { createdBy: { githubUsername: null } }],
    ["the branch has no creator at all", { createdBy: null }],
  ])("denies NotAuthor when %s", async (_label, externalLink) => {
    mocks.resolvePrContext.mockResolvedValue({
      ...matchingPrContext(),
      externalLink,
    });

    const result = await validateBranchViewLocalAccess(validInput());

    expect(result).toMatchObject({
      code: BranchViewLocalErrorCode.NotAuthor,
    });
  });

  it("denies NotAuthor when the caller has no GitHub identity to compare", async () => {
    mocks.usersService.findById.mockResolvedValue({
      id: AUTHORIZED_USER_ID,
      active: true,
      githubUsername: null,
    });

    const result = await validateBranchViewLocalAccess(validInput());

    // An absent identity must never compare equal to an absent author.
    expect(result).toMatchObject({
      code: BranchViewLocalErrorCode.NotAuthor,
    });
  });

  it("matches the author case-insensitively", async () => {
    mocks.usersService.findById.mockResolvedValue({
      id: AUTHORIZED_USER_ID,
      active: true,
      githubUsername: "OctoCat",
    });

    const result = await validateBranchViewLocalAccess(validInput());

    // GitHub logins are case-insensitive, so a casing difference is the same
    // human — denying here would lock authors out of their own branches.
    expect(result.ok).toBe(true);
  });

  it.each([
    ["repository", { repoFullName: "acme/other-repo" }],
    ["head branch", { headBranch: "feature/somewhere-else" }],
    ["PR number", { prNumber: 43 }],
  ])("denies ContextMismatch when the %s disagrees with the resolved PR", async (_label, override) => {
    const result = await validateBranchViewLocalAccess({
      ...validInput(),
      ...override,
    });

    expect(result).toMatchObject({
      code: BranchViewLocalErrorCode.ContextMismatch,
    });
    // A mismatched proof must not reach the compute target.
    expect(
      mocks.computeTargetsService.findAccessibleById
    ).not.toHaveBeenCalled();
  });

  it("compares the repository case- and whitespace-insensitively", async () => {
    const result = await validateBranchViewLocalAccess({
      ...validInput(),
      repoFullName: "  ACME/Repo  ",
    });

    expect(result.ok).toBe(true);
  });

  it("falls back to the PR head branch when the branch row has no name", async () => {
    mocks.resolvePrContext.mockResolvedValue({
      ...matchingPrContext(),
      branch: null,
    });

    const result = await validateBranchViewLocalAccess(validInput());

    // A repo-less/desktop-produced branch has no BranchDetail name, so the PR's
    // own head branch is the only identity available — and it is authoritative.
    expect(result.ok).toBe(true);
  });

  it("falls back to the context pull number when no GitHub PR is attached", async () => {
    mocks.resolvePrContext.mockResolvedValue({
      ...matchingPrContext(),
      gitHubPullRequest: null,
    });

    const result = await validateBranchViewLocalAccess(validInput());

    expect(result.ok).toBe(true);
  });

  it("denies ComputeTargetForbidden for a target the caller cannot reach", async () => {
    mocks.computeTargetsService.findAccessibleById.mockResolvedValue(null);

    const result = await validateBranchViewLocalAccess(validInput());

    expect(result).toMatchObject({
      status: 403,
      code: BranchViewLocalErrorCode.ComputeTargetForbidden,
    });
  });

  it("denies ComputeTargetOffline with 503, not 403", async () => {
    mocks.computeTargetsService.findAccessibleById.mockResolvedValue({
      id: COMPUTE_TARGET_ID,
      isOnline: false,
    });

    const result = await validateBranchViewLocalAccess(validInput());

    // Offline is a retryable availability fact, not an authorization verdict.
    // Collapsing it to 403 would tell an author they lack permission to their
    // own machine because it happens to be asleep.
    expect(result).toMatchObject({
      status: 503,
      code: BranchViewLocalErrorCode.ComputeTargetOffline,
    });
  });
});

describe("authorizeBranchViewLocalEventRead — replaying a stored proof", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    happyPathMocks();
  });

  it("returns 404 for a command that does not exist", async () => {
    mocks.desktopCommandFindUnique.mockResolvedValue(null);

    const result = await authorizeBranchViewLocalEventRead({
      commandId: COMMAND_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      userId: AUTHORIZED_USER_ID,
      organizationId: AUTHORIZED_ORG_ID,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 404,
      code: BranchViewLocalErrorCode.AuthorizationRequired,
    });
  });

  it("denies a command belonging to a different compute target", async () => {
    mocks.desktopCommandFindUnique.mockResolvedValue({
      computeTargetId: "target-other",
      operationId: BranchViewLocalOperationId.CommitPush,
      requestPayload: { headers: storedProofHeaders() },
    });

    const result = await authorizeBranchViewLocalEventRead({
      commandId: COMMAND_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      userId: AUTHORIZED_USER_ID,
      organizationId: AUTHORIZED_ORG_ID,
    });

    expect(result).toMatchObject({
      code: BranchViewLocalErrorCode.ContextMismatch,
    });
  });

  it("passes through a command that is not a Branch View local operation", async () => {
    mocks.desktopCommandFindUnique.mockResolvedValue({
      computeTargetId: COMPUTE_TARGET_ID,
      operationId: "symphony_chat",
      requestPayload: { headers: { "x-unrelated": "1" } },
    });

    const result = await authorizeBranchViewLocalEventRead({
      commandId: COMMAND_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      userId: AUTHORIZED_USER_ID,
      organizationId: AUTHORIZED_ORG_ID,
    });

    // This gate only governs Branch View local commands; an ordinary command
    // must not acquire an author requirement it never had. It also must not
    // re-run the expensive validation.
    expect(result).toEqual({ ok: true, metadataHeaders: {} });
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the authorized user is a different person",
      { [BranchViewLocalHeader.AuthorizedUserId]: "user-someone-else" },
    ],
    [
      "the authorized org is a different tenant",
      { [BranchViewLocalHeader.AuthorizedOrgId]: "org-someone-else" },
    ],
    [
      "the external link id is missing",
      { [BranchViewLocalHeader.ExternalLinkId]: "" },
    ],
    ["the repository is missing", { [BranchViewLocalHeader.RepoFullName]: "" }],
    ["the head branch is missing", { [BranchViewLocalHeader.HeadBranch]: "" }],
    [
      "the PR number is not a number",
      { [BranchViewLocalHeader.PrNumber]: "not-a-number" },
    ],
  ])("denies StaleProof when %s", async (_label, override) => {
    mocks.desktopCommandFindUnique.mockResolvedValue({
      computeTargetId: COMPUTE_TARGET_ID,
      operationId: BranchViewLocalOperationId.CommitPush,
      requestPayload: {
        headers: storedProofHeaders(override),
        path: BranchViewLocalGatewayPath.CommitPush,
      },
    });

    const result = await authorizeBranchViewLocalEventRead({
      commandId: COMMAND_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      userId: AUTHORIZED_USER_ID,
      organizationId: AUTHORIZED_ORG_ID,
    });

    expect(result).toMatchObject({
      code: BranchViewLocalErrorCode.StaleProof,
    });
    // The stored proof is rejected on its own terms; nothing downstream runs.
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
  });

  it("re-validates a well-formed stored proof against live state", async () => {
    mocks.desktopCommandFindUnique.mockResolvedValue({
      computeTargetId: COMPUTE_TARGET_ID,
      operationId: BranchViewLocalOperationId.CommitPush,
      requestPayload: {
        headers: storedProofHeaders(),
        path: BranchViewLocalGatewayPath.CommitPush,
      },
    });

    const result = await authorizeBranchViewLocalEventRead({
      commandId: COMMAND_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      userId: AUTHORIZED_USER_ID,
      organizationId: AUTHORIZED_ORG_ID,
    });

    expect(result.ok).toBe(true);
    // The point of the replay: authorization is re-derived from CURRENT state,
    // so authorship revoked after the command was stored still denies the read.
    expect(mocks.resolvePrContext).toHaveBeenCalledWith(
      EXTERNAL_LINK_ID,
      AUTHORIZED_ORG_ID
    );
  });

  it("denies on replay once the caller is no longer the author", async () => {
    mocks.desktopCommandFindUnique.mockResolvedValue({
      computeTargetId: COMPUTE_TARGET_ID,
      operationId: BranchViewLocalOperationId.CommitPush,
      requestPayload: {
        headers: storedProofHeaders(),
        path: BranchViewLocalGatewayPath.CommitPush,
      },
    });
    mocks.resolvePrContext.mockResolvedValue({
      ...matchingPrContext(),
      externalLink: { createdBy: { githubUsername: "someone-else" } },
    });

    const result = await authorizeBranchViewLocalEventRead({
      commandId: COMMAND_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      userId: AUTHORIZED_USER_ID,
      organizationId: AUTHORIZED_ORG_ID,
    });

    // A stored proof is evidence of a past decision, never a substitute for the
    // current one.
    expect(result).toMatchObject({
      code: BranchViewLocalErrorCode.NotAuthor,
    });
  });

  it.each([
    ["the payload is not an object", "not-an-object"],
    ["the headers are absent", { path: "/x" }],
    ["the headers are not an object", { headers: "nope" }],
  ])("treats a command whose %s as a non-Branch-View command", async (_label, requestPayload) => {
    mocks.desktopCommandFindUnique.mockResolvedValue({
      computeTargetId: COMPUTE_TARGET_ID,
      operationId: "symphony_chat",
      requestPayload,
    });

    const result = await authorizeBranchViewLocalEventRead({
      commandId: COMMAND_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      userId: AUTHORIZED_USER_ID,
      organizationId: AUTHORIZED_ORG_ID,
    });

    // `requestPayload` is a Json column, so a row written by an older build can
    // hold any shape. Unreadable must degrade to "not one of ours", never to an
    // authorization grant derived from a half-parsed proof.
    expect(result).toEqual({ ok: true, metadataHeaders: {} });
  });

  it("ignores non-string header values rather than coercing them", async () => {
    mocks.desktopCommandFindUnique.mockResolvedValue({
      computeTargetId: COMPUTE_TARGET_ID,
      operationId: BranchViewLocalOperationId.CommitPush,
      requestPayload: {
        headers: {
          ...storedProofHeaders(),
          [BranchViewLocalHeader.PrNumber]: 42,
        },
        path: BranchViewLocalGatewayPath.CommitPush,
      },
    });

    const result = await authorizeBranchViewLocalEventRead({
      commandId: COMMAND_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      userId: AUTHORIZED_USER_ID,
      organizationId: AUTHORIZED_ORG_ID,
    });

    // A numeric 42 is dropped by the string filter, so the proof is incomplete
    // and must be refused — not silently accepted via `Number(undefined)`.
    expect(result).toMatchObject({
      code: BranchViewLocalErrorCode.StaleProof,
    });
  });

  /**
   * The stored command's OWN identity — its operation id and its gateway path —
   * decides whether this gate applies. Deciding that from the API-owned marker
   * header instead fails open: a local-changes command whose marker was never
   * stamped, was stamped by an older build, or arrived corrupt would classify as
   * an ordinary command and skip the author check entirely.
   */
  it.each([
    [
      "a local-changes path with no proof headers at all",
      {
        operationId: "engineer_http_request",
        requestPayload: { path: BranchViewLocalGatewayPath.List },
      },
    ],
    [
      "a Branch View operation id with no proof headers at all",
      {
        operationId: BranchViewLocalOperationId.Read,
        requestPayload: { path: "/api/gateway/git/status" },
      },
    ],
    [
      "a local-changes path whose marker is switched off",
      {
        operationId: "engineer_http_request",
        requestPayload: {
          path: BranchViewLocalGatewayPath.CommitPush,
          headers: storedProofHeaders({
            [BranchViewLocalHeader.Operation]: "0",
          }),
        },
      },
    ],
    [
      "a local-changes path whose marker is not a string",
      {
        operationId: "engineer_http_request",
        requestPayload: {
          path: BranchViewLocalGatewayPath.CommitPush,
          headers: {
            ...storedProofHeaders(),
            [BranchViewLocalHeader.Operation]: 1,
          },
        },
      },
    ],
    [
      "a commit-push operation id pointing at an unrecognized path",
      {
        operationId: BranchViewLocalOperationId.CommitPush,
        requestPayload: {
          path: "/api/gateway/git/status",
          headers: storedProofHeaders(),
        },
      },
    ],
  ])("denies StaleProof for %s", async (_label, stored) => {
    mocks.desktopCommandFindUnique.mockResolvedValue({
      computeTargetId: COMPUTE_TARGET_ID,
      ...stored,
    });

    const result = await authorizeBranchViewLocalEventRead({
      commandId: COMMAND_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      userId: AUTHORIZED_USER_ID,
      organizationId: AUTHORIZED_ORG_ID,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      code: BranchViewLocalErrorCode.StaleProof,
    });
    expect("metadataHeaders" in result).toBe(false);
  });

  it("still passes through an ordinary command that carries neither identity", async () => {
    mocks.desktopCommandFindUnique.mockResolvedValue({
      computeTargetId: COMPUTE_TARGET_ID,
      operationId: "symphony_chat",
      requestPayload: {
        path: "/api/gateway/symphony/chat/run-1",
        headers: { "x-unrelated": "1" },
      },
    });

    const result = await authorizeBranchViewLocalEventRead({
      commandId: COMMAND_ID,
      computeTargetId: COMPUTE_TARGET_ID,
      userId: AUTHORIZED_USER_ID,
      organizationId: AUTHORIZED_ORG_ID,
    });

    // The control for the cases above: closing the fail-open must not hand an
    // author requirement to every unrelated command on the same target.
    expect(result).toEqual({ ok: true, metadataHeaders: {} });
    expect(mocks.resolvePrContext).not.toHaveBeenCalled();
  });

  it("classifies a stored path that is not a parseable URL without throwing", async () => {
    mocks.desktopCommandFindUnique.mockResolvedValue({
      computeTargetId: COMPUTE_TARGET_ID,
      operationId: "symphony_chat",
      requestPayload: { path: "http://[zz]/x" },
    });

    // Classifying now reads `requestPayload.path`, an arbitrary string from a
    // Json column. An unparseable one must resolve to "not one of ours", not
    // throw out of the authorization check and 500 the event read.
    await expect(
      authorizeBranchViewLocalEventRead({
        commandId: COMMAND_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        userId: AUTHORIZED_USER_ID,
        organizationId: AUTHORIZED_ORG_ID,
      })
    ).resolves.toEqual({ ok: true, metadataHeaders: {} });
  });
});

describe("isStoredBranchViewLocalCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [
      "the API-owned marker is present",
      {
        computeTargetId: COMPUTE_TARGET_ID,
        operationId: "engineer_http_request",
        requestPayload: { headers: storedProofHeaders() },
      },
    ],
    // The internal event-read block is the other half of the fail-open: a known
    // Branch View command that reports false here has its raw event log served
    // by the internal route, bypassing the public author-checked route entirely.
    [
      "only the stored gateway path identifies it",
      {
        computeTargetId: COMPUTE_TARGET_ID,
        operationId: "engineer_http_request",
        requestPayload: { path: BranchViewLocalGatewayPath.Diff },
      },
    ],
    [
      "only the stored operation id identifies it",
      {
        computeTargetId: COMPUTE_TARGET_ID,
        operationId: BranchViewLocalOperationId.CommitPush,
        requestPayload: { path: "/api/gateway/git/status" },
      },
    ],
    [
      "the marker is corrupt but the path still identifies it",
      {
        computeTargetId: COMPUTE_TARGET_ID,
        operationId: "engineer_http_request",
        requestPayload: {
          path: BranchViewLocalGatewayPath.List,
          headers: storedProofHeaders({
            [BranchViewLocalHeader.Operation]: "0",
          }),
        },
      },
    ],
  ])("reports true when %s", async (_label, command) => {
    mocks.desktopCommandFindUnique.mockResolvedValue(command);

    await expect(
      isStoredBranchViewLocalCommand({
        commandId: COMMAND_ID,
        computeTargetId: COMPUTE_TARGET_ID,
      })
    ).resolves.toBe(true);
  });

  it.each([
    ["the command is missing", null],
    [
      "the command belongs to another target",
      {
        computeTargetId: "target-other",
        operationId: "engineer_http_request",
        requestPayload: { headers: storedProofHeaders() },
      },
    ],
    [
      "nothing about the command identifies it as Branch View local",
      {
        computeTargetId: COMPUTE_TARGET_ID,
        operationId: "symphony_chat",
        requestPayload: {
          path: "/api/gateway/symphony/chat/run-1",
          headers: { "x-unrelated": "1" },
        },
      },
    ],
    [
      "the payload is not an object",
      {
        computeTargetId: COMPUTE_TARGET_ID,
        operationId: "symphony_chat",
        requestPayload: 7,
      },
    ],
  ])("reports false when %s", async (_label, command) => {
    mocks.desktopCommandFindUnique.mockResolvedValue(command);

    await expect(
      isStoredBranchViewLocalCommand({
        commandId: COMMAND_ID,
        computeTargetId: COMPUTE_TARGET_ID,
      })
    ).resolves.toBe(false);
  });
});

describe("classifyBranchViewLocalCommand", () => {
  it.each([
    BranchViewLocalGatewayPath.List,
    BranchViewLocalGatewayPath.Diff,
    BranchViewLocalGatewayPath.CommitPush,
  ])("classifies the direct command path %s", (path) => {
    expect(classifyBranchViewLocalCommand({ path } as never)).toBe(true);
  });

  it("does not classify an unrelated gateway path", () => {
    expect(
      classifyBranchViewLocalCommand({
        path: "/api/gateway/git/status",
      } as never)
    ).toBe(false);
  });

  it("reads the nested path out of a relay dispatch request", () => {
    expect(
      classifyBranchViewLocalCommand({
        params: {
          request: { path: BranchViewLocalGatewayPath.CommitPush },
        },
      } as never)
    ).toBe(true);
  });

  it.each([
    ["params are absent", {}],
    ["params are not an object", { params: "nope" }],
    ["the request is not an object", { params: { request: 5 } }],
    ["the nested path is not a string", { params: { request: { path: 5 } } }],
  ])("does not classify a relay dispatch whose %s", (_label, input) => {
    // A relay payload crosses a process boundary, so every level of this reach
    // is genuinely reachable as a non-object at runtime. Misclassifying one as
    // a Branch View command would apply the author gate to an unrelated
    // operation — or, worse, skip it for one that needs it.
    expect(classifyBranchViewLocalCommand(input as never)).toBe(false);
  });
});

describe("stampBranchViewLocalCommandMetadata", () => {
  it("merges proof headers over the caller's own without dropping them", () => {
    const stamped = stampBranchViewLocalCommandMetadata(
      {
        path: BranchViewLocalGatewayPath.CommitPush,
        headers: { "x-caller": "keep", [BranchViewLocalHeader.Operation]: "0" },
      } as never,
      storedProofHeaders()
    );

    expect(stamped.headers).toMatchObject({
      "x-caller": "keep",
      // API-owned proof wins over anything the caller supplied — this is the
      // spread order that stops a client from stamping its own authorization.
      [BranchViewLocalHeader.Operation]: "1",
      [BranchViewLocalHeader.AuthorizedUserId]: AUTHORIZED_USER_ID,
    });
  });

  it("stamps onto a command that carries no headers at all", () => {
    const stamped = stampBranchViewLocalCommandMetadata(
      { path: BranchViewLocalGatewayPath.List } as never,
      storedProofHeaders()
    );

    expect(stamped.headers).toEqual(storedProofHeaders());
  });
});
