// Resolves notification entity URLs from structured identifiers.
// Single source of truth for the route shapes used by inbox notifications,
// so backend dispatchers never hardcode frontend paths inline.

import { getRoutePrefixForType } from "./document";

export const NotificationEntityKind = {
  Artifact: "artifact",
  Project: "project",
  Loop: "loop",
  Session: "session",
} as const;
export type NotificationEntityKind =
  (typeof NotificationEntityKind)[keyof typeof NotificationEntityKind];

export type NotificationEntityRouteParams =
  | {
      kind: typeof NotificationEntityKind.Artifact;
      slug: string;
      // Document subtype (PRD | IMPLEMENTATION_PLAN | FEATURE | TEMPLATE).
      // Accepts a raw string so callers don't have to narrow before passing.
      subtype: string;
    }
  | {
      kind: typeof NotificationEntityKind.Project;
      teamId: string;
      projectId: string;
    }
  | {
      kind: typeof NotificationEntityKind.Loop;
      loopId: string;
    }
  | {
      kind: typeof NotificationEntityKind.Session;
      sessionId: string;
    };

const ARTIFACT_FALLBACK_PREFIX = "documents";

export function getNotificationEntityPath(
  params: NotificationEntityRouteParams
): string {
  switch (params.kind) {
    case NotificationEntityKind.Artifact: {
      const prefix =
        getRoutePrefixForType(params.subtype) ?? ARTIFACT_FALLBACK_PREFIX;
      return `/${prefix}/${params.slug}`;
    }
    case NotificationEntityKind.Project:
      return `/teams/${params.teamId}/projects/${params.projectId}`;
    case NotificationEntityKind.Loop:
      return `/loops/${params.loopId}`;
    case NotificationEntityKind.Session:
      return `/sessions/${params.sessionId}`;
    default: {
      const exhaustive: never = params;
      throw new Error(
        `Unhandled notification entity kind: ${JSON.stringify(exhaustive)}`
      );
    }
  }
}
