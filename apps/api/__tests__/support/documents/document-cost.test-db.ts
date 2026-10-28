import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import type {
  DocumentCostsRequest,
  DocumentCostsResponse,
} from "@repo/api/src/types/document-costs";
import { ArtifactRefRelation } from "@repo/api/src/types/session-artifact-link";
import { documentCostScopeService } from "@/app/documents/document-cost-scope-service";

export type FakeCostDoc = {
  id: string;
  organizationId: string;
  subtype: string;
  type?: string;
};
export type FakeCostLink = {
  sessionId: string;
  docId: string;
  organizationId: string;
  /** Overrides the session's organization as seen by `source.is`. */
  sourceOrg?: string;
  /** Overrides the document's organization as seen by `target.is`. */
  targetOrg?: string;
  relation?: string;
};
export type FakeCostSession = {
  id: string;
  organizationId: string;
  inputTokens: bigint;
  estimatedCost: number | null;
};
export type FakeTokenEvent = {
  id: string;
  sessionId: string;
  inputTokens: bigint;
  cost: number | null;
  completeness: string | null;
  date: Date;
};
export type DocumentCostDbState = {
  docs: FakeCostDoc[];
  links: FakeCostLink[];
  sessions: FakeCostSession[];
  events: FakeTokenEvent[];
};

type OrgIs = { is: { organizationId?: string } };

export function emptyDocumentCostState(): DocumentCostDbState {
  return { docs: [], links: [], sessions: [], events: [] };
}

/**
 * Prisma fake for document-cost reads. Every filter applies only the keys the
 * service put in its `where` (an absent key constrains nothing), so org
 * scoping is decided by the production predicate, not by the test.
 */
export function createDocumentCostDb(state: () => DocumentCostDbState) {
  const sessionOrg = (sessionId: string) =>
    state().sessions.find((session) => session.id === sessionId)
      ?.organizationId;
  const docOrg = (docId: string) =>
    state().docs.find((doc) => doc.id === docId)?.organizationId;
  return {
    artifact: {
      findMany: ({
        where,
        take,
        cursor,
      }: {
        where: {
          organizationId?: string;
          type?: string;
          subtype?: { in: string[] };
          id?: { in: string[] };
        };
        take?: number;
        cursor?: { id: string };
      }) =>
        state()
          .docs.filter(
            (doc) =>
              (!where.organizationId ||
                doc.organizationId === where.organizationId) &&
              (!where.type ||
                (doc.type ?? ArtifactType.Document) === where.type) &&
              (!where.subtype || where.subtype.in.includes(doc.subtype)) &&
              (!where.id || where.id.in.includes(doc.id))
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .filter((doc) => !cursor || doc.id > cursor.id)
          .slice(0, take)
          .map((doc) => ({ id: doc.id })),
    },
    artifactLink: {
      findMany: ({
        where,
      }: {
        where: {
          organizationId?: string;
          targetId: { in: string[] };
          source: OrgIs;
          target: OrgIs;
        };
      }) =>
        state()
          .links.filter(
            (link) =>
              (!where.organizationId ||
                link.organizationId === where.organizationId) &&
              where.targetId.in.includes(link.docId) &&
              (!where.source.is.organizationId ||
                (link.sourceOrg ?? sessionOrg(link.sessionId)) ===
                  where.source.is.organizationId) &&
              (!where.target.is.organizationId ||
                (link.targetOrg ?? docOrg(link.docId)) ===
                  where.target.is.organizationId)
          )
          .map((link) => ({
            sourceId: link.sessionId,
            targetId: link.docId,
            linkType: LinkType.RelatesTo,
            branchParticipation: null,
            metadata: {
              relation: link.relation ?? ArtifactRefRelation.Created,
            },
          })),
    },
    sessionDetail: {
      findMany: ({
        where,
      }: {
        where: { artifactId: { in: string[] }; artifact: OrgIs };
      }) =>
        state()
          .sessions.filter(
            (session) =>
              where.artifactId.in.includes(session.id) &&
              (!where.artifact.is.organizationId ||
                session.organizationId === where.artifact.is.organizationId)
          )
          .map((session) => ({
            artifactId: session.id,
            inputTokens: session.inputTokens,
            outputTokens: 0n,
            cacheReadTokens: 0n,
            cacheWriteTokens: 0n,
            estimatedCost: session.estimatedCost,
          })),
    },
    agentSessionTokenEvent: {
      groupBy: ({
        where,
        by,
      }: {
        where: {
          agentSessionId: { in: string[] };
          session: { is: { artifact: OrgIs } };
          eventCreatedAt?: { gte?: Date; lt?: Date };
        };
        by: string[];
      }) => {
        const orgId = where.session.is.artifact.is.organizationId;
        const groups = new Map<string, FakeTokenEvent[]>();
        for (const event of state().events) {
          if (
            !where.agentSessionId.in.includes(event.sessionId) ||
            (orgId && sessionOrg(event.sessionId) !== orgId) ||
            (where.eventCreatedAt?.gte &&
              event.date < where.eventCreatedAt.gte) ||
            (where.eventCreatedAt?.lt && event.date >= where.eventCreatedAt.lt)
          ) {
            continue;
          }
          const key =
            by.length === 1
              ? event.sessionId
              : `${event.sessionId}|${event.completeness}`;
          groups.set(key, [...(groups.get(key) ?? []), event]);
        }
        return [...groups.values()].map((rows) =>
          by.length === 1 ? lifetimeRow(rows) : windowedRow(rows)
        );
      },
    },
    // Mirrors dailySessionCostsSql's bound values: trend start, Complete
    // (measured), Complete (invalid filter), organization, session ids, trend
    // start, now.
    $queryRaw: ({ values }: { values: unknown[] }) => {
      const [startAt, complete, , orgId, sessionIds, , nowAt] = values as [
        string,
        string,
        string,
        string,
        string[],
        string,
        string,
      ];
      const start = new Date(startAt);
      const bins = new Map<string, DailyBin>();
      for (const event of state().events) {
        if (
          !sessionIds.includes(event.sessionId) ||
          sessionOrg(event.sessionId) !== orgId ||
          event.date < start ||
          event.date >= new Date(nowAt)
        ) {
          continue;
        }
        const day = Math.floor(
          (event.date.getTime() - start.getTime()) / 86_400_000
        );
        const key = `${event.sessionId}|${day}`;
        const bin = bins.get(key) ?? {
          agentSessionId: event.sessionId,
          day,
          cost: 0,
          measured: true,
          invalidEventId: null,
        };
        bin.cost += event.cost ?? 0;
        bin.measured &&= event.completeness === complete && event.cost !== null;
        if (
          event.completeness === complete &&
          event.cost !== null &&
          (event.cost < 0 || Number.isNaN(event.cost))
        ) {
          bin.invalidEventId ??= event.id;
        }
        bins.set(key, bin);
      }
      return [...bins.values()];
    },
  };
}

type DailyBin = {
  agentSessionId: string;
  day: number;
  cost: number;
  measured: boolean;
  invalidEventId: string | null;
};

function lifetimeRow(rows: FakeTokenEvent[]) {
  return {
    agentSessionId: rows[0].sessionId,
    _sum: {
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0n),
      outputTokens: 0n,
      cacheReadTokens: 0n,
      cacheWriteTokens: 0n,
    },
  };
}

function windowedRow(rows: FakeTokenEvent[]) {
  const priced = rows.flatMap((row) => (row.cost === null ? [] : [row.cost]));
  return {
    agentSessionId: rows[0].sessionId,
    costCompleteness: rows[0].completeness,
    _sum: { estimatedCost: priced.reduce((sum, cost) => sum + cost, 0) },
    _min: { estimatedCost: priced.length === 0 ? null : Math.min(...priced) },
    _count: { _all: rows.length, estimatedCost: priced.length },
  };
}

/** A scoped cost read through the route's own entry point. */
export async function readScopedDocumentCosts(
  organizationId: string,
  request: DocumentCostsRequest,
  userId = "user-cost-reader"
): Promise<DocumentCostsResponse> {
  const result = await documentCostScopeService.read(
    organizationId,
    userId,
    request
  );
  if (!result.ok) {
    throw new Error(
      `scoped cost read refused: ${JSON.stringify(result.error)}`
    );
  }
  return result.value;
}
