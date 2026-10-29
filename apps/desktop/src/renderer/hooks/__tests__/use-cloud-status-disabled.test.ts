/**
 * ISS-10903: the `disabled` arm of `parseCloudStatus`, which the sibling
 * `use-cloud-status.test.ts` never enters — it covers idle/online/degraded and
 * the skew folds around them.
 *
 * `disabled` is the one state that carries a REASON the user reads, and the
 * reason arrives over a version-skewed boundary: an older or newer main process
 * can omit it, send a non-string, or send whitespace. None of those may reach
 * the surface as the reason, because a blank sentence under a "cloud is off"
 * heading reads as a rendering bug rather than as a setting. The fold supplies
 * its own default instead, and these cases drive each malformed shape.
 *
 * Both directions are asserted: a genuine reason is PRESERVED verbatim in the
 * same file that proves a malformed one is replaced, so a fold that always
 * returned the default would fail here as loudly as one that never did.
 */

import { describe, expect, it } from "vitest";
import { CloudStatusKind, parseCloudStatus } from "../use-cloud-status";

const DEFAULT_DISABLED_REASON = "Cloud connection is off";
const DEFAULT_CONNECTION_ERROR = "Cloud connection failed";
const REAL_REASON = "Cloud connection is off for this workspace";

describe("parseCloudStatus — the disabled reason", () => {
  it("preserves a reason the main process actually sent", () => {
    expect(
      parseCloudStatus({
        cloudStatus: { state: "disabled", reason: REAL_REASON },
      })
    ).toEqual({ kind: CloudStatusKind.Disabled, reason: REAL_REASON });
  });

  it("supplies its own reason when the field is absent entirely", () => {
    expect(parseCloudStatus({ cloudStatus: { state: "disabled" } })).toEqual({
      kind: CloudStatusKind.Disabled,
      reason: DEFAULT_DISABLED_REASON,
    });
  });

  it("supplies its own reason for a blank or whitespace-only one", () => {
    expect(
      parseCloudStatus({ cloudStatus: { state: "disabled", reason: "" } })
    ).toEqual({
      kind: CloudStatusKind.Disabled,
      reason: DEFAULT_DISABLED_REASON,
    });
    expect(
      parseCloudStatus({ cloudStatus: { state: "disabled", reason: "   " } })
    ).toEqual({
      kind: CloudStatusKind.Disabled,
      reason: DEFAULT_DISABLED_REASON,
    });
  });

  it("supplies its own reason when a skewed peer sends a non-string", () => {
    for (const reason of [42, null, { message: "off" }, ["off"], true]) {
      expect(
        parseCloudStatus({ cloudStatus: { state: "disabled", reason } })
      ).toEqual({
        kind: CloudStatusKind.Disabled,
        reason: DEFAULT_DISABLED_REASON,
      });
    }
  });

  it("keeps a reason whose surrounding whitespace is incidental", () => {
    // Only a value that is EMPTY once trimmed is replaced; a padded real
    // sentence is still the peer's reason and is passed through as sent.
    expect(
      parseCloudStatus({
        cloudStatus: { state: "disabled", reason: `  ${REAL_REASON}  ` },
      })
    ).toEqual({
      kind: CloudStatusKind.Disabled,
      reason: `  ${REAL_REASON}  `,
    });
  });

  it("stays disabled rather than folding to unknown or to a fault", () => {
    const parsed = parseCloudStatus({ cloudStatus: { state: "disabled" } });

    // A deliberately-off connection is not a degraded one, and not "we cannot
    // say" either — mistaking it for either would alarm the reader.
    expect(parsed?.kind).toBe(CloudStatusKind.Disabled);
    expect(parsed?.kind).not.toBe(CloudStatusKind.Unknown);
    expect(parsed?.kind).not.toBe(CloudStatusKind.Degraded);
  });
});

describe("parseCloudStatus — the degraded error's remaining skew shapes", () => {
  it("supplies its own error when the field is absent entirely", () => {
    expect(parseCloudStatus({ cloudStatus: { state: "degraded" } })).toEqual({
      kind: CloudStatusKind.Degraded,
      error: DEFAULT_CONNECTION_ERROR,
    });
  });

  it("supplies its own error when a skewed peer sends a non-string", () => {
    for (const error of [500, null, { code: "EPIPE" }]) {
      expect(
        parseCloudStatus({ cloudStatus: { state: "degraded", error } })
      ).toEqual({
        kind: CloudStatusKind.Degraded,
        error: DEFAULT_CONNECTION_ERROR,
      });
    }
  });
});
