import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { GitHubConnectAction } from "../../../github/lib/github-connect-action";
import { GITHUB_CONNECT_COPY } from "../../../github/lib/github-connect-copy";
import type { GitHubConnectTarget } from "../../../github/lib/github-connect-target";
import { GatedMetricIndicatorVariant } from "../../../shared/components/gated-metric-indicator";
import { ConnectGitHubIndicator } from "../connect-github-indicator";

const EXPLANATION_RE = /light up this metric/i;
const CONNECT_GITHUB_RE = /connect (?:to )?github/i;
const CONNECT_HREF = "/api/integrations/github";

describe("ConnectGitHubIndicator", () => {
  it("renders the connect explanation with no GitHub/data dependency", () => {
    render(<ConnectGitHubIndicator />);
    expect(screen.getByText(EXPLANATION_RE)).toBeInTheDocument();
  });

  it("renders no CTA button when no connect target is given (informational only)", () => {
    render(<ConnectGitHubIndicator />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("fires the target's handler when the CTA button is clicked", () => {
    const onConnect = vi.fn();
    render(
      <ConnectGitHubIndicator
        connect={{ action: GitHubConnectAction.Connect, onConnect }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: CONNECT_GITHUB_RE }));

    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("renders a native link CTA for an href target", () => {
    renderWithNavigation(
      <ConnectGitHubIndicator
        connect={{ action: GitHubConnectAction.Connect, href: CONNECT_HREF }}
      />
    );

    expect(
      screen.getByRole("link", { name: CONNECT_GITHUB_RE })
    ).toHaveAttribute("href", CONNECT_HREF);
  });

  it("renders no inert link when the target owns a handler (FEA-3280)", () => {
    // A surface that owns a connect action must never render the hard-navigation
    // link too: the desktop href store turns that link into an inert in-app
    // navigation — a dead click. ISS-5958 made the pair unrepresentable, so what
    // is asserted here is the handler-only shape rendering a button and no link.
    const onConnect = vi.fn();
    renderWithNavigation(
      <ConnectGitHubIndicator
        connect={{ action: GitHubConnectAction.Connect, onConnect }}
      />
    );

    expect(
      screen.queryByRole("link", { name: CONNECT_GITHUB_RE })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: CONNECT_GITHUB_RE }));

    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("refuses an href and a handler on the same target at compile time (FEA-3280)", () => {
    const bothShapes = {
      action: GitHubConnectAction.Connect,
      href: CONNECT_HREF,
      onConnect: () => undefined,
    };
    // @ts-expect-error — a connect target carries an href OR a handler, never
    // both. Widen `GitHubConnectTarget` back into two optional fields and this
    // line stops erroring, which fails the typecheck instead of shipping the
    // dead click.
    const target: GitHubConnectTarget = bothShapes;

    expect(target.action).toBe(GitHubConnectAction.Connect);
  });

  it.each(Object.values(GitHubConnectAction))(
    "labels the CTA and explanation from the copy map for %s",
    (action) => {
      const copy = GITHUB_CONNECT_COPY[action];
      render(
        <ConnectGitHubIndicator connect={{ action, onConnect: vi.fn() }} />
      );

      expect(
        screen.getByRole("button", { name: copy.ctaLabel })
      ).toBeInTheDocument();
      expect(screen.getByText(copy.gatedMetricExplanation)).toBeInTheDocument();
    }
  );

  it("defaults to the first-time connect action with no target", () => {
    render(<ConnectGitHubIndicator />);

    expect(
      screen.getByText(
        GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].gatedMetricExplanation
      )
    ).toBeInTheDocument();
  });

  it("keeps compact layout narrow-card friendly", () => {
    const { container, rerender } = render(<ConnectGitHubIndicator />);
    const centered = (container.firstChild as HTMLElement).className;
    expect(centered).toContain("flex-col");
    expect(centered).toContain("items-center");
    expect(centered).toContain("text-center");

    rerender(
      <ConnectGitHubIndicator variant={GatedMetricIndicatorVariant.Card} />
    );
    const card = (container.firstChild as HTMLElement).className;
    expect(card).toContain("items-start");
    // ISS-7866 dropped `text-left` from the card variant along with the
    // explanation sentence: with only a link-styled CTA left in the slot,
    // `items-start` is what pins it left. The distinction this case exists to
    // hold — card is left-aligned, page-shell is centered — is now carried by
    // the centered variant's `text-center` being ABSENT here, which is exactly
    // what the old `text-left` assertion was standing in for.
    expect(card).not.toContain("text-center");
  });

  it("renders the card's inline ask, not the gated-metric sentence (ISS-11476)", () => {
    // BEHAVIOR CHANGE (ISS-11476, decided against the reporter-supplied
    // `web-master` dashboard prototype): the `card` variant is the prototype's
    // inline sentence — "Connect to GitHub" as an underlined foreground link,
    // then the supporting fragment in the muted tone. It supersedes ISS-7866's
    // bare-verb reading of `pre-auth-desktop-onboarding`, which shipped a blue
    // plug-icon chip on three dashboard cards. The `gatedMetricExplanation`
    // sentence still belongs to `centered`/`banner` — asserted by the copy-map
    // case above, which renders the default centered layout.
    const copy = GITHUB_CONNECT_COPY[GitHubConnectAction.Connect];
    const cardLabel = copy.cardCtaLabel ?? copy.ctaLabel;
    const { container } = render(
      <ConnectGitHubIndicator
        connect={{ action: GitHubConnectAction.Connect, onConnect: vi.fn() }}
        variant={GatedMetricIndicatorVariant.Card}
        withSupportingCopy
      />
    );

    expect(screen.getByRole("button", { name: cardLabel })).toBeInTheDocument();
    expect(container.textContent).toBe(
      `${cardLabel} ${copy.cardSupportingCopy}`
    );
    expect(screen.queryByText(copy.gatedMetricExplanation)).toBeNull();
    // The plug glyph the wrapper supplies is for the other two placements only.
    expect(container.querySelector("svg")).toBeNull();
  });

  it("keeps the dashboard's supporting sentence off a card that did not ask for it", () => {
    // The counterfactual for the case above: ISS-11476's acceptance criteria
    // scope that sentence to the dashboard metric cards, and it names a
    // session-linked population the Insights grid's cloud KPI tiles do not have
    // (Codex review on #8169). Opting in is what draws it; the default is the
    // link alone.
    const copy = GITHUB_CONNECT_COPY[GitHubConnectAction.Connect];
    const { container } = render(
      <ConnectGitHubIndicator
        connect={{ action: GitHubConnectAction.Connect, onConnect: vi.fn() }}
        variant={GatedMetricIndicatorVariant.Card}
      />
    );

    expect(container.textContent).toBe(copy.cardCtaLabel ?? copy.ctaLabel);
  });

  it("words a card's ask for the action it performs", () => {
    // Same per-action discipline the copy-map case holds for the other
    // placements: a repair asks to reconnect, never to connect — and it does so
    // in the APPROVED verb, because the ISS-11476 prototype never drew a repair
    // card for anyone to copy a wording from.
    const copy = GITHUB_CONNECT_COPY[GitHubConnectAction.Reconnect];
    const { container } = render(
      <ConnectGitHubIndicator
        connect={{
          action: GitHubConnectAction.Reconnect,
          onConnect: vi.fn(),
        }}
        variant={GatedMetricIndicatorVariant.Card}
        withSupportingCopy
      />
    );

    expect(
      screen.getByRole("button", { name: copy.ctaLabel })
    ).toBeInTheDocument();
    // Opted in and STILL no sentence: the entry supplies none, so there is
    // nothing for the opt-in to draw.
    expect(container.textContent).toBe(copy.ctaLabel);
  });

  it("degrades a card with no connect target to the explanation and no control", () => {
    // The one path on which the card variant still speaks a sentence: a surface
    // owning neither a handler nor an href. A card that cannot offer the fix
    // still has to say why it is dark rather than render an empty slot — an ask
    // with no way to act on it is what the web dashboard shipped before
    // ISS-7866, and an empty slot is what replacing it with silence would ship.
    render(
      <ConnectGitHubIndicator variant={GatedMetricIndicatorVariant.Card} />
    );

    expect(
      screen.getByText(
        GITHUB_CONNECT_COPY[GitHubConnectAction.Connect].gatedMetricExplanation
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps the explanation on a placement with no label beside it", () => {
    // The ISS-7866 REVIEW's finding, pinned. `card` and the standalone
    // placements were one name, so narrowing the card to a bare verb silently
    // emptied the strips that render this alone with nothing beside it —
    // leaving a control with nothing saying what it unlocks. A card sits beside
    // a `MetricCard` label and can afford the verb alone; a standalone
    // placement cannot, and this fails if the two are ever collapsed again.
    // ISS-11274 retired the `notice` spelling of that placement along with the
    // Branches asks that were its only hosts; `centered` (the stalled-load
    // slot, the Insights tile body) is the live one and carries the contract.
    const copy = GITHUB_CONNECT_COPY[GitHubConnectAction.Connect];
    render(
      <ConnectGitHubIndicator
        connect={{ action: GitHubConnectAction.Connect, onConnect: vi.fn() }}
        variant={GatedMetricIndicatorVariant.Centered}
      />
    );

    expect(screen.getByText(copy.gatedMetricExplanation)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: copy.ctaLabel })
    ).toBeInTheDocument();
  });
});

function renderWithNavigation(children: ReactNode) {
  const memory = createMemoryNavigation();
  return render(
    <NavigationProvider adapter={memory.adapter}>{children}</NavigationProvider>
  );
}
