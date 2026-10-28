/**
 * @file desktop-client-attribution-provider.ts
 * @description ISS-8749: the process-wide source of the caller-attested build
 * metadata every first-party cloud request stamps on itself — the local
 * installation UUID and the Desktop build version.
 *
 * A boot-set provider rather than a field threaded through
 * `SessionFetchOptions`, because both values are constant for the life of the
 * process and there are a dozen places that construct those options. Threading
 * would have made a dozen call sites decide, one at a time, whether a request
 * carries attribution. The composition root is the only writer; everything else
 * reads.
 *
 * "Every request" is a claim about the call graph, so what it covers is drawn
 * from a rule rather than from a list someone kept up to date: a lane carries
 * attribution exactly when its cl-api route runs one of the auth wrappers
 * ISS-8748 instrumented (`withAnyAuth`, `withApiKeyAuth`,
 * `withDesktopSessionAuth`), because `recordRequestClientAttribution` is called
 * only from those and a header no wrapper reads is stamped for nobody. Stating
 * the rule matters because a lane omitted by accident is not visibly different
 * from a lane on an old build — the attribution is simply absent, and no
 * analysis can tell the two apart, so an incomplete inventory does not merely
 * miss traffic, it silently reattributes current traffic to old builds.
 *
 * Reads have one chokepoint: `fetchJsonAndParse`, which stamps the
 * `fetchSessionJson` façade over it and the lanes that call it directly
 * (`/me`, `/users`, the pack analytics read, the assigned-distributions read).
 *
 * Session-data writes have one chokepoint: `sendSessionClApiRequest`, which
 * stamps the bulk agent-session sync, transcript control POSTs, and the
 * component/invocation/routine sync clients. `postSessionJson` delegates there for the best-effort observability
 * writes.
 *
 * The remaining cl-api callers still stamp their own request builders: the
 * distribution status report, managed-key provisioning, the API-key identity
 * `/me` read, and the onboarding-status read.
 * Two of them compose a `Headers` rather than an object literal — the
 * renderer's cloud-api fetch bridge and the transcript-read bridge — and use
 * {@link applyDesktopClientAttribution} for the same merged-beneath precedence
 * a spread gives.
 *
 * Deliberately NOT covered, each because the rule above excludes it rather than
 * because nobody looked: the requests that are not this client acting as itself
 * — the presigned-S3 transfers, including the transcript upload `put`, which
 * are not cl-api requests at all — and the three cl-api routes that run no auth wrapper
 * at all, so nothing on the server would read the header: the PoP-signed
 * desktop session refresh/revoke/authorize posts, the pre-session device
 * onboarding poll, and the bootstrap claim.
 *
 * Unset is a first-class state, not an error. Nothing has been set before the
 * composition root runs, and any request issued in that window carries no
 * headers rather than a placeholder — the same omission an older Desktop build
 * produces, which is what makes the server's absent-value handling the single
 * path both cases take.
 */
import {
  buildDesktopClientAttributionHeaders,
  type DesktopClientAttribution,
} from "@repo/api/src/types/desktop-client-attribution";

let desktopClientAttributionResolver:
  | (() => DesktopClientAttribution)
  | undefined;

/**
 * Publish how to resolve the attribution for the rest of the process. Called
 * once, by the composition root, reading the same values the OTel resource
 * does, so a record the desktop emits and the API span for the request that
 * produced it name the same install and the same build.
 *
 * A RESOLVER, not a value. The installation id lives on a store the composition
 * root is itself in the middle of building — `nodeUuidStore` is assigned from
 * that function's own return value — so reading it eagerly throws
 * `Cannot read properties of undefined (reading 'getOrCreateNodeUuid')` and
 * takes desktop startup down with it, before any window appears. Every other
 * consumer of that id (`getAppInstallationId`, `getDeviceId`) is a lazy getter
 * for exactly this reason; this is the same shape, not a special case.
 */
export function setDesktopClientAttributionResolver(
  resolve: () => DesktopClientAttribution
): void {
  desktopClientAttributionResolver = resolve;
}

/**
 * The request headers to merge into a first-party cloud request, or an empty
 * object when nothing has been published yet, the resolver cannot answer, or
 * neither value validates.
 *
 * Total by construction. A telemetry header must never be the reason a cloud
 * request fails, so a resolver that throws — a store not yet ready, a disposed
 * host during shutdown — degrades to the same absent-attribution state an older
 * Desktop build produces, which is the one path the server already handles.
 */
export function desktopClientAttributionHeaders(): Record<string, string> {
  if (!desktopClientAttributionResolver) {
    return {};
  }
  try {
    return buildDesktopClientAttributionHeaders(
      desktopClientAttributionResolver()
    );
  } catch {
    return {};
  }
}

/** Test-only reset, so a suite cannot inherit a previous suite's publication. */
export function resetDesktopClientAttribution(): void {
  desktopClientAttributionResolver = undefined;
}

/**
 * Merge the published attribution into a `Headers` the caller already built,
 * for the lanes that compose one instead of an object literal. Set BENEATH what
 * the caller set — an existing entry wins, exactly as the object spread's
 * ordering gives — so a bridge forwarding a renderer header keeps forwarding it.
 */
export function applyDesktopClientAttribution(headers: Headers): Headers {
  for (const [name, value] of Object.entries(
    desktopClientAttributionHeaders()
  )) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  return headers;
}

/**
 * ISS-11838: the published installation id, the install's `node_uuid`, which
 * the renderer's session-replay client sends as its distinct id. Undefined
 * when nothing has been published or the resolver cannot answer, for the same
 * reason {@link desktopClientAttributionHeaders} is total.
 */
export function desktopInstallationId(): string | undefined {
  try {
    return desktopClientAttributionResolver?.().installationId;
  } catch {
    return undefined;
  }
}
