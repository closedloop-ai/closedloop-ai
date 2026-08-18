import { beforeEach, describe, expect, it, vi } from "vitest";
import CatalogAdminPage from "../page";

const { redirectMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(() => {
    throw new Error("NEXT_REDIRECT");
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

describe("CatalogAdminPage (legacy Packs alias)", () => {
  beforeEach(() => {
    redirectMock.mockClear();
  });

  it("redirects the legacy admin/catalog route to the top-level /packs page", async () => {
    await expect(
      CatalogAdminPage({ params: Promise.resolve({ orgSlug: "test-org" }) })
    ).rejects.toThrow("NEXT_REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/test-org/packs");
  });
});
