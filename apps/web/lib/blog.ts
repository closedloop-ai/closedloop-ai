export type BlogPost = {
  slug: string;
  title: string;
  description: string;
  publishedAt: string;
  readingTime: string;
  body: string[];
};

export const blogPosts: BlogPost[] = [
  {
    slug: "team-based-agentic-development",
    title: "AI Changes Team Workflows, Not Just Individual Workflows",
    description:
      "Why the bottleneck in agentic development is coordination, not keystrokes.",
    publishedAt: "2026-04-22",
    readingTime: "5 min read",
    body: [
      "Most AI tooling is optimized for a single contributor sitting in one editor. That is useful, but it misses where work actually stalls in real organizations: handoffs, review loops, and missing context between people and systems.",
      "ClosedLoop.ai treats the team as the unit of optimization. PRDs become plans, plans become loops, and loops stay attached to the artifacts that define the work. That reduces ambiguity at the coordination layer instead of only increasing local coding speed.",
      "The result is a system where agents can operate inside a shared delivery process rather than outside it.",
    ],
  },
  {
    slug: "the-coordination-problem",
    title: "The Coordination Problem Is the Real Bottleneck",
    description:
      "Shipping faster requires a control plane for planning, execution, and review.",
    publishedAt: "2026-04-22",
    readingTime: "4 min read",
    body: [
      "Teams rarely fail because they cannot write enough code. They fail because requirements drift, context gets lost, and execution is detached from the artifacts that define intent.",
      "A useful agent stack needs more than a chat box. It needs a place to define work, generate plans, run execution loops, and judge output against the original objective.",
      "That is the job of the control plane: to keep humans, agents, and artifacts aligned while the system keeps moving.",
    ],
  },
];

export function getBlogPost(slug: string) {
  return blogPosts.find((post) => post.slug === slug);
}
