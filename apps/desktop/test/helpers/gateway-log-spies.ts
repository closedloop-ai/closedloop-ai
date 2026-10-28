import { vi } from "vitest";
import { gatewayLog } from "../../src/main/logging/gateway-logger.js";

/** Silence `gatewayLog.warn` and return the spy so a test can assert on it. */
export function silenceWarnings() {
  return vi.spyOn(gatewayLog, "warn").mockImplementation(() => undefined);
}
