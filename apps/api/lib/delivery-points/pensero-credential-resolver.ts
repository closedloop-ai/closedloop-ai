import "server-only";

import { withDb } from "@repo/database";
import {
  type PenseroResolvedCredential,
  resolvePenseroCredential,
} from "@repo/pensero/credential";
import type { PenseroRequestCredential } from "@repo/pensero/delivery-client";
import { keys } from "@repo/pensero/keys";
import { decryptSecret, KmsSecretPurpose } from "@/lib/crypto/kms-secret";

/**
 * Just-in-time, callback-scoped access to one organization's Pensero credential
 * (ISS-8761, under the operator decision of 2026-09-01).
 *
 * ## This deliberately reverses a written contract, with approval
 *
 * `penseroIntegrationService` states that it has no `get…Token` method because
 * the stored token embeds an `sk_` secret half, and until now
 * `KmsSecretPurpose.PenseroApiToken` had exactly one call site — the encrypt.
 * That contract was correct for a browser-reachable settings route and is
 * unchanged there: nothing in `apps/api/app/settings/pensero/` decrypts, and no
 * response shape anywhere carries a token.
 *
 * What is approved is a decrypt on the AUTHENTICATED SERVER-SIDE CRON PATH
 * only, because the multi-tenant scheduler cannot poll a provider on an org's
 * behalf without that org's credential, and the alternative — a deployment-wide
 * token standing in for every tenant — is the cross-tenant leak this whole
 * feature is scoped against.
 *
 * ## Why a callback and not a getter
 *
 * A function returning the token would put it in the caller's scope, where it
 * can be spread into a log line, stored on a report, or returned up a stack
 * that eventually reaches a response body. Handing it to a callback keeps its
 * lifetime bounded by one call frame that this module owns: the value is
 * created here, used by `use`, and unreachable afterwards. It is never logged,
 * never re-persisted, never placed on a returned object, and never crosses into
 * browser-bundled code — this module is `server-only`.
 *
 * The RESULT of the callback is what comes back. Callers therefore cannot get
 * the credential out by returning it, because the type they return is theirs to
 * choose and nothing here forwards the credential into it.
 */

/** One organization with a stored Pensero credential, as the sweep sees it. */
export type PenseroConfiguredOrganization = {
  readonly organizationId: string;
  /**
   * Provider team identifiers this org narrows its poll to. Empty means "do
   * not narrow" — the parameter is omitted and the provider answers for all
   * teams. Never derived from ClosedLoop `Team` names.
   */
  readonly teamIdentifiers: readonly string[];
};

/**
 * Every organization that has configured its OWN Pensero credential.
 *
 * Deliberately does NOT include organizations relying on the deployment-wide
 * `PENSERO_API_TOKEN`: that credential belongs to whoever operates the
 * deployment, and using it to poll on behalf of every tenant on a multi-tenant
 * install would attribute one Pensero account's delivery data across orgs that
 * never configured it. The env var stays what `resolvePenseroCredential`
 * already documents it as — the single-tenant / self-hosted default — and it
 * still supplies the base URL for an org that set only a token.
 *
 * The encrypted token column is NOT selected here. The sweep needs to know
 * WHICH orgs to visit before it needs any secret, and reading ciphertext it has
 * no immediate use for is how a secret ends up on an object that outlives the
 * call that needed it.
 */
export async function listPenseroConfiguredOrganizations(): Promise<
  PenseroConfiguredOrganization[]
> {
  const rows = await withDb((db) =>
    db.penseroIntegration.findMany({
      select: { organizationId: true, teamIdentifiers: true },
      orderBy: { organizationId: "asc" },
    })
  );
  const sweptAt = await readLastSweptAtByOrganization(
    rows.map((row) => row.organizationId)
  );
  return rows
    .map((row) => ({
      organizationId: row.organizationId,
      teamIdentifiers: row.teamIdentifiers,
    }))
    .sort(
      (left, right) =>
        lastSweptRank(sweptAt, left.organizationId) -
          lastSweptRank(sweptAt, right.organizationId) ||
        left.organizationId.localeCompare(right.organizationId)
    );
}

/**
 * When each organization's cursors were last written, i.e. when it was last
 * swept. Organizations with no cursor row have never been swept and are absent.
 *
 * `updatedAt` is `@updatedAt` on `PenseroBackfillCursor` and the sweep writes
 * that row exactly once per organization per run, so it already IS the
 * last-swept timestamp — no column and no migration is needed to order by it.
 */
async function readLastSweptAtByOrganization(
  organizationIds: readonly string[]
): Promise<Map<string, number>> {
  if (organizationIds.length === 0) {
    return new Map();
  }
  const rows = await withDb((db) =>
    db.penseroBackfillCursor.findMany({
      where: { organizationId: { in: [...organizationIds] } },
      select: { organizationId: true, updatedAt: true },
    })
  );
  return new Map(
    rows.map((row) => [row.organizationId, row.updatedAt.getTime()])
  );
}

/**
 * LEAST-RECENTLY-SWEPT FIRST, never-swept before everything (codex + whitlockk,
 * #6492).
 *
 * The sweep has a wall-clock budget, so on a large or slow install it does not
 * reach every tenant every run. Under the previous fixed `organizationId ASC`
 * ordering that is not a deferral, it is permanent starvation: the same
 * alphabetical prefix consumes the budget every night and the tail is NEVER
 * swept, however long it waits. Rotating on last-swept time makes the budget
 * bound WORK rather than pick winners — the tenant the budget cut off leads the
 * next run.
 *
 * The organization id breaks ties, so the order is still total and the sweep is
 * still reproducible for a given ledger state.
 */
function lastSweptRank(
  sweptAt: ReadonlyMap<string, number>,
  organizationId: string
): number {
  return sweptAt.get(organizationId) ?? Number.NEGATIVE_INFINITY;
}

/**
 * Resolve one organization's Pensero credential, hand it to `use`, and return
 * only what `use` returns.
 *
 * Returns `null` — without calling `use` — when the organization has no usable
 * credential. That is a clean no-op rather than a throw, matching
 * `resolvePenseroCredential`'s own position: an unconfigured org is not an
 * error, it is an org the sweep skips.
 *
 * The org row WINS over the env var, per `resolvePenseroCredential`. The base
 * URL resolves on its own axis, so an org that set only a token on a
 * self-hosted deployment still reaches that deployment's Pensero rather than
 * being silently redirected to the public host.
 *
 * `baseUrlSource` travels with the credential because it is what decides
 * whether the fetch's egress is pinned (ISS-9690): the sweep is the path on
 * which a TENANT-supplied base becomes a live credentialed request, and the
 * client cannot tell an org-typed internal https host from an operator-set one
 * by inspecting the URL. Dropping the label here would silently unpin the cron,
 * which is the exposure this exists to close.
 */
export async function withOrgPenseroCredential<T>(
  organizationId: string,
  use: (credential: PenseroRequestCredential) => Promise<T>
): Promise<T | null> {
  const resolved = await resolveOrgPenseroCredential(organizationId);
  if (!resolved) {
    return null;
  }
  return await use({
    token: resolved.token,
    baseUrl: resolved.baseUrl,
    baseUrlSource: resolved.baseUrlSource,
  });
}

/**
 * The decrypt itself, kept private so the plaintext has exactly one producer
 * and no exported shape carries it.
 */
async function resolveOrgPenseroCredential(
  organizationId: string
): Promise<PenseroResolvedCredential | null> {
  const row = await withDb((db) =>
    db.penseroIntegration.findUnique({
      where: { organizationId },
      select: { apiTokenEncrypted: true, baseUrl: true },
    })
  );
  if (!row) {
    return null;
  }

  const token = await decryptSecret(
    row.apiTokenEncrypted,
    KmsSecretPurpose.PenseroApiToken
  );
  const config = keys();
  return resolvePenseroCredential({
    organization: { token, baseUrl: row.baseUrl },
    env: {
      token: config.PENSERO_API_TOKEN,
      baseUrl: config.PENSERO_API_BASE_URL,
    },
  });
}
