/**
 * ISS-8880 §3a — `targetKind` on the promote route.
 *
 * `catalog_items.target_kind` is a key column of
 * `@@index([organizationId, targetKind])`, so a multi-kilobyte value raised
 * SQLSTATE 54000 at INSERT and came back as a 500. The field was free text.
 *
 * It is now BOUNDED, not enumerated, and these cases are why. The shipped
 * Promote button sends the component's own `AgentComponentKind`, which is a
 * wider set than the catalog's seven kinds; and `agent_components.component_kind`
 * is a free-form String whose cloud ingest bounds only its length, so a desktop
 * shipping a kind this repo does not list yet can legitimately reach here. An
 * enum — of either set, or their union — would 400 those.
 */

import {
  POSTGRES_INT4_MAX,
  POSTGRES_INT4_MIN,
} from "@closedloop-ai/loops-api/column-limits";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { SYNCED_COMPONENT_IDENTITY_MAX_CHARS } from "@repo/api/src/types/agent-session";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authContext: {
    clerkOrgId: "clerk-org-1",
    clerkUserId: "clerk-user-1",
    user: { id: "user-1", organizationId: "org-1" },
  },
  promoteAgentComponent: vi.fn(),
  requireOrgAdmin: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (...args: unknown[]) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(mocks.authContext, request),
}));

vi.mock("@/lib/auth/org-admin", () => ({
  requireOrgAdmin: mocks.requireOrgAdmin,
}));

vi.mock("../promote/service", () => ({
  promoteAgentComponent: mocks.promoteAgentComponent,
}));

import { POST } from "../promote/route";

const COMPONENT_ID = "0199a000-0000-7000-8000-000000000401";

/** The seven kinds the catalog route's own enum allows. */
const CATALOG_KINDS = [
  "pack",
  "plugin",
  "skill",
  "command",
  "agent",
  "hook",
  "mcp",
] as const;

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/agent-components/promote", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function promote(overrides: Record<string, unknown> = {}) {
  return POST(
    request({ agentComponentId: COMPONENT_ID, ...overrides }),
    undefined as never
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireOrgAdmin.mockResolvedValue(null);
  mocks.promoteAgentComponent.mockResolvedValue({
    ok: true,
    response: { catalogItemId: "c-1", distributionId: "d-1" },
  });
});

describe("§3a promote targetKind — accepts every kind the system produces", () => {
  it.each(CATALOG_KINDS)("accepts the catalog kind %s", async (targetKind) => {
    const response = await promote({ targetKind });

    expect(response.status).toBe(200);
    expect(mocks.promoteAgentComponent).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind }),
      undefined
    );
  });

  it.each(Object.values(AgentComponentKind))(
    "accepts the component kind %s, which the Promote button sends verbatim",
    async (targetKind) => {
      const response = await promote({ targetKind });

      expect(response.status).toBe(200);
    }
  );

  it("accepts a kind this repo does not list, as a version-skewed desktop can emit one", async () => {
    // `component_kind` is a free-form String on ingest and the read path casts
    // it, so a newer desktop's kind reaches the UI and is forwarded here. An
    // enum would 400 it; the bound must not.
    const response = await promote({ targetKind: "subagent-v2" });

    expect(response.status).toBe(200);
    expect(mocks.promoteAgentComponent).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: "subagent-v2" }),
      undefined
    );
  });

  it("still promotes with targetKind OMITTED, leaving the service fallback intact", async () => {
    const response = await promote({});

    expect(response.status).toBe(200);
    expect(mocks.promoteAgentComponent).toHaveBeenCalledWith(
      expect.objectContaining({ targetKind: undefined }),
      undefined
    );
  });
});

describe("§3a promote targetKind — refuses what would break the btree", () => {
  it("refuses a 3000-character value without reaching the service", async () => {
    const response = await promote({ targetKind: "x".repeat(3000) });

    expect(response.status).toBe(400);
    expect(mocks.promoteAgentComponent).not.toHaveBeenCalled();
  });

  it("accepts every kind the sync ingest can store, and refuses one past it", async () => {
    // The bound is `SYNCED_COMPONENT_IDENTITY_MAX_CHARS`, not a number picked
    // here. The Promote button forwards `component.componentKind` verbatim, so
    // a lower bound would 400 a component the desktop legitimately synced — a
    // valid-input refusal. Since ISS-8201 the ingest PARSER caps nothing; what
    // keeps every stored kind inside this cap is the write-side projection to
    // `INDEX_KEY_MAX_BYTES` (512 BYTES, so at most 512 characters). This pair is
    // what catches a regression: a bound of 64 makes the at-limit case go red.
    const atIngestLimit = "k".repeat(SYNCED_COMPONENT_IDENTITY_MAX_CHARS);

    const accepted = await promote({ targetKind: atIngestLimit });

    expect(accepted.status).toBe(200);
    expect(mocks.promoteAgentComponent).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetKind: atIngestLimit }),
      undefined
    );

    mocks.promoteAgentComponent.mockClear();

    const refused = await promote({
      targetKind: "k".repeat(SYNCED_COMPONENT_IDENTITY_MAX_CHARS + 1),
    });

    expect(refused.status).toBe(400);
    expect(mocks.promoteAgentComponent).not.toHaveBeenCalled();
  });

  it("still accepts an empty kind and a padded one, unchanged", async () => {
    // `body.targetKind` lands verbatim in `catalogItem.create`, so a `.trim()`
    // would rewrite a persisted index-key value and a `.min(1)` would refuse
    // what today's bare `z.string()` accepts. This ticket bounds the btree
    // hazard only — neither of those is an invalid-input refusal.
    await expect(promote({ targetKind: "" })).resolves.toMatchObject({
      status: 200,
    });

    await promote({ targetKind: "  skill  " });

    expect(mocks.promoteAgentComponent).toHaveBeenLastCalledWith(
      expect.objectContaining({ targetKind: "  skill  " }),
      undefined
    );
  });
});

describe("§3a promote sortOrder", () => {
  it.each([POSTGRES_INT4_MAX + 1, 1e21, POSTGRES_INT4_MIN - 1, -1e21])(
    "refuses %d without reaching the service",
    async (sortOrder) => {
      const response = await promote({ sortOrder });

      expect(response.status).toBe(400);
      expect(mocks.promoteAgentComponent).not.toHaveBeenCalled();
    }
  );

  // `-1` moved from the refuse set to this one, and the inversion is the point:
  // this route accepted a negative before ISS-8880 and stored it in a column
  // that holds it, so a `.min(0)` was a new refusal of valid input. The catalog
  // route's own `.min(0)` predates this ticket and is deliberately untouched —
  // covered as a pair in `catalog/__tests__/int4-and-target-kind-bounds`.
  it.each([-1, 0, POSTGRES_INT4_MAX, POSTGRES_INT4_MIN])(
    "still accepts %d",
    async (sortOrder) => {
      const response = await promote({ sortOrder });

      expect(response.status).toBe(200);
      expect(mocks.promoteAgentComponent).toHaveBeenCalledWith(
        expect.objectContaining({ sortOrder }),
        undefined
      );
    }
  );
});
