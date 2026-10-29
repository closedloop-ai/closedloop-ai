import {
  VIBE_SEED_MACHINE_NAME,
  VIBE_SEED_SIGNED_IN_LOGIN,
  vibeCorpusSessionOwner,
} from "@repo/api/src/vibe-seed-corpus";
import { openSnapshot } from "../../perf-import-desktop-snapshot-reads";
import { upsertPerson } from "./org-people";
import { VIBE_SEED_OWNER, VIBE_SEED_TEAMMATES } from "./seed-people";

/**
 * ISS-12135: whose each golden session is. The vibe store rewrites every
 * session's working directory into an Acme person's home directory, and the
 * session is that person's, run on that person's own machine. The signed-in
 * person ({@link VIBE_SEED_SIGNED_IN_LOGIN}) is the run's own user on the
 * machine the vibe Desktop registers as; each teammate gets a user and a
 * machine of their own.
 */

export type SessionOwner = {
  readonly userId: string;
  readonly machineName: string;
};

export type ResolveSessionOwner = (login: string) => Promise<SessionOwner>;

/** The store's session ids grouped by the Acme login whose work each is. */
export function readSessionsByOwner(
  storePath: string
): ReadonlyMap<string, ReadonlySet<string>> {
  const db = openSnapshot(storePath);
  try {
    const rows = db.prepare("SELECT id, cwd FROM sessions").all();
    const byOwner = new Map<string, Set<string>>();
    for (const row of rows) {
      const id = String(row.id);
      const owner = vibeCorpusSessionOwner(
        typeof row.cwd === "string" ? row.cwd : null
      );
      byOwner.set(owner, (byOwner.get(owner) ?? new Set()).add(id));
    }
    return byOwner;
  } finally {
    db.close();
  }
}

/** Resolves a login to the seeded person's user, creating a teammate's row on first use. */
export function seedPersonOwners(identity: {
  readonly organizationId: string;
  readonly userId: string;
}): ResolveSessionOwner {
  const resolved = new Map<string, Promise<SessionOwner>>();
  return (login) => {
    const cached = resolved.get(login);
    if (cached !== undefined) {
      return cached;
    }
    const owner = resolveOwner(identity, login);
    resolved.set(login, owner);
    return owner;
  };
}

async function resolveOwner(
  identity: { readonly organizationId: string; readonly userId: string },
  login: string
): Promise<SessionOwner> {
  if (login === VIBE_SEED_SIGNED_IN_LOGIN) {
    return { userId: identity.userId, machineName: VIBE_SEED_MACHINE_NAME };
  }
  const person = [VIBE_SEED_OWNER, ...VIBE_SEED_TEAMMATES].find(
    (teammate) => teammate.githubUsername === login
  );
  if (person === undefined) {
    throw new Error(`no seeded person has the GitHub handle ${login}`);
  }
  return {
    userId: await upsertPerson(identity.organizationId, person),
    machineName: `${person.firstName.toLowerCase()}s-macbook-pro`,
  };
}
