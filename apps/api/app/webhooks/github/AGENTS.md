# GitHub Webhook Handler — Agent Instructions

> Also see: `apps/api/app/webhooks/AGENTS.md` for shared webhook conventions.

## Layout

- `route.ts` — signature verification (`x-hub-signature-256` HMAC-SHA256), event-type dispatch, early return when GitHub is not configured.
- `webhook-service.ts` — shared utilities: `isGitHubConfigured()`, `validateRequest()`.
- `handlers/` — one file per GitHub event type (`pull_request`, `push`, `check_run`, `deployment_status`, `installation`, `issue_comment`, and the PR review/review-comment/review-thread handlers).

## Critical Rules

- **Signature verification reads raw body first.** `validateRequest()` calls `request.text()` before any JSON parsing. Parsing first causes HMAC verification to fail on providers that compute the HMAC over the raw payload.
- **Never use nested `withDb()` transaction parameters.** `withDb()` and `withDb.tx()` use `AsyncLocalStorage`; inner calls automatically join the outer transaction. Do not thread a `tx` parameter through handler signatures.
- **Return `200 OK` (not `401`) when GitHub is not configured.** GitHub App auto-disables endpoints on repeated auth failures; returning a non-2xx for the not-configured case triggers that. See shared webhook conventions for the pattern.

## Adding a New GitHub Event Handler

1. Create `handlers/<event>-handler.ts` — one file per event type.
2. Export a single named handler function.
3. Dispatch to it from the `switch` in `route.ts`.
4. Write unit tests in `apps/api/__tests__/unit/webhook-github-<event>.test.ts`.

## Tests

Unit tests cover every handler. Run with:

```bash
pnpm turbo test --filter=api -- --grep webhook
```

## Related Files

- `apps/api/app/webhooks/AGENTS.md` — shared webhook conventions (critical rules, idempotency, log flushing)
- `apps/api/app/webhooks/github/CLAUDE.md` — human-oriented handler docs
- `apps/api/app/integrations/github/service.ts` — GitHub integration service
- `packages/github/` — GitHub utilities and parsers
- `packages/api/src/types/artifact.ts` — artifact types
- `packages/database/prisma/schema.prisma` — `GitHubPullRequest` model
