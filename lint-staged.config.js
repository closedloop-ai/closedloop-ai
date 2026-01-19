// lint-staged.config.js
// Handles files with brackets in paths (e.g., Next.js [id] routes)

export default {
  "*.{js,jsx,ts,tsx,json,jsonc}": (filenames) => {
    // Quote each path to handle brackets (biome interprets [] as glob patterns)
    const quoted = filenames.map((f) => `"${f}"`);
    return `npx biome check --write ${quoted.join(" ")}`;
  },
};
