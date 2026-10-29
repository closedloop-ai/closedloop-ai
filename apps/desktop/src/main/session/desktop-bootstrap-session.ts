import type {
  DesktopBootstrapOrganizationInput,
  DesktopBootstrapOrganizationResult,
  DesktopBrowserSignInResult,
} from "../../shared/contracts.js";
import {
  createDesktopBootstrapOrganization,
  type RedeemDesktopBootstrapInput,
} from "../auth/desktop-bootstrap-client.js";
import type { DesktopSessionTokens } from "./desktop-session-client.js";
import type { ResolvedBrowserSignInDeps } from "./desktop-session-manager-types.js";

type BootstrapSessionDeps = {
  resolveApiOrigin: () => string;
  getGeneration: () => number;
  popSigner: RedeemDesktopBootstrapInput["popSigner"];
  fetchImpl?: typeof fetch;
  onAwaitingOrganization: (pendingUserId: string) => void;
  applyTokens: (tokens: DesktopSessionTokens, issuingOrigin: string) => void;
};

export class DesktopBootstrapSession {
  private readonly deps: BootstrapSessionDeps;
  private token: string | null = null;

  constructor(deps: BootstrapSessionDeps) {
    this.deps = deps;
  }

  clear(): void {
    this.token = null;
  }

  async redeem(
    browserDeps: ResolvedBrowserSignInDeps,
    input: Omit<
      RedeemDesktopBootstrapInput,
      "apiOrigin" | "popSigner" | "fetchImpl"
    >
  ): Promise<DesktopBrowserSignInResult> {
    const generation = this.deps.getGeneration();
    const result = await browserDeps.redeemBootstrap({
      apiOrigin: this.deps.resolveApiOrigin(),
      ...input,
      popSigner: this.deps.popSigner,
      fetchImpl: this.deps.fetchImpl,
    });
    if (result.ok && this.deps.getGeneration() === generation) {
      this.token = result.value.bootstrapToken;
      this.deps.onAwaitingOrganization(result.value.pendingUserId);
      return { ok: true };
    }
    if (result.ok) {
      return { ok: false, reason: "cancelled" };
    }
    browserDeps.logDiagnostic(
      `Desktop bootstrap exchange failed: ${result.error} (retryable=${result.retryable})`
    );
    return {
      ok: false,
      reason: result.error === "invalid" ? "expired" : "exchange_failed",
    };
  }

  async createOrganization(
    organization: DesktopBootstrapOrganizationInput
  ): Promise<DesktopBootstrapOrganizationResult> {
    const token = this.token;
    if (!token) {
      return { ok: false, error: "bootstrap_unavailable" };
    }
    const generation = this.deps.getGeneration();
    const apiOrigin = this.deps.resolveApiOrigin();
    const result = await createDesktopBootstrapOrganization({
      apiOrigin,
      bootstrapToken: token,
      organization,
      fetchImpl: this.deps.fetchImpl,
    });
    if (!result.ok) {
      if (!result.retryable) {
        this.clear();
      }
      return { ok: false, error: result.error };
    }
    if (this.deps.getGeneration() !== generation) {
      return { ok: false, error: "cancelled" };
    }
    this.clear();
    this.deps.applyTokens(result.value, apiOrigin);
    return { ok: true };
  }
}
