import type { Meta, StoryObj } from "@storybook/react";
import {
  artifactListDark,
  artifactListDefault,
  artifactListNarrow,
  artifactListPatternMeta,
} from "./artifact-list-pattern-stories";

/**
 * Patterns: the Documents list page's layout, the artifact list layout every v2
 * list shares (`artifact-list-layout.tsx`, ISS-12171).
 *
 * The live page already renders it: the Documents index lays out on
 * `GridTableListSurface`. The finished page is
 * Surfaces/Labs/Documents/Documents List.
 *
 * Controls are disabled: every story is a fixed layout state.
 */
const meta = {
  ...artifactListPatternMeta,
  title: "Patterns/Labs/Documents/Documents List",
  tags: ["preview"],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = artifactListDefault;

export const Narrow: Story = artifactListNarrow;

export const Dark: Story = artifactListDark;
