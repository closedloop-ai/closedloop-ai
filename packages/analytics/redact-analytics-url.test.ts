import { describe, expect, it } from "vitest";
import { redactAnalyticsUrl } from "./redact-analytics-url";

/**
 * The marker and the param names are spelled as literals here on purpose. The
 * module under test derives both from `./sensitive-query-params`, so a test that
 * imported them would agree with an emptied list or an emptied marker.
 */
const MARKER = "[redacted]";
const SECRET = "9f3c-csrf-token";
const BASE = "https://app.example.com/settings/integrations/desktop/authorize";

describe("redactAnalyticsUrl", () => {
  it("redacts a percent-encoded spelling of a sensitive key", () => {
    // The ISS-8307 case. `new URL(...).searchParams.get("state")` reads this as
    // `state`, and so does the authorize route, but posthog-js's own masker
    // compares the raw segment and leaves it alone.
    expect(redactAnalyticsUrl(`${BASE}?%73tate=${SECRET}`)).toBe(
      `${BASE}?%73tate=${MARKER}`
    );
  });

  it("agrees with URLSearchParams about which key an encoded spelling is", () => {
    const encoded = `${BASE}?%73tate=${SECRET}`;

    // Not a restatement of the case above: this pins the redactor's notion of a
    // key to the FRAMEWORK's, so a spelling the route would not read as `state`
    // must not be redacted as one either.
    expect(new URL(encoded).searchParams.get("state")).toBe(SECRET);
    expect(
      new URL(`${BASE}?%2573tate=${SECRET}`).searchParams.has("state")
    ).toBe(false);
    expect(redactAnalyticsUrl(`${BASE}?%2573tate=${SECRET}`)).toBe(
      `${BASE}?%2573tate=${SECRET}`
    );
  });

  it("redacts an encoded spelling anywhere in the key, not just the first character", () => {
    expect(redactAnalyticsUrl(`${BASE}?code%5Fchallenge=${SECRET}`)).toBe(
      `${BASE}?code%5Fchallenge=${MARKER}`
    );
  });

  it("decodes a plus as the space URLSearchParams reads it as", () => {
    // No sensitive key contains a space, so this is the direction that must NOT
    // redact — a decoder that ignored `+` would agree by accident.
    const url = `${BASE}?sta+te=${SECRET}`;

    expect(new URL(url).searchParams.has("state")).toBe(false);
    expect(redactAnalyticsUrl(url)).toBe(url);
  });

  it("redacts the plainly spelled keys too", () => {
    expect(
      redactAnalyticsUrl(`${BASE}?state=${SECRET}&code_challenge=${SECRET}`)
    ).toBe(`${BASE}?state=${MARKER}&code_challenge=${MARKER}`);
  });

  it("returns an unrelated url byte-identical", () => {
    // No marker where nothing sensitive matched: an ordinary route's analytics
    // has to be indistinguishable from what it was before this module existed.
    const url = "https://app.example.com/acme/sessions?status=active&page=2";

    expect(redactAnalyticsUrl(url)).toBe(url);
  });

  it("returns a url with no query byte-identical", () => {
    const url = "https://app.example.com/acme/sessions";

    expect(redactAnalyticsUrl(url)).toBe(url);
  });

  it("emits no marker for a sensitive key carrying an empty value", () => {
    // Nothing sensitive was actually carried, so claiming a redaction happened
    // would be a lie about the data.
    const url = `${BASE}?state=&platform=darwin`;

    expect(redactAnalyticsUrl(url)).toBe(url);
  });

  it("keeps the non-sensitive params, the path and the ordering", () => {
    expect(
      redactAnalyticsUrl(
        `${BASE}?platform=darwin&state=${SECRET}&provider=github&code_challenge_method=S256`
      )
    ).toBe(
      `${BASE}?platform=darwin&state=${MARKER}&provider=github&code_challenge_method=S256`
    );
  });

  it("redacts every occurrence of a repeated sensitive key", () => {
    expect(
      redactAnalyticsUrl(`${BASE}?state=${SECRET}&state=second-${SECRET}`)
    ).toBe(`${BASE}?state=${MARKER}&state=${MARKER}`);
  });

  it("preserves the fragment and does not read it as a query", () => {
    expect(redactAnalyticsUrl(`${BASE}?state=${SECRET}#section?state=x`)).toBe(
      `${BASE}?state=${MARKER}#section?state=x`
    );
  });

  it("leaves a malformed percent escape as written instead of throwing", () => {
    const url = `${BASE}?%zztate=${SECRET}`;

    expect(redactAnalyticsUrl(url)).toBe(url);
  });

  it("keeps a bare flag param with no equals sign beside a redacted key", () => {
    // `states` minus its last char is the sensitive `state`, so a split at
    // index -1 would redact this bare param.
    expect(redactAnalyticsUrl(`${BASE}?states&state=${SECRET}`)).toBe(
      `${BASE}?states&state=${MARKER}`
    );
  });

  it("is idempotent, so a second pass adds no second marker", () => {
    const once = redactAnalyticsUrl(`${BASE}?state=${SECRET}&platform=darwin`);

    expect(redactAnalyticsUrl(once)).toBe(once);
  });

  it("redacts the signed-out detour's nested authorize url wholesale", () => {
    // `apps/app/proxy.ts` sends a signed-out desktop-authorize request here, so
    // the secrets are characters inside ONE param's value.
    const nested = encodeURIComponent(`/x/authorize?state=${SECRET}`);

    expect(
      redactAnalyticsUrl(
        `https://app.example.com/connect/github?redirect_url=${nested}`
      )
    ).toBe(`https://app.example.com/connect/github?redirect_url=${MARKER}`);
  });
});
