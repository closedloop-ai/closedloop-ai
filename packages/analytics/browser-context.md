# Browser event attribution (ISS-12555)

The marketing and product root layouts pass a serializable `context` to
`AnalyticsProvider`. The first provider child installs an idempotent `before_send`
hook during render, before persistence repair or descendant feature-flag reads
can capture. The installed `@posthog/next` initializes synchronously with automatic
pageviews disabled; the integration test pins this ordering against its real
client provider. No additional SDK instance is created.

Every outgoing event receives the owning entrypoint's `surface` and `environment`
after SDK persistence and caller properties have been merged. Attribution does
not write super-properties, cookies, or person profiles. `identify` and `reset`
therefore cannot erase it, and a second site's persisted context cannot override
it. Existing URL redaction composes with this hook. Replay eligibility is unchanged.

Surface values are `marketing`, `web`, and the existing `desktop`. Only the two
browser entrypoints opt into this context; Desktop transports are unchanged.
Environment values reuse the product telemetry vocabulary: `prod` (production),
`stage` (staging), `preview`, and `local` (development). Preview deployment metadata
wins over explicit production configuration. Both surfaces use the shared
`resolveAppEnvironment` policy in `@repo/analytics/environment`; the web root passes
its existing `appEnvironment` (also used by Datadog RUM) directly. The public
`NEXT_PUBLIC_VERCEL_ENV` marker takes precedence over server `VERCEL_ENV`;
`preview` wins first, then Vercel `development` yields `local`. Otherwise explicit
`NEXT_PUBLIC_APP_ENVIRONMENT` wins, followed by the existing localhost-substring
URL check and an exact canonical-host fallback for the owning surface.
Marketing feeds that host check Vercel's production domain
(`VERCEL_PROJECT_PRODUCTION_URL`) when it runs on Vercel, and `NEXT_PUBLIC_WEB_URL`
otherwise, because web-prod sets no `NEXT_PUBLIC_APP_ENVIRONMENT` (ISS-12554). Missing or
unrecognized configuration is `stage`, never assumed production. `NODE_ENV` does
not override explicit deployment configuration; IP loopback hosts retain the app's
existing `stage` fallback. Vercel's production target alone does not distinguish
the stage project from production.

This is event-time attribution for newly captured events. Historical events remain
unchanged: analysts can use an already-redacted captured URL/hostname as a fallback.
Exact hosts `www.closedloop.ai` and `closedloop.ai` indicate marketing;
`app.closedloop.ai` indicates the web app. Unrecognized hosts or records with neither
surface nor usable URL remain unclassified; do not infer their surface from a
visitor's current profile. There is no person-property backfill.

Downstream pageview, click, and replay integrations consume this root context.
This change does not enable new marketing pageviews, button tracking, recording,
or cross-site identity/session stitching. Cross-site session continuity is
ISS-12559 (`session-correlation.md`); identity is still not stitched.
