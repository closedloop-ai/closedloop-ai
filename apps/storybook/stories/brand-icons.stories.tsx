import {
  GitHubMark,
  GoogleGlyph,
} from "@repo/design-system/components/ui/brand-icons";
import type { Meta, StoryObj } from "@storybook/react";

// Third-party brand marks (Google, GitHub) that lucide-react does not ship an
// accurate glyph for. Generic, project-agnostic logos shared by every sign-in
// surface — one canonical SVG each. Default to 16px; pass width/height or
// className to resize.
/**
 * The official Google and GitHub logo marks for sign-in buttons, used
 * instead of an icon library's glyphs, which read as empty or inaccurate.
 */
const meta = {
  title: "Primitives/Content/Brand Icons",
  component: GoogleGlyph,
  tags: ["autodocs"],
  argTypes: {},
} satisfies Meta<typeof GoogleGlyph>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The multi-color Google "G" mark.
 */
export const Google: Story = {
  render: () => <GoogleGlyph />,
};

/**
 * The solid GitHub "invertocat" mark. Inherits `currentColor`.
 */
export const GitHub: Story = {
  render: () => <GitHubMark />,
};

/**
 * Both marks at a larger size, showing the `width`/`height` override.
 */
export const Sized: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <GoogleGlyph height={32} width={32} />
      <GitHubMark height={32} width={32} />
    </div>
  ),
};
