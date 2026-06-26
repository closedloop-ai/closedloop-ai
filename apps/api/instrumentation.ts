import "@repo/observability/telemetry/origin";
import {
  assertRunnerSecretConfigured,
  RUNNER_JWT_SECRET_ENV,
} from "@repo/auth/runner-jwt-base";

export const register = () => {
  assertRunnerSecretConfigured(RUNNER_JWT_SECRET_ENV);
};
