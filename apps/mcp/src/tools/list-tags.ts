import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  TAG_LIST_DEFAULT_LIMIT,
  TAG_LIST_MAX_LIMIT,
  TAG_LIST_MAX_OFFSET,
} from "@repo/api/src/types/tag.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  fetchOrgTagPage,
  TAG_APPLY_SIDE_EFFECT_HELP,
  TAGS_WRITABLE_HELP,
  type TagWireRow,
} from "./tag-resolution.js";
import { buildPaginatedPayload, withErrorHandling } from "./tool-utils.js";

/**
 * Register the list-tags tool. Calls GET /tags and returns one page of the
 * organization's tag catalogue, which is what an agent reads before choosing a
 * name to apply.
 *
 * ISS-7461: the page is now bounded by the SERVER. Before, this tool fetched
 * every tag in the organization and sliced the result in memory — the output
 * was bounded but the database, network, JSON and heap work behind it was not.
 * The bounds travel as query params and the counts come back from the API.
 */
export function registerListTags(
  server: McpServer,
  apiClient: ApiClient
): void {
  server.registerTool(
    "list-tags",
    {
      description: `List one page of the organization's tags, ordered by name. This returns a PAGE, not the whole catalogue: it defaults to ${TAG_LIST_DEFAULT_LIMIT} tags and returns at most ${TAG_LIST_MAX_LIMIT}, so call again with nextOffset until hasMore is false before concluding a tag does not exist. Pass search to narrow by substring instead of paging through everything. ${TAGS_WRITABLE_HELP} Tag names are unique case-insensitively, so a name returned here is the one to pass to tag-artifact. ${TAG_APPLY_SIDE_EFFECT_HELP}`,
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(TAG_LIST_MAX_LIMIT)
          .optional()
          .describe(
            `Maximum number of tags to return (1-${TAG_LIST_MAX_LIMIT})`
          ),
        offset: z
          .number()
          .int()
          .min(0)
          // Bounded by the SHARED constant the API validates against. An
          // unbounded input here would let an agent send an offset the API
          // rejects with a 400, turning what used to be a clean empty page into
          // a tool error.
          .max(TAG_LIST_MAX_OFFSET)
          .optional()
          .describe(
            `Starting offset for pagination (0-${TAG_LIST_MAX_OFFSET}, default 0)`
          ),
        search: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Case-insensitive substring filter on the tag name. Use this to check whether a tag exists instead of paging the whole catalogue."
          ),
      },
    },
    ({ limit, offset, search }) =>
      withErrorHandling(async () => {
        const resolvedLimit = limit ?? TAG_LIST_DEFAULT_LIMIT;
        const resolvedOffset = offset ?? 0;
        const page = await fetchOrgTagPage(apiClient, {
          limit: resolvedLimit,
          offset: resolvedOffset,
          search,
        });
        const payload = buildPaginatedPayload<TagWireRow>(
          page.serverPaged ? page.tags : applyLocalSearch(page.tags, search),
          {
            limit: resolvedLimit,
            offset: resolvedOffset,
            mapItem: (tag) => tag,
            // Only trust server counts when the server actually paged. An older
            // API ignores the params and returns the whole catalogue, and the
            // branch above leaves that array to be filtered and sliced here.
            page: page.serverPaged
              ? { total: page.total, hasMore: page.hasMore }
              : undefined,
          }
        );
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      })
  );
}

/**
 * The `search` predicate, applied locally when the API is too old to have
 * applied it.
 *
 * Without this the fallback would slice an UNFILTERED catalogue and hand the
 * agent an arbitrary page of tags presented as search results — a wrong answer,
 * which is worse than the failure the fallback exists to prevent. Kept as
 * case-insensitive substring so it matches the server's `contains` +
 * insensitive predicate.
 */
function applyLocalSearch(
  tags: TagWireRow[],
  search: string | undefined
): TagWireRow[] {
  if (search === undefined) {
    return tags;
  }
  const needle = search.toLowerCase();
  return tags.filter((tag) => tag.name.toLowerCase().includes(needle));
}
