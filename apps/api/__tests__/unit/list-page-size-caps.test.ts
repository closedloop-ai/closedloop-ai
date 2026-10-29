import {
  SESSION_LIST_MAX_LIMIT,
  SESSION_LIST_MAX_OFFSET,
} from "@repo/api/src/types/agent-session-list-limits";
import {
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import { branchServerPageQuerySchema } from "@repo/api/src/types/branch-list-contract-schema";
import { TABLE_PAGE_SIZE_MAX } from "@repo/api/src/types/table-page-size-limits";
import { clamp } from "@repo/api/src/utils/math";
import { describe, expect, it } from "vitest";
import { agentSessionListQuerySchema } from "@/app/agent-sessions/validators";
import {
  BRANCH_LIST_MAX_LIMIT,
  branchListQuerySchema,
} from "@/app/branches/branch-list-query";
import {
  resolveDocumentListSkip,
  resolveDocumentListTake,
} from "@/app/documents/document-list-query";
import { findDocumentsQueryValidator } from "@/app/documents/validators";

/**
 * ISS-9692 — every list endpoint that backs the shared rows-per-page ladder
 * accepts the ladder's LARGEST rung.
 *
 * This is the assertion the ticket exists for. `TABLE_PAGE_SIZE_OPTIONS` and
 * these caps used to be independent numbers: Sessions rejected anything over 100
 * at its query schema, BEFORE its service's own clamp ran, so adding a rung to
 * the shared ladder would have offered Sessions readers a size the API answered
 * with a 400. Nothing in the tree failed on that.
 *
 * Each case DRIVES the real validator rather than comparing constants, so it
 * fails if a cap is lowered, if a schema stops deriving from the shared value,
 * or if a new bound is introduced under one of these reads. The other half of
 * the chain — that `TABLE_PAGE_SIZE_MAX` really is the largest rung the UI
 * offers — is
 * `packages/app/shared/hooks/__tests__/table-page-size-ladder-agreement.test.ts`,
 * which lives there because `@repo/design-system` (where the ladder is) is
 * gated from importing `@repo/api` and this app's tests run without a DOM.
 */
/** Any resolved take, so the offset clamp has a bounded read to sit under. */
const PAGE_SIZE_FOR_CLAMP = 25;

const BRANCH_SERVER_PAGE_QUERY_BASE = {
  pageMode: BranchListPageMode.Server,
  offset: 0,
  sortDir: BranchListSortDirection.Desc,
  sortKey: BranchListSortKey.LastActivity,
} as const;

describe("list endpoints accept the largest offered page size", () => {
  it("accepts the largest offered page size on GET /agent-sessions", () => {
    const result = agentSessionListQuerySchema.safeParse({
      limit: String(TABLE_PAGE_SIZE_MAX),
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(TABLE_PAGE_SIZE_MAX);
  });

  it("rejects one row past the largest offered page size on GET /agent-sessions", () => {
    const result = agentSessionListQuerySchema.safeParse({
      limit: String(TABLE_PAGE_SIZE_MAX + 1),
    });

    expect(result.success).toBe(false);
    expect(
      result.success ? [] : result.error.issues.map((i) => i.path)
    ).toEqual([["limit"]]);
  });

  it("keeps the Sessions service clamp level with the schema it sits behind", () => {
    // Both halves of the Sessions bound moved together — the schema above and
    // the service's `Math.min(limit, SESSION_LIST_MAX_LIMIT)`. Asserted through
    // the schema, not by reading the service's old private constant: a clamp
    // BELOW the accepted limit would silently serve a shorter page than the
    // request and the range readout asked for.
    const result = agentSessionListQuerySchema.safeParse({
      limit: String(SESSION_LIST_MAX_LIMIT),
      offset: String(SESSION_LIST_MAX_OFFSET),
    });

    expect(result.success && result.data.limit).toBe(SESSION_LIST_MAX_LIMIT);
  });

  it("accepts the largest offered page size on the Branches server page read", () => {
    const result = branchServerPageQuerySchema.safeParse({
      ...BRANCH_SERVER_PAGE_QUERY_BASE,
      limit: TABLE_PAGE_SIZE_MAX,
    });

    expect(result.success).toBe(true);
  });

  it("keeps the Branches aligned-offset rule satisfiable at the largest offered page size", () => {
    // The server-page refinement requires `offset % limit === 0`, so a cap that
    // admitted the limit but not its second page would still strand the reader.
    const result = branchServerPageQuerySchema.safeParse({
      ...BRANCH_SERVER_PAGE_QUERY_BASE,
      limit: TABLE_PAGE_SIZE_MAX,
      offset: TABLE_PAGE_SIZE_MAX,
    });

    expect(result.success).toBe(true);
  });

  /**
   * ISS-9692 (codex review) — the case whose absence let the Branches P1 ship.
   *
   * The two above drive `branchServerPageQuerySchema`, the CONTRACT shape in
   * `@repo/api`. The bytes on the wire are validated by a different schema:
   * `branchListQuerySchema`, the strict REST boundary in `apps/api`, which
   * carried its own `BRANCH_LIST_MAX_LIMIT = 100`. So `?limit=250` satisfied the
   * contract, was rejected with a 400 here, and every case in this file stayed
   * green. Drive the schema the ROUTE parses with, not the one that describes
   * it.
   */
  it("accepts the largest offered page size on GET /branches", () => {
    const result = branchListQuerySchema.safeParse({
      limit: String(TABLE_PAGE_SIZE_MAX),
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(TABLE_PAGE_SIZE_MAX);
  });

  it("accepts the largest offered page size on a server-mode GET /branches read", () => {
    // `pageMode=server` adds the supported-limit + aligned-offset refinement, so
    // a route cap raised without the contract's own set admitting the rung would
    // fail here rather than at the plain bound above.
    const result = branchListQuerySchema.safeParse({
      limit: String(TABLE_PAGE_SIZE_MAX),
      offset: String(TABLE_PAGE_SIZE_MAX),
      pageMode: BranchListPageMode.Server,
    });

    expect(result.success).toBe(true);
  });

  it("keeps the Branches service clamp level with the route it sits behind", () => {
    // `branchReadService.listBranches` narrows with this exact expression. A
    // clamp BELOW the accepted limit serves a short page against a total and a
    // readout computed from the requested one — the silent-truncation half of
    // the same defect, which no 400 would ever surface.
    expect(clamp(TABLE_PAGE_SIZE_MAX, 1, BRANCH_LIST_MAX_LIMIT)).toBe(
      TABLE_PAGE_SIZE_MAX
    );
  });

  it("serves the largest offered page size unclamped on the document list read", () => {
    // The project-artifacts tab pages client-side over this read, so its bound
    // is what decides whether a 500-row page can be filled at all.
    expect(resolveDocumentListTake(TABLE_PAGE_SIZE_MAX)).toBe(
      TABLE_PAGE_SIZE_MAX
    );
  });

  /**
   * ISS-9724 — the two halves of the Documents bound, at the rung and one past.
   *
   * The case above drives only the SERVICE clamp, which is the half a 400 never
   * reaches: `findDocumentsQueryValidator` rejects an over-cap `limit` before
   * `resolveDocumentListTake` runs, so a route cap that stopped deriving from
   * the ladder would have left every case in this file green while the endpoint
   * answered the grid's largest rung with a 400 — the ISS-9692 defect, on the
   * one surface ISS-9692 did not derive.
   */
  it("accepts the largest offered page size on GET /documents", () => {
    const result = findDocumentsQueryValidator.safeParse({
      limit: String(TABLE_PAGE_SIZE_MAX),
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.limit).toBe(TABLE_PAGE_SIZE_MAX);
  });

  it("rejects one row past the largest offered page size on GET /documents", () => {
    const result = findDocumentsQueryValidator.safeParse({
      limit: String(TABLE_PAGE_SIZE_MAX + 1),
    });

    expect(result.success).toBe(false);
    expect(
      result.success ? [] : result.error.issues.map((issue) => issue.path)
    ).toEqual([["limit"]]);
  });

  it("floors the document page size at one row rather than serving an empty page", () => {
    // `Math.min` alone would pass a zero or negative `limit` straight through to
    // Prisma as `take: 0`, which returns nothing at all — an empty page that
    // reads exactly like a genuinely empty population.
    expect(resolveDocumentListTake(0)).toBe(1);
    expect(resolveDocumentListTake(-25)).toBe(1);
  });

  it("floors the document offset at zero rather than paging backwards", () => {
    expect(resolveDocumentListSkip(PAGE_SIZE_FOR_CLAMP, -1)).toBe(0);
  });
});
