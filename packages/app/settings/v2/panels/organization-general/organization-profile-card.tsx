"use client";

import type { Organization } from "@repo/api/src/types/organization";
import type { SettingsDomainGrants } from "@repo/api/src/types/settings-domain";
import { SettingsDomainId } from "@repo/api/src/types/settings-domain";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { cn } from "@repo/design-system/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { Building2Icon, CheckCircle2Icon, Loader2Icon } from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useId, useState } from "react";
import {
  useOrganization,
  useUpdateOrganization,
} from "../../../../organizations/hooks/use-organizations";
import { ApiError } from "../../../../shared/api/api-error";
import { useOrganizationIdentityResync } from "../../../../shared/auth/use-organization-identity-resync";
import { useCurrentUser } from "../../../../users/hooks/use-users";
import { useSettingsDomainAccess } from "../../hooks/use-settings-view-model";
import {
  normalizeOrgSlug,
  organizationIdentityDraftState,
} from "./organization-identity-draft";

const SLUG_CONFLICT_MESSAGE = "This organization URL is already taken";
const HTTP_CONFLICT = 409;

/**
 * The prototype's "Organization profile" card: the organization's name and its
 * URL slug, saved together (ISS-8365).
 *
 * WHAT THIS CARD REFUSES TO DO. Three reads stand between the user and this
 * form — the current user, the organization, and the actor's authorization over
 * the Organization domain — and each can be in flight or fail. A failure in any
 * of them renders as a failure. It never renders the form over empty strings
 * (which invites the user to "save" a blank name over a real one), and never
 * renders the slug field read-only off an authorization answer that never
 * arrived, which would be a denial invented out of an outage (PRD-692).
 */
export function OrganizationProfileCard() {
  const currentUserQuery = useCurrentUser();
  const organizationId = currentUserQuery.data?.organizationId ?? "";
  const organizationQuery = useOrganization(organizationId, {
    enabled: organizationId.length > 0,
  });
  const domainAccess = useSettingsDomainAccess(SettingsDomainId.Organization);

  if (domainAccess.status === "error") {
    return (
      <ProfileCardShell>
        <Alert variant="error">
          <AlertDescription>
            We couldn&apos;t check what you&apos;re allowed to change here, so
            we haven&apos;t loaded the form. This isn&apos;t a refusal — try
            again in a moment.
          </AlertDescription>
        </Alert>
      </ProfileCardShell>
    );
  }

  const readError = currentUserQuery.error ?? organizationQuery.error;
  if (readError) {
    return (
      <ProfileCardShell>
        <Alert variant="error">
          <AlertDescription>{readError.message}</AlertDescription>
        </Alert>
      </ProfileCardShell>
    );
  }

  const organization = organizationQuery.data;
  if (domainAccess.status === "pending" || organization === undefined) {
    return (
      <ProfileCardShell>
        <ProfileFieldsSkeleton />
      </ProfileCardShell>
    );
  }

  // Keyed on the slug so a rename that lands from anywhere else rebuilds the
  // draft, rather than leaving the user editing a value that is no longer
  // what they are editing.
  return (
    <OrganizationProfileForm
      grants={domainAccess.grants}
      key={organization.slug}
      organization={organization}
    />
  );
}

function OrganizationProfileForm({
  organization,
  grants,
}: Readonly<{ organization: Organization; grants: SettingsDomainGrants }>) {
  const nameFieldId = useId();
  const slugFieldId = useId();
  const slugErrorId = useId();
  const queryClient = useQueryClient();
  const resyncOrganizationIdentity = useOrganizationIdentityResync();
  const updateOrganization = useUpdateOrganization();

  const [name, setName] = useState(organization.name);
  const [slug, setSlug] = useState(organization.slug);
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // The slug write is admin-gated at `PUT /organizations/[id]`, while a
  // name-only body is not (ISS-8378's policy row mirrors exactly that). Gating
  // the field on the `admin` rung is what stops a member being offered a
  // control whose route would answer 403.
  const canEditSlug = grants.admin;
  const canEditName = grants.edit;
  const draft = organizationIdentityDraftState({
    canEditName,
    canEditSlug,
    conflictError,
    isSaving: updateOrganization.isPending,
    name,
    organization,
    slug,
  });

  function editName(value: string) {
    setName(value);
    setSaved(false);
  }

  function editSlug(value: string) {
    setSlug(normalizeOrgSlug(value));
    setConflictError(null);
    setSaved(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft.canSave) {
      return;
    }

    const nextSlug = draft.changedSlug;
    updateOrganization.mutate(
      {
        id: organization.id,
        ...(draft.changedName === null ? {} : { name: draft.changedName }),
        ...(nextSlug === null ? {} : { slug: nextSlug }),
      },
      {
        onError: (error) => {
          // Only the conflict gets a local message; every other rejection is
          // owned by the shared mutation-error toast. Either way the form stays
          // dirty and unsaved — a failed write must never read as a save.
          if (error instanceof ApiError && error.status === HTTP_CONFLICT) {
            setConflictError(SLUG_CONFLICT_MESSAGE);
          }
        },
        onSuccess: async (updated) => {
          setName(updated.name);
          setSlug(updated.slug);
          setConflictError(null);
          setSaved(true);

          // BOTH identity fields live in Clerk's active-organization object,
          // which the API updated through its server SDK — the already-mounted
          // client copy does not hear about it. Skipping this for a name-only
          // save left the account menu rendering the OLD name while this form
          // said "Saved". The resync also re-anchors the URL, which only
          // actually moves when the slug is what changed.
          await resyncOrganizationIdentity(updated.slug);

          if (nextSlug === null) {
            return;
          }
          // Only a slug change invalidates the whole cache: every org-scoped
          // key was fetched under the old slug, so it refills against the new
          // one the resync just re-anchored to.
          queryClient.clear();
        },
      }
    );
  }

  return (
    <ProfileCardShell>
      {/* Two-up only once the panel column is genuinely wide enough for it,
          keyed to the shell's `settings-panel` container rather than the
          viewport (ISS-8975). The threshold is set by the URL field: its origin
          prefix is `shrink-0` and measures ~109px, so at `@xl` the half-column
          leaves ~119px of editable slug — less than the prefix beside it. `@2xl`
          buys ~167px, and the modal clips rather than scrolls horizontally, so
          erring narrow here is not recoverable by the user. */}
      <form
        className="grid @2xl/settings-panel:grid-cols-2 gap-4"
        onSubmit={handleSubmit}
      >
        <div className="space-y-2">
          <Label htmlFor={nameFieldId}>Organization name</Label>
          <Input
            disabled={!canEditName || updateOrganization.isPending}
            id={nameFieldId}
            onChange={(event) => editName(event.target.value)}
            value={name}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor={slugFieldId}>Organization URL</Label>
          <div
            className={cn(
              "flex items-center rounded-md border bg-background px-3",
              canEditSlug ? undefined : "opacity-50"
            )}
          >
            <span className="shrink-0 text-muted-foreground text-sm">
              {draft.slugPrefix}
            </span>
            <Input
              aria-describedby={draft.slugMessage ? slugErrorId : undefined}
              aria-invalid={draft.slugMessage !== null}
              className="border-0 px-1 shadow-none focus-visible:ring-0"
              disabled={!canEditSlug || updateOrganization.isPending}
              id={slugFieldId}
              onChange={(event) => editSlug(event.target.value)}
              value={slug}
            />
          </div>
          {draft.slugMessage ? (
            <p className="text-destructive text-sm" id={slugErrorId}>
              {draft.slugMessage}
            </p>
          ) : null}
          {canEditSlug ? null : (
            <p className="text-muted-foreground text-sm">
              Only an organization admin can change the URL.
            </p>
          )}
        </div>

        <div className="@2xl/settings-panel:col-span-2 flex items-center gap-3">
          <Button disabled={!draft.canSave} type="submit" variant="outline">
            {updateOrganization.isPending ? (
              <Loader2Icon aria-hidden="true" className="size-4 animate-spin" />
            ) : null}
            Save changes
          </Button>
          {saved ? (
            <span
              className="flex items-center gap-1.5 text-sm text-success"
              role="status"
            >
              <CheckCircle2Icon aria-hidden="true" className="size-4" />
              Saved
            </span>
          ) : null}
        </div>
      </form>
    </ProfileCardShell>
  );
}

function ProfileCardShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Building2Icon aria-hidden="true" className="size-5" />
          Organization profile
        </CardTitle>
        <CardDescription>
          Details teammates see throughout the product.
        </CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function ProfileFieldsSkeleton() {
  return (
    <div
      className="grid @2xl/settings-panel:grid-cols-2 gap-4"
      data-testid="organization-profile-loading"
    >
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}
