import { SESSIONS_USAGE_TYPED_SQL_SHADOW_SERVER_FLAG } from "@/lib/feature-flags/server-feature-flags";

/**
 * The flag descriptor the three `createMemoizedFeatureFlagGate` suites resolve.
 *
 * Sample input rather than their subject: every case drives the evaluation
 * itself, so no assertion in any of them depends on which key this is. It is
 * chosen once here because each suite used to bind
 * `SESSIONS_DISPLAYED_STATUS_PARITY_SERVER_FLAG` directly, which made retiring
 * that flag (ISS-10782) a three-suite break.
 *
 * It has to stay a REGISTERED descriptor — `createMemoizedFeatureFlagGate` takes
 * `RegisteredServerFeatureFlag` so a gate cannot be built for an unclassified
 * flag, and a synthetic key is not assignable to that union. This one is the
 * gate module's own live production consumer (`resolveUsageTypedSqlShadow`).
 */
export const MEMOIZED_GATE_SAMPLE_FLAG =
  SESSIONS_USAGE_TYPED_SQL_SHADOW_SERVER_FLAG;
