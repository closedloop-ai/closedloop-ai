export function formatMetricValue(value: string | number) {
  return typeof value === "number" ? value.toLocaleString("en-US") : value;
}
