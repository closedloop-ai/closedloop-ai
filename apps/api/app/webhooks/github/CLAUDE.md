# GitHub Webhook Handler

> **Agents:** also read `AGENTS.md` in this directory for coding patterns, security rules, and domain conventions.

This directory processes incoming GitHub App webhook events. `route.ts` verifies
the request and dispatches by event type to one file per event in `handlers/`.

## Layout

- `route.ts` — webhook entry point and event-type dispatch
- `webhook-service.ts` — shared request/configuration helpers
- `handlers/` — event-specific handlers, including pull request, push,
  check run, deployment status, installation, issue comment, review comment,
  review, and review-thread events

## Related

- `apps/api/app/webhooks/AGENTS.md` — shared webhook rules
- `apps/api/app/webhooks/github/AGENTS.md` — GitHub-specific agent rules
- `apps/api/app/integrations/github/service.ts` — GitHub integration service
- `packages/github/` — GitHub utilities and parsers
