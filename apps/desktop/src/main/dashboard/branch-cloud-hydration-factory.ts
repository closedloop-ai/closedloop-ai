import {
  type NormalizedPersistedRepositoryDefaultAuthority,
  repositoryDefaultEvidenceValidator,
  repositoryDefaultIdentityValidator,
  repositoryDefaultProvenanceValidator,
} from "@repo/api/src/types/repository-default-identity";
import type { BrowserWindow } from "electron";
import { z } from "zod";
import type { BranchCloudHydrationSource } from "../branch/shared-branches-api.js";
import {
  DesktopCloudGitHubHydration,
  type DesktopCloudSessionIdentity,
} from "../cloud/desktop-cloud-github-hydration.js";
import { parseCloudGithubBranchOverlayMap } from "../database/cloud-github-overlay-store.js";
import { sendToRendererWindow } from "../ipc/renderer-ipc.js";
import { reportRepositoryDefaultAuthorityWriteFailure } from "../telemetry/repository-default-authority-telemetry.js";

/**
 * The narrow slice of the dashboard runtime's options the branch cloud
 * hydration factory needs. Structurally satisfied by
 * `AgentDashboardDesignSystemRuntimeOptions`; kept as its own type so the
 * factory is testable without booting the runtime (PR #3994 review) and so
 * this module never imports the runtime (no cycle).
 */
export type BranchCloudHydrationFactoryOptions = {
  getApiOrigin?: () => string;
  getApiKey?: () => string | null;
  getAccessToken?: () => Promise<string | null>;
  /**
   * The signed-in Desktop session's account identity
   * (`DesktopSessionManager.getIdentity()`) — the session lane's gate AND its
   * cache-identity discriminator. Without it, session-auth accounts on one
   * machine would share a cache/persist identity (the PR #3994 review P0).
   */
  getSessionIdentity?: () => DesktopCloudSessionIdentity | null;
  /** Invalidate the cached session token on a 401 (early revocation). */
  invalidateAccessToken?: () => void;
  getUserIdentity?: () => {
    userId: string | null;
    organizationId: string | null;
  } | null;
  getProfileId?: () => string | null;
  getComputeTargetId?: () => string | null;
  getWindow: () => BrowserWindow | null;
  /** Test seam: injected fetch for factory behavior tests (defaults to global). */
  fetch?: typeof fetch;
  /** Test seam for the payload-free authority write-failure reporter. */
  reportRepositoryDefaultAuthorityWriteFailure?: () => void;
};

type InvokeStoreOp = (name: string, args?: unknown[]) => Promise<unknown>;

/**
 * Build the branch cloud hydration source for the dashboard runtime, or
 * undefined when no credential source is wired at all.
 *
 * PLN-1535 M3: session-first. A wired first-party session source is
 * sufficient on its own — the sk_live_* key only serves not-signed-in
 * compute-target setups. Gating on the key here was why cloud hydration was
 * dark (a false NotConnected) for every session-auth-only user.
 */
export function createBranchCloudHydration(
  options: BranchCloudHydrationFactoryOptions,
  invokeStoreOp: InvokeStoreOp
): BranchCloudHydrationSource | undefined {
  if (!options.getApiOrigin) {
    return undefined;
  }
  const getApiOrigin = options.getApiOrigin;
  if (!(options.getAccessToken || options.getApiKey)) {
    return undefined;
  }
  return new DesktopCloudGitHubHydration({
    getApiKey: options.getApiKey,
    getAccessToken: options.getAccessToken,
    getSessionIdentity: options.getSessionIdentity,
    onUnauthorized: options.invalidateAccessToken,
    fetch: options.fetch,
    getApiOrigin,
    getIdentityScope: () => {
      const identity = options.getUserIdentity?.() ?? null;
      return {
        userId: identity?.userId ?? null,
        organizationId: identity?.organizationId ?? null,
        profileId: options.getProfileId?.() ?? null,
        computeTargetId: options.getComputeTargetId?.() ?? null,
      };
    },
    // PR-field-only peek/warm callers remain non-blocking. Eligibility reads
    // await bounded hydration and reuse that result in the same operation.
    onBackgroundRefresh: () =>
      sendToRendererWindow(options.getWindow(), "desktop:db:changed", {}),
    onRepositoryDefaultAuthorityWriteFailure:
      options.reportRepositoryDefaultAuthorityWriteFailure ??
      reportRepositoryDefaultAuthorityWriteFailure,
    store: {
      readOverlays: async (identityKey, repoNames) =>
        parseCloudGithubBranchOverlayMap(
          await invokeStoreOp("cloudGithubOverlays.read", [
            identityKey,
            repoNames,
          ])
        ),
      writeOverlays: (identityKey, repoNames, overlays, lastSyncedAt) =>
        invokeStoreOp("cloudGithubOverlays.write", [
          identityKey,
          repoNames,
          overlays,
          lastSyncedAt,
        ]).then(() => undefined),
      writeRepositoryDefaultAuthorities: (identityKey, observations) =>
        invokeStoreOp("repositoryDefaultAuthorities.write", [
          identityKey,
          observations,
        ]).then(() => undefined),
      readRepositoryDefaultAuthoritiesByNames: async (
        identityKey,
        repositories
      ) =>
        parsePersistedRepositoryDefaultAuthorities(
          await invokeStoreOp(
            "repositoryDefaultAuthorities.readByRepositoryNames",
            [identityKey, repositories]
          )
        ),
    },
  });
}

const persistedRepositoryDefaultAuthorityShape = {
  repository: repositoryDefaultIdentityValidator,
  evidence: repositoryDefaultEvidenceValidator,
  provenance: repositoryDefaultProvenanceValidator.optional(),
} satisfies Record<
  keyof NormalizedPersistedRepositoryDefaultAuthority,
  z.ZodTypeAny
>;

const persistedRepositoryDefaultAuthoritySchema = z
  .object(persistedRepositoryDefaultAuthorityShape)
  .strict();
const persistedRepositoryDefaultAuthoritiesArraySchema = z.array(z.unknown());

/** Validate the IPC array boundary while retaining every independently valid row. */
function parsePersistedRepositoryDefaultAuthorities(
  value: unknown
): NormalizedPersistedRepositoryDefaultAuthority[] {
  const rows = persistedRepositoryDefaultAuthoritiesArraySchema.parse(value);
  const authorities: NormalizedPersistedRepositoryDefaultAuthority[] = [];
  for (const row of rows) {
    const parsed = persistedRepositoryDefaultAuthoritySchema.safeParse(row);
    if (parsed.success) {
      authorities.push(parsed.data);
    }
  }
  return authorities;
}
