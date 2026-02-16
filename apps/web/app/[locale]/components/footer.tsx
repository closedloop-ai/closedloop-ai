import Link from "next/link";
import { env } from "@/env";

export const Footer = () => {
  const navigationItems: Array<{ title: string; href: string }> = [
    {
      title: "Home",
      href: "/",
    },
    {
      title: "Contact",
      href: "/contact",
    },
  ];

  if (env.NEXT_PUBLIC_DOCS_URL) {
    navigationItems.push({
      title: "Docs",
      href: env.NEXT_PUBLIC_DOCS_URL,
    });
  }

  return (
    <section className="dark border-foreground/10 border-t">
      <div className="w-full bg-background py-20 text-foreground lg:py-40">
        <div className="container mx-auto">
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <div className="flex flex-col items-start gap-8">
              <div className="flex flex-col gap-2">
                <h2 className="max-w-xl text-left font-regular text-3xl tracking-tighter md:text-5xl">
                  ClosedLoop.AI
                </h2>
                <p className="max-w-lg text-left text-foreground/75 text-lg leading-relaxed tracking-tight">
                  From intent to implementation, faster.
                </p>
              </div>
            </div>
            <div className="flex flex-col items-start gap-2 text-base lg:items-end">
              {navigationItems.map((item) => (
                <Link
                  className="flex items-center justify-between"
                  href={item.href}
                  key={item.title}
                  rel={
                    item.href.includes("http")
                      ? "noopener noreferrer"
                      : undefined
                  }
                  target={item.href.includes("http") ? "_blank" : undefined}
                >
                  <span className="text-foreground/75 hover:text-foreground">
                    {item.title}
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
