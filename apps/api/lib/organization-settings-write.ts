import { Prisma, withDb } from "@repo/database";
import type { RecordWriteInTransaction } from "@/lib/record-write-in-transaction";

/**
 * ISS-7142: the one place a raw `Organization.settings` UPDATE is executed, and
 * the one place its row count is judged.
 *
 * Every caller patches ONE organization, selected by `WHERE "id" = …::uuid`.
 * `Organization.id` is the table's single-column primary key, so a correct
 * statement matches at most one row and `updatedRows` is only ever 0 or 1 —
 * which is exactly why both other counts are worth refusing:
 *
 *   - **0** means the organization did not exist. A raw UPDATE reports rows
 *     affected instead of throwing the way the Prisma `update` these statements
 *     replaced did (P2025), so without this the caller believes a setting
 *     persisted when nothing did. Deliberately a throw, so the routes keep
 *     producing the same 500 the P2025 produced rather than a new status code.
 *   - **>1** is unreachable through a correct predicate, so reaching it means
 *     the `WHERE` clause has been WIDENED — the cross-tenant mutation the
 *     three settings-race suites test for. This guard is defence in depth for
 *     that class: if a future edit widens a predicate and the test coverage is
 *     somehow bypassed, the write is refused rather than silently rewriting
 *     every organization's settings.
 *
 * **The transaction is what makes ">1" a refusal rather than a report.** A
 * throw after an autocommitted statement does not un-write it — the rows are
 * already gone. FOUR of the six call sites were outside any transaction
 * (`setComputeMode`, `setFrustrationEnabled`, `completeWizard`, and the backfill
 * summary; only the run-gate writes were already inside `withDb.tx`), so the
 * guard is executed here, inside `withDb.tx`, where the throw actually rolls the
 * statement back. `withDb.tx` joins an ambient transaction when one exists
 * (`claimOrganizationRun` and `releaseOrganizationRun` in
 * `@/lib/organization-run-gate` hold one, along with the gate's advisory lock,
 * for every lane that claims a run), so those writes keep their existing
 * single-transaction semantics and gain the same rollback.
 *
 * **ISS-7157: every statement handed here must also set `"updated_at"`.** The
 * schema declares `updatedAt DateTime @updatedAt`, but Prisma applies that at
 * the CLIENT layer, on the `update`/`updateMany` calls these raw statements
 * replaced — there is no database default or trigger behind it. A raw UPDATE
 * therefore rewrites `settings` and leaves `updated_at` pinned to whatever the
 * last Prisma-layer write set, so the column stops describing the last mutation
 * of the row. Nothing reads it today, which is why this went unnoticed; the
 * moment something keys staleness, a sync cursor or an audit trail off it, a
 * row whose settings changed reads as untouched.
 *
 * The timestamp is BOUND from the application, never a server-side `NOW()` or
 * `clock_timestamp()`. `github-repo-sync-state` documents the same decision on
 * the same grounds, and both halves of it apply here:
 *
 *   - **Zone.** `organizations.updated_at` is `TIMESTAMP(3)` with NO zone, so a
 *     server-side `timestamptz` lands converted through the session `TimeZone`
 *     GUC, while a bound value is encoded the way Prisma encodes it. Without
 *     that, a non-UTC server stores two different zones in one column.
 *   - **Clock.** Prisma-layer sites still write this column
 *     (`organizations/service`, the repo-sync bootstrap markers), and Prisma
 *     stamps `@updatedAt` from the APPLICATION clock. A raw statement reading the DATABASE clock would interleave two
 *     clocks in one column, so ordinary app/DB skew could move `updated_at`
 *     backwards between a Prisma write and a raw one — the exact failure the
 *     staleness check or sync cursor this invariant exists to support would
 *     hit. Binding keeps every writer on the column reading one clock.
 *
 * `NOW()` would have been wrong on a third count regardless: it is
 * `transaction_timestamp()`, captured at BEGIN. `withDb.tx` JOINS an ambient
 * transaction, and the run-gate lanes open theirs, take
 * `pg_advisory_xact_lock`, and only then write, so a lane that blocked on the
 * lock would stamp a time from before a settings write that had already
 * committed while it waited.
 *
 * **ISS-7157, second pass: the stamp the column ends up carrying is read AFTER
 * the row is locked.** A value bound by the CALLER is captured when the
 * statement is BUILT — before `withDb.tx` opens and long before Postgres locks
 * the row. A writer that then waits (behind the run gate's advisory lock, a
 * busy pool, or simply another write to the same row) resumes carrying a time
 * from before it waited.
 *
 * `GREATEST` alone does not close that. It stops `updated_at` moving BACKWARDS,
 * which is worth having, but the loser of a contended write then leaves the
 * column pinned to the WINNER's stamp even though the loser mutated the row
 * afterwards. A staleness check or sync cursor that has already passed the
 * winner's time never sees the loser's change — the same silence the missing
 * assignment produced, reached a third way.
 *
 * So the caller's bound value is only a FLOOR, and this function raises it. The
 * settings statement runs first and takes the row lock; the moment it returns,
 * this transaction holds that lock, so a clock read here is bounded below by
 * every write to the row that has already committed and above by this one. A
 * second statement applies that reading. Nothing else can commit to the row
 * between the two, because the lock is held until this transaction ends.
 *
 * **Why a second statement rather than locking the row up front.** A
 * `SELECT … FOR UPDATE` before the settings UPDATE would give the same reading
 * one statement earlier, and it is not free: the settings-race suites hold a
 * production write at a `BEFORE UPDATE … FOR EACH STATEMENT` trigger, which
 * fires before any row is examined precisely so the parked statement holds
 * NOTHING and the competing writer can commit inside its window. A writer
 * holding the row lock while parked deadlocks that competing writer against its
 * own park timeout. Re-stamping afterwards keeps the first statement the
 * lock-taking one, so that interleave is unchanged.
 *
 * **`GREATEST` stays on both statements, for the case the lock cannot cover.**
 * Two application hosts with skewed clocks: the later writer holds the lock,
 * reads its own clock, and that reading is genuinely behind the stamp the
 * earlier writer left. `GREATEST("updated_at", …)` reads the column on the row
 * this transaction has already locked, so the newer stamp survives and the
 * column is monotonic ACROSS THE RAW SETTINGS WRITERS regardless of which host
 * wrote it. `GREATEST` ignores NULL operands, so it is also safe against a row
 * whose column was never stamped.
 *
 * Not monotonic per row outright, and the difference is worth stating: the
 * Prisma-layer writers named above (`organizations/service`,
 * `github-repo-sync-state`) reach this column
 * through `@updatedAt` and a bare `SET`, with no `GREATEST` and no row lock
 * held from a prior statement. One of those, running on a host whose clock lags,
 * can still move `updated_at` backwards past a stamp written here. What this
 * function guarantees is that no RAW settings write does.
 *
 * Three of the four statement shapes live in caller files, so a rule each
 * caller has to remember is a rule that drifts — and the DB-backed regression
 * suite for this invariant can only enumerate the writers that existed when it
 * was written. The fifth writer is caught statically instead, by
 * `__tests__/unit/organization-settings-updated-at-gate`, which walks the AST
 * of every module in this package and fails on any literal
 * `UPDATE "organizations"` statement that does not ASSIGN the column. That is a
 * source gate rather than a runtime refusal here on purpose: this function
 * receives an opaque `Prisma.Sql`, so inspecting it would mean sniffing SQL
 * text on the write path, and would bind production behaviour to which
 * properties each suite's `Prisma.sql` double happens to define — the repo has
 * roughly twenty such doubles in three different shapes.
 *
 * **`context.organizationId` MUST name the row `statement` matches.** It is not
 * a label for the error messages: the re-stamp is addressed by it, so a caller
 * whose predicate and `context` disagree stamps a row its settings write never
 * touched, or none at all. `statement` is an opaque `Prisma.Sql` and cannot be
 * checked against it, which is why the re-stamp's own row count is judged the
 * same way the settings statement's is — the contract is stated here and
 * enforced by refusing anything but one stamped row.
 */
export async function writeOrganizationSettings(
  statement: Prisma.Sql,
  context: { organizationId: string; subject: string },
  recordWrite?: RecordWriteInTransaction<void>
): Promise<void> {
  await withDb.tx(async (tx) => {
    const updatedRows = await tx.$executeRaw(statement);
    // Read only once the statement above has returned, which is the point at
    // which this transaction holds the row lock. It sits before the guards for
    // lock proximity — as close as the code can get to the moment the lock was
    // granted. Ordering it against the guards has nothing to do with rollback:
    // assigning a JS local writes nothing Postgres holds, and the throw below
    // is what aborts the transaction wherever this line sits.
    const stampedAt = new Date();

    if (updatedRows === 0) {
      throw new Error(
        organizationSettingsNotPersistedMessage(
          context.subject,
          context.organizationId
        )
      );
    }

    if (updatedRows > 1) {
      throw new Error(
        organizationSettingsRowCountRefusedMessage(
          context.subject,
          context.organizationId,
          updatedRows
        )
      );
    }

    const stampedRows = await tx.$executeRaw`
      UPDATE "organizations"
      SET "updated_at" = GREATEST("updated_at", ${stampedAt})
      WHERE "id" = ${context.organizationId}::uuid
    `;

    // The guards above prove the CALLER's statement matched exactly one row.
    // They do NOT prove it matched THIS one: `statement` arrives as an opaque
    // `Prisma.Sql`, so nothing here can hold its predicate against
    // `context.organizationId`. A caller whose two disagree writes settings to
    // one row and stamps zero — settings changed, `updated_at` says untouched,
    // which is the silence this function exists to remove, reached from the
    // other side and with the transaction still reporting success. Discarding
    // this count is what would let that through, so it is judged too.
    if (stampedRows !== 1) {
      throw new Error(
        organizationSettingsRowCountRefusedMessage(
          context.subject,
          context.organizationId,
          stampedRows
        )
      );
    }

    // ISS-12552: a caller's record of the write (an operation receipt)
    // commits or rolls back with it.
    await recordWrite?.(tx, undefined);
  });
}

/** Exported so callers' tests assert the bound message, not a copy of it. */
export function organizationSettingsNotPersistedMessage(
  subject: string,
  organizationId: string
): string {
  return `${subject} was not persisted: organization ${organizationId} not found`;
}

/** Exported so callers' tests assert the bound message, not a copy of it. */
export function organizationSettingsRowCountRefusedMessage(
  subject: string,
  organizationId: string,
  updatedRows: number
): string {
  return `${subject} was refused and rolled back: the settings write for organization ${organizationId} matched ${updatedRows} organization rows, expected exactly 1`;
}

/**
 * ISS-7111: patch ONE top-level `Organization.settings` key in a single
 * statement, rather than reading the whole blob into JS, merging, and writing it
 * back. Mirrors `frustration-setting-service` and `onboarding/service`
 * (ISS-7092).
 *
 * A read-modify-write of the blob loses updates even inside `withDb.tx`: at
 * READ COMMITTED — Postgres's default and this repo's — two writers each read
 * the blob, merge their own change into their own stale copy, and the second
 * commit overwrites the first. No error, no conflict; the first writer's key is
 * simply gone. An advisory lock only serializes the writers that take it, so it
 * cannot protect `settings` from the writers that do not (`compute-mode-service`,
 * onboarding, frustration).
 *
 * Here every read of `settings` happens inside the same UPDATE, on the row
 * Postgres has already locked, so there is no window to lose: `jsonb_set`
 * rewrites only the named key and carries every sibling key through untouched.
 * The value replaces that key outright, so there is no `||` merge and therefore
 * no need for the `jsonb_typeof` guard `onboarding/service` requires for its
 * sub-key merge.
 *
 * ISS-7142: the row-count judgment (0 rows → not found, >1 rows → a widened
 * predicate, refused and rolled back) lives in `writeOrganizationSettings`
 * above. It runs inside `withDb.tx`, which JOINS an ambient transaction when the
 * caller already holds one (as the run-gate lanes do, along with their advisory
 * lock), so their single-transaction semantics are unchanged.
 *
 * ISS-7157: `updated_at` is set by the statement, through `GREATEST` so a
 * delayed write cannot move it backwards. That bound value is a FLOOR; the
 * shared writer raises it to a reading taken after this statement took the row
 * lock. Both halves, and why neither alone is enough, are in
 * `writeOrganizationSettings` above.
 */
export async function writeOrganizationSettingsKey(
  organizationId: string,
  key: string,
  value: unknown,
  subject: string
): Promise<void> {
  await writeOrganizationSettings(
    Prisma.sql`
      UPDATE "organizations"
      SET "settings" = jsonb_set(
        COALESCE("settings", '{}'::jsonb),
        ARRAY[${key}]::text[],
        ${JSON.stringify(value)}::jsonb,
        true
      ),
      "updated_at" = GREATEST("updated_at", ${new Date()})
      WHERE "id" = ${organizationId}::uuid
    `,
    { organizationId, subject }
  );
}
