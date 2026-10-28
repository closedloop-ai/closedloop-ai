import { PersonAvatar } from "@closedloop-ai/design-system/components/ui/person-avatar";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FailedImage,
  LoadedImage,
  PERSON_AVATAR_TEST_URL,
} from "./support/avatar-images";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PersonAvatar", () => {
  it("shows the photo when its image loads", () => {
    vi.stubGlobal("Image", LoadedImage);
    render(
      <PersonAvatar avatarUrl={PERSON_AVATAR_TEST_URL} name="Avery Carter" />
    );

    expect(
      document.querySelector('img[data-slot="avatar-image"]')
    ).toHaveAttribute("src", PERSON_AVATAR_TEST_URL);
    expect(screen.queryByText("A")).not.toBeInTheDocument();
  });

  it("shows initials with no photo URL", () => {
    render(<PersonAvatar name="Avery Carter" />);

    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("shows initials when the image reports a load failure", async () => {
    FailedImage.errorsDispatched = 0;
    vi.stubGlobal("Image", FailedImage);
    render(
      <PersonAvatar avatarUrl={PERSON_AVATAR_TEST_URL} name="Avery Carter" />
    );

    await waitFor(() => {
      expect(FailedImage.errorsDispatched).toBeGreaterThan(0);
      expect(screen.getByText("A")).toBeInTheDocument();
      expect(
        document.querySelector('img[data-slot="avatar-image"]')
      ).toBeNull();
    });
  });

  it("restores initials when a loaded photo disappears on rerender", () => {
    vi.stubGlobal("Image", LoadedImage);
    const { rerender } = render(
      <PersonAvatar avatarUrl={PERSON_AVATAR_TEST_URL} name="Avery Carter" />
    );
    expect(screen.queryByText("A")).not.toBeInTheDocument();

    act(() => {
      rerender(<PersonAvatar name="Avery Carter" />);
    });

    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("names itself only when requested and can be decorative beside a name", () => {
    const { rerender } = render(
      <PersonAvatar ariaLabel="Avery Carter" name="Avery Carter" role="img" />
    );
    expect(screen.getByRole("img", { name: "Avery Carter" })).toBeVisible();

    rerender(<PersonAvatar decorative name="Avery Carter" />);
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      screen.getByText("A").closest("[aria-hidden='true']")
    ).not.toBeNull();
  });
});
