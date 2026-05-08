import { Button } from "@repo/design-system/components/ui/button";
import { ArrowRight, Github } from "lucide-react";
import Link from "next/link";
import { env } from "@/env";
import { GITHUB_REPO_URL } from "./constants";

export const HeroSection = () => {
  return (
    <section className="mx-auto flex w-full max-w-[1300px] flex-col gap-8 px-6 pt-16 pb-12 md:px-10 md:pt-24 lg:pt-28">
      <h1 className="max-w-4xl font-semibold text-4xl tracking-tight md:text-5xl lg:text-6xl">
        The workspace for <span className="text-primary">Team-based</span>{" "}
        agentic software development.
      </h1>
      <p className="max-w-3xl text-balance text-base text-muted-foreground md:text-lg">
        Define, plan, and ship software with AI in one shared workspace. Plans
        are reviewed before execution. Work is visible as it runs. Every run
        improves the next.
      </p>
      <div className="flex flex-col flex-wrap gap-3 sm:flex-row">
        <Button
          asChild
          className="h-10 rounded-full px-5 text-sm md:text-base"
          size="lg"
        >
          <Link href={`${env.NEXT_PUBLIC_APP_URL}/sign-up`}>
            Start Building
            <ArrowRight className="size-4" />
          </Link>
        </Button>
        <Button
          asChild
          className="h-10 rounded-full px-5 text-sm md:text-base"
          size="lg"
          variant="outline"
        >
          <Link
            href={GITHUB_REPO_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            <Github className="size-4" />
            Support us on GitHub
          </Link>
        </Button>
      </div>
    </section>
  );
};
