import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AUDIT_CHARACTER_ROSTER } from "../src/shared/audit-character-roster.generated.js";
import {
  AUDIT_CHARACTER_IDS,
  characterMetaFor,
} from "../src/shared/audit-contract.js";

/**
 * FEA-4013 — the desktop audit picker must offer the FULL cast of shipped review
 * characters, not a hardcoded subset. These guards enforce contract/resource
 * parity: every prompt file under `resources/audit-characters/**` (minus the
 * excluded `shared/` infra fragments) has exactly one roster entry, every roster
 * entry resolves to a runnable prompt file, and every roster id is accepted by
 * the IPC validation set. A regression to a partial list fails here rather than
 * silently hiding characters from the picker.
 *
 * NOTE: this suite does NOT protect against a stale *committed* roster on the
 * normal path — `prebuild` runs the generator and rewrites the file before this
 * test imports it, so a hand-stale commit would be silently regenerated. That
 * drift is caught by the generator's `--check` mode (the `verify:audit-roster`
 * script, run before `prebuild` in the `test` script), not here. What THIS suite
 * adds on top is tag/filing-tag uniqueness and the roster→IPC contract — things
 * `--check` (a pure file-diff) cannot assert.
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const charactersDir = path.join(
  scriptDir,
  "..",
  "resources",
  "audit-characters"
);

/** Author subfolders excluded from the cast (shared infra prompt fragments). */
const EXCLUDED_DIRS = new Set(["shared"]);

/** The `.md` prompt-file extension, stripped to form the character id. */
const MD_EXT_RE = /\.md$/;
/** A capitalized-word start, so a derived description reads as a sentence. */
const SENTENCE_START_RE = /^[A-Z0-9]/;
/** The repo-name boilerplate the picker copy must not carry. */
const REPO_BOILERPLATE_RE = /symphony-alpha monorepo/i;
/** A `/`, replaced with `-`, to derive the expected nested filing tag. */
const PATH_SEP_RE = /\//g;
/** A known upper-cased acronym that must survive description cleanup. */
const ACRONYM_RE = /\b(?:API|SDK|IPC|MCP|UI|UX|DX|DBA|PII|LLM|QA|CI|CD)\b/;
/**
 * An acronym that is never a real lower-case English word, lower-cased in a
 * description — the signature of the blanket-all-caps cleanup regression.
 */
const LOWERCASED_ACRONYM_RE = /\b(?:api|sdk|ipc|mcp|dba|pii|llm|vqa)\b/;

/** Recursively collect character prompt ids (path relative to the dir, no `.md`). */
function collectCharacterFileIds(rel = ""): string[] {
  const ids: string[] = [];
  const dir = path.join(charactersDir, rel);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) {
        ids.push(...collectCharacterFileIds(childRel));
      }
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      ids.push(childRel.replace(MD_EXT_RE, ""));
    }
  }
  return ids;
}

describe("audit character roster parity (FEA-4013)", () => {
  const fileIds = collectCharacterFileIds().sort((a, b) => a.localeCompare(b));
  const rosterIds = AUDIT_CHARACTER_ROSTER.map((entry) => entry.id).sort(
    (a, b) => a.localeCompare(b)
  );

  test("the shipped cast is more than the legacy core-4 subset", () => {
    // Guards against a regression to the old hardcoded 4-member picker list.
    assert.ok(
      fileIds.length > 4,
      `expected the full cast (>4), found ${fileIds.length}`
    );
  });

  test("every shipped character file has exactly one roster entry", () => {
    assert.deepEqual(
      rosterIds,
      fileIds,
      "the generated roster drifted from resources/audit-characters — re-run scripts/generate-audit-character-roster.mjs"
    );
  });

  test("no shared infra prompt fragment is surfaced as a character", () => {
    for (const entry of AUDIT_CHARACTER_ROSTER) {
      assert.ok(
        !entry.id.startsWith("shared/"),
        `shared infra prompt must not be a character: ${entry.id}`
      );
    }
  });

  test("every roster entry has non-empty presentation metadata", () => {
    for (const entry of AUDIT_CHARACTER_ROSTER) {
      const meta = characterMetaFor(entry.id);
      assert.ok(meta, `no resolvable meta for ${entry.id}`);
      assert.ok(meta.label.length > 0, `empty label for ${entry.id}`);
      assert.ok(
        meta.description.length > 0,
        `empty description for ${entry.id}`
      );
      assert.ok(meta.tag.startsWith("agent-"), `bad tag for ${entry.id}`);
    }
  });

  test("every character has a unique filing tag (no basename collision)", () => {
    // A filed issue is attributed by its tag, so two distinct characters must
    // never share one — a basename-only tag would file a core `docs-darwin` and
    // the nightly `kaitic/docs-darwin` both under `agent-docs-darwin`, colliding
    // attribution and collapsing the per-character dedup guard (FEA-4013 review).
    const tags = AUDIT_CHARACTER_ROSTER.map((entry) => entry.tag);
    const uniqueTags = new Set(tags);
    assert.equal(
      uniqueTags.size,
      tags.length,
      "duplicate filing tag(s) in roster — nested ids must derive a unique tag"
    );
  });

  test("a nested character's tag carries its author path", () => {
    // Regression guard for the basename-collision fix: a nested id derives its
    // tag from the full path (`agent-<author>-<basename>`), not just the file.
    const nested = AUDIT_CHARACTER_ROSTER.find((entry) =>
      entry.id.includes("/")
    );
    assert.ok(nested, "expected at least one nested (author-folder) character");
    if (nested) {
      const expected = `agent-${nested.id.replace(PATH_SEP_RE, "-")}`;
      assert.equal(
        nested.tag,
        expected,
        `nested tag must include the author path: ${nested.id}`
      );
    }
  });

  test("derived descriptions read as sentences, not scraped clauses", () => {
    // The picker used to render lowercase, run-on, dual-voice copy for the 37
    // non-core characters (FEA-4013 review). Every description must now be a
    // capitalized, single-clause sentence with no scraped em-dash/paren noise.
    for (const entry of AUDIT_CHARACTER_ROSTER) {
      const { description } = entry;
      assert.match(
        description,
        SENTENCE_START_RE,
        `description should start capitalized: ${entry.id} → "${description}"`
      );
      assert.ok(
        !description.includes("—"),
        `description should not carry an em-dash aside: ${entry.id}`
      );
      assert.ok(
        !REPO_BOILERPLATE_RE.test(description),
        `description should drop the repo boilerplate: ${entry.id}`
      );
    }
  });

  test("description cleanup preserves acronyms, not just casing", () => {
    // The shouty-word calming must NOT lower-case legitimate acronyms — a
    // blanket all-caps rule turned "API/SDK/UI/UX" into lowercase (FEA-4013
    // review). Assert at least one known acronym survives upper-cased.
    const withAcronym = AUDIT_CHARACTER_ROSTER.find((entry) =>
      ACRONYM_RE.test(entry.description)
    );
    assert.ok(
      withAcronym,
      "expected at least one description to retain an upper-cased acronym"
    );
    // And no description silently lower-cased a common acronym.
    for (const entry of AUDIT_CHARACTER_ROSTER) {
      assert.ok(
        !LOWERCASED_ACRONYM_RE.test(entry.description),
        `description lower-cased an acronym: ${entry.id} → "${entry.description}"`
      );
    }
  });

  test("every roster id is accepted by the IPC validation set", () => {
    for (const id of rosterIds) {
      assert.ok(
        AUDIT_CHARACTER_IDS.has(id),
        `roster id not accepted by IPC validation: ${id}`
      );
    }
    assert.equal(AUDIT_CHARACTER_IDS.size, rosterIds.length);
  });

  test("core characters are grouped separately from author folders", () => {
    const coreIds = AUDIT_CHARACTER_ROSTER.filter(
      (entry) => entry.group === "core"
    ).map((entry) => entry.id);
    // Top-level prompt files (no folder) are the core group.
    for (const id of coreIds) {
      assert.ok(!id.includes("/"), `core id should be top-level: ${id}`);
    }
    assert.ok(coreIds.length >= 4, "expected at least the 4 core characters");
  });
});
