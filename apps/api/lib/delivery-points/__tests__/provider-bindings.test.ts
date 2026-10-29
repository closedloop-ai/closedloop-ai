import { NumeratorProvider } from "@repo/api/src/types/numerator-provider";
import { DeliveryPointProvider } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_PROVIDER_BINDINGS,
  deliveryPointProviderFor,
} from "../provider-bindings";

describe("delivery provider bindings", () => {
  it("binds every numerator provider", () => {
    // The `Record<NumeratorProvider, …>` annotation is the compile-time gate: a
    // new provider fails `tsc` here until it declares how it is sourced. This
    // is its runtime twin, catching a member left out at runtime by a cast.
    for (const providerId of Object.values(NumeratorProvider)) {
      expect(DELIVERY_PROVIDER_BINDINGS[providerId]).toBeDefined();
    }
  });

  it("treats LOC as derived, with no association rows to read", () => {
    expect(deliveryPointProviderFor(NumeratorProvider.Loc)).toBeNull();
  });

  it("maps Pensero to its persisted provider value", () => {
    expect(deliveryPointProviderFor(NumeratorProvider.Pensero)).toBe(
      DeliveryPointProvider.PENSERO
    );
  });
});
