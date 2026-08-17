/**
 * ISS-5009 — the HONEST Source projection for a merged catalog row.
 *
 * Split out of `identity.test.ts` when these cases pushed that file past the
 * 1,000-line ceiling (AGENTS.md "File Size and Organization"). They are a
 * cohesive unit — one resolver, one question: does this row actually know where
 * it came from — so the seam follows a real responsibility boundary rather than
 * a line count. The row builders both files need live in
 * `identity-test-fixtures.ts` so the two suites cannot drift on what a default
 * inventory row looks like.
 */

import {
  AgentComponentKind,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { ComponentScope } from "@repo/api/src/types/component-scope";
import { describe, expect, it } from "vitest";
import {
  foldOrphanUsageIntoMerged,
  type InventoryRow,
  type MergedComponent,
  mergeComponentRows,
  resolveDetailHonestSource,
  resolveMergedHonestSource,
  resolveMergedSource,
} from "../identity";
import { inventoryRow, MAX_ROWS, orphanUsage } from "./identity-test-fixtures";

/**
 * ISS-5009: the legacy `source` chain ends at the component's own identity key,
 * so the Agents catalog's Source column echoes the Component column for every row
 * with no recorded provenance. `resolveMergedHonestSource` reports that case as
 * `hasProvenance: false` instead of inventing a value, and derives `source` +
 * `sourceType` from ONE ordered switch so the emitted type always describes the
 * branch that produced the emitted value.
 *
 * These drive the real merge fold (`mergeComponentRows`) rather than a hand-built
 * `MergedComponent`, so they also pin that the fold actually carries the
 * `scope`/`projectPath` the resolver reads.
 */
describe("resolveMergedHonestSource", () => {
  /** The merged entry for exactly one inventory row. */
  function mergedEntryFor(overrides: Partial<InventoryRow>): MergedComponent {
    const [entry] = [...mergeComponentRows([inventoryRow(overrides)]).values()];
    return entry;
  }

  function honestSourceFor(overrides: Partial<InventoryRow>) {
    return resolveMergedHonestSource(mergedEntryFor(overrides));
  }

  /** Every input that is NOT provenance resolves to this, for a non-MCP kind. */
  const NO_PROVENANCE = {
    hasProvenance: false,
    source: null,
    sourceType: SourceType.Local,
  };
  /** A row carrying nothing the honest chain can read. */
  const BARE = {
    packId: null,
    sourceUrl: null,
    scope: null,
    projectPath: null,
    installPath: null,
  } satisfies Partial<InventoryRow>;

  it("reports NO provenance for a row that carries none — the echo case", () => {
    // The legacy value IS the identity key: exactly the Component-column echo.
    expect(resolveMergedSource(mergedEntryFor(BARE))).toBe("code-review");
    expect(honestSourceFor(BARE)).toEqual(NO_PROVENANCE);
  });

  it("treats a plugin whose pack id IS its own identity key as no provenance", () => {
    // The plugin scanner writes `pack_id = component_key = name`, so a naive
    // pack-first chain reports the plugin's own name as its provenance.
    expect(
      honestSourceFor({
        ...BARE,
        componentKind: AgentComponentKind.Plugin,
        componentKey: "code",
        name: "code",
        packId: "code",
      })
    ).toEqual(NO_PROVENANCE);
  });

  it("normalizes BOTH operands, so a MIXED-CASE plugin pack id is still the echo", () => {
    // The merged `key` is lowercased/trimmed while `packId` is persisted RAW, so
    // a raw-vs-normalized comparison would let `"ClosedLoop"` escape the echo
    // check on cloud while desktop (raw-vs-raw) caught it — reintroducing the
    // web/desktop skew this projection exists to remove.
    const mixedCase = {
      ...BARE,
      componentKind: AgentComponentKind.Plugin,
      componentKey: "ClosedLoop",
      name: "ClosedLoop",
      packId: "ClosedLoop",
    };
    expect(mergedEntryFor(mixedCase).key).toBe("closedloop");
    expect(honestSourceFor(mixedCase)).toEqual(NO_PROVENANCE);
  });

  it("does NOT treat an install path as provenance", () => {
    // A path is a LOCATION, not provenance, and this catalog is org-wide — a
    // chain that terminated here would print one member's absolute local
    // filesystem path to everyone else in the org.
    expect(
      honestSourceFor({
        ...BARE,
        installPath: "/home/someone/.claude/skills/code-review/SKILL.md",
      })
    ).toEqual(NO_PROVENANCE);
  });

  it("resolves Pack + the pack id for a REAL pack, MCP kind included", () => {
    // `componentKind` reaches only the no-provenance fallback: it never preempts
    // a branch whose value came from somewhere else, so an MCP tool installed
    // from a pack reads Pack rather than the kind-only Server.
    const fromPack = {
      hasProvenance: true,
      source: "acme-pack",
      sourceType: SourceType.Pack,
    };
    expect(honestSourceFor({ packId: "acme-pack" })).toEqual(fromPack);
    expect(
      honestSourceFor({
        componentKind: AgentComponentKind.Mcp,
        packId: "acme-pack",
      })
    ).toEqual(fromPack);
  });

  it("resolves Server for an MCP tool with no provenance at all", () => {
    expect(
      honestSourceFor({ ...BARE, componentKind: AgentComponentKind.Mcp })
    ).toEqual({
      hasProvenance: false,
      source: null,
      sourceType: SourceType.Server,
    });
  });

  it("resolves Repo + the sourceUrl — for MCP too, and ahead of any scope", () => {
    // The kind-only `Server` fallback must never label a value that came from the
    // repo branch: that is the self-contradictory pair a two-chain derivation
    // produces (a repo URL behind a "Local, builder-specific" glyph).
    const fromRepo = {
      hasProvenance: true,
      source: "github.com/acme/repo",
      sourceType: SourceType.Repo,
    };
    expect(
      honestSourceFor({
        componentKind: AgentComponentKind.Mcp,
        sourceUrl: "github.com/acme/repo",
      })
    ).toEqual(fromRepo);
    expect(
      honestSourceFor({ sourceUrl: "github.com/acme/repo", scope: "user" })
    ).toEqual(fromRepo);
  });

  it("resolves Repo for a project-scoped row", () => {
    expect(honestSourceFor({ scope: "project" })).toEqual({
      hasProvenance: true,
      source: "project",
      sourceType: SourceType.Repo,
    });
  });

  it("never emits projectPath itself as the source value", () => {
    // The desktop sync boundary nulls `scope` and `projectPath` independently
    // (`apps/api/app/desktop/components/sync/service.ts`), so a row carrying a
    // project path with NO scope is reachable. It is still known to be
    // project-scoped, but the value must be the scope — an absolute filesystem
    // path in the ORG-WIDE catalog would print one member's local directory
    // layout to every other member, the same leak the `installPath` exclusion
    // exists to prevent.
    const projectPath = "/home/someone/Workspace/private-client-repo";

    expect(honestSourceFor({ projectPath })).toEqual({
      hasProvenance: true,
      source: ComponentScope.Project,
      sourceType: SourceType.Repo,
    });
    // An explicit non-project scope wins over projectPath as Local provenance.
    expect(honestSourceFor({ projectPath, scope: "user" })).toEqual({
      hasProvenance: true,
      source: "user",
      sourceType: SourceType.Local,
    });
  });

  it("resolves Local + the scope for a user-scoped row", () => {
    // The legacy list value for this row is the identity-key echo, so the honest
    // projection differs from it in BOTH text and glyph.
    expect(resolveMergedSource(mergedEntryFor({ scope: "user" }))).toBe(
      "code-review"
    );
    expect(honestSourceFor({ scope: "user" })).toEqual({
      hasProvenance: true,
      source: "user",
      sourceType: SourceType.Local,
    });
  });

  it("carries no provenance for a synthetic usage-only bucket (no inventory row)", () => {
    const mergedMap = mergeComponentRows([]);
    foldOrphanUsageIntoMerged(
      mergedMap,
      [orphanUsage({ componentKind: AgentComponentKind.Mcp })],
      MAX_ROWS
    );
    const [entry] = [...mergedMap.values()];

    expect(resolveMergedHonestSource(entry)).toEqual({
      hasProvenance: false,
      source: null,
      sourceType: SourceType.Server,
    });
  });
});

/**
 * ISS-5009: the DETAIL read's honest projection, and the invariant that binds it
 * to the list's. Both must describe the CANONICAL representative — the revision
 * actually on screen — so a component cannot report one provenance in the
 * catalog and a different one on its own detail page.
 */
describe("resolveDetailHonestSource", () => {
  /** rows[0] is the canonical representative; the rest are older versions. */
  const canonicalRow = {
    componentKind: AgentComponentKind.Skill,
    packId: null as string | null,
    scope: "user" as string | null,
    projectPath: null as string | null,
    sourceUrl: null as string | null,
  };
  const supersededPackRow = {
    ...canonicalRow,
    packId: "legacy-pack",
    scope: null,
  };

  it("reads the canonical row's pack, not a pack unioned from a superseded version", () => {
    // The legacy detail projection unions `packId` across every version row. If
    // the honest projection reused that union, this component would render
    // "user"/Local in the catalog (which resolves from the representative) and
    // "legacy-pack"/Pack on its own detail page — the flag turning on a NEW
    // contradiction instead of removing one.
    expect(
      resolveDetailHonestSource(
        [canonicalRow, supersededPackRow],
        "code-review"
      )
    ).toEqual({
      hasProvenance: true,
      source: "user",
      sourceType: SourceType.Local,
    });
  });

  it("agrees with the list projection for the same representative row", () => {
    const listAnswer = resolveMergedHonestSource(
      mergedEntryForRows([inventoryRow({ id: "row-new", scope: "user" })])
    );
    const detailAnswer = resolveDetailHonestSource(
      [canonicalRow, supersededPackRow],
      "code-review"
    );

    expect(detailAnswer).toEqual(listAnswer);
  });

  it("still reports the canonical row's OWN pack as provenance", () => {
    expect(
      resolveDetailHonestSource(
        [{ ...canonicalRow, packId: "code", scope: null }],
        "code-review"
      )
    ).toEqual({
      hasProvenance: true,
      source: "code",
      sourceType: SourceType.Pack,
    });
  });
});

/** The merged entry for a set of inventory rows. */
function mergedEntryForRows(rows: InventoryRow[]): MergedComponent {
  const [entry] = [...mergeComponentRows(rows).values()];
  return entry;
}
