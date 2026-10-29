import {
  AgentSessionListCapability,
  type AgentSessionListPageInfo,
} from "@repo/api/src/types/agent-session-list-contract";
import { describe, expect, it } from "vitest";
import { resolveSessionsServedPage } from "../sessions-served-page";

const READER_PAGE_SIZE = 10;

function echo(
  overrides: Partial<AgentSessionListPageInfo> = {}
): AgentSessionListPageInfo {
  return {
    capability: AgentSessionListCapability.ServerPaginationV1,
    limit: READER_PAGE_SIZE,
    offset: 20,
    ...overrides,
  };
}

function servedPage(
  pageInfo: AgentSessionListPageInfo | null | undefined,
  overrides: {
    expectedLimit?: number;
    isPlaceholderPage?: boolean;
    isServerDriven?: boolean;
  } = {}
): number | null {
  return resolveSessionsServedPage({
    expectedLimit: overrides.expectedLimit ?? READER_PAGE_SIZE,
    isPlaceholderPage: overrides.isPlaceholderPage ?? false,
    isServerDriven: overrides.isServerDriven ?? true,
    pageInfo,
  });
}

describe("resolveSessionsServedPage", () => {
  it("reads the served page off the echo", () => {
    expect(servedPage(echo())).toBe(2);
  });

  it("defers to the caller's own derivation when there is no echo", () => {
    expect(servedPage(undefined)).toBeNull();
  });

  it("refuses the echo of the read a placeholder page is still holding", () => {
    // Those rows AND that echo describe the page the reader turned away from.
    expect(servedPage(echo(), { isPlaceholderPage: true })).toBeNull();
  });

  it("refuses an echo on a client-driven read, which has no producer", () => {
    expect(servedPage(echo(), { isServerDriven: false })).toBeNull();
  });

  it("refuses an echo whose capability this build does not understand", () => {
    // The echo is raw JSON off the wire, so a newer producer can name a
    // capability under which `offset` means something else — a cursor, when that
    // arrives. Dividing it by `limit` would name a page it never measured.
    expect(
      servedPage({
        ...echo(),
        capability: "cursor_v1" as AgentSessionListPageInfo["capability"],
      })
    ).toBeNull();
  });

  it("falls back rather than throwing on a null echo", () => {
    // A producer that serializes the absent field instead of omitting it must
    // not be able to error the list render.
    expect(servedPage(null)).toBeNull();
  });

  it("refuses an offset that names a row rather than a page", () => {
    // A producer that sends it is describing a position we cannot render, and
    // `offset / limit` would be a page index with a decimal in it.
    expect(servedPage(echo({ offset: 23 }))).toBeNull();
  });

  it("refuses an echo paged in a size the reader is not paging in", () => {
    // The desktop local read clamps a limit to its own ceiling rather than
    // rejecting it, so an echo can name a size the reader never asked for.
    // `offset / limit` is then a page index in the PRODUCER's units: rendered in
    // the reader's it names a completely different position.
    expect(
      servedPage(echo({ limit: 100, offset: 500 }), { expectedLimit: 250 })
    ).toBeNull();
  });

  it.each<[string, Partial<AgentSessionListPageInfo>]>([
    ["a zero limit", { limit: 0, offset: 0 }],
    ["a negative offset", { offset: -10 }],
    ["a non-finite limit", { limit: Number.NaN }],
    ["a fractional limit", { limit: 10.5, offset: 21 }],
  ])("refuses %s", (_label, overrides) => {
    expect(
      servedPage(echo(overrides), {
        expectedLimit: overrides.limit ?? READER_PAGE_SIZE,
      })
    ).toBeNull();
  });
});
