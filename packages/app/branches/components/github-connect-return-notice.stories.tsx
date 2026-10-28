import { GitHubConnectReturnStatus } from "@repo/api/src/types/github-status";
import type { Meta, StoryObj } from "@storybook/react";
import {
  GitHubConnectReturnNotice,
  GitHubConnectReturnVariant,
} from "./github-connect-return-notice";

/**
 * Post-OAuth banner shared by the web Branches list
 * (`apps/app/.../branches/page.tsx`, `List` chrome — the default `Alert`
 * card) and the branch detail page
 * (`apps/app/.../branches/[branchId]/page.tsx`, `Detail` chrome — a
 * full-width bottom-border banner). The copy is identical across chrome
 * variants; only the surrounding card/banner treatment changes.
 */
const meta = {
  title: "Composites v1.0/Branches/GitHub Connect Return Notice",
  component: GitHubConnectReturnNotice,
  tags: ["deprecated", "autodocs"],
} satisfies Meta<typeof GitHubConnectReturnNotice>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The list surface's rounded inline card, on a successful reconnect. */
export const Connected: Story = {
  args: {
    status: GitHubConnectReturnStatus.Connected,
    variant: GitHubConnectReturnVariant.List,
  },
};

/** The branch detail page's full-width bottom-border banner, on a failed connect. */
export const ErrorInDetail: Story = {
  args: {
    status: GitHubConnectReturnStatus.Error,
    variant: GitHubConnectReturnVariant.Detail,
  },
};
