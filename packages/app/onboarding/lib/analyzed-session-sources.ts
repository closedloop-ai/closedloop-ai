/**
 * @file The session sources the Desktop collectors scan, as onboarding names
 * them (ISS-11346).
 *
 * The Welcome step is where the reader agrees to analysis (ISS-10950), so the
 * sources it names must be exactly the ones the boot import reads.
 * `apps/desktop/src/renderer/components/onboarding/__tests__/welcome-consent-sources.test.tsx`
 * builds the real collector registry and fails when a collector is missing
 * from the rendered consent line.
 */
import { type Harness, HarnessValues } from "@repo/lib/harness/types";
import { scannedHarnessLabel } from "./harness-display-label";

/** Harness ids of every source the collector registry scans, in its order. */
export const ANALYZED_SESSION_SOURCES: readonly Harness[] = HarnessValues;

/** The analyzed sources as one list, e.g. "Claude Code, Codex, … and OpenCode". */
export function formatAnalyzedSessionSources(
  type: Intl.ListFormatType = "conjunction"
): string {
  return new Intl.ListFormat("en", { style: "long", type }).format(
    ANALYZED_SESSION_SOURCES.map(scannedHarnessLabel)
  );
}
