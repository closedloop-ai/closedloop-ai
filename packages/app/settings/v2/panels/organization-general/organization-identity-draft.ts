import type { Organization } from "@repo/api/src/types/organization";
import { orgSlugSchema } from "@repo/api/src/types/reserved-slugs";

const WHITESPACE_RUN = /\s+/g;
const NON_SLUG_CHARS = /[^a-z0-9-]/g;
const HYPHEN_RUN = /-{2,}/g;
const TRAILING_SLASH = /\/$/;
const SCHEME_PREFIX = /^https?:\/\//;
const DEFAULT_APP_ORIGIN = "http://localhost:3000";

/**
 * Fold typed input into the only shape `orgSlugSchema` accepts, so the field
 * cannot show the user a value the server would reject for a reason they can
 * see and fix themselves. Lifted verbatim from the legacy
 * `organization-slug-editor`, whose behavior a test already pins; ISS-8365 must
 * preserve the existing slug semantics rather than invent new ones.
 */
export function normalizeOrgSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(WHITESPACE_RUN, "-")
    .replace(NON_SLUG_CHARS, "")
    .replace(HYPHEN_RUN, "-");
}

/**
 * The host the workspace URL is shown under, e.g. `app.closedloop.ai/`.
 *
 * Read at render rather than at module scope, and defaulted, because the panel
 * that mounts this is web-only (`hosts: [Web]`) and lazily imported — a shell
 * without the variable must degrade to a truthful local origin rather than
 * assert a production host the user is not actually on.
 */
export function resolveWorkspaceUrlPrefix(): string {
  const configured =
    typeof process === "undefined"
      ? undefined
      : process.env.NEXT_PUBLIC_APP_URL;
  const origin = (configured || DEFAULT_APP_ORIGIN)
    .replace(TRAILING_SLASH, "")
    .replace(SCHEME_PREFIX, "");
  return `${origin}/`;
}

export type OrganizationIdentityDraftInput = {
  organization: Pick<Organization, "name" | "slug">;
  name: string;
  slug: string;
  canEditName: boolean;
  canEditSlug: boolean;
  conflictError: string | null;
  isSaving: boolean;
};

export type OrganizationIdentityDraft = {
  /** The trimmed name when it actually differs from what is stored, else null. */
  changedName: string | null;
  /** The trimmed slug when it actually differs from what is stored, else null. */
  changedSlug: string | null;
  /** Validation or conflict text for the slug field. Null when it is fine. */
  slugMessage: string | null;
  slugPrefix: string;
  canSave: boolean;
};

/**
 * Everything the form needs to decide, derived in one place from the stored
 * organization plus the draft.
 *
 * The two `changed*` fields are the point: a submit sends ONLY the fields that
 * actually moved. Sending an unchanged slug would drive `PUT /organizations/[id]`
 * down its admin-gated slug branch for an edit that changes nothing, so a member
 * renaming their organization would be refused for a field they never touched.
 */
export function organizationIdentityDraftState(
  input: OrganizationIdentityDraftInput
): OrganizationIdentityDraft {
  const trimmedName = input.name.trim();
  const trimmedSlug = input.slug.trim();
  // Both sides trimmed, because only one side of this comparison is: a stored
  // name carrying leading or trailing whitespace would otherwise differ from
  // the trimmed draft the moment the form opens, marking it dirty and sending a
  // rename the user never asked for.
  const storedName = input.organization.name.trim();
  const storedSlug = input.organization.slug.trim();

  const changedName =
    input.canEditName && trimmedName.length > 0 && trimmedName !== storedName
      ? trimmedName
      : null;
  const changedSlug =
    input.canEditSlug && trimmedSlug !== storedSlug ? trimmedSlug : null;

  const slugMessage = resolveSlugMessage(changedSlug, input.conflictError);
  const hasEmptyName = input.canEditName && trimmedName.length === 0;

  return {
    canSave:
      !(input.isSaving || hasEmptyName) &&
      slugMessage === null &&
      (changedName !== null || changedSlug !== null),
    changedName,
    changedSlug,
    slugMessage,
    slugPrefix: resolveWorkspaceUrlPrefix(),
  };
}

function resolveSlugMessage(
  changedSlug: string | null,
  conflictError: string | null
): string | null {
  if (changedSlug === null) {
    // An untouched slug is not "valid" or "invalid" — it is not being written.
    // A stored legacy slug can fail `orgSlugSchema` (org ids were written as
    // slugs before it existed), and reporting that as the user's error would
    // block a name change over a value they never typed.
    return conflictError;
  }

  const validation = orgSlugSchema.safeParse(changedSlug);
  if (validation.success) {
    return conflictError;
  }
  return validation.error.issues[0]?.message ?? "Invalid organization URL";
}
