import { describe, expect, it } from "vitest";
import { ComponentScope } from "../component-scope.js";
import {
  ComponentSourceKind,
  ComponentSourceToken,
  classifyComponentSource,
  deriveComponentSource,
  MAX_COMPONENT_SOURCE_LENGTH,
  resolveComponentSource,
  stripUrlUserinfo,
  unionComponentSourceProvenance,
} from "../component-source.js";

const OVER_CAP = "p".repeat(MAX_COMPONENT_SOURCE_LENGTH + 1);

describe("deriveComponentSource", () => {
  it("reports the pack name for a pack-sourced component", () => {
    expect(
      deriveComponentSource({
        packId: "superpowers",
        installPath: "/w/.claude/plugins/superpowers/skills/browser",
        scope: ComponentScope.User,
        identityKeys: ["browser"],
      })
    ).toBe("superpowers");
  });

  it("reports the repository for a repo-linked component with no pack", () => {
    expect(
      deriveComponentSource({
        sourceUrl: "https://github.com/closedloop-ai/symphony-alpha",
        scope: ComponentScope.Project,
        projectPath: "/w/symphony-alpha",
        identityKeys: ["review-soul"],
      })
    ).toBe("https://github.com/closedloop-ai/symphony-alpha");
  });

  it("strips embedded credentials out of the repository identity", () => {
    expect(
      deriveComponentSource({
        sourceUrl: "https://alice:hunter2@github.com/acme/skills",
        identityKeys: ["browser"],
      })
    ).toBe("https://github.com/acme/skills");
  });

  it("reports `unknown`, not `organic`, for a pack id that is only the identity echoed back", () => {
    // `discoverInstalledPlugins` writes `pack_id = component_key = name` for
    // every registry-installed plugin. The echo is uninformative, but it still
    // proves the component did NOT originate on this machine, so it must not
    // fall through to the positive local-authorship claim.
    expect(
      deriveComponentSource({
        packId: "ClosedLoop",
        installPath: "/w/.claude/plugins/closedloop",
        identityKeys: ["closedloop"],
      })
    ).toBe(ComponentSourceToken.Unknown);
  });

  it("rejects a pack id that echoes ANY identity alias, not just the first", () => {
    // A legacy row can carry a `component_key` and a DIFFERENT `external_id`,
    // with `pack_id` repeating the latter. Comparing one alias would let that
    // echo through as real provenance while `honestSourceOf` — which has always
    // compared both identity columns — rejects it.
    expect(
      deriveComponentSource({
        packId: "ext-browser",
        installPath: "/w/.claude/skills/browser.md",
        identityKeys: ["browser", "ext-browser"],
      })
    ).toBe(ComponentSourceToken.Unknown);
  });

  it("does not call an installed plugin locally authored (ISS-6232)", () => {
    const installedPlugin = deriveComponentSource({
      packId: "gstack",
      installPath: "/w/.claude/plugins/gstack",
      scope: ComponentScope.User,
      identityKeys: ["gstack"],
    });
    const handWritten = deriveComponentSource({
      installPath: "/w/.claude/skills/triage.md",
      scope: ComponentScope.User,
      identityKeys: ["triage"],
    });
    expect(installedPlugin).not.toBe(ComponentSourceToken.Organic);
    expect(handWritten).toBe(ComponentSourceToken.Organic);
  });

  it("reports `unknown` for a plugin-scoped definition whose pack link has not landed", () => {
    // `ComponentScope.Plugin` PROVES the definition is vendored by an installed
    // plugin, so a missing/unprojected `pack_id` must not promote it to the
    // positive local-authorship claim — that would also contradict the honest
    // -source projection, which reports it as plugin-scoped.
    expect(
      deriveComponentSource({
        scope: ComponentScope.Plugin,
        installPath: "/w/.claude/plugins/gstack/skills/browser.md",
        identityKeys: ["browser"],
      })
    ).toBe(ComponentSourceToken.Unknown);
  });

  it("still reports the pack for a plugin-scoped definition that HAS one", () => {
    expect(
      deriveComponentSource({
        packId: "gstack",
        scope: ComponentScope.Plugin,
        installPath: "/w/.claude/plugins/gstack/skills/browser.md",
        identityKeys: ["browser"],
      })
    ).toBe("gstack");
  });

  it.each([
    ["an install path", { installPath: "/w/.claude/skills/triage.md" }],
    ["a settings scope", { scope: ComponentScope.User }],
    ["a project root", { projectPath: "/w/symphony-alpha" }],
  ])("reports `organic` for a locally-authored component known only by %s", (_label, provenance) => {
    expect(
      deriveComponentSource({ ...provenance, identityKeys: ["triage"] })
    ).toBe(ComponentSourceToken.Organic);
  });

  it("reports `unknown` only when no provenance was captured at all", () => {
    expect(deriveComponentSource({ identityKeys: ["Explore"] })).toBe(
      ComponentSourceToken.Unknown
    );
  });

  it("keeps `organic` and `unknown` distinct — they are different facts", () => {
    const authoredHere = deriveComponentSource({
      installPath: "/w/.claude/skills/triage.md",
      identityKeys: ["triage"],
    });
    const undetermined = deriveComponentSource({ identityKeys: ["triage"] });
    expect(authoredHere).toBe(ComponentSourceToken.Organic);
    expect(undetermined).toBe(ComponentSourceToken.Unknown);
    expect(authoredHere).not.toBe(undetermined);
  });

  it.each([
    ["everything absent", {}],
    ["everything null", { packId: null, sourceUrl: null, scope: null }],
    [
      "everything whitespace",
      { packId: "  ", sourceUrl: " ", scope: "", installPath: "   " },
    ],
    ["a pack that is the identity", { packId: "x", identityKeys: ["x"] }],
  ])("never returns an empty string for %s", (_label, provenance) => {
    const derived = deriveComponentSource(provenance);
    expect(derived).not.toBe("");
    expect(derived.trim()).toBe(derived);
    expect(derived.length).toBeGreaterThan(0);
  });

  it.each([
    ["pack id", { packId: OVER_CAP }],
    ["repository", { sourceUrl: `https://example.com/${OVER_CAP}` }],
  ])("never emits an over-cap %s — a caller cannot amplify one field into megabytes of response", (_label, provenance) => {
    const derived = deriveComponentSource(provenance);
    expect(derived).toBe(ComponentSourceToken.Unknown);
    expect(derived.length).toBeLessThanOrEqual(MAX_COMPONENT_SOURCE_LENGTH);
  });
});

describe("classifyComponentSource", () => {
  it.each([
    [
      "a pack",
      { packId: "gstack", identityKeys: ["browser"] },
      "gstack",
      ComponentSourceKind.Pack,
    ],
    [
      "a repository",
      { sourceUrl: "https://github.com/acme/skills" },
      "https://github.com/acme/skills",
      ComponentSourceKind.Repository,
    ],
    [
      "local authorship",
      { installPath: "/w/.claude/skills/triage.md" },
      ComponentSourceToken.Organic,
      ComponentSourceKind.Organic,
    ],
    ["nothing", {}, ComponentSourceToken.Unknown, ComponentSourceKind.Unknown],
  ])("discriminates %s", (_label, provenance, value, kind) => {
    expect(classifyComponentSource(provenance)).toEqual({ value, kind });
  });

  it("distinguishes a pack literally named `organic` from the organic terminal", () => {
    // Pack ids are free strings, so the VALUE alone is ambiguous; the kind is
    // what tells the two apart without reserving names a marketplace may use.
    const pack = classifyComponentSource({
      packId: ComponentSourceToken.Organic,
      identityKeys: ["browser"],
    });
    const terminal = classifyComponentSource({
      installPath: "/w/.claude/skills/browser.md",
      identityKeys: ["browser"],
    });
    expect(pack.value).toBe(terminal.value);
    expect(pack.kind).toBe(ComponentSourceKind.Pack);
    expect(terminal.kind).toBe(ComponentSourceKind.Organic);
  });
});

describe("resolveComponentSource", () => {
  it.each([
    [""],
    ["   "],
    [null],
    [undefined],
  ])("derives when the persisted value is the %p sentinel", (stored) => {
    expect(
      resolveComponentSource(stored, {
        packId: "gstack",
        identityKeys: ["browser"],
      })
    ).toEqual({ value: "gstack", kind: ComponentSourceKind.Pack });
  });

  it("keeps a persisted value once one has been written, and states no kind for it", () => {
    expect(
      resolveComponentSource("code-review", { identityKeys: ["critic"] })
    ).toEqual({ value: "code-review" });
  });
});

describe("unionComponentSourceProvenance", () => {
  it("resolves a component observed from more than one source to the pack", () => {
    // Same component, two machines: one saw it inside a pack, the other saw a
    // bare local copy. Reading the representative row alone would answer
    // `organic` for a component that is demonstrably pack-sourced.
    const folded = unionComponentSourceProvenance(
      [
        {
          installPath: "/w/.claude/skills/browser.md",
          scope: ComponentScope.User,
        },
        { packId: "gstack", installPath: "/w/.claude/plugins/gstack/browser" },
      ],
      ["browser"]
    );
    expect(deriveComponentSource(folded)).toBe("gstack");
  });

  it("prefers a real pack on a later row over the canonical row's identity echo", () => {
    // The canonical row is the known scanner echo (`pack_id = component_key`).
    // Taking the first non-empty pack positionally would keep that echo, discard
    // the row that PROVES the pack, and report `unknown` for a component another
    // observer demonstrably saw inside `gstack`.
    const folded = unionComponentSourceProvenance(
      [
        { packId: "browser", installPath: "/w/.claude/plugins/browser" },
        { packId: "gstack", installPath: "/w/.claude/plugins/gstack/browser" },
      ],
      ["browser"]
    );
    expect(folded.packId).toBe("gstack");
    expect(deriveComponentSource(folded)).toBe("gstack");
  });

  it("rejects an echo of a per-row identity alias the fold does not carry", () => {
    const folded = unionComponentSourceProvenance(
      [
        {
          packId: "ext-browser",
          installPath: "/w/.claude/skills/browser.md",
          identityKeys: ["browser", "ext-browser"],
        },
      ],
      ["browser"]
    );
    expect(deriveComponentSource(folded)).toBe(ComponentSourceToken.Unknown);
  });

  it("does not let an over-cap pack id mask a valid one on another row", () => {
    const folded = unionComponentSourceProvenance(
      [{ packId: OVER_CAP }, { packId: "gstack" }],
      ["browser"]
    );
    expect(folded.packId).toBe("gstack");
  });

  it("falls through to the repository when no observer saw a pack", () => {
    const folded = unionComponentSourceProvenance(
      [
        { scope: ComponentScope.Project, projectPath: "/w/symphony-alpha" },
        { sourceUrl: "https://github.com/acme/skills" },
      ],
      ["browser"]
    );
    expect(deriveComponentSource(folded)).toBe(
      "https://github.com/acme/skills"
    );
  });

  it("carries the identity keys through so a pack echo is still rejected", () => {
    const folded = unionComponentSourceProvenance(
      [{ packId: "gstack", installPath: "/w/plugins/gstack" }],
      ["GStack"]
    );
    expect(folded.identityKeys).toEqual(["gstack"]);
    expect(deriveComponentSource(folded)).toBe(ComponentSourceToken.Unknown);
  });

  it("reports `unknown` when no observer captured anything", () => {
    expect(
      deriveComponentSource(
        unionComponentSourceProvenance([{}, {}], ["explore"])
      )
    ).toBe(ComponentSourceToken.Unknown);
  });
});

describe("stripUrlUserinfo", () => {
  it("leaves a credential-free URL untouched", () => {
    expect(stripUrlUserinfo("https://github.com/acme/skills")).toBe(
      "https://github.com/acme/skills"
    );
  });

  it("leaves a non-http remote untouched", () => {
    expect(stripUrlUserinfo("git@github.com:acme/skills.git")).toBe(
      "git@github.com:acme/skills.git"
    );
  });

  it("removes the WHOLE userinfo when the password contains a raw `@`", () => {
    // Matching through the FIRST `@` left the tail of the credential behind
    // (`https://ss@example.com/repo`), persisting half a password into the
    // org-wide catalog. The authority runs to its LAST `@`, as the URL parser
    // itself defines it.
    const stripped = stripUrlUserinfo("https://alice:pa@ss@example.com/repo");
    expect(stripped).toBe("https://example.com/repo");
    expect(stripped).not.toContain("ss@");
    expect(stripped).not.toContain("pa");
  });

  it("does not treat an `@` in the PATH as a userinfo delimiter", () => {
    expect(stripUrlUserinfo("https://example.com/@acme/skills")).toBe(
      "https://example.com/@acme/skills"
    );
  });
});
