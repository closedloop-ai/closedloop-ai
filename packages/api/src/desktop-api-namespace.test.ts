import { describe, expect, it } from "vitest";
import {
  CURRENT_DESKTOP_API_NAMESPACE,
  DESKTOP_API_NAMESPACE_CAPABILITY_KEY,
  DESKTOP_API_PREFIX,
  getDesktopApiNamespaceFromCapabilities,
  isDesktopApiNamespace,
  isDesktopApiPath,
  rewriteDesktopApiPath,
  withDesktopApiNamespaceCapability,
} from "./desktop-api-namespace.ts";

describe("desktop API namespace", () => {
  it("recognizes only the current namespace and path prefix", () => {
    expect(isDesktopApiNamespace(CURRENT_DESKTOP_API_NAMESPACE)).toBe(true);
    expect(isDesktopApiNamespace("engineer")).toBe(false);
    expect(isDesktopApiPath(`${DESKTOP_API_PREFIX}health`)).toBe(true);
    expect(isDesktopApiPath("/api/engineer/health")).toBe(false);
  });

  it("keeps supported paths unchanged", () => {
    const pathname = `${DESKTOP_API_PREFIX}git/status`;

    expect(rewriteDesktopApiPath(pathname, CURRENT_DESKTOP_API_NAMESPACE)).toBe(
      pathname
    );
  });

  it("reads the current namespace and rejects absent or stale capabilities", () => {
    expect(getDesktopApiNamespaceFromCapabilities(null)).toBeNull();
    expect(
      getDesktopApiNamespaceFromCapabilities({
        [DESKTOP_API_NAMESPACE_CAPABILITY_KEY]: CURRENT_DESKTOP_API_NAMESPACE,
      })
    ).toBe(CURRENT_DESKTOP_API_NAMESPACE);
    expect(
      getDesktopApiNamespaceFromCapabilities({
        [DESKTOP_API_NAMESPACE_CAPABILITY_KEY]: "engineer",
      })
    ).toBeNull();
  });

  it("deletes namespace capabilities while preserving unrelated values", () => {
    expect(withDesktopApiNamespaceCapability(null, null)).toEqual({});
    expect(
      withDesktopApiNamespaceCapability(
        {
          [DESKTOP_API_NAMESPACE_CAPABILITY_KEY]: CURRENT_DESKTOP_API_NAMESPACE,
          commandSigning: true,
        },
        null
      )
    ).toEqual({ commandSigning: true });
  });
});
