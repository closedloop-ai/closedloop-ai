import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_API_KEY_CARD_ANCHOR } from "../../settings-tabs";
import { AnthropicApiKeyCard } from "../anthropic-api-key-card";

const mockUseClaudeApiKeyInfo = vi.hoisted(() => vi.fn());

vi.mock("@repo/app/api-keys/hooks/use-claude-api-keys", () => ({
  useClaudeApiKeyInfo: () => mockUseClaudeApiKeyInfo(),
  useRemoveOrgClaudeApiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRemoveUserClaudeApiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetOrgClaudeApiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSetUserClaudeApiKey: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

const KEY_INFO = {
  org: { isSet: false, lastFour: null, setAt: null },
  user: { isSet: false, lastFour: null, setAt: null },
};

describe("AnthropicApiKeyCard deep-link anchor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseClaudeApiKeyInfo.mockReturnValue({
      data: KEY_INFO,
      isLoading: false,
    });
  });

  it("carries the anchor id the Cloud-block toast links to", () => {
    // The toast action navigates to `?tab=integrations#anthropic-api-key`.
    // Without this id on the card itself, that fragment resolves to nothing and
    // the user lands at the top of the six-card Integrations stack.
    render(<AnthropicApiKeyCard isAdmin />);

    const card = screen.getByText("Anthropic API Key").closest("[id]");
    expect(card?.id).toBe(ANTHROPIC_API_KEY_CARD_ANCHOR);
    // Programmatically focusable, so the page can move focus with the viewport
    // rather than scrolling the pixels and stranding keyboard users at the top.
    expect(card?.getAttribute("tabindex")).toBe("-1");
  });

  it("keeps the anchor addressable while the key lookup is still loading", () => {
    // A cold deep link arrives before the key query settles, so the anchor must
    // exist in the loading render too or the scroll silently no-ops.
    mockUseClaudeApiKeyInfo.mockReturnValue({
      data: undefined,
      isLoading: true,
    });

    render(<AnthropicApiKeyCard isAdmin />);

    const card = screen.getByText("Anthropic API Key").closest("[id]");
    expect(card?.id).toBe(ANTHROPIC_API_KEY_CARD_ANCHOR);
  });
});
