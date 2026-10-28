import type { Meta, StoryObj } from "@storybook/react";
import { DocumentFamilyCanvas } from "./document-family-detail-layout";
import { documentFamilyDetailStories } from "./document-family-detail-pattern-stories";

/**
 * Patterns: the Document Detail page's layout as its Labs surface lays it out
 * (`document-family-detail-layout.tsx`, ISS-12586): the page header row
 * (breadcrumbs ending in the slug and title, then the comments toggle), the
 * tab row (Artifact / Sessions / Details / Activity) ending with the
 * collaborators, and the comments rail beside Artifact and Sessions only.
 * Add comment sits just before the comments toggle, on the Artifact tab. The
 * Artifact canvas opens with the toolbar the Issue canvas opens with,
 * staying at the top while the document scrolls: the live editor's text
 * controls, always on, and the version dropdown, with its right end kept for
 * Publish. Then the document body.
 *
 * The finished page is Surfaces/Labs/Documents/Document Detail.
 *
 * Controls are disabled: every story is a fixed layout state.
 */
const stories = documentFamilyDetailStories(DocumentFamilyCanvas.Document);

const meta = {
  ...stories.meta,
  title: "Patterns/Labs/Documents/Document Detail",
  tags: ["preview"],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = stories.Default;

export const SessionsTab: Story = stories.SessionsTab;

export const DetailsTab: Story = stories.DetailsTab;

export const ActivityTab: Story = stories.ActivityTab;

export const Dark: Story = stories.Dark;
