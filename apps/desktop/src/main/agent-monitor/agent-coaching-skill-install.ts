/**
 * @file agent-coaching-skill-install.ts — deterministic local install of a
 * coaching "create-new-file" recommendation (FEA-3687 #3/#4).
 *
 * The old "Apply" concatenated the draft into a generic "install this artifact
 * properly" instruction and handed it to a harness — non-deterministic, with no
 * guarantee a valid skill `.md` ever landed anywhere. For the common
 * `create-new-file` kind (promote a repeated command into a NEW skill), the
 * artifact content is already the drafted `proposedArtifact`; there is nothing
 * to reason about, so we install it deterministically:
 *
 *   1. Parse the drafted markdown for a skill name (frontmatter `name:` → first
 *      `# Heading` → fallback) and any existing frontmatter.
 *   2. Write `<skillsDir>/<slug>/SKILL.md` with valid `name` + `description`
 *      frontmatter and the body, creating the directory.
 *   3. Return the created path so Apply can confirm it back to the user.
 *
 * Deliberately electron-free — it takes the skills directory as a plain path so
 * it is unit-testable under `node:test` with a temp dir. The electron glue
 * (resolving `~/.claude/skills`) lives in the IPC/harness layer.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CoachingHarnessResult } from "../../shared/coaching-pack-contract.js";

const MARKER_FILE = "SKILL.md";
const MAX_DESCRIPTION_CHARS = 240;
const SLUG_MAX_SEGMENTS = 6;

const FRONTMATTER_PATTERN = /^\s*---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const FRONTMATTER_NAME_PATTERN = /^name:\s*(.+)$/m;
const FRONTMATTER_DESCRIPTION_PATTERN = /^description:\s*(.+)$/m;
const HEADING_PATTERN = /^#\s+(.+?)\s*$/m;
const NON_SLUG_CHARACTER_PATTERN = /[^a-z0-9]+/g;
const SLUG_EDGE_PATTERN = /^-+|-+$/g;
const WHITESPACE_PATTERN = /\s+/g;

export type CoachingSkillInstallResult = {
  /** The slug used as the skill directory name. */
  slug: string;
  /** Absolute path to the written SKILL.md. */
  filePath: string;
};

type ParsedDraft = {
  name: string | null;
  description: string | null;
  body: string;
};

/**
 * Reduce a name to a short, filesystem-safe skill slug. Caps the segment count
 * so a blobby/over-long name can never expand into a giant directory name.
 * Returns null when nothing usable remains.
 */
export function coachingSkillSlug(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(NON_SLUG_CHARACTER_PATTERN, "-")
    .replace(SLUG_EDGE_PATTERN, "")
    .split("-")
    .filter((segment) => segment.length > 0)
    .slice(0, SLUG_MAX_SEGMENTS)
    .join("-")
    .slice(0, 80);
  return slug.length > 0 ? slug : null;
}

/**
 * Split a drafted artifact into frontmatter-derived name/description and the
 * markdown body. When the draft already carries `---` frontmatter we honor its
 * `name`/`description`; otherwise we derive the name from the first `# Heading`.
 */
function parseDraft(draft: string): ParsedDraft {
  const trimmed = draft.trim();
  const fm = trimmed.match(FRONTMATTER_PATTERN);
  if (fm) {
    const [, frontmatter, body] = fm;
    const nameMatch = frontmatter.match(FRONTMATTER_NAME_PATTERN);
    const descriptionMatch = frontmatter.match(FRONTMATTER_DESCRIPTION_PATTERN);
    return {
      name: nameMatch ? nameMatch[1].trim() : null,
      description: descriptionMatch ? descriptionMatch[1].trim() : null,
      body: body.trim(),
    };
  }
  const heading = trimmed.match(HEADING_PATTERN);
  return {
    name: heading ? heading[1].trim() : null,
    description: null,
    body: trimmed,
  };
}

/**
 * Derive a one-line description from the body when the draft carried none: the
 * first non-heading, non-blank line, capped. Empty when nothing usable.
 */
function deriveDescription(body: string): string {
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("---")) {
      continue;
    }
    const collapsed = line.replace(WHITESPACE_PATTERN, " ");
    return collapsed.length > MAX_DESCRIPTION_CHARS
      ? `${collapsed.slice(0, MAX_DESCRIPTION_CHARS)}…`
      : collapsed;
  }
  return "";
}

/**
 * Deterministically install a coaching skill draft as
 * `<skillsDir>/<slug>/SKILL.md` with valid frontmatter. Throws when the draft
 * carries no usable skill name (so the caller can fall back / report failure)
 * rather than writing a nameless skill.
 */
export function installCoachingSkillFile(
  draft: string,
  skillsDir: string
): CoachingSkillInstallResult {
  const parsed = parseDraft(draft);
  const name = parsed.name;
  const slug = name ? coachingSkillSlug(name) : null;
  if (!(name && slug)) {
    throw new Error(
      "coaching skill draft has no usable name (expected frontmatter `name:` or a `# Heading`)"
    );
  }
  const description = parsed.description ?? deriveDescription(parsed.body);
  const dir = path.join(skillsDir, slug);
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, MARKER_FILE);
  writeFileSync(filePath, renderSkillFile(name, description, parsed.body));
  return { slug, filePath };
}

/**
 * Render the final `SKILL.md` — always with `name` + `description` frontmatter,
 * then the body. When the body already opened with its own `# Heading` we keep
 * it (the frontmatter is the machine-readable identity; the heading is prose).
 */
function renderSkillFile(
  name: string,
  description: string,
  body: string
): string {
  const quoteYamlScalar = (value: string): string =>
    JSON.stringify(value.replace(/[\r\n]+/g, " "));
  const frontmatter = [
    "---",
    `name: ${quoteYamlScalar(name)}`,
    `description: ${quoteYamlScalar(description || name)}`,
    "---",
  ].join("\n");
  return `${frontmatter}\n\n${body.trim()}\n`;
}

/**
 * Structured `CoachingHarnessResult` wrapper around the deterministic install,
 * so the IPC layer returns the SAME `ok/output` shape the harness path returns —
 * the renderer's install-result handling stays uniform across kinds.
 */
export function installCoachingSkillArtifact(
  draft: string,
  skillsDir: string
): CoachingHarnessResult {
  try {
    const { filePath } = installCoachingSkillFile(draft, skillsDir);
    return {
      ok: true,
      output: `Installed skill at ${filePath}`,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "nonzero_exit",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
