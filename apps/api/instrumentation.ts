import { initializeSentry } from "@repo/observability/instrumentation";

export const register = async () => {
  await initializeSentry();
};
