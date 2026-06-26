type LineChartPoint = {
  label: string;
  value: number;
};

type LineChartProps = {
  points: LineChartPoint[];
  color?: string;
  valueFormatter?: (value: number) => string;
  label?: string;
};

export function LineChart({
  points,
  color = "#10b981",
  valueFormatter = (value) => value.toLocaleString(),
  label = "trend line",
}: LineChartProps) {
  if (points.length === 0) {
    return <div className="text-muted-foreground text-sm">No data</div>;
  }

  const width = 320;
  const height = 88;
  const padding = 8;
  const min = Math.min(...points.map((point) => point.value), 0);
  const max = Math.max(...points.map((point) => point.value), 0);
  const span = Math.max(max - min, 0.0001);
  const step =
    points.length > 1 ? (width - padding * 2) / (points.length - 1) : 0;

  const mapped = points.map((point, index) => {
    const x = padding + index * step;
    const y =
      height - padding - ((point.value - min) / span) * (height - padding * 2);
    return { ...point, x, y };
  });

  const polyline = mapped.map((point) => `${point.x},${point.y}`).join(" ");
  const area = `${mapped[0]?.x ?? padding},${height - padding} ${polyline} ${
    mapped.at(-1)?.x ?? padding
  },${height - padding}`;

  return (
    <svg
      aria-label={label}
      className="h-[88px] w-full overflow-visible"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      <defs>
        <linearGradient
          id={`line-fill-${label.replace(/\s+/g, "-")}`}
          x1="0"
          x2="0"
          y1="0"
          y2="1"
        >
          <stop offset="0%" stopColor={color} stopOpacity={0.35} />
          <stop offset="100%" stopColor={color} stopOpacity={0.02} />
        </linearGradient>
      </defs>
      <polyline
        fill={`url(#line-fill-${label.replace(/\s+/g, "-")})`}
        points={area}
        stroke="none"
      />
      <polyline
        fill="none"
        points={polyline}
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
      />
      {mapped.map((point) => (
        <g key={point.label}>
          <circle cx={point.x} cy={point.y} fill={color} r={2.5} />
          <title>{`${point.label}: ${valueFormatter(point.value)}`}</title>
        </g>
      ))}
    </svg>
  );
}
