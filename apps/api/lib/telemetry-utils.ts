import { log } from "@repo/observability/log";

export function safeEmit(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    log.warn("safeEmit: telemetry emission failed", { error });
  }
}
