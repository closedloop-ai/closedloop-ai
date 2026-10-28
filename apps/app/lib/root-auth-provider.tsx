// ISS-11397: one owner for the marketing paths these URLs and the onboarding
// dialog's defaults both point at, so moving a route is one edit here. It lives
// in `shared/` rather than the onboarding slice (@whitlockk) because the root auth
// provider is a second, unrelated reader of it.
import {
  LEGAL_PRIVACY_PATH,
  LEGAL_TERMS_PATH,
} from "@repo/app/shared/lib/legal-links";
import type { LocalTrustedIdentity } from "@repo/auth/auth-mode";
import { LocalTrustedIdentityProvider } from "@repo/auth/local-trusted-client";
import { AuthProvider } from "@repo/auth/provider";
import type { ReactNode } from "react";
import { env } from "@/env";

/**
 * ISS-12054: Clerk's provider on every real deployment; under
 * `AUTH_MODE=local_trusted` the server-resolved identity INSTEAD, so a local
 * stack renders with no Clerk credentials and the browser never loads Clerk.
 * The `@repo/auth/client` hooks and components answer from that identity
 * (`packages/auth/local-trusted-hooks.ts`). `localTrustedAuthIdentity` is
 * non-null only once `isLocalTrustedAuthActive()` passed its non-production
 * guard in `app/layout.tsx`.
 */
export function RootAuthProvider({
  children,
  localTrustedAuthIdentity,
  nonce,
}: {
  readonly children: ReactNode;
  readonly localTrustedAuthIdentity: LocalTrustedIdentity | null;
  readonly nonce: string | undefined;
}) {
  if (localTrustedAuthIdentity) {
    return (
      <LocalTrustedIdentityProvider identity={localTrustedAuthIdentity}>
        {children}
      </LocalTrustedIdentityProvider>
    );
  }
  return (
    <AuthProvider
      helpUrl={env.NEXT_PUBLIC_DOCS_URL}
      nonce={nonce}
      privacyUrl={new URL(
        LEGAL_PRIVACY_PATH,
        env.NEXT_PUBLIC_WEB_URL
      ).toString()}
      termsUrl={new URL(LEGAL_TERMS_PATH, env.NEXT_PUBLIC_WEB_URL).toString()}
    >
      {children}
    </AuthProvider>
  );
}
