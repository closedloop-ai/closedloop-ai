import defaultMdxComponents from "fumadocs-ui/mdx";

export function useMDXComponents(
  components: Record<string, React.ComponentType> = {}
) {
  return {
    ...defaultMdxComponents,
    ...components,
  };
}
