import {
  MEMBER_PACK_INSTALL_OPERATION_ID,
  MEMBER_PACK_INSTALL_PATH,
  MemberPackInstallDispatchReason,
  MemberPackInstallDispatchState,
} from "@repo/api/src/types/member-pack-install";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as memberInstallPOST } from "@/app/compute-targets/[id]/member-installs/route";
import { dispatchRelayCommandToRelay } from "@/app/compute-targets/relay-command-helpers";
import { computeTargetsService } from "@/app/compute-targets/service";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  CommandSigningRequirementStatus,
  resolveCommandSigningRequirement,
} from "@/lib/compute-target-signing-eligibility";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import {
  createMockRequest,
  createMockRouteContext,
  createTestAuthContext,
} from "../utils/auth-helpers";

let mockAuthContext: AuthContext;

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (handler: any) => (request: any, context: any) =>
    handler(mockAuthContext, request, context.params),
}));

vi.mock("@/app/compute-targets/service", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/app/compute-targets/service")>();
  return {
    ...original,
    computeTargetsService: {
      findOwnedById: vi.fn(),
      findAccessibleById: vi.fn(),
      findById: vi.fn(),
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
      markCommandExpired: vi.fn(),
    },
  };
});

vi.mock(
  "@/app/compute-targets/relay-command-helpers",
  async (importOriginal) => {
    const original =
      await importOriginal<
        typeof import("@/app/compute-targets/relay-command-helpers")
      >();
    return {
      ...original,
      dispatchRelayCommandToRelay: vi.fn(),
    };
  }
);

vi.mock("@/lib/compute-target-signing-eligibility", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("@/lib/compute-target-signing-eligibility")
    >();
  return {
    ...original,
    // The dispatcher derives its effective signing policy through the shared
    // resolver (FEA-4164). The resolver's own capability/eligibility/identity
    // derivation is covered in
    // lib/__tests__/compute-target-signing-eligibility.test.ts.
    resolveCommandSigningRequirement: vi.fn(),
  };
});

const OWNED_TARGET_ID = "01890000-0000-7000-8000-000000000001";
const OTHER_TARGET_ID = "01890000-0000-7000-8000-000000000002";
const PACK_ID = "gstack";
const HARNESS = "claude";

const TARGET_GATEWAY_ID = "gw-01890000-0000-7000-8000-000000000009";

function ownedTargetStub(
  id: string,
  overrides?: {
    supportedOperations?: string[];
    capabilities?: Record<string, unknown>;
  }
) {
  return {
    id,
    organizationId: mockAuthContext.user.organizationId,
    userId: mockAuthContext.user.id,
    // A concrete gatewayId so the signing-eligibility parity assertion can pin
    // the exact identity threaded into isComputeTargetSigningEligible.
    gatewayId: TARGET_GATEWAY_ID,
    machineName: "test-machine",
    platform: "darwin",
    capabilities: overrides?.capabilities ?? {},
    // A current desktop build advertises the pack-install route. Tests that
    // exercise the version-skew gate override this to omit it.
    supportedOperations: overrides?.supportedOperations ?? [
      MEMBER_PACK_INSTALL_OPERATION_ID,
    ],
    lastSeenAt: new Date(),
    isOnline: true,
    isSharedWithOrg: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;
}

async function invokeInstall(targetId: string, body: unknown) {
  const request = createMockRequest({
    url: `http://localhost:3002/compute-targets/${targetId}/member-installs`,
    method: "POST",
    body,
  });
  const context = createMockRouteContext({ id: targetId });
  const response = await memberInstallPOST(request, context);
  const json = await response.json();
  return { status: response.status, json };
}

function mockRelayResult(result: { delivered: boolean; reason?: string }) {
  vi.mocked(dispatchRelayCommandToRelay).mockResolvedValue(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthContext = createTestAuthContext();
  vi.mocked(desktopCommandStore.createCommand).mockResolvedValue({
    command: { commandId: "cmd-1", status: "queued" },
    deduped: false,
  } as any);
  // Default: signing is not required, so the unsigned server-initiated dispatch
  // proceeds. Signing-enforcement tests override this to Required/Unknown.
  vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
    status: CommandSigningRequirementStatus.NotRequired,
  });
});

describe("POST /compute-targets/:id/member-installs (FEA-4082)", () => {
  it("returns Pending (delivered != acked) with the command id when transport reaches a connected node", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID)
    );
    // Transport-only delivery: the socket emit reached a connected node, but the
    // node has NOT yet acked/ran the install. Honest state is Pending.
    mockRelayResult({ delivered: true });

    const { status, json } = await invokeInstall(OWNED_TARGET_ID, {
      packId: PACK_ID,
      harness: HARNESS,
    });

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.state).toBe(MemberPackInstallDispatchState.Pending);
    // Never a premature Dispatched from transport-only delivery.
    expect(json.data.state).not.toBe(MemberPackInstallDispatchState.Dispatched);
    expect(json.data.commandId).toBe("cmd-1");
    expect(json.data.packId).toBe(PACK_ID);
    expect(json.data.harness).toBe(HARNESS);
    // Delivered/Pending stays non-terminal: the node took the command and
    // durable resumeFromSequence replay is intended, so it is NOT expired.
    expect(desktopCommandStore.markCommandExpired).not.toHaveBeenCalled();
  });

  it("scopes the authorization lookup and dispatch to the requesting member + target", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID)
    );
    mockRelayResult({ delivered: true });

    await invokeInstall(OWNED_TARGET_ID, { packId: PACK_ID, harness: HARNESS });

    // Owner-only, org-scoped authorization gate.
    expect(computeTargetsService.findOwnedById).toHaveBeenCalledWith(
      OWNED_TARGET_ID,
      mockAuthContext.user.organizationId,
      mockAuthContext.user.id,
      mockAuthContext.user.clerkId
    );
    // The command was created against the member's target with the pack-install
    // gateway operation.
    const [targetArg, inputArg] = vi.mocked(desktopCommandStore.createCommand)
      .mock.calls[0];
    expect(targetArg).toBe(OWNED_TARGET_ID);
    expect(inputArg.operationId).toBe(MEMBER_PACK_INSTALL_OPERATION_ID);
    expect(inputArg.path).toBe(MEMBER_PACK_INSTALL_PATH);
    expect(inputArg.body).toEqual({ packId: PACK_ID, harness: HARNESS });
    // Relay delivery carried the member's target id and the pack-install op.
    expect(dispatchRelayCommandToRelay).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: OWNED_TARGET_ID,
        commandId: "cmd-1",
        relayOperation: expect.objectContaining({
          operationId: MEMBER_PACK_INSTALL_OPERATION_ID,
        }),
      })
    );
  });

  it("rejects dispatch to a node the member does not own (authz reject, no relay call)", async () => {
    // findOwnedById returns null for another member's node / org-shared node.
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(null);

    const { status, json } = await invokeInstall(OTHER_TARGET_ID, {
      packId: PACK_ID,
      harness: HARNESS,
    });

    expect(status).toBe(404);
    expect(json.success).toBe(false);
    expect(dispatchRelayCommandToRelay).not.toHaveBeenCalled();
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
  });

  it("surfaces a DEFINITIVE target-offline (in-process bus proved no subscriber) as terminal TargetOffline and expires the row", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID)
    );
    // `target_offline` comes only from the in-process relay bus, which returns
    // it when there is genuinely no subscriber — a definitive, terminalizable
    // offline (distinct from the relay's ambiguous `target_not_connected`).
    mockRelayResult({
      delivered: false,
      reason: MemberPackInstallDispatchReason.TargetOffline,
    });

    const { status, json } = await invokeInstall(OWNED_TARGET_ID, {
      packId: PACK_ID,
      harness: HARNESS,
    });

    expect(status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data.state).toBe(MemberPackInstallDispatchState.TargetOffline);
    // Honest: not reported as Dispatched/success.
    expect(json.data.state).not.toBe(MemberPackInstallDispatchState.Dispatched);
    // No replay storm: the created `queued` command is marked terminal so the
    // hello-ack replay does not re-emit and re-run it on reconnect.
    expect(desktopCommandStore.markCommandExpired).toHaveBeenCalledWith(
      "cmd-1",
      expect.stringContaining("member_pack_install_delivery_failed"),
      expect.objectContaining({ commandId: "cmd-1" })
    );
  });

  it("keeps the relay's AMBIGUOUS target_not_connected non-terminal as Pending (the relay collapses cross-instance peer timeouts into it, so it is NOT proof the node never got the command)", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID)
    );
    // The relay returns `target_not_connected` both for a genuinely absent
    // worker AND when a cross-instance peer proxy times out or returns a
    // non-JSON body after the peer may already have emitted. From the cloud's
    // vantage it is ambiguous, so it must NOT terminalize.
    mockRelayResult({
      delivered: false,
      reason: MemberPackInstallDispatchReason.TargetNotConnected,
    });

    const { status, json } = await invokeInstall(OWNED_TARGET_ID, {
      packId: PACK_ID,
      harness: HARNESS,
    });

    expect(status).toBe(200);
    expect(json.data.state).toBe(MemberPackInstallDispatchState.Pending);
    expect(json.data.state).not.toBe(
      MemberPackInstallDispatchState.TargetOffline
    );
    expect(json.data.reason).toBe(
      MemberPackInstallDispatchReason.TargetNotConnected
    );
    // Non-terminal: the queued command is left intact for reconnect replay.
    expect(desktopCommandStore.markCommandExpired).not.toHaveBeenCalled();
  });

  it("keeps an AMBIGUOUS relay failure (relay_dispatch_failed) non-terminal as Pending, NOT a terminal Failed the member could retry into a duplicate run", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID)
    );
    // `relay_dispatch_failed` is the cloud→relay `fetch` timeout/throw: by then
    // the relay may already have emitted the command and the node may be running
    // the install. Terminalizing here would (a) let the member retry a running
    // install and (b) drop the command from reconnect replay. It must stay a
    // non-terminal Pending, and the created command must NOT be expired.
    mockRelayResult({
      delivered: false,
      reason: MemberPackInstallDispatchReason.RelayDispatchFailed,
    });

    const { status, json } = await invokeInstall(OWNED_TARGET_ID, {
      packId: PACK_ID,
      harness: HARNESS,
    });

    expect(status).toBe(200);
    expect(json.data.state).toBe(MemberPackInstallDispatchState.Pending);
    expect(json.data.state).not.toBe(MemberPackInstallDispatchState.Failed);
    // The ambiguity reason is preserved so the UI can explain the unconfirmed
    // state instead of a bare spinner.
    expect(json.data.reason).toBe(
      MemberPackInstallDispatchReason.RelayDispatchFailed
    );
    // Non-terminal: the queued command is left intact so hello-ack reconnect
    // replay can still reconcile an install the node may have taken.
    expect(desktopCommandStore.markCommandExpired).not.toHaveBeenCalled();
  });

  it("degrades gracefully to a terminal Failed on a PROVEN not-emitted relay failure (wire conversion) and expires the row", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID)
    );
    // A relay-level failure that PROVES the command never reached the node
    // (wire conversion never left the API) is neither offline nor ambiguous, so
    // it must surface as a terminal Failed and expire the created command. This
    // reason is not in the wire-contract reason set, so it is dropped from the
    // response `reason` but still terminalizes.
    mockRelayResult({
      delivered: false,
      reason: "wire_conversion_failed",
    });

    const { status, json } = await invokeInstall(OWNED_TARGET_ID, {
      packId: PACK_ID,
      harness: HARNESS,
    });

    expect(status).toBe(200);
    expect(json.data.state).toBe(MemberPackInstallDispatchState.Failed);
    // `wire_conversion_failed` is not a wire-contract dispatch reason, so it is
    // dropped from the response `reason` (the contract does not widen to unknown
    // strings) — but the command is still terminalized with the raw cause.
    expect(json.data.reason).toBeUndefined();
    // Terminal-on-failure: the created command is expired so it is not replayed.
    expect(desktopCommandStore.markCommandExpired).toHaveBeenCalledWith(
      "cmd-1",
      expect.stringContaining("wire_conversion_failed"),
      expect.objectContaining({ commandId: "cmd-1" })
    );
  });

  it("returns Failed WITHOUT dispatching when the node does not advertise the pack-install route (version-skew)", async () => {
    // An older desktop build predating FEA-4082 omits member_pack_install from
    // supportedOperations; its gateway would answer 501. Detect it up front and
    // never push an operation the node cannot honor.
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID, { supportedOperations: [] })
    );

    const { status, json } = await invokeInstall(OWNED_TARGET_ID, {
      packId: PACK_ID,
      harness: HARNESS,
    });

    expect(status).toBe(200);
    expect(json.data.state).toBe(MemberPackInstallDispatchState.Failed);
    expect(json.data.reason).toBe(
      MemberPackInstallDispatchReason.OperationNotSupported
    );
    // No command was created, so there is no correlation key: commandId absent.
    expect(json.data.commandId).toBeUndefined();
    // Gated up front: no command row created, no relay dispatch attempted.
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
    expect(dispatchRelayCommandToRelay).not.toHaveBeenCalled();
  });

  it("returns Failed WITHOUT dispatching (and without a commandId) when signing is Required, threading the owner identity + gateway into the shared resolver", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID)
    );
    // Shared resolver says signing is required; the unsigned server dispatch
    // cannot authenticate, so fail closed.
    vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
      status: CommandSigningRequirementStatus.Required,
    });

    const { status, json } = await invokeInstall(OWNED_TARGET_ID, {
      packId: PACK_ID,
      harness: HARNESS,
    });

    expect(status).toBe(200);
    expect(json.data.state).toBe(MemberPackInstallDispatchState.Failed);
    expect(json.data.reason).toBe(
      MemberPackInstallDispatchReason.SigningRequired
    );
    expect(json.data.commandId).toBeUndefined();
    // The dispatcher derives its policy through the shared resolver, threading
    // the owner identity: requester === owner (findOwnedById is owner-only), so
    // requesterUserId === targetUserId and the owner clerk id is passed.
    expect(resolveCommandSigningRequirement).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: mockAuthContext.user.organizationId,
        targetUserId: mockAuthContext.user.id,
        requesterUserId: mockAuthContext.user.id,
        targetGatewayId: TARGET_GATEWAY_ID,
        requesterClerkUserId: mockAuthContext.user.clerkId,
        targetOwnerClerkUserId: mockAuthContext.user.clerkId,
      })
    );
    // Fail-closed up front: no unsigned command created or dispatched.
    expect(desktopCommandStore.createCommand).not.toHaveBeenCalled();
    expect(dispatchRelayCommandToRelay).not.toHaveBeenCalled();
  });

  it("fails closed to Failed when the shared resolver returns Unknown (cannot prove the install would be accepted, and has no browser signature to fall back on)", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID)
    );
    // Unlike the generic commands route (which proceeds unsigned on Unknown and
    // surfaces a warning), the member-pack dispatcher fails closed on Unknown.
    vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
      status: CommandSigningRequirementStatus.Unknown,
    });

    const { status, json } = await invokeInstall(OWNED_TARGET_ID, {
      packId: PACK_ID,
      harness: HARNESS,
    });

    expect(status).toBe(200);
    expect(json.data.state).toBe(MemberPackInstallDispatchState.Failed);
    expect(json.data.reason).toBe(
      MemberPackInstallDispatchReason.SigningRequired
    );
    expect(json.data.commandId).toBeUndefined();
    expect(dispatchRelayCommandToRelay).not.toHaveBeenCalled();
  });

  it("dispatches (Pending) when the shared resolver returns NotRequired (node advertises enforcement but the owner/org is not signing-eligible)", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID)
    );
    // The node is not actually verifying signatures, so an unsigned dispatch is
    // accepted.
    vi.mocked(resolveCommandSigningRequirement).mockResolvedValue({
      status: CommandSigningRequirementStatus.NotRequired,
    });
    mockRelayResult({ delivered: true });

    const { status, json } = await invokeInstall(OWNED_TARGET_ID, {
      packId: PACK_ID,
      harness: HARNESS,
    });

    expect(status).toBe(200);
    expect(json.data.state).toBe(MemberPackInstallDispatchState.Pending);
    expect(dispatchRelayCommandToRelay).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed body before any authorization or dispatch", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID)
    );

    const { status } = await invokeInstall(OWNED_TARGET_ID, { packId: "" });

    expect(status).toBe(400);
    expect(computeTargetsService.findOwnedById).not.toHaveBeenCalled();
    expect(dispatchRelayCommandToRelay).not.toHaveBeenCalled();
  });

  it("returns a 500 error envelope (no relay dispatch) when the command store throws", async () => {
    vi.mocked(computeTargetsService.findOwnedById).mockResolvedValue(
      ownedTargetStub(OWNED_TARGET_ID)
    );
    // An unexpected persistence failure while queuing the command must surface
    // as the declared error envelope, and must NOT reach the relay: an
    // un-persisted command has no correlation id for the node to ack against.
    vi.mocked(desktopCommandStore.createCommand).mockRejectedValue(
      new Error("db down")
    );

    const { status, json } = await invokeInstall(OWNED_TARGET_ID, {
      packId: PACK_ID,
      harness: HARNESS,
    });

    expect(status).toBe(500);
    expect(json.success).toBe(false);
    expect(dispatchRelayCommandToRelay).not.toHaveBeenCalled();
  });
});
