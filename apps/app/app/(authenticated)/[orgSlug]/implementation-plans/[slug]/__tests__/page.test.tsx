import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// ISS-4526: render-smoke the implementation-plan document-editor page wrapper.
// This mounts the REAL page -> REAL PlanEditorContainer down to its
// provider-requiring TanStack Query hook (`useDocumentBySlug`) under the
// required QueryClientProvider, and asserts the wrapper renders WITHOUT
// THROWING. This guards the mount-site-provider regression class: a shared
// container that newly calls a provider-requiring hook would throw at mount if
// the provider were absent.
//
// The API client is stubbed to a never-settling promise so the query stays
// pending and the container renders its loading state, keeping the smoke test
// on the lightweight loading branch rather than descending into the heavy
// Liveblocks editor subtree (which has its own dedicated coverage).
const { notFound, useRouter, usePathname, useSearchParams } = vi.hoisted(
  () => ({
    notFound: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    }),
    // Provide the full navigation-hook surface the real container subtree can
    // reach (e.g. after a loading-path change), so a smoke failure means the
    // page lacks a provider — not that a hook is undefined.
    useRouter: vi.fn(() => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    })),
    usePathname: vi.fn(() => "/"),
    useSearchParams: vi.fn(() => new URLSearchParams()),
  })
);

vi.mock("next/navigation", () => ({
  notFound,
  useRouter,
  usePathname,
  useSearchParams,
}));

const { pendingGet } = vi.hoisted(() => ({
  pendingGet: vi.fn(() => new Promise(() => undefined)),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ get: pendingGet }),
}));

import ImplementationPlanPage from "../page";

function makeParams(slug: string, version?: string) {
  return {
    params: Promise.resolve({ orgSlug: "acme", slug }),
    searchParams: Promise.resolve(version ? { version } : {}),
  };
}

function renderWithProviders(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
  );
}

describe("ImplementationPlanPage (/implementation-plans/[slug]) mount smoke", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the plan editor wrapper without throwing under the required providers", async () => {
    const page = await ImplementationPlanPage(makeParams("auth-rollout"));

    const { container } = renderWithProviders(page);

    // A stable root rendered (the container's loading state) and no branch
    // 404'd or threw during mount.
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(notFound).not.toHaveBeenCalled();
    // No version param supplied -> the fetch omits it (distinguishes this case
    // from the versioned one below).
    expect(pendingGet).toHaveBeenCalledWith(
      expect.not.stringContaining("version=")
    );
  });

  it("passes a valid version param through to the document fetch", async () => {
    const page = await ImplementationPlanPage(makeParams("auth-rollout", "2"));

    const { container } = renderWithProviders(page);

    expect(container.querySelector(".animate-spin")).not.toBeNull();
    expect(notFound).not.toHaveBeenCalled();
    // Proves version=2 actually reaches the fetch: this fails if the page drops
    // the version and fetches latest, so it no longer mirrors the unversioned
    // case.
    expect(pendingGet).toHaveBeenCalledWith(
      expect.stringContaining("version=2")
    );
  });
});
