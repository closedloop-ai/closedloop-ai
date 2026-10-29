"use client";

import {
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact";
import { AttachmentPurposeSelector } from "@repo/api/src/types/attachment";
import {
  type DocumentDetail,
  DocumentStatus,
  DocumentType,
  RepositoryRole,
  SnapshotSource,
} from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { artifactFavoriteKeys } from "@repo/app/documents/hooks/artifact-favorite-keys";
import { documentKeys } from "@repo/app/documents/hooks/document-keys";
import { artifactLinkKeys } from "@repo/app/documents/hooks/use-artifact-links";
import { attachmentKeys } from "@repo/app/documents/hooks/use-attachments";
import { PRIMARY_NAV_DESTINATIONS } from "@repo/app/shared/lib/primary-nav-destinations";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { teamKeys } from "@repo/app/teams/hooks/use-teams";
import { userKeys } from "@repo/app/users/hooks/use-users";
import type { Meta, StoryObj } from "@storybook/react";
import { VersionedDocumentEditorContainer } from "@/app/(authenticated)/[orgSlug]/components/versioned-document-editor-container";
import { AppScreenShell, ORG_SLUG } from "./app-shell";
import { StoryPlanEditor } from "./implementation-plan-detail-editor";

/**
 * Implementation Plan detail fixtures and screen states. StoryPlanEditor
 * composes the live scaffold and sections with story-scoped navigation.
 * The Actions menu is retired.
 */

const ORG_ID = "org_closedloop";

const OTTILIE: BasicUser = {
  id: "user-ottilie",
  firstName: "Ottilie",
  lastName: "Eye",
  email: "ottilie@closedloop.ai",
  avatarUrl: null,
};

const TEAM_ID = "team-platform";
const TEAM_NAME = "Platform";
const PROJECT_ID = "proj-billing-recon";
const PROJECT_NAME = "Billing Reconciliation Overhaul";
const PRIMARY_REPO_FULL_NAME = "closedloop-ai/closedloop-ai";

const PLAN_FIXTURE_DATE = new Date("2026-09-15T18:30:00.000Z");

const PLAN_MARKDOWN = `# Implementation Plan: Nightly Backfill Job for Billing Reconciliation

## Goal

Add a nightly job that backfills \`billing_reconciliation_snapshots\` for
organizations whose Stripe webhook events arrived out of order, so the
reconciliation dashboard stops undercounting revenue for the previous day.

## Context

ISS-6120 traced three orgs whose dashboards showed revenue 8-12% below
Stripe's own numbers. The cause: \`handleInvoicePaid\` writes a snapshot row
keyed on \`invoice.created\`, but Stripe can deliver \`invoice.paid\` before
\`invoice.created\` finishes replicating, so the upsert silently no-ops
against a row that does not exist yet.

## Steps

1. **Add a \`reconciliation_backfill_runs\` table** — tracks each nightly
   run's window, org count, and row count so a failed run is visible instead
   of silent.
2. **Write \`findMissedInvoiceEvents(orgId, windowStart, windowEnd)\`** in
   \`packages/billing/reconciliation/backfill.ts\` — queries Stripe's Events
   API for \`invoice.paid\` events with no matching snapshot row in the
   window.
3. **Write the backfill job**
   (\`apps/api/jobs/reconciliation-backfill.ts\`) — runs at 02:00 UTC,
   iterates every org with billing enabled, calls \`findMissedInvoiceEvents\`,
   and re-runs \`handleInvoicePaid\` for each miss.
4. **Add a dead-letter table** for events that fail twice in a row, with a
   Slack alert to #billing-eng so a third failure gets a human instead of a
   silent retry loop.
5. **Backfill the three known-affected orgs manually** via a one-off script
   before the nightly job ships, so their dashboards are correct immediately
   rather than waiting for the first scheduled run.
6. **Add a Grafana panel** charting \`reconciliation_backfill_runs.missed_count\`
   per night, so a recurring spike shows up before support tickets do.

## Testing

- Unit tests for \`findMissedInvoiceEvents\` against a fixture Stripe event
  log with out-of-order delivery.
- Integration test that runs the full backfill job against a seeded org with
  3 known-missed invoices and asserts all 3 resolve.
- Manual QA: re-run the backfill against a staging copy of the three
  affected orgs' data and diff the resulting snapshot totals against
  Stripe's own report export.

## Rollout

- Ship behind \`RECONCILIATION_BACKFILL_ENABLED\`, off by default.
- Manual backfill for the 3 known orgs, verified against Stripe's report
  export.
- Enable the nightly job for those 3 orgs only, for one week.
- Widen to every org with billing enabled once the Grafana panel shows zero
  misses for 7 consecutive nights.
`;

function buildPlanDetail({
  id,
  slug,
  title,
  status,
}: {
  id: string;
  slug: string;
  title: string;
  status: DocumentStatus;
}): DocumentDetail {
  return {
    id,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    type: DocumentType.ImplementationPlan,
    title,
    slug,
    fileName: null,
    status,
    priority: null,
    latestVersion: 1,
    createdById: OTTILIE.id,
    createdBy: OTTILIE,
    assigneeId: OTTILIE.id,
    assignee: OTTILIE,
    approverId: null,
    approver: null,
    repositorySnapshot: {
      repositories: [
        {
          fullName: PRIMARY_REPO_FULL_NAME,
          role: RepositoryRole.Primary,
          position: 0,
          branch: null,
          ref: null,
        },
      ],
      source: SnapshotSource.ProjectDefaults,
    },
    templateForType: null,
    sortOrder: 1,
    createdAt: PLAN_FIXTURE_DATE,
    updatedAt: PLAN_FIXTURE_DATE,
    project: {
      id: PROJECT_ID,
      name: PROJECT_NAME,
      teams: [{ id: TEAM_ID, name: TEAM_NAME }],
    },
    tags: [],
    version: {
      content: PLAN_MARKDOWN,
      createdAt: PLAN_FIXTURE_DATE,
      createdById: OTTILIE.id,
      documentId: id,
      id: `${id}-v1`,
      version: 1,
    },
    latestVersionContent: PLAN_MARKDOWN,
  };
}

const PLAN_DETAIL_APPROVED = buildPlanDetail({
  id: "plan-billing-recon-backfill",
  slug: "billing-reconciliation-nightly-backfill-plan",
  status: DocumentStatus.Approved,
  title: "Billing Reconciliation: Nightly Backfill Job",
});

const PLAN_DETAIL_DRAFT = buildPlanDetail({
  id: "plan-billing-recon-draft",
  slug: "billing-reconciliation-nightly-backfill-plan-draft",
  status: DocumentStatus.Draft,
  title: "Billing Reconciliation: Nightly Backfill Job (Draft)",
});

// ---------------------------------------------------------------------------
// Screen wrapper + fixture routes
// ---------------------------------------------------------------------------

const NAV_PATHS = PRIMARY_NAV_DESTINATIONS.map(
  (destination) => destination.path
);

type PlanDetailScreenProps = {
  activePath?: string;
  document: DocumentDetail;
  version?: number;
};

const PlanDetailScreen = ({
  activePath = "/documents",
  document,
  version,
}: PlanDetailScreenProps) => (
  <AppScreenShell activePath={activePath} hideHeader>
    <VersionedDocumentEditorContainer
      editor={StoryPlanEditor}
      slug={document.slug}
      version={version}
    />
  </AppScreenShell>
);

/**
 * Fixture routes + seeded query cache a Plan Detail mount needs — see the
 * file doc comment's "QUERY KEYS SEEDED" section for why each entry here is
 * load-bearing rather than cosmetic.
 */
function appCoreParamsFor(document: DocumentDetail) {
  return {
    apiRoutes: [
      {
        method: "GET",
        path: `/documents/by-slug/${document.slug}`,
        respond: () => document,
      },
      {
        method: "POST",
        path: `/documents/${document.id}/versions`,
        respond: ({ body }: FixtureRequestContext) => {
          const input = (body ?? {}) as { content?: string };
          const nextVersion = document.latestVersion + 1;
          return {
            ...document,
            latestVersion: nextVersion,
            latestVersionContent:
              input.content ?? document.latestVersionContent,
            version: {
              ...document.version,
              content: input.content ?? document.version.content,
              id: `${document.id}-v${nextVersion}`,
              version: nextVersion,
            },
          };
        },
      },
    ],
    queryData: [
      [userKeys.currentUser(), null],
      [artifactFavoriteKeys.list(), []],
      [
        attachmentKeys.listByPurpose(
          document.id,
          AttachmentPurposeSelector.Context
        ),
        [],
      ],
      [
        attachmentKeys.listByPurpose(
          document.id,
          AttachmentPurposeSelector.Inline
        ),
        [],
      ],
      [[...documentKeys.detail(document.id), "pull-request"], []],
      [
        artifactLinkKeys.list({
          artifactId: document.id,
          direction: LinkDirection.Source,
          linkType: LinkType.Produces,
          resolved: true,
        }),
        [],
      ],
      [
        artifactLinkKeys.list({
          artifactId: document.id,
          direction: LinkDirection.Target,
          mode: LinkQueryMode.Tree,
          resolved: true,
        }),
        [],
      ],
      [teamKeys.members(TEAM_ID), []],
    ],
  };
}

// ---------------------------------------------------------------------------
// Meta + stories
// ---------------------------------------------------------------------------

/**
 * The real, unflagged `/documents/[slug]` route for a plan: a plan's
 * read/edit view with its Context and Build sections.
 */
const meta = {
  title: "Surfaces v1.0/Implementation Plans/Plan Detail",
  component: PlanDetailScreen,
  tags: ["deprecated", "autodocs"],
  argTypes: {
    activePath: {
      options: NAV_PATHS,
      control: { type: "select" },
      description: "Which sidebar destination renders as current.",
      table: { category: "Shell" },
    },
    document: {
      description:
        "The plan fixture this story mounts. Not a live control — the object is too structured for the Controls panel; switch between the named stories below instead.",
      table: { disable: true },
    },
    version: {
      control: { type: "number", min: 1 },
      description:
        "The version VersionedDocumentEditorContainer opens on. Omit for latest.",
      table: { category: "State" },
    },
  },
  args: {
    activePath: "/documents",
    document: PLAN_DETAIL_APPROVED,
  },
  parameters: {
    layout: "fullscreen",
    docs: { story: { inline: false, iframeHeight: 900 } },
    appCore: appCoreParamsFor(PLAN_DETAIL_APPROVED),
  },
} satisfies Meta<typeof PlanDetailScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * An approved plan: real markdown content (a full execution plan with
 * numbered steps), real Context/Build sections in their honest
 * "nothing linked yet" states (no branch or PR yet).
 */
export const Default: Story = {};

/**
 * A draft plan awaiting approval.
 */
export const Draft: Story = {
  name: "Draft (awaiting approval)",
  args: { document: PLAN_DETAIL_DRAFT },
  parameters: { appCore: appCoreParamsFor(PLAN_DETAIL_DRAFT) },
};
