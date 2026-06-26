"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Label } from "@repo/design-system/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import { Loader2Icon } from "lucide-react";
import type { ReactNode } from "react";

export type ComputePreferenceOption = {
  value: string;
  label: string;
  description: string;
  icon?: ReactNode;
};

type ComputePreferenceCardProps = {
  title: string;
  description: string;
  headerIcon?: ReactNode;
  isLoading?: boolean;
  disabled?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  options: ComputePreferenceOption[];
};

export function ComputePreferenceCard({
  title,
  description,
  headerIcon,
  isLoading = false,
  disabled = false,
  value,
  onValueChange,
  options,
}: Readonly<ComputePreferenceCardProps>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {headerIcon}
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
          <RadioGroup
            className="gap-3"
            disabled={disabled}
            onValueChange={onValueChange}
            value={value ?? ""}
          >
            {options.map((option) => {
              const id = `compute-preference-${option.value}`;
              return (
                <div className="flex items-center gap-3" key={option.value}>
                  <RadioGroupItem id={id} value={option.value} />
                  <Label
                    className="flex cursor-pointer items-center gap-2"
                    htmlFor={id}
                  >
                    {option.icon}
                    <div>
                      <span className="font-medium">{option.label}</span>
                      <p className="text-muted-foreground text-xs">
                        {option.description}
                      </p>
                    </div>
                  </Label>
                </div>
              );
            })}
          </RadioGroup>
        )}
      </CardContent>
    </Card>
  );
}
