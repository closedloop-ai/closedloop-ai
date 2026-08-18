/**
 * @file usage-api-client.ts
 * @description PRD-538 R5 (ISS-5353). Desktop-main client for the owned
 * subscription usage endpoint: `GET https://api.anthropic.com/api/oauth/usage`
 * — the exact request Claude Code's interactive `/usage` command issues.
 *
 * ── What this returns, and what it is NOT ─────────────────────────────────────
 * The endpoint returns SERVER-COMPUTED utilization percentages (0–100) plus
 * reset timestamps, per window. That number is NOT derivable from local token
 * counts, and PRD-538 names estimating it from tokens an explicit NON-GOAL
 * because the result would be fabricated. Nothing in this module reads, sums, or
 * infers from transcript token counts; an unresolvable window stays `null`
 * (unknown) and the renderer hides it.
 *
 * ── Endpoint contract (verified against the shipped CLI, v2.1.x) ──────────────
 * The CLI's own `fetchUtilization` issues `GET /api/oauth/usage` with a 5s
 * timeout and a JSON content type, and treats the body as an in-band error
 * unless it carries at least one of these top-level keys:
 *   five_hour · seven_day · seven_day_oauth_apps · seven_day_opus ·
 *   seven_day_sonnet · cinder_cove · extra_usage · limits
 * We apply the same "at least one known window key" test — a 200 whose body has
 * none of them is an error envelope, not a zero-usage account, and must degrade
 * to unavailable rather than render as 0%.
 *
 * Each window is `{ utilization, resets_at }` where `resets_at` is an ISO string
 * on some windows and epoch SECONDS on others (the CLI branches on
 * `typeof resets_at === "number"`); both are normalized to ISO here.
 *
 * ── Version skew ──────────────────────────────────────────────────────────────
 * The response validator is deliberately NON-strict and every field is optional
 * and nullable. A newly added window, a renamed field, or an entirely unknown
 * body shape degrades to "unavailable" — never a throw, never a fabricated 0%,
 * and never a crash that could block startup (AGENTS.md cross-repo rule).
 *
 * ── Secret handling ───────────────────────────────────────────────────────────
 * The access token is placed in the `Authorization` header and nowhere else. It
 * is never logged, never put in a thrown error, never written into the returned
 * snapshot, and never persisted. Response bodies are NOT echoed into errors
 * either: this client returns a coarse failure reason rather than vendor text,
 * so nothing from the wire can reach a log or an IPC reply.
 */
import { z } from "zod";

import type { SessionLimitsSnapshot } from "../../shared/session-limits-channel.js";
import { requireHttps } from "../util/require-https.js";
import { mapUtilizationResponse } from "./utilization.js";

/** Host the usage client is permitted to contact. */
export const USAGE_API_HOST = "api.anthropic.com";

/** The owned usage endpoint — the same path the shipped CLI's `/usage` calls. */
export const USAGE_API_URL = `https://${USAGE_API_HOST}/api/oauth/usage`;

/** Request deadline. Matches the CLI's own 5s budget for this call. */
export const USAGE_API_TIMEOUT_MS = 5000;

/**
 * Top-level keys that mark a body as a real usage payload. Mirrors the shipped
 * CLI's own list; a 200 carrying none of them is an in-band error envelope.
 */
const USAGE_PAYLOAD_KEYS: readonly string[] = [
  "five_hour",
  "seven_day",
  "seven_day_oauth_apps",
  "seven_day_opus",
  "seven_day_sonnet",
  "cinder_cove",
  "extra_usage",
  "limits",
];

/**
 * One usage window. Non-strict by design (see the version-skew note): unknown
 * sibling keys pass through untouched and are simply not read.
 */
const usageWindowValidator = z
  .object({
    utilization: z.number().finite().nullish(),
    resets_at: z.union([z.string(), z.number()]).nullish(),
  })
  .nullish();

/**
 * The `/usage` response. Every field optional — a plan exposes only the windows
 * it has, and an unknown future window must not invalidate the known ones.
 */
const usageResponseValidator = z.object({
  five_hour: usageWindowValidator,
  seven_day: usageWindowValidator,
  seven_day_opus: usageWindowValidator,
  seven_day_sonnet: usageWindowValidator,
  extra_usage: z
    .object({
      is_enabled: z.boolean().nullish(),
      monthly_limit: z.number().finite().nullish(),
      used_credits: z.number().finite().nullish(),
      utilization: z.number().finite().nullish(),
    })
    .nullish(),
});

/**
 * Why a capture attempt produced no snapshot. Coarse and closed by design — it
 * carries no vendor text and no credential-derived detail, so it is safe to log
 * and safe to surface. `unauthorized` and `no_credential` are distinct because
 * only the former means "we had a credential and the server rejected it".
 */
export const UsageFetchFailure = {
  /** No readable subscription credential — the feature is hidden, not broken. */
  NoCredential: "no_credential",
  /** Server rejected the credential (401/403) — token expired or revoked. */
  Unauthorized: "unauthorized",
  /** Transport failure, timeout, or abort. */
  Network: "network",
  /** Non-2xx that is not an auth rejection. */
  HttpError: "http_error",
  /** 200 whose body is not a recognizable usage payload (in-band error/skew). */
  UnrecognizedShape: "unrecognized_shape",
} as const;
export type UsageFetchFailure =
  (typeof UsageFetchFailure)[keyof typeof UsageFetchFailure];

/** Outcome of one capture attempt. Never throws; never carries a secret. */
export type UsageFetchResult =
  | { ok: true; snapshot: SessionLimitsSnapshot }
  | { ok: false; reason: UsageFetchFailure };

/** Minimal fetch surface, injected so tests need no network. */
export type UsageFetchResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};
export type UsageFetchLike = (
  url: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
    signal?: AbortSignal;
    redirect: "error";
  }
) => Promise<UsageFetchResponse>;

export type UsageApiClientDeps = {
  /** Resolves the OAuth access token, or null when there is no credential. */
  readAccessToken: () => string | null;
  /** HTTP transport (defaults to global fetch). */
  fetchImpl?: UsageFetchLike;
  /** ISO timestamp stamped onto the snapshot as its capture time. */
  nowIso: () => string;
  /** Request deadline override (tests). */
  timeoutMs?: number;
};

/**
 * Default transport: adapts the global `fetch` to {@link UsageFetchLike} by
 * projecting only the three fields this client reads. Written as an adapter
 * rather than a cast so the structural contract is checked by the compiler.
 */
const DEFAULT_USAGE_FETCH: UsageFetchLike = async (url, init) => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  };
};

/** True when the parsed body carries at least one recognized usage key. */
function looksLikeUsagePayload(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  return USAGE_PAYLOAD_KEYS.some((key) => key in body);
}

/**
 * Fetch and map the current utilization snapshot.
 *
 * Resolves a discriminated result rather than throwing, so no caller can turn a
 * capture failure into an unhandled rejection that blocks startup.
 */
export async function fetchUsageSnapshot(
  deps: UsageApiClientDeps
): Promise<UsageFetchResult> {
  const accessToken = deps.readAccessToken();
  if (accessToken === null) {
    return { ok: false, reason: UsageFetchFailure.NoCredential };
  }

  // Belt-and-braces: the URL is a module constant, but this pins the guarantee
  // that the bearer token can only ever leave the machine toward this host.
  requireHttps(USAGE_API_URL, "Usage API URL");

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? USAGE_API_TIMEOUT_MS
  );

  try {
    const fetchImpl = deps.fetchImpl ?? DEFAULT_USAGE_FETCH;
    const response = await fetchImpl(USAGE_API_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      // A 3xx must never carry the bearer token to another origin.
      redirect: "error",
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: UsageFetchFailure.Unauthorized };
    }
    if (!response.ok) {
      return { ok: false, reason: UsageFetchFailure.HttpError };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: UsageFetchFailure.UnrecognizedShape };
    }
    if (!looksLikeUsagePayload(body)) {
      return { ok: false, reason: UsageFetchFailure.UnrecognizedShape };
    }

    const parsed = usageResponseValidator.safeParse(body);
    if (!parsed.success) {
      return { ok: false, reason: UsageFetchFailure.UnrecognizedShape };
    }

    return {
      ok: true,
      snapshot: mapUtilizationResponse(parsed.data, deps.nowIso()),
    };
  } catch {
    // Covers abort/timeout, DNS/TLS failure, and a blocked cross-origin
    // redirect. No error detail is propagated — it could quote the request.
    return { ok: false, reason: UsageFetchFailure.Network };
  } finally {
    clearTimeout(timer);
  }
}
