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
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID } from "@repo/api/src/types/desktop-sync-ack-detail";
import { DesktopComponentsSyncRestErrorCode } from "@repo/api/src/types/desktop-write-lane";
import { SyncedComponentVariantsTruncatedReason } from "@repo/api/src/types/synced-component-content";
import {
  SYNTHETIC_GITHUB_TOKEN,
  SYNTHETIC_GOOGLE_TOKEN,
} from "@repo/lib/security/synthetic-secrets.test-helpers";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countedEndlessBody,
  maxPullForCap,
  streamRequest,
} from "@/__tests__/utils/bounded-body.test-helpers";
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

import { maxDuration, POST } from "./route";

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

function validComponent() {
  return {
    externalId: "agent::reviewer",
    componentKind: "agent",
    componentKey: "reviewer",
    contentHash: "hash-primary",
    content: "PRIMARY BODY",
  };
}

// ISS-8734: `ComputeTarget.id` is `@db.Uuid`; a malformed id used to reach the
// ownership lookup as a P2023 and come back as a 500.
describe("POST /desktop/components/sync — untrusted computeTargetId", () => {
  beforeEach(() => {
    mocks.sync.mockReset();
  });

  it("rejects a malformed computeTargetId as a 400 before invoking sync", async () => {
    const response = await POST(
      new NextRequest(
        "https://api.test/desktop/components/sync?computeTargetId=abc",
        {
          method: "POST",
          body: JSON.stringify(payloadWith(validComponent())),
        }
      ),
      ctx
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: "computeTargetId must be a UUID",
      details: { reason: DESKTOP_SYNC_ACK_REASON_COMPUTE_TARGET_ID_INVALID },
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});

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

  // ISS-4965: the shape an older Desktop still sends — raw definition text.
  it("hands the service secret-redacted primary and variant bodies, and clean ones untouched", async () => {
    const primary = `PRIMARY ${SYNTHETIC_GITHUB_TOKEN}`;
    const variant = `OLD ${SYNTHETIC_GITHUB_TOKEN}`;
    const response = await POST(
      request(
        payloadWith({
          ...validComponent(),
          componentKind: AgentComponentKind.Skill,
          content: primary,
          variants: [
            { contentHash: "hash-secret", content: variant },
            { contentHash: "hash-clean", content: "CLEAN BODY" },
          ],
        })
      ),
      ctx
    );

    expect(response.status).toBe(200);
    const [syncArgs] = mocks.sync.mock.calls[0];
    const [synced] = syncArgs.payload.components;
    expect(synced.content).toBe("PRIMARY [REDACTED:ghp]");
    expect(synced.contentHash).toBe("hash-primary");
    // Perrin, 2026-10-05: the parser keeps the usage digest of what it rewrote.
    expect(synced.usageScopeHash).toBe(rawSkillUsageDigest(primary));
    const [secretVariant, cleanVariant] = synced.variants;
    expect(secretVariant.content).toBe("OLD [REDACTED:ghp]");
    expect(secretVariant.usageScopeHash).toBe(rawSkillUsageDigest(variant));
    expect(cleanVariant.content).toBe("CLEAN BODY");
    expect(Object.hasOwn(cleanVariant, "usageScopeHash")).toBe(false);
  });

  // ISS-4965: a current Desktop redacts first and sends the digest itself. The
  // body also holds a family only the cloud matches, so this pass rewrites it
  // again — the sent digest of the text as written must still win.
  it("keeps the usage digest a current Desktop sends with an already-redacted body", async () => {
    const sentDigest = "d".repeat(64);
    const sentVariantDigest = "e".repeat(64);
    const response = await POST(
      request(
        payloadWith({
          ...validComponent(),
          componentKind: AgentComponentKind.Skill,
          content: `PRIMARY [REDACTED:ghp] ${SYNTHETIC_GOOGLE_TOKEN}`,
          usageScopeHash: sentDigest,
          variants: [
            {
              contentHash: "hash-variant",
              content: `OLD [REDACTED:ghp] ${SYNTHETIC_GOOGLE_TOKEN}`,
              usageScopeHash: sentVariantDigest,
            },
          ],
        })
      ),
      ctx
    );

    expect(response.status).toBe(200);
    const [syncArgs] = mocks.sync.mock.calls[0];
    const [synced] = syncArgs.payload.components;
    expect(synced.content).toBe(
      "PRIMARY [REDACTED:ghp] [REDACTED:google_oauth_token]"
    );
    expect(synced.usageScopeHash).toBe(sentDigest);
    expect(synced.variants[0].content).toBe(
      "OLD [REDACTED:ghp] [REDACTED:google_oauth_token]"
    );
    expect(synced.variants[0].usageScopeHash).toBe(sentVariantDigest);
  });

  it("rejects a poisoned current-version payload with its parser reason", async () => {
    const response = await POST(
      request({ ...payloadWith(validComponent()), batchId: "not-a-uuid" }),
      ctx
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      success: false,
      error: "Invalid component sync payload",
      code: DesktopComponentsSyncRestErrorCode.ValidationFailed,
      details: { reason: "batch_id_invalid" },
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("rejects a missing schema version with its parser reason", async () => {
    const response = await POST(
      request({
        batchId: VALID_BATCH_ID,
        syncMode: AgentSessionSyncMode.Incremental,
        componentCount: 1,
        components: [validComponent()],
      }),
      ctx
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      success: false,
      error: "Invalid component sync payload",
      code: DesktopComponentsSyncRestErrorCode.ValidationFailed,
      details: { reason: "schema_version_invalid" },
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  // ISS-8609: the 400 now NAMES itself. Before it did, the desktop could only
  // recognise skew by folding every 400 the same way, which buried a
  // content-attributable 400 in an environmental defer.
  it("rejects a mismatched schema version with a CODED 400, not 422", async () => {
    const response = await POST(
      request({
        ...payloadWith(validComponent()),
        schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION + 1,
      }),
      ctx
    );

    expect(response.status).toBe(400);
    expect(response.status).not.toBe(422);
    expect(await response.json()).toEqual({
      success: false,
      error: "Invalid component sync payload",
      code: DesktopComponentsSyncRestErrorCode.SchemaVersionUnsupported,
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  // The wire spelling, pinned against a hand-written literal exactly once. Every
  // other assertion in this file reads the const (the repo's enum-reference
  // rule), and a const-only suite stays green through a rename that breaks the
  // wire for every installed desktop — the cloud deploys first, so the two never
  // ship together.
  it("pins the coded-400 wire spelling the desktop classifier keys on", () => {
    expect(DesktopComponentsSyncRestErrorCode.SchemaVersionUnsupported).toBe(
      "schema_version_unsupported"
    );
    expect(DesktopComponentsSyncRestErrorCode.ValidationFailed).toBe(
      "validation_failed"
    );
  });

  // ISS-8609: the route's boundary reads the ACCEPTED TUPLE, not the stamped
  // literal. This is the WIRING half only — with one accepted version, set
  // membership and equality with a single literal give the same answer here, so
  // this case cannot tell them apart and does not claim to. The membership branch
  // itself is driven at cardinality two in
  // `packages/api/src/types/__tests__/agent-component-sync-schema-version.test.ts`.
  it("accepts the stamped schemaVersion end to end", async () => {
    const response = await POST(
      request({
        ...payloadWith(validComponent()),
        schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION,
      }),
      ctx
    );

    expect(response.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });

  // ISS-7978: the 400 arm holds the desktop cursor, so it must be reachable
  // ONLY by real skew. A malformed `schemaVersion` is a batch no API deploy can
  // ever accept; routing it to 400 stalls the component lane forever, which is
  // the exact stall this ticket exists to close. Each of these is `present and
  // !== 1`, so a predicate that only compares against the supported version
  // sends every one of them down the cursor-holding path.
  it.each([
    { label: "null", schemaVersion: null },
    { label: "a numeric string", schemaVersion: "1" },
    { label: "an object", schemaVersion: {} },
    { label: "an array", schemaVersion: [] },
    { label: "a fraction", schemaVersion: 1.5 },
    { label: "zero", schemaVersion: 0 },
    { label: "a negative version", schemaVersion: -1 },
    {
      label: "a magnitude past the safe-integer range",
      schemaVersion: Number.MAX_SAFE_INTEGER + 1,
    },
  ])(
    "rejects $label schema version as a poison batch, not lane-wide skew",
    async ({ schemaVersion }) => {
      const response = await POST(
        request({ ...payloadWith(validComponent()), schemaVersion }),
        ctx
      );

      expect(response.status).toBe(422);
      expect(response.status).not.toBe(400);
      expect(await response.json()).toEqual({
        success: false,
        error: "Invalid component sync payload",
        code: DesktopComponentsSyncRestErrorCode.ValidationFailed,
        details: { reason: "schema_version_invalid" },
      });
      expect(mocks.sync).not.toHaveBeenCalled();
    }
  );

  // ISS-7978: the cursor-holding 400 is earned only when a deploy could fix the
  // batch, so skew must be its SOLE defect. A future-versioned batch that is
  // also malformed elsewhere stays permanently invalid after that deploy — a
  // predicate that reads the version alone parks the lane on it forever.
  it("rejects a future version carrying another invalid field with 422, not 400", async () => {
    const response = await POST(
      request({
        ...payloadWith(validComponent()),
        schemaVersion: AGENT_COMPONENT_SYNC_SCHEMA_VERSION + 1,
        batchId: "not-a-uuid",
      }),
      ctx
    );

    expect(response.status).toBe(422);
    expect(response.status).not.toBe(400);
    // The reason is `summarizeParseIssues`' first issue, so the version wins the
    // diagnostic here. It does not decide anything: the component lane keys on
    // `code` and status, never on `details.reason`, so this 422 dead-letters
    // whatever reason it carries. Only the session lane equality-tests
    // `schema_version_invalid`.
    expect(await response.json()).toEqual({
      success: false,
      error: "Invalid component sync payload",
      code: DesktopComponentsSyncRestErrorCode.ValidationFailed,
      details: { reason: "schema_version_invalid" },
    });
    expect(mocks.sync).not.toHaveBeenCalled();
  });

  it("returns 500 when the service throws after receiving a valid payload", async () => {
    mocks.sync.mockRejectedValueOnce(new Error("sync exploded"));

    const response = await POST(request(payloadWith(validComponent())), ctx);

    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: "Failed to sync component inventory",
    });
  });

  it("cancels an over-cap body instead of buffering it first", async () => {
    // ISS-7665: the route used to `request.text()` the whole body and measure
    // afterwards, so the 256 KiB cap bounded the response and not the read.
    const endless = countedEndlessBody(SYNC_REQUEST_MAX_BYTES);

    const response = await POST(
      streamRequest(
        `https://api.test/desktop/components/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
        endless.body
      ) as NextRequest,
      ctx
    );

    expect(response.status).toBe(413);
    expect(mocks.sync).not.toHaveBeenCalled();
    expect(endless.cancelled()).toBe(true);
    // ISS-12552: the route sets up its receipt recorder before it reads the
    // body, which gives the stream one more pull turn (see `maxPullForCap`).
    expect(endless.bytesPulled()).toBeLessThanOrEqual(
      maxPullForCap(SYNC_REQUEST_MAX_BYTES, 2)
    );
  });

  it("still accepts a body sitting exactly on the cap", async () => {
    // The paired arm: the cancellation case above passes just as well against a
    // route that refuses everything.
    const component = {
      externalId: "agent::reviewer",
      componentKind: "agent",
      componentKey: "reviewer",
      contentHash: "hash-primary",
      content: "",
    };
    const under = JSON.stringify(payloadWith(component));
    component.content = "x".repeat(SYNC_REQUEST_MAX_BYTES - under.length);

    const body = JSON.stringify(payloadWith(component));
    expect(Buffer.byteLength(body)).toBe(SYNC_REQUEST_MAX_BYTES);

    const response = await POST(
      new NextRequest(
        `https://api.test/desktop/components/sync?computeTargetId=${COMPUTE_TARGET_ID}`,
        { method: "POST", body }
      ),
      ctx
    );

    expect(response.status).toBe(200);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });
});

describe("POST /desktop/components/sync — function ceiling", () => {
  // ISS-8145: the desktop client aborts at 30s, so the function must outlive it
  // or a slow-but-successful sync is killed mid-write. The two sibling desktop
  // sync lanes pin the same value for the same reason.
  it("declares an explicit duration ceiling above the client timeout", () => {
    expect(maxDuration).toBe(60);
  });
});

/** Mirrors the route-private cap; asserted against the real byte count above. */
const SYNC_REQUEST_MAX_BYTES = 262_144;

/**
 * ISS-4965: the usage digest of a raw `skill` body, computed straight from
 * `computeDefinitionHash` so a regression in the production helper cannot move
 * both sides of the comparison at once.
 */
function rawSkillUsageDigest(body: string): string {
  return computeDefinitionHash({
    frontmatter: "",
    body,
    kind: AgentComponentKind.Skill,
  }).definitionHash;
}
