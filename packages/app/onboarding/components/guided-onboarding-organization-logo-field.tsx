"use client";

import { ORGANIZATION_LOGO_MAX_SIZE_BYTES } from "@repo/api/src/types/desktop-bootstrap";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import { Button } from "@repo/design-system/components/ui/button";
import { Label } from "@repo/design-system/components/ui/label";
import { cn } from "@repo/design-system/lib/utils";
import { Loader2Icon, UploadIcon } from "lucide-react";
import {
  type ChangeEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

/**
 * The organization-logo picker, and the rule for what it accepts. Only the
 * create-organization step mounts it; it lives beside that step rather than
 * inside it so neither file carries both the form and the upload affordance's
 * copy branches.
 *
 * {@link validateOrganizationLogoFile} is exported because the step owns the
 * staging-versus-upload decision and has to reject a file BEFORE choosing
 * between them — the field itself never sees the outcome.
 */
export function GuidedOnboardingOrganizationLogoField({
  logoError,
  logoUploadAvailable,
  logoUploadConfirmed,
  logoUploading,
  newOrganizationLogo,
  onFileSelected,
  stagedLogoFile,
}: GuidedOnboardingOrganizationLogoFieldProps) {
  const stagedLogoPreview = useStagedLogoPreview(stagedLogoFile);
  const logoInputId = useId();
  const logoInputRef = useRef<HTMLInputElement>(null);
  const logoStatusId = useId();
  const hasLogo =
    Boolean(newOrganizationLogo) ||
    stagedLogoFile !== null ||
    logoUploadConfirmed;
  const logoActionLabel = getOrganizationLogoActionLabel(hasLogo);
  const logoButtonText = getOrganizationLogoButtonText({
    hasLogo,
    logoUploading,
  });
  const logoHelperText = getOrganizationLogoHelperText({
    logoError,
    logoUploadAvailable,
    logoUploadConfirmed,
    logoUploading,
    stagedLogoFile,
  });

  const handleLogoButtonClick = () => {
    logoInputRef.current?.click();
  };

  const handleLogoInputChange = async (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }
    await onFileSelected(file);
  };

  return (
    <div className="grid gap-2">
      <Label htmlFor={logoInputId}>Logo</Label>
      <input
        accept="image/*"
        aria-label="Organization logo file"
        className="sr-only"
        disabled={!logoUploadAvailable || logoUploading}
        id={logoInputId}
        onChange={handleLogoInputChange}
        ref={logoInputRef}
        type="file"
      />
      <div className="flex items-center gap-4">
        <button
          aria-describedby={logoStatusId}
          aria-label={logoActionLabel}
          className={cn(
            "flex size-20 items-center justify-center rounded-xl border border-dashed transition-colors",
            hasLogo
              ? "border-primary bg-primary/10 text-primary"
              : "border-muted-foreground/40 text-muted-foreground",
            logoUploadAvailable &&
              "hover:border-foreground/50 hover:text-foreground",
            (!logoUploadAvailable || logoUploading) &&
              "cursor-not-allowed opacity-60"
          )}
          disabled={!logoUploadAvailable || logoUploading}
          onClick={handleLogoButtonClick}
          type="button"
        >
          {renderOrganizationLogoButtonContent({
            logoUploading,
            newOrganizationLogo: stagedLogoPreview ? (
              <Avatar className="size-full rounded-xl">
                <AvatarImage
                  alt="Organization logo"
                  className="object-contain"
                  src={stagedLogoPreview}
                />
                <AvatarFallback className="rounded-xl bg-transparent">
                  <UploadIcon aria-hidden="true" className="size-6" />
                </AvatarFallback>
              </Avatar>
            ) : (
              newOrganizationLogo
            ),
          })}
        </button>
        <div className="min-w-0">
          <Button
            aria-describedby={logoStatusId}
            disabled={!logoUploadAvailable || logoUploading}
            onClick={handleLogoButtonClick}
            type="button"
            variant="outline"
          >
            {logoButtonText}
          </Button>
          <p
            className={cn(
              "mt-1.5 max-w-sm text-sm",
              logoError ? "text-destructive" : "text-muted-foreground"
            )}
            id={logoStatusId}
            role={logoError ? "alert" : undefined}
          >
            {logoHelperText}
          </p>
        </div>
      </div>
    </div>
  );
}

export function validateOrganizationLogoFile(file: File) {
  if (!(file instanceof File && file.type.startsWith("image/"))) {
    return "Choose an image file.";
  }
  if (file.size <= 0) {
    return "Choose an image file with content.";
  }
  if (file.size > ORGANIZATION_LOGO_MAX_SIZE_BYTES) {
    return ORGANIZATION_LOGO_TOO_LARGE_MESSAGE;
  }
  return null;
}

function getOrganizationLogoActionLabel(hasLogo: boolean) {
  if (hasLogo) {
    return "Replace organization logo";
  }
  return "Upload organization logo";
}

function getOrganizationLogoButtonText({
  hasLogo,
  logoUploading,
}: {
  hasLogo: boolean;
  logoUploading: boolean;
}) {
  if (logoUploading) {
    return "Uploading";
  }
  if (hasLogo) {
    return "Replace";
  }
  return "Upload";
}

function getOrganizationLogoHelperText({
  logoError,
  logoUploadAvailable,
  logoUploadConfirmed,
  logoUploading,
  stagedLogoFile,
}: {
  logoError: string | null;
  logoUploadAvailable: boolean;
  logoUploadConfirmed: boolean;
  logoUploading: boolean;
  stagedLogoFile: File | null;
}) {
  if (logoError) {
    return logoError;
  }
  if (logoUploading) {
    return "Uploading logo...";
  }
  if (stagedLogoFile) {
    return `${stagedLogoFile.name} will upload after the organization is created.`;
  }
  if (logoUploadConfirmed) {
    return "Logo uploaded.";
  }
  if (logoUploadAvailable) {
    return `Recommended size 1:1, up to ${ORGANIZATION_LOGO_MAX_SIZE_MB}MB.`;
  }
  return "Logo upload is not available yet.";
}

function renderOrganizationLogoButtonContent({
  logoUploading,
  newOrganizationLogo,
}: {
  logoUploading: boolean;
  newOrganizationLogo?: ReactNode;
}) {
  if (logoUploading) {
    return <Loader2Icon aria-hidden="true" className="size-5 animate-spin" />;
  }
  if (newOrganizationLogo) {
    return newOrganizationLogo;
  }
  return <UploadIcon aria-hidden="true" className="size-6" />;
}

type GuidedOnboardingOrganizationLogoFieldProps = {
  logoError: string | null;
  logoUploadAvailable: boolean;
  logoUploadConfirmed: boolean;
  logoUploading: boolean;
  newOrganizationLogo?: ReactNode;
  onFileSelected: (file: File) => Promise<void>;
  stagedLogoFile: File | null;
};

/**
 * The ceiling in the unit the copy speaks, derived rather than restated.
 *
 * Both sentences below and the rejection story's fixture used to spell "10MB"
 * out beside {@link ORGANIZATION_LOGO_MAX_SIZE_BYTES}, so lowering the constant
 * would have left every one of them confidently naming the old limit. The unit
 * test that pins the rendered sentence deliberately keeps its literal: derived
 * on both sides, it could not catch a wrong derivation.
 */
const ORGANIZATION_LOGO_MAX_SIZE_MB =
  ORGANIZATION_LOGO_MAX_SIZE_BYTES / (1024 * 1024);

/** The rejection {@link validateOrganizationLogoFile} returns for an oversized file. */
export const ORGANIZATION_LOGO_TOO_LARGE_MESSAGE = `Choose an image smaller than ${ORGANIZATION_LOGO_MAX_SIZE_MB}MB.`;

/** Preview the validated staged file without claiming it has been uploaded. */
function useStagedLogoPreview(file: File | null): string | undefined {
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(
    null
  );
  useEffect(() => {
    if (!file) {
      return;
    }
    const reader = new FileReader();
    let cancelled = false;
    reader.onload = () => {
      if (!cancelled && typeof reader.result === "string") {
        setPreview({ file, url: reader.result });
      }
    };
    reader.readAsDataURL(file);
    return () => {
      cancelled = true;
      if (reader.readyState === FileReader.LOADING) {
        reader.abort();
      }
    };
  }, [file]);
  return preview?.file === file ? preview?.url : undefined;
}
