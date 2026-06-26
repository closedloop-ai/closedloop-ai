# Webhook Handlers — Agent Instructions

> Also see: `apps/api/AGENTS.md` for general API conventions.

This directory contains webhook handlers for all third-party integrations: `auth/` (Clerk), `github/` (GitHub App), `liveblocks/` (Liveblocks), and `slack/` (Slack slash commands).

## Critical Rules (Never Violate)

- **Read raw body as text before parsing.** Signature verification requires raw bytes. Parsing JSON first causes HMAC verification to fail. For HMAC providers that parse manually, `await request.text()` first, verify, then `JSON.parse(body)`. For SDK-managed providers such as Clerk/Svix and Liveblocks, preserve the SDK's verified event flow instead of adding a separate JSON parse.
- **Use timing-safe comparison** (`timingSafeEqual` from `node:crypto`) when comparing HMAC values. See `slack/webhook-utils.ts` for the canonical example.
- **Never leak internal error details** in HTTP responses. Log server-side; return generic `{ message: "Something went wrong", ok: false }` to callers.
- **Call `scheduleLogFlush()`** (from `@/lib/route-utils`) before every return path — success, validation failure, and the catch block. Omitting this drops structured logs when the serverless function freezes.
- **Never return 4xx/5xx for unsupported event types.** Providers interpret that as a delivery failure and retry. Return `200 OK` with `ok: true`.

## Route Structure

Each `route.ts` is a thin entry point. In order:

1. Configuration check — reject early if required env vars are absent
2. Signature verification — authenticate before touching the body
3. Event routing — dispatch to event-specific handler functions
4. Error boundary — `try/catch` wrapping the whole handler body
5. Log flush — `scheduleLogFlush()` before every return path

Business logic lives in co-located handler files (`handlers/<event>-handler.ts`), not in `route.ts`.

## Auth Patterns

### Configuration check

For providers that auto-disable on repeated auth failures (GitHub App, Liveblocks, Clerk/Svix), return `200 OK` (not `401`) when the integration is not configured. Slack is the exception — return `401` because slash commands are not retried/auto-disabled.

```typescript
if (!env.EXAMPLE_SECRET) {
  log.warn("[webhook/example] Secret not configured, rejecting request");
  scheduleLogFlush();
  return NextResponse.json({ message: "Integration not configured", ok: false });
}
```

### Signature verification

| Provider   | Signature header(s)                              | Algorithm   |
|------------|--------------------------------------------------|-------------|
| GitHub     | `x-hub-signature-256`                            | HMAC-SHA256 |
| Slack      | `x-slack-signature` + `x-slack-request-timestamp` | HMAC-SHA256 |
| Clerk/Svix | `svix-id`, `svix-timestamp`, `svix-signature`    | Svix SDK    |
| Liveblocks | request headers (via `@repo/collaboration/webhook`) | SDK-managed |

### Replay attack prevention

Reject stale requests when the provider includes a timestamp. Slack: reject requests older than 5 minutes.

## Error Handling

```typescript
} catch (error) {
  const message = parseError(error);
  log.error("[webhook/example] Unhandled error processing webhook", { error: message });
  scheduleLogFlush();
  return NextResponse.json({ message: "Something went wrong", ok: false }, { status: 500 });
}
```

For expected business errors (record not found, etc.): log at `warn`/`info`, return an appropriate response, do not let them bubble to the top-level catch.

For unsupported event types:

```typescript
default:
  log.info("[webhook/example] Ignoring unsupported event type", { eventType });
  return NextResponse.json({ message: `Ignoring event type: ${eventType}`, ok: true });
```

## Idempotency

Providers retry on timeout or non-2xx. All handlers must be safe to invoke multiple times for the same event:

- **Prefer `upsert()` over `insert()`** to avoid duplicate records on re-delivery.
- **Check current state before writing.** If the target state is already present, skip the write and return `200`.
- **Use `withDb.tx()`** for multi-step updates to prevent partial-completion inconsistency on re-delivery.
- **Never overwrite valid data with error state.** On downstream failure, leave existing records unchanged, log, and return `200`.

## Log Flushing

Use `try/finally` when there is a single success exit:

```typescript
try {
  // handler logic
  return NextResponse.json({ ok: true });
} catch (error) {
  // ...
  return NextResponse.json({ message: "Something went wrong", ok: false }, { status: 500 });
} finally {
  scheduleLogFlush();
}
```

Use explicit `scheduleLogFlush()` before each `return` when there are multiple early-exit paths.

## Logging Conventions

- `route.ts` log prefix: `[webhook/<provider>]`
- Handler file log prefix: `[<handlerFunctionName>]`
- Log key identifiers (event type, entity IDs, correlation IDs) as structured fields, not interpolated strings — this enables log-based metrics in Datadog.

```typescript
log.info("[webhook/github] Received webhook request");
log.warn("[webhook/github] Invalid signature, rejecting");
log.info("[handleInstallation] Processing event", { action, installationId });
```

## Adding a New Webhook Handler

1. Create `apps/api/app/webhooks/<provider>/`
2. Add `route.ts` following the structure above
3. Add `handlers/<event>-handler.ts` files for each event type
4. Register required env vars in `apps/api/env.ts`
5. Add a `CLAUDE.md` in the subdirectory if the handler is non-trivial
6. Write unit tests in `apps/api/__tests__/unit/webhook-<provider>*.test.ts`

## Related Files

- `apps/api/AGENTS.md` — general API conventions
- `apps/api/app/webhooks/github/CLAUDE.md` — GitHub-specific patterns
- `apps/api/lib/route-utils.ts` — `scheduleLogFlush` and response helpers
