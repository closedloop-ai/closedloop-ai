import { render, screen } from "@testing-library/react";
import { GitBranchIcon } from "lucide-react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Stub the surface-agnostic navigation Link as a plain anchor so it mounts
// without a NavigationProvider ancestor while preserving link semantics.
vi.mock("@repo/navigation/link", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import {
  GatedMetricIndicator,
  GatedMetricIndicatorVariant,
} from "../gated-metric-indicator";

const EXPLANATION = "Connect GitHub to see this metric";
const CTA_LABEL = "Connect to GitHub";
const SUPPORTING_COPY = "to see sessions tied to PRs.";
const HREF = "/settings/integrations/github";
const WHITESPACE = /\s+/;

describe("GatedMetricIndicator", () => {
  describe("card variant", () => {
    it("falls back to the explanation text when no action or href is given", () => {
      render(
        <GatedMetricIndicator
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          variant={GatedMetricIndicatorVariant.Card}
        />
      );

      expect(screen.getByText(EXPLANATION)).toBeInTheDocument();
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("renders the supporting sentence inline after the CTA (ISS-11476)", () => {
      const { container } = render(
        <GatedMetricIndicator
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          onAction={vi.fn()}
          supportingCopy={SUPPORTING_COPY}
          variant={GatedMetricIndicatorVariant.Card}
        />
      );

      // One sentence, CTA first: the prototype's treatment is a link inside
      // running copy, not a control above a caption.
      expect(container.textContent).toBe(`${CTA_LABEL} ${SUPPORTING_COPY}`);
      // No icon in the card placement — the plug glyph is what ISS-11476's
      // reporter saw beside the blue verb.
      expect(container.querySelector("svg")).toBeNull();
      const cta = screen.getByRole("button", { name: CTA_LABEL });
      // TOKENS, not a substring: `linkForeground` already carries
      // `underline-offset-4` and `hover:underline`, so a `toContain("underline")`
      // stays green with the always-drawn underline deleted — and that underline
      // is the only thing marking these words as a control (tamsinb review on
      // #8169). The offset is the prototype's own.
      const ctaClasses = cta.className.split(WHITESPACE);
      expect(ctaClasses).toContain("underline");
      expect(ctaClasses).toContain("underline-offset-2");
      expect(ctaClasses).not.toContain("text-primary");
    });

    it("omits the supporting sentence when the surface owns no control", () => {
      // With no control the slot already speaks a whole sentence, and the
      // supporting fragment is written to COMPLETE a link — appending it would
      // run two sentences together.
      render(
        <GatedMetricIndicator
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          supportingCopy={SUPPORTING_COPY}
          variant={GatedMetricIndicatorVariant.Card}
        />
      );

      expect(screen.getByText(EXPLANATION)).toBeInTheDocument();
      expect(screen.queryByText(SUPPORTING_COPY)).toBeNull();
    });

    it("renders a link-styled button that fires onAction when provided", () => {
      const onAction = vi.fn();
      render(
        <GatedMetricIndicator
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          onAction={onAction}
          variant={GatedMetricIndicatorVariant.Card}
        />
      );

      const button = screen.getByRole("button", { name: CTA_LABEL });
      button.click();

      expect(onAction).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("renders a hard-navigation Link when only actionHref is given", () => {
      render(
        <GatedMetricIndicator
          actionHref={HREF}
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          variant={GatedMetricIndicatorVariant.Card}
        />
      );

      const link = screen.getByRole("link", { name: CTA_LABEL });
      expect(link).toHaveAttribute("href", HREF);
    });

    it("prefers onAction over actionHref when both are given", () => {
      const onAction = vi.fn();
      render(
        <GatedMetricIndicator
          actionHref={HREF}
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          onAction={onAction}
          variant={GatedMetricIndicatorVariant.Card}
        />
      );

      expect(
        screen.getByRole("button", { name: CTA_LABEL })
      ).toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("renders the retry error with an alert role beside the CTA", () => {
      render(
        <GatedMetricIndicator
          actionHref={HREF}
          ctaLabel={CTA_LABEL}
          error="Sign-in failed. Try again."
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          variant={GatedMetricIndicatorVariant.Card}
        />
      );

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent("Sign-in failed. Try again.");
    });

    it("renders no error alert when error is not set", () => {
      render(
        <GatedMetricIndicator
          actionHref={HREF}
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          variant={GatedMetricIndicatorVariant.Card}
        />
      );

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  });

  describe("centered variant (the default)", () => {
    it("renders the icon, explanation, and an onAction button together", () => {
      const onAction = vi.fn();
      render(
        <GatedMetricIndicator
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          onAction={onAction}
          variant={GatedMetricIndicatorVariant.Centered}
        />
      );

      expect(screen.getByText(EXPLANATION)).toBeInTheDocument();
      const button = screen.getByRole("button", { name: CTA_LABEL });
      button.click();
      expect(onAction).toHaveBeenCalledTimes(1);
    });

    it("renders a Link CTA when only actionHref is given", () => {
      render(
        <GatedMetricIndicator
          actionHref={HREF}
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          variant={GatedMetricIndicatorVariant.Centered}
        />
      );

      expect(screen.getByRole("link", { name: CTA_LABEL })).toHaveAttribute(
        "href",
        HREF
      );
    });

    it("renders neither a button nor a link when no action is supplied", () => {
      render(
        <GatedMetricIndicator
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          variant={GatedMetricIndicatorVariant.Centered}
        />
      );

      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("renders the destructive error span with an alert role", () => {
      render(
        <GatedMetricIndicator
          ctaLabel={CTA_LABEL}
          error="Could not connect."
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          onAction={vi.fn()}
          variant={GatedMetricIndicatorVariant.Centered}
        />
      );

      expect(screen.getByRole("alert")).toHaveTextContent("Could not connect.");
    });
  });

  describe("centered variant, no variant prop", () => {
    it("renders the icon, explanation, and CTA with no variant prop given", () => {
      render(
        <GatedMetricIndicator
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          onAction={vi.fn()}
        />
      );

      expect(screen.getByText(EXPLANATION)).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: CTA_LABEL })
      ).toBeInTheDocument();
    });
  });

  describe("banner variant", () => {
    it("renders the explanation and CTA inside one alert region", () => {
      const onAction = vi.fn();
      render(
        <GatedMetricIndicator
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          onAction={onAction}
          variant={GatedMetricIndicatorVariant.Banner}
        />
      );

      const alert = screen.getByRole("alert");
      expect(alert).toHaveTextContent(EXPLANATION);
      expect(
        screen.getByRole("button", { name: CTA_LABEL })
      ).toBeInTheDocument();
      expect(alert).not.toHaveClass("border-destructive/30");
    });

    it("renders a Link CTA when only actionHref is given", () => {
      render(
        <GatedMetricIndicator
          actionHref={HREF}
          ctaLabel={CTA_LABEL}
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          variant={GatedMetricIndicatorVariant.Banner}
        />
      );

      expect(screen.getByRole("link", { name: CTA_LABEL })).toHaveAttribute(
        "href",
        HREF
      );
    });

    it("flips to the error tone and renders the failure copy without a nested alert role", () => {
      render(
        <GatedMetricIndicator
          ctaLabel={CTA_LABEL}
          error="Retry failed."
          explanation={EXPLANATION}
          icon={GitBranchIcon}
          onAction={vi.fn()}
          variant={GatedMetricIndicatorVariant.Banner}
        />
      );

      // Exactly one alert role — the surrounding Alert already owns it, so the
      // banner error copy must not add a second one.
      const alerts = screen.getAllByRole("alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toHaveTextContent("Retry failed.");
      expect(alerts[0]).toHaveClass("border-destructive/30");
    });
  });
});
