import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-10006 — the three docs-help handlers, driven directly.
 *
 * Everything downstream leans on the SERVER keeping its outcomes apart: 404 is
 * "the corpus holds no such page" and 503 is "the read did not come back", and
 * the surface sends a reader online for the first and back again for the second.
 * The client suites stub `fetch` and the E2E stubs the route, so without this
 * file every assertion in the change is on the client's interpretation of a
 * status nothing ever produced.
 */
const { authMock } = vi.hoisted(() => ({ authMock: vi.fn() }));
const { docsCorpusMock } = vi.hoisted(() => ({ docsCorpusMock: vi.fn() }));

vi.mock("@repo/auth/server", () => ({ auth: () => authMock() }));
// Only the READ is stubbed. `docsCorpusFailureReason` lives beside it in
// `docs-corpus.ts` and is left real, because reporting which failure happened
// is the contract these cases are about.
vi.mock("@/lib/docs-help/docs-corpus-cache", () => ({
  docsCorpus: () => docsCorpusMock(),
}));

import { DocsCorpusFailureReason } from "@repo/app/help/lib/web-help-contract";
import { DocsCorpusMissingError } from "@/lib/docs-help/docs-corpus";
import { GET as getPage } from "../page/route";
import { GET as getNav } from "../route";
import { GET as getSearch } from "../search/route";

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

const LOOPS = {
  body: "Loops run until the work is correct.",
  group: "Mechanisms",
  headings: [{ level: 2, slug: "lifecycle", text: "Lifecycle" }],
  path: "mechanisms/loops",
  renderBody: "Loops run until the work is correct.\n\n## Lifecycle",
  title: "Loops",
};
const JUDGES = {
  body: "Judges score a session against a rubric.",
  group: "Mechanisms",
  headings: [],
  path: "mechanisms/judges",
  renderBody: "Judges score a session against a rubric.",
  title: "Judges",
};

const CORPUS = {
  navGroups: [
    {
      group: "Mechanisms",
      pages: [
        { group: "Mechanisms", path: LOOPS.path, title: LOOPS.title },
        { group: "Mechanisms", path: JUDGES.path, title: JUDGES.title },
      ],
    },
  ],
  pages: [LOOPS, JUDGES],
};

function request(url: string): Request {
  return new Request(`https://app.test${url}`);
}

beforeEach(() => {
  authMock.mockReset();
  docsCorpusMock.mockReset();
  authMock.mockResolvedValue({ userId: "user_1" });
  docsCorpusMock.mockReturnValue(CORPUS);
});

describe("every docs-help read requires a signed-in reader", () => {
  it("refuses all three with no user", async () => {
    authMock.mockResolvedValue({ userId: null });

    expect((await getNav()).status).toBe(HTTP_UNAUTHORIZED);
    expect(
      (await getPage(request("/api/docs-help/page?path=mechanisms/loops")))
        .status
    ).toBe(HTTP_UNAUTHORIZED);
    expect(
      (await getSearch(request("/api/docs-help/search?q=loops"))).status
    ).toBe(HTTP_UNAUTHORIZED);
  });
});

describe("GET /api/docs-help", () => {
  it("answers with the nav tree", async () => {
    const response = await getNav();

    expect(response.status).toBe(HTTP_OK);
    await expect(response.json()).resolves.toStrictEqual({
      navGroups: CORPUS.navGroups,
    });
  });

  it("is a 503 when the corpus cannot be read, never an empty tree", async () => {
    docsCorpusMock.mockImplementation(() => {
      throw new Error("docs corpus not found");
    });

    const response = await getNav();

    expect(response.status).toBe(HTTP_UNAVAILABLE);
    // The whole point: a 200 with no groups would tell the reader the docs set
    // has no pages, which is a claim about the corpus a failed read cannot make.
    expect(response.status).not.toBe(HTTP_OK);
  });
});

describe("GET /api/docs-help/page", () => {
  it("answers with the page that `path` named, not merely a page", async () => {
    const response = await getPage(
      request(`/api/docs-help/page?path=${JUDGES.path}`)
    );

    expect(response.status).toBe(HTTP_OK);
    await expect(response.json()).resolves.toStrictEqual({ page: JUDGES });
  });

  it("is a 400 with no path at all", async () => {
    expect((await getPage(request("/api/docs-help/page"))).status).toBe(
      HTTP_BAD_REQUEST
    );
  });

  it("keeps 'no such page' and 'the read failed' apart", async () => {
    const missing = await getPage(
      request("/api/docs-help/page?path=mechanisms/nothing")
    );
    expect(missing.status).toBe(HTTP_NOT_FOUND);

    docsCorpusMock.mockImplementation(() => {
      throw new Error("docs corpus not found");
    });
    const failed = await getPage(
      request(`/api/docs-help/page?path=${LOOPS.path}`)
    );
    expect(failed.status).toBe(HTTP_UNAVAILABLE);
  });
});

describe("GET /api/docs-help/search", () => {
  it("searches the bodies the nav read does not ship", async () => {
    const response = await getSearch(request("/api/docs-help/search?q=rubric"));

    expect(response.status).toBe(HTTP_OK);
    const body = (await response.json()) as { hits: { path: string }[] };
    expect(body.hits.map((hit) => hit.path)).toStrictEqual([JUDGES.path]);
  });

  it("is a 503 when the corpus cannot be read, never zero hits", async () => {
    docsCorpusMock.mockImplementation(() => {
      throw new Error("docs corpus not found");
    });

    const response = await getSearch(request("/api/docs-help/search?q=loops"));

    expect(response.status).toBe(HTTP_UNAVAILABLE);
  });
});

describe("the 503 says WHICH failure it was", () => {
  // marisolashgrove review: a corpus this deployment never shipped is permanent,
  // and a parse or fs failure is not. Collapsing them hands the reader one
  // "couldn't load just now" sentence on every reload of a read that cannot
  // succeed.
  it("reports a missing corpus as not-deployed", async () => {
    docsCorpusMock.mockImplementation(() => {
      throw new DocsCorpusMissingError(["/nowhere/apps/web/content/docs"]);
    });

    const response = await getNav();

    expect(response.status).toBe(HTTP_UNAVAILABLE);
    expect(await response.json()).toStrictEqual({
      reason: DocsCorpusFailureReason.NotDeployed,
    });
  });

  it("reports every other failure as read-failed", async () => {
    docsCorpusMock.mockImplementation(() => {
      throw new Error("unterminated frontmatter");
    });

    const response = await getNav();

    expect(response.status).toBe(HTTP_UNAVAILABLE);
    expect(await response.json()).toStrictEqual({
      reason: DocsCorpusFailureReason.ReadFailed,
    });
  });
});
