/**
 * ISS-10005 AC2 — the guard refuses exactly what would throw during render, and
 * refuses nothing else.
 *
 * Fixtures are written as literals rather than derived from the payload types:
 * a fixture built from the thing it polices cannot fail when that thing changes.
 * The malformed shapes below are the ones a real older/newer bundle produces —
 * a group that predates `pages`, a page that predates `body` — not type-impossible
 * in-process values.
 */
import { describe, expect, it } from "vitest";
import type { DocsHelpNavGroup, DocsHelpPage } from "../docs-help-payload";
import {
  firstNavigablePath,
  isSearchHitsUnreadable,
  readNavGroups,
  readReaderPage,
  readSearchHits,
} from "../docs-help-payload-guard";

const GETTING_STARTED = {
  group: "Getting Started",
  pages: [
    {
      path: "getting-started/overview",
      title: "Overview",
      group: "Getting Started",
    },
    {
      path: "getting-started/api-keys",
      title: "API keys",
      group: "Getting Started",
    },
  ],
};

const CONCEPTS = {
  group: "Concepts",
  pages: [{ path: "concepts/loops", title: "Loops", group: "Concepts" }],
};

/** What the renderer indexes into: `group.pages.map(...)`. */
const GROUP_WITHOUT_PAGES = { group: "Reference" };

const OVERVIEW_PAGE = {
  path: "getting-started/overview",
  title: "Overview",
  description: "Start here.",
  headings: [{ level: 2, text: "Lifecycle", slug: "lifecycle" }],
  body: "## Lifecycle\n\nPlain text body.",
  renderBody: "## Lifecycle\n\nMarkdown body.",
};

function asNavGroups(value: unknown): readonly DocsHelpNavGroup[] {
  return value as readonly DocsHelpNavGroup[];
}

function asPage(value: unknown): DocsHelpPage {
  return value as DocsHelpPage;
}

describe("readSearchHits", () => {
  const HIT = {
    path: "concepts/loops",
    title: "Loops",
    group: "Concepts",
    matchField: "heading",
    score: 20,
    excerpt: "A loop lifecycle…",
    headingSlug: "lifecycle",
  };
  const asHits = (value: unknown) =>
    value as unknown as readonly Parameters<typeof readSearchHits>[0][number][];

  it("returns well-formed hits untouched", () => {
    expect(readSearchHits(asHits([HIT]))).toStrictEqual([HIT]);
  });

  /**
   * davetho review: a reply that lost its `hits` array threw on
   * `hits.length` before the pane reached a single row — the Help route, not
   * just the search pane.
   */
  it.each([
    ["a reply with no hits array", undefined],
    ["a non-array hits field", "nope"],
    ["a null hits field", null],
  ])("answers with nothing for %s", (_name, hits) => {
    expect(readSearchHits(asHits(hits))).toStrictEqual([]);
  });

  /** One corrupt row costs the reader that row, never the results beside it. */
  it.each([
    ["a title React would throw on", { title: { text: "Loops" } }],
    ["an excerpt React would throw on", { excerpt: { text: "…" } }],
    ["a missing path", { path: undefined }],
    ["a matchField absent from the label map", { matchField: "invented" }],
    ["a non-string matchField", { matchField: 3 }],
  ])("drops a hit with %s and keeps the rest", (_name, overrides) => {
    expect(
      readSearchHits(asHits([{ ...HIT, ...overrides }, HIT]))
    ).toStrictEqual([HIT]);
  });

  /**
   * ISS-10044 (whitlockk review) — the two ways of being empty, told apart.
   *
   * Both answer `[]`, and the surface renders them as opposite sentences, so
   * the caller needs this to know which one it is holding.
   */
  it.each([
    ["a reply with no hits array", undefined],
    ["a non-array hits field", "nope"],
    ["a null hits field", null],
  ])("reports %s as unreadable", (_name, hits) => {
    expect(isSearchHitsUnreadable(asHits(hits))).toBe(true);
  });

  it("does not call a search that genuinely matched nothing unreadable", () => {
    expect(isSearchHitsUnreadable(asHits([]))).toBe(false);
  });
});

describe("readNavGroups", () => {
  it("returns a well-formed tree untouched and refuses nothing", () => {
    expect(
      readNavGroups(asNavGroups([GETTING_STARTED, CONCEPTS]))
    ).toStrictEqual({
      groups: [GETTING_STARTED, CONCEPTS],
      refusedGroups: 0,
      treeUnreadable: false,
    });
  });

  it("drops only the group that lost its pages array, and counts it", () => {
    // The surviving groups are asserted POSITIVELY: a guard that returned
    // nothing at all would satisfy "the bad group is gone".
    expect(
      readNavGroups(
        asNavGroups([GETTING_STARTED, GROUP_WITHOUT_PAGES, CONCEPTS])
      )
    ).toStrictEqual({
      groups: [GETTING_STARTED, CONCEPTS],
      refusedGroups: 1,
      treeUnreadable: false,
    });
  });

  it("drops a whole group when one of its page rows is unrenderable", () => {
    // React throws on a non-primitive child, so a row whose title is an object
    // takes the tree down exactly as a missing `pages` array does.
    const objectTitle = {
      group: "Reference",
      pages: [{ path: "reference/cli", title: { text: "CLI" } }],
    };

    expect(readNavGroups(asNavGroups([objectTitle, CONCEPTS]))).toStrictEqual({
      groups: [CONCEPTS],
      refusedGroups: 1,
      treeUnreadable: false,
    });
  });

  it("keeps a page row that merely omits its optional group", () => {
    const ungrouped = {
      group: "Reference",
      pages: [{ path: "reference/cli", title: "CLI" }],
    };

    expect(readNavGroups(asNavGroups([ungrouped]))).toStrictEqual({
      groups: [ungrouped],
      refusedGroups: 0,
      treeUnreadable: false,
    });
  });

  /**
   * marisolashgrove review: this used to answer `refusedGroups: 1`, which the pane
   * printed as "1 section of the docs index couldn't be read" — the most
   * reassuring sentence available for the case where NOTHING could be read. The
   * whole-tree failure is its own fact now, and the count is honestly zero
   * because no group survived long enough to be refused.
   */
  it("reports a non-array tree as UNREADABLE, not as one refused section", () => {
    expect(readNavGroups(asNavGroups(null))).toStrictEqual({
      groups: [],
      refusedGroups: 0,
      treeUnreadable: true,
    });
  });

  it("reports a genuinely empty tree as refusing nothing", () => {
    // The pair that makes `refusedGroups` mean something: same empty `groups`,
    // different claim about why.
    expect(readNavGroups([])).toStrictEqual({
      groups: [],
      refusedGroups: 0,
      treeUnreadable: false,
    });
  });
});

describe("firstNavigablePath", () => {
  it("picks the first page of the first readable group", () => {
    expect(firstNavigablePath(asNavGroups([GETTING_STARTED, CONCEPTS]))).toBe(
      "getting-started/overview"
    );
  });

  it("skips an unreadable FIRST group instead of throwing on it", () => {
    // The host indexed `groups[0]?.pages[0]` and threw here, then caught it and
    // reported the whole bundle unavailable — losing both intact groups.
    expect(
      firstNavigablePath(asNavGroups([GROUP_WITHOUT_PAGES, CONCEPTS]))
    ).toBe("concepts/loops");
  });

  it("skips a readable group that simply has no pages", () => {
    const emptyGroup = { group: "Reference", pages: [] };

    expect(firstNavigablePath(asNavGroups([emptyGroup, CONCEPTS]))).toBe(
      "concepts/loops"
    );
  });

  it("reports no navigable page rather than a made-up one", () => {
    expect(firstNavigablePath(asNavGroups([GROUP_WITHOUT_PAGES]))).toBeNull();
  });
});

describe("readReaderPage", () => {
  it("returns a well-formed page untouched", () => {
    expect(readReaderPage(asPage(OVERVIEW_PAGE))).toStrictEqual(OVERVIEW_PAGE);
  });

  it("keeps a page that ships only the flattened body", () => {
    // An older generator shipped no `renderBody`; the reader falls back to
    // `body`, so this must NOT be read as malformed.
    const olderBundlePage = {
      path: "concepts/loops",
      title: "Loops",
      headings: [],
      body: "Plain text only.",
    };

    expect(readReaderPage(asPage(olderBundlePage))).toStrictEqual(
      olderBundlePage
    );
  });

  it("refuses a page whose body is missing rather than drawing it blank", () => {
    // react-markdown ACCEPTS a nullish body and renders an empty document, so
    // this one never throws — it just tells the reader the page has nothing in
    // it. That is the failure worth refusing.
    const { body: _body, ...withoutBody } = OVERVIEW_PAGE;

    expect(readReaderPage(asPage(withoutBody))).toBeNull();
  });

  it("refuses a page whose renderBody is present but not markdown text", () => {
    // `renderBody` WINS over `body`, and react-markdown throws on a non-nullish
    // non-string: "Unexpected value `[object Object]` for `children` prop".
    expect(
      readReaderPage(asPage({ ...OVERVIEW_PAGE, renderBody: { mdx: "…" } }))
    ).toBeNull();
  });

  it("refuses a page whose title React would throw on", () => {
    // Rendered as `<h1>{page.title}</h1>`, so a non-primitive unwinds the shell
    // exactly as a bad `renderBody` does.
    expect(
      readReaderPage(asPage({ ...OVERVIEW_PAGE, title: { text: "Loops" } }))
    ).toBeNull();
  });

  it("refuses a page whose description is present but not text", () => {
    expect(
      readReaderPage(asPage({ ...OVERVIEW_PAGE, description: 42 }))
    ).toBeNull();
  });

  it("keeps a page that simply omits its optional description", () => {
    // The positive sibling: an ABSENT description is a claim, not a defect.
    const { description: _description, ...withoutDescription } = OVERVIEW_PAGE;

    expect(readReaderPage(asPage(withoutDescription))).toStrictEqual(
      withoutDescription
    );
  });

  it("refuses a page whose path cannot be put in the View online href", () => {
    expect(
      readReaderPage(asPage({ ...OVERVIEW_PAGE, path: undefined }))
    ).toBeNull();
  });
});
