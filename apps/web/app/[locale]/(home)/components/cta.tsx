import type { HomePage } from "@repo/cms";
import { Button } from "@repo/design-system/components/ui/button";
import type { Dictionary } from "@repo/internationalization";
import { MoveRight, PhoneCall } from "lucide-react";
import Link from "next/link";
import { env } from "@/env";

type CTAProps = {
  cmsData?: HomePage["cta"] | null;
  dictionary: Dictionary;
};

export const CTA = ({ cmsData, dictionary }: CTAProps) => {
  // Use CMS data if available, otherwise fall back to dictionary
  const title = cmsData?.title ?? dictionary.web.home.cta.title;
  const description =
    cmsData?.description ?? dictionary.web.home.cta.description;
  const primaryButtonText =
    cmsData?.primaryButtonText ?? dictionary.web.global.primaryCta;
  const primaryButtonHref = cmsData?.primaryButtonHref ?? "/contact";
  const secondaryButtonText =
    cmsData?.secondaryButtonText ?? dictionary.web.global.secondaryCta;
  const secondaryButtonHref =
    cmsData?.secondaryButtonHref ?? env.NEXT_PUBLIC_APP_URL;

  return (
    <div className="w-full py-20 lg:py-40">
      <div className="container mx-auto">
        <div className="flex flex-col items-center gap-8 rounded-md bg-muted p-4 text-center lg:p-14">
          <div className="flex flex-col gap-2">
            <h3 className="max-w-xl font-regular text-3xl tracking-tighter md:text-5xl">
              {title}
            </h3>
            <p className="max-w-xl text-lg text-muted-foreground leading-relaxed tracking-tight">
              {description}
            </p>
          </div>
          <div className="flex flex-row gap-4">
            <Button asChild className="gap-4" variant="outline">
              <Link href={primaryButtonHref}>
                {primaryButtonText} <PhoneCall className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild className="gap-4">
              <Link href={secondaryButtonHref}>
                {secondaryButtonText} <MoveRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
