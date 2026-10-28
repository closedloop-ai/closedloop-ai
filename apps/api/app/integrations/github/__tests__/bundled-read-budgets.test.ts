import { GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE } from "@repo/api/src/github-read-model";
import { describe, expect, it } from "vitest";
import {
  PULL_REQUEST_BACKFILL_MAX_ITEMS,
  PULL_REQUEST_BACKFILL_MAX_PAGES,
} from "../backfill-service";
import {
  TARGET_PULL_REQUEST_MAX_ITEMS,
  TARGET_PULL_REQUEST_MAX_PAGES,
} from "../service/pull-request-list-read";

/**
 * ISS-7891 (cr-79967, #5898 review): every bundled-read caller that forwards a
 * page and item budget but no `pageSize` inherits the shared default, so its
 * two numbers are only true while pages × that default still reach the items.
 *
 * When the default fell from 100 to 25, each of these silently lost three
 * quarters of its reach while still claiming the original item budget — the
 * backfill's self-heal search and the tracked-PR target search both degrade to
 * a recorded miss rather than an error, so nothing failed loudly.
 */
describe("bundled-read budgets reach the items they claim", () => {
  it.each([
    {
      lane: "backfill self-heal",
      pages: PULL_REQUEST_BACKFILL_MAX_PAGES,
      items: PULL_REQUEST_BACKFILL_MAX_ITEMS,
    },
    {
      lane: "tracked-PR target search",
      pages: TARGET_PULL_REQUEST_MAX_PAGES,
      items: TARGET_PULL_REQUEST_MAX_ITEMS,
    },
  ])("$lane", ({ pages, items }) => {
    expect(
      pages * GITHUB_BUNDLED_PULL_REQUESTS_DEFAULT_PAGE_SIZE
    ).toBeGreaterThanOrEqual(items);
  });
});
