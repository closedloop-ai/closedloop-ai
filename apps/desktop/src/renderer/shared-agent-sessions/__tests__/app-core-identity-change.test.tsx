import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { useAgentSessionsDataSource } from "@repo/app/agents/data-source/provider";
import { useCustomFieldsForEntityType } from "@repo/app/custom-fields/hooks/use-custom-fields";
import { makeField } from "@repo/app/custom-fields/lib/__tests__/custom-field-details-fixtures";
import { queryCacheScopeOf } from "@repo/app/shared/query/query-cache-scope";
import { currentQueryCacheScope } from "@repo/app/shared/query/query-client";
import { onlineManager, useQueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import type { DesktopAuthState } from "../../types/desktop-api";
import { DesktopAppCoreMode } from "../desktop-app-core-mode";
import {
  DesktopAppCoreProvider,
  useDesktopAppCoreMode,
} from "../desktop-app-core-provider";

/**
 * ISS-12302 review: a direct authenticated identity change keeps the app-core
 * mode (Cloud), so it keeps the app-core `QueryClient`, and the custom-field
 * definitions both Details hosts read sit under the org-agnostic
 * `customFieldKeys.list({})`. The next organization must read its own fields,
 * never the previous organization's from cache.
 */

const FIRST: DesktopAuthState = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user-1",
  organizationId: "org-1",
};
const SECOND: DesktopAuthState = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user-2",
  organizationId: "org-2",
};

const FIELDS_BY_ORG: Record<string, CustomFieldWithOptions[]> = {
  "org-1": [
    makeField("org-1-risk", CustomFieldType.Text, {
      name: "Org one risk",
      organizationId: "org-1",
    }),
  ],
  "org-2": [
    makeField("org-2-estimate", CustomFieldType.Number, {
      name: "Org two estimate",
      organizationId: "org-2",
    }),
  ],
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function setupDesktopApi() {
  const listeners = new Set<(state: DesktopAuthState) => void>();
  let current = FIRST;
  const cloudApiFetch = vi.fn(async (_request: { path: string }) => ({
    kind: "response" as const,
    status: 200,
    statusText: "OK",
    headers: [["content-type", "application/json"]] as [string, string][],
    bodyText: JSON.stringify({
      success: true,
      data: FIELDS_BY_ORG[current.organizationId ?? ""] ?? [],
    }),
  }));
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      cloudApiFetch,
      getDesktopAuthState: vi.fn(() => Promise.resolve(FIRST)),
      onDesktopAuthStateChanged: vi.fn(
        (listener: (state: DesktopAuthState) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        }
      ),
    },
  });
  return {
    cloudApiFetch,
    push(state: DesktopAuthState) {
      current = state;
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
}

function forceOnline(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
  return () => {
    if (original) {
      Object.defineProperty(window.navigator, "onLine", original);
    } else {
      Reflect.deleteProperty(window.navigator, "onLine");
    }
  };
}

let restoreOnline: (() => void) | null = null;

afterEach(() => {
  onlineManager.setOnline(true);
  restoreOnline?.();
  restoreOnline = null;
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

function definitionReads(
  cloudApiFetch: ReturnType<typeof setupDesktopApi>["cloudApiFetch"]
) {
  return cloudApiFetch.mock.calls.filter(([request]) =>
    request.path.includes("/custom-fields")
  );
}

function fieldNames(fields: readonly CustomFieldWithOptions[] | undefined) {
  return (fields ?? []).map((field) => field.name);
}

describe("Desktop app-core cache across a direct identity change", () => {
  it("AC-009 DT-SP-14 serves the next organization its own fields and source cache", async () => {
    restoreOnline = forceOnline(true);
    const { cloudApiFetch, push } = setupDesktopApi();
    const { result } = renderHook(
      () => ({
        client: useQueryClient(),
        fields: useCustomFieldsForEntityType(CustomFieldEntityType.Session),
        mode: useDesktopAppCoreMode(),
        sessionsSource: useAgentSessionsDataSource(),
      }),
      { wrapper: DesktopAppCoreProvider }
    );
    await waitFor(() =>
      expect(fieldNames(result.current.fields.data)).toEqual(["Org one risk"])
    );
    expect(result.current.mode).toBe(DesktopAppCoreMode.Cloud);
    const client = result.current.client;
    const sessionsSource = result.current.sessionsSource;
    const readsBefore = definitionReads(cloudApiFetch).length;

    act(() => push(SECOND));

    // Still Cloud on the same client: this is the transition the mode-keyed
    // rebuild never sees.
    expect(result.current.mode).toBe(DesktopAppCoreMode.Cloud);
    expect(result.current.client).toBe(client);
    expect(result.current.sessionsSource).not.toBe(sessionsSource);
    expect(fieldNames(result.current.fields.data)).not.toContain(
      "Org one risk"
    );
    await waitFor(() =>
      expect(fieldNames(result.current.fields.data)).toEqual([
        "Org two estimate",
      ])
    );
    expect(definitionReads(cloudApiFetch).length).toBe(readsBefore + 1);
    // The first organization's rows are gone, not merely shadowed.
    const cached = client
      .getQueryCache()
      .getAll()
      .map((query) => JSON.stringify(query.state.data ?? null));
    expect(cached.some((data) => data.includes("Org one risk"))).toBe(false);
    // The identity a late write snapshots and compares against (ISS-7442).
    expect(currentQueryCacheScope(client)).toBe(
      queryCacheScopeOf(SECOND.userId, SECOND.organizationId)
    );
  });
});
