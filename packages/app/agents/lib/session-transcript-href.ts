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

/** Query-param key selecting the transcript file on the session-detail route. */
export const TRANSCRIPT_FILE_PARAM = "file";

/** The default transcript file — the main conversation, addressed without a param. */
export const MAIN_TRANSCRIPT_FILE_KEY = "main";

const SUBAGENT_FILE_KEY_PREFIX = "subagent:";

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
