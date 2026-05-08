// lint-staged.config.js
// Handles files with brackets in paths (e.g., Next.js [id] routes)

export default {
  "*.{js,jsx,ts,tsx,json,jsonc}": (filenames) => {
    // Quote each path to handle brackets (biome interprets [] as glob patterns)
    const quoted = filenames.map((f) => `"${f}"`);
    // --no-errors-on-unmatched: Don't error when files are ignored by biome.jsonc
    return `npx biome check --write --no-errors-on-unmatched ${quoted.join(" ")}`;
  },
};
