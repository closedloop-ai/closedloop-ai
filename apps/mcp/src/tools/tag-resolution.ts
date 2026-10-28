import { DocumentType } from "@repo/api/src/types/document.js";
import { TAG_LIST_DEFAULT_LIMIT } from "@repo/api/src/types/tag.js";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import { McpApiError } from "../api-error.js";
import {
  asRecord,
  buildQuery,
  encodePathSegment,
  extractArrayItems,
  readString,
} from "./tool-utils.js";

/**
 * A tag as it arrives on the wire, before any palette validation.
 *
 * Deliberately NOT `TagSummary`. `TagSummary.color` is the closed `TagColor`
 * union, and `readTagSummaries` drops any row whose colour falls outside it —
 * correct for the document projection it was written for, wrong for the tag
 * catalogue. `tags.color` is a plain `String` column, so an out-of-palette
 * value is storable (by a direct write, a legacy row, or a future palette
 * shrink); dropping such a row here would make the tag invisible to
 * `list-tags` AND unmatchable by name, so `tag-artifact` would try to create
 * it, hit the `(organization_id, lower(name))` unique index, re-read, drop it
 * again — and that tag could never be applied. `apps/mcp/AGENTS.md` sanctions
 * exactly this: a narrow local JSON-wire variant.
 */
export type TagWireRow = { id: string; name: string; color: string | null };

export type ResolvedTag = { tag: TagWireRow; created: boolean };

/**
 * A 409 from `POST /tags` means the name already exists case-insensitively —
 * either the service's pre-read or the unique index caught it. Re-reading the
 * list is how the winner of that race is found.
 */
const CONFLICT_STATUS = 409;

/**
 * Two passes: read-then-create, and one re-read after a conflict. A 409 proves
 * the name existed at that instant, so a second miss can only be a concurrent
 * delete — retrying past that trades a clear error for an unbounded loop.
 */
export const MAX_TAG_CREATE_ATTEMPTS = 2;

/**
 * Shared description fragments.
 *
 * ISS-6967 exists because an agent inferred from the tool schemas that tags
 * were not a concept and created a whole project as a substitute, so every tag
 * tool says outright that this surface is writable — and says it in the same
 * words, from here, so one tool cannot drift into implying otherwise.
 */
export const TAGS_WRITABLE_HELP =
  "Tags are READABLE AND WRITABLE through MCP: list-tags reads them, tag-artifact applies one, untag-artifact removes one. Use a tag to group work thematically — do NOT create a project for that.";

export const TAG_APPLY_SIDE_EFFECT_HELP =
  "Side effect: applying a tag reconciles labels on the artifact's linked GitHub pull requests, so a label may appear on GitHub. Reconciliation is additive — removing the tag does NOT retract a label already pushed.";

/**
 * Removal is not the inverse of application. `tagService.removeTag` deletes the
 * link and then runs the SAME additive reconciliation as an apply, over the
 * artifact's remaining tags, so the only external write a removal can perform
 * is an ADD for a different tag. An agent that reads "remove" as subtractive
 * would not expect that, which is why it is stated rather than left implied.
 */
export const TAG_REMOVE_SIDE_EFFECT_HELP =
  "Side effect: removal is not purely subtractive. It does NOT retract a label this tag already pushed to a linked GitHub pull request, and it re-runs the same additive reconciliation over the document's REMAINING tags — so removing one tag can ADD a missing GitHub label for another tag the document still has.";

export const TAG_DOCUMENT_SCOPE_HELP =
  "Documents only (PRD-*, PLN-*, ISS-*, DOC-*). Templates are internal blueprints and are rejected. Branches, deployments, and agent sessions cannot be tagged through this tool, and projects are not supported.";

/**
 * The lookup input is deliberately NOT constrained to the create-time charset.
 * `tags.name` is a plain column and the API validator guards only the create
 * path, so a legacy or directly-written row can hold a name the regex rejects.
 * Constraining the lookup would list such a tag and then refuse to apply or
 * remove it — the same dead end `TagWireRow` exists to avoid on `color`. A bad
 * name for a NEW tag is still rejected, by the API, with its own message.
 */
export const TAG_NAME_INPUT_HELP =
  "Tag name, matched case-insensitively against existing tags. An existing tag matches whatever its stored name looks like.";

/** Shape one wire row, dropping anything that cannot identify a tag. */
export function shapeTagRow(value: unknown): TagWireRow | null {
  const row = asRecord(value);
  const id = readString(row.id);
  const name = readString(row.name);
  if (!(id && name)) {
    return null;
  }
  return { id, name, color: readString(row.color) };
}

/**
 * The `TagListPage` envelope as it arrives on the wire.
 *
 * `items` is `unknown[]` deliberately — each row is shaped by `shapeTagRow`,
 * which is what keeps an out-of-palette colour addressable. The schema's job is
 * only to tell an envelope from a bare array at the network boundary.
 */
const tagListPageSchema = z.object({
  items: z.array(z.unknown()),
  total: z.number(),
  hasMore: z.boolean(),
});

/** One page of tags, plus whether the counts came from the server. */
export type TagPage = {
  tags: TagWireRow[];
  total: number;
  hasMore: boolean;
  /**
   * False when the API answered with the legacy bare array, i.e. it predates
   * the paged contract and ignored the query params entirely. The caller must
   * then apply the filtering and slicing itself.
   */
  serverPaged: boolean;
};

function shapeTagRows(rows: Iterable<unknown>): TagWireRow[] {
  const tags: TagWireRow[] = [];
  for (const row of rows) {
    const tag = shapeTagRow(row);
    if (tag) {
      tags.push(tag);
    }
  }
  return tags;
}

/**
 * Read tags, tolerating BOTH wire shapes.
 *
 * `apps/mcp` ships to ECS on its own trigger while `apps/api` rides Vercel, so
 * a NEW image can be talking to an OLD API (a Vercel rollback, or a push that
 * only touches `apps/mcp/**`). That API ignores every query param below and
 * answers with the whole catalogue as a bare array. Reading `.items` off an
 * array yields `undefined`, which would make a tag that exists look absent —
 * and `resolveOrCreateTag` turns "absent" into a create, a 409, and a hard
 * throw. So a bare array is not an error here; it means "no server-side paging
 * happened", and the caller finishes the job locally.
 *
 * Same posture as `normalizeDocumentListResponse` (ISS-4576), which exists for
 * this exact skew on `GET /documents`.
 */
export async function fetchOrgTagPage(
  apiClient: ApiClient,
  query: TagPageQuery
): Promise<TagPage> {
  const payload = await apiClient.get<unknown>(
    "/tags",
    buildTagListParams(query)
  );
  const envelope = tagListPageSchema.safeParse(payload);
  if (envelope.success) {
    return {
      tags: shapeTagRows(envelope.data.items),
      total: envelope.data.total,
      hasMore: envelope.data.hasMore,
      serverPaged: true,
    };
  }
  const tags = shapeTagRows(extractArrayItems<unknown>(payload));
  return {
    tags,
    total: tags.length,
    hasMore: false,
    serverPaged: false,
  };
}

/**
 * Resolve one tag by exact name in a single bounded request.
 *
 * Against a current API this is one indexed row fetch and the envelope already
 * holds the answer. Against an OLD API the `name` param is ignored and the full
 * catalogue comes back as a bare array, so the local matcher finishes the job —
 * exactly what this tool did before ISS-7461.
 *
 * The local matcher runs ONLY on that legacy path, and the envelope is what
 * distinguishes the two. It can only NARROW a result the server already
 * filtered: PostgreSQL's `lower()` and JavaScript's `toLowerCase()` do not agree
 * on every input (`"İstanbul"` is the standing example), so post-filtering a
 * server match drops a row the database correctly matched — which turns
 * `tag-artifact` into a duplicate create that 409s twice and then throws, and
 * makes `untag-artifact` report `removed: false` for a tag that is attached.
 */
export async function fetchTagByExactName(
  apiClient: ApiClient,
  tagName: string
): Promise<TagWireRow | undefined> {
  const page = await fetchOrgTagPage(apiClient, { name: tagName });
  if (page.serverPaged) {
    return page.tags[0];
  }
  return findTagByName(page.tags, tagName);
}

/**
 * Match the way the database does: `lower(name)`, with no trimming. The
 * lowercase normaliser in `pull-request-label` trims, which would match names
 * the unique index treats as distinct.
 */
export function findTagByName(
  tags: TagWireRow[],
  tagName: string
): TagWireRow | undefined {
  const target = tagName.toLowerCase();
  return tags.find((tag) => tag.name.toLowerCase() === target);
}

/**
 * The one document subtype these tools refuse.
 *
 * `GET /documents/{id}` serves every `ArtifactType.Document`, so a raw UUID
 * from `list-templates` resolves here exactly as a `PRD-*` slug does — and a
 * template is the one subtype with no user-facing slug, no product surface to
 * show the tag on, and no way for a user to undo it.
 *
 * A deny-list of one rather than an allow-list of four, deliberately. `DOC-*`
 * (evergreen Documents, FEA-3949) is user-facing and legitimately taggable, an
 * allow-list would silently lock out any subtype added after this line was
 * written, and a version-skewed API build that omits `type` would fail every
 * call instead of degrading to the prior behaviour.
 */
const UNTAGGABLE_DOCUMENT_TYPE: DocumentType = DocumentType.Template;

/**
 * Resolve a document slug or UUID to the artifact UUID `POST /entity-tags`
 * requires. The API resolves the slug; the unconditional GET is also what
 * keeps these tools document-only, since the entity-tags API itself would
 * accept a branch or deployment id.
 */
export async function resolveArtifactId(
  apiClient: ApiClient,
  documentId: string
): Promise<string> {
  const document = asRecord(
    await apiClient.get<unknown>(`/documents/${encodePathSegment(documentId)}`)
  );
  const id = readString(document.id);
  if (!id) {
    throw new Error(`Document "${documentId}" resolved without an id.`);
  }
  if (readString(document.type) === UNTAGGABLE_DOCUMENT_TYPE) {
    throw new Error(
      `Document "${documentId}" is a template. Templates are internal blueprints and cannot be tagged — tag the PRD, plan, issue, or document created from one instead.`
    );
  }
  return id;
}

/**
 * Find a tag by name, creating it when absent (ISS-6967: an unknown name
 * auto-creates rather than erroring). `color` is omitted so the service cycles
 * the palette itself.
 */
export async function resolveOrCreateTag(
  apiClient: ApiClient,
  tagName: string
): Promise<ResolvedTag> {
  for (let attempt = 0; attempt < MAX_TAG_CREATE_ATTEMPTS; attempt++) {
    const existing = await fetchTagByExactName(apiClient, tagName);
    if (existing) {
      return { tag: existing, created: false };
    }

    let createdRow: unknown;
    try {
      createdRow = await apiClient.post<unknown>("/tags", { name: tagName });
    } catch (error) {
      if (!isConflict(error)) {
        throw error;
      }
      continue;
    }

    const created = shapeTagRow(createdRow);
    if (!created) {
      throw new Error(
        `Creating tag "${tagName}" returned a row without a usable id and name.`
      );
    }
    return { tag: created, created: true };
  }

  throw new Error(
    `Tag "${tagName}" reported a naming conflict but was absent on re-read after ${MAX_TAG_CREATE_ATTEMPTS} attempts.`
  );
}

function isConflict(error: unknown): boolean {
  return error instanceof McpApiError && error.status === CONFLICT_STATUS;
}

/** The read dimensions `GET /tags` accepts. `name` excludes all the others. */
export type TagPageQuery = {
  limit?: number;
  offset?: number;
  search?: string;
  name?: string;
};

/**
 * `name` is an exact lookup and the API rejects it alongside any paging or
 * filtering dimension, so the two param sets are mutually exclusive.
 */
function buildTagListParams(query: TagPageQuery): Record<string, string> {
  if (query.name !== undefined) {
    // `includeTotal` asks for the envelope, which is the ONLY reliable signal
    // that the server understood `name`. A server too old to know the param
    // ignores both and answers with the whole catalogue as a bare array; a bare
    // 0-or-1 array from a current server would look exactly the same, and
    // guessing wrong means re-filtering a match the database already made.
    return buildQuery({ name: query.name, includeTotal: "true" });
  }
  // Floored rather than forwarded as-is. `offset` and `search` are BOTH
  // rejected by the API without a `limit`, so a caller that omitted one while
  // setting either would earn a 400 instead of a page; `list-tags` resolves
  // this same shared default before it calls, so the floor changes no live
  // behaviour and closes the hole the optional field leaves open.
  const limit = String(query.limit ?? TAG_LIST_DEFAULT_LIMIT);
  return buildQuery({
    limit,
    // Only a bounded read may ask for a total; the API rejects the pair
    // otherwise, and an unbounded total is the workload paging exists to avoid.
    includeTotal: "true",
    offset: query.offset === undefined ? undefined : String(query.offset),
    search: query.search,
  });
}
