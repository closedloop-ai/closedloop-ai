/**
 * Mock-free fixtures shared by the two `ClerkGitHubLinkClient` suites: the flow
 * suite (timeouts, retries, re-link, claim) and the ISS-11244 failure-attribution
 * suite. Only pieces that do NOT close over a `vi.hoisted` mock live here —
 * `vi.mock` is hoisted per file and `signedIn` binds that file's own mocks, so
 * both stay with their suite.
 */
import { type Mock, vi } from "vitest";

export const RETURN_TO = "/acme/branches";
export const RESUME_PATH = "/connect/github/link?returnTo=%2Facme%2Fbranches";
export const PAGE_URL =
  "http://localhost:3000/connect/github/link?returnTo=%2Facme%2Fbranches";

/** Must exceed AuthTransitionPanel's 400ms reveal hold. */
export const PAST_REVEAL_MS = 500;

/**
 * ISS-11244: the route the browser reports an otherwise-unobservable link
 * failure to. A deliberate literal, not the constant the component uses — a
 * fixture written in terms of the value under test would stay green if the path
 * changed to one no route serves.
 */
export const CLIENT_FAILURE_PATH =
  "/integrations/github/clerk-link/client-failure";

/** The sync leg's own route, so a report assertion can be told from a link POST. */
export const LINK_REQUEST_PATH = "/integrations/github/clerk-link";

/**
 * A code Clerk can emit that this page does NOT recognise, standing in for the
 * whole unrecognised tail. Reported verbatim rather than classified.
 */
export const UNRECOGNISED_CLERK_CODE = "external_account_exists";

/**
 * A DELIBERATE LITERAL, not `ClerkLinkErrorCode.IdentificationDeletionFailed`.
 * Driving the fixture from the constant it polices means changing the constant's
 * value moves fixture and expectation together and the case stays green — while
 * production would then be matching on a code Clerk never sends. The duplication
 * IS the test.
 */
export const DESTROY_FAILED_CLERK_CODE = "identification_deletion_failed";

export type FakeExternalAccount = {
  provider: string;
  verification?: {
    status?: string;
    error?: unknown;
    externalVerificationRedirectURL?: URL | null;
  } | null;
  destroy?: () => Promise<void>;
  reauthorize?: ReturnType<typeof vi.fn>;
};

/**
 * Named explicitly because this module EXPORTS the factory: the inferred shape
 * reaches into `@vitest/spy` internals, which declaration emit cannot name
 * portably (TS2883). It was a file-local helper before the suite split.
 */
export type LocationMock = {
  href: string;
  origin: string;
  search: string;
  assign: Mock;
  replace: Mock;
  reload: Mock;
};

export function makeLocationMock(url: string): LocationMock {
  const parsed = new URL(url);
  return {
    href: url,
    origin: parsed.origin,
    search: parsed.search,
    assign: vi.fn(),
    replace: vi.fn(),
    reload: vi.fn(),
  };
}

/**
 * Shaped like what `@clerk/shared` actually rejects with — an Error carrying
 * `errors[]` — because that shape crosses a trust boundary the component's types
 * do not constrain: it arrives as `unknown` from an SDK call.
 */
export class FakeClerkApiResponseError extends Error {
  readonly errors: { code: string }[];
  constructor(code: string) {
    super(`clerk refused: ${code}`);
    this.errors = [{ code }];
  }
}

/**
 * Shaped like what `useReverification` throws when the reader dismisses Clerk's
 * prompt, recognised by the SDK's own `isReverificationCancelledError`. The
 * test double for that predicate (`apps/app/vitest-mocks/clerk-nextjs-errors.ts`)
 * keys on `code`, which is what the real error carries.
 */
export class FakeReverificationCancelledError extends Error {
  readonly code = "reverification_cancelled";
  constructor() {
    super("reverification cancelled");
  }
}

/**
 * A `useReverification` double that records what actually ran through it.
 *
 * Deliberately NOT an identity passthrough. An identity mock keeps every
 * existing case green whether the SSO calls are wrapped or called raw — which
 * is precisely the defect ISS-11315 fixed, so a suite that cannot tell the two
 * apart would have stayed green through it. The recorded arguments are the
 * evidence that the production call site goes through the hook.
 */
export function makeReverificationMock() {
  const reverifiedCalls: unknown[][] = [];
  const useReverification = <Args extends unknown[], Result>(
    fetcher: (...args: Args) => Result
  ) => {
    return (...args: Args): Result => {
      reverifiedCalls.push(args);
      return fetcher(...args);
    };
  };
  return { reverifiedCalls, useReverification };
}
