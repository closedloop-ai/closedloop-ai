import { describe, expect, it } from "vitest";
import {
  buildComponentVersions,
  type ComponentVersionRow,
} from "../agent-component.js";
import {
  ComponentSourceKind,
  type ComponentSourceProvenance,
  ComponentSourceToken,
} from "../component-source.js";

const row = (
  overrides: Partial<ComponentVersionRow> & { contentHash: string }
): ComponentVersionRow => ({
  source: "",
  format: "md",
  createdAt: "2026-01-01T00:00:00.000Z",
  content: "body",
  ...overrides,
});

/**
 * ISS-6232: the provenance of a label-only component — nothing captured at all,
 * so every revision of it resolves to the `unknown` terminal.
 */
const NO_PROVENANCE: ComponentSourceProvenance = { identityKeys: ["explore"] };

describe("buildComponentVersions", () => {
  it("maps rows newest-first and flags the row matching currentHash", () => {
    const versions = buildComponentVersions(
      [
        row({ contentHash: "hB", createdAt: "2026-02-01T00:00:00.000Z" }),
        row({ contentHash: "hA", createdAt: "2026-01-01T00:00:00.000Z" }),
      ],
      "hA",
      NO_PROVENANCE
    );
    expect(versions.map((v) => [v.hash, v.isCurrent])).toEqual([
      ["hB", false],
      ["hA", true],
    ]);
  });

  it("flags the newest row (index 0) when no row matches currentHash", () => {
    const versions = buildComponentVersions(
      [row({ contentHash: "hB" }), row({ contentHash: "hA" })],
      "hMissing",
      NO_PROVENANCE
    );
    expect(versions.map((v) => v.isCurrent)).toEqual([true, false]);
  });

  it("flags the newest row when currentHash is null", () => {
    const versions = buildComponentVersions(
      [row({ contentHash: "hB" }), row({ contentHash: "hA" })],
      null,
      NO_PROVENANCE
    );
    expect(versions.map((v) => v.isCurrent)).toEqual([true, false]);
  });

  it("defaults null format→'md' and passes createdAt through", () => {
    const [v] = buildComponentVersions(
      [
        {
          contentHash: "hA",
          source: null,
          format: null,
          createdAt: "",
          content: "x",
        },
      ],
      "hA",
      NO_PROVENANCE
    );
    expect(v).toEqual({
      hash: "hA",
      source: ComponentSourceToken.Unknown,
      sourceKind: ComponentSourceKind.Unknown,
      format: "md",
      createdAt: "",
      isCurrent: true,
      content: "x",
    });
  });

  it("returns an empty array for no rows", () => {
    expect(buildComponentVersions([], "hA", NO_PROVENANCE)).toEqual([]);
  });

  // --- ISS-6232 -----------------------------------------------------------

  it("never reports an empty source, whatever the stored sentinel is", () => {
    const stored: (string | null)[] = ["", "   ", null];
    const provenances: ComponentSourceProvenance[] = [
      { packId: "gstack", identityKeys: ["browser"] },
      {
        sourceUrl: "https://github.com/acme/skills",
        identityKeys: ["browser"],
      },
      { installPath: "/w/.claude/skills/browser", identityKeys: ["browser"] },
      { identityKeys: ["browser"] },
    ];
    for (const source of stored) {
      for (const provenance of provenances) {
        const [version] = buildComponentVersions(
          [row({ contentHash: "hA", source })],
          "hA",
          provenance
        );
        expect(version.source).not.toBe("");
        expect(version.source.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps a locally-authored revision distinguishable from an undetermined one", () => {
    const [authoredHere] = buildComponentVersions(
      [row({ contentHash: "hA", source: "" })],
      "hA",
      { installPath: "/w/.claude/skills/browser.md", identityKeys: ["browser"] }
    );
    const [undetermined] = buildComponentVersions(
      [row({ contentHash: "hA", source: "" })],
      "hA",
      { identityKeys: ["browser"] }
    );
    expect(authoredHere.source).toBe(ComponentSourceToken.Organic);
    expect(undetermined.source).toBe(ComponentSourceToken.Unknown);
    expect(authoredHere.source).not.toBe(undetermined.source);
  });

  it("prefers a persisted source over the derivation once one is written", () => {
    const [version] = buildComponentVersions(
      [row({ contentHash: "hA", source: "superpowers" })],
      "hA",
      { installPath: "/w/.claude/skills/browser.md", identityKeys: ["browser"] }
    );
    expect(version.source).toBe("superpowers");
  });

  it("emits the discriminator so a pack named `organic` is not read as the terminal", () => {
    const [pack] = buildComponentVersions(
      [row({ contentHash: "hA", source: "" })],
      "hA",
      { packId: ComponentSourceToken.Organic, identityKeys: ["browser"] }
    );
    const [terminal] = buildComponentVersions(
      [row({ contentHash: "hA", source: "" })],
      "hA",
      {
        installPath: "/w/.claude/skills/browser.md",
        identityKeys: ["browser"],
      }
    );
    expect(pack.source).toBe(terminal.source);
    expect(pack.sourceKind).toBe(ComponentSourceKind.Pack);
    expect(terminal.sourceKind).toBe(ComponentSourceKind.Organic);
  });

  it("OMITS the discriminator for a persisted label, rather than guessing a kind", () => {
    const [version] = buildComponentVersions(
      [row({ contentHash: "hA", source: "superpowers" })],
      "hA",
      { packId: "gstack", identityKeys: ["browser"] }
    );
    expect(version.sourceKind).toBeUndefined();
    expect(Object.hasOwn(version, "sourceKind")).toBe(false);
  });
});
