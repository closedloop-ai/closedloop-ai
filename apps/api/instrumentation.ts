import {
  assertRunnerSecretConfigured,
  RUNNER_JWT_SECRET_ENV,
} from "@repo/auth/runner-jwt-base";

/** The only Next.js runtime that can host the API's Node instrumentation. */
const NODE_RUNTIME = "nodejs";

/** Registers API startup checks and runtime-specific observability wiring. */
export const register = async () => {
  assertRunnerSecretConfigured(RUNNER_JWT_SECRET_ENV);

  // Next compiles this entrypoint for every runtime. Keep the Node-only module
  // behind the runtime branch so Edge instrumentation never traverses Prisma,
  // pg, the OpenTelemetry Node SDK, or the Node-backed observability modules.
  if (process.env.NEXT_RUNTIME === NODE_RUNTIME) {
    const { registerNodeInstrumentation } = await import(
      "./instrumentation.node"
    );
    await registerNodeInstrumentation();
  }
};
