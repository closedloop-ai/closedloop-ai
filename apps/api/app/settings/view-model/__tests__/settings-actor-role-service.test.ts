/**
 * ISS-10335 and ISS-11468: `readSettingsActorRole` under `AUTH_MODE=local_trusted`.
 *
 * The Clerk SDK client is the only stub, and the real `clerkService` sits
 * between it and the read, because since ISS-11468 the synthetic answer comes
 * from that boundary rather than from a guard in this service. That is what
 * makes both cases falsifiable: the synthetic case asserts the SDK was NOT
 * asked, so a boundary that fell through to Clerk would fail naming the call,
 * and the Clerk case asserts it WAS, so a boundary that answered synthetically
 * everywhere would fail there.
 *
 * Measured: with the provider unreachable on that lane the read returned
 * `Unresolved`, the route answered 503, and the Settings rail rendered inert on
 * 15 e2e specs (PR #7370).
 */
import { OrgAdminRole } from "@repo/api/src/types/org-admin-role";
import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role";
import {
  AuthMode,
  E2E_LOCAL_TRUSTED_AUTH_ENABLED,
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  E2E_LOCAL_TRUSTED_ORG_ID_ENV,
  E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
  E2E_LOCAL_TRUSTED_USER_ID_ENV,
  LOCAL_TRUSTED_ORG_ID,
  LOCAL_TRUSTED_USER_ID,
} from "@repo/auth/auth-mode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOrganizationMembershipList: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(async () => ({
    organizations: {
      getOrganizationMembershipList: mocks.getOrganizationMembershipList,
    },
  })),
}));

import { readSettingsActorRole } from "../settings-actor-role-service";

/** The synthetic identity, which is who every local_trusted request acts as. */
const ACTOR = {
  clerkOrgId: LOCAL_TRUSTED_ORG_ID,
  clerkUserId: LOCAL_TRUSTED_USER_ID,
};

/**
 * The identity overrides `e2e/compose.yml` forwards. The boundary answers admin
 * only for the identity `resolveLocalTrustedIdentity()` reports, so an exported
 * sandbox id would move it away from {@link ACTOR}.
 */
const IDENTITY_OVERRIDE_KEYS = [
  E2E_LOCAL_TRUSTED_ORG_ID_ENV,
  E2E_LOCAL_TRUSTED_ORG_SLUG_ENV,
  E2E_LOCAL_TRUSTED_USER_ID_ENV,
] as const;

/** Every key this suite writes, so `afterEach` restores the exact prior state. */
const ENV_KEYS = [
  "AUTH_MODE",
  E2E_LOCAL_TRUSTED_AUTH_ENV,
  ...IDENTITY_OVERRIDE_KEYS,
  "NODE_ENV",
  "VERCEL_ENV",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

describe("readSettingsActorRole on the local_trusted lane (ISS-10335, ISS-11468)", () => {
  beforeEach(() => {
    mocks.getOrganizationMembershipList.mockReset();
  });

  afterEach(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        setEnv(key, value);
      }
    }
  });

  it("resolves the synthetic admin role without asking Clerk", async () => {
    activateLocalTrusted();

    const read = await readSettingsActorRole(ACTOR);

    expect(read.resolution).toEqual({
      status: SettingsActorRoleStatus.Resolved,
      role: SettingsActorRole.Admin,
    });
    expect(read.staleSessionRole).toBe(false);
    expect(mocks.getOrganizationMembershipList).not.toHaveBeenCalled();
  });

  it("still reads Clerk when local_trusted is not configured", async () => {
    Reflect.deleteProperty(process.env, "AUTH_MODE");
    mocks.getOrganizationMembershipList.mockResolvedValue({
      data: [{ role: OrgAdminRole.Owner }],
    });

    const read = await readSettingsActorRole(ACTOR);

    expect(read.resolution).toEqual({
      status: SettingsActorRoleStatus.Resolved,
      role: SettingsActorRole.Owner,
    });
    expect(mocks.getOrganizationMembershipList).toHaveBeenCalledWith({
      organizationId: ACTOR.clerkOrgId,
      userId: [ACTOR.clerkUserId],
      limit: 1,
    });
  });
});

/**
 * `NODE_ENV` is set to a non-production value and `VERCEL_ENV` and the identity
 * overrides removed explicitly, so neither an inherited deploy signal nor an
 * exported sandbox id can make the synthetic case fail for a reason unrelated to
 * the role read.
 */
function activateLocalTrusted(): void {
  setEnv("AUTH_MODE", AuthMode.LocalTrusted);
  setEnv(E2E_LOCAL_TRUSTED_AUTH_ENV, E2E_LOCAL_TRUSTED_AUTH_ENABLED);
  setEnv("NODE_ENV", "test");
  Reflect.deleteProperty(process.env, "VERCEL_ENV");
  for (const key of IDENTITY_OVERRIDE_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
}

/** `Reflect.set`, because `process.env.NODE_ENV` is typed read-only here. */
function setEnv(key: string, value: string): void {
  Reflect.set(process.env, key, value);
}
