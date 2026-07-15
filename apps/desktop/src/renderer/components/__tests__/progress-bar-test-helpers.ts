/** Returns the inline width set on a progressbar's fill element. */
export function progressFillWidth(bar: HTMLElement): string | undefined {
  return (bar.firstElementChild as HTMLElement | null)?.style.width;
}
