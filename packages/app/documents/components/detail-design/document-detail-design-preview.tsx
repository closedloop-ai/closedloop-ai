// gardener-support: test and story data, not shipped
"use client";

import { DocumentRichTextToolbar } from "@repo/app/documents/components/document-rich-text-toolbar";
import { VersionSelector } from "@repo/app/documents/components/version-selector";
import { ArtifactCanvasPanel } from "@repo/app/shared/components/artifact-detail-shell/artifact-canvas-panel";
import { documentDetailsTabConfig } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-fixtures";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { type ReactNode, useState } from "react";
import { ArtifactCanvasToolbar } from "./artifact-canvas-toolbar";
import {
  DOCUMENT_DESIGN_ACTIVITY_ROWS,
  DOCUMENT_DESIGN_ARTIFACT,
  DOCUMENT_DESIGN_BODY,
  DOCUMENT_DESIGN_COMMENTS,
  DOCUMENT_DESIGN_VERSIONS,
} from "./document-detail-design-fixtures";
import {
  DocumentDesignActivityPanel,
  DocumentDesignDetailsPanel,
  DocumentDesignSessionsPanel,
  type DocumentDesignTab,
  type DocumentDetailPageHeaderParts,
  DocumentFamilyDetailDesignShell,
} from "./document-detail-design-shell";

/**
 * ISS-12586 (DI-16): the Document Detail page shell in the PRD-751 artifact
 * detail shell, as Branch and Session Detail have it. Nothing in production
 * imports it; Storybook renders it (Surfaces/Labs/Documents/Document
 * Detail, and a Composites entry per section).
 *
 * - Artifact: the document canvas. It opens with the toolbar an Issue's canvas
 *   opens with (`ArtifactCanvasToolbar`, Nerys 2026-10-22), staying at the
 *   top while the document scrolls: the live editor's text controls
 *   (`DocumentRichTextToolbar`), always on, on the left; the version
 *   dropdown (the shipped `VersionSelector`, where the live editor has it)
 *   on the right, before the place Publish will take. Add comment is in the
 *   page header, beside the comments toggle. Then the body, with no fixed
 *   height and no scroller of its own: it grows with the document and the
 *   page's canvas scrolls. No sections under it.
 * - Sessions: the shipped Document Sessions panel with a fixture.
 * - Details: the shared Details sections for a Document (PRD-799's group).
 * - Activity: the shared Activity timeline with Document rows.
 */

export function DocumentDetailDesignPreview({
  initialTab = ArtifactDetailTab.Artifact,
  pageHeader,
}: Readonly<{
  /** The tab the page opens on, so a story can open it on any tab. */
  initialTab?: DocumentDesignTab;
  /** Renders the page header row; the app's route header in a full page. */
  pageHeader?: (parts: DocumentDetailPageHeaderParts) => ReactNode;
}>) {
  return (
    <DocumentFamilyDetailDesignShell
      artifact={DOCUMENT_DESIGN_ARTIFACT}
      comments={DOCUMENT_DESIGN_COMMENTS}
      initialTab={initialTab}
      pageHeader={pageHeader}
      panels={() => ({
        [ArtifactDetailTab.Artifact]: <DocumentArtifactPanel />,
        [ArtifactDetailTab.Sessions]: <DocumentSessionsDesignPanel />,
        [ArtifactDetailTab.Details]: <DocumentDetailsDesignPanel />,
        [ArtifactDetailTab.Activity]: <DocumentActivityDesignPanel />,
      })}
    />
  );
}

/**
 * The canvas toolbar: the toolbar an Issue's canvas opens with
 * (`ArtifactCanvasToolbar`). The live editor's text controls on the left,
 * always on (a document is always editable here); the version dropdown on
 * the right, where the live editor has it, before the place Publish will
 * take.
 */
export function DocumentDesignToolbar() {
  const [version, setVersion] = useState<number>(
    DOCUMENT_DESIGN_VERSIONS.current
  );
  return (
    <ArtifactCanvasToolbar
      label={DOCUMENT_TOOLBAR_LABEL}
      left={
        // The live editor's controls, as `DocumentEditorScaffold` mounts
        // them. No editor here, so they change nothing.
        <DocumentRichTextToolbar
          className="border-0 bg-transparent p-0"
          editor={null}
          onPasteMarkdown={() => undefined}
        />
      }
      right={
        <VersionSelector
          currentVersion={version}
          latestVersion={DOCUMENT_DESIGN_VERSIONS.latest}
          onVersionChange={setVersion}
        />
      }
    />
  );
}

/**
 * The Artifact tab: the document canvas. The toolbar, then the document at
 * its natural height.
 */
export function DocumentArtifactPanel() {
  return (
    <ArtifactCanvasPanel label="Document">
      <DocumentDesignToolbar />
      <article className="space-y-6 pt-6">
        <h2 className="font-semibold text-2xl">
          {DOCUMENT_DESIGN_ARTIFACT.title}
        </h2>
        {DOCUMENT_DESIGN_BODY.map((section) => (
          <section className="space-y-3" key={section.heading}>
            <h3 className="font-semibold text-lg">{section.heading}</h3>
            {section.paragraphs.map((paragraph) => (
              <p className="text-sm leading-relaxed" key={paragraph}>
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </article>
    </ArtifactCanvasPanel>
  );
}

/** The document canvas toolbar's region name. */
export const DOCUMENT_TOOLBAR_LABEL = "Document toolbar";

/** The Sessions tab: the sessions that wrote to or commented on the document. */
export function DocumentSessionsDesignPanel() {
  return <DocumentDesignSessionsPanel />;
}

/** The Details tab: Artifact details, Document details (Current version). */
export function DocumentDetailsDesignPanel() {
  return (
    <DocumentDesignDetailsPanel
      config={(host) =>
        documentDetailsTabConfig(host, DOCUMENT_DESIGN_ARTIFACT)
      }
      label="Document details"
    />
  );
}

/** The Activity tab: the Document feed, newest first. */
export function DocumentActivityDesignPanel() {
  return (
    <DocumentDesignActivityPanel
      label="Document activity"
      rows={DOCUMENT_DESIGN_ACTIVITY_ROWS}
    />
  );
}
