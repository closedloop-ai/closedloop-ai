import { makeBranchDetail } from "@repo/app/branches/__tests__/branch-fixtures";
import { createHttpBranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { focusManager } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import BranchDetailRoutePage from "../page";

vi.mock("@/hooks/use-org-slug", () => ({ useOrgSlug: () => "acme" }));
vi.mock("@repo/navigation/use-route-params", () => ({
  useRouteParams: () => ({ branchId: "branch-1" }),
}));
vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(),
}));
vi.mock("@/app/(authenticated)/components/header", () => ({
  Header: () => null,
}));
vi.mock("@repo/app/github/hooks/use-post-connect-backfill", () => ({
  usePostConnectBackfill: () => undefined,
}));
vi.mock(
  "@repo/app/branches/components/branch-detail-page",
  async (original) => ({
    ...(await original<
      typeof import("@repo/app/branches/components/branch-detail-page")
    >()),
    BranchDetailPage: () => null,
  })
);

afterEach(() => {
  focusManager.setFocused(undefined);
  vi.useRealTimers();
});

it("web route mounts once through two idle minutes and one focus event", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  const get = vi.fn().mockResolvedValue(makeBranchDetail());
  const source = createHttpBranchesDataSource({ get });
  const view = render(
    <AppCoreStoryProviders>
      <BranchesDataSourceProvider dataSource={source}>
        <BranchDetailRoutePage />
      </BranchesDataSourceProvider>
    </AppCoreStoryProviders>
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  act(() => focusManager.setFocused(false));
  act(() => focusManager.setFocused(true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20);
  });
  expect(get).toHaveBeenCalledTimes(1);
  view.unmount();
});
