// @vitest-environment jsdom
import {
  type DocsHelpHostFixture,
  HELP_BOTH_HOST_CONTRACT,
} from "@repo/app/help/__tests__/help-both-host-contract";
import {
  DOCS_HELP_NAV_PATH,
  DOCS_HELP_PAGE_PATH,
  DOCS_HELP_SEARCH_PATH,
} from "@repo/app/help/lib/web-help-contract";
import {
  runBothHostContract,
  WEB_HOST,
} from "@repo/app/shared/testing/both-host-render-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { vi } from "vitest";
import { WebHelpSurfaceHost } from "../components/help-surface-host";

/**
 * ISS-10006 — the WEB half of the Help both-host contract, the runner
 * `packages/app/help/__tests__/help-both-host-contract.ts` was written owing.
 *
 * Until this file existed the contract had one runner, and its own docstring
 * said so: "web has no Help route to mount, so the honest state is 'no web
 * runner', not 'web is excused'." Web mounts one now, and this is the pass —
 * every case, no `divergence` entry. Help has no device-only capability, so
 * there is nothing for web to be excused from.
 *
 * ONLY THE TRANSPORT IS REPLACED. The three reads become `fetch` outcomes, and
 * every state below is then produced by the host's own wiring and the shipped
 * surface — which is the point: a mock of the source would prove the surface
 * renders a `DocsHelpSource`, a thing its own suite already proves.
 */
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

class ResizeObserverStub {
  observe() {
    return;
  }
  unobserve() {
    return;
  }
  disconnect() {
    return;
  }
}
globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

/**
 * The fixture, expressed as this host's transport rather than as its state.
 *
 * `available: false` is the NAV read failing, because that is the only thing web
 * has that answers "is there a readable corpus at all" — desktop asks
 * `status.available` over IPC, and web's equivalent is whether the deployment
 * could parse the pages it ships.
 */
function installTransport(fixture: DocsHelpHostFixture): void {
  vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith(DOCS_HELP_SEARCH_PATH)) {
      return fixture.searchRejects === true
        ? Promise.resolve(new Response("nope", { status: HTTP_UNAVAILABLE }))
        : Promise.resolve(jsonResponse({ hits: [] }));
    }
    if (url.startsWith(DOCS_HELP_PAGE_PATH)) {
      if (fixture.pageRejects === true) {
        return Promise.resolve(
          new Response("nope", { status: HTTP_UNAVAILABLE })
        );
      }
      // The fixture carries desktop's `getPage` RESULT — `{ kind, page }` — so
      // it is unwrapped into web's wire shape here rather than the contract
      // being reshaped around one host. `missing` is the 404 this host's route
      // handler answers with; anything else is a 200 carrying the page, malformed
      // payloads included, which is what the shared guard is there to refuse.
      const result = fixture.page as { kind?: string; page?: unknown } | null;
      if (result?.kind === "missing") {
        return Promise.resolve(
          new Response("gone", { status: HTTP_NOT_FOUND })
        );
      }
      return Promise.resolve(jsonResponse({ page: result?.page ?? result }));
    }
    if (url.startsWith(DOCS_HELP_NAV_PATH)) {
      return fixture.available
        ? Promise.resolve(jsonResponse({ navGroups: fixture.navGroups }))
        : Promise.resolve(new Response("nope", { status: HTTP_UNAVAILABLE }));
    }
    return Promise.reject(new Error(`unexpected read: ${url}`));
  });
}

runBothHostContract<DocsHelpHostFixture>({
  contract: HELP_BOTH_HOST_CONTRACT,
  host: WEB_HOST,
  mount: (fixture) => {
    cleanup();
    vi.unstubAllGlobals();
    installTransport(fixture);
    // A FRESH client per case: the corpus is cached for the session in
    // production, which is right there and wrong here — the second fixture would
    // be answered from the first one's cache.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <WebHelpSurfaceHost docsSiteUrl="https://closedloop.ai/docs" />
      </QueryClientProvider>
    );
  },
});
