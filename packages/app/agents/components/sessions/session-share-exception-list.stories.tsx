import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { TRANSCRIPT_RETRY_LABEL } from "@repo/app/agents/components/detail/session-transcript-panel";
import {
  type SessionShareException,
  SessionShareExceptionList,
  type SessionShareExceptionListCopy,
  ShareExceptionOutcome,
  ShareExceptionPrecedence,
} from "@repo/app/agents/components/sessions/session-share-exception-list";
import { DataSyncPolicySummary } from "@repo/app/shared/components/data-sync-policy-summary";
import {
  DirectoryScopeList,
  type DirectoryScopeListCopy,
} from "@repo/app/shared/components/directory-scope-list";
import { ShareAudience } from "@repo/app/shared/lib/share-audience";
import { SessionUploadState } from "@repo/app/shared/lib/upload-state";
import { Section } from "@repo/design-system/components/ui/layout/section";
import type { Meta, StoryObj } from "@storybook/react";
import { expect, fn, userEvent, within } from "storybook/test";

/**
 * ISS-12535 (PRD-807): the sessions shared as one-off exceptions, listed in
 * the policy view apart from the default policy. Design-only: nothing records
 * exceptions yet, so the desktop Data & Sync tab does not render it; the
 * In Policy View story shows where it sits.
 *
 * Precedence against directory exclusions is a PRD-796 open decision. The
 * prototype takes "exception wins" (ISS-12535 thread th_wpRwGGsAXdk-RIqbzgatA,
 * open to Marisol / Kaito overruling it); the Exclusion Wins story is the other
 * answer, the same rows with one prop flipped.
 *
 * Copy: the retry control reuses `TRANSCRIPT_RETRY_LABEL`
 * (`session-transcript-panel.tsx:958`), as the upload badge does. "Current
 * level" and the level names in In Policy View are ISS-12523's shipped copy;
 * its "Data & Sync" section title is the tab's own (`data-sync-tab.tsx:135`).
 * Every other string is a placeholder named after its slot, allowed by
 * operator ruling (Nerys, 2026-10-15), ISS-12526 thread
 * th_Dc0RuSiAdyCvLQpC_X2G4, until the owner supplies the wording. Proposed
 * wording is on ISS-12535. Sessions and directories are fictional.
 */
const COPY: SessionShareExceptionListCopy = {
  heading: "Placeholder: exceptions heading",
  emptyText: "Placeholder: no exceptions text",
  audienceLabel: {
    [ShareAudience.OnlyMe]: "Placeholder: only-me audience label",
    [ShareAudience.Organization]: "Placeholder: organization audience label",
  },
  uploadStateLabel: {
    [SessionUploadState.LocalOnly]: "Placeholder: local-only label",
    [SessionUploadState.Uploading]: "Placeholder: uploading label",
    [SessionUploadState.Shared]: "Placeholder: shared label",
    [SessionUploadState.Failed]: "Placeholder: failed label",
  },
  retryLabel: TRANSCRIPT_RETRY_LABEL,
  excludedDirectoryLabel: "Placeholder: excluded directory label",
  blockedLabel: "Placeholder: blocked by exclusion label",
};

const EXCLUDED_DIRECTORY = {
  id: "/fixture/scratch/lumen-sandbox",
  label: "~/scratch/lumen-sandbox",
};

const SHARED_WITH_ORG: SessionShareException = {
  id: "session-orbit-webhooks",
  sessionName: "Retry backoff for orbit webhooks",
  audience: ShareAudience.Organization,
  uploadState: SessionUploadState.Shared,
};

const IN_EXCLUDED_DIRECTORY: SessionShareException = {
  id: "session-lumen-parser",
  sessionName: "Spike: lumen config parser",
  audience: ShareAudience.OnlyMe,
  uploadState: SessionUploadState.Uploading,
  excludedDirectory: EXCLUDED_DIRECTORY,
};

const FAILED_UPLOAD: SessionShareException = {
  id: "session-pebble-migration",
  sessionName: "Pebble schema migration dry run",
  audience: ShareAudience.OnlyMe,
  uploadState: SessionUploadState.Failed,
};

const EXCEPTIONS = [SHARED_WITH_ORG, IN_EXCLUDED_DIRECTORY, FAILED_UPLOAD];

const meta = {
  title: "Composites/Shared/Data Sync/Session Share Exception List",
  tags: ["experimental"],
  component: SessionShareExceptionList,
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
  args: {
    exceptions: EXCEPTIONS,
    precedence: ShareExceptionPrecedence.ExceptionWins,
    copy: COPY,
    onRetryUpload: fn(),
    retryingIds: [],
  },
  argTypes: {
    precedence: {
      control: "inline-radio",
      options: Object.values(ShareExceptionPrecedence),
      description:
        "Which rule wins for a session in an excluded directory. The prototype's decision is exception-wins.",
    },
    exceptions: {
      control: "object",
      description:
        "The sessions shared as exceptions: name, audience, upload state, and the excluded directory they live in, if any.",
    },
    copy: { control: "object", description: "Every visible string." },
    retryingIds: {
      control: "object",
      description: "Rows whose retry is in flight.",
    },
  },
} satisfies Meta<typeof SessionShareExceptionList>;

export default meta;

type Story = StoryObj<typeof meta>;

const DARK = { globals: { theme: "dark" } } as const;

function rowFor(canvasElement: HTMLElement, name: string): HTMLElement {
  const row = within(canvasElement).getByText(name).closest("li");
  if (!row) {
    throw new Error(`no row for ${name}`);
  }
  return row;
}

/**
 * The decided rule: the session in an excluded directory is shared anyway,
 * and its row says which excluded directory it comes from.
 */
export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("list", { name: COPY.heading })
    ).toBeVisible();
    const row = rowFor(canvasElement, IN_EXCLUDED_DIRECTORY.sessionName);
    await expect(row).toHaveAttribute(
      "data-outcome",
      ShareExceptionOutcome.AppliesDespiteExclusion
    );
    await expect(within(row).getByText(EXCLUDED_DIRECTORY.label)).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: TRANSCRIPT_RETRY_LABEL })
    );
    await expect(args.onRetryUpload).toHaveBeenCalledWith(FAILED_UPLOAD.id);
  },
};

/** No session shared as an exception. */
export const Empty: Story = {
  args: { exceptions: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(COPY.emptyText)).toBeVisible();
    await expect(canvas.queryByRole("list")).not.toBeInTheDocument();
  },
};

export const DefaultDark: Story = { ...Default, ...DARK };

/**
 * The other answer to the open decision: exclusion wins. The same rows, with
 * only `precedence` flipped; the session in the excluded directory shows as
 * blocked instead of its upload state.
 */
export const ExclusionWins: Story = {
  args: { precedence: ShareExceptionPrecedence.ExclusionWins },
  play: async ({ canvasElement }) => {
    const row = rowFor(canvasElement, IN_EXCLUDED_DIRECTORY.sessionName);
    await expect(within(row).getByText(COPY.blockedLabel)).toBeVisible();
    await expect(
      within(row).queryByText(
        COPY.uploadStateLabel[SessionUploadState.Uploading]
      )
    ).not.toBeInTheDocument();
  },
};

export const ExclusionWinsDark: Story = { ...ExclusionWins, ...DARK };

/** Every upload state once, each with both audiences across the rows. */
export const AllUploadStates: Story = {
  args: {
    exceptions: [
      {
        id: "session-local",
        sessionName: "Draft: harbor CLI help text",
        audience: ShareAudience.Organization,
        uploadState: SessionUploadState.LocalOnly,
      },
      { ...IN_EXCLUDED_DIRECTORY, excludedDirectory: undefined },
      SHARED_WITH_ORG,
      FAILED_UPLOAD,
    ],
  },
};

/** A failed row's retry in flight: the retry control is disabled. */
export const Retrying: Story = {
  args: { exceptions: [FAILED_UPLOAD], retryingIds: [FAILED_UPLOAD.id] },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", {
        name: TRANSCRIPT_RETRY_LABEL,
      })
    ).toBeDisabled();
  },
};

/** A session name too long for the row end-truncates. */
export const LongNames: Story = {
  args: {
    exceptions: [
      {
        ...IN_EXCLUDED_DIRECTORY,
        sessionName:
          "Investigate why the lumen config parser drops trailing comments in nested include blocks on Windows paths",
        excludedDirectory: {
          id: "/fixture/scratch/very/deeply/nested/lumen-sandbox-experiments",
          label: "~/scratch/very/deeply/nested/lumen-sandbox-experiments",
        },
      },
    ],
  },
};

const DIRECTORY_COPY: DirectoryScopeListCopy = {
  treeLabel: "Placeholder: directory tree label",
  newlyDiscovered: "Placeholder: newly discovered badge",
  unavailable: "Placeholder: unavailable badge",
  unavailableReason: "Placeholder: unavailable reason",
  empty: "Placeholder: no directories text",
  noSelection: "Placeholder: no selection text",
  autoExcludedHeading: "Placeholder: automatically excluded heading",
  autoExcludedReason: "Placeholder: automatically excluded reason",
};

const DIRECTORY_ENTRIES = [
  { id: "/fixture/code/orbit", label: "~/code/orbit" },
  { id: "/fixture/code/pebble", label: "~/code/pebble" },
  { id: EXCLUDED_DIRECTORY.id, label: EXCLUDED_DIRECTORY.label },
];

/**
 * In place: the policy view as the desktop Data & Sync tab would hold it once
 * exceptions exist. The default policy (the shipped summary and the directory
 * scope list, with lumen-sandbox left out) comes first, and the exceptions
 * follow as their own list. The tab itself is not changed: it has no
 * exception data to pass.
 */
export const InPolicyView: Story = {
  parameters: { layout: "fullscreen" },
  render: (args) => (
    <div className="mx-auto max-w-3xl p-6">
      <Section contentClassName="space-y-6" title="Data & Sync">
        <DataSyncPolicySummary
          directoryScope={{
            label: "Placeholder: directories in scope label",
            count: 2,
          }}
          level={DataSyncLevel.Full}
        />
        <DirectoryScopeList
          copy={DIRECTORY_COPY}
          entries={DIRECTORY_ENTRIES}
          includedIds={["/fixture/code/orbit", "/fixture/code/pebble"]}
        />
        <SessionShareExceptionList {...args} className="border-t pt-4" />
      </Section>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Current level")).toBeVisible();
    await expect(
      canvas.getByRole("list", { name: COPY.heading })
    ).toBeVisible();
  },
};

export const InPolicyViewDark: Story = { ...InPolicyView, ...DARK };
