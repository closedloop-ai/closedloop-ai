"use client";

import {
  CreateOrganization as ClerkCreateOrganization,
  OrganizationProfile as ClerkOrganizationProfile,
  Show as ClerkShow,
  UserProfile as ClerkUserProfile,
} from "@clerk/nextjs";
import type { ComponentProps, ReactNode } from "react";
import { hasLocalTrustedRole } from "./local-trusted-claims";
import { useLocalTrustedIdentity } from "./local-trusted-client";

/**
 * ISS-12054: the Clerk components `@repo/auth/client` hands the app, made safe
 * to render with no `ClerkProvider` mounted (see `local-trusted-hooks.ts` for
 * why there is none under `AUTH_MODE=local_trusted`). On every real deployment
 * the identity is `null` and each renders Clerk's own component untouched.
 *
 * The three account embeds manage a Clerk user or organization, and a local
 * session has neither, so they render nothing: what Clerk's own embeds render
 * for a browser holding no Clerk session, which is what the Clerk-free e2e lane
 * rendered before this change.
 */
export function UserProfile(props: ComponentProps<typeof ClerkUserProfile>) {
  return useLocalTrustedIdentity() ? null : <ClerkUserProfile {...props} />;
}

export function OrganizationProfile(
  props: ComponentProps<typeof ClerkOrganizationProfile>
) {
  return useLocalTrustedIdentity() ? null : (
    <ClerkOrganizationProfile {...props} />
  );
}

export function CreateOrganization(
  props: ComponentProps<typeof ClerkCreateOrganization>
) {
  return useLocalTrustedIdentity() ? null : (
    <ClerkCreateOrganization {...props} />
  );
}

type ShowProps = ComponentProps<typeof ClerkShow>;

/**
 * Clerk's `<Show>`, deciding `when` against the synthetic session: it is signed
 * in, and its `has()` is the one the server's `auth()` answers with.
 */
export function Show(props: ShowProps) {
  const identity = useLocalTrustedIdentity();
  if (!identity) {
    return <ClerkShow {...props} />;
  }
  const shown: ReactNode = showsForLocalTrusted(props.when)
    ? props.children
    : props.fallback;
  return <>{shown ?? null}</>;
}

export function showsForLocalTrusted(when: ShowProps["when"]): boolean {
  if (when === "signed-in") {
    return true;
  }
  if (when === "signed-out") {
    return false;
  }
  if (typeof when === "function") {
    return when(hasLocalTrustedRole);
  }
  return hasLocalTrustedRole(when);
}
