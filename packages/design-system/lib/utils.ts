import { clsx } from 'clsx';
import type { ClassValue } from 'clsx';
import { toast } from 'sonner';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]): string => twMerge(clsx(inputs));

export const capitalize = (str: string) =>
  str.charAt(0).toUpperCase() + str.slice(1);

// mirrors packages/observability/error.ts - cannot import @repo/observability in a publishable package
const parseError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message);
  }
  return String(error);
};

export const handleError = (error: unknown): void => {
  const message = parseError(error);

  toast.error(message);
};
