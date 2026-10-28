/**
 * @file migration-refusal-telemetry.test.ts
 * @description ISS-4714 — the Agent Monitor boot-failure telemetry projection.
 *
 * A raw `DesktopMigrationError` is unsafe to emit as an app-exception event: its
 * message (and stack) carries the offending migration NAME and, for checksum
 * drift, checksum fragments — bare identifiers/hex that `sanitizeDesktopException`
 * does NOT redact (they are not paths, markers, or secrets). Emitting the raw
 * error would leak names into `exception.message` and make the event cardinality
 * data-dependent. `buildMigrationFailureTelemetryError` replaces the raw error
 * with a STABLE, low-cardinality projection. These tests pin, through the REAL
 * sanitizer, that the emitted attributes carry no migration name/checksum and a
 * fixed per-kind message, while keeping the stable `DesktopMigrationError` type
 * tag.
 */

import assert from "node:assert/strict";
import { AppExceptionOrigin } from "@closedloop-ai/telemetry-contract/app-exception-origin";
import { TelemetryAttribute } from "@closedloop-ai/telemetry-contract/attributes";
import { test } from "vitest";
import {
  buildMigrationFailureTelemetryError,
  DesktopMigrationError,
  MigrationRefusalKind,
  migrationRefusalTelemetryMessage,
  userFacingMigrationRefusal,
} from "../src/main/lifecycle/migration-refusal.js";
import { sanitizeDesktopException } from "../src/shared/exception-sanitizer.js";

const MIGRATION_NAME = "0099_from_the_future";
const CHECKSUM_FRAGMENT = "deadbeefcafebabe";

test("the stable telemetry error strips the migration name/checksum a raw refusal would leak", () => {
  // A refusal message the runner would throw, carrying both the migration name
  // and a checksum fragment (neither redacted by the exception sanitizer).
  const raw = new DesktopMigrationError(
    MigrationRefusalKind.ChecksumDrift,
    `checksum drift on ${MIGRATION_NAME}: expected ${CHECKSUM_FRAGMENT}, found feed0000feed0000`
  );

  // The raw error WOULD leak the name/checksum through the sanitizer (proving
  // the leak is real, not hypothetical).
  const rawAttributes = sanitizeDesktopException({
    error: raw,
    origin: AppExceptionOrigin.Main,
  });
  const rawMessage = rawAttributes[TelemetryAttribute.ExceptionMessage] ?? "";
  assert.ok(
    rawMessage.includes(MIGRATION_NAME) ||
      rawMessage.includes(CHECKSUM_FRAGMENT),
    "the raw refusal error leaks the migration name/checksum into telemetry"
  );

  // The stable projection must not.
  const attributes = sanitizeDesktopException({
    error: buildMigrationFailureTelemetryError(raw),
    origin: AppExceptionOrigin.Main,
  });
  const message = attributes[TelemetryAttribute.ExceptionMessage] ?? "";
  assert.ok(
    !message.includes(MIGRATION_NAME),
    "the stable telemetry message must not carry the migration name"
  );
  assert.ok(
    !message.includes(CHECKSUM_FRAGMENT),
    "the stable telemetry message must not carry a checksum fragment"
  );
  assert.equal(
    message,
    migrationRefusalTelemetryMessage(MigrationRefusalKind.ChecksumDrift),
    "the stable message is the fixed per-kind telemetry message"
  );
  assert.equal(
    attributes[TelemetryAttribute.ExceptionType],
    "DesktopMigrationError",
    "the stable projection keeps the low-cardinality refusal type tag"
  );
  assert.equal(
    attributes[TelemetryAttribute.ExceptionStacktrace],
    undefined,
    "the stable projection carries no stack (no paths/SQL ride along)"
  );
});

test("the stable projection message is fixed per refusal kind (low cardinality)", () => {
  // Two DIFFERENT stores hitting the SAME downgrade refusal, each carrying its
  // own distinct migration name, must collapse to ONE stable telemetry message.
  const a = buildMigrationFailureTelemetryError(
    new DesktopMigrationError(
      MigrationRefusalKind.Downgrade,
      "local store carries 0042_store_a this build lacks"
    )
  );
  const b = buildMigrationFailureTelemetryError(
    new DesktopMigrationError(
      MigrationRefusalKind.Downgrade,
      "local store carries 0077_store_b this build lacks"
    )
  );
  assert.equal(a.message, b.message);
  assert.equal(
    a.message,
    migrationRefusalTelemetryMessage(MigrationRefusalKind.Downgrade)
  );
});

/**
 * ISS-6339 — the field could not tell store CORRUPTION (checksum drift) from
 * VERSION SKEW (history gap), because the telemetry projection reused the
 * user-facing copy, which answers both with one sentence on purpose. The
 * expectation changed here deliberately: the projection now carries its own
 * per-kind message, and the shared user-facing sentence is unchanged.
 */
test("checksum drift and a history gap are distinguishable in telemetry", () => {
  const drift = buildMigrationFailureTelemetryError(
    new DesktopMigrationError(
      MigrationRefusalKind.ChecksumDrift,
      `checksum drift on ${MIGRATION_NAME}: expected ${CHECKSUM_FRAGMENT}`
    )
  );
  const gap = buildMigrationFailureTelemetryError(
    new DesktopMigrationError(
      MigrationRefusalKind.HistoryGap,
      `${MIGRATION_NAME} is applied locally but absent from this build`
    )
  );

  assert.notEqual(
    drift.message,
    gap.message,
    "corruption and version skew must not collapse to one telemetry message"
  );
  for (const [kind, stable] of [
    [MigrationRefusalKind.ChecksumDrift, drift],
    [MigrationRefusalKind.HistoryGap, gap],
  ] as const) {
    const attributes = sanitizeDesktopException({
      error: stable,
      origin: AppExceptionOrigin.Main,
    });
    const message = attributes[TelemetryAttribute.ExceptionMessage] ?? "";
    assert.equal(message, migrationRefusalTelemetryMessage(kind));
    assert.ok(
      !(
        message.includes(MIGRATION_NAME) || message.includes(CHECKSUM_FRAGMENT)
      ),
      "the split message must still carry no migration name or checksum"
    );
  }

  // The USER-FACING copy stays shared — the two failures have one remedy, and
  // changing what a user reads is not this issue's call to make.
  assert.equal(
    userFacingMigrationRefusal(MigrationRefusalKind.ChecksumDrift),
    userFacingMigrationRefusal(MigrationRefusalKind.HistoryGap)
  );
});

/**
 * ISS-6339 — `Record<MigrationRefusalKind, string>` makes the map exhaustive
 * over the enum, so a new kind cannot be forgotten. It does NOT stop a new kind
 * being given a message another kind already uses, which is the exact collapse
 * this issue was filed for — and the sibling catalog in the same module shares
 * one sentence across two kinds, so a copy-the-neighbour edit lands on a
 * duplicate. Assert the property over the WHOLE enum rather than one pair.
 */
test("every refusal kind has a telemetry message no other kind uses", () => {
  const kinds = Object.values(MigrationRefusalKind);
  const messages = kinds.map(migrationRefusalTelemetryMessage);
  assert.equal(
    new Set(messages).size,
    kinds.length,
    `two refusal kinds share a telemetry message: ${messages.join(" | ")}`
  );
});

test("a non-migration boot error projects to a stable generic telemetry error", () => {
  const stable = buildMigrationFailureTelemetryError(
    new Error("boot failed at /Users/someone/private/path with token sk-abc123")
  );
  const attributes = sanitizeDesktopException({
    error: stable,
    origin: AppExceptionOrigin.Main,
  });
  const message = attributes[TelemetryAttribute.ExceptionMessage] ?? "";
  assert.ok(
    !message.includes("/Users/someone"),
    "the generic projection must not carry the raw path"
  );
  assert.ok(
    message.length > 0,
    "the generic projection still carries a stable message"
  );
});
