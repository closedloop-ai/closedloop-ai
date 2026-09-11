/**
 * Every Surface and Composite explains itself, in plain English.
 *
 * The comment above `const meta` becomes the paragraph at the top of a
 * component's Docs page, and it is also what the component manifest hands to an
 * AI agent asking what the component is. For most components it is the only
 * prose anyone will ever read about them.
 *
 * It started at 76 of 335 components, and almost none of those 76 said anything
 * useful. They failed in two directions, and this file checks for both:
 *
 *   the tautology   "Displays a button or a component that looks like a button."
 *   the ticket log  "ISS-5451: the session provenance marker, isolated."
 *
 * The rules below enforce the shape, not the taste. They cannot tell you a
 * description is helpful. They can tell you it exists, that it is long enough to
 * have answered "when would I pick this one", and that it was written for a
 * reader rather than for the person who closed the ticket.
 *
 * `WRITING.md` is the standard these rules come from.
 *
 * SCOPE: every level except Foundations, which document tokens rather than
 * components and have no props to table.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

const STORY_ROOTS = [
  join(REPO_ROOT, "apps/storybook/stories"),
  join(REPO_ROOT, "packages/app"),
  join(REPO_ROOT, "apps/desktop/src/renderer/components"),
];

// Foundations are deliberately absent. They document tokens rather than
// components, have no props to table, and the page itself is the documentation.
const DESCRIBED_LEVELS = ["Surfaces", "Composites", "Primitives"];

const TITLE = /const meta\b[\s\S]*?\n {2}title:\s*"([^"]+)"/;
/**
 * The JSDoc block immediately above `const meta`.
 *
 * The inner group is TEMPERED so it cannot cross a `*\/`. A plain lazy
 * `[\s\S]*?` looks correct and is not: it starts matching at the FIRST `/**` in
 * the file, so everything between that comment and the meta ends up inside the
 * match. Read, that means scanning unrelated fixture comments. Written, it means
 * replacing them. That bug deleted 977 lines across 215 files before it was
 * caught, so it is spelled out here rather than left to the next reader.
 */
const DESCRIPTION = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*\nconst meta\b/;

/** A reader does not know what ISS-5451 was. */
const TICKET = /\b(?:ISS|FEA|PLN|PRD|DSP)-\d+/i;
/** House rule, and they read badly in a docs paragraph. */
const LONG_DASH = /[—–]/;
/** Words about how the code got here, not about what the thing is. */
const PROCESS_WORDS =
  /\b(?:isolated|extracted|refactored|deprecated in favou?r|this used to|now that)\b/i;
/** Short enough that it cannot have answered "when would I reach for this". */
const MIN_LENGTH = 80;
/** Hoisted per useTopLevelRegex: this runs once per line of every description. */
const COMMENT_MARKER = /^\s*\*\s?/;

function walkStories(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") {
        found.push(...walkStories(full));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".stories.tsx")) {
      found.push(full);
    }
  }
  return found;
}

/** The description as one line of prose, comment markers stripped. */
function readDescription(source: string): string {
  const block = source.match(DESCRIPTION)?.[1];
  if (!block) {
    return "";
  }
  return block
    .split("\n")
    .map((line) => line.replace(COMMENT_MARKER, "").trim())
    .join(" ")
    .trim();
}

type Described = { title: string; file: string; description: string };

const described: Described[] = STORY_ROOTS.flatMap(walkStories)
  .map((file) => {
    const source = readFileSync(file, "utf8");
    const title = source.match(TITLE)?.[1] ?? "";
    return { title, file, description: readDescription(source) };
  })
  .filter((entry) => DESCRIBED_LEVELS.includes(entry.title.split("/")[0]));

/** Repo-relative, so a failure names something you can open. */
const rel = (file: string) => file.slice(REPO_ROOT.length + 1);

describe("every component explains itself", () => {
  it("finds the components it is supposed to check", () => {
    expect(described.length).toBeGreaterThan(300);
  });

  it("gives every one a description", () => {
    const missing = described
      .filter((entry) => entry.description.length === 0)
      .map((entry) => `${entry.title} (${rel(entry.file)})`);
    expect(
      missing,
      "A component with no comment above `const meta` renders a Docs page with a props table and no explanation, and hands an agent nothing to go on. See WRITING.md."
    ).toEqual([]);
  });

  it("writes enough to say when you would reach for it", () => {
    const tooShort = described
      .filter(
        (entry) =>
          entry.description.length > 0 && entry.description.length < MIN_LENGTH
      )
      .map((entry) => `${entry.title}: "${entry.description}"`);
    expect(
      tooShort,
      `Under ${MIN_LENGTH} characters is a label, not a description. The sentence that earns its place is the one saying when to use this instead of the component next to it.`
    ).toEqual([]);
  });

  it("does not cite ticket numbers", () => {
    const cited = described
      .filter((entry) => TICKET.test(entry.description))
      .map((entry) => `${entry.title}: "${entry.description.slice(0, 80)}"`);
    expect(
      cited,
      "A reader does not know what that ticket was. Say what the component does instead."
    ).toEqual([]);
  });

  it("does not describe the refactor that produced it", () => {
    const process = described
      .filter((entry) => PROCESS_WORDS.test(entry.description))
      .map((entry) => `${entry.title}: "${entry.description.slice(0, 80)}"`);
    expect(
      process,
      'Words like "isolated" and "extracted" describe how the code got here, which is not what the component is for.'
    ).toEqual([]);
  });

  it("uses no em or en dashes", () => {
    const dashed = described
      .filter((entry) => LONG_DASH.test(entry.description))
      .map((entry) => entry.title);
    expect(
      dashed,
      "House rule. Use a full stop, a colon, or brackets."
    ).toEqual([]);
  });

  // Self-tests, so the rules above cannot quietly stop matching anything.
  describe("the rules still catch what they are for", () => {
    it("catches a ticket log", () => {
      expect(TICKET.test("ISS-5451: the session provenance marker.")).toBe(
        true
      );
      expect(TICKET.test("A small label beside the session name.")).toBe(false);
    });

    it("catches refactor language", () => {
      expect(
        PROCESS_WORDS.test("The cost card's state matrix, isolated.")
      ).toBe(true);
      expect(PROCESS_WORDS.test("Shows what a session cost to run.")).toBe(
        false
      );
    });

    it("reads only the comment directly above the meta", () => {
      const source = [
        "/** A fixture comment that is not the description. */",
        "const FIXTURE = 1;",
        "",
        "/** The real description. */",
        "const meta = {",
      ].join("\n");
      expect(readDescription(source)).toBe("The real description.");
    });

    it("catches a long dash", () => {
      expect(LONG_DASH.test("A badge — for status.")).toBe(true);
      expect(LONG_DASH.test("A badge for status.")).toBe(false);
    });
  });
});
