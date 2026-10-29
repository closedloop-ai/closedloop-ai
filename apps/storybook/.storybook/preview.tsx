import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { Toaster } from "@repo/design-system/components/ui/sonner";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { ThemeProvider } from "@repo/design-system/providers/theme";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { withThemeByClassName } from "@storybook/addon-themes";
import type { Preview } from "@storybook/react";

// Wraps the design-system globals and adds the desktop-renderer source scan, so
// desktop stories render with real CSS. See the file for why that scan cannot
// live in globals.css itself, which four non-desktop surfaces also import.
import "@repo/design-system/styles/storybook.css";
// Repaints the Docs page chrome when the toolbar is on dark, so a component
// stops being previewed on a white card in a dark theme. Inert in light mode.
import "@repo/design-system/styles/storybook-docs-dark.css";
import "../../../packages/app/styles.css";

// Single in-memory navigation port for all stories: design-system and
// app-core components render the port `Link` / `usePath`, so the preview
// must mount an adapter the same way the web and desktop shells do. It is
// handed to the app-core harness below rather than mounted separately, so
// every story resolves paths through exactly one adapter.
const memoryNavigation = createMemoryNavigation();

/**
 * Per-story configuration for the global app-core harness, declared the same
 * way `play` is — on the story, not as a wrapper around it:
 *
 *   export const Loaded: Story = {
 *     parameters: {
 *       appCore: {
 *         queryData: [[sessionKeys.detail(id), fixture]],
 *         enabledFlags: ["sessions-v2"],
 *       },
 *     },
 *   };
 *
 * Every story gets a QueryClient, auth, feature-flag, and API port for free, so
 * a component that calls `useQuery` renders without per-story boilerplate and
 * cannot fail simply because an author forgot to wrap it (ISS-5665).
 */
type AppCoreStoryParameters = Pick<
  Parameters<typeof AppCoreStoryProviders>[0],
  "queryData" | "apiRoutes" | "enabledFlags"
>;

/**
 * Opts a story out of the theme pinning the decorator below applies, declared
 * the same way `appCore` is:
 *
 *   export default {
 *     parameters: { themeInteractive: true },
 *   };
 *
 * Every other story is pinned to the toolbar's theme so the class and
 * `color-scheme` cannot disagree. That pin makes `setTheme` a no-op, which is
 * fine everywhere except the two stories whose subject IS switching the theme:
 * Mode Toggle and Theme Submenu. They set this, and give up matching the
 * toolbar in exchange for their control actually doing something.
 *
 * Reach for it only when a story demonstrates theme switching itself. It is not
 * an escape hatch for a story that merely looks wrong in one theme.
 */
type ThemeStoryParameters = { themeInteractive?: boolean };

const preview: Preview = {
  parameters: {
    options: {
      storySort: {
        // The levels (Foundations/Primitives/Composites/Surfaces), plus the
        // "Start Here" exception that documents the system rather than being
        // part of it. Every v2.0 root (Foundations, Primitives, Composites,
        // Patterns and Surfaces) sorts above every v1.0 root, each half
        // in level order. Composites and Patterns follow the v2.0
        // page tree (Shared, then the Surfaces tree). See TAXONOMY.md — this replaces the old three-root
        // Design System / App Core / Catalog scheme (PLN-2024 Phase B), which
        // told you which package a story's code lived in and nothing about
        // what it was.
        //
        // This must be a literal, not a call to `buildStorySortOrder()`
        // (../story-group-order.ts) the way the Start Here/Catalog page reads
        // it: Storybook's story-index build step statically parses this
        // file's AST to extract `storySort.order` without executing it, and
        // errors on any node type it doesn't recognize, including a
        // CallExpression ("Unknown node type CallExpression", failing both
        // `writeIndexJson` and `writeManifests`). `story-group-order.ts`
        // remains the one real declaration of the group shape (levels,
        // subgroups, and the two rank functions the Catalog page's own sort
        // uses) — this array is its `buildStorySortOrder()` output, inlined
        // because this one consumer can't call the function that produces
        // it. Regenerate with:
        //   node --input-type=module -e "import {buildStorySortOrder} from './apps/storybook/story-group-order.ts'; console.log(JSON.stringify(buildStorySortOrder()))"
        // whenever story-group-order.ts's group shape changes.
        order: [
          "Start Here",
          ["Introduction", "Catalog", "Version History"],
          "Foundations",
          ["Colors", "Typography", "Spacing", "Radius & Elevation", "Motion"],
          "Primitives",
          [
            "Actions",
            "Inputs",
            "Data Display",
            ["Tables"],
            "Charts",
            "Content",
            "Layout",
            "Navigation",
            "Overlays",
            "Feedback & Status",
          ],
          "Composites",
          [
            "Overview",
            "Shared",
            [
              "Artifact List",
              "Navigation",
              "Artifact Detail",
              "Activity",
              "Data Sync",
              "Data Controls",
              "Prototype Tools",
            ],
            "Dashboard",
            "Artifacts",
            [
              "Sessions",
              ["Sessions List", "Session Detail"],
              "Branches",
              ["Branches List", "Branch Detail"],
            ],
            "Labs",
            [
              "Search",
              "Inbox",
              "My Tasks",
              "Documents",
              ["Documents List", "Document Detail"],
              "Issues",
              ["Issues List", "Issue Detail"],
              "Agents",
              ["Agents List", "Agent Detail"],
              "Insights",
              "Lost work",
              "TokenOps waste",
              "Packs",
              ["Packs List", "Pack Detail"],
            ],
            "Your Teams",
            ["Projects List", "Project Detail", "Archived Projects"],
            "Workspace Menu",
            [
              "Settings",
              [
                "Profile",
                "Connected Devices",
                "Plugins",
                "General",
                "Members",
                "Custom Fields",
                "Tags",
                "Compliance",
                "API Keys",
                "Desktop App",
                "Other Labs Settings",
                "Desktop Authorize",
                "Desktop Connect",
              ],
              "Diagnostics",
            ],
            "Other Pages",
            [
              "PRDs",
              ["PRDs List", "PRD Detail"],
              "Implementation Plans",
              ["Plans List", "Plan Detail"],
              "Users",
              ["User Profile"],
              "Help",
            ],
            "Not In The Live App",
            ["Judges", ["Judges", "Judge Detail"]],
            "Desktop Only",
            ["Plans", "Approvals", "Requests"],
            "Sign In",
            [
              "Sign In",
              "Sign Up",
              "SSO Callback",
              "GitHub Connect",
              "GitHub Link",
            ],
            "Onboarding",
            "System States",
            [
              "Page Not Found",
              "Route Error",
              "Page Unavailable",
              "Workspace Access Failed",
              "API Unreachable",
            ],
          ],
          "Patterns",
          [
            "Overview",
            "Shared",
            [
              "Artifact List",
              "Navigation",
              "Artifact Detail",
              "Activity",
              "Data Sync",
              "Data Controls",
              "Prototype Tools",
            ],
            "Dashboard",
            "Artifacts",
            [
              "Sessions",
              ["Sessions List", "Session Detail"],
              "Branches",
              ["Branches List", "Branch Detail"],
            ],
            "Labs",
            [
              "Search",
              "Inbox",
              "My Tasks",
              "Documents",
              ["Documents List", "Document Detail"],
              "Issues",
              ["Issues List", "Issue Detail"],
              "Agents",
              ["Agents List", "Agent Detail"],
              "Insights",
              "Lost work",
              "TokenOps waste",
              "Packs",
              ["Packs List", "Pack Detail"],
            ],
            "Your Teams",
            ["Projects List", "Project Detail", "Archived Projects"],
            "Workspace Menu",
            [
              "Settings",
              [
                "Profile",
                "Connected Devices",
                "Plugins",
                "General",
                "Members",
                "Custom Fields",
                "Tags",
                "Compliance",
                "API Keys",
                "Desktop App",
                "Other Labs Settings",
                "Desktop Authorize",
                "Desktop Connect",
              ],
              "Diagnostics",
            ],
            "Other Pages",
            [
              "PRDs",
              ["PRDs List", "PRD Detail"],
              "Implementation Plans",
              ["Plans List", "Plan Detail"],
              "Users",
              ["User Profile"],
              "Help",
            ],
            "Not In The Live App",
            ["Judges", ["Judges", "Judge Detail"]],
            "Desktop Only",
            ["Plans", "Approvals", "Requests"],
            "Sign In",
            [
              "Sign In",
              "Sign Up",
              "SSO Callback",
              "GitHub Connect",
              "GitHub Link",
            ],
            "Onboarding",
            "System States",
            [
              "Page Not Found",
              "Route Error",
              "Page Unavailable",
              "Workspace Access Failed",
              "API Unreachable",
            ],
          ],
          "Surfaces",
          [
            "Overview",
            "Dashboard",
            "Artifacts",
            [
              "Sessions",
              ["Sessions List", "Session Detail"],
              "Branches",
              ["Branches List", "Branch Detail"],
            ],
            "Labs",
            [
              "Search",
              "Inbox",
              "My Tasks",
              "Documents",
              ["Documents List", "Document Detail"],
              "Issues",
              ["Issues List", "Issue Detail"],
              "Agents",
              ["Agents List", "Agent Detail"],
              "Insights",
              "Lost work",
              "TokenOps waste",
              "Packs",
              ["Packs List", "Pack Detail"],
            ],
            "Your Teams",
            ["Projects List", "Project Detail", "Archived Projects"],
            "Workspace Menu",
            [
              "Settings",
              [
                "Profile",
                "Connected Devices",
                "Plugins",
                "General",
                "Members",
                "Custom Fields",
                "Tags",
                "Compliance",
                "API Keys",
                "Desktop App",
                "Other Labs Settings",
                "Desktop Authorize",
                "Desktop Connect",
              ],
              "Diagnostics",
            ],
            "Other Pages",
            [
              "PRDs",
              ["PRDs List", "PRD Detail"],
              "Implementation Plans",
              ["Plans List", "Plan Detail"],
              "Users",
              ["User Profile"],
              "Help",
            ],
            "Not In The Live App",
            ["Judges", ["Judges", "Judge Detail"]],
            "Desktop Only",
            ["Plans", "Approvals", "Requests"],
            "Sign In",
            [
              "Sign In",
              "Sign Up",
              "SSO Callback",
              "GitHub Connect",
              "GitHub Link",
            ],
            "Onboarding",
            "System States",
            [
              "Page Not Found",
              "Route Error",
              "Page Unavailable",
              "Workspace Access Failed",
              "API Unreachable",
            ],
          ],
          "Foundations v1.0",
          ["Colors", "Typography", "Spacing", "Radius & Elevation", "Motion"],
          "Primitives v1.0",
          [
            "Actions",
            "Inputs",
            "Data Display",
            ["Tables"],
            "Charts",
            "Content",
            "Layout",
            "Navigation",
            "Overlays",
            "Feedback & Status",
          ],
          "Composites v1.0",
          [
            "Actions",
            "Inputs",
            "Data Display",
            ["Tables"],
            "Charts",
            "Content",
            "Layout",
            "Navigation",
            "Overlays",
            "Feedback & Status",
            "Agents",
            ["Detail", "Workspace", "General"],
            "App Shell",
            "Branches",
            "Compute",
            "Custom Fields",
            "Desktop Shell",
            "Diagnostics",
            "Documents",
            "Help",
            "Inbox",
            "Insights",
            "My Tasks",
            "Onboarding",
            "Organizations",
            "Packs",
            "Projects",
            "Search",
            "Session Limits",
            "Sessions",
            "Settings",
            "Tags",
          ],
          "Surfaces v1.0",
          [
            "Sessions",
            "Branches",
            "Agents",
            "Packs",
            "Documents",
            "Projects",
            "PRDs",
            "Implementation Plans",
          ],
        ],
      },
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    chromatic: {
      modes: {
        light: {
          theme: "light",
          className: "light",
        },
        dark: {
          theme: "dark",
          className: "dark",
        },
      },
    },
  },
  decorators: [
    withThemeByClassName({
      themes: {
        light: "light",
        dark: "dark",
      },
      defaultTheme: "light",
    }),
    (Story, context) => {
      const appCore = (context.parameters.appCore ??
        {}) as AppCoreStoryParameters;
      // The toolbar owns the theme here, so next-themes is pinned to whatever
      // it selected rather than left to resolve "system" off the viewer's OS.
      //
      // Unpinned, the two disagree. `withThemeByClassName` above writes the
      // light/dark CLASS from the toolbar, while next-themes writes the inline
      // `color-scheme` on <html> from the OS, and `color-scheme` is what the
      // browser paints native UI from. On a dark-mode machine viewing the
      // light theme that renders a black scrollbar track across every screen,
      // which is not a state the product can reach: in the app next-themes
      // writes both the class and `color-scheme`, so they cannot drift apart.
      const selectedTheme = context.globals.theme === "dark" ? "dark" : "light";
      return (
        <AppCoreStoryProviders
          apiRoutes={appCore.apiRoutes}
          enabledFlags={appCore.enabledFlags}
          navigationAdapter={memoryNavigation.adapter}
          queryData={appCore.queryData}
        >
          <div className="bg-background">
            <ThemeProvider
              forcedTheme={
                (context.parameters as ThemeStoryParameters).themeInteractive
                  ? undefined
                  : selectedTheme
              }
            >
              <TooltipProvider>
                <Story />
              </TooltipProvider>
              <Toaster />
            </ThemeProvider>
          </div>
        </AppCoreStoryProviders>
      );
    },
  ],
  // The port above outlives every story, so a story that writes the URL (the
  // linked `hierarchyExpanded` set, for one) would otherwise hand that query to
  // the next story: FourLevelHierarchy's set overrode PointerPlacement's seeded
  // expansion in the all-stories sweep (ISS-12901).
  beforeEach: () => {
    if (memoryNavigation.getCurrentHref() !== "/") {
      memoryNavigation.replace("/");
    }
  },
};

export default preview;
