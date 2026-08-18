import { describe, expect, it } from "vitest";
import { bodyLeadsWithTitleHeading } from "../leading-title-heading";

const TITLE = "Enhance Session Quality Signals with GitHub PR Metrics";

describe("bodyLeadsWithTitleHeading (ISS-5006)", () => {
  it("detects the templated H1 that repeats the record title", () => {
    expect(
      bodyLeadsWithTitleHeading(`# ${TITLE}\n\nSome body copy.`, TITLE)
    ).toBe(true);
  });

  it("ignores leading blank lines before the heading", () => {
    expect(bodyLeadsWithTitleHeading(`\n\n\n# ${TITLE}\n`, TITLE)).toBe(true);
  });

  it("matches through whitespace and casing differences", () => {
    expect(
      bodyLeadsWithTitleHeading(
        "#   enhance   THE  thing  ",
        "Enhance the thing"
      )
    ).toBe(true);
  });

  it("detects the setext form", () => {
    expect(bodyLeadsWithTitleHeading(`${TITLE}\n====\n\nBody.`, TITLE)).toBe(
      true
    );
  });

  it("tolerates closing hashes", () => {
    expect(bodyLeadsWithTitleHeading(`# ${TITLE} #\n`, TITLE)).toBe(true);
  });

  // The negative case ISS-5006 could not test in production: a body that does
  // NOT lead with the title must keep its first heading.
  it("leaves a body whose first heading is different alone", () => {
    expect(bodyLeadsWithTitleHeading("# Background\n\nBody.", TITLE)).toBe(
      false
    );
  });

  it("leaves a body that does not start with a heading alone", () => {
    expect(
      bodyLeadsWithTitleHeading(`Intro paragraph.\n\n# ${TITLE}\n`, TITLE)
    ).toBe(false);
  });

  it("does not treat a deeper heading as the title repeat", () => {
    expect(bodyLeadsWithTitleHeading(`## ${TITLE}\n`, TITLE)).toBe(false);
  });

  it("does not match a heading that merely starts with the title", () => {
    expect(bodyLeadsWithTitleHeading(`# ${TITLE} and then some\n`, TITLE)).toBe(
      false
    );
  });

  it("is false for empty or missing content and for an empty title", () => {
    expect(bodyLeadsWithTitleHeading("", TITLE)).toBe(false);
    expect(bodyLeadsWithTitleHeading(null, TITLE)).toBe(false);
    expect(bodyLeadsWithTitleHeading(undefined, TITLE)).toBe(false);
    expect(bodyLeadsWithTitleHeading("#  \n", "")).toBe(false);
    expect(bodyLeadsWithTitleHeading("   \n\n  ", TITLE)).toBe(false);
  });

  it("does not match a bare hash with no heading text", () => {
    expect(bodyLeadsWithTitleHeading("#\n", TITLE)).toBe(false);
  });
});
