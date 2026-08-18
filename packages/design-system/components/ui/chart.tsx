"use client"

import * as React from "react"
import * as RechartsPrimitive from "recharts"

import { cn } from "@closedloop-ai/design-system/lib/utils"

// FEA-3961: Recharts' ResponsiveContainer measures its parent and, when that
// parent momentarily resolves to 0 (a `flex-1 min-h-0` chain that hasn't laid
// out yet, a display:none → visible reveal, an expand modal, or a grid cell
// before its track settles), it logs `width(-1) and height(-1) ... should be
// greater than 0` and renders an invisible 0×0 chart. Two layers keep it honest:
//  1. `min-h-40` (= CHART_MIN_HEIGHT_PX) on the ChartContainer BOX itself, so a
//     shrinkable host (`flex-1 min-h-0`) grows to fit the chart instead of the
//     chart overflowing the card. The floor lives on the laid-out box the parent
//     measures, not only the inner container.
//  2. A matching `minHeight` on the inner ResponsiveContainer, so even mid-layout
//     it always has real pixels to measure and never resolves to 0×0.
// Height-owning callers (the dashboard chart cards fix an explicit `h-*`, or a
// `flex-1` parent taller than the floor) still expand past this floor; the
// `min-h-40` only sets a lower bound. Unconstrained callers keep the
// `aspect-video` intrinsic height (which is >= the floor above ~285px wide).
const CHART_MIN_HEIGHT_PX = 160
const CHART_MIN_HEIGHT_CLASS = "min-h-40"
const RESPONSIVE_CONTAINER_DIMENSIONS = {
  minHeight: CHART_MIN_HEIGHT_PX,
  minWidth: 0,
} as const

// Format: { THEME_NAME: CSS_SELECTOR }
const THEMES = { light: "", dark: ".dark" } as const

export type ChartConfig = {
  [k in string]: {
    label?: React.ReactNode
    icon?: React.ComponentType
    // ISS-5362: CSS background properties painted over this series' swatch, so
    // a chart that carries identity in a REDUNDANT non-colour channel (the
    // donut's slice textures) shows the same texture wherever a swatch appears.
    // Without it a textured ring would have a flat legend and the reader would
    // have nothing to map an arc back to. A full style object, not just an
    // image: a repeating texture is not described without its `backgroundSize`.
    // Undefined keeps the plain colour fill, which is every other chart.
    //
    // #4514 (review): all THREE swatch renderers read this — both legends and
    // the tooltip chip. The tooltip is where a reader goes to CONFIRM which arc
    // they are on, so a flat chip there would drop the channel at the exact
    // moment it is being used.
    swatchTexture?: React.CSSProperties
  } & (
    | { color?: string; theme?: never }
    | { color?: never; theme: Record<keyof typeof THEMES, string> }
  )
}

type ChartContextProps = {
  config: ChartConfig
  // FEA-4264: interactive legend. The set of series keys the user has hidden by
  // clicking their legend entry. A key in this set is dimmed in the legend and
  // dropped from the plot by the composite chart. Empty = every series visible
  // (the default). `toggleSeries` flips one key; composites read `isSeriesHidden`
  // to decide whether to draw a given series, so the behavior lights up every
  // chart built on these primitives from one place.
  hiddenSeries: ReadonlySet<string>
  // Flip one series' visibility. Refuses to hide the last still-visible series —
  // an all-hidden chart reads as broken, not as a filter (thread #2). The guard
  // lives here so every composite built on these primitives is covered from one
  // place; it needs the full set of togglable keys, which the legend registers
  // via `registerSeriesKeys`.
  toggleSeries: (key: string) => void
  isSeriesHidden: (key: string) => boolean
  // Clear every hidden series — the "Show all" reset the legend renders once
  // anything is hidden (thread #6).
  resetSeries: () => void
  // Show only `key`, hiding all its siblings — the double-click "isolate"
  // behavior the feature is named for (thread #6). Double-clicking an already
  // isolated series restores all.
  isolateSeries: (key: string) => void
  // True once the user has hidden at least one series, so the legend can reveal
  // its "Show all" reset.
  hasHiddenSeries: boolean
  // The legend reports the full set of togglable series keys here so the
  // last-visible guard and isolate can reason about siblings without the context
  // having to know how each composite enumerates its series.
  registerSeriesKeys: (keys: readonly string[]) => void
}

const ChartContext = React.createContext<ChartContextProps | null>(null)

function useChart() {
  const context = React.useContext(ChartContext)

  if (!context) {
    throw new Error("useChart must be used within a <ChartContainer />")
  }

  return context
}

function ChartContainer({
  id,
  className,
  children,
  config,
  resetKey,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig
  children: React.ReactElement
  // FEA-4264 (wongk review): a semantic identity for the data this chart draws.
  // The interactive-legend hidden-series state lives in this component, so a
  // consumer that reuses one ChartContainer instance across a data-identity
  // change (e.g. a metric-picker preview swapping which metric it shows) would
  // otherwise carry a series hidden under one identity into the next and hide an
  // unrelated same-named bucket. When `resetKey` changes, hidden series clear.
  // Consumers that instead remount per identity (a React `key`) don't need this.
  resetKey?: string
}) {
  const uniqueId = React.useId()
  const chartId = `chart-${id || uniqueId.replace(/:/g, "")}`
  const [hiddenSeries, setHiddenSeries] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  // Clear any hidden series when the chart's data identity changes, so toggle
  // state never bleeds across a semantic reset (wongk review). Tracked via a ref
  // + render-phase compare rather than an effect so the stale hidden set never
  // paints for a frame against the new identity.
  const previousResetKeyRef = React.useRef(resetKey)
  if (previousResetKeyRef.current !== resetKey) {
    previousResetKeyRef.current = resetKey
    if (hiddenSeries.size > 0) {
      setHiddenSeries(new Set())
    }
  }
  // The legend reports every togglable series key here so the last-visible guard
  // and isolate can reason about siblings. A ref (not state) because it's read
  // inside the toggle updater, not rendered.
  const seriesKeysRef = React.useRef<readonly string[]>([])
  const registerSeriesKeys = React.useCallback((keys: readonly string[]) => {
    seriesKeysRef.current = keys
  }, [])
  const toggleSeries = React.useCallback((key: string) => {
    setHiddenSeries((previous) => {
      const next = new Set(previous)
      if (next.has(key)) {
        next.delete(key)
        return next
      }
      // Refuse to hide the last still-visible series (thread #2): an all-hidden
      // chart reads as broken, not as an applied filter. If hiding `key` would
      // empty the plot, keep it visible.
      const known = seriesKeysRef.current
      const visibleCount = known.filter((k) => !next.has(k)).length
      if (known.includes(key) && visibleCount <= 1) {
        return previous
      }
      next.add(key)
      return next
    })
  }, [])
  const resetSeries = React.useCallback(() => {
    setHiddenSeries((previous) => (previous.size === 0 ? previous : new Set()))
  }, [])
  const isolateSeries = React.useCallback((key: string) => {
    setHiddenSeries((previous) => {
      const known = seriesKeysRef.current
      // Double-clicking an already isolated series restores all.
      const alreadyIsolated =
        previous.size === known.length - 1 && !previous.has(key)
      if (alreadyIsolated || known.length <= 1) {
        return previous.size === 0 ? previous : new Set()
      }
      return new Set(known.filter((k) => k !== key))
    })
  }, [])
  const isSeriesHidden = React.useCallback(
    (key: string) => hiddenSeries.has(key),
    [hiddenSeries]
  )
  const hasHiddenSeries = hiddenSeries.size > 0
  const contextValue = React.useMemo(
    () => ({
      config,
      hiddenSeries,
      toggleSeries,
      isSeriesHidden,
      resetSeries,
      isolateSeries,
      hasHiddenSeries,
      registerSeriesKeys,
    }),
    [
      config,
      hiddenSeries,
      toggleSeries,
      isSeriesHidden,
      resetSeries,
      isolateSeries,
      hasHiddenSeries,
      registerSeriesKeys,
    ]
  )

  return (
    <ChartContext.Provider value={contextValue}>
      <div
        data-slot="chart"
        data-chart={chartId}
        className={cn(
          "[&_.recharts-cartesian-axis-line]:stroke-[var(--chart-axis)] [&_.recharts-cartesian-axis-tick-value]:fill-[var(--chart-axis-label)] [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border flex aspect-video justify-center text-xs [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
          CHART_MIN_HEIGHT_CLASS,
          className
        )}
        {...props}
      >
        <ChartStyle id={chartId} config={config} />
        <RechartsPrimitive.ResponsiveContainer
          {...RESPONSIVE_CONTAINER_DIMENSIONS}
        >
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  )
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colorConfig = Object.entries(config).filter(
    ([, config]) => config.theme || config.color
  )

  if (!colorConfig.length) {
    return null
  }

  return (
    <style
      dangerouslySetInnerHTML={{
        __html: Object.entries(THEMES)
          .map(
            ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
  .map(([key, itemConfig]) => {
    const color =
      itemConfig.theme?.[theme as keyof typeof itemConfig.theme] ||
      itemConfig.color
    return color ? `  --color-${key}: ${color};` : null
  })
  .join("\n")}
}
`
          )
          .join("\n"),
      }}
    />
  )
}

// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const ChartTooltip = RechartsPrimitive.Tooltip as unknown as React.FC<any>

function ChartTooltipContent({
  active,
  payload,
  className,
  indicator = "dot",
  hideLabel = false,
  hideIndicator = false,
  label,
  labelFormatter,
  labelClassName,
  formatter,
  valueFormatter,
  color,
  nameKey,
  labelKey,
}: // biome-ignore lint/suspicious/noExplicitAny: recharts types incompatible with React 19 JSX
  any & {
    hideLabel?: boolean
    hideIndicator?: boolean
    indicator?: "line" | "dot" | "dashed"
    nameKey?: string
    labelKey?: string
    // Formats the per-series numeric value (e.g. currency, tokens) while keeping
    // the default indicator + label layout. Falls back to `toLocaleString()`.
    valueFormatter?: (value: number) => string
  }) {
  const { config } = useChart()

  const tooltipLabel = React.useMemo(() => {
    if (hideLabel || !payload?.length) {
      return null
    }

    const [item] = payload
    const key = `${labelKey || item?.dataKey || item?.name || "value"}`
    const itemConfig = getPayloadConfigFromPayload(config, item, key)
    const value =
      !labelKey && typeof label === "string"
        ? config[label as keyof typeof config]?.label || label
        : itemConfig?.label

    if (labelFormatter) {
      return (
        <div className={cn("font-medium", labelClassName)}>
          {labelFormatter(value, payload)}
        </div>
      )
    }

    if (!value) {
      return null
    }

    return <div className={cn("font-medium", labelClassName)}>{value}</div>
  }, [
    label,
    labelFormatter,
    payload,
    hideLabel,
    labelClassName,
    config,
    labelKey,
  ])

  if (!active || !payload?.length) {
    return null
  }

  const nestLabel = payload.length === 1 && indicator !== "dot"

  return (
    <div
      className={cn(
        "border-border/50 bg-background grid min-w-[8rem] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl",
        className
      )}
    >
      {!nestLabel ? tooltipLabel : null}
      <div className="grid gap-1.5">
        {payload
          .filter((item: any) => item.type !== "none")
          .map((item: any, index: number) => {
            const key = `${nameKey || item.name || item.dataKey || "value"}`
            const itemConfig = getPayloadConfigFromPayload(config, item, key)
            // ISS-5362 (#4514 review): Recharts merges each `<Cell>`'s fill
            // into the tooltip payload, so a TEXTURED slice arrives here as
            // `url(#donut-texture-…)`. That is a paint server reference, not a
            // CSS colour — assigning it to `--color-bg` renders an EMPTY chip
            // on exactly the slices whose identity the texture is carrying. So
            // a paint server falls back to the series' own configured colour,
            // and the texture is re-applied below as a real background.
            const payloadFill = item.payload?.fill
            const indicatorColor =
              color ||
              (isPaintServerReference(payloadFill)
                ? itemConfig?.color
                : payloadFill) ||
              item.color

            return (
              <div
                key={item.dataKey}
                className={cn(
                  "[&>svg]:text-muted-foreground flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5",
                  indicator === "dot" && "items-center"
                )}
              >
                {formatter && item?.value !== undefined && item.name ? (
                  formatter(item.value, item.name, item, index, item.payload)
                ) : (
                  <>
                    {itemConfig?.icon ? (
                      <itemConfig.icon />
                    ) : (
                      !hideIndicator && (
                        <div
                          className={cn(
                            "shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)",
                            {
                              // A texture needs repeats to read as a texture
                              // rather than as a slightly-off flat colour, so
                              // a textured chip gets the same 12px box the
                              // legend swatch uses.
                              "h-2.5 w-2.5":
                                indicator === "dot" && !itemConfig?.swatchTexture,
                              "h-3 w-3":
                                indicator === "dot" &&
                                Boolean(itemConfig?.swatchTexture),
                              "w-1": indicator === "line",
                              "w-0 border-[1.5px] border-dashed bg-transparent":
                                indicator === "dashed",
                              "my-0.5": nestLabel && indicator === "dashed",
                            }
                          )}
                          style={
                            {
                              "--color-bg": indicatorColor,
                              "--color-border": indicatorColor,
                              ...itemConfig?.swatchTexture,
                            } as React.CSSProperties
                          }
                        />
                      )
                    )}
                    <div
                      className={cn(
                        "flex flex-1 justify-between gap-3 leading-none",
                        nestLabel ? "items-end" : "items-center"
                      )}
                    >
                      <div className="grid gap-1.5">
                        {nestLabel ? tooltipLabel : null}
                        <span className="text-muted-foreground">
                          {itemConfig?.label || item.name}
                        </span>
                      </div>
                      {item.value != null && (
                        <span className="text-foreground font-mono font-medium tabular-nums">
                          {valueFormatter
                            ? valueFormatter(Number(item.value))
                            : item.value.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
          })}
      </div>
    </div>
  )
}

// biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
const ChartLegend = RechartsPrimitive.Legend as unknown as React.FC<any>

function ChartLegendContent({
  className,
  hideIcon = false,
  payload,
  verticalAlign = "bottom",
  nameKey,
  seriesKey,
  interactive = true,
}: React.ComponentProps<"div"> & {
    // biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
    payload?: any[]
    verticalAlign?: "top" | "bottom"
    hideIcon?: boolean
    // Config key used to resolve each entry's label/icon.
    nameKey?: string
    // FEA-4264: the payload field whose value is the series identity the parent
    // chart draws under (e.g. an Area's `dataKey`, a Pie slice's `key`). This is
    // the key toggled in the shared hidden-series set, so it MUST match the
    // identity the composite checks with `isSeriesHidden`. Defaults to the
    // Recharts `dataKey`, which is correct for the stacked-area chart; the donut
    // passes its `key` nameKey here.
    seriesKey?: string
    // FEA-4264 (thread #1): whether legend entries are click-to-toggle. The
    // time-series area chart is interactive — its y-axis is labeled and rescales
    // visibly, so hiding a series is honest. The donut is NOT: it's part-to-whole
    // with no on-screen denominator, so zeroing a slice renormalizes the ring and
    // the survivors silently misread as a larger share of the whole. The donut
    // passes `interactive={false}` to render a plain, static legend.
    interactive?: boolean
  }) {
  const {
    config,
    toggleSeries,
    isSeriesHidden,
    isolateSeries,
    resetSeries,
    hasHiddenSeries,
    registerSeriesKeys,
  } = useChart()

  const entries = React.useMemo(
    () => (payload ?? []).filter((item) => item.type !== "none"),
    [payload]
  )
  // Report the full set of togglable series keys to the container so its
  // last-visible guard (thread #2) and isolate (thread #6) can reason about
  // siblings without knowing how each composite enumerates its series. Static
  // legends register nothing — they never toggle.
  const seriesKeys = React.useMemo(
    () =>
      interactive
        ? entries.map((item) => resolveSeriesIdentity(item, seriesKey))
        : [],
    [entries, seriesKey, interactive]
  )
  React.useEffect(() => {
    registerSeriesKeys(seriesKeys)
  }, [registerSeriesKeys, seriesKeys])

  if (!payload?.length) {
    return null
  }

  if (!interactive) {
    return (
      <ChartLegendStatic
        className={className}
        config={config}
        entries={entries}
        hideIcon={hideIcon}
        nameKey={nameKey}
        verticalAlign={verticalAlign}
      />
    )
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-center gap-2",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className
      )}
    >
      {entries.map((item) => {
        const key = `${nameKey || item.dataKey || "value"}`
        const itemConfig = getPayloadConfigFromPayload(config, item, key)
        const identity = resolveSeriesIdentity(item, seriesKey)
        const hidden = isSeriesHidden(identity)
        const label = itemConfig?.label ?? identity

        return (
          <button
            aria-pressed={!hidden}
            className={cn(
              // A legend entry is a real toggle: single click flips its series,
              // double click isolates it (thread #6). `aria-pressed` (not color)
              // carries selected state to AT. The visible affordance is a
              // filled/hollow swatch — the label stays full-contrast so the one
              // bit of text a user reads to find a hidden series stays legible
              // (thread #4). House hover + focus-ring + padding match the small
              // toggles in Chip/filter-chip and give the hit target room
              // (threads #3, #7).
              "flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-muted-foreground outline-none transition-colors [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground",
              "hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            )}
            key={item.value}
            onClick={() => toggleSeries(identity)}
            onDoubleClick={() => isolateSeries(identity)}
            type="button"
          >
            {itemConfig?.icon && !hideIcon ? (
              <itemConfig.icon />
            ) : (
              <div
                className={cn(
                  "shrink-0 rounded-[2px]",
                  legendSwatchSizeClass(config),
                  // Hollow the swatch when hidden so the off state reads in
                  // monochrome, not just as a dimmer fill. Ring it in the
                  // series' own color (thread #5) so the entry keeps the
                  // identity that ties it to its band even while off.
                  hidden && "bg-transparent ring-1"
                )}
                style={
                  hidden
                    ? { color: item.color }
                    : // ISS-5362: honour `swatchTexture` here too. No chart on
                      // this legend sets one today, but a shared config field
                      // that one of two renderers silently drops is a trap for
                      // whoever wires up the next textured chart. #4514
                      // (review): the branch is exercised, not merely written —
                      // `chart.stories.tsx` mounts an interactive legend with a
                      // textured config, in both its shown and hidden states.
                      { backgroundColor: item.color, ...itemConfig?.swatchTexture }
                }
              />
            )}
            <span>{label}</span>
          </button>
        )
      })}
      {hasHiddenSeries ? (
        <button
          className={cn(
            "cursor-pointer rounded-md px-1.5 py-1 font-medium text-muted-foreground outline-none transition-colors",
            "hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          )}
          onClick={resetSeries}
          type="button"
        >
          Show all
        </button>
      ) : null}
    </div>
  )
}

// FEA-4264 (thread #1): the static, non-interactive legend. Rendered when a
// composite (the donut) opts out of click-to-toggle because it has no on-screen
// denominator to make hiding a series honest. Plain filled-swatch + label
// entries, no button semantics, no toggle affordances.
function ChartLegendStatic({
  className,
  entries,
  config,
  hideIcon,
  nameKey,
  verticalAlign,
}: {
  className?: string
  // biome-ignore lint/suspicious/noExplicitAny: recharts React 19 type workaround
  entries: any[]
  config: ChartConfig
  hideIcon: boolean
  nameKey: string | undefined
  verticalAlign: "top" | "bottom"
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-center gap-4",
        verticalAlign === "top" ? "pb-3" : "pt-3",
        className
      )}
    >
      {entries.map((item) => {
        const key = `${nameKey || item.dataKey || "value"}`
        const itemConfig = getPayloadConfigFromPayload(config, item, key)
        const label = itemConfig?.label ?? item.value

        return (
          <div
            className="flex items-center gap-1.5 text-muted-foreground [&>svg]:h-3 [&>svg]:w-3 [&>svg]:text-muted-foreground"
            key={item.value}
          >
            {itemConfig?.icon && !hideIcon ? (
              <itemConfig.icon />
            ) : (
              <div
                className={cn(
                  "shrink-0 rounded-[2px]",
                  legendSwatchSizeClass(config)
                )}
                style={{
                  backgroundColor: item.color,
                  ...itemConfig?.swatchTexture,
                }}
              />
            )}
            <span>{label}</span>
          </div>
        )
      })}
    </div>
  )
}

// FEA-4264: derive the toggle identity for a legend entry. Prefer the caller's
// `seriesKey` field on the Recharts payload (e.g. the donut passes "key"),
// falling back to the Recharts `dataKey` used by the stacked-area chart, then
// the entry's `value`. Kept in lockstep with how each composite draws a series
// so a legend click hides exactly the mark it labels.
function resolveSeriesIdentity(
  // biome-ignore lint/suspicious/noExplicitAny: recharts payload item is untyped
  item: any,
  seriesKey: string | undefined
): string {
  if (seriesKey && item?.payload && seriesKey in item.payload) {
    return String(item.payload[seriesKey])
  }
  return String(item?.dataKey ?? item?.value ?? "")
}

// Helper to extract item config from a payload.
function getPayloadConfigFromPayload(
  config: ChartConfig,
  payload: unknown,
  key: string
) {
  if (typeof payload !== "object" || payload === null) {
    return undefined
  }

  const payloadPayload =
    "payload" in payload &&
    typeof payload.payload === "object" &&
    payload.payload !== null
      ? payload.payload
      : undefined

  let configLabelKey: string = key

  if (
    key in payload &&
    typeof payload[key as keyof typeof payload] === "string"
  ) {
    configLabelKey = payload[key as keyof typeof payload] as string
  } else if (
    payloadPayload &&
    key in payloadPayload &&
    typeof payloadPayload[key as keyof typeof payloadPayload] === "string"
  ) {
    configLabelKey = payloadPayload[
      key as keyof typeof payloadPayload
    ] as string
  }

  return configLabelKey in config
    ? config[configLabelKey]
    : config[key as keyof typeof config]
}

/**
 * Build an axis tick formatter: use the caller-supplied `valueFormatter` (e.g.
 * currency) when present, else the chart's own default (`fallback`). Shared by
 * the chart composites so the "formatter ?? default" wrapper lives in one place.
 */
function resolveTickFormatter(
  valueFormatter: ((value: number) => string) | undefined,
  fallback: (value: number | string) => string
): (value: number | string) => string {
  return (value) =>
    valueFormatter ? valueFormatter(Number(value)) : fallback(value)
}

// FEA-4264: the interactive composite (TimeSeriesAreaChart) reads this to learn
// which series the user hid via the legend, so it can drop those marks from the
// plot. Only valid inside a <ChartContainer>. (The donut opts out of toggling —
// thread #1 — so it does not consult this.)
function useChartLegendState() {
  const { hiddenSeries, isSeriesHidden, toggleSeries } = useChart()
  return { hiddenSeries, isSeriesHidden, toggleSeries }
}

/**
 * The swatch box size for a whole legend (ISS-5362).
 *
 * Decided ONCE per legend, not per entry. A texture needs repeats to read as a
 * texture rather than as a slightly-off flat colour, but sizing only the
 * textured entries leaves the solid one looking like an item that failed to
 * load next to three that didn't. Square, because every other swatch in the
 * product is — a wide chip reads as a different component.
 *
 * #4514 (review): shared by BOTH legend renderers. A textured chart is allowed
 * to use either, and a texture that only gets its box on the static one would
 * be the same silent-drop trap `swatchTexture` exists to avoid.
 */
function legendSwatchSizeClass(config: ChartConfig) {
  return Object.values(config).some((entry) => entry.swatchTexture)
    ? "h-3 w-3"
    : "h-2 w-2"
}

const PAINT_SERVER_REFERENCE_PATTERN = /^\s*url\(/i

/**
 * Whether an SVG fill is a paint SERVER reference (`url(#…)`) rather than a
 * colour (ISS-5362, #4514 review).
 *
 * Recharts merges a `<Cell>`'s fill into the tooltip payload, and a textured
 * donut slice fills with a `<pattern>` reference. Handing that to a CSS
 * `background-color` is not "the wrong shade" — it is an invalid value, so the
 * declaration is dropped and the chip renders empty on precisely the slices
 * whose identity the texture exists to carry.
 */
function isPaintServerReference(fill: unknown): boolean {
  return (
    typeof fill === "string" && PAINT_SERVER_REFERENCE_PATTERN.test(fill)
  )
}

export {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartStyle,
  ChartTooltip,
  ChartTooltipContent,
  resolveTickFormatter,
  useChartLegendState
}
