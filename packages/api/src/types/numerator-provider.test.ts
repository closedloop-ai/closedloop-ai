import { describe, expect, it } from "vitest";
import { LOC_PER_DOLLAR_LABEL } from "../utils/loc-per-dollar";
import {
  DEFAULT_NUMERATOR_PROVIDER,
  NUMERATOR_PROVIDER_DESCRIPTORS,
  NumeratorProvider,
  numeratorBasisFor,
  numeratorProviderDescriptor,
  parseNumeratorProvider,
  perDollarLabelFor,
  perDollarShortLabelFor,
  perDollarUnitLabelFor,
} from "./numerator-provider";

describe("numerator provider seam", () => {
  it("describes every member of the closed provider set", () => {
    // The compile-time guard is the `Record<NumeratorProvider, …>` annotation
    // on the map itself. This is its runtime twin: it catches the case the
    // type cannot, a descriptor copy-pasted under the wrong key.
    for (const providerId of Object.values(NumeratorProvider)) {
      const descriptor = NUMERATOR_PROVIDER_DESCRIPTORS[providerId];
      expect(descriptor.id).toBe(providerId);
      expect(descriptor.unitLabel.length).toBeGreaterThan(0);
      expect(descriptor.unitName.length).toBeGreaterThan(0);
    }
  });

  it("treats LOC as a provider rather than a hardcoded baseline", () => {
    expect(DEFAULT_NUMERATOR_PROVIDER).toBe(NumeratorProvider.Loc);
    expect(
      numeratorProviderDescriptor(NumeratorProvider.Loc).requiresAssociation
    ).toBe(false);
  });

  it("marks an externally sourced provider as needing association", () => {
    // The flag is what tells a surface that "no value" may mean "not yet
    // backfilled" rather than a measured zero.
    expect(
      numeratorProviderDescriptor(NumeratorProvider.Pensero).requiresAssociation
    ).toBe(true);
  });

  it("carries the unit on the wire basis so copy never hardcodes it", () => {
    expect(numeratorBasisFor(NumeratorProvider.Pensero)).toEqual({
      providerId: NumeratorProvider.Pensero,
      unitLabel:
        NUMERATOR_PROVIDER_DESCRIPTORS[NumeratorProvider.Pensero].unitLabel,
    });
    expect(numeratorBasisFor(NumeratorProvider.Loc).unitLabel).not.toBe(
      numeratorBasisFor(NumeratorProvider.Pensero).unitLabel
    );
  });

  it("refuses to substitute the default for an unrecognized provider", () => {
    // Defaulting here would render one provider's numbers under another's
    // unit — the exact confusion the basis discriminator exists to prevent.
    expect(parseNumeratorProvider("jira")).toBeNull();
    expect(parseNumeratorProvider(undefined)).toBeNull();
    expect(parseNumeratorProvider(7)).toBeNull();
    expect(parseNumeratorProvider(NumeratorProvider.Pensero)).toBe(
      NumeratorProvider.Pensero
    );
  });
});

describe("ISS-9814 per-dollar labels", () => {
  // Pinned as INDEPENDENT literals, not re-derived from the descriptor map the
  // functions read: a test that rebuilds its expectation from the same const it
  // polices passes for any value that const takes, including a wrong one.
  it("spells each provider's spaced per-dollar label", () => {
    expect(perDollarLabelFor(NumeratorProvider.Loc)).toBe("LOC / $");
    expect(perDollarLabelFor(NumeratorProvider.Pensero)).toBe(
      "Pensero pts / $"
    );
  });

  it("spells each provider's compact per-dollar unit", () => {
    expect(perDollarUnitLabelFor(NumeratorProvider.Loc)).toBe("LOC/$");
    expect(perDollarUnitLabelFor(NumeratorProvider.Pensero)).toBe(
      "Pensero pts/$"
    );
  });

  it("ISS-11117: spells each provider's SHORT per-dollar label", () => {
    expect(perDollarShortLabelFor(NumeratorProvider.Loc)).toBe("LOC / $");
    expect(perDollarShortLabelFor(NumeratorProvider.Pensero)).toBe("Pts / $");
  });

  it("ISS-11117: keeps the SHORT LOC arm on the canonical LOC/$ label", () => {
    // A listing that adopts the short label must render the identical LOC
    // string it renders today — AC2's "exactly as today" at the label.
    expect(perDollarShortLabelFor(NumeratorProvider.Loc)).toBe(
      LOC_PER_DOLLAR_LABEL
    );
  });

  it("keeps the LOC arm byte-identical to the canonical LOC/$ label", () => {
    // The two owners are deliberately not wired together at runtime (this
    // module stays dependency-free), so this assertion is the only thing
    // stopping them drifting apart.
    expect(perDollarLabelFor(NumeratorProvider.Loc)).toBe(LOC_PER_DOLLAR_LABEL);
  });

  it("never labels one provider's ratio with another's unit", () => {
    // AC6: the label travels with the value. A shared or empty unit here would
    // let a Pensero number render under a LOC label somewhere downstream.
    const labels = Object.values(NumeratorProvider).map(perDollarLabelFor);
    expect(new Set(labels).size).toBe(labels.length);
    expect(perDollarLabelFor(NumeratorProvider.Pensero)).not.toContain(
      NUMERATOR_PROVIDER_DESCRIPTORS[NumeratorProvider.Loc].unitLabel
    );
  });
});
