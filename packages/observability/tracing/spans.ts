import {
  type Attributes,
  context,
  type Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

const TRACER_NAME = "closedloop.application";

type SpanBody<T> = () => T | Promise<T>;

/** Run work in an application child span when an active trace is recording. */
export function withAppSpan<T>(
  name: string,
  body: () => Promise<T>,
  attributes?: Attributes
): Promise<T>;
export function withAppSpan<T>(
  name: string,
  body: () => T,
  attributes?: Attributes
): T;
export function withAppSpan<T>(
  name: string,
  body: SpanBody<T>,
  attributes?: Attributes
): T | Promise<T> {
  const parent = trace.getSpan(context.active());
  if (!parent?.isRecording()) {
    return body();
  }
  return trace.getTracer(TRACER_NAME).startActiveSpan(name, (span) => {
    if (attributes) {
      span.setAttributes(attributes);
    }
    try {
      const result = body();
      if (isPromiseLike(result)) {
        return result
          .catch((error) => {
            recordSpanException(span, error);
            throw error;
          })
          .finally(() => span.end());
      }
      span.end();
      return result;
    } catch (error) {
      recordSpanException(span, error);
      span.end();
      throw error;
    }
  });
}

export function setAppSpanAttributes(attributes: Attributes): void {
  const span = trace.getSpan(context.active());
  if (!span?.isRecording()) {
    return;
  }
  span.setAttributes(attributes);
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return (
    typeof value === "object" &&
    value !== null &&
    "finally" in value &&
    typeof value.finally === "function"
  );
}

function recordSpanException(span: Span, error: unknown): void {
  span.recordException(error as Error);
  span.setStatus({ code: SpanStatusCode.ERROR });
}
