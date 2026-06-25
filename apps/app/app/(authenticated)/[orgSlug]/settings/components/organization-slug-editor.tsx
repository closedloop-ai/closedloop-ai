"use client";

import { orgSlugSchema } from "@repo/api/src/types/reserved-slugs";
import { useUpdateOrganization } from "@repo/app/organizations/hooks/use-organizations";
import { ApiError } from "@repo/app/shared/api/api-error";
import { useOrganization, useSession } from "@repo/auth/client";
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
import { toast } from "@repo/design-system/components/ui/sonner";
import { useNavigation } from "@repo/navigation/use-navigation";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, PencilIcon, SaveIcon, XIcon } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";

const TRAILING_SLASH_PATTERN = /\/$/;
const APP_BASE_URL = (
  process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000"
).replace(TRAILING_SLASH_PATTERN, "");

type OrganizationSlugEditorProperties = {
  currentSlug: string;
  organizationId: string;
  organizationName: string;
};

function normalizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-");
}

export function OrganizationSlugEditor({
  currentSlug,
  organizationId,
  organizationName,
}: OrganizationSlugEditorProperties) {
  const navigation = useNavigation();
  const { organization: clerkOrganization } = useOrganization();
  const { session } = useSession();
  const queryClient = useQueryClient();
  const updateSlug = useUpdateOrganization();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(currentSlug);
  const [conflictError, setConflictError] = useState<string | null>(null);

  const trimmedDraft = draft.trim();
  const validation = orgSlugSchema.safeParse(trimmedDraft);
  const hasDraft = trimmedDraft.length > 0;
  const isUnchanged = trimmedDraft === currentSlug;
  const schemaError =
    hasDraft && !validation.success
      ? (validation.error.issues[0]?.message ?? "Invalid organization slug")
      : null;
  const validationMessage = schemaError ?? conflictError;
  const previewUrl = `${APP_BASE_URL}/${currentSlug}/prds/...`;
  const editPreviewUrl = `${APP_BASE_URL}/${hasDraft ? trimmedDraft : currentSlug}/prds/...`;
  const canSave =
    validation.success &&
    !isUnchanged &&
    !updateSlug.isPending &&
    hasDraft &&
    !conflictError;

  function handleEdit() {
    setDraft(currentSlug);
    setConflictError(null);
    setIsEditing(true);
  }

  function handleCancel() {
    setDraft(currentSlug);
    setConflictError(null);
    setIsEditing(false);
  }

  function handleSlugChange(value: string) {
    setDraft(normalizeSlug(value));
    setConflictError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!canSave) {
      return;
    }

    updateSlug.mutate(
      { id: organizationId, slug: trimmedDraft },
      {
        onSuccess: async (organization) => {
          setDraft(organization.slug);
          setConflictError(null);
          setIsEditing(false);
          toast.success("Organization slug updated");

          await Promise.allSettled([
            clerkOrganization?.reload(),
            session?.reload(),
          ]);

          queryClient.clear();
          navigation.replace(`/${organization.slug}/settings`);
        },
        onError: (error) => {
          if (error instanceof ApiError && error.status === 409) {
            setConflictError("This slug is already taken");
          }
        },
      }
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization URL</CardTitle>
        <CardDescription>{organizationName}</CardDescription>
      </CardHeader>
      <CardContent>
        {isEditing ? (
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="organization-slug">Slug</Label>
              <Input
                aria-describedby="organization-slug-help organization-slug-error"
                id="organization-slug"
                onChange={(event) => handleSlugChange(event.target.value)}
                value={draft}
              />
              <p
                className="font-mono text-muted-foreground text-sm"
                id="organization-slug-help"
              >
                {editPreviewUrl}
              </p>
              {validationMessage ? (
                <p
                  className="text-destructive text-sm"
                  id="organization-slug-error"
                >
                  {validationMessage}
                </p>
              ) : null}
            </div>

            <div className="flex gap-2">
              <Button disabled={!canSave} type="submit">
                {updateSlug.isPending ? (
                  <Loader2Icon className="h-4 w-4 animate-spin" />
                ) : (
                  <SaveIcon className="h-4 w-4" />
                )}
                Save
              </Button>
              <Button
                disabled={updateSlug.isPending}
                onClick={handleCancel}
                type="button"
                variant="outline"
              >
                <XIcon className="h-4 w-4" />
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-2">
            <p className="font-mono text-sm">{currentSlug}</p>
            <p className="font-mono text-muted-foreground text-sm">
              {previewUrl}
            </p>
            <Button onClick={handleEdit} size="sm" variant="outline">
              <PencilIcon className="h-4 w-4" />
              Edit
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
