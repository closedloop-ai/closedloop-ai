/**
 * FEA-2717 (PLN-1290 Task 5): deep-link addressing for the session transcript
 * view. A transcript is addressed by `(sessionId, fileKey)`; `sessionId` is the
 * session-detail route and `fileKey` is a `?file=` query param selecting which
 * transcript file (the `main` conversation or a `subagent:{id}` sidechain) the
 * detail should render. QA surfaces (session detail, branch/session trace) build
 * these links so a reviewer can jump from a structured row to the raw evidence.
 *
 * SSOT for the param name + encoding on both the writing (href builder) and
 * reading (param parser) sides.
 */

import {
  type AgentComponentInvocationAnchor,
  AgentComponentInvocationAnchorKind,
} from "@repo/api/src/types/agent-component-invocation";

/** Query-param key selecting the transcript file on the session-detail route. */
export const TRANSCRIPT_FILE_PARAM = "file";

/** Query-param key selecting an exact invocation-backed transcript row. */
export const TRANSCRIPT_INVOCATION_ANCHOR_PARAM = "invocationAnchor";

/** The default transcript file — the main conversation, addressed without a param. */
export const MAIN_TRANSCRIPT_FILE_KEY = "main";

/**
 * Prefix marking a transcript file key as a subagent sidechain. Exported as the
 * SSOT for the format: `transcriptFileLabel` strips it here and
 * `buildSubagentTranscriptLabels` parses it to join a sidechain back to its
 * agent row, so a format change must land in exactly one place.
 */
export const SUBAGENT_FILE_KEY_PREFIX = "subagent:";
const MAX_ANCHOR_PARAM_CHARS = 2048;
const MAX_ANCHOR_ID_CHARS = 512;
const MAX_TIMESTAMP_ORDINAL = 1_000_000;

/** Human label for a transcript file key, for the file switcher tabs. */
export function transcriptFileLabel(fileKey: string): string {
  if (fileKey === MAIN_TRANSCRIPT_FILE_KEY) {
    return "Main";
  }
  if (fileKey.startsWith(SUBAGENT_FILE_KEY_PREFIX)) {
    return `Subagent ${fileKey.slice(SUBAGENT_FILE_KEY_PREFIX.length)}`;
  }
  return fileKey;
}

/**
 * Append the transcript-file selector to a session-detail href. `main` (the
 * default) is addressed by the bare session href — no redundant param — so the
 * canonical session link and the "main transcript" deep link are the same URL.
 * Any existing query string on `sessionHref` is preserved.
 */
export function withTranscriptFileParam(
  sessionHref: string,
  fileKey: string
): string {
  if (!fileKey || fileKey === MAIN_TRANSCRIPT_FILE_KEY) {
    return sessionHref;
  }
  const [path, existingQuery] = sessionHref.split("?", 2);
  const params = new URLSearchParams(existingQuery);
  params.set(TRANSCRIPT_FILE_PARAM, fileKey);
  return `${path}?${params.toString()}`;
}

/**
 * Add an optional invocation anchor to a session-detail href. The JSON payload
 * is URL-encoded by `URLSearchParams`; readers validate every discriminator and
 * scalar before returning it, so malformed/copied query strings are a no-op.
 */
export function withTranscriptInvocationAnchorParam(
  sessionHref: string,
  anchor: AgentComponentInvocationAnchor | null | undefined
): string {
  if (!anchor || anchor.kind === AgentComponentInvocationAnchorKind.Session) {
    return sessionHref;
  }
  const [path, existingQuery] = sessionHref.split("?", 2);
  const params = new URLSearchParams(existingQuery);
  params.set(TRANSCRIPT_INVOCATION_ANCHOR_PARAM, JSON.stringify(anchor));
  return `${path}?${params.toString()}`;
}

/** Build one transcript deep link without duplicating file/anchor URL logic. */
export function withTranscriptInvocationParams(
  sessionHref: string,
  fileKey: string,
  anchor: AgentComponentInvocationAnchor | null | undefined
): string {
  return withTranscriptInvocationAnchorParam(
    withTranscriptFileParam(sessionHref, fileKey),
    anchor
  );
}

/** A `.get`-shaped params reader — covers `URLSearchParams` and the navigation
 * port's read-only `ReadonlySearchParams` (mutators stripped) alike. */
type SearchParamsGetter = Pick<URLSearchParams, "get">;

function hasGetter(params: object): params is SearchParamsGetter {
  return typeof (params as { get?: unknown }).get === "function";
}

/**
 * Read the addressed transcript file key from route search params, defaulting to
 * the main conversation. Accepts a `.get`-shaped params object
 * (`URLSearchParams` / the navigation `ReadonlySearchParams`), a plain record
 * (Next.js server `searchParams`), or `null`/`undefined`.
 */
export function readTranscriptFileKey(
  params:
    | SearchParamsGetter
    | Record<string, string | string[] | undefined>
    | null
    | undefined
): string {
  if (!params) {
    return MAIN_TRANSCRIPT_FILE_KEY;
  }
  if (hasGetter(params)) {
    const value = params.get(TRANSCRIPT_FILE_PARAM);
    return value && value.length > 0 ? value : MAIN_TRANSCRIPT_FILE_KEY;
  }
  const raw = params[TRANSCRIPT_FILE_PARAM];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.length > 0 ? value : MAIN_TRANSCRIPT_FILE_KEY;
}

/** Safely parse an optional invocation anchor from route search params. */
export function readTranscriptInvocationAnchor(
  params:
    | SearchParamsGetter
    | Record<string, string | string[] | undefined>
    | null
    | undefined
): AgentComponentInvocationAnchor | null {
  const raw = readSearchParam(params, TRANSCRIPT_INVOCATION_ANCHOR_PARAM);
  if (!(raw && raw.length <= MAX_ANCHOR_PARAM_CHARS)) {
    return null;
  }
  try {
    return parseInvocationAnchor(JSON.parse(raw));
  } catch {
    return null;
  }
}

function readSearchParam(
  params:
    | SearchParamsGetter
    | Record<string, string | string[] | undefined>
    | null
    | undefined,
  key: string
): string | null {
  if (!params) {
    return null;
  }
  if (hasGetter(params)) {
    return params.get(key);
  }
  const raw = params[key];
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
}

function parseInvocationAnchor(
  value: unknown
): AgentComponentInvocationAnchor | null {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    return null;
  }
  const record = value as Record<string, unknown>;
  switch (record.kind) {
    case AgentComponentInvocationAnchorKind.Event:
      return parseEventAnchor(record);
    case AgentComponentInvocationAnchorKind.Agent:
      return parseAgentAnchor(record);
    case AgentComponentInvocationAnchorKind.UserTurn:
      return parseUserTurnAnchor(record);
    case AgentComponentInvocationAnchorKind.Timestamp:
      return parseTimestampAnchor(record);
    case AgentComponentInvocationAnchorKind.Session:
      return { kind: AgentComponentInvocationAnchorKind.Session };
    default:
      return null;
  }
}

function anchorId(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ANCHOR_ID_CHARS
    ? value
    : null;
}

function optionalAnchorId(value: unknown): {
  valid: boolean;
  value: string | null;
} {
  if (value === undefined) {
    return { valid: true, value: null };
  }
  const parsed = anchorId(value);
  return { valid: parsed !== null, value: parsed };
}

function parseEventAnchor(
  record: Record<string, unknown>
): AgentComponentInvocationAnchor | null {
  const eventId = anchorId(record.eventId);
  const providerToolUseId = optionalAnchorId(record.providerToolUseId);
  if (!(eventId && providerToolUseId.valid)) {
    return null;
  }
  return {
    kind: AgentComponentInvocationAnchorKind.Event,
    eventId,
    ...(providerToolUseId.value
      ? { providerToolUseId: providerToolUseId.value }
      : {}),
  };
}

function parseAgentAnchor(
  record: Record<string, unknown>
): AgentComponentInvocationAnchor | null {
  const agentId = anchorId(record.agentId);
  const externalAgentId = optionalAnchorId(record.externalAgentId);
  if (!(agentId && externalAgentId.valid)) {
    return null;
  }
  return {
    kind: AgentComponentInvocationAnchorKind.Agent,
    agentId,
    ...(externalAgentId.value
      ? { externalAgentId: externalAgentId.value }
      : {}),
  };
}

function parseUserTurnAnchor(
  record: Record<string, unknown>
): AgentComponentInvocationAnchor | null {
  const userTurnId = anchorId(record.userTurnId);
  return userTurnId
    ? { kind: AgentComponentInvocationAnchorKind.UserTurn, userTurnId }
    : null;
}

function parseTimestampAnchor(
  record: Record<string, unknown>
): AgentComponentInvocationAnchor | null {
  const timestamp = anchorId(record.timestamp);
  const ordinal = record.ordinal;
  return timestamp &&
    Number.isFinite(Date.parse(timestamp)) &&
    typeof ordinal === "number" &&
    Number.isInteger(ordinal) &&
    ordinal >= 0 &&
    ordinal <= MAX_TIMESTAMP_ORDINAL
    ? {
        kind: AgentComponentInvocationAnchorKind.Timestamp,
        timestamp,
        ordinal,
      }
    : null;
}
