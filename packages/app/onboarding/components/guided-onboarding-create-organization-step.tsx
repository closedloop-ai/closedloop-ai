"use client";

import { OnboardingPhase } from "@repo/api/src/types/onboarding-phase";
import {
  Alert,
  AlertDescription,
} from "@repo/design-system/components/ui/alert";
import { Button } from "@repo/design-system/components/ui/button";
import { DialogDescription } from "@repo/design-system/components/ui/dialog";
import { AlertCircle, Loader2 } from "lucide-react";
import {
  type ComponentProps,
  type FormEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { createOrganizationReadyEvent } from "../lib/guided-onboarding-events";
import {
  createOrganizationSlug,
  GuidedOnboardingOrganizationFields,
} from "./guided-onboarding-organization-fields";
import {
  GuidedOnboardingOrganizationLogoField,
  validateOrganizationLogoFile,
} from "./guided-onboarding-organization-logo-field";
import {
  GUIDED_ONBOARDING_STEP_BODY_CLASS,
  GUIDED_ONBOARDING_STEP_FOOTER_CLASS,
  GUIDED_ONBOARDING_STEP_SCROLL_CLASS,
  GuidedOnboardingBackButton,
  GuidedOnboardingPhaseHeading,
} from "./guided-onboarding-step-layout";
import type {
  GuidedOnboardingPhaseSource,
  OrganizationDetails,
  OrganizationLogoUploadHandler,
} from "./guided-onboarding-types";

export function GuidedOnboardingCreateOrganizationStep({
  annotation,
  brand,
  creating = false,
  defaultName,
  defaultSlug,
  error = null,
  allowStagedOrganizationLogo,
  newOrganizationLogo,
  onBack,
  onCreate,
  onUploadOrganizationLogo,
}: {
  annotation?: ReactNode;
  brand: ReactNode;
  creating?: boolean;
  defaultName: string;
  defaultSlug: string;
  error?: string | null;
  allowStagedOrganizationLogo?: boolean;
  newOrganizationLogo?: ReactNode;
  onBack?: () => void;
  onCreate: (organization: OrganizationDetails) => void;
  onUploadOrganizationLogo?: OrganizationLogoUploadHandler;
}) {
  const [name, setName] = useState(defaultName);
  const [slug, setSlug] = useState(
    () => defaultSlug || createOrganizationSlug(defaultName)
  );
  const [slugEdited, setSlugEdited] = useState(Boolean(defaultSlug));
  const [stagedLogoFile, setStagedLogoFile] = useState<File | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoUploadConfirmed, setLogoUploadConfirmed] = useState(false);
  const logoStagingAvailable =
    Boolean(allowStagedOrganizationLogo) && !onUploadOrganizationLogo;
  const effectiveStagedLogoFile = logoStagingAvailable ? stagedLogoFile : null;
  const logoUploadAvailable =
    Boolean(onUploadOrganizationLogo) || logoStagingAvailable;
  const canCreate = name.trim().length > 0 && slug.length > 0;
  const canSubmit = canCreate && !(creating || logoUploading);

  useEffect(() => {
    if (logoStagingAvailable || !stagedLogoFile) {
      return;
    }
    setStagedLogoFile(null);
  }, [logoStagingAvailable, stagedLogoFile]);

  const handleNameChange = (nextName: string) => {
    setName(nextName);
    if (!slugEdited) {
      setSlug(createOrganizationSlug(nextName));
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canSubmit) {
      onCreate({
        ...(effectiveStagedLogoFile
          ? { logoFile: effectiveStagedLogoFile }
          : {}),
        name: name.trim(),
        slug,
      });
    }
  };

  // This phase is a `form`, so it restates the layout's shell rather than
  // composing `GuidedOnboardingStepLayout`. It takes all three parts of the
  // frame from there so the scroll region and the action row cannot drift apart
  // from the ones every other step draws.
  return (
    <form className={GUIDED_ONBOARDING_STEP_BODY_CLASS} onSubmit={handleSubmit}>
      <div className={GUIDED_ONBOARDING_STEP_SCROLL_CLASS}>
        <div className="h-7 w-fit">{brand}</div>
        <div className="relative mt-14 w-full">
          <p className="font-semibold text-primary text-xs uppercase tracking-wider">
            Team setup
          </p>
          <GuidedOnboardingPhaseHeading className="mt-3 font-semibold text-3xl tracking-tight">
            You're the first one here!
          </GuidedOnboardingPhaseHeading>
          {annotation}
          <DialogDescription className="mt-4 text-base leading-7">
            {getFirstPersonSentence(defaultName)}
            {
              " Create your company's profile by adding a logo and confirming the details below."
            }
          </DialogDescription>
          {error === null ? null : (
            <Alert className="mt-6" variant="error">
              <AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <div
            className={`${error === null ? "mt-6" : "mt-4"} grid max-w-2xl gap-5`}
          >
            <GuidedOnboardingOrganizationLogoField
              logoError={logoError}
              logoUploadAvailable={logoUploadAvailable}
              logoUploadConfirmed={logoUploadConfirmed}
              logoUploading={logoUploading}
              newOrganizationLogo={newOrganizationLogo}
              onFileSelected={handleOrganizationLogoFile}
              stagedLogoFile={effectiveStagedLogoFile}
            />
            <GuidedOnboardingOrganizationFields
              autoFocusName
              name={name}
              nameInputId="organization-name"
              onNameChange={handleNameChange}
              onSlugChange={(nextSlug) => {
                setSlugEdited(true);
                setSlug(nextSlug);
              }}
              slug={slug}
              slugInputId="organization-slug"
            />
          </div>
        </div>
      </div>
      <div className={GUIDED_ONBOARDING_STEP_FOOTER_CLASS}>
        <GuidedOnboardingBackButton onBack={onBack} />
        <Button
          aria-busy={creating}
          className="w-full sm:w-56"
          disabled={!canSubmit}
          size="lg"
          type="submit"
        >
          {creating ? <Loader2 className="animate-spin" /> : null}
          Create organization
        </Button>
      </div>
    </form>
  );

  async function handleOrganizationLogoFile(file: File) {
    const validationError = validateOrganizationLogoFile(file);
    if (validationError) {
      setStagedLogoFile(null);
      setLogoError(validationError);
      return;
    }

    if (!onUploadOrganizationLogo) {
      setStagedLogoFile(file);
      setLogoUploadConfirmed(false);
      setLogoError(null);
      return;
    }

    setLogoUploading(true);
    setLogoError(null);
    try {
      await onUploadOrganizationLogo(file);
      setLogoUploadConfirmed(true);
      setStagedLogoFile(null);
    } catch {
      setLogoError("Logo upload failed. Try again.");
    } finally {
      setLogoUploading(false);
    }
  }
}

/**
 * Names the company only when the host inferred one. An empty `defaultName` is
 * absence, not a company called "" — so the sentence drops to "your company"
 * instead of the invented "Acme Co." it shipped with (ISS-8678).
 */
function getFirstPersonSentence(defaultName: string): string {
  const trimmed = defaultName.trim();
  return trimmed
    ? `You're the first person from ${trimmed} to join Closedloop.`
    : "You're the first person from your company to join Closedloop.";
}

export function selectCreateOrganizationStepProps(
  source: GuidedOnboardingPhaseSource
): ComponentProps<typeof GuidedOnboardingCreateOrganizationStep> {
  return {
    // Staging a logo is only offered when the host can actually create the
    // organization; without that callback there is nothing to attach it to.
    allowStagedOrganizationLogo:
      Boolean(source.onCreateOrganization) &&
      source.allowStagedOrganizationLogo,
    annotation: source.annotations[OnboardingPhase.CreateOrganization],
    brand: source.brand,
    creating: source.organizationCreating,
    defaultName: source.organizationName,
    defaultSlug: source.organizationSlug,
    error: source.organizationCreationError,
    newOrganizationLogo: source.newOrganizationLogo,
    onBack: source.onBack,
    onCreate: (organization) => {
      if (source.onCreateOrganization) {
        source.onCreateOrganization(
          organization,
          createOrganizationReadyEvent()
        );
        return;
      }
      source.onComplete();
    },
    onUploadOrganizationLogo: source.onUploadOrganizationLogo,
  };
}
