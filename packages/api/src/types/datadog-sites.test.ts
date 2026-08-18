import { describe, expect, test } from "vitest";
import {
  DatadogSite,
  DEFAULT_DD_SITE,
  isAllowedDatadogSite,
} from "./datadog-sites";

/**
 * The authority-injection payloads this allowlist exists to reject (ISS-5417).
 *
 * Each one CONTAINS a real Datadog host, so any prefix/suffix/substring test
 * would admit it — and admitting it means `DD-API-KEY` is posted to the host on
 * the right-hand side. These are the cases that make exact whole-value
 * membership load-bearing rather than stylistic.
 */
const AUTHORITY_INJECTION_PAYLOADS = [
  "datadoghq.com@attacker.example",
  "datadoghq.com.evil.test",
  "datadoghq.com:8443",
  "datadoghq.com.",
  "evil.test/datadoghq.com",
  "sub.datadoghq.com",
  "DATADOGHQ.COM",
  " datadoghq.com",
  "datadoghq.com ",
] as const;

describe("isAllowedDatadogSite", () => {
  test.each(
    Object.entries(DatadogSite)
  )("admits the %s intake host", (_name, site) => {
    expect(isAllowedDatadogSite(site)).toBe(true);
  });

  test.each(AUTHORITY_INJECTION_PAYLOADS)("rejects %j", (payload) => {
    expect(isAllowedDatadogSite(payload)).toBe(false);
  });

  test("rejects an empty or unrelated site", () => {
    expect(isAllowedDatadogSite("")).toBe(false);
    expect(isAllowedDatadogSite("attacker.example")).toBe(false);
  });
});

describe("DEFAULT_DD_SITE", () => {
  test("is itself an allowed site", () => {
    // A default that the membership test rejects would make every caller with
    // an unset DD_SITE silently stop emitting.
    expect(isAllowedDatadogSite(DEFAULT_DD_SITE)).toBe(true);
  });

  test("is Datadog's US1 default", () => {
    expect(DEFAULT_DD_SITE).toBe(DatadogSite.Us1);
  });
});
