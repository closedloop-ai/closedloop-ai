/**
 * Shared fetch stub for the Desktop session-fetch API client tests
 * (`fetchSessionJson` and its callers such as `fetchDesktopIdentity`). Returns a
 * `fetch`-shaped implementation that resolves the given `response` and records
 * each call's URL and init so tests can assert on the request shape.
 */
export function sessionFetchStub(response: Response): {
  fetchImpl: typeof fetch;
  calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
