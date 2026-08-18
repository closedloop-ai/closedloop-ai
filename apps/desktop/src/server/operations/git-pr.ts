import type { OperationDispatcher } from "../operation-dispatcher.js";
import { resolveBinaryFromLoginShell } from "../shell-path.js";
import { registerGitPrCreateRoute } from "./git-pr-create.js";
import { runRead } from "./git-pr-exec.js";
import { json } from "./response-utils.js";
import { getOverrideBinaryPaths } from "./symphony-loop.js";

/**
 * Gateway PR operations.
 *
 * PLN-1535 M5 deletion 2 retired the legacy local-`gh` PR data lane. Desktop
 * GitHub data is now served from the cloud projection (D2/D10), so nothing in
 * either shell reaches these routes: the live-overlay client that called
 * `/pr/reviews`, `/pr/files` and `/pr/file-diff` went in M5 deletion 3, the
 * `/pr/comments` client went with FEA-2608's move to the projection, and
 * `apps/mobile` — the last caller that bypassed the `allowLiveOverlays` gate —
 * was deleted in ISS-5284.
 *
 * What survives here is deliberately small: `/git/user`, which is identity
 * rather than PR data, and the PR CREATE route, which is a write and has real
 * callers. Everything else answers HTTP 410 (see `RETIRED_GITHUB_DATA_ROUTES`).
 *
 * The 410s are registered UNCONDITIONALLY, replacing the previous
 * `enableGithubDataRoutes` flag that defaulted to serving the legacy handlers.
 * A version-skewed caller must get a definitive "this is gone" rather than the
 * generic 501 `operation not implemented` this gateway returns for an
 * unregistered `/api/gateway/*` path (`router.ts`) — which, per root AGENTS.md,
 * means "not built yet, may arrive later" and would read as exactly the wrong
 * thing. The gateway is a cross-process contract and old Desktop builds are
 * never upgraded in lockstep.
 *
 * "Unconditionally" is about registration, not about what every caller
 * observes: `/api/gateway/*` requests pass the auth, onboarding and approval
 * gates first (`router.ts` -> `evaluateApproval`), any of which can answer
 * before dispatch. The 410 is what this lane returns once a request reaches it.
 */

export const RETIRED_GITHUB_DATA_ROUTE_ERROR = "github_data_route_retired";
export const RETIRED_GITHUB_DATA_ROUTE_MESSAGE =
  "Desktop GitHub data is synced from cloud. This local gh-backed route has been retired.";

/**
 * Every local-`gh` PR data route, read and write alike.
 *
 * The write ops (`/pr/reply`, `/pr/inline-comment`) are here rather than kept
 * live because they had no caller either — PLN-1535's "PR write/create gateway
 * ops stay" was written before that was known, and `/pr/create` is the only
 * write with real callers. Recorded as a deviation on the plan.
 */
const RETIRED_GITHUB_DATA_ROUTES = [
  { method: "GET", path: "/api/gateway/git/pr/list" },
  { method: "GET", path: "/api/gateway/git/pr/comments" },
  { method: "GET", path: "/api/gateway/git/pr/reviews" },
  { method: "POST", path: "/api/gateway/git/pr/reply" },
  { method: "GET", path: "/api/gateway/git/pr/files" },
  { method: "GET", path: "/api/gateway/git/pr/file-diff" },
  { method: "GET", path: "/api/gateway/git/pr/head-sha" },
  { method: "POST", path: "/api/gateway/git/pr/inline-comment" },
] as const;

function registerRetiredGithubDataRoutes(
  dispatcher: OperationDispatcher
): void {
  for (const route of RETIRED_GITHUB_DATA_ROUTES) {
    dispatcher.register(route.method, route.path, (context) => {
      json(context, 410, {
        error: RETIRED_GITHUB_DATA_ROUTE_ERROR,
        message: RETIRED_GITHUB_DATA_ROUTE_MESSAGE,
      });
    });
  }
}

export function registerGitPrRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[]
): void {
  registerGitPrCreateRoute(dispatcher, getAllowedDirectories);

  dispatcher.register("GET", "/api/gateway/git/user", async (context) => {
    try {
      const ghBin = (
        await resolveBinaryFromLoginShell("gh", getOverrideBinaryPaths()?.gh)
      ).path;
      const login = await runRead(undefined, ghBin, [
        "api",
        "user",
        "--jq",
        ".login",
      ]);
      if (!login) {
        json(context, 500, { error: "Could not determine GitHub user" });
        return;
      }
      json(context, 200, { login });
    } catch {
      json(context, 500, {
        error:
          "Failed to get GitHub user. Ensure gh is installed and authenticated.",
      });
    }
  });

  registerRetiredGithubDataRoutes(dispatcher);
}
