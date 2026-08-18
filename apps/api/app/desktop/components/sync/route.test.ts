/**
 * @file route.test.ts
 * @description ISS-5164 — the route-to-parser WIRING, which the helper suite
 * cannot reach (#4425 review).
 *
 * `desktop-agent-components-parse.test.ts` proves the helper sanitizes and
 * preserves the ISS-5029 marker. It stops there. Nothing pinned that
 * `POST /desktop/components/sync` actually routes its raw body through that
 * helper before calling the service — the existing sync suites mock the schema
 * and assert on service behaviour, never on the payload the route hands over.
 *
 * That gap is silent in exactly the direction that matters. Drop the
 * `parseDesktopAgentComponentsPayload` call from the route and the schema still
 * accepts the body (it is a non-strict `z.object`), the marker still rides
 * through, every existing test stays green — and a NUL-bearing definition body
 * reaches the Postgres `text` write, 500s, and parks the desktop cursor on a
 * poison batch it retries forever.
 *
 * So this asserts the EXACT payload handed to the service: sanitized content,
 * marker and reason intact, in one case.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { SyncedComponentVariantsTruncatedReason } from "@repo/api/src/types/synced-component-content";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_COMPONENT_SYNC_SCHEMA_VERSION } from "@/lib/desktop-agent-sessions-schema";

const mocks = vi.hoisted(() => ({
  user: { id: "user-1", organizationId: "org-1" },
  sync: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler({ user: mocks.user, clerkUserId: "clerk-1" }, request),
}));

vi.mock("./service", () => ({
  desktopComponentsSyncService: { sync: mocks.sync },
}));

import { POST } from "./route";

const COMPUTE_TARGET_ID = "11111111-1111-7111-8111-111111111111";
const VALID_BATCH_ID = "22222222-2222-4222-8222-222222222222";

/**
 * Built via `fromCharCode` so no literal NUL byte lives in source, matching the
 * convention in `agent-sessions-text-sanitizer.ts` and the helper suite.
 */
const NUL_CHAR = String.fromCharCode(0);

/** The Next.js route context; this endpoint has no dynamic segments. */
const ctx = { params: Promise.resolve({}) };

function request(body: unknown) {
  return new NextRequest(
    `https://api.test/desktop/components/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
    { method: "POST", body: JSON.stringify(body) }
  );
}

function payloadWith(component: Record<string, unknown>) {
  return {
    schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
    batchId: VALID_BATCH_ID,
    syncMode: AgentSessionSyncMode.Incremental,
    componentCount: 1,
    components: [component],
  };
}

describe("POST /desktop/components/sync — ISS-5164 route-to-parser wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sync.mockResolvedValue({ ok: true, value: { synced: true } });
  });

  it("hands the service a NUL-free body with the truncation marker and reason intact", async () => {
    const response = await POST(
      request(
        payloadWith({
          externalId: "agent::reviewer",
          componentKind: "agent",
          componentKey: "reviewer",
          contentHash: "hash-primary",
          content: `PRIMARY${NUL_CHAR} BODY`,
          variantsTruncated: true,
          variantsTruncatedReason:
            SyncedComponentVariantsTruncatedReason.FamilyCap,
        })
      ),
      ctx
    );

    expect(response.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledTimes(1);

    // Read the payload the ROUTE built, not a re-derivation of it.
    const [syncArgs] = mocks.sync.mock.calls[0];
    const [synced] = syncArgs.payload.components;

    // The sanitizer ran: no NUL survives to the Postgres `text` write. Asserted
    // on the codepoint rather than a trimmed string so a sanitizer that replaced
    // the NUL with another control character would still fail.
    expect(synced.content).not.toContain(NUL_CHAR);
    expect(synced.content).toBe("PRIMARY BODY");

    // ...and sanitizing did not cost the ISS-5029 ground. This is the pair that
    // matters: either half alone can pass while the boundary is broken.
    expect(synced.variantsTruncated).toBe(true);
    expect(synced.variantsTruncatedReason).toBe(
      SyncedComponentVariantsTruncatedReason.FamilyCap
    );

    // The rest of the service contract, so a payload reshuffle is not silent.
    expect(syncArgs.computeTargetId).toBe(COMPUTE_TARGET_ID);
    expect(syncArgs.organizationId).toBe(mocks.user.organizationId);
    expect(syncArgs.userId).toBe(mocks.user.id);
  });

  it("rejects an unparseable payload before the service is reached", async () => {
    // The negative half: without this, the assertion above would still pass if
    // the route forwarded everything unconditionally.
    const response = await POST(
      request({ schemaVersion: "not-a-version" }),
      ctx
    );

    expect(response.status).toBe(400);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
