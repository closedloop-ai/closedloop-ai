# Cross-site session correlation (ISS-12559)

Marketing (`apps/web`: `www.closedloop.ai`, `closedloop.ai`, `marketing.closedloop.ai`)
and the web app (`apps/app`: `app.closedloop.ai`) send to the same PostHog project
with the same key. Every browser event carries the capture-time `surface` and
`environment` described in `browser-context.md`. This page covers how one visitor's
activity on both sites lands in one `$session_id`, and how to report on it.

## Why sessions split, and the fix

posthog-js persists with `localStorage+cookie` (`@posthog/next` default). It writes
`distinct_id`, `$device_id`, `$user_state`, `$sesid` and a few other keys to a cookie
named `ph_<token>_posthog`. Everything else stays in that origin's own localStorage.
`cross_subdomain_cookie` defaults to true on these hosts, so the cookie is set for
`domain=.closedloop.ai` and both sites can read it. Two things in posthog-js 1.359.1
(the copy `@posthog/next@0.1.0` initializes) stopped that cookie from carrying the
session:

1. `createLocalPlusCookieStore._parse` (`src/storage.ts`) loads
   `extend(cookie, localStorageRecord)`, so this origin's localStorage `$sesid` wins
   over the shared cookie. If this site was last visited more than 30 minutes ago,
   that record is idle, and `SessionIdManager` starts a new session on the first
   event. The persistence constructor then saves that new session over the shared
   cookie, which breaks the other direction as well.
2. On the first request that carries no PostHog cookie, `@posthog/next`'s
   `postHogMiddleware` (run by `apps/app/proxy.ts`) sets a host-only cookie on
   `app.closedloop.ai` with the same name. posthog-js always writes the domain
   cookie and never rewrites this one. `cookieStore._get` returns the first match in
   `document.cookie`. Both cookies have `path=/`, so the browser lists the older one
   first (RFC 6265 §5.4), which is the frozen seed.

`PostHogSharedSessionGuard` (`posthog-shared-session-guard.tsx`, logic in
`posthog-shared-session.ts`) is mounted by `AnalyticsProvider` on both sites as the
sibling rendered before `<PostHogProvider>`. During render, before `posthog.init`,
it collects this origin's `$sesid` and the `$sesid` of every same-name cookie. It
writes the one with the latest activity time into the origin's record. A
`$client_session_props` that names a different session is dropped with it, so events
in the resumed session do not carry another session's entry URL.

What `$session_entry_*` the resumed session then carries on this site depends on the
tab's history, because posthog-js only records entry props when `SessionIdManager`
reports a change:

- **This origin's first page load in the tab.** sessionStorage holds no window id for
  this origin, so posthog-js mints one and fires its session callback.
  `SessionPropsManager` then records **this site's landing page** as the entry, not the
  other site's page where the session really began.
- **The tab has loaded this origin before.** The window id survives in sessionStorage,
  the callback does not fire, and events here carry **no** `$session_entry_*`.

Neither branch records the session's true entry, because that page lives in the other
origin's storage. **One merged session can therefore carry two different
`$session_entry_*` values, one from each site**, so do not group or filter a
cross-site session by `$session_entry_url`. For the real entry URL, use the first event of the session (PostHog's
session table derives it that way). The integration suites pin both branches: the
marketing suite has no window id, the app suite does.

Only `$sesid` moves. Identity keys load exactly as before:

- Each site keeps the `distinct_id` it would have loaded without the guard.
- `identify` keeps the session.
- `reset()` on sign-out still starts a new anonymous id and a new session.
- No alias or merge is issued (see `posthog-alias-refusal.pin.test.ts`).

So one session can carry an anonymous marketing `distinct_id` and an identified app
`distinct_id`. Session-level reporting does not depend on `distinct_id`. When
consent is denied, the guard writes nothing. It reads consent the way posthog-js's
`ConsentManager` does under `@posthog/next`'s cookie consent persistence: the
`__ph_opt_in_out_<token>` cookie decides, and localStorage is consulted only when
that cookie is absent. If `document.cookie` or localStorage cannot be read, the guard
does nothing and posthog-js starts as it always did.

Why not posthog-js's public `bootstrap.sessionID`:

- It is read from the init options. `@posthog/next`'s server `PostHogProvider` builds
  those in a Server Component, which cannot see this browser's cookies or localStorage
  (marketing pages are also static).
- `SessionIdManager` stamps a bootstrapped session's activity as now. That would revive
  an idle session instead of letting it expire.
Desktop does not mount `AnalyticsProvider` and is unchanged.

Evidence: the `posthog-shared-session.{marketing,app}.integration` suites resume the
shared session through the real `ClientPostHogProvider`. The matching
`.counterfactual` suites remove only the guard and reproduce the split.

## Session boundaries

- **Idle:** 30 minutes without activity starts a new session. This is posthog-js
  `DEFAULT_SESSION_IDLE_TIMEOUT_SECONDS`, and neither site overrides it. A hop between
  sites continues the session only when the latest activity on either site is under
  30 minutes old.
- **Maximum length:** 24 hours from session start (`SESSION_LENGTH_LIMIT_MILLISECONDS`).
- **Sign-out:** `reset()` ends the session. **Sign-in** (`identify`) does not.
  `reset()` clears both cookies and writes a cleared `$sesid` (`[null, null, null]`)
  to this origin and to the domain cookie, so the next page load anywhere starts a
  new session.
- **Cleared local session:** posthog-js also writes the cleared tuple from its idle
  timer, about 33 minutes after the last activity in a background tab. The guard
  reads a cleared local `$sesid` as "no local session" and continues the latest
  domain-cookie session that is still active. Example: a marketing tab idles in the
  background while the app stays active; reloading marketing continues the app's
  session. An idle cookie session is never adopted, and that includes a stale
  host-only seed.
- **Cookie scope:** sessions continue across `*.closedloop.ai`. Preview deployments
  on `*.vercel.app` (a public suffix) and `localhost` get host-only cookies, so they
  never share a session across sites. Any other `*.closedloop.ai` host using the same
  key also shares the cookie. That is why `environment` is a separate parameter
  below.
- **Already-open tabs:** posthog-js reads storage only when it initializes. A tab
  that was already open keeps its own session until its next page load. Continuity
  applies to page loads after this change. There is no historical backfill.

## Reporting semantics

- **Session key:** `$session_id`. A session qualifies through its own events. It is
  never qualified through the visitor, the person, or a marketing visit in another
  session.
- **Reporting window:** a session belongs to `[window_start, window_end)` when its
  first event falls inside the window. All of its events are reported, including
  activity after `window_end`, so events are scanned from `window_start - 24h` to
  `window_end + 24h`.
- **Environment:** a separate parameter. It decides which marketing visits qualify a
  session (`properties.environment = <env>`). It does not hide other events of a
  qualifying session, and the `environment` column shows each event's value. To run
  across all environments, delete the environment predicate.
- **Surface values:** `marketing`, `web`, `desktop`. Anything else, and a missing
  value, is **unknown**. This includes server-side events that join the session
  through tracing headers and carry no surface.
  - An unknown event never qualifies a session. Qualification requires
    `surface = 'marketing'`.
  - In query (b), an unknown event keeps a session from being marketing-only unless
    its `$host` is a marketing host. Without a surface or a marketing host, the
    session cannot be proven marketing-only, so it is left out.
  - Both queries list unknown events with `surface = 'unknown'`.

Replace the literal dates and `'prod'` in both queries. The three hosts in (b) are
the production marketing hosts. A non-production run needs that environment's
marketing hosts.

### (a) All activity in sessions with a marketing visit

```sql
SELECT
    e.$session_id AS session_id,
    e.timestamp AS timestamp,
    e.event AS event,
    coalesce(e.properties.surface, 'unknown') AS surface,
    e.properties.environment AS environment,
    e.properties.$host AS host,
    e.properties.$pathname AS pathname,
    e.distinct_id AS distinct_id
FROM events AS e
WHERE e.timestamp >= toDateTime('2026-10-01 00:00:00') - INTERVAL 24 HOUR
    AND e.timestamp < toDateTime('2026-10-20 00:00:00') + INTERVAL 24 HOUR
    AND e.$session_id IN (
        SELECT $session_id
        FROM events
        WHERE timestamp >= toDateTime('2026-10-01 00:00:00') - INTERVAL 24 HOUR
            AND timestamp < toDateTime('2026-10-20 00:00:00') + INTERVAL 24 HOUR
            AND coalesce($session_id, '') != ''
        GROUP BY $session_id
        HAVING countIf(properties.surface = 'marketing' AND properties.environment = 'prod') > 0
            AND min(timestamp) >= toDateTime('2026-10-01 00:00:00')
            AND min(timestamp) < toDateTime('2026-10-20 00:00:00')
    )
ORDER BY session_id, timestamp
```

### (b) Marketing-only sessions

```sql
SELECT
    e.$session_id AS session_id,
    e.timestamp AS timestamp,
    e.event AS event,
    coalesce(e.properties.surface, 'unknown') AS surface,
    e.properties.environment AS environment,
    e.properties.$host AS host,
    e.properties.$pathname AS pathname,
    e.distinct_id AS distinct_id
FROM events AS e
WHERE e.timestamp >= toDateTime('2026-10-01 00:00:00') - INTERVAL 24 HOUR
    AND e.timestamp < toDateTime('2026-10-20 00:00:00') + INTERVAL 24 HOUR
    AND e.$session_id IN (
        SELECT $session_id
        FROM events
        WHERE timestamp >= toDateTime('2026-10-01 00:00:00') - INTERVAL 24 HOUR
            AND timestamp < toDateTime('2026-10-20 00:00:00') + INTERVAL 24 HOUR
            AND coalesce($session_id, '') != ''
        GROUP BY $session_id
        HAVING countIf(properties.surface = 'marketing' AND properties.environment = 'prod') > 0
            AND countIf(properties.surface IN ('web', 'desktop')) = 0
            AND countIf(
                coalesce(properties.surface, '') NOT IN ('marketing', 'web', 'desktop')
                AND coalesce(properties.$host, '') NOT IN ('www.closedloop.ai', 'closedloop.ai', 'marketing.closedloop.ai')
            ) = 0
            AND min(timestamp) >= toDateTime('2026-10-01 00:00:00')
            AND min(timestamp) < toDateTime('2026-10-20 00:00:00')
    )
ORDER BY session_id, timestamp
```

### Test matrix

Every session starts inside the window. The visitor in S5 and S6 is the same.
"Click" is a captured button click (`$autocapture` or the marketing click event).

| Session | Events in the session (surface, environment) | (a) prod | (b) prod |
| --- | --- | --- | --- |
| S1 marketing-only | marketing pageview, marketing click (prod) | all 2 events | all 2 events |
| S2 marketing→web | marketing pageview, web pageview, web click (prod) | all 3 events | excluded |
| S3 web→marketing | web pageview, web click, marketing pageview (prod) | all 3 events | excluded |
| S4 web-only | web pageview, web click (prod) | excluded | excluded |
| S5 same visitor, session 1 | marketing pageview (prod) | 1 event | 1 event |
| S6 same visitor, session 2 | web pageview, web click (prod), 2h after S5 | excluded | excluded |
| S7 environment | marketing pageview, marketing click (stage) | excluded (included with `'stage'`) | excluded (included with `'stage'`) |
| S8 unknown, app host | marketing pageview (prod); no-surface event on `app.closedloop.ai` | both events, second as `unknown` | excluded |
| S9 unknown, marketing host | marketing pageview (prod); no-surface event on `www.closedloop.ai` | both events | both events |
| S10 unknown only | no-surface pageview on `www.closedloop.ai` | excluded | excluded |

S5/S6: a marketing visit in another session never qualifies a web-only session.

### Actual results

These are aggregates observed on production project 341818, posted on
[PR #8911](https://github.com/closedloop-ai/closedloop-ai/pull/8911#issuecomment-6270753529).
They are not a seeded run of each scenario in the matrix above. Both queries ran over
`[2026-10-01, 2026-10-20)`:

| Query | `environment` | Sessions | Events | By surface |
| --- | --- | --- | --- | --- |
| (a) all activity in sessions with a marketing visit | `stage` | 42 | 123 | 121 marketing, 2 web |
| (b) marketing-only sessions | `stage` | 41 | 116 | 116 marketing |
| (a) and (b) | `prod` | 0 | 0 | — |

The `prod` result is 0 because production marketing events were labelled `stage`
until #8903 deploys. The gap between (a) and (b) is 1 session and 7 events (5
marketing, 2 web). That is consistent with (b) excluding one whole mixed session,
the one holding the 2 web events. This difference is derived arithmetic; it was not
queried separately.
