import {
  type SearchHit,
  SearchMode,
  searchHitDeepLink,
  type UnifiedSearchResponse,
} from "@repo/api/src/types/search";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import {
  liveAppShellRoutes,
  organizationUsersFixture,
} from "./live-app-fixtures";

// The live Search route (`apps/app/.../search/components/search-results.tsx`)
// reads `GET /search?q=…&mode=fulltext` for the query in the URL. This is the
// answer for "transcript" in a workspace with documents, a project, a session
// and an agent component that mention it.

export const SEARCH_QUERY = "transcript";

function hit(
  entityType: SearchHit["entityType"],
  entityId: string,
  title: string,
  snippet: string,
  daysAgo: number,
  extra: Partial<SearchHit> = {}
): SearchHit {
  return {
    deepLink: searchHitDeepLink(entityType, entityId),
    entityId,
    entityType,
    rank: 1 - daysAgo / 100,
    snippet,
    title,
    updatedAt: new Date(Date.UTC(2026, 9, 6 - daysAgo, 14, 0, 0)),
    ...extra,
  };
}

export const searchHitsFixture: SearchHit[] = [
  hit(
    SearchEntityType.Document,
    "doc_task_1",
    "Fix session transcripts truncating at 2 MB",
    "uploads stop at 2 MB, so long <b>transcripts</b> lose their tail",
    0,
    { entitySubtype: "FEATURE", slug: "ISS-1042" }
  ),
  hit(
    SearchEntityType.Document,
    "doc_task_3",
    "Session reliability: zero lost transcripts",
    "every synced session keeps its full <b>transcript</b>, even offline",
    2,
    { entitySubtype: "PRD", slug: "PRD-212" }
  ),
  hit(
    SearchEntityType.Document,
    "doc_task_4",
    "Chunked transcript upload plan",
    "split each <b>transcript</b> into 512 KB chunks and resume on failure",
    3,
    { entitySubtype: "IMPLEMENTATION_PLAN", slug: "PLN-318" }
  ),
  hit(
    SearchEntityType.Project,
    "prj_reliability",
    "Session Reliability",
    "sync, upload and <b>transcript</b> durability for the desktop app",
    5
  ),
  hit(
    SearchEntityType.AgentSession,
    "ses_backfill",
    "Overnight backfill of usage rollups",
    "re-read 1,204 <b>transcripts</b> to rebuild the token rollups",
    1
  ),
];

export function searchResponse(
  results: SearchHit[],
  query = SEARCH_QUERY
): UnifiedSearchResponse {
  return { mode: SearchMode.Fulltext, nextCursor: null, query, results };
}

export const searchApiRoutes: FixtureRoute[] = [
  ...liveAppShellRoutes,
  { method: "GET", path: "/users", respond: () => organizationUsersFixture },
  {
    method: "GET",
    path: "/search",
    respond: () => searchResponse(searchHitsFixture),
  },
];
