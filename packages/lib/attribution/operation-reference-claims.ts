/**
 * ISS-12552: reference claims, one per ClosedLoop slug the session named in
 * prose, in another tool's text, or nested in a ClosedLoop call's structured
 * result (a list or search hit, a linked artifact). A reference proves a
 * mention, nothing more, so each slug is claimed once, anchored at its first
 * sighting.
 */
import {
  type OperationClaim,
  OperationClaimSource,
} from "@repo/api/src/types/operation-claims";
import { buildSlugPrefixAlternation } from "@repo/api/src/types/slug-prefix";
import { flattenTextValues } from "../harness/parser-utils";
import type { IndexedToolUse } from "../harness/session-tool-uses";
import type { NormalizedSession } from "../harness/types";

const REFERENCE_SLUG_RE = new RegExp(
  String.raw`\b(?:${buildSlugPrefixAlternation()})-\d+\b`,
  "g"
);

type Sighting = { agentId?: string; at?: string };

/** A slug a ClosedLoop call's result names beside the call's own target. */
export type ResultSlugSighting = Sighting & { slug: string };

/**
 * Reference claims for every slug in human and assistant prose, in the text
 * of non-ClosedLoop tools, and in ClosedLoop results' nested slugs. A
 * ClosedLoop call's raw text is never scanned: its MCP claim reads the
 * structured result, which is where `resultSlugs` come from.
 */
export function extractReferenceClaims(
  session: NormalizedSession,
  otherToolUses: readonly IndexedToolUse[],
  resultSlugs: readonly ResultSlugSighting[] = []
): OperationClaim[] {
  const sightings = new Map<string, Sighting>();
  for (const message of session.messages) {
    if (
      message.role === "system" ||
      message.isSynthetic ||
      message.isForkReplayed
    ) {
      continue;
    }
    recordSightings(sightings, message.text ?? "", {
      at: message.timestamp ?? undefined,
    });
  }
  for (const { tu, agentId } of otherToolUses) {
    const text = [
      ...flattenTextValues(tu.input),
      ...flattenTextValues(tu.output),
    ].join("\n");
    recordSightings(sightings, text, {
      ...(agentId ? { agentId } : {}),
      at: tu.timestamp ?? undefined,
    });
  }
  for (const { slug, ...sighting } of resultSlugs) {
    if (!sightings.has(slug)) {
      sightings.set(slug, sighting);
    }
  }
  return [...sightings].map(([slug, sighting]) => ({
    claimKey: `ref:${slug}`,
    source: OperationClaimSource.Reference,
    referenceSlug: slug,
    ...(sighting.agentId ? { agentId: sighting.agentId } : {}),
    ...(sighting.at ? { invokedAt: sighting.at } : {}),
  }));
}

function recordSightings(
  sightings: Map<string, Sighting>,
  text: string,
  sighting: Sighting
): void {
  for (const match of text.matchAll(REFERENCE_SLUG_RE)) {
    if (!sightings.has(match[0])) {
      sightings.set(match[0], sighting);
    }
  }
}
