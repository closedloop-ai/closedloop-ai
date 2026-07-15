import type { CategoryCounters } from "@repo/database/scripts/cleanup-preview-schemas-lib";
import { log } from "@repo/observability/log";
import { z } from "zod";
import { env } from "@/env";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SLACK_CHANNEL_ID = "C0A86M2KAG6";
const SLACK_API_URL = "https://slack.com/api/chat.postMessage";
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 1000;

/**
 * Slack application-level error codes (returned in an HTTP 200 body with
 * `ok: false`) that represent transient failures worth one retry. HTTP-layer
 * 429/5xx are detected separately in `postToSlack`.
 */
const RETRYABLE_SLACK_API_ERRORS: ReadonlySet<string> = new Set([
  "ratelimited",
  "service_unavailable",
  "fatal_error",
  "internal_error",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NotifySlackOpts = {
  /** Short identifier for the route posting the alert, e.g. "cleanup-preview-schemas:daily". */
  route: string;
  /** Human-readable summary of the failure. */
  message: string;
  /** Structured error counters used to build the per-category error summary. */
  counters?: CategoryCounters;
  /** Datadog-pivotable correlation identifier. Derive via `buildCorrelationId()`. */
  correlationId: string;
};

const slackApiResponseSchema = z.object({
  ok: z.boolean(),
  ts: z.string().optional(),
  channel: z.string().optional(),
  error: z.string().optional(),
});

type SlackApiResponse = z.infer<typeof slackApiResponseSchema>;

type PostToSlackResult = SlackApiResponse & {
  /**
   * True when the failure is transient (HTTP 429 / 5xx or a transient
   * app-level error such as `ratelimited` / `service_unavailable`) and a
   * single retry may succeed.
   */
  retryable?: boolean;
};

// ---------------------------------------------------------------------------
// buildAlertText — message formatter
// ---------------------------------------------------------------------------

/**
 * Builds the mrkdwn alert body from structured inputs.
 *
 * Pure function — reads no environment variables and produces no side effects.
 *
 * Includes:
 * - Route name for triage
 * - Per-category error summary for any category with errored > 0
 * - Datadog correlation identifier passed in via `opts.correlationId`
 */
export function buildAlertText(opts: NotifySlackOpts): string {
  const { route, message, counters, correlationId } = opts;

  const lines: string[] = [
    `*Preview schema cleanup failure* — route: \`${route}\``,
    message,
  ];

  if (counters) {
    const categoryKeys = [
      "ttl-expired",
      "orphan",
      "orphan-branch",
      "pr-closed",
    ] as const;

    const erroredCategories: string[] = [];
    for (const key of categoryKeys) {
      const bucket = counters[key];
      if (bucket.errored > 0) {
        erroredCategories.push(`errored=${bucket.errored} in ${key}`);
      }
    }

    if (counters.registryReadErrored > 0) {
      erroredCategories.push(
        `errored=${counters.registryReadErrored} in registry-read`
      );
    }

    if (erroredCategories.length > 0) {
      lines.push(`*Errors:* ${erroredCategories.join(", ")}`);
    }
  }

  lines.push(`*Correlation:* ${correlationId}`);

  return lines.join("\n");
}

/**
 * Returns a Datadog-pivotable correlation identifier.
 * Uses Vercel deployment identifiers when available; falls back to timestamp.
 */
export function buildCorrelationId(): string {
  const deploymentId = process.env.VERCEL_DEPLOYMENT_ID;
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA;

  if (deploymentId) {
    const sha = commitSha ? ` sha=${commitSha.slice(0, 8)}` : "";
    return `deployment=${deploymentId}${sha}`;
  }

  if (commitSha) {
    return `sha=${commitSha.slice(0, 8)}`;
  }

  return `ts=${new Date().toISOString()}`;
}

// ---------------------------------------------------------------------------
// postToSlack — core fetch wrapper (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Posts a single message to `chat.postMessage`.
 * Never throws — always resolves with an ok/error result.
 *
 * NOTE: This intentionally restates the slim core of `postSlackMessage` in
 * `scripts/deploy/slack-post.ts`. The two cannot share code today: that module
 * is a Node CLI deploy script (its own tsconfig, `node:fs/promises`, a relative
 * `./utils.ts` `isDryRun`), whereas this is a Next.js API leaf module. If a
 * third caller appears, extract a shared `@repo/slack` `chat.postMessage` core;
 * until then the wire contract is small and stable enough to keep local.
 */
export function postToSlack(
  botToken: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<PostToSlackResult> {
  return postToSlackChannel(botToken, SLACK_CHANNEL_ID, text, fetchImpl);
}

/**
 * Per-channel variant of `postToSlack` — posts to an explicit `channel` rather
 * than the global ops-channel constant. Used to deliver engagement messages to
 * an org's connected workspace (`SlackIntegration.defaultChannelId`) instead of
 * the single hardcoded ops channel.
 *
 * Shares `postToSlack`'s exact wire contract, timeout, and retryable-error
 * semantics; never throws — always resolves with an ok/error result.
 */
export async function postToSlackChannel(
  botToken: string,
  channel: string,
  text: string,
  fetchImpl: typeof fetch = fetch
): Promise<PostToSlackResult> {
  try {
    const response = await fetchImpl(SLACK_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ channel, text }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // Slack reports rate limits and server-side failures at the HTTP layer
    // (429 / 5xx), frequently with a non-JSON body. Detect these before parsing
    // so the retry path actually engages — a 5xx HTML body would otherwise fall
    // through as an opaque parse error and never be retried.
    if (response.status === 429 || response.status >= 500) {
      return { ok: false, error: `http_${response.status}`, retryable: true };
    }

    const parsed = slackApiResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return { ok: false, error: "invalid_slack_response" };
    }

    // Slack can also surface transient failures as application-level errors
    // (HTTP 200 body with ok:false), e.g. ratelimited / service_unavailable.
    const retryable =
      parsed.data.error !== undefined &&
      RETRYABLE_SLACK_API_ERRORS.has(parsed.data.error);
    return { ...parsed.data, retryable };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// notifySlack — public entry point
// ---------------------------------------------------------------------------

/**
 * Posts a Slack alert to channel C0A86M2KAG6 on preview-schema cleanup failures.
 *
 * Semantics:
 * - Fire-and-forget: returns void
 * - Fail-soft: Slack API errors are logged at `error` level but do NOT throw
 * - One retry on transient failures (HTTP 429/5xx or transient app-level errors)
 * - Gracefully no-ops (logs a warning and returns) if SLACK_BOT_TOKEN is absent
 */
export async function notifySlack(opts: NotifySlackOpts): Promise<void> {
  const botToken = env.SLACK_BOT_TOKEN;

  if (!botToken) {
    log.warn("notifySlack: SLACK_BOT_TOKEN is not set — skipping Slack alert", {
      route: opts.route,
    });
    return;
  }

  const text = buildAlertText(opts);

  let result = await postToSlack(botToken, text);

  if (!result.ok && result.retryable) {
    await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    result = await postToSlack(botToken, text);
  }

  if (!result.ok) {
    log.error("notifySlack: Slack chat.postMessage failed", {
      route: opts.route,
      slackError: result.error ?? "unknown",
    });
  }
}
