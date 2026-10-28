/** Minimal MDX input for the real Fumadocs loader in docs-routing.test.ts. */
export const docs = {
  toFumadocsSource: () => ({
    files: [
      { type: "page", path: "index.mdx", data: { title: "Documentation" } },
      { type: "page", path: "guide.mdx", data: { title: "Guide" } },
    ],
  }),
};
