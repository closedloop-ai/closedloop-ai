import { type Prisma, withDb } from "@repo/database";
import type { SessionListParityWrite } from "@repo/lib/sessions/__tests__/session-list-parity-concurrency";
import {
  SESSION_LIST_PARITY_OWNER_NAMES,
  SessionListParityOwner,
  SessionListParityPullRequest,
  type SessionListParityRead,
  type SessionListParityRow,
} from "@repo/lib/sessions/__tests__/session-list-parity-model";
import { z } from "zod";
import {
  type createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { listQueryRefusalMetadata } from "@/app/agent-sessions/list-query-param";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { agentSessionListQuerySchema } from "@/app/agent-sessions/validators";
import { parseQueryParams } from "@/lib/route-utils";

/**
 * The CLOUD half of the Sessions list parity harness (ISS-9584, ISS-9483):
 * seeding a scenario's rows into a committed organization, writing to them,
 * and reading the list the way `GET /agent-sessions` does. The runners are
 * `app/agent-sessions/service/session-list-parity*.integration.test.ts`.
 */

type OrganizationTracker = ReturnType<
  typeof createCommittedTestOrganizationTracker
>;

export type ParityCloudHost = {
  organizationId: string;
  ownerIds: Record<SessionListParityOwner, string>;
  /** Fixture key → the `artifactId` this host minted for it. */
  artifactIds: Map<string, string>;
};

/** Query params as a client sends them: an array is a repeated param. */
export type ParityQueryParams = Readonly<
  Record<string, string | number | readonly string[]>
>;

const refusalBodySchema = z.object({ code: z.string() });

export async function seedParityHost(
  organizations: OrganizationTracker,
  rows: readonly SessionListParityRow[]
): Promise<ParityCloudHost> {
  const organizationId = await organizations.create();
  const ownerIds: Record<SessionListParityOwner, string> = {
    [SessionListParityOwner.A]: "",
    [SessionListParityOwner.B]: "",
  };
  for (const owner of Object.values(SessionListParityOwner)) {
    const user = await createTestUser(
      organizationId,
      SESSION_LIST_PARITY_OWNER_NAMES[owner]
    );
    ownerIds[owner] = user.id;
  }
  const artifactIds = new Map<string, string>();
  // Sequential on purpose: the identity-tie row relies on each artifact id
  // being minted after the one before it.
  for (const row of rows) {
    artifactIds.set(
      row.key,
      await seedParityRow(organizationId, ownerIds[row.owner], row)
    );
  }
  return { organizationId, ownerIds, artifactIds };
}

/** A copy of `template` in ANOTHER organization; returns its owner's id. */
export async function seedParityDecoy(
  organizations: OrganizationTracker,
  template: SessionListParityRow,
  key: string
): Promise<string> {
  const organizationId = await organizations.create();
  const user = await createTestUser(organizationId);
  await seedParityRow(organizationId, user.id, { ...template, key });
  return user.id;
}

/**
 * Read the list as `GET /agent-sessions` does: the params travel as a query
 * string (an array as a repeated param, the way the HTTP data source's
 * `buildSearchParams` sends one), the route's `parseQueryParams` runs the
 * schema — and with it the ISS-9477 `listQuery` lowering — and `findSessions`
 * reads the page.
 */
export async function readParityParams(
  organizationId: string,
  params: ParityQueryParams
): Promise<SessionListParityRead> {
  const response = await readParityResponse(organizationId, params);
  return {
    keys: response.items.map((item) => item.externalSessionId),
    total: response.total,
  };
}

/** The refusal code the route answers `params` with; `null` when it serves them. */
export async function readParityRefusal(
  params: ParityQueryParams
): Promise<string | null> {
  const { errorResponse } = parseListParams(params);
  if (!errorResponse) {
    return null;
  }
  const body = refusalBodySchema.safeParse(await errorResponse.json());
  return body.success ? body.data.code : null;
}

/**
 * Apply one parity write to the row the fixture key names. The lifecycle
 * status is the session ARTIFACT's column on the cloud; the activity and end
 * instants are `SessionDetail`'s.
 */
export async function applyParityWrite(
  host: ParityCloudHost,
  write: SessionListParityWrite
): Promise<void> {
  const artifactId = host.artifactIds.get(write.key);
  if (!artifactId) {
    throw new Error(`no artifact seeded for ${write.key}`);
  }
  const updatedAt = new Date(write.updatedAt);
  await withDb((db) =>
    db.sessionDetail.update({
      where: { artifactId },
      data: {
        ...(write.lastActivityAt === undefined
          ? {}
          : { lastActivityAt: new Date(write.lastActivityAt) }),
        ...(write.endedAt === undefined
          ? {}
          : {
              sessionEndedAt:
                write.endedAt === null ? null : new Date(write.endedAt),
            }),
        updatedAt,
      },
      select: { artifactId: true },
    })
  );
  await withDb((db) =>
    db.artifact.update({
      where: { id: artifactId },
      data: {
        ...(write.status === undefined ? {} : { status: write.status }),
        updatedAt,
      },
      select: { id: true },
    })
  );
}

function parseListParams(params: ParityQueryParams) {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const entry of typeof value === "object" ? value : [value]) {
      searchParams.append(key, String(entry));
    }
  }
  return parseQueryParams(
    { nextUrl: { searchParams } },
    agentSessionListQuerySchema,
    { errorMetadata: listQueryRefusalMetadata }
  );
}

/**
 * One session artifact and `SessionDetail`, then the columns
 * `createTestSessionDetail` does not take. `externalSessionId` is set to the
 * fixture key: the id the desktop serves the same session under. Both
 * `updated_at` columns are written LAST, because the `updated` sort reads the
 * later of the two and every earlier write re-stamps them.
 */
async function seedParityRow(
  organizationId: string,
  userId: string,
  row: SessionListParityRow
): Promise<string> {
  const artifactId = await createTestSessionDetail({
    organizationId,
    userId,
    label: row.key,
    status: row.status,
    sessionTimestamp: new Date(row.startedAt),
    lastActivityAt: new Date(row.lastActivityAt),
    sessionEndedAt: row.endedAt === null ? null : new Date(row.endedAt),
    cost: {
      estimatedCost: row.sessionTotalCostUsd ?? row.costUsd,
      billingMode: "api",
    },
  });
  const updatedAt = new Date(row.updatedAt);
  await withDb((db) =>
    db.sessionDetail.update({
      where: { artifactId },
      data: {
        externalSessionId: row.key,
        harness: row.harness,
        model: row.model,
        repositoryFullName: row.repositoryFullName,
        autonomy: row.autonomy,
        turns: row.turns,
        linesAdded: row.linesAdded,
        pullRequests:
          row.pullRequest === SessionListParityPullRequest.None
            ? undefined
            : ([
                { number: 9584, url: "https://example.com/pull/9584" },
              ] satisfies Prisma.InputJsonValue),
        updatedAt,
      },
      select: { artifactId: true },
    })
  );
  await withDb((db) =>
    db.artifact.update({
      where: { id: artifactId },
      data: { priority: row.priority, updatedAt },
      select: { id: true },
    })
  );
  return artifactId;
}

/** The whole list response {@link readParityParams} reads its keys from. */
export async function readParityResponse(
  organizationId: string,
  params: ParityQueryParams
) {
  const { params: filters, errorResponse } = parseListParams(params);
  if (errorResponse) {
    throw new Error(
      `the cloud refused a parity query: ${JSON.stringify(await errorResponse.json())}`
    );
  }
  return await agentSessionsService.findSessions({ organizationId, filters });
}
