import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { parse } from "yaml";
import { AUDIT_CHARACTER_ROSTER } from "../src/shared/audit-character-roster.generated.js";

/**
 * FEA-4013 — packaging-config guard for the FULL audit cast.
 *
 * The picker now offers ~41 characters, most of them in author subfolders
 * (`kaitic/desktop-denny.md`). Those prompts ship to the packaged app via the
 * `audit-characters` extraResources entry — and ONLY if its filter is recursive
 * (`**` /*.md). A regression to a single-level `*.md` filter would ship only the
 * 4 top-level prompts, and every nested character would then fail "character
 * prompt not found" at runtime in packaged builds. That regression is invisible
 * to PR validation (which stops at `stage:package`) and to the post-merge
 * packaging job (which only checks the outer artifacts), so it would land
 * cleanly — this guard fails it pre-merge instead (FEA-4013 review).
 *
 * This reads the declarative electron-builder config (allowed config-file
 * assertion), not implementation source.
 */

// cwd for the desktop test suite is apps/desktop.
const CONFIG_PATH = path.resolve("electron-builder.yml");
const CHARACTERS_DIR = path.resolve("resources", "audit-characters");

type ExtraResource = {
  from?: string;
  to?: string;
  filter?: string[];
};

function findAuditResource(): ExtraResource | undefined {
  const config = parse(fs.readFileSync(CONFIG_PATH, "utf8")) as {
    extraResources?: ExtraResource[];
  };
  return (config.extraResources ?? []).find(
    (resource) => resource?.from === "resources/audit-characters"
  );
}

describe("electron-builder audit-character resources (FEA-4013)", () => {
  test("ships the audit prompts unpacked to `audit-characters`", () => {
    const entry = findAuditResource();
    assert.ok(
      entry,
      "electron-builder.yml must ship the audit-characters resources"
    );
    assert.equal(entry.to, "audit-characters");
  });

  test("uses a RECURSIVE filter so nested author prompts ship too", () => {
    const entry = findAuditResource();
    assert.ok(entry, "audit-characters resource entry must exist");
    const filters = entry.filter ?? [];
    // A single-level `*.md` would drop every author-subfolder character.
    assert.ok(
      filters.includes("**/*.md"),
      `audit-characters filter must be recursive (**/*.md); got ${JSON.stringify(filters)}`
    );
    assert.ok(
      !filters.includes("*.md"),
      "audit-characters filter must not be a single-level *.md (drops nested prompts)"
    );
  });

  test("every roster character's prompt file is on disk to be packaged", () => {
    // The recursive filter only matters if the prompts exist; guard the roster
    // against a deleted/renamed source file the filter can no longer match.
    const nested = AUDIT_CHARACTER_ROSTER.filter((entry) =>
      entry.id.includes("/")
    );
    assert.ok(
      nested.length > 0,
      "expected at least one nested (author-folder) character to package"
    );
    for (const entry of AUDIT_CHARACTER_ROSTER) {
      const promptFile = path.join(CHARACTERS_DIR, `${entry.id}.md`);
      assert.ok(
        fs.existsSync(promptFile),
        `roster character has no prompt file to package: ${entry.id}`
      );
    }
  });
});
