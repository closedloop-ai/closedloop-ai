import type { Span as ApiSpan, Context } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import type { Span, SpanProcessor } from "@opentelemetry/sdk-trace-node";

const ATTR_SESSION_MESH = "cl.session_mesh";

const ATTR_HTTP_TARGET = "http.target";

/**
 * Marks every span of a Session Mesh request, children included.
 *
 * Only the root request span ever carries `http.route`, and Next writes it as
 * the request ENDS, after the pg and internal children have already ended. The
 * root's `http.target` is set at creation, so the decision is made in
 * `onStart` and inherited from the in-process parent.
 */
export class SessionMeshSpanProcessor implements SpanProcessor {
  private readonly meshSpans = new WeakSet<ApiSpan>();

  onStart(span: Span, parentContext: Context): void {
    const parent = trace.getSpan(parentContext);
    if (!((parent && this.meshSpans.has(parent)) || isMeshRequest(span))) {
      return;
    }
    this.meshSpans.add(span);
    span.setAttribute(ATTR_SESSION_MESH, true);
  }

  onEnd(): void {
    // Required by `SpanProcessor`; the mark is made at start.
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function isMeshRequest(span: Span): boolean {
  const target = span.attributes[ATTR_HTTP_TARGET];
  return typeof target === "string" && target.startsWith("/session-mesh/");
}
