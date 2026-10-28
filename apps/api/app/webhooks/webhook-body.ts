import { NextResponse } from "next/server";
import {
  logRequestBodyOverCap,
  readCappedRequestText,
} from "@/lib/route-utils";

/**
 * Per-provider request body ceilings for the four webhook receivers.
 *
 * These four cannot take `parseBody`'s default (ISS-7565): the HMAC is computed
 * over the raw body, so the read has to precede verification and the caller is
 * anonymous until it succeeds. Each bound is therefore sized from what the
 * provider can actually send, since a cap that refuses a real delivery loses
 * the event — the provider retries, then gives up, and nothing surfaces.
 *
 * No p99 exists to size against: nothing in the request path records a body
 * size (checked 2026-08-22 — cl-api's Vercel/Datadog logs carry no
 * `content-length`, and `packages/telemetry-contract` has no request-size
 * field). Each value below is derived from measured payload composition plus
 * the provider's own transport ceiling.
 */

/**
 * Sized from the transport ceiling, not from measured traffic. GitHub's own
 * envelope is 25 MB, but this route runs as a Vercel Function, and Vercel
 * refuses a request body over 4.5 MB with a platform `413
 * FUNCTION_PAYLOAD_TOO_LARGE` before the handler is invoked
 * (https://vercel.com/docs/functions/limitations#request-body-size) — so no
 * delivery above that ever reaches this code, with or without a cap here.
 * 4.5 MiB is at or above 4.5 MB under either MB/MiB reading, which makes this
 * bound provably incapable of refusing a delivery the platform admitted; a
 * tighter one would refuse real events in the band the platform still passes.
 *
 * For scale, the payloads themselves are nowhere near it: the worst `push`
 * reconstructible from 400 real commits of this repo's first-parent history is
 * ~265 KiB (20-commit `commits[]` + `head_commit`, dominated by
 * `added`/`removed`/`modified` path lists), and the largest measured
 * `pull_request` payload is ~35 KiB (PR 26.7 KiB + repository 7.6 KiB +
 * sender).
 */
export const GITHUB_WEBHOOK_MAX_BYTES = 4_718_592;

/**
 * Clerk delivers through Svix, whose documented message payload ceiling is
 * 1 MiB — so this bound provably cannot refuse a legitimate Clerk delivery.
 * The largest event actually observed on `/webhooks/auth` (30d to 2026-08-22,
 * 1,409 events) is `email.created`, which carries a rendered email body; the
 * rest are `session.created` and user/organization objects in the low KiB.
 */
export const CLERK_WEBHOOK_MAX_BYTES = 1_048_576;

/**
 * Slash-command bodies are `application/x-www-form-urlencoded` over a fixed
 * field set (`command`, `text`, `team_id`, `user_id`, `channel_id`, …) plus the
 * `url_verification` challenge. Only `text` varies, and it is bounded by
 * Slack's 4,000-character message limit: ~16 KiB as UTF-8, ~48 KiB after
 * percent-encoding worst case. 256 KiB is >5x that.
 */
export const SLACK_WEBHOOK_MAX_BYTES = 262_144;

/**
 * Liveblocks thread/comment events carry an ID envelope only — the handlers in
 * `liveblocks/handlers.ts` read `roomId`/`threadId`/`commentId`/`createdBy`/
 * `updatedAt`/`updatedBy` and lazy-fetch the content through the Liveblocks API
 * client. Real payloads are ~1 KiB; 64 KiB is ~64x headroom.
 */
export const LIVEBLOCKS_WEBHOOK_MAX_BYTES = 65_536;

/**
 * The envelope every webhook receiver already answers errors in — `{ message,
 * ok: false }`, not the `ApiResult` `{ success, error }` the rest of the API
 * uses (`webhooks/AGENTS.md`). The cap path is still a webhook error, so it
 * speaks the webhook envelope; a caller parsing these routes must not get a
 * different shape on one status.
 */
export type WebhookErrorBody = { message: string; ok: false };

export type WebhookBodyResult =
  | { body: string; response: null }
  | { body: null; response: NextResponse<WebhookErrorBody> };

/**
 * Read a webhook body under a byte cap, streaming, so an anonymous caller
 * cannot make the process buffer past `maxBytes` before the signature is
 * checked. Returns the raw text unmodified — the HMAC is computed over these
 * exact bytes, so nothing here may re-serialize or normalize them.
 *
 * Over-cap emits `REQUEST_BODY_OVER_CAP_EVENT` (via `logRequestBodyOverCap`,
 * which also flushes) and answers 413. 413 rather than a silent 200 is
 * deliberate: every one of these providers records a non-2xx as a failed
 * delivery its own console shows, whereas accept-and-dead-letter would have to
 * buffer the very payload the cap is refusing to buffer.
 */
export async function readVerifiableWebhookBody(
  request: Request,
  maxBytes: number
): Promise<WebhookBodyResult> {
  const result = await readCappedRequestText(request, maxBytes);
  if (!result.ok) {
    logRequestBodyOverCap(request, maxBytes);
    return {
      body: null,
      response: NextResponse.json(
        { message: "Request body too large", ok: false },
        { status: 413 }
      ),
    };
  }
  return { body: result.value, response: null };
}
