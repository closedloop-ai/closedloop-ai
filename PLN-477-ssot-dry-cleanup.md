# PLN-477 — SSOT & DRY Cleanup Plan

Follow-up to PR #1079 ("Prevent duplicate active loops per (artifact, command)"). The duplicate-active-loop fix is correct in shape but introduced (and inherited) several SSOT and DRY violations across `apps/api/app/loops/service.ts`, the run-loop route, and shared test fixtures. This plan enumerates each violation, the concrete risk, and the proposed fix.

## Scope

In scope:
- `apps/api/app/loops/service.ts`
- `apps/api/app/loops/loop-error-responses.ts`
- `apps/api/app/loops/route.ts`
- `apps/api/app/loops/[id]/resume/route.ts`
- `apps/api/app/documents/[id]/run-loop/route.ts`
- `apps/api/__tests__/fixtures/loop.ts`
- `apps/api/__tests__/fixtures/prisma-errors.ts`
- `apps/api/__tests__/unit/find-active-plan-loop.test.ts`
- `apps/api/__tests__/unit/loops-service-concurrent-limit.test.ts`
- `packages/database/prisma/migrations/20260505111856_replace_loop_active_index_drop_artifact_version/migration.sql` (read-only — referenced as the upstream SSOT for "active")

Out of scope:
- Changing the migration definition of "active loop". The DB-level partial unique index is treated as the authoritative source; application code is realigned to it.
- Frontend handling of the `loop_already_active` body.
- Behavior changes beyond making the existing contract consistent.

---

## Findings

### S1 — Three competing definitions of "active loop"  *(SSOT, high-impact)*

**Locations.**
- DB partial unique index: `packages/database/prisma/migrations/.../migration.sql:33` — `status IN ('PENDING','CLAIMED','RUNNING') AND command <> 'CHAT'`, no staleness clause.
- App lookup `findActiveLoopForDocumentAndCommand`: `apps/api/app/loops/service.ts:1483-1497` — `RUNNING ∪ (CLAIMED ∧ containerId≠null) ∪ (PENDING ∧ containerId=null ∧ age<30 s)`.
- Concurrency-count and write-side guards: `service.ts:381-389`, `:726`, `:911-920`, `:1541` (raw SQL), `:1562` — `[Pending, Claimed, Running]`, no staleness.

**Why the predicates are not the same set.** The two write-side users (DB index, concurrency count) match exactly. The pre-insert gate is *strictly narrower*: it removes three sub-shapes the developer treats as orphan-or-transient and therefore not worth blocking on:
- `CLAIMED ∧ containerId=null` — transient state during dispatch.
- `PENDING ∧ containerId≠null` — never produced by the happy path; possible after `persistLaunchInfo` raced ahead of `updateStatus`.
- `PENDING ∧ containerId=null ∧ age≥30 s` — silently-failed dispatch, swept by `reapStalePendingLoops`.

This narrowness *cannot* be lifted into the DB index. Postgres partial-index `WHERE` clauses are immutable expressions evaluated against the row at write time; they cannot reference `now()` or compute "younger than 30 s." So the database is structurally forced to enforce a looser predicate than the application's intent. The asymmetry is not a bug to delete — it's a consequence of where the check runs.

**The bug this creates.** The P2002 backstop in `loopsService.create` (`service.ts:440-466`) and `loopsService.resume` (`:971-998`) translates a unique-index violation into `LoopAlreadyActiveError` by re-running `findActiveLoopForDocumentAndCommand`. When the colliding row matches the index but falls into one of the three sub-shapes excluded by the staleness predicate, the lookup returns `null`, the catch block re-throws raw `P2002`, and `handleLoopServiceError` falls through to a generic 500. The contract promised in the PR description ("two concurrent run-loop calls produce one 200 + one 409 with `loop_already_active`") silently downgrades to "one 200 + one 500" exactly when the colliding row is in the gap between the two predicates.

**Resolution: name two tiers explicitly, with the reap step bridging them.**

| Tier | Predicate | Authoritative for | Used by |
|---|---|---|---|
| **Index-blocking** | `status ∈ {PENDING, CLAIMED, RUNNING} ∧ command ≠ CHAT` | What the DB physically refuses to duplicate. Mirrors the partial unique index. | `db.loop.create` outcomes; P2002 → 409 translation; concurrency quota; `persistLaunchInfo` / `updateMetadata` write guards. |
| **Operationally active** | RUNNING ∪ (CLAIMED ∧ containerId≠null) ∪ (PENDING ∧ containerId=null ∧ age<`STALE_PENDING_THRESHOLD_MS`) | What a human reader of the UI would call "a loop is running on this document." | Pre-insert gate; UI status badges. |

Invariant: any row in *index-blocking* but not in *operationally active* is an orphan and must be removed by `reapStalePendingLoops` so the DB-level constraint stops blocking new work. The reap step is the named mechanism that keeps the two tiers eventually consistent — not a magic mitigation.

**Why this and not "collapse to one definition":**
- *Collapsing to the index predicate (drop staleness)* would make orphan rows permanent blockers from any path that doesn't run reap, and remove the UX-friendly behavior of treating CLAIMED-no-containerId as transient. It's a behavior regression dressed up as cleanup.
- *Collapsing to the staleness predicate* is structurally impossible: Postgres can't enforce it. Pretending it can is what produced the current bug.
- *Two named tiers* is honest about the constraint, makes each call site's intent explicit, and reduces the SSOT problem to a small testable invariant.

**Fix.**
1. Add a module-level constant `ACTIVE_LOOP_STATUSES` (see D5) documented as the in-app mirror of the migration's partial unique index. All write-side guards and the concurrency count use this.
2. Rename and re-document the existing app lookup to make its narrowness explicit. Suggested rename: `findActiveLoopForDocumentAndCommand` → `findOperationallyActiveLoop`. Add a sibling `findIndexBlockingLoop` (no staleness filter) used by the post-P2002 catch path.
3. In `createLoopWithActiveGate` (see D3): the pre-insert gate calls `findOperationallyActiveLoop`; the catch path calls `findIndexBlockingLoop`. The catch path can therefore always populate the structured 409 body — whichever tier the colliding row sits in.
4. Narrow the catch's P2002 handling to the loops index by name (`loops_active_artifact_command_key`, available in `Prisma.PrismaClientKnownRequestError.meta`) so a P2002 raised by an unrelated unique constraint (e.g. event idempotency at `service.ts:1080`) still surfaces unchanged. See "Risks & rollback".
5. Decide explicitly: does the per-user concurrency quota count orphan rows? Recommendation: **yes — use `ACTIVE_LOOP_STATUSES`.** Rationale: matches the DB's view of "rows the user is holding," is strictly safer (caps abuse), and the reap step makes any over-count self-healing within `STALE_PENDING_THRESHOLD_MS`. Document this choice in the helper from D2.
6. Tests:
   - Regression: P2002 with a colliding row in `CLAIMED ∧ containerId=null` returns 409 with `loop_already_active` (today: 500).
   - Regression: P2002 with a colliding row that is `PENDING ∧ age ≥ STALE_PENDING_THRESHOLD_MS` returns 409 (today: 500 unless reap-before-gate happens to win the race).
   - Property: for every shape returned by `findIndexBlockingLoop`, the catch path produces a 409, never a 500.
   - Property: `findOperationallyActiveLoop` ⊆ `findIndexBlockingLoop` — never returns a row the index doesn't cover.

---

### S2 — `30_000` ms staleness threshold is unnamed and repeated 3×  *(SSOT)*

**Locations:** `service.ts:355`, `:845`, `:1482`.

**Risk.** Reaping inside `create()`, the `reapStalePendingLoops` helper, and the read predicate in `findActiveLoopForDocumentAndCommand` must agree exactly. A change applied to one site silently desyncs the other two: tighter reaping than the read predicate orphans rows; looser reaping leaves stale gates blocking writes.

**Fix.** Promote a single module-level constant adjacent to `TERMINAL_STATUSES`:

```ts
/** PENDING rows older than this with no containerId are treated as orphaned dispatches. */
const STALE_PENDING_THRESHOLD_MS = 30_000;
```

All three sites compute `new Date(Date.now() - STALE_PENDING_THRESHOLD_MS)` from the same constant.

---

### S3 — Test fixtures bypass the project's enum-only rule  *(SSOT)*

**Locations:**
- `apps/api/__tests__/fixtures/loop.ts:13-46` — `buildPrismaLoop` returns `status: "RUNNING"`, `command: "PLAN"` as raw string literals. The sibling `buildLoop` at `loop.ts:48-83` uses `LoopStatus.Completed` / `LoopCommand.Plan` correctly.
- Tests that follow the bad pattern: `__tests__/unit/find-active-plan-loop.test.ts:66-78`, `:106`, `:111` (`"RUNNING"`, `"PENDING"`, `"CLAIMED"`, `"EXECUTE"`).

**Risk.** Project CLAUDE.md is explicit: *"Use enum/const references, not hardcoded strings — applies everywhere: type annotations, runtime comparisons, test fixtures, and object literals."* Raw strings in fixtures defeat the purpose of the const-object pattern: a rename of `LoopStatus.Running` would compile while silently breaking these tests.

**Fix.**
1. Update `buildPrismaLoop` defaults to `status: LoopStatus.Running` / `command: LoopCommand.Plan`. Prisma's generated types accept the const-object string literals, so no cast needed.
2. Sweep `find-active-plan-loop.test.ts` and `loops-service-concurrent-limit.test.ts` for raw `"RUNNING"`, `"PENDING"`, `"CLAIMED"`, command names, and replace with enum references. Where the test is asserting on Prisma's string output, the const-object value still carries the same string at runtime.

---

### S4 — "Non-Chat with documentId" guard is the SSOT for "this code applies", repeated 4×  *(SSOT)*

**Locations:** `service.ts:402`, `:448`, `:873`, `:981`. Same predicate `command !== LoopCommand.Chat && documentId != null` (or its parent-loop variant) gates every entry into the active-loop logic.

**Risk.** Each duplicate is a place where the rule could drift — particularly if a future command joins Chat in being exempt from the index. Because the Chat exemption is also carved into the migration's index, the application-level check must remain in lockstep with the DB index.

**Fix.** A single small predicate:

```ts
function shouldEnforceActiveGate(
  command: LoopCommand | string | null,
  documentId: string | null | undefined
): boolean {
  return command !== LoopCommand.Chat && documentId != null;
}
```

Every callsite calls this. The function's docstring explicitly references the migration index so future readers know why the predicate exists.

---

### D1 — Stale-PENDING reap implemented twice  *(DRY)*

**Locations:** `service.ts:354-371` (inline in `create`) duplicates `service.ts:837-861` (`reapStalePendingLoops`). The two `updateMany` calls are byte-equivalent except that `create` already has narrower input shape.

**Fix.** Replace the inline block with `await loopsService.reapStalePendingLoops(input.documentId, input.command);`. The helper already short-circuits when either argument is null, matching the existing `if (input.documentId && input.command)` guard.

---

### D2 — Per-user concurrency check duplicated verbatim  *(DRY)*

**Locations:** `service.ts:378-393` (`create`) and `:909-923` (`resume`) — 16 identical lines (`fetchOrgLoopLimit` → `db.loop.count` → throw `ConcurrentLoopLimitError`).

**Fix.** Extract a private helper:

```ts
async function enforceConcurrencyLimit(
  userId: string,
  organizationId: string
): Promise<void> {
  const limit = await fetchOrgLoopLimit(organizationId);
  const activeCount = await withDb((db) =>
    db.loop.count({
      where: {
        userId,
        organizationId,
        status: { in: ACTIVE_LOOP_STATUSES },
      },
    })
  );
  if (activeCount >= limit) {
    throw new ConcurrentLoopLimitError(activeCount, limit);
  }
}
```

`create` and `resume` each shrink to a single call. The helper participates in any ambient `withDb.tx` automatically.

---

### D3 — Pre-insert active-loop gate + P2002 backstop duplicated  *(DRY, ties to S1)*

**Locations:** `service.ts:402-466` (`create`) and `:928-998` (`resume`). Both run `shouldEnforceActiveGate` → `findActiveLoopForDocumentAndCommand` → `throw LoopAlreadyActiveError`; both wrap the insert in `try/catch`; both translate P2002 by re-querying.

**Fix.** A single helper that owns both the pre-insert gate (operationally-active tier) and the P2002 catch path (index-blocking tier), per S1:

```ts
async function createLoopWithActiveGate<T extends { id: string; status: string }>(args: {
  command: LoopCommand;
  documentId: string | null;
  organizationId: string;
  excludeLoopId?: string;
  insert: () => Promise<T>;
}): Promise<T> {
  const enforce = shouldEnforceActiveGate(args.command, args.documentId);

  // Pre-insert gate: operationally-active tier. Excludes orphan-shaped rows
  // so users aren't told "blocked" by a silently-failed dispatch.
  if (enforce && args.documentId) {
    const blocker = await loopsService.findOperationallyActiveLoop(
      args.documentId, args.command, args.organizationId,
    );
    if (blocker && blocker.id !== args.excludeLoopId) throwLoopAlreadyActive(blocker);
  }

  try {
    return await args.insert();
  } catch (error) {
    // Post-insert: index-blocking tier. Whatever the DB rejected on must be
    // describable here, even if the staleness predicate would have ignored it.
    if (
      enforce &&
      args.documentId &&
      isLoopActiveIndexViolation(error)
    ) {
      const blocker = await loopsService.findIndexBlockingLoop(
        args.documentId, args.command, args.organizationId,
      );
      if (blocker && blocker.id !== args.excludeLoopId) throwLoopAlreadyActive(blocker);
    }
    throw error;
  }
}
```

`isLoopActiveIndexViolation` narrows `isPrismaUniqueConstraintError` to constraint name `loops_active_artifact_command_key` so unrelated P2002s (event idempotency at `:1080`, etc.) are not swallowed. `excludeLoopId` covers the resume case where the parent's own row must not block the new child.

---

### D4 — P2002 duck-typing repeated 3×  *(DRY)*

**Locations:** `service.ts:447`, `:980`, `:1080`. Same shape: `error instanceof Error && "code" in error && (error as { code: string }).code === "P2002"`.

**Fix.** Encode the predicate once. The test-side fixture `apps/api/__tests__/fixtures/prisma-errors.ts` already alludes to this — pair it with a runtime helper exported from `service.ts` (or from a new `apps/api/lib/prisma-errors.ts`):

```ts
export function isPrismaUniqueConstraintError(error: unknown): error is Error & { code: "P2002" } {
  return error instanceof Error && (error as { code?: unknown }).code === "P2002";
}
```

All three sites delegate. The `addEvent` callsite at `:1080` benefits too.

---

### D5 — Active-status array literal repeated 5×  *(DRY, ties to S1)*

**Locations:** `service.ts:385`, `:726`, `:916`, `:1562`, plus `:1541` (raw SQL `'PENDING','CLAIMED','RUNNING'`).

**Fix.** Add a module-level constant near `TERMINAL_STATUSES`, named to match the "index-blocking" tier from S1:

```ts
/**
 * Loop statuses that the partial unique index
 * `loops_active_artifact_command_key` (migration
 * 20260505111856_replace_loop_active_index_drop_artifact_version) treats as
 * "currently holding an (artifact_id, command) slot." This is the
 * **index-blocking tier** of the two-tier model documented in S1: the DB
 * physically refuses a duplicate insert for any row in this set.
 *
 * The narrower **operationally-active tier** lives in
 * `findOperationallyActiveLoop` and is strictly a subset.
 */
const ACTIVE_LOOP_STATUSES = [
  LoopStatus.Pending,
  LoopStatus.Claimed,
  LoopStatus.Running,
] as const;
```

The four Prisma sites use `{ in: ACTIVE_LOOP_STATUSES }`. The raw SQL site at `:1541` builds its IN-list from the same constant via `Prisma.join(ACTIVE_LOOP_STATUSES.map((s) => Prisma.sql`${s}`), ", ")` — that way a future status added to the const lands in the SQL too.

---

### D6 — `LoopAlreadyActiveError` construction shape repeated 4×  *(DRY)*

**Locations:** `service.ts:410-414`, `:458-462`, `:883-887`, `:991-995`. Each block builds the same `{existingLoopId, existingCommand, existingStatus}` triple from the same lookup.

**Fix.** A trivial helper:

```ts
function throwLoopAlreadyActive(existing: { id: string; command: string; status: string }): never {
  throw new LoopAlreadyActiveError(existing.id, existing.command as LoopCommand, existing.status as LoopStatus);
}
```

Once D3 is in place this collapses to a single callsite anyway.

---

## Implementation tasks

Ordered so each task leaves the tree green and reviewable on its own:

- [ ] **T1 — Constants & predicates (no behavior change).** Add `STALE_PENDING_THRESHOLD_MS`, `ACTIVE_LOOP_STATUSES`, `shouldEnforceActiveGate`, `isPrismaUniqueConstraintError`, `isLoopActiveIndexViolation`, `throwLoopAlreadyActive` to `apps/api/app/loops/service.ts`. Replace literal usages at the listed line numbers. No new tests — existing tests must continue to pass with no edits.
  - Acceptance: `pnpm turbo lint --filter=api`, `pnpm turbo typecheck --filter=api`, `pnpm turbo test --filter=api` all green; diff is purely substitutions.

- [ ] **T2 — Test fixture cleanup (S3).** Update `apps/api/__tests__/fixtures/loop.ts` `buildPrismaLoop` defaults to enum references; sweep `find-active-plan-loop.test.ts` and `loops-service-concurrent-limit.test.ts` for raw status/command strings.
  - Acceptance: `apps/api` tests green; grep `"RUNNING"\|"PENDING"\|"CLAIMED"\|"COMPLETED"\|"FAILED"\|"PLAN"\|"EXECUTE"\|"REQUEST_CHANGES"` returns zero hits inside `apps/api/__tests__/`.

- [ ] **T3 — Collapse stale-PENDING reap (D1).** Replace the inline reap in `loopsService.create` with `await loopsService.reapStalePendingLoops(input.documentId ?? null, input.command ?? null)`.
  - Acceptance: existing reap-related tests in `loops-service-concurrent-limit.test.ts` and `loops-service.test.ts` still pass; one new test asserts `create` is a no-op for stale-reap when `documentId` is null.

- [ ] **T4 — Extract `enforceConcurrencyLimit` (D2).** Move the duplicated 16-line block out of `create`/`resume`. Both methods call the helper.
  - Acceptance: `loops-service-concurrent-limit.test.ts` passes unchanged; coverage for the helper is provided by the same suite.

- [ ] **T5 — Introduce `createLoopWithActiveGate` and the two-tier lookup split (D3 + S1 + S4).** Rename `findActiveLoopForDocumentAndCommand` → `findOperationallyActiveLoop` (operationally-active tier). Add a sibling `findIndexBlockingLoop` (index-blocking tier; `status ∈ ACTIVE_LOOP_STATUSES`, no staleness clause). The helper owns the pre-insert gate (operationally-active) and the P2002 backstop (index-blocking, narrowed to constraint name `loops_active_artifact_command_key`). `create` and `resume` delegate.
  - Acceptance:
    - All existing `loops-service.test.ts` cases pass after the rename.
    - New unit test: P2002 is caught and a `LoopAlreadyActiveError` is thrown when the colliding row is `CLAIMED ∧ containerId=null` (today: generic 500).
    - New unit test: P2002 is caught and translated when the colliding row is `PENDING ∧ age ≥ STALE_PENDING_THRESHOLD_MS` (today: 500 unless reap-before-gate happens to win the race).
    - New unit test: a P2002 from an unrelated unique constraint (constraint name ≠ `loops_active_artifact_command_key`) is *not* swallowed.
    - Property test: `findOperationallyActiveLoop` ⊆ `findIndexBlockingLoop` for an arbitrary row generator.
    - Route-level test confirms the response in the regression cases is 409 with `loop_already_active`.

- [ ] **T6 — Document the SSOT.** Comment block above `ACTIVE_LOOP_STATUSES` in `service.ts` references the migration name and the two-tier model from S1; the migration's header comment links back. Update `apps/api/CLAUDE.md` "Learned Patterns" with a one-line entry: *"Loops have two tiers of 'active': `ACTIVE_LOOP_STATUSES` (index-blocking, mirrors `loops_active_artifact_command_key`) and `findOperationallyActiveLoop` (UX-facing, narrower). Reap bridges them. Keep all three in sync."*
  - Acceptance: comment present at both ends; CLAUDE.md entry committed.

- [ ] **T7 — Verification.** `pnpm turbo test --filter=api`, `pnpm turbo typecheck`, `pnpm lint:fix`. Manually re-run the PR's two-concurrent-`POST /documents/[id]/run-loop` scenario; confirm one 200 + one 409 with the structured `loop_already_active` body, including the previously-broken cases (orphaned CLAIMED, stale PENDING).

## Risks & rollback

- **Risk: catch-path translates a non-loops P2002.** A naive "broader lookup" would swallow P2002s raised by other unique constraints (e.g. event idempotency at `service.ts:1080`). Mitigation: `isLoopActiveIndexViolation` only matches when the Prisma error meta carries constraint name `loops_active_artifact_command_key`; everything else rethrows. Covered by a dedicated unit test in T5.
- **Risk: rename of `findActiveLoopForDocumentAndCommand` breaks an external caller.** The function is only used inside `apps/api/app/loops/`. Mitigation: grep before T5; if any caller exists outside that tree, keep the old name as a thin wrapper that delegates to `findOperationallyActiveLoop` and add a follow-up to remove the wrapper.
- **Risk: counting orphan rows in the concurrency quota over-counts user usage.** Mitigation: `STALE_PENDING_THRESHOLD_MS` is short (30 s), reap runs on every `create`/`resume`, and the quota is org-configurable. Documented in the helper from D2 so the policy is visible.
- **Risk: enum substitution in fixtures changes Prisma's deserialization shape.** The const-object values are plain strings at runtime, so `db.loop.findFirst` mocks behave identically. No mitigation needed beyond running the suite.
- **Rollback.** Each task is a standalone commit. Reverting any of T1–T6 leaves earlier tasks intact.

## Out of scope / deferred

- Re-evaluating whether the staleness clause belongs in the operationally-active tier at all. Removing it would make CLAIMED-no-containerId user-visible as a blocker — a behavior change worth its own ticket.
- Folding `persistLaunchInfo` and `updateMetadata` "active row" guards onto `ACTIVE_LOOP_STATUSES` is included (D5); revisiting *whether* those writes should guard on active status is not.
- Tightening the reap step to also age out the other two orphan shapes (`CLAIMED ∧ containerId=null`, `PENDING ∧ containerId≠null`). Today only `PENDING ∧ containerId=null` is reaped, so the other two shapes still produce a 409 once T5 lands rather than being self-healing. Worth a follow-up.
- Any frontend updates to surface the now-reliable 409 body.
