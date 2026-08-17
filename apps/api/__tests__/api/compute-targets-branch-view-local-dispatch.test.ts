import {
  BranchViewLocalErrorCode,
  BranchViewLocalGatewayPath,
  BranchViewLocalHeader,
} from "@repo/api/src/types/branch-view-local";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as commandsPOST } from "@/app/compute-targets/[id]/commands/route";
import { POST as dispatchPOST } from "@/app/compute-targets/[id]/operations/route";
import { computeTargetsService } from "@/app/compute-targets/service";
import { env } from "@/env";
import type { AuthContext } from "@/lib/auth/with-auth";
import { enforceRegisteredBrowserPublicKey } from "@/lib/browser-command-public-key-enforcement";
import {
  CommandSigningRequirementStatus,
  resolveCommandSigningRequirement,
} from "@/lib/compute-target-signing-eligibility";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { relayEventBus } from "@/lib/relay-event-bus";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

/**
 * ISS-5291: the DISPATCH half of the Branch View local-command authorization
 * boundary, driven through both real POST handlers.
 *
 * Both routes authorize a local-content command and then stamp the API-owned
 * proof onto the command they hand to the store. That stamp is a composition
 * neither `validateBranchViewLocalAccess` nor
 * `stampBranchViewLocalCommandMetadata` can defend on its own: delete the merge
 * from either route and every helper-level test stays green while the command
 * is persisted with no proof for `authorizeBranchViewLocalEventRead` to replay.
 * So the assertions here are on the STORED input, not on the response.
 */

let mockAuthContext: AuthContext;
const mockIsFeatureEnabled = vi.hoisted(() => vi.fn());

vi.mock("@repo/analytics/server", () => ({
  analytics: {
    isFeatureEnabled: mockIsFeatureEnabled,
  },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => async (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    ...original,
    computeTargetsService: {
      findAccessibleById: vi.fn(),
      findById: vi.fn(),
      findOwnedById: vi.fn(),
      markStaleTargetsOffline: vi.fn(),
      heartbeat: vi.fn(),
    },
  };
});

vi.mock("@/app/users/service", () => ({
  usersService: {
    findById: vi.fn().mockResolvedValue({
      id: "user-1",
      active: true,
      githubUsername: "octocat",
    }),
  },
}));

vi.mock("@/lib/resolve-pr-context", () => ({
  resolvePrContext: vi.fn().mockResolvedValue({
    owner: "acme",
    repo: "widget",
    pullNumber: 42,
    branch: { branchName: "feature" },
    gitHubPullRequest: { number: 42, headBranch: "feature" },
    externalLink: { createdBy: { githubUsername: "octocat" } },
  }),
}));

vi.mock("@/lib/relay-event-bus", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/relay-event-bus")>();
  return {
    ...original,
    relayEventBus: {
      ...original.relayEventBus,
      publishOperation: vi.fn(),
      publishResult: vi.fn(),
    },
  };
});

vi.mock("@/lib/desktop-command-store", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/desktop-command-store")>();
  return {
    ...original,
    desktopCommandStore: {
      ...original.desktopCommandStore,
      createCommand: vi.fn(),
      createFromRelayOperation: vi.fn(),
      markCommandExpired: vi.fn(),
    },
  };
});

vi.mock("@/lib/compute-target-signing-eligibility", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/compute-target-signing-eligibility")
    >();
  return {
    ...original,
    resolveCommandSigningRequirement: vi.fn(),
  };
});

vi.mock("@/lib/browser-command-public-key-enforcement", () => ({
  enforceRegisteredBrowserPublicKey: vi.fn(),
}));

const mockTarget = {
  id: "target-1",
  organizationId: "org-1",
  userId: "user-1",
  machineName: "machine-1",
  platform: "darwin",
  capabilities: {},
  supportedOperations: ["symphony_chat"],
  gatewayId: "gateway-1",
  lastSeenAt: new Date(),
  isOnline: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function branchViewLocalCommandBody() {
  return {
    operationId: "git_local_changes",
    method: "GET",
    path: BranchViewLocalGatewayPath.List,
    headers: {
      [BranchViewLocalHeader.ExternalLinkId]: "branch-link-1",
      [BranchViewLocalHeader.RepoFullName]: "acme/widget",
      [BranchViewLocalHeader.HeadBranch]: "feature",
      [BranchViewLocalHeader.PrNumber]: "42",
    },
    streaming: false,
  };
}

function branchViewLocalOperationBody() {
  return {
    operationId: "op-local",
    operation: "engineer_http_request",
    params: {
      request: {
        method: "GET",
        path: BranchViewLocalGatewayPath.List,
        headers: {
          [BranchViewLocalHeader.ExternalLinkId]: "branch-link-1",
          [BranchViewLocalHeader.RepoFullName]: "acme/widget",
          [BranchViewLocalHeader.HeadBranch]: "feature",
          [BranchViewLocalHeader.PrNumber]: "42",
        },
        body: { kind: "none" },
      },
    },
    streaming: false,
  };
}

/**
 * Headers a hostile caller supplies alongside an otherwise legitimate
 * local-content request: a marker claiming the command is already authorized,
 * and an authorized-user/org naming somebody else. The API-owned stamp must
 * overwrite all three while leaving unrelated caller headers intact.
 */
const SPOOFED_CALLER_PROOF_HEADERS = {
  "x-caller": "keep",
  [BranchViewLocalHeader.Operation]: "0",
  [BranchViewLocalHeader.AuthorizedUserId]: "user-attacker",
  [BranchViewLocalHeader.AuthorizedOrgId]: "org-attacker",
};

/**
 * The proof that must be present on the STORED command for the replay helpers
 * (`authorizeBranchViewLocalEventRead`, `isStoredBranchViewLocalCommand`) to
 * re-derive authorization from it later.
 */
const EXPECTED_STAMPED_HEADERS = {
  "x-caller": "keep",
  [BranchViewLocalHeader.Operation]: "1",
  [BranchViewLocalHeader.ExternalLinkId]: "branch-link-1",
  [BranchViewLocalHeader.RepoFullName]: "acme/widget",
  [BranchViewLocalHeader.HeadBranch]: "feature",
  [BranchViewLocalHeader.PrNumber]: "42",
  [BranchViewLocalHeader.AuthorizedUserId]: "user-1",
  [BranchViewLocalHeader.AuthorizedOrgId]: "org-1",
};

function mockCommandRelayDelivery(result: {
  deliveredToSubscriber: boolean;
  reason?: string;
}) {
  if (env.RELAY_API_URL) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            delivered: result.deliveredToSubscriber,
            ...(result.reason ? { reason: result.reason } : {}),
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }
        )
      )
    );
    return;
  }

  vi.mocked(relayEventBus.publishOperation).mockReturnValue(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.mocked(desktopCommandStore.createFromRelayOperation).mockResolvedValue({
    command: { commandId: "cmd-1" },
    deduped: false,
  } as any);
  vi.mocked(desktopCommandStore.createCommand).mockResolvedValue({
    command: { commandId: "cmd-1", status: "queued" },
    deduped: false,
  } as any);
  vi.mocked(enforceRegisteredBrowserPublicKey).mockResolvedValue(null);
  vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
    status: CommandSigningRequirementStatus.NotRequired,
  });
  vi.mocked(computeTargetsService.findById).mockResolvedValue({
    ...mockTarget,
    user: { clerkId: "clerk-user-1", firstName: "Owner", lastName: "User" },
  } as any);
  mockIsFeatureEnabled.mockResolvedValue(true);
  mockAuthContext = createTestAuthContext({
    user: { id: "user-1", organizationId: "org-1" } as any,
  });
});

describe("POST /compute-targets/:id/operations — Branch View local content", () => {
  it("rejects local-content operations before command creation when branch-pr is not explicitly enabled", async () => {
    mockIsFeatureEnabled.mockResolvedValue(false);
    vi.mocked(computeTargetsService.markStaleTargetsOffline).mockResolvedValue(
      0
    );
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      mockTarget as any
    );

    const response = await dispatchPOST(
      createMockRequest({
        method: "POST",
        body: branchViewLocalOperationBody(),
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: BranchViewLocalErrorCode.FeatureDisabled,
      code: BranchViewLocalErrorCode.FeatureDisabled,
    });
    expect(desktopCommandStore.createFromRelayOperation).not.toHaveBeenCalled();
    expect(relayEventBus.publishOperation).not.toHaveBeenCalled();
  });

  it("stores the API-owned proof on a successfully dispatched local-content operation", async () => {
    vi.mocked(computeTargetsService.markStaleTargetsOffline).mockResolvedValue(
      0
    );
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      mockTarget as any
    );
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(
      mockTarget as any
    );
    mockCommandRelayDelivery({ deliveredToSubscriber: true });

    const operationBody = branchViewLocalOperationBody();
    const response = await dispatchPOST(
      createMockRequest({
        method: "POST",
        body: {
          ...operationBody,
          params: {
            ...operationBody.params,
            request: {
              ...operationBody.params.request,
              headers: {
                ...operationBody.params.request.headers,
                ...SPOOFED_CALLER_PROOF_HEADERS,
              },
            },
          },
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    expect(desktopCommandStore.createFromRelayOperation).toHaveBeenCalledWith(
      "target-1",
      expect.objectContaining({
        params: expect.objectContaining({
          request: expect.objectContaining({
            path: BranchViewLocalGatewayPath.List,
            headers: EXPECTED_STAMPED_HEADERS,
          }),
        }),
      })
    );
  });
});

describe("POST /compute-targets/:id/commands — Branch View local content", () => {
  it.each([
    ["disabled", async () => false],
    ["missing", async () => undefined],
    ["unresolved", async () => null],
    [
      "thrown",
      () => {
        throw new Error("flag unavailable");
      },
    ],
  ])("rejects local-content command creation when branch-pr is %s", async (_label, flagImpl) => {
    mockIsFeatureEnabled.mockImplementation(flagImpl);
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(
      mockTarget as any
    );

    const response = await commandsPOST(
      createMockRequest({
        method: "POST",
        body: branchViewLocalCommandBody(),
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: BranchViewLocalErrorCode.FeatureDisabled,
      code: BranchViewLocalErrorCode.FeatureDisabled,
    });
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
    expect(relayEventBus.publishOperation).not.toHaveBeenCalled();
  });

  it("stores the API-owned proof on a successfully dispatched local-content command", async () => {
    vi.mocked(computeTargetsService.findAccessibleById).mockResolvedValue(
      mockTarget as any
    );
    mockCommandRelayDelivery({ deliveredToSubscriber: true });

    const response = await commandsPOST(
      createMockRequest({
        method: "POST",
        body: {
          ...branchViewLocalCommandBody(),
          headers: {
            ...branchViewLocalCommandBody().headers,
            ...SPOOFED_CALLER_PROOF_HEADERS,
          },
        },
      }),
      createMockRouteContext({ id: "target-1" })
    );

    expect(response.status).toBe(200);
    // `createCommand` persists this object as `requestPayload`, so what is
    // pinned here is exactly what the replay helpers read back out of the row.
    expect(desktopCommandStore.createCommand).toHaveBeenCalledWith(
      "target-1",
      expect.objectContaining({
        path: BranchViewLocalGatewayPath.List,
        headers: EXPECTED_STAMPED_HEADERS,
      }),
      expect.anything()
    );
  });
});
