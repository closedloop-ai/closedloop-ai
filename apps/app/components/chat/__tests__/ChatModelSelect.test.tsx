import { CHAT_MODEL_OPTIONS } from "@repo/app/chat/lib/default-models";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ChatModelSelect } from "../ChatModelSelect";

const flagResult = (flag: string, enabled: boolean) => ({
  key: flag,
  enabled,
  variant: undefined,
  payload: undefined,
});

const mockUseFeatureFlag = vi.fn((flag: string) => flagResult(flag, true));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (flag: string) => mockUseFeatureFlag(flag),
}));

afterEach(() => {
  cleanup();
  mockUseFeatureFlag.mockReset();
  mockUseFeatureFlag.mockImplementation((flag: string) =>
    flagResult(flag, true)
  );
});

describe("ChatModelSelect", () => {
  test("renders nothing when the emergent flag is disabled", () => {
    mockUseFeatureFlag.mockImplementation((flag: string) =>
      flagResult(flag, false)
    );
    const { container } = render(
      <ChatModelSelect onChange={vi.fn()} provider="claude" value={undefined} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("shows the selected model label for the bound provider when enabled", () => {
    render(
      <ChatModelSelect
        onChange={vi.fn()}
        provider="codex"
        value="gpt-5-codex"
      />
    );
    const expected = CHAT_MODEL_OPTIONS.codex.find(
      (o) => o.value === "gpt-5-codex"
    )?.label;
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      expected ?? ""
    );
  });

  test("falls back to the provider default label when no value is selected", () => {
    render(
      <ChatModelSelect onChange={vi.fn()} provider="claude" value={undefined} />
    );
    // Default for claude is the first option (Sonnet 4.5).
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      CHAT_MODEL_OPTIONS.claude[0].label
    );
  });
});
