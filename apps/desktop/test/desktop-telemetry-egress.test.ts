import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_TELEMETRY_EGRESS_ENV_VAR,
  resolveDesktopTelemetryEgressEnabled,
} from "../src/main/desktop-telemetry-egress.js";

test("egress defaults to enabled only for a packaged build", () => {
  assert.equal(
    resolveDesktopTelemetryEgressEnabled({ isPackaged: true, env: {} }),
    true
  );
  assert.equal(
    resolveDesktopTelemetryEgressEnabled({ isPackaged: false, env: {} }),
    false
  );
});

test("explicit override force-enables egress for an unpackaged build", () => {
  for (const value of ["1", "true", "yes", "TRUE", " Yes "]) {
    assert.equal(
      resolveDesktopTelemetryEgressEnabled({
        isPackaged: false,
        env: { [DESKTOP_TELEMETRY_EGRESS_ENV_VAR]: value },
      }),
      true,
      `expected "${value}" to force-enable egress`
    );
  }
});

test("explicit override force-disables egress for a packaged build", () => {
  for (const value of ["0", "false", "no", "FALSE", " No "]) {
    assert.equal(
      resolveDesktopTelemetryEgressEnabled({
        isPackaged: true,
        env: { [DESKTOP_TELEMETRY_EGRESS_ENV_VAR]: value },
      }),
      false,
      `expected "${value}" to force-disable egress`
    );
  }
});

test("blank or unrecognized override falls back to the packaging default", () => {
  for (const value of ["", "   ", "maybe", "on", "1.0"]) {
    assert.equal(
      resolveDesktopTelemetryEgressEnabled({
        isPackaged: true,
        env: { [DESKTOP_TELEMETRY_EGRESS_ENV_VAR]: value },
      }),
      true,
      `expected packaged default to hold for "${value}"`
    );
    assert.equal(
      resolveDesktopTelemetryEgressEnabled({
        isPackaged: false,
        env: { [DESKTOP_TELEMETRY_EGRESS_ENV_VAR]: value },
      }),
      false,
      `expected unpackaged default to hold for "${value}"`
    );
  }
});
