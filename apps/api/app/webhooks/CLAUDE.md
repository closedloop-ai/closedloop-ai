# Webhook Handlers

> **Agents:** also read `AGENTS.md` in this directory for coding patterns, security rules, and domain conventions.

This directory contains webhook handlers for third-party integrations:
`auth/` (Clerk), `github/` (GitHub App), `liveblocks/` (Liveblocks), and
`slack/` (Slack slash commands).

## Directory Structure

```text
webhooks/
|-- AGENTS.md                 # agent-facing webhook rules
|-- CLAUDE.md                 # this orientation file
|-- auth/
|   `-- route.ts              # Clerk user/org lifecycle events
|-- github/
|   |-- AGENTS.md             # GitHub-specific agent rules
|   |-- CLAUDE.md             # GitHub handler orientation
|   `-- route.ts
|-- liveblocks/
|   `-- route.ts              # Liveblocks thread/comment events
`-- slack/
    `-- route.ts              # Slack slash commands
```

Route files are thin HTTP entry points. Provider-specific business logic belongs
in co-located handler modules such as `github/handlers/*`.

## Related

- `apps/api/AGENTS.md` — general API conventions
- `apps/api/app/webhooks/AGENTS.md` — shared webhook rules
- `apps/api/app/webhooks/github/CLAUDE.md` — GitHub webhook orientation
