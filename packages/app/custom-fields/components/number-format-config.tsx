"use client";

import { LabelPosition, NumberFormat } from "@repo/api/src/types/custom-field";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  RadioGroup,
  RadioGroupItem,
} from "@repo/design-system/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import type { Control, FieldValues, Path } from "react-hook-form";
import { Controller, useFormContext, useWatch } from "react-hook-form";

const PRECISION_OPTIONS = [0, 1, 2, 3, 4, 5, 6] as const;

export type NumberFormatConfigProps<T extends FieldValues = FieldValues> = {
  control?: Control<T>;
};

export function NumberFormatConfig<T extends FieldValues = FieldValues>({
  control: controlProp,
}: Readonly<NumberFormatConfigProps<T>>) {
  const formContext = useFormContext<T>();
  const control = controlProp ?? formContext?.control;

  const numberFormat = useWatch({
    control,
    name: "numberFormat" as Path<T>,
  }) as string | undefined;

  return (
    <div className="space-y-4">
      <Controller
        control={control}
        name={"numberFormat" as Path<T>}
        render={({ field }) => (
          <div className="space-y-2">
            <Label>Number Format</Label>
            <RadioGroup
              className="flex flex-col gap-2"
              onValueChange={field.onChange}
              value={field.value as string}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem id="format-none" value={NumberFormat.None} />
                <Label htmlFor="format-none">None</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem
                  id="format-currency"
                  value={NumberFormat.Currency}
                />
                <Label htmlFor="format-currency">Currency</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem
                  id="format-percentage"
                  value={NumberFormat.Percentage}
                />
                <Label htmlFor="format-percentage">Percentage</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem
                  id="format-custom"
                  value={NumberFormat.Custom}
                />
                <Label htmlFor="format-custom">Custom</Label>
              </div>
            </RadioGroup>
          </div>
        )}
      />

      {numberFormat === NumberFormat.Currency && (
        <Controller
          control={control}
          name={"currencyCode" as Path<T>}
          render={({ field }) => (
            <div className="space-y-2">
              <Label htmlFor="currency-code">Currency Code</Label>
              <Input
                id="currency-code"
                maxLength={3}
                onBlur={field.onBlur}
                onChange={field.onChange}
                placeholder="USD"
                value={(field.value as string) ?? ""}
              />
            </div>
          )}
        />
      )}

      {numberFormat === NumberFormat.Custom && (
        <div className="space-y-4">
          <Controller
            control={control}
            name={"customLabel" as Path<T>}
            render={({ field }) => (
              <div className="space-y-2">
                <Label htmlFor="custom-label">Custom Label</Label>
                <Input
                  id="custom-label"
                  onBlur={field.onBlur}
                  onChange={field.onChange}
                  placeholder="e.g. pts"
                  value={(field.value as string) ?? ""}
                />
              </div>
            )}
          />
          <Controller
            control={control}
            name={"customLabelPosition" as Path<T>}
            render={({ field }) => (
              <div className="space-y-2">
                <Label>Label Position</Label>
                <Select
                  onValueChange={field.onChange}
                  value={(field.value as string) ?? LabelPosition.Prefix}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select position" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={LabelPosition.Prefix}>Prefix</SelectItem>
                    <SelectItem value={LabelPosition.Suffix}>Suffix</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          />
        </div>
      )}

      <Controller
        control={control}
        name={"precision" as Path<T>}
        render={({ field }) => (
          <div className="space-y-2">
            <Label>Decimal Precision</Label>
            <Select
              onValueChange={(val) => field.onChange(Number(val))}
              value={String(field.value ?? 0)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select precision" />
              </SelectTrigger>
              <SelectContent>
                {PRECISION_OPTIONS.map((p) => (
                  <SelectItem key={p} value={String(p)}>
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      />
    </div>
  );
}
