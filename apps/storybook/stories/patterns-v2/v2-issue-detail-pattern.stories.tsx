import type { Meta, StoryObj } from "@storybook/react";
import { DocumentFamilyCanvas } from "./document-family-detail-layout";
import { documentFamilyDetailStories } from "./document-family-detail-pattern-stories";

/**
 * Patterns: the Issue Detail page's layout as its Labs surface lays it out
 * (`document-family-detail-layout.tsx`, ISS-12576), as Ottilie and Nerys
 * settled it on 2026-10-21: the page header row (breadcrumbs ending in the
 * slug and title, then the comments toggle; nothing issue-only, so it matches
 * every artifact's), the tab row (Artifact / Sessions / Details / Activity)
 * ending with the collaborators, and the comments rail beside Artifact and
 * Sessions only.
 *
 * Add comment sits just before the comments toggle, on the Artifact tab. The
 * Artifact canvas opens with the toolbar the Document canvas opens with
 * (slug with the issue icon, key fields; its right end kept for Publish),
 * staying at the top while the issue scrolls under it, with the text
 * controls in an edit bar under it while the issue's text is edited, then the issue's
 * text, Sub-issues, Branch and Activity summary. The toolbar is on the
 * Artifact tab only; Details shows the same fields with more room. Issues
 * have no versions.
 *
 * The finished page is Surfaces/Labs/Issues/Issue Detail.
 *
 * Controls are disabled: every story is a fixed layout state.
 */
const stories = documentFamilyDetailStories(DocumentFamilyCanvas.Issue);

const meta = {
  ...stories.meta,
  title: "Patterns/Labs/Issues/Issue Detail",
  tags: ["preview"],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = stories.Default;

export const SessionsTab: Story = stories.SessionsTab;

export const DetailsTab: Story = stories.DetailsTab;

export const ActivityTab: Story = stories.ActivityTab;

export const Dark: Story = stories.Dark;
