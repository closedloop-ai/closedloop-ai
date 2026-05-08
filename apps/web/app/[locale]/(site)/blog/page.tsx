import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import Link from "next/link";
import { blogPosts, getBlogPost } from "@/lib/blog";
import { createPageMetadata, localize } from "@/lib/site";

type BlogIndexProps = {
  params: Promise<{
    locale: string;
  }>;
};

export const generateMetadata = async () =>
  createPageMetadata(
    "Blog",
    "Essays about coordination, team-based agentic development, and how ClosedLoop.ai is built."
  );

const BlogIndexPage = async ({ params }: BlogIndexProps) => {
  const { locale } = await params;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-12 md:px-10">
      <div className="space-y-3">
        <p className="font-medium text-muted-foreground text-sm uppercase tracking-[0.2em]">
          Blog
        </p>
        <h1 className="font-semibold text-4xl tracking-tight">
          Essays that define the category.
        </h1>
        <p className="max-w-2xl text-muted-foreground">
          Phase 1 starts with two anchor posts focused on team workflows and the
          coordination problem behind agentic development.
        </p>
      </div>

      <div className="grid gap-4">
        {blogPosts.map((post) => (
          <Link href={localize(locale, `/blog/${post.slug}`)} key={post.slug}>
            <Card className="transition-colors hover:border-primary/50">
              <CardHeader>
                <div className="text-muted-foreground text-sm">
                  {post.publishedAt} · {post.readingTime}
                </div>
                <CardTitle>{post.title}</CardTitle>
                <CardDescription>{post.description}</CardDescription>
              </CardHeader>
              <CardContent className="text-muted-foreground text-sm">
                {getBlogPost(post.slug)?.body[0]}
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
};

export default BlogIndexPage;
