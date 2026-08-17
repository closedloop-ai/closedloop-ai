/**
 * Provider-neutral VCS host identifier — the single source of truth for the
 * PERSISTED provider discriminator (FEA-3874, parent FEA-3801, PLN-1457
 * Slice 2).
 *
 * WHY ITS OWN LEAF MODULE
 * -----------------------
 * This const is the discriminator carried by the persisted connection row
 * (`VcsConnection.provider`, projected from `GitHubInstallation`). It lives in
 * its own module — deliberately lightweight and dependency-free (no GitHub enum
 * or mapper imports) — so bundle-sensitive consumers, and the desktop `nodenext`
 * program, can import the identifier without pulling in the neutral mappers in
 * `vcs-neutral.ts`, which re-exports this same const so both surfaces share ONE
 * value.
 */
export const VcsProviderKind = {
  GitHub: "github",
  GitLab: "gitlab",
} as const;
export type VcsProviderKind =
  (typeof VcsProviderKind)[keyof typeof VcsProviderKind];
