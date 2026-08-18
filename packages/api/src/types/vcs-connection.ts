/**
 * `VcsConnection` — the provider-neutral auth/connection record, introduced as a
 * READ-ONLY PROJECTION over `GitHubInstallation` (FEA-3874, parent FEA-3801,
 * PLN-1457 Slice 3).
 *
 * Phase 1 keeps `GitHubInstallation` as the one live, writable auth table; there
 * is NO new physical connection table and NO dual-write (honoring the
 * `packages/database` "do not dual-write the same entity" rule). Callers that
 * only need to *read* a connection can project a `GitHubInstallation` row into
 * this neutral shape via {@link projectGitHubInstallationToVcsConnection}; the
 * GitHub install / suspend / uninstall / claim write path is untouched. The
 * risky installation-table write-path cutover is deferred to a later phase.
 *
 * `authKind` is always `app_installation` for GitHub in Phase 1. `baseUrl`
 * defaults to the public GitHub host so downstream URL building (Slice 4) has a
 * per-connection host to key on without changing any current output.
 *
 * NB: this module mirrors the neutral status enum from `vcs-neutral.ts` and has
 * no relative VALUE imports beyond that leaf, so it stays importable from the
 * desktop `nodenext` program as well as the app/api bundlers.
 */

import type { GitHubInstallationStatus } from "./github.js";
import {
  type VcsConnectionStatus,
  VcsProviderKind,
  vcsConnectionStatusFromGitHub,
} from "./vcs-neutral.js";

/**
 * How a connection authenticates to its VCS host. GitHub uses a GitHub App
 * installation token today; PAT/OAuth kinds slot in for other providers later.
 */
export const VcsAuthKind = {
  AppInstallation: "app_installation",
  OAuth: "oauth",
  PersonalAccessToken: "personal_access_token",
} as const;
export type VcsAuthKind = (typeof VcsAuthKind)[keyof typeof VcsAuthKind];

/** Public GitHub host used as the default `baseUrl` for GitHub connections. */
export const GITHUB_DEFAULT_BASE_URL = "https://github.com";

/**
 * Provider-neutral connection record. A read-only projection in Phase 1 — no row
 * of this exact shape is persisted; it is derived on read from the live
 * provider-specific auth table (`GitHubInstallation` for GitHub).
 */
export type VcsConnection = {
  /** Stable id of the underlying auth row (the `GitHubInstallation.id`). */
  readonly id: string;
  readonly provider: VcsProviderKind;
  readonly authKind: VcsAuthKind;
  /** VCS host root, e.g. `https://github.com`. Never null in the projection. */
  readonly baseUrl: string;
  readonly status: VcsConnectionStatus;
  /** Owning organization, when the connection has been claimed. */
  readonly organizationId: string | null;
  /**
   * The provider's native connection identifier (the GitHub App
   * `installationId`). Kept so callers can still resolve the provider-specific
   * auth path during the projection window.
   */
  readonly providerConnectionId: string;
};

/**
 * The subset of `GitHubInstallation` columns the projection reads. Declared
 * structurally (not importing the Prisma type) so this stays a
 * bundler/nodenext-safe leaf with no `@repo/database` dependency.
 */
export type GitHubInstallationProjectionSource = {
  id: string;
  organizationId: string | null;
  installationId: string;
  status: GitHubInstallationStatus;
};

/**
 * Project a `GitHubInstallation` row into the neutral {@link VcsConnection}
 * shape. Pure and read-only — performs no writes and preserves the row's
 * identity (`id`), status (via the exhaustive
 * {@link vcsConnectionStatusFromGitHub} mapper), and native installation id.
 */
export function projectGitHubInstallationToVcsConnection(
  installation: GitHubInstallationProjectionSource
): VcsConnection {
  return {
    id: installation.id,
    provider: VcsProviderKind.GitHub,
    authKind: VcsAuthKind.AppInstallation,
    baseUrl: GITHUB_DEFAULT_BASE_URL,
    status: vcsConnectionStatusFromGitHub(installation.status),
    organizationId: installation.organizationId,
    providerConnectionId: installation.installationId,
  };
}
