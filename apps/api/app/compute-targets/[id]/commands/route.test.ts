import {
  DesktopCommandStatus,
  UPDATE_AND_RESTART_OPERATION_ID,
} from "@repo/api/src/types/compute-target";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-7561: the 409 contract of `POST /compute-targets/:id/commands`.
 *
 * `handleCreateCommandError` maps a conflict to 409 by error-class NAME alone,
 * and nothing asserted that mapping — a raw Prisma P2002 reaching the catch
 * turns the documented 409 into a 500 with no test going red. The store-side
 * half (that a duplicate raises the conflict class rather than a bare P2002)
 * is `lib/desktop-command-store.test.ts`; this file owns the other half, that
 * the route answers 409 for the class and does NOT answer 409 for anything
 * else.
 */

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1", clerkId: "clerk-user-1" },
  },
  findAccessibleById: vi.fn(),
  findById: vi.fn(),
  resolveCommandSigningRequirement: vi.fn(),
  dispatchRelayCommandToRelay: vi.fn(),
  toRelayOperation: vi.fn(),
  isFeatureEnabled: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest, context: unknown) =>
      handler(mocks.auth, request, context),
}));

vi.mock("../../service", () => ({
  computeTargetsService: {
    findAccessibleById: mocks.findAccessibleById,
    findById: mocks.findById,
  },
}));

vi.mock("../../relay-command-helpers", () => ({
  dispatchRelayCommandToRelay: mocks.dispatchRelayCommandToRelay,
  toRelayOperation: mocks.toRelayOperation,
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: { isFeatureEnabled: mocks.isFeatureEnabled },
}));

vi.mock("@/lib/compute-target-signing-eligibility", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/compute-target-signing-eligibility")
    >();
  return {
    ...actual,
    resolveCommandSigningRequirement: mocks.resolveCommandSigningRequirement,
  };
});

import { CommandSigningRequirementStatus } from "@/lib/compute-target-signing-eligibility";
import { desktopCommandStore } from "@/lib/desktop-command-store";
import { POST } from "./route";

const TARGET_ID = "target-1";

const target = {
  id: TARGET_ID,
  userId: "user-1",
  organizationId: "org-1",
  capabilities: {},
  supportedOperations: [],
  gatewayId: "gateway-1",
};

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(
    `https://api.closedloop.ai/compute-targets/${TARGET_ID}/commands`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

function commandBody(over: Record<string, unknown> = {}) {
  return {
    operationId: "echo",
    method: "POST",
    path: "/api/gateway/echo",
    ...over,
  };
}

function routeContext() {
  return { params: Promise.resolve({ id: TARGET_ID }) };
}

describe("POST /compute-targets/:id/commands — conflict mapping (ISS-7561)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.findAccessibleById.mockResolvedValue(target);
    mocks.findById.mockResolvedValue(null);
    mocks.resolveCommandSigningRequirement.mockResolvedValue({
      status: CommandSigningRequirementStatus.NotRequired,
    });
    mocks.dispatchRelayCommandToRelay.mockResolvedValue({ delivered: true });
    mocks.toRelayOperation.mockReturnValue({});
  });

  it("maps IdempotencyConflictError to 409", async () => {
    vi.spyOn(desktopCommandStore, "createCommand").mockRejectedValue(
      new desktopCommandStore.IdempotencyConflictError()
    );

    const response = await POST(
      request(commandBody({ idempotencyKey: "race-key" })),
      routeContext()
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Idempotency key collision with different payload",
    });
  });

  it("maps ClientCommandIdConflictError to 409", async () => {
    vi.spyOn(desktopCommandStore, "createCommand").mockRejectedValue(
      new desktopCommandStore.ClientCommandIdConflictError()
    );

    const response = await POST(request(commandBody()), routeContext());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Command ID already exists",
    });
  });

  it("does NOT map a raw Prisma P2002 to 409", async () => {
    // The regression the 409 assertions above cannot see on their own: if the
    // store stops classifying a duplicate and lets P2002 escape, the route has
    // no name to match and the documented 409 silently becomes a 500.
    vi.spyOn(desktopCommandStore, "createCommand").mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" })
    );

    const response = await POST(request(commandBody()), routeContext());

    expect(response.status).toBe(500);
  });

  it("answers 200 when the store does not conflict", async () => {
    vi.spyOn(desktopCommandStore, "createCommand").mockResolvedValue({
      command: {
        commandId: "command-1",
        status: DesktopCommandStatus.Queued,
      },
      deduped: false,
    } as Awaited<ReturnType<typeof desktopCommandStore.createCommand>>);

    const response = await POST(request(commandBody()), routeContext());

    expect(response.status).toBe(200);
  });
});

describe("POST /compute-targets/:id/commands — update-and-restart preconditions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.findAccessibleById.mockResolvedValue({
      ...target,
      supportedOperations: [UPDATE_AND_RESTART_OPERATION_ID],
    });
    mocks.findById.mockResolvedValue(null);
    mocks.resolveCommandSigningRequirement.mockResolvedValue({
      status: CommandSigningRequirementStatus.NotRequired,
    });
    mocks.dispatchRelayCommandToRelay.mockResolvedValue({ delivered: true });
    mocks.toRelayOperation.mockReturnValue({});
    mocks.isFeatureEnabled.mockResolvedValue(true);
  });

  it("rejects update-and-restart when the target does not support the operation", async () => {
    mocks.findAccessibleById.mockResolvedValue({
      ...target,
      supportedOperations: [],
    });
    const createCommandSpy = vi.spyOn(desktopCommandStore, "createCommand");

    const response = await POST(
      request(commandBody({ operationId: UPDATE_AND_RESTART_OPERATION_ID })),
      routeContext()
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Operation not supported by target",
    });
    expect(createCommandSpy).not.toHaveBeenCalled();
  });

  it("rejects update-and-restart when the electron-remote-update flag is off", async () => {
    mocks.isFeatureEnabled.mockResolvedValue(false);
    const createCommandSpy = vi.spyOn(desktopCommandStore, "createCommand");

    const response = await POST(
      request(commandBody({ operationId: UPDATE_AND_RESTART_OPERATION_ID })),
      routeContext()
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Feature not available",
    });
    expect(createCommandSpy).not.toHaveBeenCalled();
  });

  it("rejects update-and-restart when the request carries a body, even an explicit null", async () => {
    // `body !== undefined` is the guard's actual test, not truthiness — an
    // explicit `body: null` is a present field and must still trip it.
    const createCommandSpy = vi.spyOn(desktopCommandStore, "createCommand");

    const response = await POST(
      request(
        commandBody({
          operationId: UPDATE_AND_RESTART_OPERATION_ID,
          body: null,
        })
      ),
      routeContext()
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "update-and-restart does not accept a body or custom headers",
    });
    expect(createCommandSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "the flag check rejects",
      flag: () =>
        mocks.isFeatureEnabled.mockRejectedValue(
          new Error("posthog unreachable")
        ),
    },
    {
      name: "the flag resolves undefined",
      flag: () => mocks.isFeatureEnabled.mockResolvedValue(undefined),
    },
  ])(
    "permits update-and-restart when $name (fail-open pin)",
    async ({ flag }) => {
      // `isElectronRemoteUpdateEnabled` denies only on a literal `false`, so all three
      // of these fail OPEN. This pins that current behaviour; it is not an endorsement.
      // The reject row alone would be misleading coverage: a real PostHog server-flag
      // outage RESOLVES `null` rather than throwing (ISS-8132), so it never reaches the
      // `catch` at all — it takes the `result !== false` branch, and mutating that
      // comparison to `result === true` would flip the real-outage behaviour to closed
      // with only the reject row green. The sibling `isBranchPrEnabled`
      // (apps/api/lib/branch-view-local-authorization.ts) fails CLOSED on the same
      // conditions, so the two guards diverge — either way, this is what ships today.
      flag();
      vi.spyOn(desktopCommandStore, "createCommand").mockResolvedValue({
        command: {
          commandId: "command-uar",
          status: DesktopCommandStatus.Queued,
        },
        deduped: false,
      } as Awaited<ReturnType<typeof desktopCommandStore.createCommand>>);

      const response = await POST(
        request(commandBody({ operationId: UPDATE_AND_RESTART_OPERATION_ID })),
        routeContext()
      );

      expect(response.status).toBe(200);
      expect(desktopCommandStore.createCommand).toHaveBeenCalled();
    }
  );

  /**
   * BEHAVIOUR CHANGED IN THIS DIFF (ISS-7778), which is why this row left the
   * fail-open table above.
   *
   * This route used to read `analytics.isFeatureEnabled` directly — one of the
   * two sites that bypassed the shared helper — and denied only on a literal
   * `false`, so a provider answer of `null` fell through the `result !== false`
   * branch and ADMITTED the command. It now reads through the same classified
   * evaluator as every other server flag, and that path applies the repo-wide
   * `@repo/analytics` normalisation in which only `undefined` means "PostHog did
   * not answer"; a literal `null` normalises to an answered OFF.
   *
   * The narrowing is deliberate and moves toward CLOSED. It reaches a value
   * posthog-node does not emit — its documented range is `boolean | undefined` —
   * and the two rows that model a REAL outage, a rejected read and an
   * `undefined` answer, still fail open above and are untouched. The operator's
   * ISS-7778 ruling keeps the fail-open posture itself out of scope, and this
   * does not change it: it changes which provider answers count as an answer.
   */
  /**
   * IDENTITY PARITY WITH THE BUTTON (PR #6494 review).
   *
   * The control that offers this command renders behind `<FeatureFlagged>`,
   * which reads the browser PostHog client — identified with the CLERK id alone.
   * This route evaluated `input.user.id`, the internal database id, making it an
   * independent second draw on any percentage rollout: the two ids hash to
   * different buckets, so the button could render and the command still 403, or
   * the button hide while a direct call was admitted.
   *
   * The two cases below pin OPPOSITE verdicts on the two ids, so whichever id
   * the route evaluates decides the status code. Neither can pass by accident:
   * swapping the resolver back to the internal id inverts both.
   */
  it("admits update-and-restart on the clerk id's verdict when the internal id disagrees", async () => {
    mocks.isFeatureEnabled.mockImplementation(
      (_flag: string, distinctId: string) => distinctId === "clerk-user-1"
    );
    const createCommandSpy = vi
      .spyOn(desktopCommandStore, "createCommand")
      .mockResolvedValue({
        command: {
          commandId: "command-uar",
          status: DesktopCommandStatus.Queued,
        },
        deduped: false,
      } as Awaited<ReturnType<typeof desktopCommandStore.createCommand>>);

    const response = await POST(
      request(commandBody({ operationId: UPDATE_AND_RESTART_OPERATION_ID })),
      routeContext()
    );

    expect(response.status).toBe(200);
    expect(createCommandSpy).toHaveBeenCalled();
    expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
      "electron-remote-update",
      "clerk-user-1"
    );
    expect(mocks.isFeatureEnabled).not.toHaveBeenCalledWith(
      "electron-remote-update",
      "user-1"
    );
  });

  it("denies update-and-restart on the clerk id's verdict when the internal id disagrees", async () => {
    mocks.isFeatureEnabled.mockImplementation(
      (_flag: string, distinctId: string) => distinctId === "user-1"
    );
    const createCommandSpy = vi.spyOn(desktopCommandStore, "createCommand");

    const response = await POST(
      request(commandBody({ operationId: UPDATE_AND_RESTART_OPERATION_ID })),
      routeContext()
    );

    expect(response.status).toBe(403);
    expect(createCommandSpy).not.toHaveBeenCalled();
    expect(mocks.isFeatureEnabled).toHaveBeenCalledWith(
      "electron-remote-update",
      "clerk-user-1"
    );
  });

  it("denies update-and-restart when the provider answers a literal null", async () => {
    mocks.isFeatureEnabled.mockResolvedValue(null);
    const createCommandSpy = vi.spyOn(desktopCommandStore, "createCommand");

    const response = await POST(
      request(commandBody({ operationId: UPDATE_AND_RESTART_OPERATION_ID })),
      routeContext()
    );

    expect(response.status).toBe(403);
    expect(createCommandSpy).not.toHaveBeenCalled();
  });
});

describe("POST /compute-targets/:id/commands — browser command signature consistency", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.findAccessibleById.mockResolvedValue(target);
    mocks.findById.mockResolvedValue(null);
    mocks.resolveCommandSigningRequirement.mockResolvedValue({
      status: CommandSigningRequirementStatus.NotRequired,
    });
    mocks.dispatchRelayCommandToRelay.mockResolvedValue({ delivered: true });
    mocks.toRelayOperation.mockReturnValue({});
  });

  it("rejects a client command ID with no signature triple", async () => {
    const createCommandSpy = vi.spyOn(desktopCommandStore, "createCommand");

    const response = await POST(
      request(commandBody({ commandId: SIGNED_COMMAND_ID })),
      routeContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Client command IDs require browser command signing fields",
    });
    expect(createCommandSpy).not.toHaveBeenCalled();
  });

  it("rejects a full signature triple with no client command ID", async () => {
    const createCommandSpy = vi.spyOn(desktopCommandStore, "createCommand");

    const response = await POST(
      request(commandBody({ ...SIGNATURE_TRIPLE })),
      routeContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Signed browser commands require a client command ID",
    });
    expect(createCommandSpy).not.toHaveBeenCalled();
  });

  it("rejects a signed command whose path targets outside the gateway namespace at the body validator", async () => {
    // `isDesktopApiPath` (the validator, apps/api/app/compute-targets/validators.ts)
    // and `isPathInCurrentNamespace` (this route) are the byte-identical
    // `p.startsWith(DESKTOP_API_PREFIX)` expression, so a signed command that
    // fails the route's inner namespace guard while passing the validator's is
    // an EMPTY set — that inner guard is unreachable defence-in-depth, kept
    // deliberately rather than tested. This pins the boundary that IS
    // reachable: the validator rejects the out-of-namespace path first.
    const createCommandSpy = vi.spyOn(desktopCommandStore, "createCommand");

    const response = await POST(
      request(
        commandBody({
          path: "/api/documents/1",
          commandId: SIGNED_COMMAND_ID,
          ...SIGNATURE_TRIPLE,
        })
      ),
      routeContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "path: Path must target /api/gateway/*",
    });
    expect(createCommandSpy).not.toHaveBeenCalled();
  });
});

describe("POST /compute-targets/:id/commands — undelivered dispatch signal (ISS-7486 evidence)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.findAccessibleById.mockResolvedValue(target);
    mocks.findById.mockResolvedValue(null);
    mocks.resolveCommandSigningRequirement.mockResolvedValue({
      status: CommandSigningRequirementStatus.NotRequired,
    });
    mocks.toRelayOperation.mockReturnValue({});
  });

  it("reports Queued with no delivery signal for an unsigned command whose target is offline", async () => {
    // Unsigned dispatch never reaches the signed-command expiry branch, so
    // "handed to the machine" and "buffered because nothing is connected" both
    // render as the identical Queued response — the caller cannot tell them
    // apart from this API alone.
    mocks.dispatchRelayCommandToRelay.mockResolvedValue({
      delivered: false,
      reason: "target_offline",
    });
    vi.spyOn(desktopCommandStore, "createCommand").mockResolvedValue({
      command: {
        commandId: "command-unsigned",
        status: DesktopCommandStatus.Queued,
      },
      deduped: false,
    } as Awaited<ReturnType<typeof desktopCommandStore.createCommand>>);
    const markExpiredSpy = vi.spyOn(desktopCommandStore, "markCommandExpired");

    const response = await POST(request(commandBody()), routeContext());

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.data.status).toBe(DesktopCommandStatus.Queued);
    expect(markExpiredSpy).not.toHaveBeenCalled();
  });
});

const SIGNED_COMMAND_ID = "018f4b6e-1234-7abc-89ab-0123456789ab";
const SIGNATURE_TRIPLE = {
  signature: "c2lnbmF0dXJl",
  signaturePayload: "signature-payload",
  publicKeyFingerprint: `cl:${"A".repeat(22)}`,
};
