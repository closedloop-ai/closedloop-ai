import type { Meta, StoryObj } from "@storybook/react";
import {
  documentDetailActivityTab,
  documentDetailDark,
  documentDetailDefault,
  documentDetailDetailsTab,
  documentDetailPatternMeta,
  documentDetailSessionsTab,
} from "./document-detail-pattern-stories";

/**
 * Patterns: the Plan Detail page's layout, the document detail layout
 * (`document-detail-layout.tsx`, ISS-12171): the route header row, then the
 * artifact detail shell with Artifact / Sessions / Details / Activity and the
 * comments rail beside every tab.
 *
 * The finished page is Surfaces/Other Pages/Implementation Plans/Plan
 * Detail.
 *
 * Controls are disabled: every story is a fixed layout state.
 */
const meta = {
  ...documentDetailPatternMeta,
  title: "Patterns/Other Pages/Implementation Plans/Plan Detail",
  tags: ["stable"],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = documentDetailDefault;

export const SessionsTab: Story = documentDetailSessionsTab;

export const DetailsTab: Story = documentDetailDetailsTab;

export const ActivityTab: Story = documentDetailActivityTab;

export const Dark: Story = documentDetailDark;
