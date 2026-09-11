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
 * Two logo components, a multi-color Google "G" and a solid GitHub mark, for
 * anywhere a sign-in button needs a recognizable brand icon. Reach for these
 * instead of an icon library's glyph when you need the official look: the
 * common icon library's GitHub icon is a hollow outline that reads as empty
 * on a filled button, and it has no accurate Google logo at all. Each one
 * defaults to 16 pixels and accepts the usual width, height or className
 * props to resize, so there is no separate small or large version to pick
 * between.
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
