"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { ModeToggle } from "@repo/design-system/components/ui/mode-toggle";
import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "@repo/design-system/components/ui/navigation-menu";
import type { Dictionary } from "@repo/internationalization";
import { Menu, MoveRight, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { env } from "@/env";
import { LanguageSwitcher } from "./language-switcher";

type HeaderProps = {
  dictionary: Dictionary;
};

export function Header({ dictionary }: HeaderProps) {
  const [isOpen, setIsOpen] = useState(false);

  const navigationItems = [
    {
      title: dictionary.web.header.home,
      href: "/",
    },
  ];

  if (env.NEXT_PUBLIC_DOCS_URL) {
    navigationItems.push({
      title: dictionary.web.header.docs,
      href: env.NEXT_PUBLIC_DOCS_URL,
    });
  }

  return (
    <header className="sticky top-0 left-0 z-40 w-full border-b bg-background">
      <div className="container relative mx-auto flex min-h-20 flex-row items-center gap-4 lg:grid lg:grid-cols-3">
        <div className="hidden flex-row items-center justify-start gap-4 lg:flex">
          <NavigationMenu className="flex items-start justify-start">
            <NavigationMenuList className="flex flex-row justify-start gap-4">
              {navigationItems.map((item) => (
                <NavigationMenuItem key={item.title}>
                  <NavigationMenuLink asChild>
                    <Button asChild variant="ghost">
                      <Link href={item.href}>{item.title}</Link>
                    </Button>
                  </NavigationMenuLink>
                </NavigationMenuItem>
              ))}
            </NavigationMenuList>
          </NavigationMenu>
        </div>
        <div className="flex items-center gap-2 lg:justify-center">
          <svg
            className="h-[18px] w-[18px] -translate-y-[0.5px] fill-current text-symphony-violet"
            fill="none"
            height="22"
            viewBox="0 0 235 203"
            xmlns="http://www.w3.org/2000/svg"
          >
            <title>Symphony</title>
            <path
              d="M117.082 0L234.164 202.794H0L117.082 0Z"
              fill="currentColor"
            />
          </svg>
          <p className="whitespace-nowrap font-semibold">Symphony</p>
        </div>
        <div className="flex w-full justify-end gap-4">
          <Button asChild className="hidden md:inline" variant="ghost">
            <Link href="/contact">{dictionary.web.header.contact}</Link>
          </Button>
          <div className="hidden border-r md:inline" />
          <div className="hidden md:inline">
            <LanguageSwitcher />
          </div>
          <div className="hidden md:inline">
            <ModeToggle />
          </div>
          <Button asChild className="hidden md:inline" variant="outline">
            <Link href={`${env.NEXT_PUBLIC_APP_URL}/sign-in`}>
              {dictionary.web.header.signIn}
            </Link>
          </Button>
          <Button asChild>
            <Link href={`${env.NEXT_PUBLIC_APP_URL}/sign-up`}>
              {dictionary.web.header.signUp}
            </Link>
          </Button>
        </div>
        <div className="flex w-12 shrink items-end justify-end lg:hidden">
          <Button onClick={() => setIsOpen(!isOpen)} variant="ghost">
            {isOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          {isOpen ? (
            <div className="container absolute top-20 right-0 flex w-full flex-col gap-8 border-t bg-background py-4 shadow-lg">
              {navigationItems.map((item) => (
                <div key={item.title}>
                  <div className="flex flex-col gap-2">
                    <Link
                      className="flex items-center justify-between"
                      href={item.href}
                      rel={
                        item.href.startsWith("http")
                          ? "noopener noreferrer"
                          : ""
                      }
                      target={item.href.startsWith("http") ? "_blank" : ""}
                    >
                      <span className="text-lg">{item.title}</span>
                      <MoveRight className="h-4 w-4 stroke-1 text-muted-foreground" />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}
