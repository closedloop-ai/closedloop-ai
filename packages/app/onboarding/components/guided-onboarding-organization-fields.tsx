"use client";

import {
  DESKTOP_BOOTSTRAP_ORGANIZATION_NAME_MAX_LENGTH,
  DESKTOP_BOOTSTRAP_ORGANIZATION_SLUG_MAX_LENGTH,
} from "@repo/api/src/types/desktop-bootstrap";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import type { ChangeEvent } from "react";

/**
 * The organization's name and slug, as one pair of labelled fields.
 *
 * Extracted from the create-organization step so the choose step can offer the
 * SAME two fields for the organization Clerk's signup task already made
 * (ISS-11253). One module, so the labels, the placeholders, the URL hint and the
 * slug normalization cannot drift between the screen that names a new
 * organization and the screen that renames an existing one — and so neither
 * screen restates a string the other already owns.
 *
 * Ids are caller-supplied: two mounts of this pair in one document would
 * otherwise share a `for`/`id` pair, which points every label at the first
 * input.
 */
export function GuidedOnboardingOrganizationFields({
  autoFocusName = false,
  name,
  nameInputId,
  onNameChange,
  onSlugChange,
  slug,
  slugInputId,
}: {
  autoFocusName?: boolean;
  name: string;
  nameInputId: string;
  onNameChange: (name: string) => void;
  onSlugChange: (slug: string) => void;
  slug: string;
  slugInputId: string;
}) {
  return (
    <>
      <div className="grid gap-2">
        <Label htmlFor={nameInputId}>Name</Label>
        <Input
          autoComplete="organization"
          autoFocus={autoFocusName}
          id={nameInputId}
          maxLength={DESKTOP_BOOTSTRAP_ORGANIZATION_NAME_MAX_LENGTH}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onNameChange(event.target.value)
          }
          placeholder="Organization name"
          value={name}
        />
      </div>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <Label htmlFor={slugInputId}>Slug</Label>
          <span className="min-w-0 break-all text-muted-foreground text-xs">
            Used in your organization URL
            {slug ? (
              <>
                {": "}
                <a
                  className="underline decoration-muted-foreground/40 underline-offset-4 transition-colors hover:text-foreground"
                  href={`https://app.closedloop.ai/${slug}`}
                  rel="noreferrer"
                  target="_blank"
                >
                  {`https://app.closedloop.ai/${slug}`}
                </a>
              </>
            ) : null}
          </span>
        </div>
        <Input
          id={slugInputId}
          maxLength={DESKTOP_BOOTSTRAP_ORGANIZATION_SLUG_MAX_LENGTH}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onSlugChange(normalizeOrganizationSlugInput(event.target.value))
          }
          placeholder="my-organization"
          value={slug}
        />
      </div>
    </>
  );
}

/**
 * The slug a value SAVES as: fully normalized, trailing separators included.
 * Use it to propose a slug from a name, and at submit — never on a keystroke.
 */
export function createOrganizationSlug(value: string) {
  return normalizeOrganizationSlugInput(value).replace(TRAILING_HYPHENS, "");
}

/**
 * The slug a value shows as WHILE IT IS BEING TYPED. Identical to
 * {@link createOrganizationSlug} except that it keeps a trailing hyphen.
 *
 * Stripping that hyphen per keystroke is not a cosmetic difference: the field is
 * controlled, so the stripped value is what the next keystroke appends to, and
 * typing "ada-labs" one character at a time yields "adalabs" — a hyphenated
 * organization URL becomes unreachable by typing at all, only by pasting
 * (tamsinb, ISS-11253 review). A LEADING hyphen is still stripped, because no
 * keystroke sequence can be reaching for one.
 */
export function normalizeOrganizationSlugInput(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(LEADING_HYPHENS, "");
}

const LEADING_HYPHENS = /^-+/;
const TRAILING_HYPHENS = /-+$/;
