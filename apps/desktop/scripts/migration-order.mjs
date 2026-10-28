// @ts-check

export const legacyMigrationSortKeys = new Map([
  ["0011_session_activity_segments", "0011_session_activity_segments"],
  [
    "20260619220000_add_genai_prices_pricing_source",
    "0004_add_genai_prices_pricing_source",
  ],
  // FEA-2267 (#2157) merged with a stale base and re-used the 0011 prefix
  // already taken by 0011_clear_default_branch_pr_poison (which landed first),
  // producing two committed `0011_` migrations on main. Both are immutable, so
  // neither can be renamed. clear_default_branch_pr_poison keeps slot 0011 (it
  // landed first); session_activity_segments is logically the 12th migration,
  // so map it to a 0012 sort key. This exempts it from the canonical-name check
  // and orders it after 0011_clear — matching the existing application order
  // ("clear" < "session"), so runtime migration order is unchanged.
  ["0011_session_activity_segments", "0012_session_activity_segments"],
]);

/**
 * ISS-10416. The LAST desktop migration committed under the historical
 * contiguous `000N_` scheme. Everything at or before it keeps the name it
 * merged with; everything after it is named `YYYYMMDDHHMMSS_<snake_case>`.
 *
 * This constant IS the boundary between the two schemes — the one place it is
 * stated, so neither the guard nor the docs infers it from the directory list.
 *
 * Why the scheme changed: a contiguous prefix is a property of the MERGED tree,
 * not of a PR, so two PRs cut from the same base both pick the same next number
 * and whichever merges second reddens the merge group. On 2026-09-16 that
 * ejected seven merge groups from three PRs, and 13 desktop migrations merged
 * in the preceding seven days, so two concurrent migration PRs is the common
 * case.
 *
 * What a UTC timestamp buys, stated exactly, because the overclaim is easy to
 * write: two branches can never CLAIM THE SAME SLOT, so no PR is ever renumbered
 * because someone else took its number, and nothing cascades to the PRs behind
 * it. It does NOT make every merge order free. `findOutOfOrderMigrations`
 * (`scripts/lint/destructive-migrations/migration-order.ts`) still refuses a new migration
 * sorting below the tip on `main`, so of two same-base PRs the one that MINTED
 * EARLIER must also MERGE earlier; minted-earlier-merging-second re-mints its
 * own timestamp once, against a tip that is not moving under it. That refusal is
 * load-bearing, not incidental — a build shipped between the two merges leaves
 * stores with the later migration applied, and the earlier one slotting in
 * behind it is the runner's `HistoryGap`. Pinned in
 * `scripts/lint/desktop-migration-same-base-pair.test.ts`.
 *
 * Why the history is NOT renamed: the runner keys `_desktop_migrations` on the
 * directory NAME (`src/main/database/migration/migration-runner.ts`), so a
 * rename reads back on an already-migrated store as a name the bundle does not
 * ship and refuses the boot with `MigrationRefusalKind.Downgrade`.
 *
 * Why a fixed name here is not the old trap wearing a new label: the rule it
 * feeds is "sorts after THIS name ⇒ must be timestamped", whose verdict for a
 * given branch does not change when somebody else's migration merges — unlike
 * "prefix equals the count of everything ahead of you", which changed with
 * every merge and is what ejected the groups. It is also self-freezing: the
 * only thing that could make this constant stale is a new `000N_` directory,
 * and that is precisely what the rule refuses.
 */
export const lastContiguousMigrationDirName =
  "0094_iss8617_session_outbox_engine_state";

/** `000N_snake_case` — the historical scheme, closed to new entries. */
const CONTIGUOUS_MIGRATION_DIR_RE = /^\d{4}_[a-z0-9][a-z0-9_]*$/;

/** `YYYYMMDDHHMMSS_snake_case` — the scheme every new migration uses. */
const TIMESTAMP_MIGRATION_DIR_RE = /^(\d{14})_[a-z0-9][a-z0-9_]*$/;

const TIMESTAMP_PARTS_RE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

/**
 * The first year a minted prefix may carry — when the scheme starts. The past
 * side is the cheap one: a far-past prefix sorts below the tip and
 * `findOutOfOrderMigrations` already refuses it as backdated, so this only moves
 * the refusal to the naming gate, where the message names the real rule.
 */
const MIN_MIGRATION_YEAR = 2026;

/**
 * How far past the reading clock a prefix may sit. A prefix is minted with
 * `date -u` on the author's machine and read back on another one, so this covers
 * the skew between those two clocks and nothing else.
 */
const MAX_MINT_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * @param {string} left
 * @param {string} right
 */
export function compareMigrationDirNames(left, right) {
  const leftKey = migrationSortKey(left);
  const rightKey = migrationSortKey(right);
  return leftKey.localeCompare(rightKey) || left.localeCompare(right);
}

/**
 * @param {string} name
 */
export function migrationSortKey(name) {
  return legacyMigrationSortKeys.get(name) ?? name;
}

/**
 * Whether a 14-digit prefix is a real UTC instant that has already happened.
 *
 * Round-tripped through `Date` rather than range-checked field by field: that
 * rejects month 13, day 32, February 30, hour 24 and second 60 in one step, and
 * a bare digit count would accept every one of them as a migration sorting
 * wherever its digits happen to fall.
 *
 * THE FUTURE BOUND IS THE CLOCK, NOT A YEAR BAND. A future prefix is the one
 * typo nothing downstream catches: it sorts above everything, so it merges, and
 * once a commit reachable from `green` touches it the directory can never be
 * renamed (ISS-12720) — from then on every correctly minted migration sorts
 * BELOW the tip and `findOutOfOrderMigrations` reports each one as backdated
 * with no legal remedy. A year ceiling only narrows the window a
 * typo can land in: `2926` is caught by a band, `2036` is the same single
 * keystroke and is not. `now` catches both, and every other future typo.
 *
 * Bounding by `now` is safe against the committed set precisely because `now`
 * only moves forward: a prefix that passed once keeps passing forever, so this
 * can never redden a directory that is already immutable. {@link
 * MAX_MINT_SKEW_MS} is the allowance for the mint clock and the reading clock
 * being different machines.
 *
 * @param {string} prefix
 */
function isUtcTimestampPrefix(prefix) {
  const parts = TIMESTAMP_PARTS_RE.exec(prefix);
  if (parts === null) {
    return false;
  }
  if (Number(parts[1]) < MIN_MIGRATION_YEAR) {
    return false;
  }
  const iso = `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}.000Z`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== iso) {
    return false;
  }
  return parsed.getTime() <= Date.now() + MAX_MINT_SKEW_MS;
}

/**
 * @param {string} name
 */
function isTimestampMigrationDirName(name) {
  const match = TIMESTAMP_MIGRATION_DIR_RE.exec(name);
  return match !== null && isUtcTimestampPrefix(match[1] ?? "");
}

/**
 * The remedy sentence, so the guard, the docs and a failing CI log hand a new
 * author the same instruction.
 */
export function describeNewMigrationDirNameRule() {
  return (
    "run `date -u +%Y%m%d%H%M%S` and use its output as the prefix, e.g. " +
    "20260916231500_iss1234_add_widget_index. The contiguous 000N scheme ended " +
    `at ${lastContiguousMigrationDirName} (ISS-10416) because two PRs cut from ` +
    "the same base both pick the same next number and the second to merge " +
    "reddens the merge group. A directory is never renamed once a commit " +
    "reachable from `green` touches it (ISS-12720), which is why a prefix in " +
    "the FUTURE is refused too: it would sort above every later mint and " +
    "leave each one unfixably backdated."
  );
}

/**
 * Every naming or ordering violation in a set of desktop migration directory
 * names, as ready-to-print lines. Empty means the set is legal.
 *
 * Three rules, and the boundary decides which of the first two applies:
 *  1. at or before {@link lastContiguousMigrationDirName} a name is historical,
 *     so it keeps its `000N_` shape (or its {@link legacyMigrationSortKeys}
 *     entry) and is never re-checked for contiguity — the two committed `0011_`
 *     directories mean the history is not contiguous and cannot be made so;
 *  2. after the boundary a name must be `YYYYMMDDHHMMSS_snake_case`;
 *  3. sort keys strictly increase, so the applied set on an upgraded install
 *     stays a contiguous prefix of the bundle. Anything else is the runner's
 *     `HistoryGap` refusal.
 *
 * What this deliberately does NOT catch is a new migration BACKDATED behind the
 * branch it was cut from. That needs the base branch's directory list, which
 * only `scripts/lint/check-destructive-migrations.ts` has — its
 * `findOutOfOrderMigrations` sorts through this module's `migrationSortKey`.
 *
 * @param {readonly string[]} dirNames
 * @returns {string[]}
 */
export function findMigrationDirNameViolations(dirNames) {
  const sorted = [...dirNames].sort(compareMigrationDirNames);
  const boundaryKey = migrationSortKey(lastContiguousMigrationDirName);
  /** @type {string[]} */
  const violations = [];
  let previousName = "";
  let previousKey = "";
  for (const name of sorted) {
    const sortKey = migrationSortKey(name);
    if (previousName !== "" && sortKey <= previousKey) {
      violations.push(
        `Migration directory ${name} must sort after ${previousName}`
      );
    }
    previousName = name;
    previousKey = sortKey;

    if (sortKey <= boundaryKey) {
      if (
        !(
          legacyMigrationSortKeys.has(name) ||
          CONTIGUOUS_MIGRATION_DIR_RE.test(name)
        )
      ) {
        violations.push(
          `Migration directory ${name} sorts within the committed 000N history but is not one of its names`
        );
      }
      continue;
    }

    if (!isTimestampMigrationDirName(name)) {
      violations.push(
        `Migration directory ${name} must be named <YYYYMMDDHHMMSS>_<snake_case>: ${describeNewMigrationDirNameRule()}`
      );
    }
  }
  return violations;
}
