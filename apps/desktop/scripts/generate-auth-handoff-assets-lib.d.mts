export declare const DESIGN_SYSTEM_THEME_PATH: string;
export declare const LOGO_LIGHT_PATH: string;
export declare const LOGO_DARK_PATH: string;
export declare const FONT_PATH: string;
export declare const MISSING_THEME_MESSAGE: string;

export type ThemeBlocks = { light: string; dark: string };

export declare function extractThemeBlocks(css: string): ThemeBlocks;

export declare function toDataUrl(bytes: Uint8Array, mime: string): string;

export type AuthHandoffAssets = {
  theme: string;
  logoLight: string;
  logoDark: string;
  font: string;
};

export declare function buildAuthHandoffAssets(
  readDesignSystemFile: (designSystemPath: string) => Buffer
): AuthHandoffAssets;

export declare function renderAuthHandoffAssetsModule(
  assets: AuthHandoffAssets
): string;
