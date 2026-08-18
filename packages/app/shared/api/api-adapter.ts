import type { ApiRequestOptions } from "./api-timeout";

/**
 * Transport port for the shared app-core layer (FEA-1510).
 *
 * The API origin differs per surface (web: env/preview-hostname logic in
 * `apps/app/lib/api-origin.ts`; desktop: its own configuration), so shared
 * code resolves it through this adapter instead of reading env vars. Token
 * and org identity come from the auth port (`shared/auth`), not from here.
 */
export type ApiAdapter = {
  /** Origin (scheme://host[:port]) of the REST API for the current surface. */
  resolveApiOrigin: () => string;
  /**
   * Transport used for every request. Defaults to the platform `fetch` when
   * omitted; surfaces inject a replacement to run the real client without a
   * live API (e.g. a fixture handler in the Storybook/test harness), or to
   * reach the API over something that is not the network at all (the desktop
   * IPC bridge).
   *
   * CONTRACT: a transport that cannot honor `init.signal` MUST enforce
   * `init.timeoutMs` some other way. The two are the same deadline expressed
   * twice; a transport that observes neither silently reinstates the unbounded
   * wait the deadline exists to prevent (ISS-5013), or pins the request to a
   * bound of its own that the call site never asked for (ISS-5082).
   */
  fetch?: ApiTransportFetch;
  /**
   * api deployment uid this build is pinned to (FEA-1485). When set, the client
   * forwards it as the `x-deployment-id` header so the cross-origin app→api
   * fetch routes to the matching api deployment even after the api-prod alias
   * moves (rollback/hotfix). The web shell resolves it server-side from the
   * FEA-1484 Edge Config `{sha → uid}` store; `null`/unset off app-prod
   * (preview / non-prod / no entry) → no header, latest api.
   */
  deploymentId?: string | null;
};

/**
 * Signature of {@link ApiAdapter.fetch}. Identical to the platform `fetch`
 * except that the init is the client's own {@link ApiRequestOptions}, so the
 * resolved per-request deadline is visible to the transport. The platform
 * `fetch` remains assignable to this — it simply ignores the extra member — but
 * a transport that cannot honor an `AbortSignal` (the desktop IPC bridge) reads
 * `timeoutMs` and enforces the deadline its own way (ISS-5082).
 */
export type ApiTransportFetch = (
  input: RequestInfo | URL,
  init?: ApiRequestOptions
) => Promise<Response>;
