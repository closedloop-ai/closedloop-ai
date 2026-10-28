/** Exact, payload-free message carried by an infrastructure-only witness failure. */
export const CONNECTED_DOCUMENT_PROVIDER_FAILURE =
  "Connected document provider infrastructure failure (ISS-12432)";

/** Constructed only at a positively classified SDK operation, never from renderer errors. */
export class ConnectedDocumentProviderError extends Error {
  constructor() {
    super(CONNECTED_DOCUMENT_PROVIDER_FAILURE);
    this.name = "ConnectedDocumentProviderError";
  }
}

/** An aggregate containing an assertion or unknown failure must remain a hard failure. */
export function connectedDocumentFailure(
  failures: readonly unknown[],
  hardMessage: string
): AggregateError {
  return new AggregateError(
    failures,
    failures.length > 0 && failures.every(isConnectedDocumentProviderFailure)
      ? CONNECTED_DOCUMENT_PROVIDER_FAILURE
      : hardMessage
  );
}

/** Do not inspect message substrings or ordinary error causes to infer infrastructure. */
export function isConnectedDocumentProviderFailure(error: unknown): boolean {
  if (error instanceof ConnectedDocumentProviderError) {
    return true;
  }
  return (
    error instanceof AggregateError &&
    error.errors.length > 0 &&
    error.errors.every(isConnectedDocumentProviderFailure)
  );
}

/** Propagate an owned auth-handler failure while awaiting its dependent navigation/readiness. */
export function connectedDocumentAuthorizationBoundary() {
  let rejectFailure: (error: unknown) => void = () => undefined;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  // The handler may fail between awaited operations; retain the rejection without an unhandled promise.
  failed.catch(() => undefined);
  return {
    fail: rejectFailure,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      return await Promise.race([operation(), failed]);
    },
  };
}

/** Failed deletion checks absence independently; registered rooms retain the deletion failure. */
export async function cleanupConnectedDocumentRoom(
  witness: { delete: () => Promise<void>; assertDeleted: () => Promise<void> },
  created: boolean
): Promise<void> {
  try {
    await witness.delete();
  } catch (deletionError) {
    try {
      await witness.assertDeleted();
    } catch (absenceError) {
      throw connectedDocumentFailure(
        [deletionError, absenceError],
        created
          ? "Created room cleanup and absence verification failed"
          : "Partial room cleanup and absence verification failed"
      );
    }
    if (created) {
      throw deletionError;
    }
  }
}
