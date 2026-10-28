/**
 * @file external-url-allowlist.test.ts
 * @description Behavioral tests for the shared main-process external-URL
 * allowlist (`src/main/settings/external-url-allowlist.ts`). The allowlist is the single
 * gate every `shell.openExternal` caller (renderer navigation guards and the
 * `desktop:db:open-pr` IPC handler) routes through, so its fail-closed policy is
 * exercised directly here rather than only via source-text assertions.
 */
import assert from "node:assert/strict";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import type {
  WithDb,
  WithPrisma,
} from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import {
  isAllowedDesktopVerificationUrl,
  isAllowedExternalUrl,
  isAllowedRendererExternalUrl,
} from "../src/main/settings/external-url-allowlist.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  openedExternalUrls,
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

test("isAllowedExternalUrl allows https URLs on known hosts", () => {
  assert.equal(isAllowedExternalUrl("https://github.com/closedloop-ai"), true);
  assert.equal(isAllowedExternalUrl("https://app.closedloop.ai/loops"), true);
  assert.equal(isAllowedExternalUrl("https://closedloop.ai"), true);
  assert.equal(isAllowedExternalUrl("https://docs.closedloop.ai/start"), true);
});

test("isAllowedExternalUrl rejects non-https schemes forwarded to the OS", () => {
  // The whole point of routing through this gate: shell.openExternal hands
  // non-http schemes to the OS, so file:/custom-scheme values must be denied.
  assert.equal(isAllowedExternalUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedExternalUrl("http://github.com"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedExternalUrl("custom-scheme://github.com"), false);
});

test("isAllowedExternalUrl rejects unknown hosts", () => {
  assert.equal(isAllowedExternalUrl("https://evil.com"), false);
  assert.equal(isAllowedExternalUrl("https://github.com.evil.com"), false);
});

test("isAllowedExternalUrl rejects embedded credentials", () => {
  assert.equal(isAllowedExternalUrl("https://user:pass@github.com"), false);
  assert.equal(isAllowedExternalUrl("https://user@github.com"), false);
});

test("isAllowedExternalUrl rejects unparseable input", () => {
  assert.equal(isAllowedExternalUrl("not a url"), false);
  assert.equal(isAllowedExternalUrl(""), false);
});

const CONNECT_PATH = "/settings/integrations/desktop/connect?code=ABCD";

test("isAllowedDesktopVerificationUrl accepts the configured origin (prod, stage, or any https host)", () => {
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `https://app.closedloop.ai${CONNECT_PATH}`,
      "https://app.closedloop.ai"
    ),
    true
  );
  // A stage/preview host works purely because it is what the desktop is
  // configured to talk to — no fixed prod-host allowlist is involved.
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `https://app.stage.closedloop.dev${CONNECT_PATH}`,
      "https://app.stage.closedloop.dev"
    ),
    true
  );
});

test("isAllowedDesktopVerificationUrl allows http only for loopback dev origins", () => {
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `http://localhost:3000${CONNECT_PATH}`,
      "http://localhost:3000"
    ),
    true
  );
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `http://127.0.0.1:3000${CONNECT_PATH}`,
      "http://127.0.0.1:3000"
    ),
    true
  );
  // http to a non-loopback host is rejected even if that is the configured
  // origin — sign-in over a public network must be https.
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `http://app.example.com${CONNECT_PATH}`,
      "http://app.example.com"
    ),
    false
  );
});

test("isAllowedDesktopVerificationUrl rejects a URL whose origin differs from the configured one", () => {
  // MITM/redirect to another host.
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `https://evil.com${CONNECT_PATH}`,
      "https://app.closedloop.ai"
    ),
    false
  );
  // Different port.
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `http://localhost:9999${CONNECT_PATH}`,
      "http://localhost:3000"
    ),
    false
  );
  // Scheme downgrade.
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `http://app.closedloop.ai${CONNECT_PATH}`,
      "https://app.closedloop.ai"
    ),
    false
  );
});

test("isAllowedDesktopVerificationUrl rejects non-web schemes, credentials, and unparseable input", () => {
  assert.equal(
    isAllowedDesktopVerificationUrl(
      "file:///etc/passwd",
      "https://app.closedloop.ai"
    ),
    false
  );
  assert.equal(
    isAllowedDesktopVerificationUrl(
      "app-evil://app.closedloop.ai",
      "https://app.closedloop.ai"
    ),
    false
  );
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `https://user:pass@app.closedloop.ai${CONNECT_PATH}`,
      "https://app.closedloop.ai"
    ),
    false
  );
  assert.equal(
    isAllowedDesktopVerificationUrl("not a url", "https://app.closedloop.ai"),
    false
  );
  assert.equal(
    isAllowedDesktopVerificationUrl(
      `https://app.closedloop.ai${CONNECT_PATH}`,
      "garbage"
    ),
    false
  );
});

// ---------------------------------------------------------------------------
// ISS-4898 (whitlockk + codex review) — `isAllowedRendererExternalUrl`: the fixed
// production host set PLUS the exact origin this desktop is configured against.
//
// Without the second half, the session-detail linked-artifact pills rendered as
// live anchors on every stage/preview/localhost profile and every click was
// silently denied here — a control that looks actionable and does nothing.
// ---------------------------------------------------------------------------

const STAGE_ORIGIN = "https://app.stage.example";
const STAGE_ARTIFACT_URL = `${STAGE_ORIGIN}/acme/issues/ISS-4898`;

test("ISS-4898: the fixed production host set is admitted with no configured origin", () => {
  assert.equal(
    isAllowedRendererExternalUrl(
      "https://app.closedloop.ai/acme/issues/ISS-4898",
      null
    ),
    true
  );
  assert.equal(
    isAllowedRendererExternalUrl("https://github.com/org/repo/pull/1", null),
    true
  );
});

test("ISS-4898: a stage artifact URL is DENIED without the configured origin and ADMITTED with it", () => {
  // The regression itself: the fixed host set alone rejects the very URL the
  // stage-pointed renderer builds.
  assert.equal(isAllowedRendererExternalUrl(STAGE_ARTIFACT_URL, null), false);
  assert.equal(
    isAllowedRendererExternalUrl(STAGE_ARTIFACT_URL, STAGE_ORIGIN),
    true
  );
});

test("ISS-4898: a localhost dev profile is admitted over loopback http", () => {
  assert.equal(
    isAllowedRendererExternalUrl(
      "http://localhost:3000/acme/issues/ISS-4898",
      "http://localhost:3000"
    ),
    true
  );
});

test("ISS-4898: the configured origin admits ONLY that exact origin", () => {
  // Configuring stage must not widen the gate to a sibling host, another port,
  // a downgraded scheme, or a credential-bearing URL.
  for (const url of [
    "https://evil.stage.example/acme/issues/ISS-4898",
    "https://app.stage.example:8443/acme/issues/ISS-4898",
    "http://app.stage.example/acme/issues/ISS-4898",
    "https://user:pass@app.stage.example/acme/issues/ISS-4898",
    "app-evil://app.stage.example/acme",
    "not a url",
  ]) {
    assert.equal(
      isAllowedRendererExternalUrl(url, STAGE_ORIGIN),
      false,
      `must deny ${url}`
    );
  }
});

test("ISS-4898: a malformed configured origin never widens the gate", () => {
  assert.equal(
    isAllowedRendererExternalUrl(STAGE_ARTIFACT_URL, "garbage"),
    false
  );
  // The fixed set still applies, so docs/GitHub links keep working.
  assert.equal(
    isAllowedRendererExternalUrl("https://docs.closedloop.ai/start", "garbage"),
    true
  );
});

// ---------------------------------------------------------------------------
// ISS-8143 — the `desktop:db:open-pr` HANDLER's decision.
//
// The six `isAllowedExternalUrl` cases above test the gate in isolation. None
// reached the handler, so deleting `&& isAllowedExternalUrl(prUrl)` from
// `agent-dashboard-catalog-pack-ipc.ts` left this entire file green while every
// stored `prUrl` — a value that arrives from a sync record, not from the user —
// went straight to the OS. These cases drive the REAL registrar and assert on
// whether `shell.openExternal` was called at all.
//
// PINNED AS-IS, NOT ASSERTED CORRECT: the deny path returns `undefined`, which
// is byte-identical to the success path, and logs nothing. The renderer cannot
// tell "opened" from "refused" — unlike `open-plan`, which logs its refusal,
// and unlike `github-connect-opener`, which returns a typed `{ok:false,reason}`.
// Changing that return shape is a contract change and is deliberately NOT made
// here; these cases record the CURRENT behaviour so the change is visible when
// someone makes it.
// ---------------------------------------------------------------------------

describe("desktop:db:open-pr only opens an allowlisted URL", () => {
  const OPEN_PR_CHANNEL = "desktop:db:open-pr";
  const TRUSTED_EVENT = { sender: {} };
  const PR_ID = "pr-1";

  let mock: ElectronModuleMock;
  let registerCatalogAndPackIpcHandlers: (deps: {
    withDb: WithDb;
    withPrisma: WithPrisma;
    options: AgentDashboardDesignSystemRuntimeOptions;
    invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
  }) => void;

  beforeAll(async () => {
    mock = registerElectronModuleMock();
    const registrar = await import(
      "../src/main/dashboard/agent-dashboard-catalog-pack-ipc.js"
    );
    registerCatalogAndPackIpcHandlers =
      registrar.registerCatalogAndPackIpcHandlers as typeof registerCatalogAndPackIpcHandlers;
  });

  afterAll(() => {
    mock.deregister();
  });

  afterEach(() => {
    resetElectronModuleStub();
  });

  /**
   * Registers the real handlers over a single stored PR artifact row, counting
   * the reads so a case can assert the id guard refused BEFORE the lookup —
   * `openedExternalUrls()` alone cannot see that, because a read that finds no
   * matching row also opens nothing.
   */
  function registerWithPrUrl(prUrl: string | null): {
    reads: () => number;
  } {
    let reads = 0;
    const prisma = {
      client: {
        artifact: {
          findMany: () => {
            reads += 1;
            return Promise.resolve([
              {
                id: PR_ID,
                url: prUrl,
                prNumber: 1,
                repoFullName: "owner/repo",
                branchName: "feature",
                headSha: "abc",
                title: "A pull request",
                harness: "claude",
                observedAt: "2026-01-01T00:00:00.000Z",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ]);
          },
        },
      },
    };
    const withPrisma: WithPrisma =
      (handler) =>
      async (_event, ...args) =>
        await handler(
          prisma as unknown as Parameters<typeof handler>[0],
          ...args
        );
    const withDb: WithDb =
      (handler) =>
      async (_event, ...args) =>
        await handler(
          undefined as unknown as Parameters<typeof handler>[0],
          ...args
        );
    registerCatalogAndPackIpcHandlers({
      withDb,
      withPrisma,
      options: {} as AgentDashboardDesignSystemRuntimeOptions,
      invokeStoreOp: () => Promise.resolve(undefined),
    });
    return { reads: () => reads };
  }

  for (const prUrl of [
    // `shell.openExternal` hands the scheme to the OS, so a non-web scheme is
    // arbitrary local execution, not a navigation.
    "javascript:alert(1)",
    "file:///etc/passwd",
    "https://evil.example/x",
    "https://user:pass@github.com/owner/repo/pull/1",
    "not a url at all",
  ]) {
    test(`refuses ${prUrl}`, async () => {
      registerWithPrUrl(prUrl);

      await registeredInvokeHandler(OPEN_PR_CHANNEL)(TRUSTED_EVENT, PR_ID);

      assert.deepEqual(openedExternalUrls(), []);
    });
  }

  test("opens an allowlisted URL exactly once, unmodified", async () => {
    // The positive control: without it every refusal above is satisfied by a
    // handler that opens nothing ever.
    const allowed = "https://github.com/closedloop-ai/closedloop-ai/pull/1";
    registerWithPrUrl(allowed);

    await registeredInvokeHandler(OPEN_PR_CHANNEL)(TRUSTED_EVENT, PR_ID);

    assert.deepEqual(openedExternalUrls(), [allowed]);
  });

  test("a non-string id is refused BEFORE the store is read", async () => {
    // Both halves matter. `openedExternalUrls()` alone would stay empty even
    // with the `typeof id !== "string"` guard deleted, because the subsequent
    // lookup finds no artifact whose id is the number 42 and so opens nothing
    // either way. The read count is what actually pins the early return.
    const { reads } = registerWithPrUrl(
      "https://github.com/closedloop-ai/closedloop-ai/pull/1"
    );

    await registeredInvokeHandler(OPEN_PR_CHANNEL)(TRUSTED_EVENT, 42);

    assert.equal(reads(), 0, "the guard must return before listPullRequests");
    assert.deepEqual(openedExternalUrls(), []);
  });

  test("a well-formed id matching no stored row reads, then opens nothing", async () => {
    // The contrast that makes the case above mean something: a STRING id does
    // reach the store, and still opens nothing when no row matches.
    const { reads } = registerWithPrUrl(
      "https://github.com/closedloop-ai/closedloop-ai/pull/1"
    );

    await registeredInvokeHandler(OPEN_PR_CHANNEL)(TRUSTED_EVENT, "missing");

    assert.equal(reads(), 1);
    assert.deepEqual(openedExternalUrls(), []);
  });
});
