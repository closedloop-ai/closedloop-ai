export const ModelPricingCurrency = {
  Usd: "USD",
} as const;
export type ModelPricingCurrency =
  (typeof ModelPricingCurrency)[keyof typeof ModelPricingCurrency];

export const ModelPricingSource = {
  PricingTableV1: "pricing_table_v1",
  GenaiPricesV1: "genai_prices_v1",
} as const;
export type ModelPricingSource =
  (typeof ModelPricingSource)[keyof typeof ModelPricingSource];
