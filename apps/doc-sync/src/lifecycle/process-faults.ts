import type { EventEmitter } from "node:events";
import { log } from "@repo/observability/log";
import { errorCode, stackFrames } from "../storage/error-code";

export const DOC_SYNC_UNHANDLED_REJECTION_EVENT =
  "doc_sync.unhandled_rejection";
export const DOC_SYNC_UNCAUGHT_EXCEPTION_EVENT = "doc_sync.uncaught_exception";

/**
 * The backstop behind `guardExtension`. An unhandled rejection is logged and
 * the process keeps serving: it unwound no synchronous stack. An uncaught
 * exception may have left state half-written, so it is logged and `onFatal`
 * runs once (the bounded shutdown, which flushes pending stores, then exit
 * 1). Both log the stack frames, because a listener stops Node printing the
 * stack itself. Returns the function that removes both listeners.
 */
export function installProcessFaultHandlers({
  onFatal,
  target = process,
}: {
  onFatal: () => void;
  target?: Pick<EventEmitter, "on" | "off">;
}): () => void {
  let fatal = false;
  const onRejection = (reason: unknown) => {
    log.error("Doc sync unhandled rejection", {
      event: DOC_SYNC_UNHANDLED_REJECTION_EVENT,
      code: errorCode(reason),
      ...stackField(reason),
    });
  };
  const onException = (error: unknown) => {
    log.error("Doc sync uncaught exception", {
      event: DOC_SYNC_UNCAUGHT_EXCEPTION_EVENT,
      code: errorCode(error),
      ...stackField(error),
      fatal: true,
    });
    if (!fatal) {
      fatal = true;
      onFatal();
    }
  };
  target.on("unhandledRejection", onRejection);
  target.on("uncaughtException", onException);
  return () => {
    target.off("unhandledRejection", onRejection);
    target.off("uncaughtException", onException);
  };
}

function stackField(error: unknown): { stack?: string } {
  const stack = stackFrames(error);
  return stack === undefined ? {} : { stack };
}
