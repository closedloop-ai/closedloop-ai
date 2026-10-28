import type { SessionMeshWorkspace } from "@repo/api/src/types/session-mesh";
import { withDb } from "@repo/database";
import { boundedMeshPage } from "./bounded-page";

export async function readRosterPage(
  organizationId: string,
  workspace?: Partial<Pick<SessionMeshWorkspace, "repository" | "revision">>,
  cursor?: string
) {
  const rows = await withDb((db) =>
    db.sessionMeshPresence.findMany({
      where: {
        organizationId,
        expiresAt: { gt: new Date() },
        ...(workspace?.repository ? { repository: workspace.repository } : {}),
        ...(workspace?.revision ? { revision: workspace.revision } : {}),
        ...(cursor ? { agentId: { gt: cursor } } : {}),
      },
      select: {
        agentId: true,
        repository: true,
        revision: true,
        dirtyStateHash: true,
        configurationHash: true,
        harness: true,
        capabilities: true,
        lineage: true,
        context: true,
        paths: true,
        symbols: true,
        expiresAt: true,
        user: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { agentId: "asc" },
      take: 501,
    })
  );
  const page = boundedMeshPage(rows, 500);
  const hasMore = rows.length > page.length;
  return {
    agents: page.map(({ context, ...presence }) => ({
      ...presence,
      context:
        context &&
        typeof context === "object" &&
        !Array.isArray(context) &&
        context.sensitivity === "restricted"
          ? { sensitivity: "restricted" }
          : context,
    })),
    ...(hasMore ? { nextCursor: page.at(-1)?.agentId } : {}),
  };
}
