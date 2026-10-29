// @vitest-environment jsdom

import type { TablePerson } from "@repo/design-system/components/ui/table-cell-primitives";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditableOwnerTableCell } from "../editable-cells";
import { openRadixMenu } from "../preview/components/__tests__/support/radix-menu";

// Loaded INSIDE the factory: `vi.mock` hoists above every import, so a static
// binding to the helper is still uninitialised when the factory runs.
vi.mock("@repo/design-system/components/ui/avatar", async (importOriginal) => {
  const { avatarImageMockModule } = await import(
    "@repo/app/test/mocks/avatar-image"
  );
  return avatarImageMockModule(importOriginal);
});

/**
 * ISS-12341: the owner picker's OPTION rows show each person's picture, as its
 * own trigger already does.
 *
 * `TablePersonCell` — the trigger of this very dropdown — has rendered
 * `PersonAvatar` from `person.avatarUrl` all along, while the option rows below
 * it hand-rolled an initials-only `Avatar` from the same `TablePerson`. So this
 * is a contract the component states twice and used to answer two ways.
 *
 * Scope, stated rather than implied: every production caller today passes the
 * `artifactPeople` fixture, which carries `initials` and no `avatarUrl`, so
 * nothing on screen changes until a real producer supplies one. These cases
 * therefore pin the COMPONENT's contract — given a photo, it draws it — which
 * is the half that was wrong. Radix gates `AvatarImage` on a real load and
 * jsdom loads none, so the shared `avatarImageMockModule` stands in; it
 * forwards only `alt` and `src`.
 */
const OWNER_PHOTO = "https://img.example.test/sam.png";

describe("Owner picker option rows render photos (ISS-12341)", () => {
  it("draws the photo an option carries", () => {
    openPicker([withPhoto, withoutPhoto]);

    expect(photoInOption(withPhoto.name)).toBe(OWNER_PHOTO);
  });

  it("draws no photo for an option that carries none", () => {
    // Beside the case above, and in the SAME menu, so neither can pass by the
    // menu failing to open.
    openPicker([withPhoto, withoutPhoto]);

    expect(photoInOption(withoutPhoto.name)).toBeNull();
  });
});

const withPhoto: TablePerson = {
  avatarUrl: OWNER_PHOTO,
  initials: "SC",
  name: "Sam Chen",
};
const withoutPhoto: TablePerson = { initials: "AE", name: "Ottilie Eastwick" };

function openPicker(options: readonly TablePerson[]) {
  render(
    <EditableOwnerTableCell
      onChange={() => undefined}
      options={options}
      owner={null}
    />
  );
  openRadixMenu(
    screen.getByRole("button", { name: "Edit owner, currently empty" })
  );
}

/** The `src` one option row drew, or null when it drew initials instead. */
function photoInOption(name: string): string | null {
  const option = screen
    .getAllByRole("menuitemradio")
    .find((row) => within(row).queryByText(name) !== null);
  if (!option) {
    throw new Error(`Expected an option row for ${name}`);
  }
  return option.querySelector("img")?.getAttribute("src") ?? null;
}
