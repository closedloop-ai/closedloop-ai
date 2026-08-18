import type { ApiKey } from "@repo/api/src/types/api-key";
import { API_KEY_SCOPES, ApiKeyScope } from "@repo/api/src/types/api-key";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiKeysSettingsPanel } from "../api-keys-settings-panel";

const mocks = vi.hoisted(() => ({
  usePlatformApiKeys: vi.fn(),
  useCreatePlatformApiKey: vi.fn(),
  useRevokePlatformApiKey: vi.fn(),
}));

vi.mock("@repo/app/api-keys/hooks/use-platform-api-keys", () => ({
  usePlatformApiKeys: mocks.usePlatformApiKeys,
  useCreatePlatformApiKey: mocks.useCreatePlatformApiKey,
  useRevokePlatformApiKey: mocks.useRevokePlatformApiKey,
}));

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_MCP_SERVER_URL: "https://mcp.example.test" },
}));

// Radix's tooltip content measures its trigger with ResizeObserver, which jsdom
// does not implement. Stubbed per test and unstubbed in afterEach so the global
// never leaks past the case that needs it.
class MockResizeObserver {
  observe() {
    // no-op
  }
  unobserve() {
    // no-op
  }
  disconnect() {
    // no-op
  }
}

const CREATED_AT = new Date("2026-01-02T03:04:05.000Z");

/** Column order of the API-keys table; the Scope cell is the third. */
const SCOPE_CELL_INDEX = 2;

const UNKNOWN_SCOPE_EXPLANATION =
  "We can't confirm this key's access. It may have more than shown.";

/**
 * Comfortably past the design-system `TooltipProvider` open delay (700ms at the
 * time of writing). A ceiling rather than the exact value so the test drives the
 * clock past the delay without pinning a number the design system owns.
 */
const TOOLTIP_OPEN_CEILING_MS = 2000;

/**
 * The badge classes carried by each design-system variant the Scope column
 * uses, so a state that renders unstyled (or with a variant that is not the one
 * the scope map assigns) fails rather than passing on label text alone.
 */
const VARIANT_MARKER_CLASS = {
  accent: "bg-primary/10",
  warning: "bg-warning/14",
} as const;

/**
 * `usePlatformApiKeys` casts the parsed `/api-keys` body to `ApiKey[]` without
 * validating it, so the `scopes` field is a trust boundary: these shapes are
 * unreachable through the type but reachable at runtime.
 */
const MALFORMED_SCOPE_FIELDS: [string, unknown][] = [
  ["null", null],
  ["absent", undefined],
  ["a bare string", ApiKeyScope.Read],
  ["an array with a non-string member", [ApiKeyScope.Read, 7]],
  ["an object", { read: true }],
];

function makeKey(scopes: string[]): ApiKey {
  return {
    id: `key-${scopes.join("-") || "none"}`,
    organizationId: "org-1",
    userId: "user-1",
    name: "Desktop",
    keyPrefix: "sk_live_abc",
    expiresAt: null,
    // The wire can carry a scope this build does not know; the panel type is
    // narrower than the runtime payload, which is exactly what the Unknown
    // state exists for.
    scopes: scopes as ApiKey["scopes"],
    lastUsedAt: null,
    createdAt: CREATED_AT,
    revokedAt: null,
  };
}

function renderWithKeyScopes(scopes: string[]) {
  mocks.usePlatformApiKeys.mockReturnValue({
    data: [makeKey(scopes)],
    isLoading: false,
  });
  return render(<ApiKeysSettingsPanel />);
}

/**
 * The Scope cell of the single rendered key row, found positionally rather than
 * by its text, so a wrong label cannot make the lookup miss and pass vacuously.
 */
function getScopeCell(): HTMLElement {
  const dataRow = screen.getAllByRole("row").at(1);
  if (!dataRow) {
    throw new Error("no API key row rendered");
  }
  const cell = dataRow.querySelectorAll("td").item(SCOPE_CELL_INDEX);
  if (!cell) {
    throw new Error("no Scope cell rendered");
  }
  return cell;
}

function getScopeBadge(): HTMLElement {
  const badge = getScopeCell().querySelector('[data-slot="badge"]');
  if (!(badge instanceof HTMLElement)) {
    throw new Error("no Scope badge rendered");
  }
  return badge;
}

/** The Scope cell renders a pill only where the row is worth stopping on. */
function hasScopePill(): boolean {
  return getScopeCell().querySelector('[data-slot="badge"]') !== null;
}

describe("ApiKeysSettingsPanel scope badge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", MockResizeObserver);
    vi.clearAllMocks();
    mocks.useCreatePlatformApiKey.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    });
    mocks.useRevokePlatformApiKey.mockReturnValue({
      mutateAsync: vi.fn(),
      isPending: false,
    });
  });

  it("names delete for a full-access key instead of collapsing it into read & write", () => {
    renderWithKeyScopes([
      ApiKeyScope.Read,
      ApiKeyScope.Write,
      ApiKeyScope.Delete,
    ]);

    expect(getScopeCell().textContent).toBe("Read, write, delete");
    expect(screen.queryByText("Read & Write")).toBeNull();
  });

  it("renders the routine full-access scope as plain text, not a pill", () => {
    renderWithKeyScopes([
      ApiKeyScope.Read,
      ApiKeyScope.Write,
      ApiKeyScope.Delete,
    ]);

    // Every key the API issues today carries these three scopes, so a pill here
    // would be the identical string repeated down every row.
    expect(hasScopePill()).toBe(false);
  });

  it("never renders an admin key as read only", () => {
    renderWithKeyScopes([ApiKeyScope.Read, ApiKeyScope.Admin]);

    const badge = getScopeBadge();
    expect(badge.textContent).toBe("Read, admin");
    expect(badge.className).toContain(VARIANT_MARKER_CLASS.accent);
    expect(screen.queryByText("Read only")).toBeNull();
  });

  it("renders an admin-only key as admin", () => {
    renderWithKeyScopes([ApiKeyScope.Admin]);

    expect(getScopeBadge().textContent).toBe("Admin");
    expect(screen.queryByText("Read only")).toBeNull();
  });

  it("keeps the warning tone for unknown alone, not for admin", () => {
    renderWithKeyScopes([ApiKeyScope.Admin]);
    const adminBadge = getScopeBadge();
    expect(adminBadge.className).toContain(VARIANT_MARKER_CLASS.accent);
    expect(adminBadge.className).not.toContain(VARIANT_MARKER_CLASS.warning);

    cleanup();
    renderWithKeyScopes([]);
    expect(getScopeBadge().className).toContain(VARIANT_MARKER_CLASS.warning);
  });

  it("keeps read only for a legacy read-scoped key", () => {
    renderWithKeyScopes([ApiKeyScope.Read]);

    expect(getScopeCell().textContent).toBe("Read only");
    expect(hasScopePill()).toBe(false);
  });

  it("renders read, write for a key without delete or admin", () => {
    renderWithKeyScopes([ApiKeyScope.Read, ApiKeyScope.Write]);

    expect(getScopeCell().textContent).toBe("Read, write");
    expect(hasScopePill()).toBe(false);
  });

  it("does not invent read and write for a delete-only key", () => {
    renderWithKeyScopes([ApiKeyScope.Delete]);

    expect(getScopeCell().textContent).toBe("Delete");
    expect(screen.queryByText("Read, write, delete")).toBeNull();
  });

  it("names only the scopes a partial key carries", () => {
    renderWithKeyScopes([ApiKeyScope.Write, ApiKeyScope.Delete]);

    expect(getScopeCell().textContent).toBe("Write, delete");
  });

  it("renders a styled unknown badge for a key with no scopes rather than read only", () => {
    renderWithKeyScopes([]);

    const badge = getScopeBadge();
    expect(badge.textContent).toBe("Unknown");
    expect(badge.className).toContain(VARIANT_MARKER_CLASS.warning);
    expect(screen.queryByText("Read only")).toBeNull();
  });

  it("renders a styled unknown badge when the key carries an unrecognized scope", () => {
    renderWithKeyScopes([ApiKeyScope.Read, "supervise"]);

    const badge = getScopeBadge();
    expect(badge.textContent).toBe("Unknown");
    expect(badge.className).toContain(VARIANT_MARKER_CLASS.warning);
    expect(screen.queryByText("Read only")).toBeNull();
  });

  it("explains the unknown state through a focusable tooltip, not a native title", async () => {
    // Pin the clock rather than racing the Tooltip's open delay against the
    // query timeout: the wait is driven, not hoped for.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderWithKeyScopes([]);

      const cell = getScopeCell();
      expect(cell.querySelector("[title]")).toBeNull();

      const trigger = within(cell).getByRole("button");
      // The visible affordance: the pill carries an icon telling the reader
      // there is more to read, rather than hiding it behind a hover-only title.
      expect(trigger.querySelector("svg")).not.toBeNull();

      trigger.focus();
      await vi.advanceTimersByTimeAsync(TOOLTIP_OPEN_CEILING_MS);

      const tooltip = screen.getByRole("tooltip");
      expect(tooltip.textContent).toContain(UNKNOWN_SCOPE_EXPLANATION);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wrap a self-explanatory scope in a tooltip trigger", () => {
    renderWithKeyScopes([
      ApiKeyScope.Read,
      ApiKeyScope.Write,
      ApiKeyScope.Delete,
    ]);

    const cell = getScopeCell();
    expect(within(cell).queryByRole("button")).toBeNull();
    expect(cell.querySelector("[title]")).toBeNull();
  });

  it("renders every scope in the contract, and never names a scope the key lacks", () => {
    for (const scope of API_KEY_SCOPES) {
      mocks.usePlatformApiKeys.mockReturnValue({
        data: [makeKey([scope])],
        isLoading: false,
      });
      const { unmount } = render(<ApiKeysSettingsPanel />);

      const label = (getScopeCell().textContent ?? "").toLowerCase();
      expect(label).toContain(scope);
      for (const other of API_KEY_SCOPES) {
        if (other !== scope) {
          expect(label).not.toContain(other);
        }
      }
      // A pill is reserved for the states worth stopping on; where one is
      // rendered it must carry a real design-system variant, never unstyled.
      if (hasScopePill()) {
        const styled = Object.values(VARIANT_MARKER_CLASS).some((marker) =>
          getScopeBadge().className.includes(marker)
        );
        expect(styled).toBe(true);
      }

      unmount();
    }
  });

  it("renders Unknown instead of crashing when the scopes field is malformed", () => {
    for (const [description, scopes] of MALFORMED_SCOPE_FIELDS) {
      mocks.usePlatformApiKeys.mockReturnValue({
        data: [{ ...makeKey([]), scopes: scopes as ApiKey["scopes"] }],
        isLoading: false,
      });

      // The panel must still render: one malformed row cannot take the whole
      // Settings surface down.
      render(<ApiKeysSettingsPanel />);
      expect(getScopeCell().textContent, description).toBe("Unknown");
      expect(getScopeBadge().className, description).toContain(
        VARIANT_MARKER_CLASS.warning
      );
      expect(screen.queryByText("Read only"), description).toBeNull();
      cleanup();
    }
  });

  it("spends the pill only on admin and unknown", () => {
    const pillByScopes: [string[], boolean][] = [
      [[ApiKeyScope.Read], false],
      [[ApiKeyScope.Read, ApiKeyScope.Write], false],
      [[ApiKeyScope.Read, ApiKeyScope.Write, ApiKeyScope.Delete], false],
      [[ApiKeyScope.Delete], false],
      [[ApiKeyScope.Admin], true],
      [[ApiKeyScope.Read, ApiKeyScope.Admin], true],
      [[], true],
      [[ApiKeyScope.Read, "supervise"], true],
    ];

    for (const [scopes, expectedPill] of pillByScopes) {
      renderWithKeyScopes(scopes);
      expect(hasScopePill()).toBe(expectedPill);
      cleanup();
    }
  });
});
