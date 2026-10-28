/** The only Next.js runtime that can host the API's Node instrumentation. */
const NODE_RUNTIME = "nodejs";

/** Registers the API's runtime-specific instrumentation. */
export const register = async () => {
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
