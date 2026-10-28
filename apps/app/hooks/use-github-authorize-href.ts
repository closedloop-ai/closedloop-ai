import { getGitHubConnectUrl } from "@/lib/integration-connect-urls";

/**
 * The authorize-mode GitHub connect href. Since PLN-1742 M5 retired the
 * in-house authorize route this is a pure alias for
 * `getGitHubConnectUrl("authorize")` — kept as the shared seam so every
 * connect affordance stays on one symbol (it stopped being a stateful hook
 * when the org-enrollment verdict it used to read became moot).
 *
 * Install-mode entry points do not use this: the App-install flow stays on
 * the legacy route permanently.
 */
export function useGitHubAuthorizeHref(
  options: { returnTo?: string } = {}
): string {
  return getGitHubConnectUrl("authorize", options);
}
