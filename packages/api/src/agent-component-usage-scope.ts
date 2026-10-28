import { computeDefinitionHash } from "./definition-fingerprint";
import { AgentComponentKind } from "./types/agent-component";

/**
 * @file agent-component-usage-scope.ts
 * @description The ONE translation from a definition's CONTENT to the digest an
 * `AgentComponentSessionUsage` row's `componentVersionHash` actually carries.
 *
 * Two digest spaces meet on the agent-component surfaces and they never agree
 * for the same file. `AgentComponent.contentHash` / `AgentComponentVersion
 * .contentHash` — which every routable slug and the detail's version selector
 * key on — is a raw `sha256Hex(content)`. A usage row's `componentVersionHash`
 * is stamped at invocation from `agent_component_invocations.definition_hash`,
 * which is the domain-tagged, kind-scoped, length-framed
 * `computeDefinitionHash({ frontmatter: "", body: content, kind })`. Scoping
 * usage by a selector's own coarse hash therefore matches NOTHING, and a
 * per-version read that did it returned a measured-looking `0` for every
 * revision (ISS-4403 on desktop; ISS-10467 on the cloud half).
 *
 * It lives in `@repo/api` rather than beside either consumer because BOTH the
 * Electron main process (`apps/desktop/src/main/dashboard/usage-scope-hash.ts`)
 * and the cloud version-usage read (`apps/api/app/agent-components/service/
 * version-usage-identity.ts`) have to answer "which usage rows are this
 * revision's" with the same digest, and two copies of this translation would be
 * two ways to answer it.
 */

// Derived from the canonical `AgentComponentKind` const object (SSOT) so a kind
// added there is recognized automatically rather than silently coerced.
export const KNOWN_AGENT_COMPONENT_KINDS: ReadonlySet<string> = new Set(
  Object.values(AgentComponentKind)
);

/** Coerce a stored kind string to the canonical union; unknown → `config`. */
export function toAgentComponentKind(value: string): AgentComponentKind {
  return (
    KNOWN_AGENT_COMPONENT_KINDS.has(value) ? value : AgentComponentKind.Config
  ) as AgentComponentKind;
}

/**
 * The usage-space digest for one definition body, or `null` when there is no
 * captured body to hash — which is "cannot be scoped", never "scoped to
 * nothing".
 *
 * ABSENCE IS `null`/`undefined` AND NOTHING ELSE. An empty definition body is a
 * real, hashable revision: the desktop version sync retains it and the cloud
 * column is non-null, so both surfaces hold a genuine digest for it. Treating
 * `""` as absent (a bare falsy test) sent an otherwise-known revision down the
 * not-computed branch on desktop while the cloud path reported its measured
 * usage — one revision, two surfaces, two different answers (whitlockk, ISS-10467).
 */
export function usageScopeHashForContent(
  content: string | null | undefined,
  kind: string
): string | null {
  if (content == null) {
    return null;
  }
  return computeDefinitionHash({
    frontmatter: "",
    body: content,
    kind: toAgentComponentKind(kind),
  }).definitionHash;
}
