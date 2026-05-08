export type Pattern = {
  id: string;
  category: string;
  summary: string;
  confidence: string;
  seen_count: number;
  success_rate: number;
  flags: string[];
  applies_to: string[];
  context: string[];
};

const TOON_HEADER_REGEX = /^patterns\[\d+\]\{(.+)\}:$/;

function splitToonValues(line: string): string[] {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      values.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  values.push(current.trim());
  return values;
}

function convertField(field: string, raw: string): unknown {
  switch (field) {
    case "seen_count":
      return Number.parseInt(raw, 10) || 0;
    case "success_rate":
      return Number.parseFloat(raw) || 0;
    case "flags": {
      const matches = Array.from(raw.matchAll(/\[([^\]]+)\]/g));
      return matches.length > 0 ? matches.map((m) => m[1]) : [];
    }
    case "applies_to":
    case "context":
      return raw ? raw.split("|") : [];
    default:
      return raw;
  }
}

export function parseToonRow(line: string, fields: string[]): Pattern | null {
  const values = splitToonValues(line);
  if (values.length < fields.length) {
    return null;
  }

  const obj: Record<string, unknown> = {};
  for (const [i, field] of fields.entries()) {
    obj[field] = convertField(field, values[i] ?? "");
  }

  obj.id ??= "";
  obj.category ??= "";
  obj.summary ??= "";
  obj.confidence ??= "";
  obj.seen_count ??= 0;
  obj.success_rate ??= 0;
  obj.flags ??= [];
  obj.applies_to ??= [];
  obj.context ??= [];

  return obj as unknown as Pattern;
}

export function parseToon(content: string): Pattern[] {
  const lines = content.split("\n");
  const patterns: Pattern[] = [];
  let fields: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimEnd();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    // Match header declaration: patterns[N]{field1,field2,...}:
    const headerMatch = TOON_HEADER_REGEX.exec(trimmed);
    if (headerMatch) {
      fields = headerMatch[1].split(",").map((f) => f.trim());
      continue;
    }

    // Data rows start with 2 spaces
    if (line.startsWith("  ") && fields.length > 0) {
      const parsed = parseToonRow(trimmed, fields);
      if (parsed) {
        patterns.push(parsed);
      }
    }
  }

  return patterns;
}
