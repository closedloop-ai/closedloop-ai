/**
 * ISS-9479 — the desktop Sessions sort orders null and text keys the way the
 * cloud and the ISS-9585 ruling do: no model, or a Cost cell with no figure,
 * LAST in both directions, and text ranked by the pinned collation rather than
 * the host's locale.
 */
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  SyncedAgentSession,
  SyncedAgentSessionTokenUsage,
} from "../src/main/agent-sync/agent-session-sync-contract.js";
import { sortSyncedSessions } from "../src/main/session/session-working-set-sort.js";
import type { SanitizedQuery } from "../src/main/session/shared-agent-sessions-query.js";
import type { BillingMode } from "../src/shared/billing-mode.js";
import { sessionSortQuery } from "./helpers/session-sort-query.js";

const DIRECTIONS = ["asc", "desc"] as const;
const SUBSCRIPTION_MODE = "max_5x" satisfies BillingMode;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Sessions sort null and text keys (ISS-9479)", () => {
  it.each(DIRECTIONS)("keeps a session with no model last, %s", (sortDir) => {
    const sessions = [
      session("no-model", { model: null }),
      session("alpha", { model: "alpha" }),
      session("beta", { model: "beta" }),
    ];

    const sorted = ids(sortSyncedSessions(sessions, sortBy("model", sortDir)));

    expect(sorted.at(-1)).toBe("no-model");
  });

  // The cell's own rule decides the blank: a $0.00 subscription session is a
  // figure, a partly priced one shows its sum, a session with no work shows none.
  it.each(DIRECTIONS)(
    "keeps a session whose Cost cell shows no figure last, %s",
    (sortDir) => {
      const sessions = [
        session("no-figure", { tokenUsageByModel: [] }),
        session("subscription-zero", {
          billingMode: SUBSCRIPTION_MODE,
          turns: 3,
          tokenUsageByModel: [usage(0)],
        }),
        session("partly-priced", {
          tokenUsageByModel: [usage(5), usage(undefined)],
        }),
        session("priced", { tokenUsageByModel: [usage(2)] }),
      ];

      const sorted = ids(sortSyncedSessions(sessions, sortBy("cost", sortDir)));

      expect(sorted).toEqual(
        sortDir === "asc"
          ? ["subscription-zero", "priced", "partly-priced", "no-figure"]
          : ["partly-priced", "priced", "subscription-zero", "no-figure"]
      );
    }
  );

  // A host whose locale ranks text backwards: a bare `localeCompare()` would
  // follow it, the pinned collation does not.
  it.each(["model", "harness", "repo"])(
    "ranks %s text by the pinned collation, not the host locale",
    (column) => {
      const hostCompare = String.prototype.localeCompare;
      vi.spyOn(String.prototype, "localeCompare").mockImplementation(
        function reversed(this: string, other: string) {
          return -hostCompare.call(this, other);
        }
      );
      const sessions = [
        session("beta", textFields("beta")),
        session("alpha", textFields("alpha")),
      ];

      expect(ids(sortSyncedSessions(sessions, sortBy(column, "asc")))).toEqual([
        "alpha",
        "beta",
      ]);
    }
  );
});

function textFields(value: string): Partial<SyncedAgentSession> {
  return {
    model: value,
    harness: value,
    attribution: { repositoryFullName: `org/${value}` },
  };
}

function sortBy(column: string, sortDir: "asc" | "desc"): SanitizedQuery {
  return sessionSortQuery(column, sortDir);
}

function session(
  externalSessionId: string,
  overrides: Partial<SyncedAgentSession>
): SyncedAgentSession {
  return {
    externalSessionId,
    status: SESSION_STATUS.INACTIVE,
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...overrides,
  };
}

/** One token-usage row; an `undefined` cost is a row nothing priced. */
function usage(
  estimatedCostUsd: number | undefined
): SyncedAgentSessionTokenUsage {
  return {
    model: "opus",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
}

function ids(sessions: SyncedAgentSession[]): string[] {
  return sessions.map((entry) => entry.externalSessionId);
}
