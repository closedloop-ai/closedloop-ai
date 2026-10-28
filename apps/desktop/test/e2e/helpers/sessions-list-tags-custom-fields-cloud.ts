/**
 * ISS-12455: the cloud routes the Sessions LIST reads when a signed-in Desktop
 * user has org tags and a table-visible Session custom field, as `extraRoutes`
 * for the authenticated session stand-in.
 *
 * The list route is overridden here because the stand-in's own serves an empty
 * list, and `extraRoutes` is consulted first — the same reason
 * `sessions-list-project-cloud.ts` overrides it.
 *
 * Every route requires the bearer token, so a read that did not cross the
 * authenticated bridge cannot fill either column.
 *
 * ISS-12691 added `GET /artifacts/favorites` and `POST`/`DELETE
 * /artifacts/{id}/favorite` here too — same stand-in, same bearer check — so
 * the favorite star this list row now carries has somewhere real to read from
 * and write to.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
// `.ts` is load-bearing: an extensionless `@repo/*` subpath resolves in the app
// but not under the spec loader, and that aborts the WHOLE e2e suite at import
// time (`apps/desktop/test/AGENTS.md` -> Import hazard).
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session.ts";
import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field.ts";
import {
  ArtifactTagAvailability,
  type Tag,
  TagColor,
} from "@repo/api/src/types/tag.ts";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  rejectUnauthorized,
  writeApiResult,
} from "./branch-details-authenticated-cloud";

/** Origin only `URL.parse` needs; the stand-in serves on its own port. */
const REQUEST_ORIGIN = "http://127.0.0.1";
const HOUR_MS = 60 * 60 * 1000;
const FIELD_ID = "4b8c1d26-9f47-4a03-8e51-7c2a6b9d0e38";

export const LIST_SESSION_ID = "6e3a9c41-2b78-4d50-9f16-8a4c7d2e5b93";
export const LIST_SESSION_NAME = "iss-12455 list row";
export const CUSTOM_FIELD_NAME = "Squad";
export const CUSTOM_FIELD_VALUE = "Platform";
export const CUSTOM_FIELD_COLUMN_ID = `custom-field:${FIELD_ID}`;

export const CLOUD_TAG: Tag = {
  id: "0f5d8a73-6c24-4b19-9e08-3a1f7b6c2d45",
  organizationId: AUTHENTICATED_ORGANIZATION_ID,
  name: "needs-triage",
  color: TagColor.Blue,
  createdById: AUTHENTICATED_USER_ID,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
};

const SESSION_FIELD = {
  id: FIELD_ID,
  organizationId: AUTHENTICATED_ORGANIZATION_ID,
  name: CUSTOM_FIELD_NAME,
  description: null,
  fieldType: CustomFieldType.Text,
  createdById: AUTHENTICATED_USER_ID,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  precision: null,
  numberFormat: null,
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  isGlobalToOrg: true,
  entityTypes: [CustomFieldEntityType.Session],
  referenceTargetSources: [],
  showInTable: true,
  isSearchable: false,
  isSortable: false,
  enumOptions: [],
};

/**
 * `GET /agent-sessions` carrying one tagged session with one custom-field
 * value, plus the `GET /custom-fields` definitions and `GET /tags` vocabulary
 * both columns need.
 *
 * The row carries `customFields` as its own key, which is the precondition
 * `useSessionsCustomFieldsController` checks before it issues the definitions
 * read at all — a row without the key leaves the whole controller undefined and
 * the spec would fail on a missing header for the wrong reason.
 */
/** `/artifacts/{id}/favorite` — a capture group, not a literal suffix. */
const FAVORITE_ROUTE_PATTERN = /^\/artifacts\/([^/]+)\/favorite$/;

export function sessionsListTagsCustomFieldsCloudRoutes() {
  // ISS-12691: mutable across requests, so the POST/DELETE the star issues is
  // visible to the GET the mutation's own cache invalidation triggers next —
  // a stand-in that always answered the same array could not prove the write
  // actually landed anywhere.
  const favoriteIds = new Set<string>();

  const route = (
    request: IncomingMessage,
    response: ServerResponse
  ): boolean => {
    const pathname = URL.parse(
      `${REQUEST_ORIGIN}${request.url ?? "/"}`
    )?.pathname;
    if (!isOwnedPath(request.method, pathname)) {
      return false;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      rejectUnauthorized(response);
      return true;
    }
    return respondToOwnedPath({
      favoriteIds,
      method: request.method,
      pathname,
      response,
    });
  };

  return { route };
}

function isOwnedPath(
  method: string | undefined,
  pathname: string | null | undefined
): boolean {
  if (method === "GET") {
    return (
      pathname === "/agent-sessions" ||
      pathname === "/custom-fields" ||
      pathname === "/tags" ||
      pathname === "/artifacts/favorites"
    );
  }
  return (
    (method === "POST" || method === "DELETE") &&
    FAVORITE_ROUTE_PATTERN.test(pathname ?? "")
  );
}

function respondToOwnedPath({
  favoriteIds,
  method,
  pathname,
  response,
}: {
  favoriteIds: Set<string>;
  method: string | undefined;
  pathname: string | null | undefined;
  response: ServerResponse;
}): boolean {
  const favoriteId = pathname?.match(FAVORITE_ROUTE_PATTERN)?.[1];
  if (favoriteId) {
    if (method === "POST") {
      favoriteIds.add(favoriteId);
    } else {
      favoriteIds.delete(favoriteId);
    }
    writeApiResult(response, { favorited: favoriteIds.has(favoriteId) });
    return true;
  }
  if (pathname === "/custom-fields") {
    writeApiResult(response, [SESSION_FIELD]);
    return true;
  }
  if (pathname === "/tags") {
    writeApiResult(response, [CLOUD_TAG]);
    return true;
  }
  if (pathname === "/artifacts/favorites") {
    writeApiResult(
      response,
      [...favoriteIds].map((id) => ({ id }))
    );
    return true;
  }
  // `viewerScope` is part of the response contract, not decoration: the
  // stand-in's own empty fixture carries it, and the surface reads it.
  writeApiResult(response, {
    items: [listItem()],
    total: 1,
    viewerScope: AgentSessionViewerScope.Organization,
  });
  return true;
}

/**
 * One tagged session holding one custom-field value.
 *
 * Only the fields the two cells and the row identity read are pinned; naming
 * more would make this fixture claim a contract it is not testing.
 */
function listItem() {
  return {
    id: LIST_SESSION_ID,
    name: LIST_SESSION_NAME,
    status: "inactive",
    linkedArtifacts: [],
    tags: [{ color: CLOUD_TAG.color, id: CLOUD_TAG.id, name: CLOUD_TAG.name }],
    tagAvailability: ArtifactTagAvailability.Available,
    tagPermissions: { canApply: true, canRemove: true },
    customFields: [
      {
        id: `${FIELD_ID}-value`,
        customFieldId: FIELD_ID,
        entityId: LIST_SESSION_ID,
        name: CUSTOM_FIELD_NAME,
        fieldType: CustomFieldType.Text,
        displayValue: CUSTOM_FIELD_VALUE,
        showInTable: true,
        textValue: CUSTOM_FIELD_VALUE,
        numberValue: null,
        dateValue: null,
        enumValue: null,
        multiEnumValues: [],
        peopleValues: [],
        referenceValues: [],
      },
    ],
    // Relative to NOW, never pinned. The list defaults to a 7-day window, so a
    // fixed instant ages out of it and empties this spec on a calendar boundary
    // with no code change (ISS-12442).
    startedAt: new Date(Date.now() - HOUR_MS).toISOString(),
    lastActivityAt: new Date(Date.now() - HOUR_MS / 2).toISOString(),
  };
}
