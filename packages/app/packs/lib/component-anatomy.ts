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

export type ComponentDraft = {
  name: string;
  description: string;
  /** Field key → raw editor string (list values are comma-separated). */
  fields: Record<string, string>;
  /** Markdown/prompt body (markdown kinds only). */
  body: string;
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
  return obj;
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
    for (const field of anatomy.fields) {
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
};

/** Parse a frontmatter block into a lowercased key → raw-value map. */
function parseFrontmatterBlock(block: string): Record<string, string> {
  const fm: Record<string, string> = {};
  for (const rawLine of block.split(LINE_SPLIT_RE)) {
    const line = rawLine.trim();
    const sep = line.indexOf(":");
    if (!line || line.startsWith("#") || sep < 0) {
      continue;
    }
    fm[line.slice(0, sep).trim().toLowerCase()] = line.slice(sep + 1);
  }
  return fm;
}

function parseMarkdownContent(
  anatomy: ComponentAnatomy,
  content: string
): ComponentDraft {
  const match = content.match(FRONTMATTER_RE);
  const fm = match ? parseFrontmatterBlock(match[1]) : {};
  const body = match ? content.slice(match[0].length) : content;
  const fields: Record<string, string> = {};
  for (const field of anatomy.fields) {
    const raw = fm[field.key];
    if (raw !== undefined) {
      fields[field.key] =
        field.type === "list" ? parseListValue(raw) : unquote(raw);
    }
  }
  return {
    name: fm.name ? unquote(fm.name) : "",
    description: fm.description ? unquote(fm.description) : "",
    fields,
    body: body.trim(),
  };
}

function parseConfigContent(
  anatomy: ComponentAnatomy,
  content: string
): ComponentDraft {
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
    return {
      name: typeof obj.name === "string" ? obj.name : "",
      description: typeof obj.description === "string" ? obj.description : "",
      fields,
      body: "",
    };
  } catch {
    return { ...EMPTY_DRAFT };
  }
}

/**
 * Parse a component's stored `content` back into editor state. Tolerant of
 * hand-authored files: unknown frontmatter keys are dropped, missing fields
 * default to empty.
 */
export function parseComponentContent(
  kind: ComponentKind,
  content: string | null | undefined
): ComponentDraft {
  if (!content) {
    return { ...EMPTY_DRAFT };
  }
  const anatomy = COMPONENT_ANATOMY[kind];
  return anatomy.bodyMode === "markdown"
    ? parseMarkdownContent(anatomy, content)
    : parseConfigContent(anatomy, content);
}
