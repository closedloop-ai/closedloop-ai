import { initializeDatabase } from "@repo/database";
import { initializeSentry } from "@repo/observability/instrumentation";

export const register = async () => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await initializeDatabase();
  }

  await initializeSentry();
};
