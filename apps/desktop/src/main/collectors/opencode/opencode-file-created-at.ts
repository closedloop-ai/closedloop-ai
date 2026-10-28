/**
 * @file opencode-file-created-at.ts
 * @description ISS-12251 (PLN-2176 T-6.2): OpenCode keeps every session in one
 * shared `opencode.db`, so that file's birth time says nothing about a session.
 * The session row's own `time_created` stands in for it.
 */

/**
 * `{ fileCreatedAt }` from the row's `time_created`, or `{}` when that cell is
 * not a usable epoch (absent, 0, negative, non-finite, outside `Date`'s range)
 * or is later than a usable `time_updated`. Spread into the session so an
 * unusable value omits the key instead of carrying `null`.
 *
 * As with `time_updated`, an absent cell or the `0` sentinel is an ordinary
 * missing value, while a present unusable one is corruption in a foreign store
 * and goes to `report`, the loader's monitored per-session sink.
 */
export function opencodeFileCreatedAt(
  timeCreated: unknown,
  timeUpdated: unknown,
  report: (message: string) => void
): { fileCreatedAt?: number } {
  const created = usableEpochMs(timeCreated);
  if (created === undefined) {
    if (!isAbsentCell(timeCreated)) {
      report(
        `session.time_created ${String(timeCreated)} is not a usable epoch; fileCreatedAt is omitted`
      );
    }
    return {};
  }
  const updated = usableEpochMs(timeUpdated);
  if (updated !== undefined && created > updated) {
    return {};
  }
  return { fileCreatedAt: created };
}

function usableEpochMs(cell: unknown): number | undefined {
  if (
    typeof cell !== "number" &&
    typeof cell !== "bigint" &&
    typeof cell !== "string"
  ) {
    return;
  }
  const value = Number(cell);
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    Number.isNaN(new Date(value).getTime())
  ) {
    return;
  }
  return value;
}

function isAbsentCell(cell: unknown): boolean {
  return cell === null || cell === undefined || cell === 0 || cell === 0n;
}
