/**
 * ISS-5288 — the refusals `perf-import-desktop-snapshot.ts` decides before it
 * touches a database, plus the identity lookup and credentials writer the import
 * shares between its preflight and its bearer handoff.
 *
 * Split out of the import script rather than inlined so the script that performs
 * the writes stays readable, and so each guard can be driven directly by a test
 * without running an import.
 */
import { spawnSync } from "node:child_process";
import { open, rm } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { Result } from "@repo/api/src/types/result";
import { withDb } from "@repo/database";

/** The one database the import is ever allowed to write to. */
const PERF_DATABASE_NAME = "closedloop_perf";

/** Loopback hosts. A perf database is local by definition; anything else is a typo. */
const LOCAL_DATABASE_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** Module scope, per Ultracite's `useTopLevelRegex`. */
const LEADING_SLASH = /^\//;

/** The handoff file carries a live credential, so it is created owner-only. */
const CREDENTIALS_FILE_MODE = 0o600;

/** Name the minted bearer carries in the API-keys list. */
export const PERF_API_KEY_NAME = `perf-workload (${PERF_DATABASE_NAME})`;

/**
 * Why the import refused before reaching its own snapshot checks. Every refusal
 * exits non-zero carrying one of these, so a lane wrapper can branch on the code
 * instead of matching prose.
 */
export const GuardRefusalCode = {
  ArgsInvalid: "args_invalid",
  DatabaseUrlMissing: "database_url_missing",
  DatabaseUrlUnparseable: "database_url_unparseable",
  DatabaseUrlNotLocal: "database_url_not_local",
  DatabaseUrlNotPerfDatabase: "database_url_not_perf_database",
  OutPathNotGitIgnored: "out_path_not_git_ignored",
  OrganizationAmbiguous: "organization_ambiguous",
  UserAmbiguous: "user_ambiguous",
} as const;
export type GuardRefusalCode =
  (typeof GuardRefusalCode)[keyof typeof GuardRefusalCode];

export type Refusal = { code: GuardRefusalCode; message: string };

export type ResolvedIdentity = { organizationId: string; userId: string };

function refuse(code: GuardRefusalCode, message: string): Refusal {
  return { code, message };
}

/**
 * Assert `DATABASE_URL` names the local throwaway perf database. This is the
 * guard that makes every write safe, so it runs before anything opens a
 * connection.
 *
 * The refusal prose names the DATABASE rather than the caller's action, so the
 * message stays true wherever it surfaces.
 */
export function checkDatabaseUrl(
  databaseUrl: string | undefined
): Result<true, Refusal> {
  if (!databaseUrl?.trim()) {
    return Result.err(
      refuse(
        GuardRefusalCode.DatabaseUrlMissing,
        "DATABASE_URL is not set — point it at the local closedloop_perf database."
      )
    );
  }
  const parsed = URL.parse(databaseUrl.trim());
  if (parsed === null) {
    return Result.err(
      refuse(
        GuardRefusalCode.DatabaseUrlUnparseable,
        "DATABASE_URL is not a parseable URL — refusing to connect."
      )
    );
  }
  if (!LOCAL_DATABASE_HOSTS.has(parsed.hostname)) {
    return Result.err(
      refuse(
        GuardRefusalCode.DatabaseUrlNotLocal,
        `DATABASE_URL host is '${parsed.hostname}', expected localhost or 127.0.0.1 — refusing to write to a remote database.`
      )
    );
  }
  const databaseName = parsed.pathname.replace(LEADING_SLASH, "");
  if (databaseName !== PERF_DATABASE_NAME) {
    return Result.err(
      refuse(
        GuardRefusalCode.DatabaseUrlNotPerfDatabase,
        `DATABASE_URL database is '${databaseName}', expected ${PERF_DATABASE_NAME} — refusing to write to a non-perf database.`
      )
    );
  }
  return Result.ok(true);
}

/**
 * Refuse unless the directory holding `--out` is git-ignored. FAILS CLOSED: a
 * non-zero exit (1 = not ignored, 128 = outside a work tree or a git error) and
 * a spawn failure are all refusals, because "we could not prove it is ignored"
 * and "it is not ignored" carry the same risk for a file holding a live bearer.
 *
 * The probe carries a TRAILING SLASH. A directory-only ignore pattern (`.perf/`,
 * which is exactly what the perf lane writes under) only matches a path git can
 * tell is a directory, and git infers that from the filesystem — so probing a
 * not-yet-created `.perf` returns "not ignored" and would refuse the one target
 * this lane exists to write to. The trailing slash states it instead.
 */
export function checkOutPathIsGitIgnored(
  outPath: string
): Result<string, Refusal> {
  const directory = dirname(resolvePath(outPath));
  const probe = spawnSync(
    "git",
    ["check-ignore", "--quiet", "--", `${directory}/`],
    {
      cwd: process.cwd(),
      encoding: "utf8",
    }
  );
  if (probe.error || probe.status !== 0) {
    return Result.err(
      refuse(
        GuardRefusalCode.OutPathNotGitIgnored,
        `--out directory '${directory}' is not proven git-ignored (git check-ignore exited ${probe.status ?? "with a spawn error"}) — refusing to write credentials somewhere git would commit them.`
      )
    );
  }
  return Result.ok(directory);
}

/**
 * Resolve the identity to import as. The seeded perf database holds exactly one
 * org and one user, so anything else is ambiguous and the operator has to say
 * which they meant.
 *
 * Deliberately NOT read from a shared constant: the seed derives these ids from
 * the environment it ran in, so a pinned constant would drift the moment the
 * perf database is reseeded and silently write against the wrong identity.
 */
export async function resolveIdentity(
  overrides: { organizationId?: string; userId?: string } = {}
): Promise<Result<ResolvedIdentity, Refusal>> {
  const organizationId =
    overrides.organizationId ?? (await findSoleOrganizationId());
  if (organizationId === null) {
    return Result.err(
      refuse(
        GuardRefusalCode.OrganizationAmbiguous,
        `${PERF_DATABASE_NAME} does not hold exactly one organization — pass --organization-id <uuid> (and --user-id <uuid>) to say which identity to import as.`
      )
    );
  }
  const userId = overrides.userId ?? (await findSoleUserId(organizationId));
  if (userId === null) {
    return Result.err(
      refuse(
        GuardRefusalCode.UserAmbiguous,
        `organization ${organizationId} does not hold exactly one user — pass --user-id <uuid> to say which identity to import as.`
      )
    );
  }
  return Result.ok({ organizationId, userId });
}

/** The sole organization id, or `null` when there are zero or more than one. */
async function findSoleOrganizationId(): Promise<string | null> {
  // `take: 2` is all that is needed to tell "none" and "exactly one" apart from
  // "more than one", without reading a whole table to count it.
  const organizations = await withDb((db) =>
    db.organization.findMany({
      take: 2,
      select: { id: true },
      orderBy: { id: "asc" },
    })
  );
  return organizations.length === 1 ? (organizations[0]?.id ?? null) : null;
}

/** The sole user id in an org, or `null` when there are zero or more than one. */
async function findSoleUserId(organizationId: string): Promise<string | null> {
  const users = await withDb((db) =>
    db.user.findMany({
      where: { organizationId },
      take: 2,
      select: { id: true },
      orderBy: { id: "asc" },
    })
  );
  return users.length === 1 ? (users[0]?.id ?? null) : null;
}

/**
 * Write the handoff JSON owner-only (0600). Never echoed to the log.
 *
 * The mode argument applies only when `open` CREATES the file, so re-running
 * over an existing handoff would keep whatever permissions that file already
 * had. The previous file is removed first and re-created exclusively (`wx`), so
 * every run — first or fiftieth — produces a file that was born 0600.
 */
export async function writeCredentialsFile<T>(
  outPath: string,
  credentials: T
): Promise<string> {
  const path = resolvePath(outPath);
  await rm(path, { force: true });
  const handle = await open(path, "wx", CREDENTIALS_FILE_MODE);
  try {
    await handle.write(`${JSON.stringify(credentials, null, 2)}\n`);
  } finally {
    await handle.close();
  }
  return path;
}
