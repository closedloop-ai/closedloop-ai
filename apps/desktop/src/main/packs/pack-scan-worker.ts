/**
 * @file pack-scan-worker.ts — Electron utilityProcess entry for the pure-compute
 * pack scan (FEA-3628).
 *
 * This process owns NO database connection. It receives the recent project
 * roots from the db-host, runs `computePackScan` (filesystem walk,
 * execFileSync, frontmatter/marketplace parsing — the heavy work), and returns
 * a serializable `PackScanComputeResult`. The db-host replays that plan as the
 * sole SQLite writer. Keeping this compute off the db-host is what stops pack
 * scanning from starving renderer DB reads.
 *
 * Mirrors `collectors/engine/historical-parse-worker.ts`.
 */

import { discoverDefinitions } from "./definition-discovery.js";
import {
  createPackScanComputedResponse,
  createPackScanDefinitionsOmittedResponse,
  createPackScanDefinitionsResponse,
  createPackScanFailedResponse,
  definitionBudgetOmissionReason,
  type PackScanWorkerRequest,
  PackScanWorkerRequestType,
  type PackScanWorkerResponse,
  packScanWorkerRequestSchema,
  requestIdFromWorkerMessage,
  toDefinitionWire,
} from "./pack-scan-worker-protocol.js";
import { computePackScan } from "./pack-scanner.js";

process.parentPort.on("message", (messageEvent) => {
  handleWorkerMessage(messageEvent.data).catch((error: unknown) => {
    const requestId = requestIdFromWorkerMessage(messageEvent.data);
    if (!requestId) {
      return;
    }
    try {
      process.parentPort.postMessage(
        createPackScanFailedResponse(requestId, workerErrorMessage(error))
      );
    } catch {
      // The IPC channel is already unavailable; the db-host timeout is the only
      // remaining signal path.
    }
  });
});

async function handleWorkerMessage(message: unknown): Promise<void> {
  const parsedRequest = packScanWorkerRequestSchema.safeParse(message);
  if (!parsedRequest.success) {
    const requestId = requestIdFromWorkerMessage(message);
    if (requestId) {
      process.parentPort.postMessage(
        createPackScanFailedResponse(requestId, "invalid pack scan request")
      );
    }
    return;
  }
  const request = parsedRequest.data;
  try {
    process.parentPort.postMessage(await computeResponse(request));
  } catch (error) {
    process.parentPort.postMessage(
      createPackScanFailedResponse(request.requestId, workerErrorMessage(error))
    );
  }
}

/**
 * Run the request's compute. `definitions` is the ISS-5274 walk that used to
 * run inside the `packScanner.apply` db-host store op — the recursive
 * `readdirSync` sweep of every recent project root that blocked the db-host's
 * single JS thread and starved renderer DB reads.
 *
 * The roots arrive fully resolved from the db-host: this process reads NO
 * environment (`CLAUDE_HOME`, `CODEX_HOME`, the OpenCode config home,
 * `os.homedir()`), because a divergent environment here would silently change
 * the scanned set and, through the scope context, the persisted
 * `agent_components.scope`.
 */
async function computeResponse(
  request: PackScanWorkerRequest
): Promise<PackScanWorkerResponse> {
  if (request.type === PackScanWorkerRequestType.Definitions) {
    const definitions = toDefinitionWire(
      discoverDefinitions(request.scanRoots)
    );
    // Complete-or-fall-back: over budget we omit the WHOLE payload with a
    // reason so the db-host does the full on-host walk. Truncating here would
    // hand the db-host a partial set it would apply as complete, reconciling
    // every dropped definition to `missing`.
    const omissionReason = definitionBudgetOmissionReason(definitions);
    if (omissionReason) {
      return createPackScanDefinitionsOmittedResponse(
        request.requestId,
        omissionReason
      );
    }
    return createPackScanDefinitionsResponse(request.requestId, definitions);
  }
  const result = await computePackScan({
    recentProjectRoots: request.recentProjectRoots,
  });
  return createPackScanComputedResponse(request.requestId, result);
}

function workerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
