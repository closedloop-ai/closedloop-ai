import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthAdapter } from "../../auth/auth-adapter";
import { AuthAdapterProvider } from "../../auth/provider";
import { createStaticAuthAdapter } from "../../auth/static-auth-adapter";
import type { FeatureFlagAdapter } from "../../feature-flags/feature-flag-adapter";
import { FeatureFlagAdapterProvider } from "../../feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../feature-flags/static-feature-flag-adapter";
import { FEATURE_FLAG_RESOLUTION_DEADLINE_MS } from "../../feature-flags/use-feature-flag-enabled";
import { ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY } from "../../lib/feature-flags";
import { DocumentColumn, useColumnVisibility } from "../use-column-visibility";
import { groupExpansionKey, useGroupExpansion } from "../use-group-expansion";
import { useViewStateKey } from "../use-view-state-key";
import { useViewStatePersistence } from "../use-view-state-persistence";

// The Documents index search key, verbatim. Written out rather than imported
// from `apps/app` (a package test cannot reach the app) and deliberately not
// rebuilt from the builder under test.
const SEARCH_BASE_KEY = "table:search:documents-index";
const SEARCH_KEY_ORG_A = "table:search:documents-index::id:user_a:org_a";
const COLUMNS_BASE_KEY = "table:columns:my-tasks";

const ORG_A = "org_a";
const ORG_B = "org_b";
const USER_A = "user_a";

const ENABLED_FLAG_ADAPTER = createStaticFeatureFlagAdapter({
  enabledFlags: [ORG_SCOPED_TABLE_VIEW_STATE_FEATURE_FLAG_KEY],
});
const DISABLED_FLAG_ADAPTER = createStaticFeatureFlagAdapter();

/**
 * The THIRD flag state, which the static adapter cannot express: PostHog has not
 * answered yet. `useFeatureFlagEnabled` reports `false` — that is exactly the
 * collapse under test, an unanswered flag being indistinguishable from a
 * deliberate `false` — while `useFeatureFlagResolved` says so honestly.
 *
 * `enabled: true` is deliberately NOT what this adapter reports. A real
 * unresolved PostHog reports `false`, so a test that pre-answered the flag would
 * be exercising a state production never reaches and would stay green under the
 * very mutation it exists to catch.
 */
const UNRESOLVED_FLAG_ADAPTER: FeatureFlagAdapter = {
  useFeatureFlagEnabled: () => false,
  useFeatureFlagResolved: () => false,
};

// Memoized per organization so the adapter identity is stable across renders,
// which is what the auth port asks implementations for.
const authAdapters = new Map<string, AuthAdapter>();
function authAdapterFor(organizationId: string | null): AuthAdapter {
  const cacheKey = organizationId ?? "__none__";
  const cached = authAdapters.get(cacheKey);
  if (cached) {
    return cached;
  }
  const adapter = createStaticAuthAdapter({
    orgId: organizationId,
    userId: organizationId === null ? null : USER_A,
  });
  authAdapters.set(cacheKey, adapter);
  return adapter;
}

// Mutable ambient state the wrapper reads, so a `rerender()` can move the
// signed-in organization exactly the way switching workspaces does.
let activeOrgId: string | null = ORG_A;
let activeFlagAdapter: FeatureFlagAdapter = ENABLED_FLAG_ADAPTER;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <FeatureFlagAdapterProvider adapter={activeFlagAdapter}>
      <AuthAdapterProvider adapter={authAdapterFor(activeOrgId)}>
        {children}
      </AuthAdapterProvider>
    </FeatureFlagAdapterProvider>
  );
}

beforeEach(() => {
  activeOrgId = ORG_A;
  activeFlagAdapter = ENABLED_FLAG_ADAPTER;
});

afterEach(() => {
  localStorage.clear();
});

function readStoredSearch(key: string): unknown {
  const raw = localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

function renderSearchState() {
  return renderHook(
    () => {
      const key = useViewStateKey(SEARCH_BASE_KEY);
      const [value, setValue] = useViewStatePersistence<string>(key, "");
      return { key, value, setValue };
    },
    { wrapper: Wrapper }
  );
}

describe("organization-namespaced view state (ISS-9726)", () => {
  it("does not carry one organization's search term into another, and still restores it on return", () => {
    const { result, rerender } = renderSearchState();

    act(() => {
      result.current.setValue("acme-only-term");
    });
    expect(result.current.value).toBe("acme-only-term");

    activeOrgId = ORG_B;
    rerender();
    // The decisive assertion: B must not inherit A's term. A test that only
    // checked persistence would pass on the defect this closes.
    expect(result.current.value).toBe("");

    activeOrgId = ORG_A;
    rerender();
    // And the other half: namespacing must not have BROKEN persistence, which
    // is how "B sees nothing" could be true for the wrong reason.
    expect(result.current.value).toBe("acme-only-term");
  });

  it("keeps the two organizations' values in separate stored keys", () => {
    const { result, rerender } = renderSearchState();
    act(() => {
      result.current.setValue("term-a");
    });
    activeOrgId = ORG_B;
    rerender();
    act(() => {
      result.current.setValue("term-b");
    });

    expect(readStoredSearch(SEARCH_KEY_ORG_A)).toMatchObject({
      data: "term-a",
    });
    expect(
      readStoredSearch("table:search:documents-index::id:user_a:org_b")
    ).toMatchObject({ data: "term-b" });
    // Nothing was written to the key every organization used to share.
    expect(localStorage.getItem(SEARCH_BASE_KEY)).toBeNull();
  });

  it("does not adopt pre-existing un-namespaced state into whichever organization is open", () => {
    // The migration decision, asserted: legacy state is NOT read. The stored
    // value could belong to any organization the reader has visited, so
    // attributing it to this one would bake in the very defect being fixed.
    localStorage.setItem(
      SEARCH_BASE_KEY,
      JSON.stringify({ savedAt: Date.now(), data: "legacy-term" })
    );

    const { result } = renderSearchState();

    expect(result.current.value).toBe("");
  });

  it("leaves pre-existing un-namespaced state intact, so turning the flag back off restores it", () => {
    const legacyRaw = JSON.stringify({
      savedAt: Date.now(),
      data: "legacy-term",
    });
    localStorage.setItem(SEARCH_BASE_KEY, legacyRaw);

    const { result, rerender } = renderSearchState();
    act(() => {
      result.current.setValue("namespaced-term");
    });

    // Neither deleted nor rewritten by the namespaced path.
    expect(localStorage.getItem(SEARCH_BASE_KEY)).toBe(legacyRaw);

    activeFlagAdapter = DISABLED_FLAG_ADAPTER;
    rerender();

    expect(result.current.key).toBe(SEARCH_BASE_KEY);
    expect(result.current.value).toBe("legacy-term");
  });

  it("addresses the legacy key while the flag is off", () => {
    activeFlagAdapter = DISABLED_FLAG_ADAPTER;
    const { result } = renderSearchState();

    act(() => {
      result.current.setValue("flag-off-term");
    });

    expect(result.current.key).toBe(SEARCH_BASE_KEY);
    expect(readStoredSearch(SEARCH_BASE_KEY)).toMatchObject({
      data: "flag-off-term",
    });
    expect(localStorage.getItem(SEARCH_KEY_ORG_A)).toBeNull();
  });

  it("prefers the namespaced value over a conflicting legacy value", () => {
    // Both populated, with DIFFERENT contents, so precedence itself is under
    // test rather than a case where either answer would look correct.
    localStorage.setItem(
      SEARCH_BASE_KEY,
      JSON.stringify({ savedAt: Date.now(), data: "legacy-term" })
    );
    localStorage.setItem(
      SEARCH_KEY_ORG_A,
      JSON.stringify({ savedAt: Date.now(), data: "org-a-term" })
    );

    const { result } = renderSearchState();

    expect(result.current.value).toBe("org-a-term");
  });

  it("persists nothing while the signed-in organization is unresolved", () => {
    activeOrgId = null;
    const { result } = renderSearchState();

    expect(result.current.key).toBeNull();
    act(() => {
      result.current.setValue("typed-before-org-resolved");
    });

    expect(result.current.value).toBe("typed-before-org-resolved");
    // Not under the legacy key, and not under any invented "no organization"
    // bucket that a later organization would then read.
    expect(localStorage.length).toBe(0);
  });

  it("hands an unresolved reader no key at all, rather than the legacy one", () => {
    // The headline regression (whitlockk 3966373516 / codex 3966394757). An
    // unanswered flag reads `false`, which is byte-identical to a deliberate
    // `false` — so collapsing the two hands a reader who IS in the enabled
    // cohort the un-namespaced key for the length of PostHog hydration.
    localStorage.setItem(
      SEARCH_BASE_KEY,
      JSON.stringify({ savedAt: Date.now(), data: "previous-org-term" })
    );
    activeFlagAdapter = UNRESOLVED_FLAG_ADAPTER;

    const { result } = renderSearchState();

    expect(result.current.key).toBeNull();
    // The decisive one: the stored term belongs to whichever organization was
    // last open, and restoring it here is the leak this flag exists to close.
    expect(result.current.value).toBe("");
  });

  it("neither reads nor writes the legacy key when an organization switch lands inside the hydration window", () => {
    // The half that makes the window WORSE than not shipping: the restored term
    // is not merely read, the writers behind it persist it back — so the flag
    // meant to stop state crossing organizations carries it across itself.
    const legacyRaw = JSON.stringify({
      savedAt: Date.now(),
      data: "org-a-term",
    });
    localStorage.setItem(SEARCH_BASE_KEY, legacyRaw);
    activeFlagAdapter = UNRESOLVED_FLAG_ADAPTER;

    const { result, rerender } = renderSearchState();
    // Never adopted into the view...
    expect(result.current.value).toBe("");

    act(() => {
      result.current.setValue("typed-in-org-a");
    });
    activeOrgId = ORG_B;
    rerender();

    // ...and never written back under it. The in-memory value survives the
    // switch, which is the documented memory-mode contract and costs nothing:
    // no identity can read it, because it never reaches storage.
    expect(result.current.key).toBeNull();
    expect(localStorage.getItem(SEARCH_BASE_KEY)).toBe(legacyRaw);
    expect(localStorage.length).toBe(1);
  });

  it("lands on the namespaced key, with its stored value, once the flag resolves enabled", () => {
    // The other half of holding: it must be a PAUSE, not a permanent memory
    // mode. A test that only asserted the hold would pass on a hook that never
    // persisted anything again.
    localStorage.setItem(
      SEARCH_KEY_ORG_A,
      JSON.stringify({ savedAt: Date.now(), data: "org-a-term" })
    );
    activeFlagAdapter = UNRESOLVED_FLAG_ADAPTER;
    const { result, rerender } = renderSearchState();
    expect(result.current.key).toBeNull();

    activeFlagAdapter = ENABLED_FLAG_ADAPTER;
    rerender();

    expect(result.current.key).toBe(SEARCH_KEY_ORG_A);
    expect(result.current.value).toBe("org-a-term");
  });

  it("falls through to the legacy key once the resolution deadline passes", () => {
    // The deadline is the load-bearing half of holding. If PostHog never
    // initializes, an unbounded hold is a table that silently stops persisting
    // forever; past the deadline the surface degrades to the pre-flag behavior.
    vi.useFakeTimers();
    try {
      activeFlagAdapter = UNRESOLVED_FLAG_ADAPTER;
      const { result } = renderSearchState();
      expect(result.current.key).toBeNull();

      act(() => {
        vi.advanceTimersByTime(FEATURE_FLAG_RESOLUTION_DEADLINE_MS);
      });

      expect(result.current.key).toBe(SEARCH_BASE_KEY);
    } finally {
      vi.useRealTimers();
    }
  });

  it("degrades a malformed stored value to the default without writing it back", () => {
    localStorage.setItem(SEARCH_KEY_ORG_A, "{not json");

    const { result } = renderSearchState();

    expect(result.current.value).toBe("");
    // Left exactly as found: a corrupt record is not re-persisted in a
    // half-repaired shape.
    expect(localStorage.getItem(SEARCH_KEY_ORG_A)).toBe("{not json");
  });
});

describe("useColumnVisibility organization namespacing (ISS-9726)", () => {
  function renderColumns() {
    return renderHook(
      () => {
        const storageKey = useViewStateKey(COLUMNS_BASE_KEY);
        return useColumnVisibility({
          storageKey,
          columns: [DocumentColumn.Type, DocumentColumn.Priority],
          defaults: {
            [DocumentColumn.Type]: true,
            [DocumentColumn.Priority]: true,
          },
        });
      },
      { wrapper: Wrapper }
    );
  }

  it("does not carry one organization's hidden columns into another, and restores them on return", () => {
    const { result, rerender } = renderColumns();

    act(() => {
      result.current.toggleColumn(DocumentColumn.Priority);
    });
    expect(result.current.visibleColumns).toEqual([DocumentColumn.Type]);

    activeOrgId = ORG_B;
    rerender();
    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Type,
      DocumentColumn.Priority,
    ]);

    activeOrgId = ORG_A;
    rerender();
    expect(result.current.visibleColumns).toEqual([DocumentColumn.Type]);
  });

  it("holds visibility in memory, writing nothing, while the organization is unresolved", () => {
    activeOrgId = null;
    const { result } = renderColumns();

    act(() => {
      result.current.toggleColumn(DocumentColumn.Priority);
    });

    expect(result.current.visibleColumns).toEqual([DocumentColumn.Type]);
    expect(localStorage.length).toBe(0);
  });

  it("keeps a reorderable table reorderable, but memory-only, on a null order key", () => {
    // `orderStorageKey: null` is NOT `undefined`: ordering stays offered, it
    // just has nowhere to persist yet. Reverting that distinction either
    // silently disables reordering or writes this reader's order to a key
    // every organization shares.
    const { result } = renderHook(
      () =>
        useColumnVisibility({
          storageKey: null,
          orderStorageKey: null,
          columns: [DocumentColumn.Type, DocumentColumn.Priority],
          defaults: {
            [DocumentColumn.Type]: true,
            [DocumentColumn.Priority]: true,
          },
        }),
      { wrapper: Wrapper }
    );

    act(() => {
      result.current.reorderColumns([
        DocumentColumn.Priority,
        DocumentColumn.Type,
      ]);
    });

    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Priority,
      DocumentColumn.Type,
    ]);
    expect(localStorage.length).toBe(0);
  });

  it("leaves ordering disabled when the order key is omitted rather than null", () => {
    const { result } = renderHook(
      () =>
        useColumnVisibility({
          storageKey: null,
          columns: [DocumentColumn.Type, DocumentColumn.Priority],
          defaults: {
            [DocumentColumn.Type]: true,
            [DocumentColumn.Priority]: true,
          },
        }),
      { wrapper: Wrapper }
    );

    act(() => {
      result.current.reorderColumns([
        DocumentColumn.Priority,
        DocumentColumn.Type,
      ]);
    });

    // Canonical order preserved: an omitted key means this table never offered
    // reordering, and an unresolved identity must not start offering it.
    expect(result.current.visibleColumns).toEqual([
      DocumentColumn.Type,
      DocumentColumn.Priority,
    ]);
  });
});

describe("useGroupExpansion memory mode (ISS-9726)", () => {
  it("toggles in memory and writes nothing when handed a null key", () => {
    const { result } = renderHook(() => useGroupExpansion(null));

    act(() => {
      result.current.toggleGroup("group-1");
    });

    expect(result.current.isExpanded("group-1")).toBe(true);
    expect(localStorage.length).toBe(0);
  });
});

describe("groupExpansionKey (ISS-9726)", () => {
  it("prefixes a real base", () => {
    expect(groupExpansionKey("documents-index-artifacts", "")).toBe(
      "table:expand:documents-index-artifacts"
    );
    expect(
      groupExpansionKey("documents-index-artifacts", "-group-sections")
    ).toBe("table:expand:documents-index-artifacts-group-sections");
  });

  it("propagates null instead of interpolating it into a shared key", () => {
    // `table:expand:null-group-sections` would be a real key every
    // organization writes to — the exact leak the null arm exists to avoid.
    expect(groupExpansionKey(null, "")).toBeNull();
    expect(groupExpansionKey(null, "-group-sections")).toBeNull();
  });
});
