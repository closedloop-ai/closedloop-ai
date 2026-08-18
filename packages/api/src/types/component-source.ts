/**
 * @file component-source.ts
 * @description ISS-6232 — the ONE derivation of a component's `source`, shared
 * by the desktop collectors (which write `agent_components.source`) and the
 * cloud projection (which reports `ComponentVersion.source`).
 *
 * `source` is a COMPONENT-level fact — where this component came from — reported
 * on every revision of it. Before this module it was written by nobody: every
 * desktop row carried `NULL`/`""` and every revision carried the `""` sentinel,
 * so the field asserted that EVERY component's origin was unknown — while
 * `pack_id`, `source_url`, `scope` and `install_path` sat right there holding
 * the answer.
 *
 * ISS-6232 (review): the STORED `agent_component_versions.source` column is a
 * dimension of the stored revision identity and is NOT touched by any of this —
 * rewriting it would re-key and fork every retained revision. What this module
 * produces is the REPORTED origin, resolved at read time from the component's
 * provenance, and it can legitimately change as observers accumulate (a pack id
 * arriving from a second machine sharpens `unknown` into `gstack`) WITHOUT
 * minting a new revision. The reported revision identity is the content hash;
 * `ComponentVersion.source` documents that scope explicitly.
 *
 * The terminal values are the load-bearing part. "An engineer authored this
 * here" and "we could not determine an origin" are different facts, and
 * collapsing both into one empty string is what made the field useless. They
 * get distinct explicit tokens ({@link ComponentSourceToken}) and the derivation
 * NEVER returns an empty string.
 *
 * Lives in `packages/api` because both surfaces must derive the same answer
 * from the same inputs — a component observed as a pack member on one machine
 * and as a bare local file on another must not resolve two different ways.
 */

import { normalizeComponentKey } from "./agent-component-analytics.ts";
import { ComponentScope } from "./component-scope.ts";

/**
 * The explicit terminal values of {@link deriveComponentSource}, for the two
 * cases that carry no pack or repository identity.
 *
 * These are contract values on the wire and in both stores, so they are
 * referenced through this const object everywhere — including tests — never
 * respelled as literals.
 */
export const ComponentSourceToken = {
  /**
   * Authored locally: the component exists as a real definition on a machine
   * (an install path, a settings scope, or a project it lives under) but
   * belongs to no pack and is checked into no known repository. This is a
   * POSITIVE answer — "an engineer wrote this here" — not a fallback.
   */
  Organic: "organic",
  /**
   * No provenance signal at all. Typically a label-minted row: a component
   * observed only by name in a transcript, with no definition file, scope, or
   * pack ever resolved for it. Deliberately DISTINCT from
   * {@link ComponentSourceToken.Organic}: conflating "we could not tell" with
   * "authored here" is the distinction-collapse this module exists to remove.
   */
  Unknown: "unknown",
} as const;
export type ComponentSourceToken =
  (typeof ComponentSourceToken)[keyof typeof ComponentSourceToken];

/**
 * ISS-6232 (review): the DISCRIMINATOR for a derived source value.
 *
 * A pack id is a free string, so a pack literally named `organic` or `unknown`
 * is byte-identical to a {@link ComponentSourceToken} terminal. The value alone
 * therefore cannot say which of the four branches produced it, and a consumer
 * that special-cases the terminals would mis-handle such a pack. The kind is
 * emitted alongside the value everywhere the value crosses a boundary
 * (`ComponentVersion.sourceKind`), so the two cases are distinguishable without
 * reserving names a marketplace is free to use.
 */
export const ComponentSourceKind = {
  /** The value is a pack/plugin id. */
  Pack: "pack",
  /** The value is a repository/remote URL, userinfo-stripped. */
  Repository: "repository",
  /** The value is {@link ComponentSourceToken.Organic}. */
  Organic: "organic",
  /** The value is {@link ComponentSourceToken.Unknown}. */
  Unknown: "unknown",
} as const;
export type ComponentSourceKind =
  (typeof ComponentSourceKind)[keyof typeof ComponentSourceKind];

/** A derived source: the value to report, and which branch produced it. */
export type DerivedComponentSource = {
  value: string;
  kind: ComponentSourceKind;
};

/**
 * ISS-6232 (review): the longest provenance string this derivation will emit.
 *
 * `packId`/`sourceUrl` are unbounded at the desktop sync schema, and the derived
 * value is copied onto EVERY retained revision of a component (up to
 * `SYNCED_COMPONENT_VARIANTS_MAX`), so an unbounded field is a multi-megabyte
 * amplification in a single detail response. A value longer than this is not a
 * plausible pack id or remote — it is corrupt input — so it is treated as ABSENT
 * rather than truncated: a truncated id is a plausible-but-wrong answer, which
 * is exactly what this module exists to stop emitting.
 */
export const MAX_COMPONENT_SOURCE_LENGTH = 256;

/**
 * The provenance columns {@link deriveComponentSource} reads. Every field is
 * optional and nullable because the two stores null them independently and a
 * version-skewed desktop may omit any of them; an absent field simply does not
 * win its branch.
 *
 * Structural, not tied to either store's row type, so the desktop SQLite reader
 * and the cloud Prisma reader can both pass their own rows through.
 */
export type ComponentSourceProvenance = {
  /** Owning pack/plugin id, when the component ships inside one. */
  packId?: string | null;
  /** Repository/remote the scanner recorded for this component. */
  sourceUrl?: string | null;
  /** Settings scope (`user`, `project`, `local`, …). */
  scope?: string | null;
  /** Owning project root, for a project-scoped component. */
  projectPath?: string | null;
  /** On-disk location of the definition file. */
  installPath?: string | null;
  /**
   * EVERY alias of the component's own identity — `component_key` AND
   * `external_id` on the desktop, the org identity key on the cloud. Used ONLY
   * to reject a pack id that is just the identity restated: the plugin scanner
   * writes `pack_id = component_key = name`, so without this check a plugin
   * would report itself as its own provenance.
   *
   * ISS-6232 (review): ALL aliases, not one, because a legacy row can carry a
   * `component_key` and a DIFFERENT `external_id` with `pack_id` echoing the
   * latter. Collapsing to a single alias would let that echo through as real
   * provenance here while `honestSourceOf` — which has always compared both
   * identity columns — rejects it, so the two surfaces would disagree.
   */
  identityKeys?: readonly (string | null | undefined)[];
};

/**
 * ISS-6232: derive a component's `source` from the provenance actually
 * captured. NEVER returns an empty string.
 *
 * Ordered precedence, most specific origin first:
 *  1. **Pack** — the pack/plugin name (`gstack`, `superpowers`, `code-review`).
 *     Skipped when the id is only the component's own identity echoed back.
 *  2. **Repository** — the recorded remote, userinfo-stripped so an embedded
 *     credential never lands in a store or an org-wide catalog.
 *  3. **{@link ComponentSourceToken.Organic}** — no pack evidence at all and no
 *     repo, but the component demonstrably exists here: it has an install path,
 *     a settings scope, or a project root.
 *  4. **{@link ComponentSourceToken.Unknown}** — none of the above, INCLUDING a
 *     row whose only pack evidence is its own identity restated, and a row
 *     scoped `ComponentScope.Plugin` with no pack or repo. Both are
 *     demonstrably not locally authored, so neither may reach the `organic`
 *     terminal just because its pack evidence was disqualified or absent.
 *
 * A provenance string longer than {@link MAX_COMPONENT_SOURCE_LENGTH} is treated
 * as ABSENT at every branch — see that constant for why.
 *
 * The order is TOTAL and deterministic, which is what makes a component
 * observed from more than one source resolve consistently: given the union of
 * what any observer captured, the highest-precedence origin always wins, so two
 * surfaces holding the same provenance can never disagree.
 *
 * `installPath` and `projectPath` are consulted only as SIGNALS that a local
 * definition exists — never emitted as the value. A filesystem path is a
 * location, not a provenance, and this value reaches an org-wide catalog, so
 * emitting one would print a member's local paths to the whole org (the same
 * rule `resolveHonestSource` and `honestSourceOf` already hold).
 */
export function deriveComponentSource(
  provenance: ComponentSourceProvenance
): string {
  return classifyComponentSource(provenance).value;
}

/**
 * ISS-6232: {@link deriveComponentSource} with its DISCRIMINATOR — the value and
 * the branch that produced it. Pack ids are free strings, so `"organic"` as a
 * value is ambiguous on its own; the kind is what makes a pack literally named
 * `organic` distinguishable from the {@link ComponentSourceToken.Organic}
 * terminal.
 */
export function classifyComponentSource(
  provenance: ComponentSourceProvenance
): DerivedComponentSource {
  const packId = boundedOrNull(provenance.packId);
  const packEcho =
    packId != null && isIdentityEcho(packId, provenance.identityKeys);
  if (packId && !packEcho) {
    return { value: packId, kind: ComponentSourceKind.Pack };
  }
  const sourceUrl = boundedOrNull(provenance.sourceUrl);
  if (sourceUrl) {
    return {
      value: stripUrlUserinfo(sourceUrl),
      kind: ComponentSourceKind.Repository,
    };
  }
  if (packEcho || isPluginVendored(provenance)) {
    // Two ways to be demonstrably NOT locally authored while carrying no usable
    // origin. (1) A pack id that only restates the row's own identity is
    // UNINFORMATIVE, not absent — `discoverInstalledPlugins` writes
    // `pack_id = component_key = name` for every registry-installed plugin.
    // (2) ISS-6232 (review): `ComponentScope.Plugin` PROVES the definition is
    // vendored by an installed plugin, so when the pack projection has not
    // landed (or the pack id was dropped) the row still must not reach the
    // `organic` branch — that would record a marketplace install as "an engineer
    // wrote this here", the very collapse the two terminals exist to prevent,
    // and would disagree with the honest-source projection, which reports it as
    // plugin-scoped. We know it did NOT originate here and cannot say where it
    // came from, which is exactly what `unknown` means.
    return {
      value: ComponentSourceToken.Unknown,
      kind: ComponentSourceKind.Unknown,
    };
  }
  if (hasLocalDefinitionEvidence(provenance)) {
    return {
      value: ComponentSourceToken.Organic,
      kind: ComponentSourceKind.Organic,
    };
  }
  return {
    value: ComponentSourceToken.Unknown,
    kind: ComponentSourceKind.Unknown,
  };
}

/**
 * ISS-6232: the `source` to REPORT for a stored row — the persisted value when
 * one exists, otherwise {@link deriveComponentSource} over the row's own
 * provenance.
 *
 * This is the read-side seam for rows written before the derivation existed.
 * `agent_component_versions.source` is `""` on every historical row (the
 * collector's sentinel), and that column participates in the version identity,
 * so it is NOT rewritten in place — re-keying it would fork every retained
 * revision into a second row under a new identity. Resolving at read time
 * instead means no revision reports `""` while the stored identity tuple stays
 * byte-identical.
 */
export function resolveComponentSource(
  stored: string | null | undefined,
  provenance: ComponentSourceProvenance
): { value: string; kind?: ComponentSourceKind } {
  const persisted = boundedOrNull(stored);
  if (persisted) {
    // A persisted label predates the derivation, so which branch would have
    // produced it is unknowable — the kind is OMITTED rather than guessed. A
    // consumer seeing no kind knows only "this is the label that was stored",
    // which is the truth.
    return { value: persisted };
  }
  return classifyComponentSource(provenance);
}

/**
 * ISS-6232: fold the provenance of the SEVERAL inventory rows that make up one
 * component identity into the single provenance {@link deriveComponentSource}
 * reads — the "observed from more than one source" case.
 *
 * A component installed on two machines (or captured by two collectors) can
 * carry its pack on one row and only a bare install path on another, so reading
 * the representative row alone would report `organic` for a component that is
 * demonstrably pack-sourced. Each field takes the FIRST non-empty value in row
 * order, which — combined with the total precedence in
 * {@link deriveComponentSource} — makes the union resolve to the most specific
 * origin any observer actually saw, independently of which row happens to be
 * canonical. Rows must be passed canonical-first so ties resolve to the
 * representative revision.
 *
 * `packId` is the ONE field that is not a plain first-non-empty pick: a pack id
 * that merely echoes the component's own identity is uninformative, so the fold
 * takes the first NON-ECHO pack and only falls back to an echo when no row has a
 * real one (see {@link firstUsablePackId}). Picking positionally instead would
 * let the canonical row's echo mask a later row that proves the actual pack, and
 * {@link deriveComponentSource} would then report `unknown` for a component
 * another observer demonstrably saw inside a pack.
 */
export function unionComponentSourceProvenance(
  rows: readonly ComponentSourceProvenance[],
  identityKeys: readonly (string | null | undefined)[]
): ComponentSourceProvenance {
  const foldedKeys = unionIdentityKeys(rows, identityKeys);
  return {
    packId: firstUsablePackId(rows, foldedKeys),
    sourceUrl: firstNonEmpty(rows, (row) => row.sourceUrl),
    scope: firstNonEmpty(rows, (row) => row.scope),
    projectPath: firstNonEmpty(rows, (row) => row.projectPath),
    installPath: firstNonEmpty(rows, (row) => row.installPath),
    identityKeys: foldedKeys,
  };
}

/**
 * Strip the ENTIRE userinfo (`user:password@`) from an http(s) URL so a
 * credential embedded in a remote never reaches a store, a log, or the org-wide
 * catalog. Shared with the desktop honest-source resolver, which applies the
 * same rule to the same column.
 *
 * The authority segment is matched GREEDILY up to its LAST `@`, which is the
 * delimiter the WHATWG URL parser itself uses. Stopping at the FIRST `@` (as
 * this did before review) leaves the tail of a password that legally contains a
 * raw `@` in the output: `https://alice:pa@ss@example.com/repo` became
 * `https://ss@example.com/repo`, persisting half a credential. `[^/]` keeps the
 * match inside the authority, so an `@` in the PATH is never treated as a
 * userinfo delimiter.
 */
export function stripUrlUserinfo(url: string): string {
  return url.replace(URL_USERINFO_RE, "$1");
}

const URL_USERINFO_RE = /^(https?:\/\/)[^/]*@/i;

function trimmedOrNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * {@link trimmedOrNull} plus the {@link MAX_COMPONENT_SOURCE_LENGTH} cap: an
 * over-long provenance string is corrupt input, so it is treated as absent
 * rather than emitted or truncated. Applied at EVERY read of a provenance
 * string — both the derivation and the multi-row fold — so an over-cap value can
 * neither be reported nor mask a valid value on another row.
 */
function boundedOrNull(value: string | null | undefined): string | null {
  const trimmed = trimmedOrNull(value);
  if (trimmed == null || trimmed.length > MAX_COMPONENT_SOURCE_LENGTH) {
    return null;
  }
  return trimmed;
}

/**
 * Is this pack id just the component's own identity restated? Compared against
 * EVERY identity alias, and both operands go through
 * {@link normalizeComponentKey} because the plugin scanner persists `pack_id`
 * RAW while the cross-surface identity key is lowercased and trimmed, so a
 * mixed-case id would otherwise escape the check on one surface and not the
 * other.
 */
function isIdentityEcho(
  packId: string,
  identityKeys: readonly (string | null | undefined)[] | undefined
): boolean {
  const normalizedPack = normalizeComponentKey(packId);
  if (normalizedPack.length === 0) {
    return false;
  }
  return (identityKeys ?? []).some((identityKey) => {
    const key = normalizeComponentKey(identityKey);
    return key.length > 0 && key === normalizedPack;
  });
}

/**
 * Is this definition vendored by an installed plugin? A `plugin` scope is
 * POSITIVE evidence of a non-local origin, so it disqualifies the `organic`
 * terminal even though it is also local-definition evidence.
 */
function isPluginVendored(provenance: ComponentSourceProvenance): boolean {
  return trimmedOrNull(provenance.scope) === ComponentScope.Plugin;
}

/** Does this row prove a definition physically exists on the machine? */
function hasLocalDefinitionEvidence(
  provenance: ComponentSourceProvenance
): boolean {
  return Boolean(
    boundedOrNull(provenance.installPath) ||
      boundedOrNull(provenance.scope) ||
      boundedOrNull(provenance.projectPath)
  );
}

function firstNonEmpty(
  rows: readonly ComponentSourceProvenance[],
  pick: (row: ComponentSourceProvenance) => string | null | undefined
): string | null {
  for (const row of rows) {
    const value = boundedOrNull(pick(row));
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * Every identity alias the fold must know: the caller's, plus each row's own.
 * Carried onto the folded provenance so a row-level alias still rejects its own
 * echo when {@link deriveComponentSource} runs over the FOLD — the fallback
 * below can hand an echo forward when no row has a real pack, and the derivation
 * has to recognise it as one.
 */
function unionIdentityKeys(
  rows: readonly ComponentSourceProvenance[],
  identityKeys: readonly (string | null | undefined)[]
): readonly (string | null | undefined)[] {
  const keys = new Set<string>();
  for (const key of identityKeys) {
    keys.add(normalizeComponentKey(key));
  }
  for (const row of rows) {
    for (const key of row.identityKeys ?? []) {
      keys.add(normalizeComponentKey(key));
    }
  }
  keys.delete("");
  return [...keys];
}

/**
 * The first pack id across `rows` that is NOT the component's own identity
 * restated, falling back to the first echoed one when no row carries a real
 * pack. Taking the first non-empty pack positionally instead would keep the
 * canonical row's known scanner echo (`pack_id = component_key`) and discard a
 * later row that proves the actual pack.
 */
function firstUsablePackId(
  rows: readonly ComponentSourceProvenance[],
  identityKeys: readonly (string | null | undefined)[]
): string | null {
  let echoed: string | null = null;
  for (const row of rows) {
    const packId = boundedOrNull(row.packId);
    if (!packId) {
      continue;
    }
    if (!isIdentityEcho(packId, identityKeys)) {
      return packId;
    }
    echoed ??= packId;
  }
  return echoed;
}
