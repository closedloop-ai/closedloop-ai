/**
 * ISS-11282: pins the relevance sort in
 * `src/server/operations/filesystem-search.ts` independent of the order the
 * filesystem walk returns matches. `glob` is mocked to return a scripted
 * order, because an exact-vs-prefix rule only runs when that pair meets in
 * that argument order, and real directory order is filesystem-specific.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationDispatcher } from "../src/server/operation-dispatcher.js";
import { registerFilesystemSearchRoutes } from "../src/server/operations/filesystem-search.js";
import {
  createGitOpTempDirs,
  dispatchOperation,
} from "./helpers/git-gateway-op-harness.js";

const globResult = vi.hoisted(() => ({ matches: [] as string[] }));

vi.mock("glob", () => ({
  glob: () => Promise.resolve([...globResult.matches]),
}));

const { makeTempDir } = createGitOpTempDirs("iss11282-fs-order-");

afterEach(() => {
  globResult.matches = [];
});

async function searchWithWalkOrder(
  matches: string[]
): Promise<{ status: number; files: unknown }> {
  globResult.matches = matches;
  const repo = makeTempDir();
  const dispatcher = new OperationDispatcher();
  registerFilesystemSearchRoutes(dispatcher, () => [repo]);
  const res = await dispatchOperation({
    dispatcher,
    method: "GET",
    pathname: "/api/gateway/files/search",
    query: { repo, base: "true", query: "widget" },
  });
  return { status: res.statusCode, files: res.body.files };
}

// A long exact match against a shorter prefix match: without the exact rule
// the shorter prefix match would win on length.
const LONG_EXACT = "deep/folder/widget.ts";
const SHORT_PREFIX = "widgeta";
// Two exact matches: ordered by length.
const SHORT_EXACT = "a/widget";
const LONGER_EXACT = "bbbb/widget.tsx";

describe("relevance order does not depend on walk order", () => {
  it.each([
    { label: "exact first", walk: [LONG_EXACT, SHORT_PREFIX] },
    { label: "prefix first", walk: [SHORT_PREFIX, LONG_EXACT] },
  ])(
    "puts a long exact match before a shorter prefix match ($label)",
    async ({ walk }) => {
      expect(await searchWithWalkOrder(walk)).toEqual({
        status: 200,
        files: [LONG_EXACT, SHORT_PREFIX],
      });
    }
  );

  it.each([
    { label: "shorter first", walk: [SHORT_EXACT, LONGER_EXACT] },
    { label: "longer first", walk: [LONGER_EXACT, SHORT_EXACT] },
  ])("orders two exact matches by length ($label)", async ({ walk }) => {
    expect(await searchWithWalkOrder(walk)).toEqual({
      status: 200,
      files: [SHORT_EXACT, LONGER_EXACT],
    });
  });
});
