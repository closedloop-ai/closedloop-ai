"use client";

import { SettingsPanelLoading } from "@repo/app/settings/v2/components/settings-panel-boundary";
import type { SettingsPanelProps } from "@repo/app/settings/v2/lib/settings-panel-registry";
import { deriveSignInMethods } from "@repo/app/shared/lib/sign-in-methods";
import { useClerk, useUser } from "@repo/auth/client";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import { Card, CardContent } from "@repo/design-system/components/ui/card";
import { EmptyState } from "@repo/design-system/components/ui/empty-state";
import { PersonAvatar } from "@repo/design-system/components/ui/person-avatar";
import { useOrgPath } from "@repo/navigation/use-org-path";
import { KeyRoundIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useGitHubAuthorizeHref } from "@/hooks/use-github-authorize-href";
import { profileIdentityFromUser } from "./profile-identity";
import { SignInMethodsSection } from "./sign-in-methods-section";
import { useSignInMethodActions } from "./use-sign-in-method-actions";

/**
 * @file profile-settings-panel-body.tsx
 * @description The Settings v2 Profile panel body (ISS-8364), built from the
 * approved prototype at
 * `packages/app/shell/v2/components/web-master-preview/components/settings-account-panels.tsx:36-142`.
 * The layout, headings and controls are the prototype's; every VALUE it showed
 * was fixture data and is a live Clerk read here.
 *
 * The shell only mounts this body when resolution says `ready`, so the states
 * this file owns are the ones BELOW that: Clerk still loading, and Clerk loaded
 * with no user. Neither may render as an empty profile — a blank row would say
 * "you have no email addresses" about a read that never completed.
 */

/** The Clerk-owned page each control opens; `undefined` is the modal default. */
const CLERK_SECURITY_PATH = "/security";

function SettingsRow({
  children,
  label,
}: Readonly<{ children: React.ReactNode; label: string }>) {
  return (
    <div className="grid gap-4 px-5 py-5 sm:grid-cols-[180px_1fr] sm:px-6">
      <p className="font-medium text-sm">{label}</p>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function ProfileUnavailable() {
  return (
    <div data-profile-panel-state="unavailable" role="alert">
      <EmptyState
        description="Your account details didn't load. Reload the page to try again."
        icon={TriangleAlertIcon}
        title="We couldn't load your profile"
        titleAs="h2"
      />
    </div>
  );
}

export function ProfileSettingsPanelBody(_props: Readonly<SettingsPanelProps>) {
  const { isLoaded, user } = useUser();
  const clerk = useClerk();
  const buildOrgPath = useOrgPath();
  const githubAuthorizeHref = useGitHubAuthorizeHref({
    returnTo: buildOrgPath("/settings"),
  });
  const actions = useSignInMethodActions({ githubAuthorizeHref, user });

  if (!isLoaded) {
    return <SettingsPanelLoading />;
  }
  if (!user) {
    return <ProfileUnavailable />;
  }

  const identity = profileIdentityFromUser(user);
  const connections = deriveSignInMethods({
    accounts: user.externalAccounts.map((account) => ({
      emailAddress: account.emailAddress,
      provider: account.provider,
      username: account.username,
      verificationStatus: account.verification?.status,
    })),
    lastAuthenticationStrategy:
      clerk.client?.lastAuthenticationStrategy ?? null,
  });

  return (
    <section aria-labelledby="settings-profile-heading">
      <div className="mb-4">
        <h2
          className="font-semibold text-lg tracking-tight"
          id="settings-profile-heading"
        >
          Profile
        </h2>
        <p className="mt-1 text-muted-foreground text-sm">
          Your personal details and the methods you use to sign in.
        </p>
      </div>

      <div className="space-y-5">
        <Card>
          <CardContent className="divide-y p-0">
            <SettingsRow label="Profile">
              <div className="flex flex-1 flex-wrap items-center gap-3">
                <PersonAvatar
                  avatarUrl={identity.imageUrl}
                  className="size-12"
                  initials={identity.initials}
                  name={identity.displayName}
                />
                <p className="font-medium">{identity.displayName}</p>
                <Button
                  className="ml-auto"
                  onClick={() => clerk.openUserProfile()}
                  size="sm"
                  variant="outline"
                >
                  Update profile
                </Button>
              </div>
            </SettingsRow>

            <SettingsRow label="Email addresses">
              <div className="flex-1 space-y-3">
                {identity.primaryEmail === null ? (
                  <p className="text-muted-foreground text-sm">
                    No primary email address is set on this account.
                  </p>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{identity.primaryEmail}</span>
                    <Badge variant="outline">Primary</Badge>
                  </div>
                )}
                <Button
                  className="px-0"
                  onClick={() => clerk.openUserProfile()}
                  size="sm"
                  variant="ghost"
                >
                  <PlusIcon />
                  Add email address
                </Button>
              </div>
            </SettingsRow>

            <SettingsRow label="Sign-in methods">
              <SignInMethodsSection
                connections={connections}
                getActionState={actions.getActionState}
                onConnect={actions.connect}
                onDisconnect={actions.disconnect}
                onRetry={actions.retry}
              />
            </SettingsRow>

            <SettingsRow label="Password">
              <div className="flex flex-1 items-center justify-between gap-4">
                <div>
                  <p className="font-medium text-sm">
                    {identity.passwordEnabled
                      ? "Password set"
                      : "Password not set"}
                  </p>
                  <p className="mt-1 text-muted-foreground text-sm">
                    {identity.passwordEnabled
                      ? "Change the password you use to sign in."
                      : "Add a password as another way to sign in."}
                  </p>
                </div>
                <Button
                  onClick={() =>
                    clerk.openUserProfile({
                      __experimental_startPath: CLERK_SECURITY_PATH,
                    })
                  }
                  size="sm"
                  variant="outline"
                >
                  <KeyRoundIcon />
                  {identity.passwordEnabled
                    ? "Change password"
                    : "Set password"}
                </Button>
              </div>
            </SettingsRow>
          </CardContent>
        </Card>

        {identity.deleteSelfEnabled ? (
          <Card className="border-destructive/30">
            <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6">
              <div>
                <p className="font-medium text-sm">Delete account</p>
                <p className="mt-1 text-muted-foreground text-sm">
                  Permanently remove your profile and personal account data.
                </p>
              </div>
              <Button
                onClick={() =>
                  clerk.openUserProfile({
                    __experimental_startPath: CLERK_SECURITY_PATH,
                  })
                }
                variant="destructive"
              >
                Delete account
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </section>
  );
}
