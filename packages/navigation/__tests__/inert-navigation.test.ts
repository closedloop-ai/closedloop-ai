import { describe, expect, it } from "vitest";
import {
  INERT_NAVIGATION,
  useIdentityOrgPath,
  useInertNavigation,
  useNoPath,
  useNoRouteParams,
  useNoSearchParams,
} from "../inert-navigation";

describe("inert navigation stand-ins", () => {
  it("returns the same value on every call, so a caller's dependencies hold still", () => {
    expect(useNoSearchParams()).toBe(useNoSearchParams());
    expect(useNoRouteParams()).toBe(useNoRouteParams());
    expect(useInertNavigation()).toBe(INERT_NAVIGATION);
    expect(useIdentityOrgPath()).toBe(useIdentityOrgPath());
  });

  it("reads as no route at all and navigates nowhere", () => {
    expect(useNoPath()).toBe("");
    expect(useNoSearchParams().toString()).toBe("");
    expect(useNoRouteParams()).toEqual({});
    expect(useIdentityOrgPath()("/packs")).toBe("/packs");
    expect(INERT_NAVIGATION.replace("/sessions")).toBeUndefined();
  });
});
