"use client";

import type { HomePage } from "@repo/cms";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@repo/design-system/components/ui/avatar";
import {
  Carousel,
  type CarouselApi,
  CarouselContent,
  CarouselItem,
} from "@repo/design-system/components/ui/carousel";
import type { Dictionary } from "@repo/internationalization";
import { User } from "lucide-react";
import { useEffect, useState } from "react";

type TestimonialsProps = {
  cmsData?: HomePage["testimonials"] | null;
  dictionary: Dictionary;
};

export const Testimonials = ({ cmsData, dictionary }: TestimonialsProps) => {
  const [api, setApi] = useState<CarouselApi>();
  const [current, setCurrent] = useState(0);

  // Use CMS data if available, otherwise fall back to dictionary
  const title = cmsData?.title ?? dictionary.web.home.testimonials.title;
  const items =
    // @ts-expect-error - Types will be inferred once BaseHub schema is created
    cmsData?.items?.items?.map((item) => ({
      title: item.title,
      description: item.description,
      author: {
        name: item.authorName,
        image: item.authorImage?.url ?? "",
      },
    })) ?? dictionary.web.home.testimonials.items;

  useEffect(() => {
    if (!api) {
      return;
    }

    setTimeout(() => {
      if (api.selectedScrollSnap() + 1 === api.scrollSnapList().length) {
        setCurrent(0);
        api.scrollTo(0);
      } else {
        api.scrollNext();
        setCurrent(current + 1);
      }
    }, 4000);
  }, [api, current]);

  return (
    <div className="w-full py-20 lg:py-40">
      <div className="container mx-auto">
        <div className="flex flex-col gap-10">
          <h2 className="text-left font-regular text-3xl tracking-tighter md:text-5xl lg:max-w-xl">
            {title}
          </h2>
          <Carousel className="w-full" setApi={setApi}>
            <CarouselContent>
              {/* @ts-expect-error - Types will be inferred once BaseHub schema is created */}
              {items.map((item, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Pre-existing pattern, items are static
                <CarouselItem className="lg:basis-1/2" key={index}>
                  <div className="flex aspect-video h-full flex-col justify-between rounded-md bg-muted p-6 lg:col-span-2">
                    <User className="h-8 w-8 stroke-1" />
                    <div className="flex flex-col gap-4">
                      <div className="flex flex-col">
                        <h3 className="text-xl tracking-tight">{item.title}</h3>
                        <p className="max-w-xs text-base text-muted-foreground">
                          {item.description}
                        </p>
                      </div>
                      <p className="flex flex-row items-center gap-2 text-sm">
                        <span className="text-muted-foreground">By</span>
                        <Avatar className="h-6 w-6">
                          <AvatarImage src={item.author.image} />
                          <AvatarFallback>??</AvatarFallback>
                        </Avatar>
                        <span>{item.author.name}</span>
                      </p>
                    </div>
                  </div>
                </CarouselItem>
              ))}
            </CarouselContent>
          </Carousel>
        </div>
      </div>
    </div>
  );
};
