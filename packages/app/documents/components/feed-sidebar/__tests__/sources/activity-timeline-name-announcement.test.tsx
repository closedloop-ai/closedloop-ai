/**
 * ISS-12330: on the Activity tab's timeline, a person is announced once.
 *
 * The timeline draws `ActivityActorAvatar` with `kindGlyph` right before the
 * name. A photo-less person's initials used to reach assistive technology as
 * "D R" and then the name; on the timeline the fallback is `aria-hidden`, so
 * only the name is read. The rail card keeps ISS-6174's ruling (initials
 * exposed), and that half is pinned here too so the change cannot leak there.
 *
 * What AT hears is approximated as the row's text with every `aria-hidden`
 * subtree removed. That is the claim this suite can make in jsdom; the photo's
 * `alt=""` is covered by `activity-actor-name-announcement.test.tsx` and its
 * e2e. `AvatarImage` is mocked for the reason that file gives.
 */
import { avatarImageMockModule } from "@repo/app/test/mocks/avatar-image";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/app/shared/components/user-link", () => ({
  UserLink: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@repo/design-system/components/ui/avatar", (importOriginal) =>
  avatarImageMockModule(importOriginal)
);

import {
  ActivityActorAvatar,
  ActivityActorName,
} from "../../sources/activity-actor";
import { resolveActivityActor } from "../../sources/activity-formatting";
import {
  DANA,
  DANA_NAME,
  HUMAN_ACTOR,
  readyDirectory,
} from "./activity-actor-fixtures";

/** One initial on every avatar (Nerys, 2026-10-22), and nothing else. */
const ONLY_D = /^D$/;

const WHITESPACE = /\s+/g;

/** The row's text as assistive technology gets it: aria-hidden removed. */
function announced(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll("[aria-hidden='true']")) {
    hidden.remove();
  }
  return (clone.textContent ?? "").replace(WHITESPACE, " ").trim();
}

function renderRow(kindGlyph: boolean) {
  const actor = resolveActivityActor(HUMAN_ACTOR, readyDirectory(DANA));
  return render(
    <div>
      <ActivityActorAvatar actor={actor} kindGlyph={kindGlyph} />{" "}
      <ActivityActorName actor={actor} />
    </div>
  );
}

describe("Timeline avatar name announcement (ISS-12330)", () => {
  it("hides a photo-less person's initials on the timeline, so the name is read once", () => {
    const { container } = renderRow(true);
    // Vacuity control: the initial is drawn, just not announced. One initial
    // on every avatar (Nerys, 2026-10-22), so it is read off the fallback
    // itself: a bare "D" would also match the name.
    expect(
      container.querySelector('[data-slot="avatar-fallback"]')
    ).toHaveTextContent(ONLY_D);
    expect(announced(container)).toBe(DANA_NAME);
  });

  it("leaves the rail card's initials exposed (ISS-6174 ruling)", () => {
    const { container } = renderRow(false);
    expect(announced(container)).toBe(`D ${DANA_NAME}`);
  });
});
