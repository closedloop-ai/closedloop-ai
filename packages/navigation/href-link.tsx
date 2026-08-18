"use client";

import type { ComponentType, MouseEvent } from "react";
import type {
  NavigationActions,
  NavigationLinkProps,
} from "./navigation-adapter";

/**
 * Transforms an internal navigation href (the org-relative path the click
 * handler navigates, e.g. `/agents/foo`) into the value rendered on the
 * anchor's `href` attribute. Adapters whose surface can't resolve a bare
 * path through the browser (the desktop renderer has no router: a raw
 * `file:///agents/foo` document nav is blocked by Electron's navigation
 * guard) supply a transform so modifier/middle/right-click — which bypass
 * the click handler and defer to the browser — still land somewhere the
 * surface resolves (desktop: a `#/agents/foo` same-document hash the
 * hash-store adapter adopts). Defaults to identity (web/memory: a real path
 * is already a valid browser navigation).
 */
export type RenderHref = (href: string) => string;

/**
 * Builds the port `Link` component for adapters backed by an href store
 * (memory, desktop). Renders a real anchor — middle-click, Cmd/Ctrl+click,
 * and context-menu behaviors defer to the browser — and routes plain left
 * clicks through the supplied navigation actions.
 *
 * `renderHref` maps the internal navigation path to the anchor's rendered
 * `href` (default identity). The click handler always navigates the internal
 * `href`, so the transform only affects the browser-deferred click paths.
 */
export function createHrefLink(
  actions: Pick<NavigationActions, "navigate" | "replace">,
  renderHref: RenderHref = identityHref
): ComponentType<NavigationLinkProps> {
  const HrefLink = ({
    href,
    prefetch: _prefetch,
    replace: replaceOnClick,
    scroll: _scroll,
    onClick,
    children,
    ...anchorProps
  }: NavigationLinkProps) => {
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      onClick?.(event);
      if (shouldDeferToBrowser(event, anchorProps.target)) {
        return;
      }
      event.preventDefault();
      if (replaceOnClick) {
        actions.replace(href);
        return;
      }
      actions.navigate(href);
    };
    return (
      <a href={renderHref(href)} onClick={handleClick} {...anchorProps}>
        {children}
      </a>
    );
  };
  return HrefLink;
}

function shouldDeferToBrowser(
  event: MouseEvent<HTMLAnchorElement>,
  target: string | undefined
): boolean {
  const hasModifier =
    event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
  const opensElsewhere = target !== undefined && target !== "_self";
  return (
    event.defaultPrevented ||
    event.button !== 0 ||
    hasModifier ||
    opensElsewhere
  );
}

function identityHref(href: string): string {
  return href;
}
