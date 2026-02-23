import type { JudgesReport } from "@repo/api/src/types/evaluation";
import { log } from "@repo/observability/log";

/**
 * Parse a JudgesReport JSON buffer safely.
 * @param data      Raw buffer from the zip entry.
 * @param entryName Zip entry path (used in log messages).
 * @param label     Human-readable label for log messages (e.g. "judges report").
 */
export function parseJudgesReportBuffer(
  data: Buffer,
  entryName: string,
  label: string
): JudgesReport | null {
  try {
    const result = JSON.parse(data.toString("utf-8")) as JudgesReport;
    log.info(
      `Found ${label}: ${entryName}, report_id: ${result.report_id}, ${result.stats?.length ?? "?"} judges`
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    log.error(`Failed to parse ${label}: ${message}`);
    return null;
  }
}
