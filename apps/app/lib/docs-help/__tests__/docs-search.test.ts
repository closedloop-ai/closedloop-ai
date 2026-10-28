import { DocsHelpMatchField } from "@repo/app/help/lib/docs-help-payload";
import { describe, expect, it } from "vitest";
import { searchDocsCorpus } from "../docs-search";

/**
 * ISS-10006 — web's docs index.
 *
 * The heading-first ordering is the load-bearing part: a heading hit is the ONLY
 * kind that carries a `headingSlug`, and that slug is what turns "open the page"
 * into "land on the section". A ranking that preferred a title match would leave
 * `pendingHeadingSlug` permanently null and the surface's deep-link path dead on
 * this host, with nothing anywhere reporting it.
 */
const LOOPS = {
  body: "A loop runs until the work is correct. Ghost detection catches a stalled one.",
  group: "Mechanisms",
  headings: [{ level: 2, slug: "ghost-detection", text: "Ghost detection" }],
  path: "mechanisms/loops",
  title: "Loops",
};

const JUDGES = {
  body: "Judges score a session. Ghost detection is not their concern.",
  group: "Mechanisms",
  headings: [{ level: 2, slug: "rubrics", text: "Rubrics" }],
  path: "mechanisms/judges",
  title: "Ghost detection overview",
};

const CORPUS = [JUDGES, LOOPS];

describe("searchDocsCorpus", () => {
  it("ranks the heading hit above the title hit, because only it carries an anchor", () => {
    const hits = searchDocsCorpus(CORPUS, "Ghost detection");

    expect(hits[0]?.path).toBe(LOOPS.path);
    expect(hits[0]?.matchField).toBe(DocsHelpMatchField.Heading);
    expect(hits[0]?.headingSlug).toBe("ghost-detection");
    // The paired positive on the loser: it is RETURNED, just second. A ranking
    // test that only asserted the winner would pass on a search that dropped it.
    expect(hits[1]?.path).toBe(JUDGES.path);
    expect(hits[1]?.matchField).toBe(DocsHelpMatchField.Title);
    expect(hits[1]?.headingSlug).toBeUndefined();
  });

  it("windows a body excerpt at the match, not at the start of the page", () => {
    const [hit] = searchDocsCorpus([LOOPS], "correct");

    expect(hit?.matchField).toBe(DocsHelpMatchField.Body);
    expect(hit?.excerpt.startsWith("correct")).toBe(true);
  });

  it("leaves out a page that matches nothing", () => {
    expect(searchDocsCorpus(CORPUS, "rubrics").map((hit) => hit.path)).toEqual([
      JUDGES.path,
    ]);
  });

  it("returns nothing for a blank query rather than the whole corpus", () => {
    expect(searchDocsCorpus(CORPUS, "   ")).toHaveLength(0);
  });

  it("ANDs the query terms, so word order does not decide whether a page matches", () => {
    const forward = searchDocsCorpus([LOOPS], "ghost detection");
    const reversed = searchDocsCorpus([LOOPS], "detection ghost");

    expect(forward.map((hit) => hit.path)).toEqual([LOOPS.path]);
    // The whole point of tokenizing: a raw substring match answers the second
    // query with nothing while answering the first with the page.
    expect(reversed.map((hit) => hit.path)).toEqual([LOOPS.path]);
  });

  it("drops a page that carries only some of the terms", () => {
    // "rubrics" is JUDGES-only and "loop" is LOOPS-only, so neither page holds
    // both and AND semantics leave the set empty. Paired with the positive
    // above, this is what separates AND from OR.
    expect(searchDocsCorpus(CORPUS, "rubrics loop")).toHaveLength(0);
  });

  it("keeps a page whose only match is its nav group", () => {
    const [hit] = searchDocsCorpus([LOOPS], "mechanisms");

    expect(hit?.path).toBe(LOOPS.path);
    expect(hit?.matchField).toBe(DocsHelpMatchField.Group);
  });

  it("clamps the result set instead of painting the whole corpus into the pane", () => {
    const corpus = Array.from({ length: 40 }, (_, index) => ({
      ...LOOPS,
      path: `mechanisms/loops-${index}`,
      title: `Loops ${index}`,
    }));

    // Every page matches; the default cap is desktop's `DEFAULT_LIMIT`.
    expect(searchDocsCorpus(corpus, "loop")).toHaveLength(20);
    expect(searchDocsCorpus(corpus, "loop", 5)).toHaveLength(5);
    // Floors at 1 and ceilings at desktop's MAX_LIMIT rather than trusting the
    // caller at either end.
    expect(searchDocsCorpus(corpus, "loop", 0)).toHaveLength(1);
    expect(searchDocsCorpus(corpus, "loop", 999)).toHaveLength(40);
  });
});
