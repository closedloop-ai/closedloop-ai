"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { cn } from "@repo/design-system/lib/utils";
import { Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";

type IntegrationConnectionCardProps = {
  title: string;
  description: ReactNode;
  titleIcon?: ReactNode;
  isLoading?: boolean;
  className?: string;
  banner?: ReactNode;
  statusIcon?: ReactNode;
  statusTitle?: ReactNode;
  statusDescription?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
};

export function IntegrationConnectionCard({
  title,
  description,
  titleIcon,
  isLoading = false,
  className,
  banner,
  statusIcon,
  statusTitle,
  statusDescription,
  actions,
  children,
}: Readonly<IntegrationConnectionCardProps>) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {titleIcon}
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2Icon className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-4">
            {banner}
            {statusTitle || actions ? (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-3">
                  {statusIcon}
                  <div className="space-y-1">
                    {statusTitle ? (
                      <p className="font-medium">{statusTitle}</p>
                    ) : null}
                    {statusDescription ? (
                      <div
                        className={cn(
                          "text-muted-foreground text-sm",
                          !statusTitle && "text-foreground"
                        )}
                      >
                        {statusDescription}
                      </div>
                    ) : null}
                  </div>
                </div>
                {actions ? (
                  <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
                    {actions}
                  </div>
                ) : null}
              </div>
            ) : null}
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
