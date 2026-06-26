import { parseHistoricalSource } from "./historical-parse-source.js";
import {
  createHistoricalParseWorkerFailedResponse,
  createHistoricalParseWorkerParsedResponse,
  historicalParseWorkerRequestSchema,
  requestIdFromWorkerMessage,
} from "./historical-parse-worker-protocol.js";

process.parentPort.on("message", (messageEvent) => {
  handleWorkerMessage(messageEvent.data).catch((error: unknown) => {
    const requestId = requestIdFromWorkerMessage(messageEvent.data);
    if (!requestId) {
      return;
    }
    try {
      process.parentPort.postMessage(
        createHistoricalParseWorkerFailedResponse(
          requestId,
          workerErrorMessage(error)
        )
      );
    } catch {
      // The IPC channel is already unavailable; the main process timeout is the
      // only remaining signal path.
    }
  });
});

async function handleWorkerMessage(message: unknown): Promise<void> {
  const parsedRequest = historicalParseWorkerRequestSchema.safeParse(message);
  if (!parsedRequest.success) {
    const requestId = requestIdFromMalformedRequest(message);
    if (requestId) {
      process.parentPort.postMessage(
        createHistoricalParseWorkerFailedResponse(
          requestId,
          "invalid historical parse request"
        )
      );
    }
    return;
  }
  const request = parsedRequest.data;
  try {
    const sessions = await parseHistoricalSource(
      request.collectorKey,
      request.source
    );
    process.parentPort.postMessage(
      createHistoricalParseWorkerParsedResponse(request.requestId, sessions)
    );
  } catch (error) {
    process.parentPort.postMessage(
      createHistoricalParseWorkerFailedResponse(
        request.requestId,
        workerErrorMessage(error)
      )
    );
  }
}

function requestIdFromMalformedRequest(message: unknown): string | null {
  return requestIdFromWorkerMessage(message);
}

function workerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
