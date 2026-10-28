import { isProductionHost } from "@repo/analytics/environment";

/**
 * Whether the root layout lets `@posthog/next` pre-resolve the signed-in
 * persona's flag assignment SERVER-SIDE into the RSC payload (ISS-9244).
 *
 * Suppressing that bootstrap is the only way an E2E spec can pin a flag on a
 * deployed target: `page.route` cannot reach a server-side evaluation, so the
 * first frames render against PostHog's real answer and the localStorage
 * fixture — which answers only UNRESOLVED flags, via `resolveTestingFeatureFlag`
 * in `packages/analytics/client.ts` — never gets asked. With the bootstrap off,
 * posthog-js resolves the same assignment from the client instead, and the
 * fixture answers the window before it lands.
 *
 * Three properties are load-bearing and are why the signal is shaped this way.
 *
 * It is a SERVER-ONLY env var, deliberately not a cookie, header, or query
 * param. The decision happens during SSR, so it must be server-readable; but a
 * visitor can set all three of those, and suppression is what opens the window
 * in which a user-writable localStorage fixture is consulted at all. Keeping the
 * switch off the request means no end user has a channel to open that window on
 * a deployment where an operator has not already opened it.
 *
 * Suppression needs an EXPLICIT non-production declaration, so an env var set on
 * the wrong Vercel project cannot take effect. This reads
 * `NEXT_PUBLIC_APP_ENVIRONMENT` directly rather than the derived
 * `getAppEnvironment()`, and that is the whole point: `getAppEnvironment` spells
 * both "this is stage" and "I could not classify this deployment" as `"stage"`,
 * so keying on it would permit suppression on exactly the deployment nobody has
 * checked — the trap `apps/app/lib/content-security-policy.ts` documents and
 * refuses for the same reason. An undeclared deployment keeps the bootstrap.
 * The cost of failing this way is that a target must declare itself before the
 * suppression works there; the cost of failing the other way is production.
 *
 * The canonical production host refuses on its OWN evidence, so the label alone
 * never decides. `NEXT_PUBLIC_APP_ENVIRONMENT` is a hand-set Vercel project
 * setting, and a `"stage"` marker mis-scoped onto the production project would
 * otherwise satisfy the declaration check and open the fixture window to real
 * visitors on `app.closedloop.ai` (whitlockk, PR #6683). Corroborating a
 * non-production label with independent evidence is the same asymmetry
 * `enforcesContentSecurityPolicy` (`lib/content-security-policy.ts`) applies to
 * the same hazard, and `NEXT_PUBLIC_APP_URL` is build-scoped, so the refusal
 * covers every host that build answers on — the Vercel alias included.
 *
 * Suppression cannot turn a flag ON. It removes a pre-resolution and produces no
 * flag value of its own, and once posthog-js answers, `client.ts` returns that
 * answer over any fixture — the behaviour `client.test.ts` pins as "ignores
 * mutable E2E fixtures when PostHog is enabled".
 */
export function bootstrapsFeatureFlags(
  suppressionSignal: string | undefined,
  declaredEnvironment: string | undefined,
  appUrl: string
): boolean {
  if (suppressionSignal !== "true") {
    return true;
  }
  if (isProductionHost(appUrl)) {
    return true;
  }
  return !declaresNonProduction(declaredEnvironment);
}

/**
 * Whether the deployment POSITIVELY declares itself non-production. A value the
 * schema does not know — including an absent one — is not a declaration, so a
 * future `NEXT_PUBLIC_APP_ENVIRONMENT` member is un-suppressible until someone
 * adds it here deliberately.
 */
function declaresNonProduction(
  declaredEnvironment: string | undefined
): boolean {
  return (
    declaredEnvironment === "stage" || declaredEnvironment === "development"
  );
}
