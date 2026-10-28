import { GitHubClerkLinkClientFailureStage } from "@repo/api/src/types/github";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const recordClerkLinkClientFailureMock = vi.fn();

const AUTH_ORGANIZATION_ID = "org-1";
const AUTH_USER_ID = "user-1";

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (
      handler: (
        context: { user: { id: string; organizationId: string } },
        request: Request
      ) => Promise<Response>
    ) =>
    (request: Request) =>
      handler(
        { user: { id: AUTH_USER_ID, organizationId: AUTH_ORGANIZATION_ID } },
        request
      ),
}));

vi.mock("@/app/integrations/github/clerk-link-service", () => ({
  recordClerkLinkClientFailure: recordClerkLinkClientFailureMock,
}));

const { POST } = await import("./route");

function request(body: unknown) {
  return new NextRequest(
    "http://localhost/integrations/github/clerk-link/client-failure",
    { body: JSON.stringify(body), method: "POST" }
  );
}

const EMPTY_CONTEXT = { params: Promise.resolve({}) };

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * ISS-11244. The browser is the only observer of a GitHub hand-off refusal, so
 * this route is the whole path from that observation to the monitored event. A
 * test that only checked the 200 would stay green against a handler that
 * recorded nothing, which is exactly the silence the ticket is about.
 */
describe("POST /integrations/github/clerk-link/client-failure", () => {
  it("records the reported Clerk code against the authenticated caller", async () => {
    const response = await POST(
      request({ clerkErrorCode: "external_account_exists" }),
      EMPTY_CONTEXT
    );

    expect(response.status).toBe(200);
    // The scope is the SERVER's idea of who called, never a body field: a
    // browser-supplied org id would let any caller attribute a failure to
    // another organization.
    expect(recordClerkLinkClientFailureMock).toHaveBeenCalledWith({
      apiErrorCode: undefined,
      apiErrorStatus: undefined,
      clerkErrorCode: "external_account_exists",
      organizationId: AUTH_ORGANIZATION_ID,
      stage: GitHubClerkLinkClientFailureStage.Threw,
      userId: AUTH_USER_ID,
    });
  });

  it("still records a report that carried no Clerk code", async () => {
    const response = await POST(request({}), EMPTY_CONTEXT);

    expect(response.status).toBe(200);
    // A browser shipped before `stage` existed posts exactly this, and it is
    // the `threw` case it used to be the only reporter of — so the default is
    // what keeps a version-skewed client's one observation out of silence.
    expect(recordClerkLinkClientFailureMock).toHaveBeenCalledWith({
      apiErrorCode: undefined,
      apiErrorStatus: undefined,
      clerkErrorCode: undefined,
      organizationId: AUTH_ORGANIZATION_ID,
      stage: GitHubClerkLinkClientFailureStage.Threw,
      userId: AUTH_USER_ID,
    });
  });

  /**
   * A version-skewed browser sending fields this server does not know must
   * degrade to the fields it does, not lose the report: `z.object()` strips
   * unknown keys. The org it names is ignored for the reason above.
   */
  it("strips unknown fields instead of refusing the report", async () => {
    const response = await POST(
      request({
        clerkErrorCode: "identification_deletion_failed",
        organizationId: "org-attacker",
        unknownFutureField: true,
      }),
      EMPTY_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(recordClerkLinkClientFailureMock).toHaveBeenCalledWith({
      apiErrorCode: undefined,
      apiErrorStatus: undefined,
      clerkErrorCode: "identification_deletion_failed",
      organizationId: AUTH_ORGANIZATION_ID,
      stage: GitHubClerkLinkClientFailureStage.Threw,
      userId: AUTH_USER_ID,
    });
  });

  /**
   * ISS-11244 on #7968: the sync leg throws `ApiError`, which has no `errors[]`
   * array — these two fields are the only thing that tells a client deadline
   * apart from an expired session or a refused POST once the record reaches the
   * monitor.
   */
  it("records the API status and code a sync-leg throw carried", async () => {
    const response = await POST(
      request({
        apiErrorCode: "client_request_timeout",
        apiErrorStatus: 0,
        stage: GitHubClerkLinkClientFailureStage.Threw,
      }),
      EMPTY_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(recordClerkLinkClientFailureMock).toHaveBeenCalledWith({
      apiErrorCode: "client_request_timeout",
      apiErrorStatus: 0,
      clerkErrorCode: undefined,
      organizationId: AUTH_ORGANIZATION_ID,
      stage: GitHubClerkLinkClientFailureStage.Threw,
      userId: AUTH_USER_ID,
    });
  });

  it("records a stage that carries no error code at all", async () => {
    const response = await POST(
      request({
        stage: GitHubClerkLinkClientFailureStage.ReauthorizeNoConsentUrl,
      }),
      EMPTY_CONTEXT
    );

    expect(response.status).toBe(200);
    expect(recordClerkLinkClientFailureMock).toHaveBeenCalledWith({
      apiErrorCode: undefined,
      apiErrorStatus: undefined,
      clerkErrorCode: undefined,
      organizationId: AUTH_ORGANIZATION_ID,
      stage: GitHubClerkLinkClientFailureStage.ReauthorizeNoConsentUrl,
      userId: AUTH_USER_ID,
    });
  });

  // A stage this server does not know is a browser ahead of it, and the report
  // is worth more than the label: `z.enum` refuses the unknown value, so this
  // pins that the refusal is visible rather than silently recorded as `threw`.
  it("refuses an unknown stage rather than mislabelling the record", async () => {
    const response = await POST(
      request({ stage: "a_stage_this_server_does_not_know" }),
      EMPTY_CONTEXT
    );

    expect(response.status).toBe(400);
    expect(recordClerkLinkClientFailureMock).not.toHaveBeenCalled();
  });

  it("refuses a malformed code rather than recording it", async () => {
    const response = await POST(request({ clerkErrorCode: "" }), EMPTY_CONTEXT);

    expect(response.status).toBe(400);
    expect(recordClerkLinkClientFailureMock).not.toHaveBeenCalled();
  });
});
