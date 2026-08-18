/**
 * Anatomy of the agentic components a Pack can hold, and the assemble/parse of
 * a component's authored `content` (the `.md` file with YAML frontmatter, or the
 * JSON config) from/to editor fields.
 *
 * The kind-aware editor renders `COMPONENT_ANATOMY[kind].fields` as form inputs
 * (plus a body editor for markdown kinds); on save it assembles the canonical
 * file text, and on edit it parses that text back into fields + body. Mirrors the
 * codebase's hand-rolled frontmatter approach (see `parseSkillFrontmatter` in
 * `apps/desktop/src/main/packs/pack-scanner.ts`) rather than pulling a YAML dep.
 */

/** Component kinds a Pack holds (the container itself is kind "pack"). */
export const COMPONENT_KINDS = [
  "skill",
  "command",
  "agent",
  "hook",
  "mcp",
  "plugin",
] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

export type ComponentFieldType = "text" | "list";

export type ComponentField = {
  /** Frontmatter / config key (e.g. "allowed-tools"). */
  key: string;
  label: string;
  type: ComponentFieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
};

/** How a component's body is authored. */
export type ComponentBodyMode = "markdown" | "json" | "none";

export type ComponentAnatomy = {
  kind: ComponentKind;
  label: string;
  /** markdown → frontmatter + prompt; json → config object; none → asset-only. */
  bodyMode: ComponentBodyMode;
  bodyLabel?: string;
  /** Semantic frontmatter/config fields (beyond the always-present name + description). */
  fields: ComponentField[];
};

export const COMPONENT_ANATOMY: Record<ComponentKind, ComponentAnatomy> = {
  skill: {
    kind: "skill",
    label: "Skill",
    bodyMode: "markdown",
    bodyLabel: "SKILL.md instructions",
    fields: [
      {
        key: "allowed-tools",
        label: "Allowed tools",
        type: "list",
        placeholder: "Read, Write, Bash",
        help: "Comma-separated tools the skill may use.",
      },
    ],
  },
  command: {
    kind: "command",
    label: "Command",
    bodyMode: "markdown",
    bodyLabel: "Prompt (.md)",
    fields: [
      { key: "argument-hint", label: "Argument hint", type: "text" },
      { key: "allowed-tools", label: "Allowed tools", type: "list" },
      { key: "model", label: "Model", type: "text" },
    ],
  },
  agent: {
    kind: "agent",
    label: "Agent",
    bodyMode: "markdown",
    bodyLabel: "System prompt (.md)",
    fields: [
      { key: "tools", label: "Tools", type: "list" },
      { key: "model", label: "Model", type: "text" },
    ],
  },
  hook: {
    kind: "hook",
    label: "Hook",
    bodyMode: "json",
    bodyLabel: "Hook config (JSON)",
    fields: [
      {
        key: "event",
        label: "Event",
        type: "text",
        required: true,
        placeholder: "PreToolUse",
      },
      { key: "matcher", label: "Matcher", type: "text" },
      { key: "command", label: "Command", type: "text", required: true },
    ],
  },
  mcp: {
    kind: "mcp",
    label: "MCP",
    bodyMode: "json",
    bodyLabel: "MCP config (JSON)",
    fields: [
      { key: "command", label: "Command", type: "text", placeholder: "npx" },
      { key: "url", label: "URL", type: "text" },
      { key: "args", label: "Args", type: "list" },
    ],
  },
  plugin: {
    kind: "plugin",
    label: "Plugin",
    bodyMode: "none",
    fields: [
      { key: "version", label: "Version", type: "text", placeholder: "1.0.0" },
      { key: "author", label: "Author", type: "text" },
    ],
  },
};

/**
 * A frontmatter/config key the component's anatomy does not model, carried
 * through parse → edit → serialize untouched so editing a known field never
 * silently strips it (FEA-3164). `key` is the original (non-lowercased) key as
 * authored; `raw` is the verbatim serialized value, so an unedited key re-emits
 * byte-for-byte.
 *
 * - markdown kinds: `raw` is the text right of the first `:` on the frontmatter
 *   line (its original quoting/spacing preserved).
 * - config (JSON) kinds: `raw` is the top-level property's JSON value.
 */
export type UnknownField = {
  key: string;
  raw: string;
};

export type ComponentDraft = {
  name: string;
  description: string;
  /** Field key → raw editor string (list values are comma-separated). */
  fields: Record<string, string>;
  /** Markdown/prompt body (markdown kinds only). */
  body: string;
  /**
   * Frontmatter/config keys not modeled by the anatomy, preserved verbatim and
   * in original order so editing a known field never drops them (FEA-3164).
   */
  unknownFields: UnknownField[];
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const QUOTE_TRIGGER_RE = /[:#[\]{},&*!|>'"%@`]/;
const LINE_SPLIT_RE = /\r?\n/;

function needsQuote(value: string): boolean {
  return QUOTE_TRIGGER_RE.test(value) || value.trim() !== value;
}
function quote(value: string): string {
  return needsQuote(value) ? JSON.stringify(value) : value;
}
function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Build a config object from the always-present + kind-specific fields. */
function toConfigObject(
  anatomy: ComponentAnatomy,
  draft: ComponentDraft
): Record<string, unknown> {
  const obj: Record<string, unknown> = { name: draft.name };
  if (draft.description) {
    obj.description = draft.description;
  }
  for (const field of anatomy.fields) {
    const raw = (draft.fields[field.key] ?? "").trim();
    if (!raw) {
      continue;
    }
    obj[field.key] = field.type === "list" ? splitList(raw) : raw;
  }
  // Carry unknown config keys through untouched (FEA-3164): re-parse each
  // preserved JSON value so it round-trips as its original type, not a string.
  for (const { key, raw } of draft.unknownFields ?? []) {
    if (key in obj) {
      continue;
    }
    obj[key] = parseUnknownJsonValue(raw);
  }
  return obj;
}

/** Restore a preserved unknown config value, tolerating a non-JSON remnant. */
function parseUnknownJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Assemble a component's canonical `content` from editor state:
 * markdown → `--- frontmatter ---` + body; json/none → a config JSON object.
 */
export function assembleComponentContent(
  kind: ComponentKind,
  draft: ComponentDraft
): string {
  const anatomy = COMPONENT_ANATOMY[kind];
  if (anatomy.bodyMode === "markdown") {
    const lines: string[] = [`name: ${quote(draft.name)}`];
    if (draft.description) {
      lines.push(`description: ${quote(draft.description)}`);
    }
    const emittedKeys = new Set<string>(["name", "description"]);
    for (const field of anatomy.fields) {
      emittedKeys.add(field.key.toLowerCase());
      const raw = (draft.fields[field.key] ?? "").trim();
      if (!raw) {
        continue;
      }
      if (field.type === "list") {
        lines.push(`${field.key}: [${splitList(raw).map(quote).join(", ")}]`);
      } else {
        lines.push(`${field.key}: ${quote(raw)}`);
      }
    }
    // Re-emit unknown frontmatter keys verbatim (FEA-3164), preserving the
    // original key + raw value so an unedited key round-trips byte-for-byte.
    for (const { key, raw } of draft.unknownFields ?? []) {
      if (emittedKeys.has(key.toLowerCase())) {
        continue;
      }
      lines.push(`${key}:${raw}`);
    }
    return `---\n${lines.join("\n")}\n---\n\n${draft.body.trim()}\n`;
  }
  return `${JSON.stringify(toConfigObject(anatomy, draft), null, 2)}\n`;
}

function parseListValue(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return splitList(trimmed.slice(1, -1)).map(unquote).join(", ");
  }
  return unquote(trimmed);
}

const EMPTY_DRAFT: ComponentDraft = {
  name: "",
  description: "",
  fields: {},
  body: "",
  unknownFields: [],
};

/** One parsed frontmatter line, keeping the original key casing and raw value. */
type FrontmatterEntry = { key: string; value: string };

/**
 * Parse a frontmatter block into ordered entries, preserving each key's
 * original casing and its raw value text. Order is preserved so unknown keys
 * can be re-emitted in place (FEA-3164). Comment (`#`) and separator-less lines
 * are skipped (they carry no key to round-trip).
 */
function parseFrontmatterBlock(block: string): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  for (const rawLine of block.split(LINE_SPLIT_RE)) {
    const line = rawLine.trim();
    const sep = line.indexOf(":");
    if (!line || line.startsWith("#") || sep < 0) {
      continue;
    }
    entries.push({
      key: line.slice(0, sep).trim(),
      value: line.slice(sep + 1),
    });
  }
  return entries;
}

function parseMarkdownContent(
  anatomy: ComponentAnatomy,
  content: string
): ComponentDraft {
  const match = content.match(FRONTMATTER_RE);
  const entries = match ? parseFrontmatterBlock(match[1]) : [];
  const body = match ? content.slice(match[0].length) : content;
  // Case-insensitively dedupe the parsed lines so a key appears once. A later
  // occurrence's raw value wins (last-occurrence-wins, matching the prior
  // `fm[key] = value` reduce this rewrite replaced), while the first
  // occurrence's authored casing and position are kept — so both known-field
  // lookup and the unknown-field passthrough see a single, stable entry per
  // key. Re-setting an existing Map key leaves its insertion order intact, so
  // updating `raw` on a duplicate does not move it. (FEA-3164)
  const byLowerKey = new Map<string, UnknownField>();
  for (const entry of entries) {
    const lower = entry.key.toLowerCase();
    const existing = byLowerKey.get(lower);
    byLowerKey.set(lower, {
      key: existing?.key ?? entry.key,
      raw: entry.value,
    });
  }
  const knownKeys = new Set<string>([
    "name",
    "description",
    ...anatomy.fields.map((field) => field.key.toLowerCase()),
  ]);
  const fields: Record<string, string> = {};
  for (const field of anatomy.fields) {
    const entry = byLowerKey.get(field.key.toLowerCase());
    if (entry !== undefined) {
      fields[field.key] =
        field.type === "list" ? parseListValue(entry.raw) : unquote(entry.raw);
    }
  }
  const unknownFields: UnknownField[] = [...byLowerKey.values()]
    .filter((entry) => !knownKeys.has(entry.key.toLowerCase()))
    .map((entry) => ({ key: entry.key, raw: entry.raw }));
  const nameEntry = byLowerKey.get("name");
  const descriptionEntry = byLowerKey.get("description");
  return {
    name: nameEntry ? unquote(nameEntry.raw) : "",
    description: descriptionEntry ? unquote(descriptionEntry.raw) : "",
    fields,
    body: body.trim(),
    unknownFields,
  };
}

/**
 * Result of a tolerant parse attempt. `ok: false` means the raw content could
 * not be parsed (invalid JSON for a config kind) — callers that must not lose a
 * user's edits should surface an error rather than fall back to an empty draft.
 */
export type ParseComponentResult =
  | { ok: true; draft: ComponentDraft }
  | { ok: false };

function tryParseConfigContent(
  anatomy: ComponentAnatomy,
  content: string
): ParseComponentResult {
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const field of anatomy.fields) {
      const value = obj[field.key];
      if (Array.isArray(value)) {
        fields[field.key] = value.join(", ");
      } else if (value != null) {
        fields[field.key] = String(value);
      }
    }
    const knownKeys = new Set<string>([
      "name",
      "description",
      ...anatomy.fields.map((field) => field.key),
    ]);
    // Preserve any top-level config keys the anatomy doesn't model (FEA-3164),
    // in their original order, serialized back verbatim on assemble.
    const unknownFields: UnknownField[] = Object.keys(obj)
      .filter((key) => !knownKeys.has(key))
      .map((key) => ({ key, raw: JSON.stringify(obj[key]) }));
    return {
      ok: true,
      draft: {
        name: typeof obj.name === "string" ? obj.name : "",
        description: typeof obj.description === "string" ? obj.description : "",
        fields,
        body: "",
        unknownFields,
      },
    };
  } catch {
    return { ok: false };
  }
}

/**
 * Parse a component's stored `content` back into editor state, reporting parse
 * failure instead of silently discarding it. Markdown kinds always succeed
 * (frontmatter parsing is tolerant); config (JSON) kinds fail on invalid JSON.
 */
export function tryParseComponentContent(
  kind: ComponentKind,
  content: string | null | undefined
): ParseComponentResult {
  if (!content) {
    return { ok: true, draft: { ...EMPTY_DRAFT } };
  }
  const anatomy = COMPONENT_ANATOMY[kind];
  return anatomy.bodyMode === "markdown"
    ? { ok: true, draft: parseMarkdownContent(anatomy, content) }
    : tryParseConfigContent(anatomy, content);
}

/**
 * Parse a component's stored `content` back into editor state. Tolerant of
 * hand-authored files: unknown frontmatter keys are dropped, missing fields
 * default to empty, and unparseable config content yields an empty draft.
 */
export function parseComponentContent(
  kind: ComponentKind,
  content: string | null | undefined
): ComponentDraft {
  const result = tryParseComponentContent(kind, content);
  return result.ok ? result.draft : { ...EMPTY_DRAFT };
}
