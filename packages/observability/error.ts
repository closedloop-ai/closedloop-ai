export const parseError = (error: unknown): string => {
  try {
    return readErrorMessage(error);
  } catch {
    // Total by contract: this only ever produces a string for a log line, and
    // it runs inside catch blocks that owe the caller a response. A thrown
    // value with a throwing `message` getter — a Proxy, or a hostile object —
    // would otherwise escape the catch that was handling it and reject the
    // handler instead of returning the intended error response.
    return UNREADABLE_ERROR_MESSAGE;
  }
};

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === "object" && "message" in error) {
    return typeof error.message === "string"
      ? error.message
      : String(error.message);
  }
  return String(error);
}

/** What a value reports when its own message cannot be read. */
export const UNREADABLE_ERROR_MESSAGE = "[unreadable error]";
