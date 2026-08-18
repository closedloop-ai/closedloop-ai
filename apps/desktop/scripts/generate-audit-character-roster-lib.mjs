// @ts-check
/**
 * ISS-5303 — the pure parsing half of
 * `scripts/generate-audit-character-roster.mjs`.
 *
 * The generator entrypoint is a top-level side-effecting script: importing it
 * walks `resources/audit-characters/**`, renders the module and either writes
 * the committed roster or exits 1. Nothing inside it can be asserted directly,
 * so every derivation it performs — markdown stripping, first-sentence
 * trimming, shouty-word calming, label/description parsing, tag and group
 * derivation — was unreachable from a test.
 *
 * These helpers are pure: string in, string (or `{ label, description }`) out.
 * They live here so `test/audit-character-roster-lib.test.ts` can drive them
 * against synthetic prompt text, while the entrypoint keeps the filesystem
 * walk, the TS rendering and its three-way write / `--check` / up-to-date
 * decision. Extraction only — no behaviour changed (FEA-4013 semantics are
 * pinned by `test/audit-character-roster.test.ts` and the generator's own
 * `--check` mode, which `pnpm verify:audit-roster` runs).
 */

/**
 * `# Name — description` heading form (top-level core characters + a few
 * nightly ones). Accepts an em-dash or hyphen separator.
 */
const HEADING_RE = /^#\s+(.+?)\s+[—-]\s+(.+)$/;
/** `You are [**]Name[**], <description clause>…` prose form (most nightly ones). */
const YOU_ARE_RE = /^You are\s+\*{0,2}([^,*]+?)\*{0,2},\s*(.+)$/;
/** A capitalized-word start used to sanity-check a parsed label. */
const LABEL_START_RE = /^[A-Z0-9]/;
/** `**bold**` emphasis markers, stripped from a scraped first line. */
const BOLD_MARKER_RE = /\*\*/g;
/** `` `code` `` markers, stripped from a scraped first line. */
const CODE_MARKER_RE = /`/g;
/** The role-clause boilerplate every character prompt repeats, trimmed off. */
const REPO_BOILERPLATE_RE =
  /\s+(?:for|across|in)\s+the\s+symphony-alpha\s+monorepo\b.*$/i;
/** A trailing em-dash / parenthetical aside — scraped noise, not a description. */
const TRAILING_ASIDE_RE = /\s*[—-]\s.*$/;
const TRAILING_PAREN_RE = /\s*\([^)]*\)\s*$/;
/**
 * All-caps emphasis words the prose SHOUTS ("across BOTH the web app…"). Only
 * these are calmed to lower-case — a blanket all-caps rule would wrongly
 * lower-case legitimate acronyms (API, SDK, IPC, UI, UX, MCP, DBA, …) that read
 * correctly upper-cased in a description.
 */
const SHOUTY_WORDS = new Set([
  "ALL",
  "ALWAYS",
  "BOTH",
  "EVERY",
  "NEVER",
  "NOT",
  "ONLY",
  "STRICTLY",
]);
/** Any all-caps run, matched so {@link SHOUTY_WORDS} membership can be checked. */
const ALL_CAPS_WORD_RE = /\b[A-Z]{2,}\b/g;
/** Word separators in an author folder slug, split to title-case a heading. */
const SLUG_WORD_SEP_RE = /[-_]/;
/** A path separator, replaced with `-` to derive a flat filing tag. */
const PATH_SEP_RE = /\//g;
/** Trailing whitespace / punctuation, trimmed before re-adding a single period. */
const TRAILING_PUNCT_RE = /[.\s]+$/;

/**
 * Friendly display names for the known author folders. A folder not listed here
 * falls back to a title-cased slug via {@link groupLabelFor}, so a brand-new
 * author folder renders an intentional-looking heading rather than a raw slug
 * that reads like a bug (FEA-4013 review). Emitted per-entry as `groupLabel` so
 * the renderer consumes ONE derived source instead of a parallel hand-kept map.
 */
const GROUP_LABELS = {
  core: "Core",
  chrisc: "Chris C",
  danielochoa: "Daniel Ochoa",
  kaitic: "Kai Tic",
  mikeangstadt: "Mike Angstadt",
  peteru: "Pete U",
  thadeusb: "Thadeus B",
};

/**
 * Strip the light markdown (`**bold**`, `` `code` ``) a first line can carry.
 *
 * @param {string} value
 * @returns {string}
 */
export function stripInlineMarkdown(value) {
  return value.replace(BOLD_MARKER_RE, "").replace(CODE_MARKER_RE, "").trim();
}

/**
 * The first non-blank line of a prompt file (its title/opening sentence).
 *
 * @param {string} raw
 * @returns {string}
 */
export function firstNonBlankLine(raw) {
  for (const line of raw.split("\n")) {
    if (line.trim().length > 0) {
      return line.trim();
    }
  }
  return "";
}

/**
 * Trim a long clause to its first sentence when that sentence is substantial.
 *
 * @param {string} value
 * @returns {string}
 */
export function firstSentence(value) {
  const dot = value.indexOf(". ");
  if (dot > 40) {
    return value.slice(0, dot + 1);
  }
  return value;
}

/**
 * Lower-case only shouted emphasis words ("BOTH" → "both"); keep acronyms.
 *
 * @param {string} value
 * @returns {string}
 */
export function calmShoutyWords(value) {
  return value.replace(ALL_CAPS_WORD_RE, (word) =>
    SHOUTY_WORDS.has(word) ? word.toLowerCase() : word
  );
}

/**
 * Upper-case the first character so a clause reads as a sentence.
 *
 * @param {string} value
 * @returns {string}
 */
export function capitalizeFirst(value) {
  return value.length > 0
    ? value.charAt(0).toUpperCase() + value.slice(1)
    : value;
}

/**
 * Turn a scraped opening clause into a short, sentence-cased picker description.
 * The prompt files open with `You are X, the <role> for the symphony-alpha
 * monorepo — <aside> (<parenthetical>).`; rendering that verbatim gave the
 * picker lowercase, run-on, dual-voice copy (FEA-4013 review). We keep the role
 * clause, drop the repeated repo boilerplate and any em-dash/parenthetical
 * aside, calm shouty emphasis words, and sentence-case the result so every
 * derived entry reads like the curated core-4 one-liners.
 *
 * @param {string} clause
 * @returns {string}
 */
export function cleanDescription(clause) {
  const trimmed = firstSentence(stripInlineMarkdown(clause))
    .replace(REPO_BOILERPLATE_RE, "")
    .replace(TRAILING_ASIDE_RE, "")
    .replace(TRAILING_PAREN_RE, "")
    .replace(TRAILING_PUNCT_RE, "")
    .trim();
  const cleaned = capitalizeFirst(calmShoutyWords(trimmed));
  return cleaned.length > 0 ? `${cleaned}.` : cleaned;
}

/**
 * Derive `{ label, description }` from a character prompt's opening line. Falls
 * back to the raw first line so an unrecognized format still yields a usable
 * (if plain) picker entry rather than throwing.
 *
 * @param {string} raw Full prompt-file contents.
 * @param {string} id Character id (path relative to the characters dir, no `.md`).
 * @returns {{ label: string, description: string }}
 */
export function parseLabelAndDescription(raw, id) {
  const first = firstNonBlankLine(raw);
  const heading = first.match(HEADING_RE);
  if (heading?.[1] && LABEL_START_RE.test(stripInlineMarkdown(heading[1]))) {
    return {
      label: stripInlineMarkdown(heading[1]),
      description: cleanDescription(heading[2]),
    };
  }
  const youAre = first.match(YOU_ARE_RE);
  if (youAre?.[1] && LABEL_START_RE.test(stripInlineMarkdown(youAre[1]))) {
    return {
      label: stripInlineMarkdown(youAre[1]),
      description: cleanDescription(youAre[2]),
    };
  }
  // Last resort: title-case the id's basename for the label, first line as desc.
  const base = id.split("/").pop() ?? id;
  const label = base
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  return { label, description: cleanDescription(first) };
}

/**
 * The ClosedLoop filing tag for a character. A filed issue is attributed by this
 * tag, so it MUST be unique per character. Two characters can share a basename
 * across author folders (a core `docs-darwin` and a nightly `kaitic/docs-darwin`),
 * and a basename-only tag would file both under `agent-docs-darwin` — colliding
 * attribution and collapsing the per-character dedup guard (FEA-4013 review).
 *
 * Top-level (`core`) ids keep their legacy `agent-<basename>` tag — the shipped,
 * back-referenced tags the M3 filing path already uses. A nested id derives from
 * its full path (`agent-<author>-<basename>`, e.g. `agent-kaitic-docs-darwin`) so
 * it can never collide with a top-level tag or another author's same-named
 * character.
 *
 * @param {string} id
 * @returns {string}
 */
export function tagForId(id) {
  return `agent-${id.replace(PATH_SEP_RE, "-")}`;
}

/**
 * The picker group for a character. Files in an author subfolder group under
 * that author; top-level files group under `core`.
 *
 * @param {string} id
 * @returns {string}
 */
export function groupForId(id) {
  const slash = id.indexOf("/");
  return slash === -1 ? "core" : id.slice(0, slash);
}

/**
 * The human heading for a picker group — friendly name, else title-cased slug.
 *
 * @param {string} group
 * @returns {string}
 */
export function groupLabelFor(group) {
  if (Object.hasOwn(GROUP_LABELS, group)) {
    return GROUP_LABELS[group];
  }
  return group
    .split(SLUG_WORD_SEP_RE)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}
