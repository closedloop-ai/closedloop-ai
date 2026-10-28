/**
 * ISS-6715 — the root error boundaries had no test that mounted them; the only
 * coverage called `reportNextjsError` directly, so it would still pass with
 * either boundary file deleted.
 *
 * `ErrorBoundary` is imported from Next's internals deliberately: it is the
 * component that actually receives `error.tsx` / `global-error.tsx` as its
 * `errorComponent` at runtime, so mounting through it exercises the real
 * `getDerivedStateFromError` and the real `reset`/`retry`, not a hand-made
 * prop bag.
 * It does NOT prove Next's file-convention routing (that `app/error.tsx` is the
 * file handed to that boundary) — only a build or e2e can. If Next moves the
 * module, this fails loudly at import rather than degrading to a weaker test.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ErrorBoundary,
  type ErrorComponent,
} from "next/dist/client/components/error-boundary";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AppError from "@/app/error";
import GlobalError from "@/app/global-error";
import { RumErrorSource } from "@/lib/datadog-rum/error-source";

const { reportNextjsError } = vi.hoisted(() => ({
  reportNextjsError: vi.fn(),
}));

vi.mock("@/lib/datadog-rum/report-error", () => ({ reportNextjsError }));

// `geist` resolves `next/font/local` as a directory import, which Node's ESM
// loader rejects under vitest. The font class is not part of the contract these
// tests cover, so stub the module global-error.tsx reads it from.
vi.mock("@repo/design-system/lib/fonts", () => ({ fonts: "test-font-class" }));

beforeEach(() => {
  reportNextjsError.mockClear();
});

describe("app/error.tsx mounted in Next's error boundary", () => {
  it("reports the thrown error with its digest and the nextjs-error-boundary source", async () => {
    const route = createControlledRoute();
    const error = digestError("route render failed", "digest-route-1");
    route.throwOnNextRender(error);

    render(
      <ErrorBoundary errorComponent={appErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );

    expect(
      await screen.findByRole("heading", { name: "Something went wrong" })
    ).toBeInTheDocument();
    expect(reportNextjsError).toHaveBeenCalledTimes(1);
    expect(reportNextjsError).toHaveBeenCalledWith(error, {
      digest: "digest-route-1",
      source: RumErrorSource.NextjsErrorBoundary,
    });
  });

  it("re-attempts the failed render when the user activates Try again", async () => {
    const route = createControlledRoute();
    route.throwOnNextRender(digestError("transient", "digest-transient"));

    render(
      <ErrorBoundary errorComponent={appErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );
    await screen.findByRole("heading", { name: "Something went wrong" });

    route.stopThrowing();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(RECOVERED_TEXT)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Something went wrong" })
    ).toBeNull();
  });

  it("reports a client-thrown error that carries no digest", async () => {
    const route = createControlledRoute();
    const error = new Error("client render failed");
    route.throwOnNextRender(error);

    render(
      <ErrorBoundary errorComponent={appErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );

    expect(
      await screen.findByRole("heading", { name: "Something went wrong" })
    ).toBeInTheDocument();
    expect(reportNextjsError).toHaveBeenCalledTimes(1);
    expect(reportNextjsError.mock.calls[0]?.[0]).toBe(error);
    expect(reportNextjsError.mock.calls[0]?.[1]).toEqual({
      digest: undefined,
      source: RumErrorSource.NextjsErrorBoundary,
    });
  });

  it("re-reports a second distinct error but not a re-render of the same one", async () => {
    const route = createControlledRoute();
    const first = digestError("first failure", "digest-first");
    const second = digestError("second failure", "digest-second");
    route.throwOnNextRender(first);

    const view = render(
      <ErrorBoundary errorComponent={appErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );
    await screen.findByRole("heading", { name: "Something went wrong" });
    expect(reportNextjsError).toHaveBeenCalledTimes(1);

    // Same error identity across a re-render must not emit a duplicate report.
    // This catches an effect with no dependency array; it does NOT distinguish
    // `[error]` from `[]` — see the dependency describe block below.
    view.rerender(
      <ErrorBoundary errorComponent={appErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );
    expect(reportNextjsError).toHaveBeenCalledTimes(1);

    route.throwOnNextRender(second);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(reportNextjsError).toHaveBeenCalledTimes(2));
    expect(reportNextjsError).toHaveBeenLastCalledWith(second, {
      digest: "digest-second",
      source: RumErrorSource.NextjsErrorBoundary,
    });
  });

  it("stays actionable for a production digest-only error with no message", async () => {
    const route = createControlledRoute();
    // biome-ignore lint/suspicious/useErrorMessage: the empty message IS the production shape under test — the digest is all the user's error carries.
    const error = Object.assign(new Error(""), { digest: "digest-prod-only" });
    route.throwOnNextRender(error);

    render(
      <ErrorBoundary errorComponent={appErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );

    expect(
      await screen.findByRole("heading", { name: "Something went wrong" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(reportNextjsError).toHaveBeenCalledWith(error, {
      digest: "digest-prod-only",
      source: RumErrorSource.NextjsErrorBoundary,
    });
  });
});

/**
 * ISS-6995: Next types the thrown value `unknown` (`ErrorInfo.error`, with its
 * own NAR-804 TODO), so a `throw "string"`, `throw { code: 500 }` or
 * `throw null` from anywhere in the authenticated app arrives here. These run
 * through the real `ErrorBoundary`, so what they exercise is the production
 * path: before the fix, `error.digest` on `null` threw INSIDE the crash
 * handler, which is a blank page for the whole app.
 */
describe("app/error.tsx given a value Next did not promise is an Error", () => {
  it("still renders its recovery UI when a bare string is thrown", async () => {
    const route = createControlledRoute();
    route.throwOnNextRender("thrown-string-with-user-text");

    render(
      <ErrorBoundary errorComponent={appErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );

    expect(
      await screen.findByRole("heading", { name: "Something went wrong" })
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(reportNextjsError).toHaveBeenCalledTimes(1);
    const [reported, context] = reportNextjsError.mock.calls[0] ?? [];
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe("Non-Error value thrown (string)");
    expect(reported.message).not.toContain("thrown-string-with-user-text");
    expect(context).toEqual({
      digest: undefined,
      source: RumErrorSource.NextjsErrorBoundary,
    });
  });

  it("does not crash inside the crash handler when null is thrown", async () => {
    const route = createControlledRoute();
    route.throwOnNextRender(null);

    render(
      <ErrorBoundary errorComponent={appErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );

    expect(
      await screen.findByRole("heading", { name: "Something went wrong" })
    ).toBeVisible();
    expect(reportNextjsError.mock.calls[0]?.[0]?.message).toBe(
      "Non-Error value thrown (null)"
    );
  });

  // A digest a NON-Error carries is deliberately DROPPED, through the real
  // boundary (review of PR #7206, whitlockk + davetho). Two reasons, and both are
  // about this exact effect: reading the property can THROW when the thrown
  // object puts a getter on it, which is the blank page ISS-6995 is about; and
  // the value is untrusted — `reportNextjsError` returns without reporting when
  // the digest names Next control flow, so a forged `NEXT_HTTP_ERROR_FALLBACK;`
  // silences a real error and ships an unvalidated string to Datadog.
  //
  // The capability is untouched where it is actually generated: a real `Error`
  // keeps its digest end to end, which the first case in this file pins
  // (`digest-route-1`), and `notFound()`/`redirect()` throw real Errors.
  // A PLAIN digest, not a `NEXT_…` one, and not a throwing getter: Next reads
  // `.digest` off the thrown value ITSELF (`isNextRouterError`) before handing
  // it to the boundary, so a control-flow digest is rethrown to the router and a
  // getter that throws does so inside Next, never in this effect. Both are
  // covered where they are reachable, against `toReportableError` directly, in
  // `__tests__/lib/datadog-rum-thrown-value.test.ts`.
  it("drops the digest a thrown object supplies, so a forged one cannot suppress the report", async () => {
    const route = createControlledRoute();
    route.throwOnNextRender({ digest: "digest-object-throw" });

    render(
      <ErrorBoundary errorComponent={appErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );

    await screen.findByRole("heading", { name: "Something went wrong" });
    const [reported, context] = reportNextjsError.mock.calls[0] ?? [];
    expect(reported.message).toBe("Non-Error value thrown (object)");
    expect(reported.digest).toBeUndefined();
    expect(context).toEqual({
      digest: undefined,
      source: RumErrorSource.NextjsErrorBoundary,
    });
  });

  it("recovers the route when the user activates Try again after a non-Error throw", async () => {
    const route = createControlledRoute();
    route.throwOnNextRender("transient-non-error");

    render(
      <ErrorBoundary errorComponent={appErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );
    await screen.findByRole("heading", { name: "Something went wrong" });

    route.stopThrowing();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText(RECOVERED_TEXT)).toBeInTheDocument();
  });
});

describe("app/global-error.tsx given a value Next did not promise is an Error", () => {
  it("renders its document shell instead of crashing on a non-Error throw", async () => {
    const route = createControlledRoute();
    route.throwOnNextRender({ code: 500 });

    render(
      <ErrorBoundary errorComponent={globalErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );

    expect(
      await screen.findByRole("heading", { name: "Oops, something went wrong" })
    ).toBeVisible();
    const [reported, context] = reportNextjsError.mock.calls[0] ?? [];
    expect(reported.message).toBe("Non-Error value thrown (object)");
    expect(context).toEqual({
      digest: undefined,
      source: RumErrorSource.GlobalError,
    });
  });
});

/**
 * These render the boundary components directly rather than through
 * `ErrorBoundary`, because Next's boundary unmounts the error component between
 * errors (it renders `children` again on reset), so it never hands the same
 * mounted instance a second `error` object. That makes the `[error]` dependency
 * array unobservable from the mounted path — swapping it for `[]` leaves every
 * mounted test above green. These two pin the effect's dependency contract
 * itself.
 *
 * The two errors deliberately share a message and a digest and differ only in
 * object identity, so a dependency narrowed to `[error.digest]` or
 * `[error.message]` fails here instead of passing. That also rules out
 * `toHaveBeenLastCalledWith`, which compares errors structurally and cannot
 * tell the two apart — these assert on the recorded argument by reference.
 */
describe("error-boundary report effect dependency", () => {
  it("re-reports from app/error.tsx when the error prop changes identity", () => {
    const first = digestError("route render failed", "digest-dep-a");
    const second = digestError("route render failed", "digest-dep-a");

    const view = render(<AppError error={first} reset={noop} />);
    expect(reportNextjsError).toHaveBeenCalledTimes(1);
    expect(reportNextjsError.mock.calls[0]?.[0]).toBe(first);

    view.rerender(<AppError error={first} reset={noop} />);
    expect(reportNextjsError).toHaveBeenCalledTimes(1);

    view.rerender(<AppError error={second} reset={noop} />);
    expect(reportNextjsError).toHaveBeenCalledTimes(2);
    expect(reportNextjsError.mock.calls[1]?.[0]).toBe(second);
    expect(reportNextjsError.mock.calls[1]?.[1]).toEqual({
      digest: "digest-dep-a",
      source: RumErrorSource.NextjsErrorBoundary,
    });
  });

  it("re-reports from app/global-error.tsx when the error prop changes identity", () => {
    const first = digestError("root layout failed", "digest-dep-b");
    const second = digestError("root layout failed", "digest-dep-b");

    const view = render(<GlobalError error={first} retry={noop} />);
    expect(reportNextjsError).toHaveBeenCalledTimes(1);
    expect(reportNextjsError.mock.calls[0]?.[0]).toBe(first);

    view.rerender(<GlobalError error={first} retry={noop} />);
    expect(reportNextjsError).toHaveBeenCalledTimes(1);

    view.rerender(<GlobalError error={second} retry={noop} />);
    expect(reportNextjsError).toHaveBeenCalledTimes(2);
    expect(reportNextjsError.mock.calls[1]?.[0]).toBe(second);
    expect(reportNextjsError.mock.calls[1]?.[1]).toEqual({
      digest: "digest-dep-b",
      source: RumErrorSource.GlobalError,
    });
  });
});

describe("app/global-error.tsx mounted in Next's error boundary", () => {
  it("reports the thrown error with its digest and the global-error source", async () => {
    const route = createControlledRoute();
    const error = digestError("root layout failed", "digest-global-1");
    route.throwOnNextRender(error);

    render(
      <ErrorBoundary errorComponent={globalErrorComponent}>
        <route.Component />
      </ErrorBoundary>
    );

    expect(
      await screen.findByRole("heading", { name: "Oops, something went wrong" })
    ).toBeInTheDocument();
    expect(reportNextjsError).toHaveBeenCalledTimes(1);
    expect(reportNextjsError).toHaveBeenCalledWith(error, {
      digest: "digest-global-1",
      source: RumErrorSource.GlobalError,
    });
  });

  // global-error.tsx REPLACES app/layout.tsx, so it owns the document shell —
  // including `lang`, which nothing else on this path declares.
  it("renders its own <html lang> and <body> document shell", () => {
    const markup = renderToStaticMarkup(
      <GlobalError
        error={digestError("root layout failed", "digest-global-2")}
        retry={noop}
      />
    );

    expect(HTML_ROOT_WITH_LANG.test(markup)).toBe(true);
    expect(BODY_TAG.test(markup)).toBe(true);
    expect(markup).toContain("Oops, something went wrong");
  });

  // ISS-9070: this document renders outside app/layout.tsx, so the `x-nonce`
  // the layout threads to its providers never reaches it — and it needs none.
  // Every script on it is Next's own, which Next stamps with the nonce it
  // parses out of the request's CSP header. A script emitted HERE would carry
  // no nonce, and the enforcing `strict-dynamic` policy would block it.
  //
  // This case owns only that emits-no-script property. That the request really
  // arrives carrying the enforcing policy, and that Next's own parser recovers
  // the policy's nonce from it, is `packages/auth/__tests__/
  // content-security-policy-nonce-forwarding.test.ts`. The browser half —
  // Next's error-recovery document under the enforcing policy, its scripts'
  // nonces, and "Try again" recovering through `retry()` — is
  // `e2e/global-error-csp-nonce.local-trusted.spec.ts` (ISS-10078).
  it("emits no script of its own, leaving only Next's nonced scripts on its document", () => {
    const markup = renderToStaticMarkup(
      <GlobalError
        error={digestError("root layout failed", "digest-global-4")}
        retry={noop}
      />
    );

    expect(markup).not.toContain("<script");
  });

  // ISS-11423: a root-layout failure lives in the server payload, so only a
  // refresh clears it. The route here keeps throwing until `refresh()` runs,
  // which a bare `reset()` never calls.
  it("refreshes the server payload before re-rendering when the user activates Try again", async () => {
    const route = createControlledRoute();
    route.throwOnNextRender(digestError("transient", "digest-global-3"));
    const refresh = vi.fn(() => route.stopThrowing());

    render(
      <AppRouterContext.Provider value={routerWithRefresh(refresh)}>
        <ErrorBoundary errorComponent={globalErrorComponent}>
          <route.Component />
        </ErrorBoundary>
      </AppRouterContext.Provider>
    );
    await screen.findByRole("heading", { name: "Oops, something went wrong" });

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(RECOVERED_TEXT)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Oops, something went wrong" })
    ).toBeNull();
  });
});

const RECOVERED_TEXT = "Route content rendered";
const NOTHING_PENDING = Symbol("nothing pending");
const HTML_ROOT_WITH_LANG = /^<html[^>]*\slang="en"[\s>]/;
const BODY_TAG = /<body[\s>]/;

type DigestError = Error & { digest?: string };

function digestError(message: string, digest: string): DigestError {
  return Object.assign(new Error(message), { digest });
}

function noop(): void {
  // Stands in for callbacks the tests that pass it never exercise.
}

/**
 * Stands in for a route subtree whose render can be flipped between throwing
 * and succeeding. The pending error is read on every render rather than
 * consumed from a queue, so React replaying a failed render cannot change the
 * outcome the test set up.
 */
function createControlledRoute() {
  // A SENTINEL rather than `null` for "do not throw": `null` is itself one of
  // the thrown values under test (ISS-6995), so it cannot double as the
  // absence of one.
  let pending: unknown = NOTHING_PENDING;

  return {
    Component: () => {
      if (pending !== NOTHING_PENDING) {
        throw pending;
      }
      return <p>{RECOVERED_TEXT}</p>;
    },
    throwOnNextRender(thrown: unknown) {
      pending = thrown;
    },
    stopThrowing() {
      pending = NOTHING_PENDING;
    },
  };
}

/**
 * Mounted directly, with no narrowing wrapper in between (ISS-6995).
 *
 * The wrapper that used to sit here threw a `TypeError` on a non-`Error`
 * thrown value, which made the test seam honest about Next's `unknown` while
 * leaving production unguarded — the boundaries themselves declared
 * `Error & { digest?: string }`. They now take `unknown` and narrow with
 * `toReportableError`, so the seam under test IS the production one and the
 * non-Error cases below reach the real component.
 */
const appErrorComponent: ErrorComponent = AppError;
const globalErrorComponent: ErrorComponent = GlobalError;

function routerWithRefresh(refresh: () => void): AppRouterInstance {
  return {
    back: noop,
    forward: noop,
    refresh,
    push: noop,
    replace: noop,
    prefetch: noop,
    bfcacheId: "error-boundaries-test",
  };
}
