/** ISS-8735: unit coverage for the Postgres timestamp-floor pre-pass. */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import {
  ComponentTimestampField,
  degradeUnstorableComponentTimestamps,
} from "./timestamp-floor";

const POISON = "-100000-01-01T00:00:00.000Z";
const FLOOR = "-004712-01-01T00:00:00.000Z";
const HEALTHY = "2026-01-10T00:00:00.000Z";

type ComponentFixture = Record<string, unknown>;

function buildComponent(overrides: ComponentFixture = {}) {
  return {
    externalId: "skill::my-skill",
    componentKind: AgentComponentKind.Skill,
    componentKey: "my-skill",
    firstSeenAt: HEALTHY,
    lastSeenAt: HEALTHY,
    uninstalledAt: HEALTHY,
    contentFirstSeenAt: HEALTHY,
    scannedAt: HEALTHY,
    ...overrides,
  } as never;
}

function degradeOne(component: ReturnType<typeof buildComponent>) {
  const result = degradeUnstorableComponentTimestamps([component]);
  return { component: result.components[0] as ComponentFixture, result };
}

describe("degradeUnstorableComponentTimestamps", () => {
  const componentFields = [
    ComponentTimestampField.FirstSeenAt,
    ComponentTimestampField.LastSeenAt,
    ComponentTimestampField.UninstalledAt,
    ComponentTimestampField.ContentFirstSeenAt,
    ComponentTimestampField.ScannedAt,
  ];

  for (const field of componentFields) {
    it(`removes a below-floor ${field} and leaves its siblings intact`, () => {
      const { component, result } = degradeOne(
        buildComponent({ [field]: POISON })
      );

      expect(component).not.toHaveProperty(field);
      for (const sibling of componentFields) {
        if (sibling !== field) {
          expect(component[sibling]).toBe(HEALTHY);
        }
      }
      expect(result.degraded).toEqual({ [field]: 1 });
    });
  }

  it("removes a below-floor variant timestamp on the variant only", () => {
    const { component, result } = degradeOne(
      buildComponent({
        variants: [
          {
            contentHash: "hash-a",
            content: "BODY",
            format: "md",
            firstSeenAt: POISON,
            lastSeenAt: POISON,
          },
        ],
      })
    );

    const variant = (component.variants as ComponentFixture[])[0];
    expect(variant).not.toHaveProperty("firstSeenAt");
    expect(variant).not.toHaveProperty("lastSeenAt");
    expect(variant.contentHash).toBe("hash-a");
    // The component's own timestamps are untouched by a variant degrade.
    expect(component.lastSeenAt).toBe(HEALTHY);
    expect(result.degraded).toEqual({
      [ComponentTimestampField.VariantFirstSeenAt]: 1,
      [ComponentTimestampField.VariantLastSeenAt]: 1,
    });
  });

  it("keeps the floor instant itself and other legal-but-unusual forms", () => {
    const kept = [
      FLOOR,
      "2026-06-03T24:00:00Z",
      "0050-03-04T10:00:00Z",
      "2024-02-29T12:00:00Z",
    ];

    for (const value of kept) {
      const { component, result } = degradeOne(
        buildComponent({ firstSeenAt: value })
      );
      expect(component.firstSeenAt).toBe(value);
      expect(result.degraded).toEqual({});
    }
  });

  it("passes null, undefined and malformed strings through untouched", () => {
    const { component, result } = degradeOne(
      buildComponent({
        firstSeenAt: null,
        lastSeenAt: undefined,
        scannedAt: "not-a-date",
      })
    );

    expect(component.firstSeenAt).toBeNull();
    expect(component.lastSeenAt).toBeUndefined();
    expect(component.scannedAt).toBe("not-a-date");
    expect(result.degraded).toEqual({});
  });

  it("tallies each field across the whole batch", () => {
    const result = degradeUnstorableComponentTimestamps([
      buildComponent({ externalId: "a", firstSeenAt: POISON }),
      buildComponent({
        externalId: "b",
        firstSeenAt: POISON,
        scannedAt: POISON,
      }),
      buildComponent({ externalId: "c" }),
    ]);

    expect(result.degraded).toEqual({
      [ComponentTimestampField.FirstSeenAt]: 2,
      [ComponentTimestampField.ScannedAt]: 1,
    });
  });

  it("returns a clean component by reference", () => {
    const component = buildComponent();

    const result = degradeUnstorableComponentTimestamps([component]);

    expect(result.components[0]).toBe(component);
  });
});
