/**
 * ISS-8950 Property 3 — one feature, two predicates, and they disagreed.
 *
 * `buildConnectSrc` opened GA's hosts on plain truthiness of
 * `NEXT_PUBLIC_GA_MEASUREMENT_ID`, while `AnalyticsProvider` mounts
 * `<GoogleAnalytics>` only when `isValidGaMeasurementId` passes. Production ran
 * with both hosts in `connect-src` and no `gtag` anywhere in the document: the
 * policy was opened for a feature that never loads. The symmetric failure is
 * the dangerous one — a shape the mount accepts but the allowlist does not
 * would, under enforcement, kill telemetry silently.
 *
 * These cases live in their own file because the delegation half needs a module
 * mock, and the 430-line sibling suite deliberately mocks nothing.
 */

import { describe, expect, it, vi } from "vitest";
import { buildConnectSrc } from "../content-security-policy";

// The placeholder shape `packages/analytics/keys.ts` names and `keys.test.ts`
// pins as invalid: `G-` prefixed, so the env schema accepts it, but hyphenated,
// so the mount predicate rejects it.
const PLACEHOLDER_GA_ID = "G-placeholder-GAID";
const VALID_GA_ID = "G-TEST123";
// Written out, never read back out of the module under test.
const GA_COLLECT_SOURCE = "https://www.google-analytics.com/";
const GA_MEASUREMENT_PROTOCOL_SOURCE = "https://www.google.com";
const PROD_API_URL = "https://api.closedloop.ai";

const gaPredicate = vi.hoisted(() => ({
  forced: undefined as boolean | undefined,
}));

// Wraps the REAL predicate so the value cases below exercise production
// behavior, and only the two delegation cases override it. An override that the
// policy ignores is the signature of a re-derived local copy — which is the
// SSOT failure this ticket's acceptance criterion ("governed by a single
// predicate") exists to prevent, and which no value-based case can detect.
vi.mock("@repo/analytics/keys", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@repo/analytics/keys")>();
  return {
    ...actual,
    isValidGaMeasurementId: (value: string | undefined) =>
      gaPredicate.forced ?? actual.isValidGaMeasurementId(value),
  };
});

function connectSrcFor(gaMeasurementId: string | undefined): string[] {
  return buildConnectSrc({
    apiUrl: PROD_API_URL,
    environment: "prod",
    gaMeasurementId,
    electronHostnames: [],
  });
}

describe("GA connect-src allowlisting (ISS-8950 Property 3)", () => {
  it("omits GA's hosts for a placeholder ID that GA would never mount under", () => {
    const sources = connectSrcFor(PLACEHOLDER_GA_ID);

    expect(sources).not.toContain(GA_COLLECT_SOURCE);
    expect(sources).not.toContain(GA_MEASUREMENT_PROTOCOL_SOURCE);
  });

  it("includes GA's hosts for an ID that GA does mount under", () => {
    const sources = connectSrcFor(VALID_GA_ID);

    expect(sources).toContain(GA_COLLECT_SOURCE);
    expect(sources).toContain(GA_MEASUREMENT_PROTOCOL_SOURCE);
  });
});

describe("the allowlist delegates to the mount predicate, not a copy of it", () => {
  it("closes the hosts when the shared predicate rejects an otherwise-valid ID", () => {
    gaPredicate.forced = false;
    try {
      expect(connectSrcFor(VALID_GA_ID)).not.toContain(GA_COLLECT_SOURCE);
    } finally {
      gaPredicate.forced = undefined;
    }
  });

  it("opens the hosts when the shared predicate accepts an otherwise-invalid ID", () => {
    gaPredicate.forced = true;
    try {
      expect(connectSrcFor(PLACEHOLDER_GA_ID)).toContain(GA_COLLECT_SOURCE);
    } finally {
      gaPredicate.forced = undefined;
    }
  });
});
