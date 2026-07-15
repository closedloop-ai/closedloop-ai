"use client";

import { useOrganization } from "@repo/app/organizations/hooks/use-organizations";
import { useCurrentUser } from "@repo/app/users/hooks/use-users";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Loader2Icon } from "lucide-react";
import { OrganizationSlugEditor } from "./organization-slug-editor";

type OrganizationSlugSettingsProperties = {
  isAdmin: boolean;
};

export function OrganizationSlugSettings({
  isAdmin,
}: OrganizationSlugSettingsProperties) {
  const currentUserQuery = useCurrentUser();
  const currentOrganizationId = currentUserQuery.data?.organizationId ?? "";
  const organizationQuery = useOrganization(currentOrganizationId, {
    enabled: Boolean(currentOrganizationId),
  });

  if (!isAdmin) {
    return null;
  }

  if (currentUserQuery.isLoading || organizationQuery.isLoading) {
    return <SlugSettingsLoadingState />;
  }

  if (currentUserQuery.error) {
    return <SlugSettingsErrorState message={currentUserQuery.error.message} />;
  }

  if (organizationQuery.error) {
    return <SlugSettingsErrorState message={organizationQuery.error.message} />;
  }

  if (!organizationQuery.data) {
    return null;
  }

  const organization = organizationQuery.data;

  return (
    <OrganizationSlugEditor
      currentSlug={organization.slug}
      key={organization.slug}
      organizationId={organization.id}
      organizationName={organization.name}
    />
  );
}

function SlugSettingsLoadingState() {
  return (
    <div
      className="flex items-center justify-center py-8"
      data-testid="slug-settings-loading"
    >
      <Loader2Icon className="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  );
}

function SlugSettingsErrorState({ message }: { message: string }) {
  return (
    <Alert variant="error">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
