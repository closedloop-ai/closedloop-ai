/**
 * ISS-5303 — the pure parsing helpers behind the Audit Bot roster generator.
 *
 * `scripts/generate-audit-character-roster.mjs` is a top-level side-effecting
 * script: importing it walks `resources/audit-characters/**`, renders the roster
 * module and then writes it, reports it up to date, or exits 1. Every string
 * derivation it performs — markdown stripping, first-sentence trimming,
 * shouty-word calming, label/description parsing, tag and group derivation —
 * was therefore unreachable from a test, and the picker copy those helpers
 * produce was only ever asserted in aggregate by
 * `test/audit-character-roster.test.ts` ("no description carries an em-dash",
 * "some description keeps an acronym"). Aggregate shape assertions cannot pin a
 * derivation: they stay green while a helper mangles a clause in a way no
 * shipped prompt file happens to trigger.
 *
 * These suites drive the extracted helpers directly against synthetic prompt
 * text, then prove the extraction is actually wired: the generator's `--check`
 * mode still reports the committed roster up to date (so the rewire produced
 * byte-identical output), and every committed roster entry is re-derivable from
 * these helpers (so the entrypoint has not drifted to a second, private copy).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  calmShoutyWords,
  capitalizeFirst,
  cleanDescription,
  firstNonBlankLine,
  firstSentence,
  groupForId,
  groupLabelFor,
  parseLabelAndDescription,
  stripInlineMarkdown,
  tagForId,
} from "../scripts/generate-audit-character-roster-lib.mjs";
import { AUDIT_CHARACTER_ROSTER } from "../src/shared/audit-character-roster.generated.js";

const desktopDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const generatorPath = path.join(
  desktopDir,
  "scripts",
  "generate-audit-character-roster.mjs"
);
const charactersDir = path.join(desktopDir, "resources", "audit-characters");

const UP_TO_DATE_PATTERN =
  /generate-audit-character-roster: up to date \(\d+ characters\)/;

/**
 * `--check` walks the prompt tree and diffs; anything approaching this is a
 * hang. node:test's own `timeout` cannot interrupt `spawnSync` (it blocks this
 * worker's event loop), so the child needs its own deadline and the case a
 * strictly larger one.
 */
const SPAWN_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 60_000;

describe("ISS-5303: stripInlineMarkdown", () => {
  test("strips bold and code markers and trims", () => {
    assert.equal(
      stripInlineMarkdown("  **Docs Darwin** reviews `apps/web`  "),
      "Docs Darwin reviews apps/web"
    );
  });

  test("leaves italic and link syntax alone — deliberately narrow", () => {
    // The helper strips only the two markers a prompt's FIRST line actually
    // carries. Pinning the boundary matters: broadening it to `*` would eat the
    // asterisks out of a glob like `src/**/*.ts`, and broadening it to link
    // syntax would silently drop a URL a description references.
    assert.equal(
      stripInlineMarkdown("*italic* and [links](https://example.test)"),
      "*italic* and [links](https://example.test)"
    );
  });

  test("returns an empty string for whitespace-only input", () => {
    assert.equal(stripInlineMarkdown("   \t "), "");
  });
});

describe("ISS-5303: firstNonBlankLine", () => {
  test("skips leading blank and whitespace-only lines, and trims", () => {
    assert.equal(
      firstNonBlankLine("\n\n   \n  # Heading  \nnext\n"),
      "# Heading"
    );
  });

  test("returns an empty string when every line is blank", () => {
    // The parse path must degrade to the id-derived fallback rather than throw
    // on an empty or whitespace-only prompt file.
    assert.equal(firstNonBlankLine("\n \n"), "");
  });
});

describe("ISS-5303: firstSentence", () => {
  test("cuts a multi-sentence clause at its first sentence, keeping the period", () => {
    assert.equal(
      firstSentence(
        "Audits every database migration for reversibility and index coverage. It also flags missing constraints."
      ),
      "Audits every database migration for reversibility and index coverage."
    );
  });

  test("keeps a short first sentence joined to what follows", () => {
    // The >40 guard exists so a terse opening ("Reviews CI.") is not truncated
    // into something useless; the whole clause survives instead.
    assert.equal(
      firstSentence("Reviews CI. It also reviews the release pipeline."),
      "Reviews CI. It also reviews the release pipeline."
    );
  });

  test("an abbreviation inside the guard does not truncate the clause", () => {
    assert.equal(
      firstSentence(
        "Covers e.g. the IPC bridge and the gateway routes in one pass. Nothing else."
      ),
      "Covers e.g. the IPC bridge and the gateway routes in one pass. Nothing else."
    );
  });

  test("an abbreviation PAST the guard does truncate — the guard is positional", () => {
    // Honest pin of a real limitation: the cut is `". "` at an offset, not a
    // sentence parser, so a late "e.g." reads as a sentence end. No shipped
    // prompt file hits this today; if one ever does, this test names why the
    // description came out clipped instead of leaving it a mystery.
    assert.equal(
      firstSentence(
        "Reviews the desktop collector and the sync lanes, e.g. the transcript importer."
      ),
      "Reviews the desktop collector and the sync lanes, e.g."
    );
  });

  test("a clause with no sentence break is returned unchanged", () => {
    assert.equal(
      firstSentence("the guardian of the migration order"),
      "the guardian of the migration order"
    );
  });
});

describe("ISS-5303: calmShoutyWords", () => {
  test("lower-cases shouted emphasis words and keeps acronyms upper-cased", () => {
    // The FEA-4013 regression this replaced: a blanket all-caps rule turned
    // "API"/"CLI" into lowercase alongside the emphasis it was meant to calm.
    assert.equal(
      calmShoutyWords(
        "Reviews BOTH the web app and the API surface, but NEVER the CLI."
      ),
      "Reviews both the web app and the API surface, but never the CLI."
    );
  });

  test("calms every occurrence, not just the first", () => {
    assert.equal(
      calmShoutyWords("ALWAYS files, NEVER edits, ONLY reports"),
      "always files, never edits, only reports"
    );
  });

  test("leaves a single capital letter alone", () => {
    // The match requires two or more capitals, so an initial ("Reviews A/B
    // lanes") is never mistaken for shouting.
    assert.equal(calmShoutyWords("Reviews A lane"), "Reviews A lane");
  });
});

describe("ISS-5303: capitalizeFirst", () => {
  test("upper-cases the leading character", () => {
    assert.equal(capitalizeFirst("the reviewer"), "The reviewer");
  });

  test("returns an empty string untouched", () => {
    assert.equal(capitalizeFirst(""), "");
  });
});

describe("ISS-5303: cleanDescription", () => {
  test("drops the repo boilerplate and everything trailing it", () => {
    assert.equal(
      cleanDescription(
        "the **guardian** of the migration order for the symphony-alpha monorepo — files everything under `agent-x` (nightly)."
      ),
      "The guardian of the migration order."
    );
  });

  test("drops an em-dash aside but keeps the calmed clause before it", () => {
    assert.equal(
      cleanDescription("the reviewer of ALL desktop IPC — see the notes."),
      "The reviewer of all desktop IPC."
    );
  });

  test("drops a trailing parenthetical", () => {
    assert.equal(
      cleanDescription("the auditor of nightly runs (kaitic)"),
      "The auditor of nightly runs."
    );
  });

  test("collapses trailing punctuation to exactly one period", () => {
    assert.equal(
      cleanDescription("reviews the schema..."),
      "Reviews the schema."
    );
  });

  test("an empty clause yields an empty description, not a bare period", () => {
    // A prompt whose opening line cleans away entirely must render as blank in
    // the picker rather than as a lone ".".
    assert.equal(cleanDescription("   "), "");
  });
});

describe("ISS-5303: parseLabelAndDescription", () => {
  test("splits the `# Name — description` heading form", () => {
    assert.deepEqual(
      parseLabelAndDescription(
        "\n\n# Migration Molly — the guardian of migration order.\n\nBody\n",
        "migration-molly"
      ),
      {
        label: "Migration Molly",
        description: "The guardian of migration order.",
      }
    );
  });

  test("splits the `You are **Name**, …` prose form and unwraps the bold", () => {
    assert.deepEqual(
      parseLabelAndDescription(
        "You are **Desktop Denny**, the reviewer of the Electron surface for the symphony-alpha monorepo.\n",
        "kaitic/desktop-denny"
      ),
      {
        label: "Desktop Denny",
        description: "The reviewer of the Electron surface.",
      }
    );
  });

  test("an unrecognized opening line falls back to the title-cased id basename", () => {
    // Malformed input must still yield a usable picker entry rather than throw
    // — a new prompt file in an unforeseen format degrades, it does not break
    // the generator.
    assert.deepEqual(
      parseLabelAndDescription(
        "Some random opening line without a recognizable form.\n",
        "kaitic/docs-darwin"
      ),
      {
        label: "Docs Darwin",
        description: "Some random opening line without a recognizable form.",
      }
    );
  });

  test("a lower-cased parsed name is rejected and falls back to the id", () => {
    // The capitalized-start check is what stops a handle ("You are wongk, …")
    // from becoming a picker label. Without it the picker would show "wongk".
    assert.deepEqual(
      parseLabelAndDescription(
        "You are wongk, the reviewer of the merge queue.\n",
        "core-critic"
      ),
      {
        label: "Core Critic",
        description: "You are wongk, the reviewer of the merge queue.",
      }
    );
  });
});

describe("ISS-5303: tagForId / groupForId / groupLabelFor", () => {
  test("a top-level id keeps its legacy flat filing tag", () => {
    assert.equal(tagForId("docs-darwin"), "agent-docs-darwin");
  });

  test("a nested id folds its author path into the tag", () => {
    // Attribution depends on this: a basename-only tag would file a core
    // `docs-darwin` and a nightly `kaitic/docs-darwin` under one tag.
    assert.equal(tagForId("kaitic/docs-darwin"), "agent-kaitic-docs-darwin");
    assert.notEqual(tagForId("kaitic/docs-darwin"), tagForId("docs-darwin"));
  });

  test("every path separator is replaced, not just the first", () => {
    assert.equal(tagForId("a/b/c"), "agent-a-b-c");
  });

  test("a top-level id groups under core, a nested id under its author folder", () => {
    assert.equal(groupForId("docs-darwin"), "core");
    assert.equal(groupForId("kaitic/docs-darwin"), "kaitic");
    assert.equal(groupForId("a/b/c"), "a");
  });

  test("a known author folder renders its friendly name", () => {
    assert.equal(groupLabelFor("kaitic"), "Kai Tic");
    assert.equal(groupLabelFor("core"), "Core");
  });

  test("an unknown author folder falls back to a title-cased slug", () => {
    assert.equal(groupLabelFor("new-author_two"), "New Author Two");
  });

  test("an inherited Object property name is not treated as a known folder", () => {
    // The lookup is `Object.hasOwn`-guarded, so a folder literally named
    // `constructor` renders a heading instead of stringifying Object's
    // constructor into the picker.
    assert.equal(groupLabelFor("constructor"), "Constructor");
    assert.equal(groupLabelFor("toString"), "ToString");
  });
});

describe("ISS-5303: the generator is actually wired to these helpers", () => {
  test("`--check` still reports the committed roster up to date", {
    timeout: CASE_TIMEOUT_MS,
  }, () => {
    // The extraction is only behaviour-preserving if the entrypoint still
    // renders byte-identical output. `--check` re-derives the whole roster
    // from the real prompt tree and diffs it against the committed module
    // WITHOUT writing, so a helper that changed meaning during the move — or
    // an import that resolves to the wrong symbol — exits 1 here. This is the
    // same mode `pnpm verify:audit-roster` runs in CI before prebuild.
    const result = spawnSync(process.execPath, [generatorPath, "--check"], {
      cwd: desktopDir,
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });

    assert.equal(
      result.error,
      undefined,
      `generator did not exit on its own: ${result.error?.message ?? ""}`
    );
    assert.equal(
      result.status,
      0,
      `--check failed; stderr: ${result.stderr}\nstdout: ${result.stdout}`
    );
    assert.match(result.stdout, UP_TO_DATE_PATTERN);
  });

  test("every committed roster entry is re-derivable from these helpers", () => {
    // `--check` alone proves the entrypoint agrees with the file on disk; it
    // cannot tell whether the entrypoint still uses THIS lib or quietly grew a
    // second private copy of the derivations. Re-deriving each shipped entry
    // from the exported helpers closes that gap: a drifted or re-inlined helper
    // makes the derived value disagree with the committed one.
    assert.ok(
      AUDIT_CHARACTER_ROSTER.length > 0,
      "the committed roster is empty — nothing to cross-check"
    );

    for (const entry of AUDIT_CHARACTER_ROSTER) {
      const raw = readFileSync(
        path.join(charactersDir, `${entry.id}.md`),
        "utf8"
      );
      const derived = parseLabelAndDescription(raw, entry.id);
      const group = groupForId(entry.id);
      const groupLabel = groupLabelFor(group);

      assert.equal(entry.tag, tagForId(entry.id), `tag drift for ${entry.id}`);
      assert.equal(entry.group, group, `group drift for ${entry.id}`);
      assert.equal(
        entry.groupLabel,
        groupLabel,
        `groupLabel drift for ${entry.id}`
      );
      assert.equal(
        entry.description,
        derived.description,
        `description drift for ${entry.id}`
      );
      // The entrypoint qualifies a duplicated display name with its author
      // group ("Docs Darwin (Kai Tic)"); that disambiguation is the
      // entrypoint's job, not the lib's, so accept either form.
      assert.ok(
        entry.label === derived.label ||
          entry.label === `${derived.label} (${groupLabel})`,
        `label drift for ${entry.id}: committed "${entry.label}" vs derived "${derived.label}"`
      );
    }
  });
});
