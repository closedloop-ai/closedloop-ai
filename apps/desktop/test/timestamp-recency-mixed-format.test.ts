/**
 * @file timestamp-recency-mixed-format.test.ts
 * @description ISS-6815 regression suite for the desktop reads whose answer is
 * a recency over a TEXT timestamp column.
 *
 * Every fixture here is MIXED-FORMAT on purpose: byte order and time order
 * DISAGREE in it. A single-format fixture passes while the defect is live —
 * that is exactly how ISS-6414 escaped its first review — so each case seeds a
 * whole-second `Z` stamp beside a sub-second one at a LATER instant, plus an
 * extended-offset form, and asserts the later INSTANT wins rather than the
 * larger byte string.
 *
 * Also pinned: the ISS-5497 all-or-nothing fallback. A group holding one
 * un-canonicalizable value (the BASIC-format offset `+0530`, which SQLite
 * cannot parse) must behave EXACTLY as it did before the fix — canonical for
 * every row in a group or raw for every row in it, never a mix.
 */

import assert from "node:assert/strict";
import { afterAll, test } from "vitest";
import { queryIsSkillLoaded } from "../src/main/dashboard/optimization-analytics-queries.js";
import {
  getAgentComponentDetailLocal,
  listAgentComponentsLocal,
} from "../src/main/dashboard/shared-agent-components-api.js";
import { createSqliteDashboardQueries } from "../src/main/database/dashboard-queries.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";
import {
  insertComponent as seedComponent,
  insertUsage as seedUsage,
} from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";

// A whole-second `Z` stamp sorts ABOVE any sub-second stamp in the same second
// (`Z` is 0x5A, `.` is 0x2E) while being the EARLIER instant. `LATER_SUBSECOND`
// is the true maximum of the canonicalizable set below; `EARLIER_WHOLE_SECOND`
// is what a byte-wise MAX returns instead.
const EARLIER_WHOLE_SECOND = "2026-06-22T10:00:00Z";
const LATER_SUBSECOND = "2026-06-22T10:00:00.500Z";
// 03:30Z — an extended-offset form whose wall-clock digits sort ABOVE both of
// the above while its instant is hours EARLIER, so a byte-wise MAX prefers it.
const OFFSET_FORM_EARLIEST = "2026-06-22T09:00:00+05:30";
// SQLite cannot parse the BASIC-format offset, so this value canonicalizes to
// NULL and drops its whole group to the raw byte-wise expression.
const UNPARSEABLE_OFFSET = "2026-06-22T21:00:00.000+0530";
// 18:00Z. Canonicalization LOWERS its text below IMPOSSIBLE_INSTANT's, which is
// what lets a shape-only canonical test rank the impossible value above it.
const OFFSET_FORM_LATER = "2026-06-22T23:00:00+05:00";
// Canonical by SHAPE and not an instant: every field of the canonical glob is a
// bare `[0-9]` class, so minute 60 matches it while `strftime` returns NULL and
// `Date.parse` is NaN.
const IMPOSSIBLE_INSTANT = "2026-06-22T19:60:00.000Z";
// ISS-7663: `EARLIER_WHOLE_SECOND` re-spelled in the canonical fixed-width form.
// The two usage bounds that carry three min/max aggregates project the ranking
// KEY (SQLite's bare-column rule needs exactly one), so a canonical-mode group
// returns this text for the same instant.
const CANONICAL_WHOLE_SECOND = "2026-06-22T10:00:00.000Z";

const openStores: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openStores) {
    await close();
  }
});

async function openStore(): Promise<DesktopPrisma> {
  const { prisma, close } = await openTestPrisma();
  openStores.push(close);
  return prisma;
}

async function insertSession(
  prisma: DesktopPrisma,
  id: string,
  startedAt: string | null,
  cwd: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness, cwd)
       VALUES ($1, $1, 'inactive', $2, $3, 'claude', $4)`,
      id,
      startedAt,
      startedAt ?? LATER_SUBSECOND,
      cwd
    )
  );
}

async function insertToolEvent(
  prisma: DesktopPrisma,
  id: string,
  toolName: string,
  createdAt: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
       VALUES ($1, 's-tools', 'PreToolUse', $2, $3)`,
      id,
      toolName,
      createdAt
    )
  );
}

async function insertUsage(
  prisma: DesktopPrisma,
  sessionId: string,
  componentKey: string,
  lastInvokedAt: string
): Promise<void> {
  await prisma.write((client) =>
    client.$executeRawUnsafe(
      `INSERT INTO agent_component_session_usage
         (session_id, component_kind, component_key, invocations, error_count,
          started_day, last_invoked_at)
       VALUES ($1, 'skill', $2, 1, 0, '2026-06-22', $3)`,
      sessionId,
      componentKey,
      lastInvokedAt
    )
  );
}

// dashboard-queries.getTools — `events.created_at` is raw harness text and the
// FEA-3743 heal never repairs it, so this column carries mixed forms
// indefinitely.
test("ISS-6815 getTools reports the latest INSTANT, not the largest byte string", async () => {
  const prisma = await openStore();
  await insertSession(prisma, "s-tools", LATER_SUBSECOND, "/repo/tools");
  // Bash: every stamp canonicalizes, so the group ranks by instant.
  await insertToolEvent(prisma, "e1", "Bash", EARLIER_WHOLE_SECOND);
  await insertToolEvent(prisma, "e2", "Bash", LATER_SUBSECOND);
  await insertToolEvent(prisma, "e3", "Bash", OFFSET_FORM_EARLIEST);
  // Grep: one un-canonicalizable stamp drops the group to the raw expression.
  await insertToolEvent(prisma, "e4", "Grep", UNPARSEABLE_OFFSET);
  await insertToolEvent(prisma, "e5", "Grep", LATER_SUBSECOND);

  const tools = await createSqliteDashboardQueries(prisma).getTools();
  const byName = new Map(tools.map((tool) => [tool.toolName, tool]));

  // The later instant wins even though its bytes are the SMALLEST of the three.
  assert.equal(byName.get("Bash")?.lastUsedAt, LATER_SUBSECOND);
  // ...and the fix changed only WHICH row won, not the counts beside it.
  assert.equal(byName.get("Bash")?.invocationCount, 3);
  assert.equal(byName.get("Bash")?.sessionCount, 1);
  // The dissenting group keeps the pre-fix byte-wise winner verbatim: raw for
  // every row in it, rather than a canonical value compared against a raw one.
  assert.equal(byName.get("Grep")?.lastUsedAt, UNPARSEABLE_OFFSET);
});

// ISS-6815 (review): the canonical glob is a SHAPE test — every field in it is a
// bare `[0-9]` class — so an impossible instant matches it and, without a VALUE
// check, counts as canonical in the all-or-nothing fold.
test("ISS-6815 an impossible instant is not canonical, so it cannot beat a real one", async () => {
  const prisma = await openStore();
  await insertSession(prisma, "s-tools", LATER_SUBSECOND, "/repo/tools");
  await insertToolEvent(prisma, "e1", "Read", IMPOSSIBLE_INSTANT);
  await insertToolEvent(prisma, "e2", "Read", OFFSET_FORM_LATER);

  const tools = await createSqliteDashboardQueries(prisma).getTools();
  const read = tools.find((tool) => tool.toolName === "Read");

  // Shape alone calls `19:60` canonical, ranks it against the offset form that
  // canonicalization LOWERED to 18:00Z, and reports the impossible value as
  // last used. The value check makes it a dissenter instead, dropping the group
  // to the raw column — where the offset form's bytes win, exactly as on `main`.
  assert.equal(read?.lastUsedAt, OFFSET_FORM_LATER);
  assert.equal(read?.invocationCount, 2);
});

// optimization-analytics-queries.queryIsSkillLoaded —
// `agent_component_session_usage.last_invoked_at` is written from raw parser
// timestamps and is outside the heal.
test("ISS-6815 isSkillLoaded reports the latest INSTANT last used", async () => {
  const prisma = await openStore();
  await insertSession(prisma, "s-a", LATER_SUBSECOND, "/repo/skills");
  await insertSession(prisma, "s-b", LATER_SUBSECOND, "/repo/skills");
  await insertSession(prisma, "s-c", LATER_SUBSECOND, "/repo/skills");
  await insertUsage(prisma, "s-a", "lint", EARLIER_WHOLE_SECOND);
  await insertUsage(prisma, "s-b", "lint", LATER_SUBSECOND);
  await insertUsage(prisma, "s-c", "lint", OFFSET_FORM_EARLIEST);

  const loaded = await queryIsSkillLoaded(prisma, "lint");

  assert.equal(loaded.lastUsedAt, LATER_SUBSECOND);
  assert.equal(loaded.totalInvocations, 3);
});

// The same read's two-mode fallback: one un-canonicalizable usage row drops the
// aggregate back to the raw byte-wise winner, which is what `main` returns.
test("ISS-6815 isSkillLoaded falls back to raw when one usage row cannot be read", async () => {
  const prisma = await openStore();
  await insertSession(prisma, "s-d", LATER_SUBSECOND, "/repo/skills");
  await insertSession(prisma, "s-e", LATER_SUBSECOND, "/repo/skills");
  await insertUsage(prisma, "s-d", "fmt", LATER_SUBSECOND);
  await insertUsage(prisma, "s-e", "fmt", UNPARSEABLE_OFFSET);

  const loaded = await queryIsSkillLoaded(prisma, "fmt");

  assert.equal(loaded.lastUsedAt, UNPARSEABLE_OFFSET);
  assert.equal(loaded.totalInvocations, 2);
});

// ---------------------------------------------------------------------------
// ISS-7663 — the nine `agent_component_session_usage` recency reads in
// shared-agent-components-api.ts. Same column family, same defect: that table's
// `first_invoked_at`/`last_invoked_at` are written from
// MIN/MAX(agent_component_invocations.invoked_at), itself bound from raw
// `agents.started_at`/`events.created_at` outside the FEA-3743 heal.
// ---------------------------------------------------------------------------

// usageAggregateSql — the list's per-identity usage recency, one MAX with the
// raw column bare beside it, so the fix changes WHICH row wins and not the text.
test("ISS-7663 the list's usage recency is the latest INSTANT, not the largest bytes", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    externalId: "ext-lint",
    id: "c-lint",
    key: "lint",
    kind: "skill",
  });
  await seedUsage(prisma, {
    invocations: 1,
    key: "lint",
    kind: "skill",
    lastInvokedAt: EARLIER_WHOLE_SECOND,
    sessionId: "s-a",
  });
  await seedUsage(prisma, {
    invocations: 1,
    key: "lint",
    kind: "skill",
    lastInvokedAt: LATER_SUBSECOND,
    sessionId: "s-b",
  });
  await seedUsage(prisma, {
    invocations: 1,
    key: "lint",
    kind: "skill",
    lastInvokedAt: OFFSET_FORM_EARLIEST,
    sessionId: "s-c",
  });

  const [item] = (await listAgentComponentsLocal(prisma, {})).items;

  // The later instant wins even though its bytes are the SMALLEST of the three,
  // and it keeps its stored text — the bare column takes the winning row's value.
  assert.equal(item?.lastInvokedAt, LATER_SUBSECOND);
  // ...and the fix changed only WHICH row won, not the counts beside it.
  assert.equal(item?.invocations, 3);
  assert.equal(item?.sessions, 3);
});

// unresolvedUsageAggregateSql — three min/max aggregates (both bounds plus the
// harness collapse), so the bare-column rule does not apply and the ranking KEY
// is projected instead. Byte order gets BOTH bounds wrong, in opposite
// directions: byte MIN prefers the sub-second spelling (`.` 0x2E < `Z` 0x5A),
// which is the LATER instant, and byte MAX prefers the whole-second one.
test("ISS-7663 an unresolved identity bounds first/last seen by INSTANT, both ends", async () => {
  const prisma = await openStore();
  // No inventory row — this identity reaches the list through the FEA-3121 fold.
  await seedUsage(prisma, {
    firstInvokedAt: LATER_SUBSECOND,
    invocations: 1,
    key: "orphan",
    kind: "skill",
    lastInvokedAt: LATER_SUBSECOND,
    sessionId: "s-a",
  });
  await seedUsage(prisma, {
    firstInvokedAt: EARLIER_WHOLE_SECOND,
    invocations: 1,
    key: "orphan",
    kind: "skill",
    lastInvokedAt: EARLIER_WHOLE_SECOND,
    sessionId: "s-b",
  });

  const [item] = (await listAgentComponentsLocal(prisma, {})).items;

  assert.equal(item?.firstSeenAt, CANONICAL_WHOLE_SECOND);
  assert.equal(item?.lastSeenAt, LATER_SUBSECOND);
});

// The ISS-5497 two-mode rule on this lane: canonical for EVERY row in the group
// or raw for every row in it, never a mix. One un-canonicalizable stamp drops
// the identity back to the byte-wise winner, which is what shipped.
test("ISS-7663 one unreadable usage stamp drops the identity back to raw", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    externalId: "ext-fmt",
    id: "c-fmt",
    key: "fmt",
    kind: "skill",
  });
  await seedUsage(prisma, {
    invocations: 1,
    key: "fmt",
    kind: "skill",
    lastInvokedAt: LATER_SUBSECOND,
    sessionId: "s-a",
  });
  await seedUsage(prisma, {
    invocations: 1,
    key: "fmt",
    kind: "skill",
    lastInvokedAt: UNPARSEABLE_OFFSET,
    sessionId: "s-b",
  });

  const [item] = (await listAgentComponentsLocal(prisma, {})).items;

  assert.equal(item?.lastInvokedAt, UNPARSEABLE_OFFSET);
  assert.equal(item?.invocations, 2);
});

// buildUnresolvedOnlyDetail — its session ORDER BY is the ranking BETWEEN
// groups, so that window is unpartitioned; its two bounds project the key.
test("ISS-7663 an unresolved detail orders sessions and bounds them by INSTANT", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    firstInvokedAt: EARLIER_WHOLE_SECOND,
    invocations: 1,
    key: "orphan",
    kind: "skill",
    lastInvokedAt: EARLIER_WHOLE_SECOND,
    sessionId: "s-earlier",
  });
  await seedUsage(prisma, {
    firstInvokedAt: LATER_SUBSECOND,
    invocations: 1,
    key: "orphan",
    kind: "skill",
    lastInvokedAt: LATER_SUBSECOND,
    sessionId: "s-later",
  });

  const detail = await getAgentComponentDetailLocal(prisma, "skill::orphan");

  assert.deepEqual(
    detail?.usageSessions?.map((session) => session.sessionId),
    ["s-later", "s-earlier"]
  );
  assert.equal(detail?.firstSeenAt, CANONICAL_WHOLE_SECOND);
  assert.equal(detail?.lastSeenAt, LATER_SUBSECOND);
});

// The resolved detail lane — one MAX with the bare column beside it, and the
// same between-group session ordering. Detail and list must agree, so both are
// pinned against the same pair of stamps.
test("ISS-7663 a resolved detail reports and orders by the latest usage INSTANT", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    externalId: "ext-lint",
    id: "c-lint",
    key: "lint",
    kind: "skill",
  });
  await seedUsage(prisma, {
    invocations: 1,
    key: "lint",
    kind: "skill",
    lastInvokedAt: EARLIER_WHOLE_SECOND,
    sessionId: "s-earlier",
  });
  await seedUsage(prisma, {
    invocations: 1,
    key: "lint",
    kind: "skill",
    lastInvokedAt: LATER_SUBSECOND,
    sessionId: "s-later",
  });

  const detail = await getAgentComponentDetailLocal(prisma, "skill::lint");

  assert.equal(detail?.lastInvokedAt, LATER_SUBSECOND);
  assert.deepEqual(
    detail?.usageSessions?.map((session) => session.sessionId),
    ["s-later", "s-earlier"]
  );
});

// pluginUsageSql / PLUGIN_USAGE_SESSIONS_SQL — a plugin has no usage rows of its
// own, so both its rolled-up recency and its session breakdown come from the
// child-usage join. The rollup partitions by `pack_id` (each plugin's answer
// comes from within its own group); the session list does not (its answer IS
// the ranking between session groups).
test("ISS-7663 a plugin rolls up its children by INSTANT and orders sessions by it", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    externalId: "claude|/x|pack",
    id: "c-plugin",
    key: "pack",
    kind: "plugin",
    packId: "pack",
  });
  await seedComponent(prisma, {
    externalId: "pack-skill",
    id: "c-child",
    key: "pack-nav",
    kind: "skill",
    packId: "pack",
  });
  await seedUsage(prisma, {
    invocations: 1,
    key: "pack-nav",
    kind: "skill",
    lastInvokedAt: EARLIER_WHOLE_SECOND,
    sessionId: "s-earlier",
  });
  await seedUsage(prisma, {
    invocations: 1,
    key: "pack-nav",
    kind: "skill",
    lastInvokedAt: LATER_SUBSECOND,
    sessionId: "s-later",
  });

  const items = (await listAgentComponentsLocal(prisma, {})).items;
  const plugin = items.find((item) => item.kind === "plugin");
  assert.equal(plugin?.lastInvokedAt, LATER_SUBSECOND);

  const detail = await getAgentComponentDetailLocal(prisma, "plugin::pack");
  assert.deepEqual(
    detail?.usageSessions?.map((session) => session.sessionId),
    ["s-later", "s-earlier"]
  );
});

// The session ORDER BY's window is EMPTY, and that is the whole correctness
// argument rather than a shortcut — the same one RECENT_PROJECTS_SQL makes. A
// per-session partition would let `s-canon` (canonicalized DOWN to 18:00Z) be
// ranked against `s-raw`'s un-canonicalizable 21:00+0530 (15:30Z), putting the
// EARLIER session first: worse than the unfixed query, which gets this pair
// right. One dissenter drops the WHOLE ranking to raw instead.
test("ISS-7663 one unreadable stamp drops the WHOLE session ranking to raw", async () => {
  const prisma = await openStore();
  await seedUsage(prisma, {
    invocations: 1,
    key: "orphan",
    kind: "skill",
    lastInvokedAt: OFFSET_FORM_LATER,
    sessionId: "s-canon",
  });
  await seedUsage(prisma, {
    invocations: 1,
    key: "orphan",
    kind: "skill",
    lastInvokedAt: UNPARSEABLE_OFFSET,
    sessionId: "s-raw",
  });

  const detail = await getAgentComponentDetailLocal(prisma, "skill::orphan");

  // Byte-wise over the raw column, which is what `main` returns for this pair.
  assert.deepEqual(
    detail?.usageSessions?.map((session) => session.sessionId),
    ["s-canon", "s-raw"]
  );
});

// The window is an independent argument at EACH call site, so the case above
// pins only `buildUnresolvedOnlyDetail`'s. These are the other two between-group
// rankings — the resolved detail's session query and PLUGIN_USAGE_SESSIONS_SQL.
// An all-canonicalizable fixture cannot tell the two window choices apart (the
// guard's two COUNTs agree under either), so both need the mixed pair: `s-canon`
// canonicalizes DOWN to 18:00Z and would then lose byte-wise to `s-raw`'s
// un-canonicalizable 15:30Z under a per-session partition, putting the EARLIER
// session first.
test("ISS-7663 one unreadable stamp drops the resolved and plugin session rankings to raw", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    externalId: "ext-lint",
    id: "c-lint",
    key: "lint",
    kind: "skill",
  });
  await seedComponent(prisma, {
    externalId: "claude|/x|pack",
    id: "c-plugin",
    key: "pack",
    kind: "plugin",
    packId: "pack",
  });
  await seedComponent(prisma, {
    externalId: "pack-skill",
    id: "c-child",
    key: "pack-nav",
    kind: "skill",
    packId: "pack",
  });
  for (const key of ["lint", "pack-nav"]) {
    await seedUsage(prisma, {
      invocations: 1,
      key,
      kind: "skill",
      lastInvokedAt: OFFSET_FORM_LATER,
      sessionId: "s-canon",
    });
    await seedUsage(prisma, {
      invocations: 1,
      key,
      kind: "skill",
      lastInvokedAt: UNPARSEABLE_OFFSET,
      sessionId: "s-raw",
    });
  }

  // Byte-wise over the raw column, which is what `main` returns for this pair.
  const resolved = await getAgentComponentDetailLocal(prisma, "skill::lint");
  assert.deepEqual(
    resolved?.usageSessions?.map((session) => session.sessionId),
    ["s-canon", "s-raw"]
  );

  const plugin = await getAgentComponentDetailLocal(prisma, "plugin::pack");
  assert.deepEqual(
    plugin?.usageSessions?.map((session) => session.sessionId),
    ["s-canon", "s-raw"]
  );
});

// ---------------------------------------------------------------------------
// ISS-7663 (whitlockk review) — the WINDOW predicate, which runs one step EARLIER
// than everything above: it filters `agent_component_session_usage` inside the
// ranked source's own FROM, so a byte comparison there drops a row BEFORE any
// sort key exists. That is a strictly worse failure than a mis-ranking — the
// row is absent from the result set, so no downstream ordering can recover it.
//
// The pair below is offset-INDEPENDENT: both stamps carry an explicit UTC
// offset, and every parse on both sides of the comparison is absolute (SQLite's
// default parse, applied with no `utc` modifier, and JS `Date.parse`). Neither
// the byte order nor the instant order moves with the host `TZ`, so these cases
// fail on a UTC runner exactly as they fail on a Chicago one.
// ---------------------------------------------------------------------------

// Inclusive lower bound of 10:00Z.
const WINDOW_START = "2026-06-22T10:00:00.000Z";
// 12:00Z — INSIDE the window, but its wall-clock digits (`T07`) sort UNDER the
// bound's (`T10`), so a byte-wise WHERE drops a row that belongs in the result.
const IN_WINDOW_OFFSET_FORM = "2026-06-22T07:00:00-05:00";
// 08:30Z — OUTSIDE the window, and the same defect from the other side: `T14`
// sorts OVER the bound, so a byte-wise WHERE admits a row that does not belong.
const OUT_OF_WINDOW_OFFSET_FORM = "2026-06-22T14:00:00+05:30";

test("ISS-7663 a usage window admits and rejects by INSTANT, not by bytes", async () => {
  const prisma = await openStore();
  for (const key of ["inside", "outside"]) {
    await seedComponent(prisma, {
      externalId: `ext-${key}`,
      id: `c-${key}`,
      key,
      kind: "skill",
    });
  }
  await seedUsage(prisma, {
    invocations: 1,
    key: "inside",
    kind: "skill",
    lastInvokedAt: IN_WINDOW_OFFSET_FORM,
    sessionId: "s-in",
  });
  await seedUsage(prisma, {
    invocations: 1,
    key: "outside",
    kind: "skill",
    lastInvokedAt: OUT_OF_WINDOW_OFFSET_FORM,
    sessionId: "s-out",
  });

  const { items } = await listAgentComponentsLocal(prisma, {
    startDate: WINDOW_START,
  });

  // Byte order inverts BOTH rows: it drops the 12:00Z one and admits the
  // 08:30Z one, so this single fixture pins the predicate in both directions.
  assert.deepEqual(
    items.map((item) => item.slug),
    ["skill::inside"]
  );
  // ...and the surviving row keeps the counts its usage carried.
  assert.equal(items[0]?.invocations, 1);
  assert.equal(items[0]?.sessions, 1);
});

// The null arm, separately: `last_invoked_at` is NULL when a usage row has no
// timestamped invocation, and such a row has no comparable instant, so it
// belongs to NO window. Asserted against the all-time read as well, because a
// component that never appears proves nothing on its own.
test("ISS-7663 a usage row with no invocation instant belongs to no window", async () => {
  const prisma = await openStore();
  await seedComponent(prisma, {
    externalId: "ext-untimed",
    id: "c-untimed",
    key: "untimed",
    kind: "skill",
  });
  await seedUsage(prisma, {
    firstInvokedAt: null,
    invocations: 1,
    key: "untimed",
    kind: "skill",
    lastInvokedAt: null,
    sessionId: "s-untimed",
  });

  // All-time: the component is present and its usage counts.
  const allTime = await listAgentComponentsLocal(prisma, {});
  assert.equal(allTime.items[0]?.slug, "skill::untimed");
  assert.equal(allTime.items[0]?.invocations, 1);

  // Windowed: the untimed row is in neither the lower- nor the upper-bounded
  // window, so the component drops out of both rather than being admitted by a
  // predicate that widened far enough to let a NULL through.
  assert.deepEqual(
    (await listAgentComponentsLocal(prisma, { startDate: WINDOW_START })).items,
    []
  );
  assert.deepEqual(
    (await listAgentComponentsLocal(prisma, { endDate: WINDOW_START })).items,
    []
  );
});
