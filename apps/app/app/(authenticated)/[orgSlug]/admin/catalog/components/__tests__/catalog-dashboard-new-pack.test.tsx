/**
 * ISS-6679: the "New Pack" funnel, end to end at the `CatalogDashboard`
 * boundary.
 *
 * `create-pack-dialog.test.tsx` mocks `useCreateCatalogItem`, and
 * `catalog-dashboard.test.tsx` mocks the dialog out entirely — so between them
 * the button that opens the dialog, the create mutation's cache invalidation,
 * the refetch it triggers, and the created pack reaching the grid could all
 * break with both suites green. This file mocks NOTHING between the button and
 * the transport: the real dashboard, the real dialog, the real `use-catalog`
 * hooks and a real `QueryClient`, with the shared API client as the only seam.
 *
 * The invalidation is asserted as a REFETCH the fake transport actually
 * received, not as a spy on `invalidateQueries` — a key typo satisfies the spy
 * and fails the refetch.
 */
import type {
  CatalogItemDto,
  CreateCatalogItemRequest,
} from "@repo/api/src/types/distribution";
import {
  CatalogItemScope,
  CatalogItemSource,
} from "@repo/api/src/types/distribution";
import { createTestQueryClient } from "@repo/app/shared/test-utils";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CatalogDashboard } from "../catalog-dashboard";

const CATALOG_PATH = "/catalog";
const DISTRIBUTIONS_PATH = "/distributions";
/** `CreateCatalogItemRequest.targetKind` is a bare `string` with no const to import. */
const PACK_TARGET_KIND = "pack";

const NEW_PACK_BUTTON = "New Pack";
const CREATE_BUTTON = "Create Pack";
const DONE_BUTTON = "Done";
const PACK_NAME = "Platform Standards";
const RE_NAME_FIELD = /^Name/;
const RE_CREATED_CONFIRMATION = /^Created/;
const GRID_EMPTY_TITLE = "No packs match your filters";
/**
 * Explicit, because these mount the real workspace + detail tree against a real
 * QueryClient and land near Vitest's 5s default (~3s each locally). Stated here
 * rather than inherited so a genuine hang still fails on a bound this file owns
 * — never raised to make a failing assertion pass.
 */
const INTEGRATION_TIMEOUT_MS = 20_000;
const DIALOG_ROLE = "dialog";
const BUTTON_ROLE = "button";

/** The org catalog the fake transport serves, mutated by a successful create. */
let serverCatalog: CatalogItemDto[] = [];
/** Every path handed to `apiClient.get`, in order — the refetch evidence. */
let getPaths: string[] = [];

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
}));

/**
 * The one seam. It serves the same three read families the real API does, out
 * of `serverCatalog` — the detail read included, because the dashboard hydrates
 * whatever pack is selected and a stub that answered every path with `[]` would
 * hand `catalogItemToPackView` an array where an item belongs.
 */
vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({
    get: (path: string) => {
      getPaths.push(path);
      if (path === CATALOG_PATH) {
        return Promise.resolve([...serverCatalog]);
      }
      if (path.startsWith(`${CATALOG_PATH}/`)) {
        const id = path.slice(CATALOG_PATH.length + 1);
        const found = serverCatalog.find((item) => item.id === id);
        return found
          ? Promise.resolve(found)
          : Promise.reject(new Error(`No catalog item ${id}`));
      }
      // Distributions and the peripheral reads the surface makes (compute
      // targets, analytics) are empty collections for this flow.
      return Promise.resolve([]);
    },
    post: mocks.post,
    patch: vi.fn().mockResolvedValue({}),
    delete: vi.fn().mockResolvedValue({}),
  }),
}));

// PostHog is not available in jsdom, and every packs flag is closed by default
// (ISS-4779) — `false` is the shipped state, so the surface under test is the
// one an admin actually sees today.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => false,
  // ISS-6925: this suite's cases run with routed selection OFF (settled), which
  // is the component-state shape they were written against.
  useFeatureFlagGate: () => ({
    enabled: false,
    isReady: true,
    isResolved: true,
  }),
}));

// The selected pack's detail renders `PackDetail`, whose tabs read the URL
// through the navigation port. `vitest.setup.ts` delegates that port back to
// `next/navigation`, so this is the seam a jsdom render has to fill.
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: "org-test" }),
  usePathname: () => "/org-test/packs",
  useRouter: () => ({
    back: vi.fn(),
    push: vi.fn(),
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

function makePack(overrides: Partial<CatalogItemDto> = {}): CatalogItemDto {
  return {
    agentSlug: null,
    archived: false,
    coaching: false,
    coachingConfig: null,
    components: [],
    content: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    createdById: "user-1",
    description: null,
    enabled: true,
    id: "pack-created-1",
    logoUrl: null,
    name: PACK_NAME,
    organizationId: "org-1",
    parentPackId: null,
    scope: CatalogItemScope.Org,
    sortOrder: 0,
    source: CatalogItemSource.OrgCustom,
    targetKind: PACK_TARGET_KIND,
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: "1.0.0",
    ...overrides,
  };
}

function renderDashboard(isAdmin = true) {
  const queryClient = createTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(<CatalogDashboard isAdmin={isAdmin} />, { wrapper });
}

function countGets(path: string): number {
  return getPaths.filter((candidate) => candidate === path).length;
}

/** Wait for the first catalog read to settle, so the grid — not the skeleton — is on screen. */
async function waitForLoadedGrid(): Promise<void> {
  await screen.findByText(GRID_EMPTY_TITLE);
}

/**
 * Open the real dialog from the real toolbar button, and hand back the dialog
 * so every assertion about it is scoped inside it — "New Pack" is both the
 * button's label and the dialog's title, so an unscoped text query matches both.
 */
async function openCreateDialog(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole(BUTTON_ROLE, { name: NEW_PACK_BUTTON }));
  return await screen.findByRole(DIALOG_ROLE);
}

describe("CatalogDashboard — New Pack funnel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serverCatalog = [];
    getPaths = [];
  });

  it(
    "creates a pack from the New Pack button and lands it in the grid",
    async () => {
      const created = makePack();
      mocks.post.mockImplementation((path: string) => {
        if (path !== CATALOG_PATH) {
          return Promise.resolve({});
        }
        // The server now holds it, so the refetch the invalidation triggers is
        // what puts it on screen — not a client-side optimistic insert.
        serverCatalog = [created];
        return Promise.resolve(created);
      });

      renderDashboard();
      await waitForLoadedGrid();
      const catalogGetsBeforeCreate = countGets(CATALOG_PATH);
      // The grid genuinely started empty, so the card asserted below cannot be a
      // pack that was already there.
      expect(screen.queryByTestId(`pack-card-${created.id}`)).toBeNull();

      // The step neither existing suite covers: the toolbar button is what mounts
      // the real dialog.
      const dialog = await openCreateDialog();

      fireEvent.change(within(dialog).getByLabelText(RE_NAME_FIELD), {
        target: { value: PACK_NAME },
      });
      fireEvent.click(
        within(dialog).getByRole(BUTTON_ROLE, { name: CREATE_BUTTON })
      );

      await waitFor(() => expect(mocks.post).toHaveBeenCalled());
      // The wire shape, not merely "it was called": `targetKind` is what makes the
      // new row a Pack CONTAINER rather than a standalone component.
      const expectedRequest: CreateCatalogItemRequest = {
        coaching: undefined,
        description: undefined,
        name: PACK_NAME,
        targetKind: PACK_TARGET_KIND,
      };
      expect(mocks.post).toHaveBeenCalledWith(CATALOG_PATH, expectedRequest);

      // The invalidation actually reached the transport as a second read...
      await waitFor(() =>
        expect(countGets(CATALOG_PATH)).toBeGreaterThan(catalogGetsBeforeCreate)
      );
      // ...and the refetched list reached the grid. This is the assertion that
      // spans `useCreateCatalogItem` → `catalogKeys.lists()` → `useCatalogItems`
      // → `useAdminPackViews` → `PacksWorkspace`; every existing test stops short
      // of at least one of those hops.
      expect(
        await screen.findByTestId(`pack-card-${created.id}`)
      ).toBeDefined();

      // The dialog became its created state rather than closing — the fact a
      // "did it close?" assertion gets backwards.
      expect(within(dialog).getByText(RE_CREATED_CONFIRMATION)).toBeDefined();

      fireEvent.click(
        within(dialog).getByRole(BUTTON_ROLE, { name: DONE_BUTTON })
      );
      await waitFor(() => expect(screen.queryByRole(DIALOG_ROLE)).toBeNull());
      // Reopening lands on a blank form, not the previous pack's created state.
      const reopened = await openCreateDialog();
      expect(within(reopened).getByLabelText(RE_NAME_FIELD)).toHaveValue("");
      expect(within(reopened).queryByText(RE_CREATED_CONFIRMATION)).toBeNull();
    },
    INTEGRATION_TIMEOUT_MS
  );

  it(
    "opens the created pack's authoring affordances from the grid",
    async () => {
      const created = makePack();
      mocks.post.mockImplementation((path: string) => {
        serverCatalog = path === CATALOG_PATH ? [created] : serverCatalog;
        return Promise.resolve(created);
      });

      renderDashboard();
      await waitForLoadedGrid();
      const dialog = await openCreateDialog();
      fireEvent.change(within(dialog).getByLabelText(RE_NAME_FIELD), {
        target: { value: PACK_NAME },
      });
      fireEvent.click(
        within(dialog).getByRole(BUTTON_ROLE, { name: CREATE_BUTTON })
      );
      const card = await screen.findByTestId(`pack-card-${created.id}`);
      fireEvent.click(
        within(dialog).getByRole(BUTTON_ROLE, { name: DONE_BUTTON })
      );
      await waitFor(() => expect(screen.queryByRole(DIALOG_ROLE)).toBeNull());

      fireEvent.click(card);

      // The pack the dashboard resolves for its detail is the one the create
      // returned, resolved out of the REFETCHED list — an item the dashboard
      // never held before this flow. Its admin authoring affordances are the
      // observable proof `selectedItem` bound to a Pack container: `Add component`
      // renders only for `isAdmin && selectedIsPack`.
      const detail = await screen.findByRole(BUTTON_ROLE, {
        name: "Add component",
      });
      expect(detail).toBeDefined();
      expect(screen.getByRole(BUTTON_ROLE, { name: "Archive" })).toBeDefined();
    },
    INTEGRATION_TIMEOUT_MS
  );

  it(
    "keeps a refused create off the grid and states the refusal in the dialog",
    async () => {
      const refusal = new Error("You do not have permission to create packs.");
      mocks.post.mockRejectedValue(refusal);

      renderDashboard();
      await waitForLoadedGrid();
      const catalogGetsBeforeCreate = countGets(CATALOG_PATH);
      const dialog = await openCreateDialog();

      fireEvent.change(within(dialog).getByLabelText(RE_NAME_FIELD), {
        target: { value: PACK_NAME },
      });
      fireEvent.click(
        within(dialog).getByRole(BUTTON_ROLE, { name: CREATE_BUTTON })
      );

      expect(await within(dialog).findByText(refusal.message)).toBeDefined();
      // A failed create must not invalidate: refetching here would replace the
      // list the admin is looking at on the strength of a write that never landed.
      expect(countGets(CATALOG_PATH)).toBe(catalogGetsBeforeCreate);
      // Still the form, so the admin can retry, and nothing was added.
      expect(
        within(dialog).getByRole(BUTTON_ROLE, { name: CREATE_BUTTON })
      ).toBeDefined();
      expect(within(dialog).queryByText(RE_CREATED_CONFIRMATION)).toBeNull();
      expect(screen.getByText(GRID_EMPTY_TITLE)).toBeDefined();
    },
    INTEGRATION_TIMEOUT_MS
  );

  it(
    "never issues the create request when the name is blank",
    async () => {
      renderDashboard();
      await waitForLoadedGrid();
      const dialog = await openCreateDialog();

      fireEvent.change(within(dialog).getByLabelText(RE_NAME_FIELD), {
        target: { value: "   " },
      });
      fireEvent.click(
        within(dialog).getByRole(BUTTON_ROLE, { name: CREATE_BUTTON })
      );

      await within(dialog).findByText("Name is required.");
      // The assertion the message alone cannot make: a dialog that complained AND
      // posted anyway would satisfy the line above and fail this one.
      expect(mocks.post).not.toHaveBeenCalled();
    },
    INTEGRATION_TIMEOUT_MS
  );

  it(
    "hides the New Pack funnel from a non-admin",
    async () => {
      renderDashboard(false);

      await waitForLoadedGrid();
      expect(
        screen.queryByRole(BUTTON_ROLE, { name: NEW_PACK_BUTTON })
      ).toBeNull();
      // The member surface must not fetch the admin-only distributions list at
      // all — `useAdminPackViews` disables it rather than merely ignoring it.
      expect(countGets(DISTRIBUTIONS_PATH)).toBe(0);
    },
    INTEGRATION_TIMEOUT_MS
  );
});
