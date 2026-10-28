import { DocumentStatus, IssueStatus } from "@closedloop-ai/loops-api/document";
import {
  ArtifactStatusEditSurface,
  ArtifactStatusReadOnlyReason,
  ArtifactStatusVocabulary,
} from "@repo/api/src/types/artifact-status-contract";
import {
  toArtifactStatusFromDocument,
  toArtifactStatusFromIssue,
  toArtifactStatusFromSession,
} from "@repo/api/src/types/artifact-status-mapping";
import { ArtifactStatus } from "@repo/app/shared/components/artifact-status/artifact-status";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import type {
  ArtifactStatusFacet,
  ArtifactStatusView,
} from "@repo/app/shared/lib/artifact-status-view-contract";
import { ArtifactStatusVariant } from "@repo/app/shared/lib/artifact-status-view-contract";
import { ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import type { Meta, StoryObj } from "@storybook/react";
import { type ReactNode, useState } from "react";

// Reachable rather than contrived: `Artifact.status` is a freeform column
// carrying disjoint vocabularies, so a row written by a newer build arrives
// with a value this one's fold cannot place.
const UNRECOGNIZED_RAW_STATUS = "BRANCH_MERGED";

const DOCUMENT_VIEW: ArtifactStatusView = {
  artifactId: "doc-1",
  normalized: toArtifactStatusFromDocument(DocumentStatus.Draft),
  raw: DocumentStatus.Draft,
  vocabulary: ArtifactStatusVocabulary.Document,
};

const UNRECOGNIZED_VIEW: ArtifactStatusView = {
  artifactId: "doc-2",
  normalized: toArtifactStatusFromDocument(UNRECOGNIZED_RAW_STATUS),
  raw: UNRECOGNIZED_RAW_STATUS,
  vocabulary: ArtifactStatusVocabulary.Document,
};

const SESSION_VIEW: ArtifactStatusView = {
  artifactId: "session-1",
  normalized: toArtifactStatusFromSession("active"),
  raw: "active",
  vocabulary: ArtifactStatusVocabulary.Session,
};

const ISSUE_FACET: ArtifactStatusFacet = {
  normalized: toArtifactStatusFromIssue(IssueStatus.InProgress),
  raw: IssueStatus.InProgress,
  vocabulary: ArtifactStatusVocabulary.Issue,
};

/**
 * All nine approved variants at once — the proof the champion mounts, which is
 * the whole of this ticket's Storybook obligation. The state matrix, the
 * light/dark and narrow/wide passes, the interaction and a11y tests and the
 * catalog entry are ISS-9302's.
 */
function ArtifactStatusVariantGallery() {
  return (
    <div className="flex flex-col gap-4">
      <VariantRow name={ArtifactStatusVariant.Display}>
        <ArtifactStatus
          variant={ArtifactStatusVariant.Display}
          view={DOCUMENT_VIEW}
        />
      </VariantRow>
      <VariantRow name={ArtifactStatusVariant.Icon}>
        <ArtifactStatus
          variant={ArtifactStatusVariant.Icon}
          view={DOCUMENT_VIEW}
        />
      </VariantRow>
      <VariantRow name={ArtifactStatusVariant.Badge}>
        <ArtifactStatus
          variant={ArtifactStatusVariant.Badge}
          view={DOCUMENT_VIEW}
        />
      </VariantRow>
      <VariantRow name={ArtifactStatusVariant.CompactCell}>
        <ArtifactStatus
          variant={ArtifactStatusVariant.CompactCell}
          view={DOCUMENT_VIEW}
        />
      </VariantRow>
      <VariantRow name={ArtifactStatusVariant.DetailField}>
        <ArtifactStatus
          variant={ArtifactStatusVariant.DetailField}
          view={DOCUMENT_VIEW}
        />
      </VariantRow>
      <VariantRow name={ArtifactStatusVariant.Editor}>
        <EditorHost />
      </VariantRow>
      <VariantRow name={ArtifactStatusVariant.FilterOption}>
        <ArtifactStatus
          facet={ISSUE_FACET}
          variant={ArtifactStatusVariant.FilterOption}
        />
      </VariantRow>
      <VariantRow name={ArtifactStatusVariant.BulkOption}>
        <ArtifactStatus
          facet={ISSUE_FACET}
          variant={ArtifactStatusVariant.BulkOption}
        />
      </VariantRow>
      <VariantRow name={ArtifactStatusVariant.BoardLane}>
        <ArtifactStatus
          facet={ISSUE_FACET}
          variant={ArtifactStatusVariant.BoardLane}
        />
      </VariantRow>
    </div>
  );
}

/**
 * The editor drives a real transition: the champion is controlled, so the host
 * owns the value and hands back the view its own commit produced. That is the
 * contract ISS-9304 inherits, and a no-op handler would demonstrate the
 * opposite of it.
 */
function EditorHost() {
  const [view, setView] = useState<ArtifactStatusView>({
    artifactId: "doc-3",
    normalized: toArtifactStatusFromDocument(DocumentStatus.InReview),
    raw: DocumentStatus.InReview,
    vocabulary: ArtifactStatusVocabulary.Document,
  });

  return (
    <ArtifactStatus
      capability={{
        allowedTargets: [
          DocumentStatus.Approved,
          DocumentStatus.ChangesRequested,
          DocumentStatus.Obsolete,
        ],
        editable: true,
      }}
      onCommit={(commit) => {
        setView((current) => ({
          ...current,
          normalized: toArtifactStatusFromDocument(commit.to),
          raw: commit.to,
        }));
      }}
      surface={ArtifactStatusEditSurface.Detail}
      variant={ArtifactStatusVariant.Editor}
      view={view}
    />
  );
}

function VariantRow({
  children,
  name,
}: Readonly<{ children: ReactNode; name: string }>) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-32 shrink-0 text-muted-foreground text-xs">
        {name}
      </span>
      {children}
    </div>
  );
}

const meta = {
  title: "Primitives v1.0/Feedback & Status/Artifact Status",
  component: ArtifactStatusVariantGallery,
  tags: ["deprecated", "autodocs"],
} satisfies Meta<typeof ArtifactStatusVariantGallery>;

export default meta;

type Story = StoryObj<typeof meta>;

export const AllVariants: Story = {
  tags: ["!manifest"],
};

export const Display: Story = {
  render: () => (
    <ArtifactStatus
      variant={ArtifactStatusVariant.Display}
      view={DOCUMENT_VIEW}
    />
  ),
};

export const Icon: Story = {
  render: () => (
    <ArtifactStatus variant={ArtifactStatusVariant.Icon} view={DOCUMENT_VIEW} />
  ),
};

export const Badge: Story = {
  render: () => (
    <ArtifactStatus
      variant={ArtifactStatusVariant.Badge}
      view={DOCUMENT_VIEW}
    />
  ),
};

export const CompactCell: Story = {
  render: () => (
    <ArtifactStatus
      variant={ArtifactStatusVariant.CompactCell}
      view={DOCUMENT_VIEW}
    />
  ),
};

export const DetailField: Story = {
  render: () => (
    <ArtifactStatus
      variant={ArtifactStatusVariant.DetailField}
      view={DOCUMENT_VIEW}
    />
  ),
};

export const Editor: Story = { render: () => <EditorHost /> };

export const FilterOption: Story = {
  render: () => (
    <ArtifactStatus
      facet={ISSUE_FACET}
      variant={ArtifactStatusVariant.FilterOption}
    />
  ),
};

export const BulkOption: Story = {
  render: () => (
    <ArtifactStatus
      facet={ISSUE_FACET}
      variant={ArtifactStatusVariant.BulkOption}
    />
  ),
};

export const BoardLane: Story = {
  render: () => (
    <ArtifactStatus
      facet={ISSUE_FACET}
      variant={ArtifactStatusVariant.BoardLane}
    />
  ),
};

/**
 * UAS-005 / UAS-023 — a status this build cannot place, with ISS-9560's gate
 * open. The mark is the muted marker no real status wears, the word is the
 * absence of a claim rather than the raw wire token, and the icon variant's
 * accessible name carries the sentence because it has nowhere to hover.
 */
export const UnrecognizedStatus: Story = {
  render: () => (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [ARTIFACT_STATUS_LABEL_HONESTY_FEATURE_FLAG_KEY],
      })}
    >
      <div className="flex flex-col gap-4">
        <VariantRow name={ArtifactStatusVariant.Display}>
          <ArtifactStatus
            variant={ArtifactStatusVariant.Display}
            view={UNRECOGNIZED_VIEW}
          />
        </VariantRow>
        <VariantRow name={ArtifactStatusVariant.Icon}>
          <ArtifactStatus
            variant={ArtifactStatusVariant.Icon}
            view={UNRECOGNIZED_VIEW}
          />
        </VariantRow>
        <VariantRow name={ArtifactStatusVariant.Badge}>
          <ArtifactStatus
            variant={ArtifactStatusVariant.Badge}
            view={UNRECOGNIZED_VIEW}
          />
        </VariantRow>
      </div>
    </FeatureFlagAdapterProvider>
  ),
};

/**
 * UAS-024 — editability is a permission. A session's status is machine-written,
 * so the editor renders the mark and the reason and offers no control at all,
 * rather than a control that refuses on click.
 */
export const ReadOnlyCapability: Story = {
  render: () => (
    <ArtifactStatus
      capability={{
        editable: false,
        reason: ArtifactStatusReadOnlyReason.MachineWritten,
      }}
      onCommit={() => undefined}
      surface={ArtifactStatusEditSurface.Detail}
      variant={ArtifactStatusVariant.Editor}
      view={SESSION_VIEW}
    />
  ),
};

/**
 * Editable with nothing legal to move to right now — distinct from read-only,
 * and deliberately not dressed as a refusal. The control exists and opens.
 */
export const NoAllowedTargets: Story = {
  render: () => (
    <ArtifactStatus
      capability={{ allowedTargets: [], editable: true }}
      onCommit={() => undefined}
      surface={ArtifactStatusEditSurface.Detail}
      variant={ArtifactStatusVariant.Editor}
      view={DOCUMENT_VIEW}
    />
  ),
};
