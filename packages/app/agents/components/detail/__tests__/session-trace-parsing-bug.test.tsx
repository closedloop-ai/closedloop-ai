import { TraceCommentKind } from "@repo/api/src/types/comment";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { ParsingBugFlagProvider } from "../../../data-source/parsing-bug-flag-provider";
import { SessionTrace } from "../session-trace";
import type { TraceCommentDraft } from "../trace-comments";
import {
  COMMENT_BUTTON_NAME_RE,
  sayItem,
  selectRenderedText,
} from "./session-trace-test-helpers";

// FEA-4171: the trace composer carries an optional parsing/data-bug flag that
// feeds the golden-dataset CANDIDATE pipeline. The inline composer renders the
// org-member @-mention picker, so stub `useOrganizationUsers` like the sibling
// SessionTrace suite does.
// FEA-4347: the flag is staff-only — `ParsingBugFlagProvider` injects the
// per-surface staff signal, defaulting to hidden when no provider is mounted.
const mockUseOrganizationUsers = vi.fn();
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: (options?: { enabled?: boolean }) =>
    mockUseOrganizationUsers(options),
}));

const PARSING_BUG_CHECKBOX_NAME_RE = /flag as parsing\/data bug/i;

beforeEach(() => {
  mockUseOrganizationUsers.mockReturnValue({ data: [] });
});

afterEach(() => {
  cleanup();
});

// Renders SessionTrace, opening the composer on a selected passage. `canFlag`
// controls the injected staff signal; `undefined` mounts NO provider so the
// context default (customer / un-updated caller) applies.
async function openComposer(
  onSubmitTraceComment: Mock<(draft: TraceCommentDraft) => void>,
  canFlag: boolean | undefined
): Promise<{ user: ReturnType<typeof userEvent.setup> }> {
  const user = userEvent.setup();
  const trace = (
    <SessionTrace
      items={[sayItem(3, "Select this exact passage for review.")]}
      onSubmitTraceComment={onSubmitTraceComment}
    />
  );
  const tree: ReactNode =
    canFlag === undefined ? (
      trace
    ) : (
      <ParsingBugFlagProvider canFlagParsingBug={canFlag}>
        {trace}
      </ParsingBugFlagProvider>
    );
  const { container } = render(tree);

  selectRenderedText(container, "exact passage");
  fireEvent.mouseUp(container.querySelector(".st") as HTMLElement);
  await user.click(
    screen.getByRole("button", { name: COMMENT_BUTTON_NAME_RE })
  );
  return { user };
}

describe("SessionTrace parsing-bug flag (FEA-4171 / FEA-4347 staff gate)", () => {
  it("shows the flag to staff and classifies the draft when checked", async () => {
    const onSubmitTraceComment = vi.fn<(draft: TraceCommentDraft) => void>();
    const { user } = await openComposer(onSubmitTraceComment, true);

    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "Collector emitted raw text; expected parsed JSON."
    );
    await user.click(
      screen.getByRole("checkbox", { name: PARSING_BUG_CHECKBOX_NAME_RE })
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmitTraceComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Collector emitted raw text; expected parsed JSON.",
        kind: TraceCommentKind.ParsingBug,
      })
    );
  });

  it("omits the parsing-bug kind for staff when the checkbox is left unchecked", async () => {
    const onSubmitTraceComment = vi.fn<(draft: TraceCommentDraft) => void>();
    const { user } = await openComposer(onSubmitTraceComment, true);

    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "Just a normal note."
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmitTraceComment).toHaveBeenCalledTimes(1);
    expect(onSubmitTraceComment.mock.calls[0]?.[0]).not.toHaveProperty("kind");
  });

  it("hides the flag from non-staff and never classifies their comment", async () => {
    const onSubmitTraceComment = vi.fn<(draft: TraceCommentDraft) => void>();
    const { user } = await openComposer(onSubmitTraceComment, false);

    expect(
      screen.queryByRole("checkbox", { name: PARSING_BUG_CHECKBOX_NAME_RE })
    ).toBeNull();

    await user.type(
      screen.getByPlaceholderText("Comment on this passage..."),
      "A customer comment."
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmitTraceComment).toHaveBeenCalledTimes(1);
    expect(onSubmitTraceComment.mock.calls[0]?.[0]).not.toHaveProperty("kind");
  });

  it("hides the flag by default when no provider is mounted (fail-safe)", async () => {
    const onSubmitTraceComment = vi.fn<(draft: TraceCommentDraft) => void>();
    await openComposer(onSubmitTraceComment, undefined);

    expect(
      screen.queryByRole("checkbox", { name: PARSING_BUG_CHECKBOX_NAME_RE })
    ).toBeNull();
  });
});
