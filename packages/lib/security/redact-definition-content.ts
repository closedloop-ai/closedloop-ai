import { usageScopeHashForContent } from "@repo/api/src/agent-component-usage-scope";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import type { AgentComponentInvocationSyncItem } from "@repo/api/src/types/agent-component-invocation";
import { REDACTION_MARKER_PREFIX, redactSecrets } from "./redact-secrets";

/**
 * ISS-4965: scrub secrets out of an invocation's `definitionContent`. Shared by
 * the Desktop producer (`agent-component-invocation-sync-payload.ts`) and the
 * cloud's staging write (`component-invocation-wire-row.ts`), which covers
 * Desktop builds that predate the producer half.
 *
 * The cloud fingerprints the content it holds and rejects a `definitionHash`
 * that disagrees with it, so a rewritten body carries the fingerprint of the
 * rewritten bytes. A hash or contract version the item did not carry stays
 * omitted.
 */
export function redactInvocationDefinitionContent(
  item: AgentComponentInvocationSyncItem
): AgentComponentInvocationSyncItem {
  if (item.definitionContent === undefined) {
    return item;
  }
  const definitionContent = redactSecrets(item.definitionContent);
  if (definitionContent === item.definitionContent) {
    return item;
  }
  const fingerprint = computeDefinitionHash({
    body: definitionContent,
    kind: item.kind,
  });
  return {
    ...item,
    definitionContent,
    ...(item.definitionHash === undefined
      ? {}
      : { definitionHash: fingerprint.definitionHash }),
    ...(item.normalizerContractVersion === undefined
      ? {}
      : { normalizerContractVersion: fingerprint.normalizerContractVersion }),
  };
}

/** Whether `content` holds a marker {@link redactSecrets} wrote. */
export function carriesRedactionMarker(content: string): boolean {
  return content.includes(REDACTION_MARKER_PREFIX);
}

/**
 * ISS-4965: scrub secrets out of one inventory definition body. A body this
 * rewrote keeps the usage digest (`usageScopeHashForContent`) of the text as
 * written, because usage rows are stamped with that digest and the redacted
 * body cannot reproduce it (Perrin, 2026-10-05, ISS-4965). Shared by the Desktop
 * producer (`component-sync-source.ts`) and the cloud parser
 * (`desktop-agent-components-parse.ts`).
 */
export function redactDefinitionBody(
  content: string,
  componentKind: string
): RedactedDefinitionBody {
  const redacted = redactSecrets(content);
  const usageScopeHash =
    redacted === content
      ? null
      : usageScopeHashForContent(content, componentKind);
  return usageScopeHash
    ? { content: redacted, usageScopeHash }
    : { content: redacted };
}

/** A definition body as it may leave Desktop or be stored in the cloud. */
export type RedactedDefinitionBody = {
  content: string;
  /** Present only when redaction rewrote `content`. */
  usageScopeHash?: string;
};
