# Webhook Handlers — Agent Instructions

> Also see: `apps/api/AGENTS.md` for general API conventions.

Webhook handlers for all third-party integrations: `auth/` (Clerk), `github/` (GitHub App), `liveblocks/` (Liveblocks), and `slack/` (Slack slash commands). Route files are thin HTTP entry points; provider-specific business logic belongs in co-located handler modules such as `github/handlers/*`.

## Critical Rules (Never Violate)

- **Read raw body as text before parsing.** Signature verification requires raw bytes. Parsing JSON first causes HMAC verification to fail. For HMAC providers that parse manually, `await request.text()` first, verify, then `JSON.parse(body)`. For SDK-managed providers such as Clerk/Svix and Liveblocks, preserve the SDK's verified event flow instead of adding a separate JSON parse. GitHub's `github/webhook-service.ts` (`isGitHubConfigured()`, `validateRequest()`) is the worked example — `validateRequest()` calls `request.text()` before any JSON parsing.
- **Use timing-safe comparison** (`timingSafeEqual` from `node:crypto`) when comparing HMAC values. See `slack/webhook-utils.ts` for the canonical example.
- **Never leak internal error details** in HTTP responses. Log server-side; return generic `{ message: "Something went wrong", ok: false }` to callers.
- **Call `scheduleLogFlush()`** (from `@/lib/route-utils`) before every return path — success, validation failure, and the catch block. Omitting this drops structured logs when the serverless function freezes. Use `try/finally` when there is a single success exit; use an explicit call before each `return` when there are multiple early-exit paths.
- **Never return 4xx/5xx for unsupported event types.** Providers interpret that as a delivery failure and retry. Return `200 OK` with `ok: true` and one terminal info log carrying `outcome: "unsupported_event"`.
- **Never use nested `withDb()` transaction parameters.** `withDb()` and `withDb.tx()` use `AsyncLocalStorage`; inner calls automatically join the outer transaction. Do not thread a `tx` parameter through handler signatures.

## Route Structure

`route.ts` order: config check → signature verify → dispatch → `try/catch` around the whole handler body → `scheduleLogFlush()` before every return path. Business logic lives in `handlers/<event>-handler.ts`, not in `route.ts`.

## Auth Patterns

**Unconfigured integration.** Return `200 OK` for auto-disabling providers (GitHub App, Liveblocks, Clerk/Svix); `401` for Slack, which is not retried or auto-disabled.

**Signature verification.** Per-provider headers and algorithms: `docs/runbooks/webhook-signature-verification.md`.

**Replay attack prevention.** Reject stale requests when the provider includes a timestamp. Slack: reject requests older than 5 minutes.

## Error Handling

On error: log server-side, return generic `{ message, ok: false }` + `scheduleLogFlush()`. Expected business errors (record not found, etc.) log at `warn`/`info`, return an appropriate response, and never reach the top-level catch.

## Idempotency

Providers retry on timeout or non-2xx. All handlers must be safe to invoke multiple times for the same event:

- **Prefer `upsert()` over `insert()`** to avoid duplicate records on re-delivery.
- **Check current state before writing.** If the target state is already present, skip the write and return `200`.
- **Use `withDb.tx()`** for multi-step updates to prevent partial-completion inconsistency on re-delivery.
- **Never overwrite valid data with error state.** On downstream failure, leave existing records unchanged, log, and return `200`.

## Logging Conventions

Log prefixes: `[webhook/<provider>]` in `route.ts`, `[<handlerFunctionName>]` in handlers. Log key identifiers (event type, entity IDs, correlation IDs) as structured fields, not interpolated strings — this enables log-based metrics in Datadog. Emit one terminal structured `outcome` log per request; no received/validating/processing narration at info. GitHub's exact strings are `[webhook/github] Completed webhook handling` (route) and `[handleCheckRun] Completed check_run webhook handling` (check_run handler).

## Adding a New Webhook Handler

New provider: `<provider>/route.ts` plus `handlers/<event>-handler.ts` (one file per event type, a single named export, dispatched from the `switch` in `route.ts`); register required env vars in `apps/api/env.ts`; write unit tests in `apps/api/__tests__/unit/webhook-<provider>*.test.ts`. Add an `AGENTS.md` (plus a `@AGENTS.md` `CLAUDE.md` shim) in the subdirectory only when the handler carries rules this file does not.

## Tests

Assert the production wiring, not only the helper. A handler test that calls the reconciler directly proves nothing about whether the webhook dispatches it for the intended action set — add caller-level assertions, including the fail-open completion behavior.
