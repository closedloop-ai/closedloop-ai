# Relay Integration Contracts

Last updated: 2026-02-27 (synced with Desktop DG artifacts from `/Users/daniel.ochoa/Source/closedloop-electron/docs/artifacts/desktop-gateway-contracts.md`)

## Tier Routing Decision Table

| Tier | Mode ID | Activation condition | Browser request target | Server path involved | Primary use |
| --- | --- | --- | --- | --- | --- |
| Tier 1 | `local-dev` | App host is localhost and no selected compute target relay header | `/api/engineer/*` on `apps/app` | Existing `apps/app` engineer route handlers | Primary local development path |
| Tier 2 | `local-electron` | Electron probe returns `{ status: "ok" }` on localhost ports 19432-19435 | `http://localhost:{detectedPort}/api/engineer/*` | `apps/app`/`apps/api` bypassed | Primary same-machine engineering path |
| Tier 3 | `cloud-relay` | Electron probe fails and selected cloud compute target is online | `/api/engineer/*` on `apps/app`, relayed to API-origin compute-target endpoints | `apps/app` relay client + `apps/api` compute-target relay routes | Cross-device fallback path |

## Browser Fetch Rewrite Rules

1. Install one global `window.fetch` wrapper in engineer shell.
2. Match requests where pathname starts with `/api/engineer/`.
3. If active mode is `local-electron`, rewrite origin only to `http://localhost:{detectedPort}`.
4. Preserve method, query string, body, credentials mode, and non-auth headers.
5. Remove `Authorization` and `Cookie` headers on localhost rewrites.
6. If active mode is `cloud-relay`, rewrite `/api/engineer/*` to `/api/engineer-relay/*` on app origin and inject `X-Compute-Target: {id}`.
7. If active mode is `local-dev`, pass request through unchanged.
8. Non-engineer routes are never rewritten.

## Relay Stream Framing Rules

1. Browser-facing streaming payloads must remain NDJSON lines (`{...}\n`).
2. Tier 2 localhost responses may keep `Content-Type: text/event-stream` but body format stays NDJSON (no SSE `data:` prefix).
3. Tier 3 internal transport (`apps/api`) may use SSE (`data: ...\n\n`) between relay participants.
4. `apps/app` must transcode Tier 3 stream events back to NDJSON before returning to browser.
5. Existing stream consumers (`readChatStream` and similar line parsers) remain unchanged.
6. One-shot responses remain JSON payloads matching existing route contracts.

## Desktop Contract Sync Inputs

- Source of truth: `/Users/daniel.ochoa/Source/closedloop-electron/docs/artifacts/desktop-gateway-contracts.md`
- `DG-001`: `/health` response identity fields (`status`, `machineName`, `capabilities`, `version`, `port`) and CORS headers
- `DG-002`: port fallback behavior (`19432 -> 19433 -> 19434 -> 19435`) + discovery file
- `DG-003`: registration + heartbeat payload/envelope, plus desktop retry/backoff semantics
- `DG-004`: operation parity matrix (finalized in Desktop artifact; all mapped engineer routes implemented natively)

R0-R5 can run with contract fixtures; R6 requires final validation against DG artifacts.

## Relay Replay Limits (R2)

- Pending operation backlog per target: max `200` operations (oldest dropped first).
- Result replay buffer per operation: max `500` events.
- Result replay retention TTL: `10` minutes since last event.
- SSE keepalive interval: `15s`; max stream lifetime: `30` minutes (client reconnect required).
