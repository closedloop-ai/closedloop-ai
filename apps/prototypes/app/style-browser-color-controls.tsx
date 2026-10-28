"use client";

import { Button } from "@repo/design-system/components/ui/button";
import { Input } from "@repo/design-system/components/ui/input";
import { PipetteIcon, ShuffleIcon } from "lucide-react";
import { useEffect, useState } from "react";

export function ColorPaletteSelector({
  onSelectValue,
}: {
  onSelectValue: (value: string) => void;
}) {
  const [eyeDropperAvailable, setEyeDropperAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nativeColor, setNativeColor] = useState("#4685ff");

  useEffect(() => {
    setEyeDropperAvailable(Boolean(getEyeDropperConstructor()));
  }, []);

  const selectSampledColor = async () => {
    const EyeDropper = getEyeDropperConstructor();
    if (!EyeDropper) {
      setError("Eyedropper is not available in this browser.");
      return;
    }
    try {
      const result = await new EyeDropper().open();
      onSelectValue(result.sRGBHex);
      setError(null);
    } catch (caughtError) {
      if (isAbortError(caughtError)) {
        return;
      }
      setError("Could not sample that color.");
    }
  };

  const selectRandomColor = () => {
    onSelectValue(randomColorTokenValue());
    setError(null);
  };
  const selectNativeColor = (value: string) => {
    setNativeColor(value);
    onSelectValue(value);
    setError(null);
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-sm">Color tools</p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label="Native color picker"
            className="style-lab-control h-8 w-12 cursor-pointer p-1"
            onChange={(event) => selectNativeColor(event.target.value)}
            title="Native color picker"
            type="color"
            value={nativeColor}
          />
          <Button
            className="style-lab-control"
            disabled={!eyeDropperAvailable}
            onClick={selectSampledColor}
            size="sm"
            type="button"
            variant="outline"
          >
            <PipetteIcon />
            Eyedropper
          </Button>
          <Button
            className="style-lab-control"
            onClick={selectRandomColor}
            size="sm"
            type="button"
            variant="outline"
          >
            <ShuffleIcon />
            Random
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {colorPaletteOptions.map((option) => (
          <Button
            className="style-lab-control h-auto justify-start rounded-md border bg-background p-2 text-left font-normal transition-colors hover:bg-muted/40"
            key={option.label}
            onClick={() => onSelectValue(option.value)}
            type="button"
            variant="ghost"
          >
            <span
              className="block h-8 rounded-sm border shadow-inset"
              style={{ background: option.value }}
            />
            <span className="mt-1 block truncate font-medium text-xs">
              {option.label}
            </span>
          </Button>
        ))}
      </div>
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </div>
  );
}

function getEyeDropperConstructor(): EyeDropperConstructor | null {
  const EyeDropper = (globalThis as StyleLabGlobal).EyeDropper;
  if (typeof EyeDropper === "function") {
    return EyeDropper;
  }
  return null;
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "AbortError"
  );
}

function randomColorTokenValue(): string {
  const lightness = randomInRange(0.48, 0.78);
  const chroma = randomInRange(0.11, 0.24);
  const hue = randomInRange(0, 360);
  return `oklch(${formatOklchNumber(lightness)} ${formatOklchNumber(
    chroma
  )} ${formatOklchHue(hue)})`;
}

function randomInRange(minimum: number, maximum: number): number {
  return minimum + Math.random() * (maximum - minimum);
}

function formatOklchNumber(value: number): string {
  return value.toFixed(3).replace(trailingZeroPattern, "");
}

function formatOklchHue(value: number): string {
  return value.toFixed(1).replace(trailingZeroPattern, "");
}

const colorPaletteOptions = [
  { label: "Primary", value: "oklch(0.528 0.214 267)" },
  { label: "Violet", value: "oklch(0.61 0.256 285.5)" },
  { label: "Info", value: "oklch(0.6 0.15 250)" },
  { label: "Success", value: "oklch(0.629 0.144 155.113)" },
  { label: "Warning", value: "oklch(0.82 0.17 85)" },
  { label: "Destructive", value: "oklch(0.62 0.22 29.2)" },
  { label: "Surface", value: "oklch(0.962 0.004 267)" },
  {
    label: "Brand wash",
    value:
      "linear-gradient(to bottom, #fff9eb, #ffe4ab 31%, #d9a2d2 68%, #4685ff)",
  },
] as const;

const trailingZeroPattern = /\.?0+$/;

type EyeDropperConstructor = new () => {
  open: () => Promise<{ sRGBHex: string }>;
};

type StyleLabGlobal = typeof globalThis & {
  EyeDropper?: EyeDropperConstructor;
};
