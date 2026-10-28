/**
 * ISS-7352: desktop-only INTERNAL gate on LOCAL PERSISTENCE of the Claude Code
 * OTel signals the OTLP receiver already decodes and ACKs.
 *
 * NO USER-FACING SURFACE RENDERS IT — not the retired Labs tab, not the
 * Settings -> General "Data Collection" privacy card. It is registered only so
 * getFlag / setFlag stay type-sound, and is reachable by editing the settings
 * record directly. The category is `"Labs"` and not `"Data Collection"` because
 * `data-collection-card.tsx` selects on category ALONE — it does not honor
 * `hiddenFromLabs`, which the three collector flags rely on to render there —
 * so that category is itself the invitation to opt in.
 *
 * Internal rather than opt-in because two questions are open, and shipping the
 * toggle would answer both by inviting users to flip it (whitlockk review; Product
 * Decision Guardrail — default-off does not leave a product question open once
 * the UI offers the choice):
 *
 * 1. Consent (ISS-7352 open question #1). Whether to keep a durable local
 *    record of a user's Claude Code telemetry is a product decision, not an
 *    implementation detail.
 * 2. Partial coverage. The component Insights latency series
 *    (`optimization-analytics-queries.ts`) reads `claude_code_api_request`, a
 *    table that has never had a writer. Capture populates a panel that is empty
 *    today — and populates it only for sessions whose Claude process got the
 *    OTel env (ones the gateway spawned), so the series would cover a SUBSET of
 *    the sessions its own denominator counts. What the panel should say about
 *    that gap is undecided.
 *
 * Give it a home and a matching category in the slice that lands those two
 * decisions. The gate is fully functional meanwhile — anyone who sets the key
 * gets the writes — and still default-off.
 *
 * Declared in this LEAF module — no imports, no registry — for the same reason
 * `desktop-docs-help-flag.ts` is: `feature-flags.ts` is not reachable from the
 * Playwright ESM loader, and IMPORT IT FROM HERE rather than from that registry,
 * which `noBarrelFile` forbids re-exporting it.
 */
export const CLAUDE_CODE_OTEL_CAPTURE_FEATURE_FLAG_KEY =
  "claudeCodeOtelCapture";
