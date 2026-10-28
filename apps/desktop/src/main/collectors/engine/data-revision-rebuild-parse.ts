/**
 * @file data-revision-rebuild-parse.ts
 * @description How the data-revision rebuild parses one source and classifies
 * the outcome. Extracted from `data-revision-rebuild.ts` (ISS-12552) to keep
 * that module under the file-size ceiling.
 */

import type { ParsePolicy } from "../../parse-policy/parse-policy.js";
import type { HarnessCollector, NormalizedSession } from "../types.js";
import { isHistoricalParseWorkerParserOutputError } from "./historical-parse-worker-protocol.js";
import { reportUnrecognizedEntrypoints } from "./unrecognized-entrypoint-log.js";

export type DataRevisionParseSource = (
  collector: HarnessCollector,
  source: string,
  /** ISS-12552: the pass's policy, for a parse that runs out of process. */
  parsePolicy?: ParsePolicy
) => Promise<NormalizedSession[]>;

export const DataRevisionSourceParseResultKind = {
  ParserOutputError: "parser_output_error",
  Retry: "retry",
  Sessions: "sessions",
} as const;

export type DataRevisionSourceParseResult =
  | {
      kind: typeof DataRevisionSourceParseResultKind.Sessions;
      sessions: NormalizedSession[];
    }
  | {
      kind:
        | typeof DataRevisionSourceParseResultKind.ParserOutputError
        | typeof DataRevisionSourceParseResultKind.Retry;
      error: unknown;
    };

/**
 * ISS-7260 (whitlockk review): the rebuild is the SECOND parse path, and it does not
 * go through `collector-manager-source-parse`. A stale cohort re-derived here
 * could write sessions carrying an entrypoint the headless classifier does not
 * recognise while the log said nothing — and a rebuild is precisely when an
 * upstream rename gets applied to a whole corpus at once. Reported off the
 * parse-success path, through the shared reporter, so a value already named by
 * the import pass is not named again.
 */
export async function parseDataRevisionSource(
  collector: HarnessCollector,
  source: string,
  parseSource: DataRevisionParseSource,
  log: (message: string) => void
): Promise<DataRevisionSourceParseResult> {
  try {
    const sessions = await parseSource(collector, source);
    reportUnrecognizedEntrypoints(sessions, log);
    return {
      kind: DataRevisionSourceParseResultKind.Sessions,
      sessions,
    };
  } catch (error) {
    return {
      kind: isHistoricalParseWorkerParserOutputError(error)
        ? DataRevisionSourceParseResultKind.ParserOutputError
        : DataRevisionSourceParseResultKind.Retry,
      error,
    };
  }
}
