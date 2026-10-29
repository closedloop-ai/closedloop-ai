import { TEST_USER } from "@repo/app/shared/test-fixtures/documents";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { avatarImageMockModule } from "@repo/app/test/mocks/avatar-image";
import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/design-system/components/ui/avatar", (importOriginal) =>
  avatarImageMockModule(importOriginal)
);

import { AssigneeAvatar } from "@repo/app/shared/components/assignee-avatar";

const CLERK_AVATAR_URL = "https://img.clerk.com/ada-avatar.png";

describe("AssigneeAvatar image wiring", () => {
  it("passes the assigned user's Clerk photo through the shared avatar", () => {
    const { container } = render(
      <AssigneeAvatar
        assignee={{ ...TEST_USER, avatarUrl: CLERK_AVATAR_URL }}
      />
    );

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      CLERK_AVATAR_URL
    );
    expect(screen.getByRole("link", { name: "Ada Lovelace" })).toBeVisible();
  });

  it("opens the assignee tooltip when the unlinked avatar takes focus", async () => {
    const { container } = render(
      <AssigneeAvatar assignee={TEST_USER} disableLink />
    );
    const trigger = container.querySelector('[data-slot="tooltip-trigger"]');
    expect(trigger).not.toBeNull();
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.focusIn(trigger as HTMLElement);

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Ada Lovelace"
    );
  });
});
