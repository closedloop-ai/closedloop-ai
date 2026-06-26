import { notFound } from "next/navigation";
import { blogPosts, getBlogPost } from "@/lib/blog";
import { createPageMetadata, locales } from "@/lib/site";

type BlogPostPageProps = {
  params: Promise<{
    locale: string;
    slug: string;
  }>;
};

export async function generateMetadata({ params }: BlogPostPageProps) {
  const { slug } = await params;
  const post = getBlogPost(slug);

  if (!post) {
    return createPageMetadata("Blog", "Closedloop.ai blog");
  }

  return createPageMetadata(post.title, post.description);
}

export function generateStaticParams() {
  return locales.flatMap((locale) =>
    blogPosts.map((post) => ({
      locale,
      slug: post.slug,
    }))
  );
}

const BlogPostPage = async ({ params }: BlogPostPageProps) => {
  const { slug } = await params;
  const post = getBlogPost(slug);

  if (!post) {
    notFound();
  }

  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-12 md:px-10">
      <header className="space-y-3">
        <p className="text-muted-foreground text-sm">
          {post.publishedAt} · {post.readingTime}
        </p>
        <h1 className="font-semibold text-4xl tracking-tight">{post.title}</h1>
        <p className="text-lg text-muted-foreground">{post.description}</p>
      </header>

      <div className="space-y-4 text-base text-foreground/90 leading-7">
        {post.body.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
    </article>
  );
};

export default BlogPostPage;
