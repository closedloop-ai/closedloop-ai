import type { SyncLane } from "@closedloop-ai/telemetry-contract/sync";
import { withDb } from "@repo/database";
import { log } from "@repo/observability/log";
import type { AuthContext } from "@/lib/auth/with-auth";

/**
 * ISS-11426 — why a sync lane's `findOwnedById` missed, classified from the
 * row itself, so Datadog alone can say which of the two suspected paths
 * produces the `target_not_owned` refusals (operator, 2026-10-05: "let's add
 * the telemetry to know whether it's 1 or 2"):
 *
 * - path 1, the target drifted orgs: `register` upserts on
 *   `(userId, machineName)` and keeps the existing row's org, so a hello
 *   authenticated in org B can ack the same user's org-A row. Reads here as
 *   `target_org_mismatch` with the relay hello's org equal to the HTTP org.
 * - path 2, the credentials split orgs: the socket authenticates with the
 *   desktop API key while the HTTP lanes send the access token first. Also
 *   `target_org_mismatch`, but with the relay hello's org equal to the
 *   TARGET's org — the hello log (`Relay hello processed`) carries that org per
 *   `computeTargetId`, which is the join.
 *
 * Telemetry only: it never changes the refusal. The read is one primary-key
 * point read on the refusal path alone, and any failure of it is reported as
 * `unknown` rather than thrown into the lane.
 *
 * Bounded (`apps/api/AGENTS.md` → Emission and Abuse Control): an
 * authenticated caller drives this path, and one install produced 5,131
 * refusals in two days. At most one line and one read per
 * `(organizationId, computeTargetId, lane, authMethod)` per window per
 * instance — lane and credential are in the key so neither breakdown loses a
 * race to the other — and the lines in between are counted into the next one's
 * `suppressedCount`. An org also has a budget of lines (and so reads) per
 * window across all its keys, because a caller can name any number of
 * nonexistent targets; what the budget drops is counted into that org's next
 * line as `orgSuppressedCount`.
 */
export async function reportComputeTargetOwnershipRefusal(input: {
  lane: SyncLane;
  computeTargetId: string;
  organizationId: string;
  userId: string;
  authMethod?: AuthContext["authMethod"];
}): Promise<void> {
  const admitted = ownershipRefusalThrottle.admit(
    input.organizationId,
    [
      input.organizationId,
      input.computeTargetId,
      input.lane,
      input.authMethod ?? "",
    ].join(":"),
    Date.now()
  );
  if (admitted === null) {
    return;
  }
  const { target, readFailed } = await readTargetOwner(input.computeTargetId);
  log.warn(COMPUTE_TARGET_OWNERSHIP_REFUSED_EVENT, {
    ...admitted,
    lane: input.lane,
    computeTargetId: input.computeTargetId,
    organizationId: input.organizationId,
    userId: input.userId,
    // Absent when the caller predates the field; never guessed.
    ...(input.authMethod ? { authMethod: input.authMethod } : {}),
    targetOrganizationId: target?.organizationId ?? null,
    targetUserId: target?.userId ?? null,
    classification: readFailed
      ? ComputeTargetOwnershipRefusalClassification.Unknown
      : classifyOwnershipRefusal(input, target),
  });
}

/**
 * ISS-11426 path 1's smoking gun, from the hello: `register` handed back a row
 * owned by a different org than the socket authenticated under. Nothing about
 * the ack changes here; this only records that it happened.
 */
export function reportRegisteredTargetOrgMismatch(input: {
  computeTargetId: string;
  organizationId: string;
  userId: string;
  targetOrganizationId: string;
  targetUserId: string;
}): void {
  if (input.targetOrganizationId === input.organizationId) {
    return;
  }
  // Throttled like the refusal: a repeated hello with the same mismatched
  // registration would otherwise log every time, and hello is not rate limited.
  const admitted = registerMismatchThrottle.admit(
    input.organizationId,
    `${input.organizationId}:${input.computeTargetId}`,
    Date.now()
  );
  if (admitted === null) {
    return;
  }
  log.warn(COMPUTE_TARGET_REGISTER_ORG_MISMATCH_EVENT, {
    ...admitted,
    computeTargetId: input.computeTargetId,
    organizationId: input.organizationId,
    userId: input.userId,
    targetOrganizationId: input.targetOrganizationId,
    targetUserId: input.targetUserId,
  });
}

export const COMPUTE_TARGET_OWNERSHIP_REFUSED_EVENT =
  "compute_target.ownership_refused" as const;

export const COMPUTE_TARGET_REGISTER_ORG_MISMATCH_EVENT =
  "compute_target.register_org_mismatch" as const;

export const ComputeTargetOwnershipRefusalClassification = {
  TargetOrgMismatch: "target_org_mismatch",
  TargetUserMismatch: "target_user_mismatch",
  TargetMissing: "target_missing",
  Unknown: "unknown",
} as const;
export type ComputeTargetOwnershipRefusalClassification =
  (typeof ComputeTargetOwnershipRefusalClassification)[keyof typeof ComputeTargetOwnershipRefusalClassification];

type TargetOwner = { organizationId: string; userId: string };

async function readTargetOwner(
  computeTargetId: string
): Promise<{ target: TargetOwner | null; readFailed: boolean }> {
  try {
    const target = await withDb((db) =>
      db.computeTarget.findUnique({
        where: { id: computeTargetId },
        select: { organizationId: true, userId: true },
      })
    );
    return { target, readFailed: false };
  } catch {
    return { target: null, readFailed: true };
  }
}

function classifyOwnershipRefusal(
  caller: { organizationId: string; userId: string },
  target: TargetOwner | null
): ComputeTargetOwnershipRefusalClassification {
  if (!target) {
    return ComputeTargetOwnershipRefusalClassification.TargetMissing;
  }
  if (target.userId !== caller.userId) {
    return ComputeTargetOwnershipRefusalClassification.TargetUserMismatch;
  }
  if (target.organizationId !== caller.organizationId) {
    return ComputeTargetOwnershipRefusalClassification.TargetOrgMismatch;
  }
  // Owned after all: the row moved between the ownership check and this read.
  return ComputeTargetOwnershipRefusalClassification.Unknown;
}

const REFUSAL_EMISSION_WINDOW_MS = 60_000;
const REFUSAL_EMISSION_MAX_KEYS = 1000;
/** Lines (and, for the refusal, point reads) per org per window. */
const REFUSAL_EMISSION_ORG_BUDGET = 20;

type EmissionWindow = { windowStartedAt: number; suppressed: number };
type OrgBudgetWindow = EmissionWindow & { emitted: number };
type AdmittedEmission = { suppressedCount: number; orgSuppressedCount: number };

/**
 * Per-key windows plus a per-org budget. Both maps are insertion-ordered and
 * capped, evicting the oldest window first.
 */
function createEmissionThrottle() {
  const keyWindows = new Map<string, EmissionWindow>();
  const orgWindows = new Map<string, OrgBudgetWindow>();
  return {
    /**
     * Null when the line is dropped (counted against its key's open window or
     * its org's spent budget); otherwise what was dropped since the last line.
     */
    admit(org: string, key: string, now: number): AdmittedEmission | null {
      const open = keyWindows.get(key);
      if (open && isOpen(open, now)) {
        open.suppressed += 1;
        return null;
      }
      const budget = currentOrgWindow(orgWindows, org, now);
      if (budget.emitted >= REFUSAL_EMISSION_ORG_BUDGET) {
        budget.suppressed += 1;
        return null;
      }
      budget.emitted += 1;
      const orgSuppressedCount = budget.suppressed;
      budget.suppressed = 0;
      setCapped(keyWindows, key, { windowStartedAt: now, suppressed: 0 });
      return { suppressedCount: open?.suppressed ?? 0, orgSuppressedCount };
    },
    reset(): void {
      keyWindows.clear();
      orgWindows.clear();
    },
  };
}

function isOpen(window: EmissionWindow, now: number): boolean {
  return now - window.windowStartedAt < REFUSAL_EMISSION_WINDOW_MS;
}

/** The org's budget window, rolled over (carrying its dropped count) when stale. */
function currentOrgWindow(
  orgWindows: Map<string, OrgBudgetWindow>,
  org: string,
  now: number
): OrgBudgetWindow {
  const existing = orgWindows.get(org);
  if (existing && isOpen(existing, now)) {
    return existing;
  }
  const fresh: OrgBudgetWindow = {
    windowStartedAt: now,
    emitted: 0,
    suppressed: existing?.suppressed ?? 0,
  };
  setCapped(orgWindows, org, fresh);
  return fresh;
}

function setCapped<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  if (map.size >= REFUSAL_EMISSION_MAX_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
  map.set(key, value);
}

const ownershipRefusalThrottle = createEmissionThrottle();
const registerMismatchThrottle = createEmissionThrottle();

/** Test seam: the throttles are module state, so each case starts from empty. */
export function resetOwnershipRefusalEmissionWindowsForTest(): void {
  ownershipRefusalThrottle.reset();
  registerMismatchThrottle.reset();
}
