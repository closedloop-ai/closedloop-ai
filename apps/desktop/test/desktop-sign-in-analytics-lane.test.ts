import { DesktopSignInAnalyticsPath } from "@repo/api/src/types/desktop-sign-in-analytics.ts";
import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAccountMode as Mode,
  OnboardingCtaId,
  OnboardingAnalyticsProperty as Property,
  OnboardingFailureReason as Reason,
} from "@repo/api/src/types/onboarding-analytics.ts";
import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase.ts";
import { Surface } from "@repo/api/src/types/surface-analytics.ts";
import { expect, it, vi } from "vitest";
import { createObservabilityLaneRouter } from "../src/main/cloud/observability-lane-router.js";
import { DesktopAuthStatus } from "../src/shared/contracts.js";
import {
  createLoopbackStub,
  createManager,
  installTempRoot,
} from "./helpers/desktop-session-manager-fixtures.js";

installTempRoot();
const flowId = "11111111-1111-4111-8111-111111111111";
const nodeUuid = "22222222-2222-4222-8222-222222222222";
function setup(
  enabled = true,
  registration: () => Promise<Response> = async () => new Response()
) {
  const requests: {
    url: string;
    body: Record<string, unknown>;
    headers: Headers;
  }[] = [];
  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
      });
      if (url.endsWith(DesktopSignInAnalyticsPath.Register)) {
        return await registration();
      }
      return Response.json({ success: true, data: { captured: true } });
    }
  );
  const router = createObservabilityLaneRouter({
    getIdentity: () => ({ userId: "user-1", organizationId: "org-1" }),
    getAppVersion: () => "0.17.482",
    fetch: fetchImpl,
    getApiOrigin: () => "https://api.example.test",
    getAccessToken: async () => null,
    getPluginVersion: () => "test",
    onUnauthorized: () => undefined,
    isHttpReady: () => false,
    getComputeTargetId: () => null,
    getRetainedComputeTargetId: () => null,
    getAuthStatus: () => DesktopAuthStatus.SignedOut,
    getNodeUuid: () => nodeUuid,
    isSinglePlayerInstall: () => true,
    isPreAuthSendEnabled: () => enabled,
  });
  return { router, requests };
}
function accountEvent(router: ReturnType<typeof setup>["router"]) {
  router.sendAnalytics({
    event: Event.StepViewed,
    occurredAt: "2026-09-30T12:00:00Z",
    properties: {
      [Property.FlowId]: flowId,
      [Property.Step]: OnboardingPhase.Account,
      [Property.StepIndex]: 2,
      [Property.Surface]: Surface.Desktop,
    },
  });
}
it("registers only the live attempt and retains its pre-auth snapshot after reset", async () => {
  const { router, requests } = setup();
  expect(router.beginSignInAnalytics()).toBeNull();
  accountEvent(router);
  // The renderer CTA carries the account step but omits step_index.
  router.sendAnalytics({
    event: Event.CtaClicked,
    occurredAt: "2026-09-30T12:00:01Z",
    properties: {
      [Property.FlowId]: flowId,
      [Property.Step]: OnboardingPhase.Account,
      [Property.CtaId]: OnboardingCtaId.SignIn,
    },
  });
  const attempt = router.beginSignInAnalytics();
  attempt?.register("A".repeat(43));
  router.resetForSession();
  attempt?.failed([Mode.Created, Mode.LoggedOut], Reason.ExchangeFailed);
  await router.flushAnalytics({ timeoutMs: 1000 });
  const registration = requests.find((r) =>
    r.url.endsWith(DesktopSignInAnalyticsPath.Register)
  );
  expect(registration?.body).toEqual({ codeChallenge: "A".repeat(43), flowId });
  expect(registration?.headers.has("authorization")).toBe(false);
  const failure = requests.find((r) => r.body.event === Event.StepFailed);
  expect(failure?.body).toMatchObject({
    distinctId: flowId,
    properties: {
      [Property.FlowId]: flowId,
      [Property.DeviceId]: nodeUuid,
      [Property.StepIndex]: 2,
      [Property.AccountMode]: [Mode.Created, Mode.LoggedOut],
      [Property.FailureReason]: Reason.ExchangeFailed,
    },
  });
  expect(failure?.headers.has("authorization")).toBe(false);
  expect(requests.every((r) => !r.url.includes(flowId))).toBe(true);
});
it("does not reuse the account index after leaving the account step", () => {
  const { router } = setup();
  accountEvent(router);
  router.sendAnalytics({
    event: Event.StepViewed,
    occurredAt: "2026-09-30T12:00:01Z",
    properties: {
      [Property.FlowId]: flowId,
      [Property.Step]: OnboardingPhase.ConnectGitHub,
      [Property.StepIndex]: 3,
    },
  });
  expect(router.beginSignInAnalytics()).toBeNull();
  router.sendAnalytics({
    event: Event.CtaClicked,
    occurredAt: "2026-09-30T12:00:02Z",
    properties: {
      [Property.FlowId]: flowId,
      [Property.Step]: OnboardingPhase.Account,
      [Property.CtaId]: OnboardingCtaId.SignIn,
    },
  });
  expect(router.beginSignInAnalytics()).toBeNull();
});
it.each(["hang", "reject"])(
  "a registration that %ss never delays sign-in",
  async (behavior) => {
    const { router, requests } = setup(true, () =>
      behavior === "hang"
        ? new Promise(() => undefined)
        : Promise.reject(new Error("offline"))
    );
    accountEvent(router);
    const { deps, state } = createLoopbackStub();
    const { manager } = createManager({
      browserSignIn: deps,
      beginSignInAnalytics: () => router.beginSignInAnalytics(),
    });
    expect(await manager.beginBrowserSignIn()).toEqual({ ok: true });
    expect(state.openCalls).toHaveLength(1);
    expect(state.openCalls[0]).not.toContain(flowId);
    expect(
      requests.some((r) => r.url.endsWith(DesktopSignInAnalyticsPath.Register))
    ).toBe(true);
    await router.flushAnalytics({ timeoutMs: 1000 });
  }
);
it("skipped flows and disabled egress cannot register install identity", async () => {
  const { router, requests } = setup(false);
  accountEvent(router);
  const attempt = router.beginSignInAnalytics();
  attempt?.register("A".repeat(43));
  attempt?.failed([Mode.CreationUnconfirmed], Reason.Cancelled);
  router.sendAnalytics({
    event: Event.StepSkipped,
    occurredAt: "2026-09-30T12:00:00Z",
    properties: {
      [Property.Step]: OnboardingPhase.Account,
      [Property.FlowId]: flowId,
    },
  });
  expect(router.beginSignInAnalytics()).toBeNull();
  await router.flushAnalytics({ timeoutMs: 1000 });
  expect(requests).toEqual([]);
});
