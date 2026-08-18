/**
 * @file agent-coaching-skill-install.test.ts
 * Unit tests for the deterministic coaching skill install (FEA-3687 #3/#4).
 *
 * Covers:
 *   - installCoachingSkillFile: writes `<skillsDir>/<slug>/SKILL.md` with valid
 *     frontmatter, deriving the name from frontmatter or a `# Heading`.
 *   - coachingSkillSlug: slug safety + segment cap (no giant slugs).
 *   - installCoachingSkillArtifact: structured ok/failure wrapper.
 *   - installCoachingArtifact dispatch by kind: create-new-file writes a file
 *     deterministically (no harness); an unusable draft fails cleanly.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { installCoachingArtifact } from "../src/main/agent-monitor/agent-coaching-harness.js";
import {
  coachingSkillSlug,
  installCoachingSkillArtifact,
  installCoachingSkillFile,
} from "../src/main/agent-monitor/agent-coaching-skill-install.js";
import { parseSkillFrontmatter } from "../src/main/packs/pack-scanner.js";

const FRONTMATTER_NAME_HEAD_PATTERN = /^---\nname: "repo-state-inspection"\n/;
const FRONTMATTER_DESCRIPTION_PATTERN =
  /description: "Gather branch, dirty files, and PR status\."/;
const BODY_PATTERN = /Return the compact repo facts\./;
const HEADING_NAME_PATTERN = /name: "Preflight Skill"/;
const HEADING_DESCRIPTION_PATTERN = /description: "Do the preflight\."/;
const NO_USABLE_NAME_PATTERN = /no usable name/;
const INSTALLED_TOKEN_COACH_PATTERN =
  /Installed skill at .+token-coach.+SKILL\.md/;
const REPO_STATE_SKILL_PATTERN = /repo-state-skill/;
const QUOTED_NAME_PATTERN = /name: "Deploy: production \\"now\\""/;
const QUOTED_DESCRIPTION_PATTERN = /description: "say \\"yes\\" then deploy"/;

let skillsDir: string;

beforeEach(() => {
  skillsDir = mkdtempSync(path.join(tmpdir(), "coaching-skills-"));
});

afterEach(() => {
  rmSync(skillsDir, { recursive: true, force: true });
});

describe("coachingSkillSlug", () => {
  test("slugifies a plain name", () => {
    assert.equal(
      coachingSkillSlug("Nightly Review Preflight"),
      "nightly-review-preflight"
    );
  });

  test("caps giant/blobby names to a short slug (no leaked identifier)", () => {
    const giant =
      "session id 65950db3 bb90 4438 babe tool input command cd extra";
    const slug = coachingSkillSlug(giant);
    assert.ok(slug);
    assert.ok(
      (slug as string).split("-").length <= 6,
      `expected <= 6 segments, got ${slug}`
    );
  });

  test("returns null when nothing usable remains", () => {
    assert.equal(coachingSkillSlug("///"), null);
  });
});

describe("installCoachingSkillFile", () => {
  test("writes SKILL.md with frontmatter from the draft's own frontmatter", () => {
    const draft = [
      "---",
      "name: repo-state-inspection",
      "description: Gather branch, dirty files, and PR status.",
      "---",
      "",
      "# Repo state inspection",
      "",
      "Return the compact repo facts.",
    ].join("\n");

    const { slug, filePath } = installCoachingSkillFile(draft, skillsDir);
    assert.equal(slug, "repo-state-inspection");
    assert.equal(
      filePath,
      path.join(skillsDir, "repo-state-inspection", "SKILL.md")
    );
    const written = readFileSync(filePath, "utf8");
    assert.match(written, FRONTMATTER_NAME_HEAD_PATTERN);
    assert.match(written, FRONTMATTER_DESCRIPTION_PATTERN);
    assert.match(written, BODY_PATTERN);
  });

  test("derives the name from a leading heading when no frontmatter", () => {
    const draft = "# Preflight Skill\n\nDo the preflight.";
    const { slug, filePath } = installCoachingSkillFile(draft, skillsDir);
    assert.equal(slug, "preflight-skill");
    const written = readFileSync(filePath, "utf8");
    assert.match(written, HEADING_NAME_PATTERN);
    // A description is synthesized from the first body line when absent.
    assert.match(written, HEADING_DESCRIPTION_PATTERN);
  });

  test("throws (does not write a nameless skill) when no name is derivable", () => {
    assert.throws(
      () =>
        installCoachingSkillFile("just some prose with no heading", skillsDir),
      NO_USABLE_NAME_PATTERN
    );
  });

  test("quotes YAML-unsafe frontmatter values", () => {
    const draft = '# Deploy: production "now"\n\nsay "yes" then deploy';
    const { filePath } = installCoachingSkillFile(draft, skillsDir);
    const written = readFileSync(filePath, "utf8");
    assert.match(written, QUOTED_NAME_PATTERN);
    assert.match(written, QUOTED_DESCRIPTION_PATTERN);
  });

  // Regression (codex P2): the quoted frontmatter we write must round-trip
  // cleanly through the shared `parseSkillFrontmatter` collector. A value with
  // an embedded quote is JSON-escaped on write (`\"`); the parser must UNESCAPE
  // it, not leave literal backslashes in the indexed name/description.
  test("frontmatter with embedded quotes round-trips through the collector", () => {
    const draft = '# Deploy: production "now"\n\nsay "yes" then deploy';
    const { filePath } = installCoachingSkillFile(draft, skillsDir);
    const written = readFileSync(filePath, "utf8");
    const meta = parseSkillFrontmatter(written);
    assert.ok(meta);
    assert.equal(meta.name, 'Deploy: production "now"');
    assert.equal(meta.description, 'say "yes" then deploy');
    // No stray escape characters survived the round-trip.
    assert.ok(!meta.name.includes("\\"), "name has no leftover backslashes");
    assert.ok(
      !meta.description.includes("\\"),
      "description has no leftover backslashes"
    );
  });
});

describe("installCoachingSkillArtifact", () => {
  test("returns ok with the created path", () => {
    const result = installCoachingSkillArtifact(
      "# Token Coach\n\nAudit token usage.",
      skillsDir
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.match(result.output, INSTALLED_TOKEN_COACH_PATTERN);
    }
  });

  test("returns a structured failure for an unusable draft", () => {
    const result = installCoachingSkillArtifact("no name here", skillsDir);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "nonzero_exit");
    }
  });
});

describe("installCoachingArtifact dispatch by kind (FEA-3687 #4)", () => {
  const originalClaudeHome = process.env.CLAUDE_HOME;

  afterEach(() => {
    if (originalClaudeHome === undefined) {
      process.env.CLAUDE_HOME = undefined;
      delete process.env.CLAUDE_HOME;
    } else {
      process.env.CLAUDE_HOME = originalClaudeHome;
    }
  });

  test("create-new-file installs a real SKILL.md deterministically (no harness)", async () => {
    // Point the resolver's `~/.claude` at a temp home so the write is contained.
    const home = mkdtempSync(path.join(tmpdir(), "claude-home-"));
    process.env.CLAUDE_HOME = home;
    try {
      const result = await installCoachingArtifact(
        "# Repo State Skill\n\nGather repo facts.",
        "claude",
        "create-new-file"
      );
      assert.equal(result.ok, true);
      const expected = path.join(
        home,
        "skills",
        "repo-state-skill",
        "SKILL.md"
      );
      assert.ok(existsSync(expected), `expected ${expected} to exist`);
      if (result.ok) {
        assert.match(result.output, REPO_STATE_SKILL_PATTERN);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("an unusable create-new-file draft fails cleanly without spawning", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "claude-home-"));
    process.env.CLAUDE_HOME = home;
    try {
      const result = await installCoachingArtifact(
        "prose with no name",
        "claude",
        "create-new-file"
      );
      assert.equal(result.ok, false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
