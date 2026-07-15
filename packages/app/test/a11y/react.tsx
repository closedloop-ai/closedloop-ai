import type { ReactElement } from "react";
import {
  type A11yTheme,
  applyA11yTheme,
  themeBackground,
  themeForeground,
} from "./contrast";

export function A11yThemeRoot({
  children,
  theme,
}: {
  children: ReactElement;
  theme: A11yTheme;
}) {
  return (
    <div
      data-testid={`a11y-theme-${theme}`}
      ref={(element) => {
        if (element) {
          applyA11yTheme(element, theme);
        }
      }}
      style={{
        backgroundColor: themeBackground(theme),
        color: themeForeground(theme),
      }}
    >
      {children}
    </div>
  );
}
