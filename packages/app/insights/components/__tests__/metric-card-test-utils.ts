import { screen } from "@testing-library/react";

export function getMetricValueRow(label: string): HTMLElement {
  const card = screen.getByText(label).closest('[data-slot="card"]');
  if (!card) {
    throw new Error(`Metric card for ${label} is missing`);
  }
  const valueRow = card.querySelector('[data-slot="card-title"]');
  if (!(valueRow instanceof HTMLElement)) {
    throw new Error(`Metric value row for ${label} is missing`);
  }
  return valueRow;
}
