import { presignTranscriptPutObject } from "@repo/aws/transcript-storage";
import {
  formatVibeEnvironmentMarker,
  vibeEnvironmentKeyPrefix,
  writeSchemaComment,
} from "@repo/database/scripts/vibe-environment";
import {
  restoreStagedVibeSeedRows,
  stageVibeSeedRows,
} from "@repo/database/scripts/vibe-environment-restore";
import { log } from "@repo/observability/log";
import {
  VIBE_ENVIRONMENT_OBJECT_KEY_MAX_LENGTH,
  VibeEnvironmentFailureReason,
  type VibeEnvironmentOrgChoice,
} from "./constants";
import { adoptSeededPerson, loadPersonProfile } from "./service/adopt-person";
import {
  type DesktopAuthClaim,
  listBoundClerkOrgIds,
  mintPersonDesktopSession,
} from "./service/desktop-session";
import {
  type PersonClerkIdentity,
  resolvePersonClerkIdentity,
} from "./service/person-identity";
import {
  AWAITING_SEED,
  bindSeededOrganization,
  isAcceptableObjectKey,
  reconcileTranscriptEtags,
  SEEDED_READY,
  seededOrganizationName,
} from "./service/seed-load";
import {
  failure,
  resolveTarget,
  type VibeEnvironmentFailure,
  withVibeEnvironment,
} from "./service/target";

/**
 * ISS-12056: what `vibe-environment.yml` asks of the stage API after
 * `/preview-schemas/ensure` has built the branch's preview schema EMPTY as a
 * vibe environment. For a seeded one: stage the runner's seeded rows
 * (`stageVibeEnvironmentRows`), upload its transcripts under the schema's key
 * prefix (`presignVibeEnvironmentObject`), and load everything in one
 * transaction bound to the person's stage Clerk org, handing them the seed's
 * signed-in person (`finalizeVibeEnvironment`).
 * For either mode: a Desktop session for the person
 * (`mintVibeEnvironmentDesktopSession`). The shared refusals live in
 * `service/target.ts`.
 */

export type { VibeEnvironmentFailure } from "./service/target";

export async function stageVibeEnvironmentRows(
  branch: string,
  table: string,
  rowsJson: string
): Promise<
  | { ok: true; branch: string; schema: string; table: string; staged: number }
  | VibeEnvironmentFailure
> {
  const target = await resolveTarget(branch);
  if (!target.ok) {
    return target;
  }
  const { schema } = target.value;
  return withVibeEnvironment(target.value, AWAITING_SEED, async (client) => {
    const { staged } = await stageVibeSeedRows(client, schema, table, rowsJson);
    return { ok: true, branch, schema, table, staged };
  });
}

export async function presignVibeEnvironmentObject(
  branch: string,
  key: string,
  checksumCrc64Nvme: string
): Promise<
  | { ok: true; branch: string; schema: string; uploadUrl: string }
  | VibeEnvironmentFailure
> {
  if (!isAcceptableObjectKey(key, VIBE_ENVIRONMENT_OBJECT_KEY_MAX_LENGTH)) {
    return failure(
      VibeEnvironmentFailureReason.Refused,
      "Refusing an object key that is empty, absolute, too long, or climbs a directory"
    );
  }
  const target = await resolveTarget(branch);
  if (!target.ok) {
    return target;
  }
  const { schema } = target.value;
  return withVibeEnvironment(target.value, AWAITING_SEED, async () => {
    const uploadUrl = await presignTranscriptPutObject({
      key: `${vibeEnvironmentKeyPrefix(schema)}${key}`,
      checksumCrc64Nvme,
    });
    return { ok: true, branch, schema, uploadUrl };
  });
}

export type PersonRequest = { personEmail: string; clerkOrgId?: string };

export type VibeEnvironmentFinalized = {
  ok: true;
  branch: string;
  schema: string;
  tables: number;
  rows: number;
  transcripts: { reconciled: number; missing: number };
  clerkOrgId: string;
  /** Whether the person's Clerk role in that org is an admin role. */
  personOrgAdmin: boolean;
  /**
   * ISS-12135 bug 47: who the run bound and adopted, for its log; `chosenBy`
   * says why that org (an older API omits it).
   */
  boundOrg: {
    clerkOrgId: string;
    name: string;
    chosenBy: VibeEnvironmentOrgChoice;
  };
  adoptedPerson: {
    userId: string;
    clerkUserId: string;
    email: string;
    name: string;
  };
};

export async function finalizeVibeEnvironment(
  branch: string,
  request: PersonRequest
): Promise<VibeEnvironmentFinalized | VibeEnvironmentFailure> {
  const target = await resolveTarget(branch);
  if (!target.ok) {
    return target;
  }
  const person = await resolveAdminPerson(request);
  if (!person.ok) {
    return person;
  }
  const { schema } = target.value;
  const { identity } = person;
  const profile = await loadPersonProfile(identity.clerkUserId);
  return withVibeEnvironment(target.value, AWAITING_SEED, async (client) => {
    let adoptedUserId = "";
    const restored = await restoreStagedVibeSeedRows(
      client,
      schema,
      {
        log: (message: string) => log.info(message),
        warn: (message: string) => log.warn(message),
      },
      async (tx) => {
        await bindSeededOrganization(
          tx,
          schema,
          identity.clerkOrgId,
          seededOrganizationName(profile.email)
        );
        const adopted = await adoptSeededPerson(
          tx,
          schema,
          identity.clerkOrgId,
          profile
        );
        adoptedUserId = adopted.userId;
      }
    );
    const transcripts = await reconcileTranscriptEtags(client, schema);
    await writeSchemaComment(
      client,
      schema,
      formatVibeEnvironmentMarker(SEEDED_READY)
    );
    return {
      ok: true as const,
      branch,
      schema,
      ...restored,
      transcripts,
      clerkOrgId: identity.clerkOrgId,
      personOrgAdmin: identity.isOrgAdmin,
      boundOrg: {
        clerkOrgId: identity.clerkOrgId,
        name: identity.clerkOrgName,
        chosenBy: identity.chosenBy,
      },
      adoptedPerson: {
        userId: adoptedUserId,
        clerkUserId: profile.clerkUserId,
        email: profile.email,
        name: [profile.firstName, profile.lastName].filter(Boolean).join(" "),
      },
    };
  });
}

export async function mintVibeEnvironmentDesktopSession(
  branch: string,
  request: PersonRequest & { desktopAuth: DesktopAuthClaim },
  now: Date = new Date()
): Promise<
  | {
      ok: true;
      branch: string;
      schema: string;
      sessionId: string;
      created: boolean;
    }
  | VibeEnvironmentFailure
> {
  const target = await resolveTarget(branch);
  if (!target.ok) {
    return target;
  }
  const { schema } = target.value;
  return withVibeEnvironment(
    target.value,
    {
      accepts: (marker) => marker !== null,
      notAccepted:
        "The schema is not a vibe environment; ensure it with vibeEnvironment first",
    },
    async (client) => {
      const person = await resolvePerson(
        request,
        request.clerkOrgId === undefined
          ? { boundOrgIds: await listBoundClerkOrgIds(client, schema) }
          : {}
      );
      if (!person.ok) {
        return person;
      }
      const minted = await mintPersonDesktopSession(
        client,
        schema,
        person.identity,
        request.desktopAuth,
        now
      );
      return {
        ok: true as const,
        branch,
        schema,
        sessionId: minted.sessionId,
        created: minted.created,
      };
    }
  );
}

async function resolvePerson(
  request: PersonRequest,
  options: { requireAdmin?: boolean; boundOrgIds?: readonly string[] } = {}
): Promise<
  { ok: true; identity: PersonClerkIdentity } | VibeEnvironmentFailure
> {
  const resolved = await resolvePersonClerkIdentity(
    request.personEmail,
    request.clerkOrgId,
    undefined,
    options
  );
  if ("refused" in resolved) {
    return {
      ...failure(VibeEnvironmentFailureReason.Refused, resolved.refused),
      ...(resolved.code === undefined ? {} : { code: resolved.code }),
      ...(resolved.clerkOrgs === undefined
        ? {}
        : { details: { clerkOrgs: resolved.clerkOrgs } }),
    };
  }
  return { ok: true, identity: resolved };
}

export type VibeEnvironmentPersonChecked = {
  ok: true;
  branch: string;
  clerkOrgId: string;
  personOrgAdmin: boolean;
  /** ISS-12135: the org's name and why it was chosen, for the run's log. */
  clerkOrgName: string;
  clerkOrgChosenBy: VibeEnvironmentOrgChoice;
};

/**
 * ISS-12135 bug 19: the finalize route's person checks, read-only and on their
 * own, so `vibe-environment.yml` can refuse a seeded request in its first
 * minute instead of after the seed. Touches no schema and nothing in Clerk.
 */
export async function checkVibeEnvironmentPerson(
  branch: string,
  request: PersonRequest
): Promise<VibeEnvironmentPersonChecked | VibeEnvironmentFailure> {
  const target = await resolveTarget(branch);
  if (!target.ok) {
    return target;
  }
  const person = await resolveAdminPerson(request);
  if (!person.ok) {
    return person;
  }
  return {
    ok: true,
    branch,
    clerkOrgId: person.identity.clerkOrgId,
    personOrgAdmin: person.identity.isOrgAdmin,
    clerkOrgName: person.identity.clerkOrgName,
    clerkOrgChosenBy: person.identity.chosenBy,
  };
}

/** {@link resolvePerson} for an org the person administers. */
function resolveAdminPerson(
  request: PersonRequest
): Promise<
  { ok: true; identity: PersonClerkIdentity } | VibeEnvironmentFailure
> {
  return resolvePerson(request, { requireAdmin: true });
}
