import { createServer, type IncomingMessage } from "node:http";
import type { GuidedOnboardingSnapshot } from "@repo/api/src/types/onboarding-guided.ts";
import { guidedOnboardingTransitionRequestSchema } from "@repo/api/src/types/onboarding-guided.ts";
import {
  OnboardingRestoreOutcome,
  serializeOnboardingState,
} from "@repo/api/src/types/onboarding-persistence.ts";
import {
  AccountProvider,
  AccountStatus,
  createInitialOnboardingState,
  KnownFlag,
  OrganizationMembership,
} from "@repo/api/src/types/onboarding-phase.ts";

export const ORGLESS_USER_ID = "orgless-e2e-user";
export const CREATED_ORGANIZATION_ID = "orgless-e2e-organization";

/** Only cloud HTTP is substituted; Desktop manager, IPC and storage are real. */
export async function startOrglessBootstrapCloud() {
  const requests: string[] = [];
  const organizationRequests: { authorization?: string; body: unknown }[] = [];
  let snapshot: GuidedOnboardingSnapshot = {
    attemptId: null,
    experienceVariant: null,
    revision: 0,
    restoreOutcome: OnboardingRestoreOutcome.Absent,
    state: serializeOnboardingState(createInitialOnboardingState()),
    context: {
      accountProvider: AccountProvider.Email,
      accountStatus: AccountStatus.Established,
      desktopAppDownloaded: false,
      githubConnected: false,
      membership: OrganizationMembership.FirstUser,
      organizationHasSyncedSessionData: KnownFlag.No,
      teamInvited: false,
      tourCompleted: false,
    },
  };
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const tokens = {
    accessToken: "orgless-e2e-access",
    accessTokenExpiresAt: expiresAt,
    refreshToken: "orgless-e2e-refresh",
    refreshTokenExpiresAt: expiresAt,
    userId: ORGLESS_USER_ID,
    organizationId: CREATED_ORGANIZATION_ID,
  };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    requests.push(`${request.method} ${pathname}`);
    const route = `${request.method} ${pathname}`;
    const respond = (status: number, body: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      if (route === "POST /desktop/bootstrap-authorize/token") {
        respond(200, {
          bootstrapToken: "orgless-e2e-bootstrap",
          expiresAt,
          pendingUserId: ORGLESS_USER_ID,
        });
        return;
      }
      if (route === "POST /desktop/organizations/bootstrap") {
        const body = await readBody(request);
        organizationRequests.push({
          authorization: request.headers.authorization,
          body,
        });
        if (request.headers.authorization !== "Bearer orgless-e2e-bootstrap") {
          respond(401, { code: "unauthorized" });
          return;
        }
        respond(200, tokens);
        return;
      }
      if (route === "POST /desktop/session/refresh") {
        respond(200, tokens);
        return;
      }
      if (route === "GET /onboarding/guided/snapshot") {
        respond(200, { success: true, data: snapshot });
        return;
      }
      if (route === "POST /onboarding/guided/transition") {
        const command = guidedOnboardingTransitionRequestSchema.parse(
          await readBody(request)
        );
        snapshot = {
          ...snapshot,
          attemptId: "orgless-e2e-attempt",
          revision: snapshot.revision + 1,
          restoreOutcome: OnboardingRestoreOutcome.Restored,
          state: command.state,
          experienceVariant: command.experienceVariant,
        };
        respond(200, { success: true, data: snapshot });
        return;
      }
      respond(404, { error: "unclaimed fixture path" });
    } catch {
      respond(500, { error: "invalid fixture request" });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No fixture listener");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    organizationRequests,
    requests,
    snapshot: () => snapshot,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
