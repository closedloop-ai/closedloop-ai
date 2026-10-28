import type { ClerkProvider } from "@clerk/nextjs";
import type { ComponentProps } from "react";

/**
 * Clerk does not publish its localization type from a package this workspace
 * depends on, so it is read off the provider that consumes it — which is the
 * stronger binding anyway: this object is exactly what that prop accepts.
 */
type AuthLocalization = NonNullable<
  ComponentProps<typeof ClerkProvider>["localization"]
>;

/**
 * Copy overrides for Clerk's embedded surfaces.
 *
 * Lifted out of `provider.tsx` (ISS-10969) so the shipped strings are readable
 * by a test, the way `appearance.ts` already is. A key here REPLACES the one
 * `@clerk/localizations` ships for it — and only replaces it where Clerk
 * actually renders that key, which is not true of every key it declares.
 */
export const authLocalization: AuthLocalization = {
  signIn: {
    start: {
      title: "Welcome to Closedloop",
    },
  },
  signUp: {
    start: {
      title: "Create your account",
    },
  },
  // ISS-10969 (PRD-754 UAT): Clerk's default for this task's submit is the
  // generic "Continue". The screen creates an organization, and the
  // approved prototype — and our own step — name that action. Clerk's own
  // standalone `createOrganization.formButtonSubmit` is already this
  // string; only the session task's copy of it says Continue.
  taskChooseOrganization: {
    createOrganization: {
      formButtonSubmit: "Create organization",
    },
  },
  userButton: {
    action__manageAccount: "Settings",
  },
};
