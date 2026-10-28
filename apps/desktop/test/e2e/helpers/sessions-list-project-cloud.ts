/**
 * ISS-12454: the cloud routes the Sessions LIST reads and writes when a
 * signed-in Desktop user files a session into a project, as `extraRoutes` for
 * the authenticated session stand-in.
 *
 * Every route requires the bearer token, which is the whole point of driving
 * this through a launched app: `/artifact-links/batch-move` is a non-GET route,
 * so it only reaches here if the desktop cloud bridge admits it AND attaches the
 * token (`cloud-api-fetch-ipc.ts` carries it as a `BatchMutationRoute`). A write
 * that bypassed the bridge, or crossed it unauthenticated, is recorded as a
 * rejection rather than silently passing.
 *
 * The list route is overridden here because the stand-in's own serves an empty
 * list, and `extraRoutes` is consulted first.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
// `.ts` is load-bearing: an extensionless `@repo/*` subpath resolves in the app
// but not under the spec loader, and that aborts the WHOLE e2e suite at import
// time (`apps/desktop/test/AGENTS.md` -> Import hazard).
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session.ts";
import { ArtifactType } from "@repo/api/src/types/artifact.ts";
import { z } from "zod";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  rejectUnauthorized,
  writeApiResult,
} from "./branch-details-authenticated-cloud";

/** Origin only `URL.parse` needs; the stand-in serves on its own port. */
const REQUEST_ORIGIN = "http://127.0.0.1";
const HOUR_MS = 60 * 60 * 1000;

export const LIST_SESSION_ID = "2f9d6a7e-4c21-4a8b-9b3e-1d5c8f0a7e42";
export const LIST_SESSION_NAME = "iss-12454 list row";
export type Project = Readonly<{ id: string; name: string; slug: string }>;

export const FILED_PROJECT: Project = {
  id: "7c1e5b9a-3d48-4f26-8a70-6e2b4c9d1f33",
  name: "Platform Core",
  slug: "PRO-1",
};
export const TARGET_PROJECT: Project = {
  id: "9a4f2c6d-8b13-4e59-a27c-5f0d3b8e6a14",
  name: "Developer Tooling",
  slug: "PRO-2",
};

export type SessionsListProjectWrite = { body: unknown; authorized: boolean };

/** The two fields the stand-in acts on; the spec asserts the whole body. */
const MOVE_BODY_SCHEMA = z.object({
  artifactId: z.string(),
  targetProjectId: z.string(),
});

/**
 * `GET /agent-sessions` carrying one filed session, `GET /projects`, and a
 * capturing `POST /artifact-links/batch-move`.
 *
 * `writes` records the body the bridge delivered. `unauthorized` counts requests
 * that arrived without the token, so a spec can tell "the write never happened"
 * apart from "the write happened but skipped the bridge".
 *
 * The list route SERVES the write back (whitlockk review): a stand-in that kept
 * answering {@link FILED_PROJECT} forever let a spec assert the new name and
 * pass on a cell that had never repainted, so the read half could not fail.
 * `filedProject` is the session's project as of the last accepted move.
 */
export function sessionsListProjectCloudRoutes() {
  const writes: SessionsListProjectWrite[] = [];
  let unauthorized = 0;
  let filedProject: Project = FILED_PROJECT;

  const route = (
    request: IncomingMessage,
    response: ServerResponse
  ): boolean => {
    const pathname = URL.parse(
      `${REQUEST_ORIGIN}${request.url ?? "/"}`
    )?.pathname;
    const isList = request.method === "GET" && pathname === "/agent-sessions";
    const isProjects = request.method === "GET" && pathname === "/projects";
    const isMove =
      request.method === "POST" && pathname === "/artifact-links/batch-move";
    if (!(isList || isProjects || isMove)) {
      return false;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      unauthorized += 1;
      rejectUnauthorized(response);
      return true;
    }
    if (isProjects) {
      writeApiResult(response, [FILED_PROJECT, TARGET_PROJECT]);
      return true;
    }
    if (isList) {
      // `viewerScope` is part of the response contract, not decoration: the
      // stand-in's own empty fixture carries it, and the surface reads it.
      writeApiResult(response, {
        items: [listItem(filedProject)],
        total: 1,
        viewerScope: AgentSessionViewerScope.Organization,
      });
      return true;
    }
    // Callback collection, not a promise: the handler has to answer
    // synchronously that it OWNS this request while the body is still arriving,
    // and a floating promise is the only other way to express that. Same shape
    // as `details-custom-fields-cloud.ts`.
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body: unknown = raw.trim() === "" ? null : JSON.parse(raw);
      writes.push({ authorized: true, body });
      filedProject = resolveMovedProject(body) ?? filedProject;
      writeApiResult(response, {
        movedArtifacts: [{ id: LIST_SESSION_ID, type: ArtifactType.Session }],
      });
    });
    return true;
  };

  return {
    route,
    writes,
    unauthorizedCount: () => unauthorized,
  };
}

/**
 * One list item filed into `project`. Only the fields the Owning project cell
 * and the row identity read are pinned; the surface tolerates the rest being
 * absent, and naming more would make this fixture claim a contract it is not
 * testing.
 */
function listItem(project: Project) {
  return {
    id: LIST_SESSION_ID,
    name: LIST_SESSION_NAME,
    status: "inactive",
    project,
    linkedArtifacts: [],
    // Relative to NOW, never pinned. The list defaults to a 7-day window, so a
    // fixed instant ages out of it and empties this spec on a calendar boundary
    // with no code change — which is the defect ISS-12442 was filed for.
    startedAt: new Date(Date.now() - HOUR_MS).toISOString(),
    lastActivityAt: new Date(Date.now() - HOUR_MS / 2).toISOString(),
  };
}

/**
 * The project a `batch-move` body names, or `null` when it does not move the one
 * session this stand-in serves.
 *
 * `artifactId` is checked, not just read (tamsinb review): a move naming some
 * other artifact must not repaint THIS row, or the spec's wait would be
 * satisfied by a write against the wrong session. An unrecognised id of either
 * kind leaves the list on the project it already reported rather than inventing
 * one, so a spec waiting for a name fails on the timeout instead of on a
 * fabricated row.
 */
function resolveMovedProject(body: unknown): Project | null {
  const parsed = MOVE_BODY_SCHEMA.safeParse(body);
  if (!parsed.success || parsed.data.artifactId !== LIST_SESSION_ID) {
    return null;
  }
  return (
    [FILED_PROJECT, TARGET_PROJECT].find(
      (project) => project.id === parsed.data.targetProjectId
    ) ?? null
  );
}
