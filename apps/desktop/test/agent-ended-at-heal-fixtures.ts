/**
 * @file agent-ended-at-heal-fixtures.ts
 * @description ISS-7069: the corpus shapes and test doubles the three
 * `agent-ended-at-heal-*` suites share.
 *
 * THREE FIXTURE DISCIPLINES live here, each closing a false-green those suites
 * would otherwise have:
 *
 *  - Events whose TEXTUAL max and CHRONOLOGICAL max are DIFFERENT ROWS. A
 *    single-encoding fixture passes under both the broken and the fixed
 *    derivation and proves nothing.
 *  - A SUBAGENT in the corpus. A main-agent-only fixture cannot distinguish this
 *    repair from the reimport path that already exists.
 *  - At least one agent whose STORED `ended_at` is itself non-canonical. Every
 *    other fixture stores canonical text, which makes the canonicalization of
 *    the stored operand the identity — so without this shape, comparing the fold
 *    against a bare `ended_at` column keeps every suite green while silently
 *    dropping the whole positive-offset half of the corrupted population.
 */
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { DESKTOP_AGENT_STATUS } from "../src/main/database/db-constants.js";
import type { openTestPrisma } from "./prisma-test-utils.js";
import {
  getSession,
  type Store,
  seedAgent,
  seedAgentEvent,
  seedSession,
} from "./session-sweep-fixtures.js";

export const AGENT_STARTED_AT = "2026-06-22T05:00:00.000Z";
export const OLD_UPDATED_AT = "2026-06-20T00:00:00.000Z";

/*
 * The reported reproduction. `2026-06-22T09:30:00-05:00` is 14:30Z — 4.5h AFTER
 * `2026-06-22T10:00:00.000Z` — yet its raw text sorts BELOW it, so the pre-fix
 * byte-wise `MAX(e.created_at)` stored the 10:00Z value and shortened the
 * agent's duration by 4.5 hours.
 */
export const LATER_OFFSET_EVENT = "2026-06-22T09:30:00-05:00";
export const EARLIER_CANONICAL_EVENT = "2026-06-22T10:00:00.000Z";
/** What the pre-ISS-6893 sweep persisted for the pair above: the byte-wise winner. */
export const BYTE_WISE_ENDED_AT = EARLIER_CANONICAL_EVENT;
/** What the chronological fold returns for the pair above. */
export const CHRONOLOGICAL_ENDED_AT = "2026-06-22T14:30:00.000Z";

/*
 * The OTHER half of the defect shape, and the one a canonical-only corpus hides.
 * `agents.ended_at` is outside `HEALED_COLUMNS`, and the pre-fix sweep copied the
 * byte-wise-winning RAW text into it — so when the byte-wise winner is a
 * positive-offset form, the STORED value is itself non-canonical AND the wrong
 * instant. `…T20:00:00+05:30` is 14:30Z but sorts ABOVE `…T18:00:00.000Z`
 * (18:00Z), so the old fold picked it and stored it verbatim.
 *
 * This shape serves BOTH non-canonical operands of the fold: used as an
 * `ended_at` it exercises the stored side, and used as an agent's `started_at`
 * it exercises the floor operand that no event encoding can reveal.
 */
export const OFFSET_STORED_ENDED_AT = "2026-06-22T20:00:00+05:30";
export const LATER_CANONICAL_EVENT = "2026-06-22T18:00:00.000Z";

/**
 * SQLite cannot parse the BASIC-format offset even though V8 can, so ONE of
 * these among an agent's events drops that agent's whole fold to legacy mode.
 */
export const UNCANONICALIZABLE = "2026-06-22T21:00:00.000+0530";

export const UNREADABLE_LOG_RE = /un-canonicalizable stored ended_at/;
export const LEGACY_LOG_RE = /fold in legacy mode and could not be judged/;
export const FAILED_CHUNK_LOG_RE = /agent ended_at heal failed for chunk/;
export const RETRY_NEXT_BOOT_LOG_RE = /chunk\(s\) failed, will retry next boot/;

export const noopLog = () => {
  /* no failures expected */
};

export type TestPrisma = Awaited<ReturnType<typeof openTestPrisma>>["prisma"];

/** A terminal session old enough that any bump of it is visible. */
export async function seedInactiveSession(
  store: Store,
  id: string
): Promise<void> {
  await seedSession(
    store,
    id,
    SESSION_STATUS.INACTIVE,
    OLD_UPDATED_AT,
    OLD_UPDATED_AT,
    AGENT_STARTED_AT
  );
}

/**
 * One terminal session holding an already-swept `main` agent and an already-swept
 * SUBAGENT, both carrying the byte-wise `ended_at` and both owning the same
 * mixed-encoding event pair on their OWN events.
 */
export async function seedSweptRun(store: Store): Promise<void> {
  await seedInactiveSession(store, "run");
  // `subagent` is the literal `agents.type` the parser and the live-hook
  // spawner both write (write-core.ts), so the subagent row here is the shape
  // the reimport path actually keys on.
  for (const [agentId, type] of [
    ["main-agent", "main"],
    ["sub-agent", "subagent"],
  ] as const) {
    await seedAgent(
      store,
      agentId,
      "run",
      DESKTOP_AGENT_STATUS.COMPLETED,
      AGENT_STARTED_AT,
      type,
      BYTE_WISE_ENDED_AT
    );
    await seedMixedEncodingEvents(store, "run", agentId);
  }
}

/** One terminal, already-swept agent per suffix, each in its own session. */
export async function seedSweptSoloAgents(
  store: Store,
  suffixes: readonly string[]
): Promise<void> {
  for (const suffix of suffixes) {
    await seedInactiveSession(store, `run-${suffix}`);
    await seedSweptAgentIn(
      store,
      `run-${suffix}`,
      `worker-${suffix}`,
      DESKTOP_AGENT_STATUS.COMPLETED,
      BYTE_WISE_ENDED_AT,
      false
    );
  }
}

/**
 * One agent owning the mixed-encoding event pair, seeded into `sessionId`
 * (creating that session unless `withSession` is false).
 */
export async function seedSweptAgentIn(
  store: Store,
  sessionId: string,
  agentId: string,
  status: string,
  endedAt: string,
  withSession = true
): Promise<void> {
  // Callers may seed SEVERAL agents into one session, so this is create-if-absent
  // rather than create.
  if (withSession && !(await getSession(store, sessionId))) {
    await seedInactiveSession(store, sessionId);
  }
  await seedAgent(
    store,
    agentId,
    sessionId,
    status,
    AGENT_STARTED_AT,
    "main",
    endedAt
  );
  await seedMixedEncodingEvents(store, sessionId, agentId);
}

/**
 * The event pair whose textual and chronological maxima are DIFFERENT ROWS —
 * the only pair that can tell the byte-wise fold apart from the canonical one.
 */
export async function seedMixedEncodingEvents(
  store: Store,
  sessionId: string,
  agentId: string
): Promise<void> {
  await seedAgentEvent(
    store,
    `${agentId}-ev-0`,
    sessionId,
    agentId,
    EARLIER_CANONICAL_EVENT
  );
  await seedAgentEvent(
    store,
    `${agentId}-ev-1`,
    sessionId,
    agentId,
    LATER_OFFSET_EVENT
  );
}

/**
 * A pass-through proxy whose `write` rejects on the Nth call and delegates on
 * every other, so per-chunk error isolation can be driven for real.
 */
export function failWriteOnCall(
  prisma: TestPrisma,
  failOn: number
): TestPrisma {
  let calls = 0;
  return proxyWrite(prisma, (target, run) => {
    calls += 1;
    return calls === failOn
      ? Promise.reject(new Error("forced chunk failure"))
      : target.write(run);
  });
}

/**
 * A pass-through proxy that runs `mutate` once, immediately BEFORE the first
 * repair transaction — i.e. inside the real discovery→write window.
 */
export function mutateBeforeWrite(
  prisma: TestPrisma,
  mutate: () => Promise<void>
): TestPrisma {
  let mutated = false;
  return proxyWrite(prisma, async (target, run) => {
    if (!mutated) {
      mutated = true;
      await mutate();
    }
    return target.write(run);
  });
}

type WriteRun = Parameters<TestPrisma["write"]>[0];

/** The shared proxy both write doubles are: intercept `write`, pass the rest. */
function proxyWrite(
  prisma: TestPrisma,
  onWrite: (target: TestPrisma, run: WriteRun) => Promise<unknown>
): TestPrisma {
  return new Proxy(prisma, {
    get(target, property) {
      if (property === "write") {
        return (run: WriteRun) => onWrite(target, run);
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
