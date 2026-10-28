import { TagColor } from "@repo/api/src/types/tag";
import { CatalogTargetKind } from "@/app/catalog/validators";

/**
 * ISS-12017: the team-authored text the domain stages write. Seeded data, not
 * product copy: tag names and pack bodies a real team would leave.
 */

export type SeedTag = { readonly name: string; readonly color: TagColor };

export const SEED_TAGS: readonly SeedTag[] = [
  { name: "onboarding", color: TagColor.Sky },
  { name: "billing", color: TagColor.Amber },
  { name: "desktop", color: TagColor.Indigo },
  { name: "performance", color: TagColor.Orange },
  { name: "tech-debt", color: TagColor.Rose },
  { name: "customer-reported", color: TagColor.Red },
  { name: "q4-launch", color: TagColor.Emerald },
];

export type SeedPackComponent = {
  readonly name: string;
  readonly targetKind:
    | typeof CatalogTargetKind.Skill
    | typeof CatalogTargetKind.Command;
  readonly description: string;
  readonly content: string;
  /** A later edit, appended as the component's second version. */
  readonly revisedContent: string;
};

export type SeedPack = {
  readonly name: string;
  readonly description: string;
  readonly components: readonly SeedPackComponent[];
};

export const SEED_PACKS: readonly SeedPack[] = [
  {
    name: "Platform Review Kit",
    description:
      "Review and release helpers the platform team runs on every pull request.",
    components: [
      {
        name: "pr-review-checklist",
        targetKind: CatalogTargetKind.Skill,
        description: "Walks a diff against the platform review checklist.",
        content:
          "# PR review checklist\n\nRead the diff, then check:\n\n- Org scoping on every new query\n- Tests for each new branch\n- No new client-side logging\n",
        revisedContent:
          "# PR review checklist\n\nRead the diff, then check:\n\n- Org scoping on every new query\n- Tests for each new branch\n- No new client-side logging\n- Cross-version compatibility for any payload change\n",
      },
      {
        name: "release-notes",
        targetKind: CatalogTargetKind.Command,
        description: "Drafts release notes from the merged pull requests.",
        content:
          "Collect the pull requests merged since the last tag and group them by area. Write one line per change in the imperative mood.\n",
        revisedContent:
          "Collect the pull requests merged since the last tag and group them by area. Write one line per change in the imperative mood, and call out anything that needs a migration.\n",
      },
    ],
  },
  {
    name: "Incident Response",
    description: "Runbook helpers for the on-call rotation.",
    components: [
      {
        name: "triage-alert",
        targetKind: CatalogTargetKind.Skill,
        description: "Turns a paging alert into a first-pass triage note.",
        content:
          "# Triage an alert\n\nFind the monitor, the first bad timestamp and the last deploy before it. Write what changed, what is affected and who owns it.\n",
        revisedContent:
          "# Triage an alert\n\nFind the monitor, the first bad timestamp and the last deploy before it. Write what changed, what is affected, who owns it and whether a rollback is safe.\n",
      },
    ],
  },
];

/** A Pensero person: the org's own user bridges by email, the others do not. */
export type SeedDeliveryPerson = {
  readonly providerPersonId: number;
  readonly name: string;
  readonly email: string;
};

export const SEED_DELIVERY_TEAMMATES: readonly SeedDeliveryPerson[] = [
  {
    providerPersonId: 4102,
    name: "Priya Raman",
    email: "priya.raman@example.com",
  },
  {
    providerPersonId: 4107,
    name: "Marcus Webb",
    email: "marcus.webb@example.com",
  },
];

export const SEED_DELIVERY_MESSAGING_TITLES: readonly string[] = [
  "Answered a question about the rollout plan in #platform",
  "Unblocked the desktop release in #release-train",
];

export const SEED_DELIVERY_TICKET_TITLES: readonly string[] = [
  "Investigate slow branch list on large orgs",
  "Document the new API key scopes",
];

export type SeedOrgDocument = {
  readonly title: string;
  readonly content: string;
};

/** Evergreen team documents that belong to no single project. */
export const SEED_ORG_DOCUMENTS: readonly SeedOrgDocument[] = [
  {
    title: "Engineering onboarding guide",
    content:
      "# Engineering onboarding guide\n\n## First day\n\n- Get access to the monorepo and run the bootstrap script.\n- Pair with your onboarding buddy on one small pull request.\n\n## First week\n\n- Ship a change behind review end to end.\n- Join the on-call shadow rotation for one shift.\n",
  },
  {
    title: "On-call runbook",
    content:
      "# On-call runbook\n\n## When a page fires\n\n1. Acknowledge within five minutes.\n2. Find the first bad timestamp and the last deploy before it.\n3. Roll back first, investigate second, when the deploy is the likely cause.\n\n## Handoff\n\nWrite what happened, what is still open and who owns it in the on-call channel.\n",
  },
  {
    title: "Release checklist",
    content:
      "# Release checklist\n\n- Green main pipeline on the release commit.\n- Migrations reviewed for backward compatibility.\n- Desktop and web changes verified against the previous client version.\n- Release notes drafted from the merged pull requests.\n",
  },
  {
    title: "Architecture decision log",
    content:
      "# Architecture decision log\n\n## Keep database access behind the API\n\nThe product UI calls the API, and only the API reads the database. This keeps org scoping in one place.\n\n## Additive wire contracts\n\nNew payload fields are optional, so installed Desktop builds keep working while the API moves ahead.\n",
  },
];

/** A finished project the team archived, so the archived view has a row. */
export const SEED_ARCHIVED_PROJECT = {
  name: "Legacy billing export",
  description:
    "Nightly CSV export of invoices for the old finance tooling. Replaced by the billing API and archived after the cutover.",
} as const;
