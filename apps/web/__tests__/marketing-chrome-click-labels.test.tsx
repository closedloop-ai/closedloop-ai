// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  OnboardingAnalyticsEvent as Event,
  OnboardingAnalyticsProperty as Property,
} from "@repo/api/src/types/onboarding-analytics";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from "@repo/design-system/components/ui/sheet";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Menu } from "lucide-react";
import { type AnchorHTMLAttributes, type ComponentType, useState } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import ts from "typescript6";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_REPO_URL } from "@/app/[locale]/(site)/components/home/constants";
import { ClosedloopLogo } from "@/app/[locale]/components/closedloop-logo";
import { MobileNav } from "@/app/[locale]/components/site-header-mobile";
import { GitHubLogo } from "@/components/github-logo";
import { MarketingSurfaceAnalyticsProvider } from "@/components/marketing-surface-analytics-adapter";
import { localize } from "@/lib/site";

const state = vi.hoisted(() => ({ capture: vi.fn() }));

vi.mock("@repo/analytics/client", () => ({
  useAnalytics: () => state,
  useFeatureFlag: () => undefined,
}));

const COMPONENTS = path.resolve(
  import.meta.dirname,
  "../app/[locale]/components"
);
const MODULES: Record<string, unknown> = {
  "react/jsx-runtime": { Fragment, jsx, jsxs },
  "next/link": { __esModule: true, default: AnchorLink },
  "@/app/[locale]/(site)/components/home/constants": { GITHUB_REPO_URL },
  "@/app/[locale]/components/closedloop-logo": { ClosedloopLogo },
  "@/components/github-logo": { GitHubLogo },
  "@/lib/site": { localize },
  "./site-header-mobile": { MobileNav },
  "@repo/design-system/components/ui/sheet": {
    Sheet,
    SheetContent,
    SheetTitle,
    SheetTrigger,
  },
  "lucide-react": { Menu },
  react: { useState },
};

beforeEach(() => {
  document.addEventListener("click", cancelNavigation);
});

afterEach(() => {
  document.removeEventListener("click", cancelNavigation);
  cleanup();
  state.capture.mockReset();
});

describe("marketing chrome click labels after the build loader (ISS-12557)", () => {
  it.each([
    ["site-header.tsx", "SiteHeader", "Documentation"],
    ["site-header.tsx", "SiteHeader", "Resources"],
    ["site-footer.tsx", "SiteFooter", "Pricing"],
    ["site-footer.tsx", "SiteFooter", "Privacy Policy"],
  ])("%s (%s) emits the real %s label", async (file, name, label) => {
    const Chrome = await transformedComponent<{ locale: string }>(file, name);
    render(
      <MarketingSurfaceAnalyticsProvider>
        <Chrome locale="en" />
      </MarketingSurfaceAnalyticsProvider>
    );

    fireEvent.click(screen.getAllByRole("link", { name: label })[0]);

    expect(buttonNames()).toEqual([label]);
  });

  it("emits the real mobile nav link label", async () => {
    const MobileNav = await transformedComponent<{
      docsHref: string;
      githubUrl: string;
      resourcesHref: string;
    }>("site-header-mobile.tsx", "MobileNav");
    render(
      <MarketingSurfaceAnalyticsProvider>
        <MobileNav
          docsHref="/docs"
          githubUrl="https://github.test/closedloop-ai"
          resourcesHref="/resources"
        />
      </MarketingSurfaceAnalyticsProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("link", { name: "Resources" }));

    expect(buttonNames()).toEqual(["Open menu", "Resources"]);
  });
});

async function transformedComponent<Props extends object>(
  file: string,
  name: string
): Promise<ComponentType<Props>> {
  const code = await transformWithBuildLoader(path.join(COMPONENTS, file));
  const compiled = ts.transpileModule(code, {
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const exports: Record<string, ComponentType<Props>> = {};
  const load = (specifier: string) => {
    if (!(specifier in MODULES)) {
      throw new Error(`no module stub for ${specifier}`);
    }
    return MODULES[specifier];
  };
  new Function("exports", "require", compiled)(exports, load);
  const component = exports[name];
  if (!component) {
    throw new Error(`${file} did not export ${name}`);
  }
  return component;
}

type LoaderContext = {
  async: () => (error: Error | null, code?: string) => void;
  resourcePath: string;
  getOptions: () => Record<string, never>;
  addDependency: (dependency: string) => void;
};

// The production Next loader, run natively: under jsdom, Vite-served module
// URLs are not `file:` URLs, so the transform cannot be imported through Vite.
function transformWithBuildLoader(source: string): Promise<string> {
  const loader = createRequire(path.join(process.cwd(), "package.json"))(
    "../../scripts/analytics/trusted-label-loader.cjs"
  ) as (this: LoaderContext, code: string) => void;
  return new Promise((resolve, reject) => {
    loader.call(
      {
        async: () => (error, code) =>
          error ? reject(error) : resolve(code ?? ""),
        resourcePath: source,
        getOptions: () => ({}),
        addDependency: () => undefined,
      },
      readFileSync(source, "utf8")
    );
  });
}

function AnchorLink(props: AnchorHTMLAttributes<HTMLAnchorElement>) {
  return <a {...props} />;
}

// jsdom cannot navigate; cancel after the tracker's capture-phase listener ran.
function cancelNavigation(event: MouseEvent) {
  event.preventDefault();
}

function buttonNames() {
  return state.capture.mock.calls
    .filter(([event]) => event === Event.ButtonClicked)
    .map(([, properties]) => properties[Property.ButtonName]);
}
