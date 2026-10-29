/**
 * ISS-9395 — the reads both complete-surface registry suites need, once.
 *
 * The two suites deliberately hand-write their EXPECTATIONS separately (that
 * independence is what lets them fail). These helpers are not expectations —
 * they are how a registry entry is inspected — so sharing them removes a copy
 * that had to be kept in sync by hand without weakening either suite.
 */

import { readFileSync } from "node:fs";
import ts from "typescript6";
import {
  type CompleteSurfaceEntry,
  SurfaceMastery,
} from "../complete-surface-registry";

/**
 * The names a module exports, read from the AST.
 *
 * Text-scanning implementation source is banned (`no-raw-text-source-scan`),
 * and the ban earns its keep here: the surfaces these registries own are
 * declared as both `export function X` and `export const X = (…) =>`, so a
 * substring check would have to know every spelling and would still miss the
 * next one.
 */
export function exportedNames(absolutePath: string): readonly string[] {
  const source = ts.createSourceFile(
    absolutePath,
    readFileSync(absolutePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!hasExportModifier(statement)) {
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.push(statement.name.text);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.push(declaration.name.text);
        }
      }
    }
  }
  return names;
}

/** How many entries carry `mastery`, across one registry's values. */
export function countOfMastery(
  entries: readonly CompleteSurfaceEntry[],
  mastery: SurfaceMastery
): number {
  return entries.filter((entry) => entry.mastery === mastery).length;
}

/**
 * Every repo-relative host path an entry names — both hosts and any legacy
 * hosts for a `Mastered` entry, the single present host for a `SingleHost` one,
 * and nothing for an entry that names no host at all.
 */
export function hostPathsOfEntry(
  entry: CompleteSurfaceEntry
): readonly string[] {
  if (entry.mastery === SurfaceMastery.Mastered) {
    return [entry.webHost, entry.desktopHost, ...(entry.legacyHosts ?? [])];
  }
  if (entry.mastery === SurfaceMastery.Partial) {
    return [entry.webHost, entry.desktopHost];
  }
  if (entry.mastery === SurfaceMastery.SingleHost) {
    return [entry.presentHost];
  }
  return [];
}

/** The owner an entry names, or nothing when it names none. */
export function ownerOfEntry(
  entry: CompleteSurfaceEntry
): { module: string; exportName: string } | undefined {
  if (
    entry.mastery === SurfaceMastery.IntentionallyExcluded ||
    entry.mastery === SurfaceMastery.Undecided
  ) {
    return undefined;
  }
  return entry.owner ?? undefined;
}

function hasExportModifier(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    )
  );
}
