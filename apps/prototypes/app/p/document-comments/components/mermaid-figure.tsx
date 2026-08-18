// Presentational stand-in for an inline-rendered mermaid diagram. The real doc
// body renders these through @repo/rich-text's mermaid node view (always on, no
// per-document toggle); that runtime isn't available in the prototype sandbox,
// so this paints a static, DS-tokened flowchart to show the block renders as a
// figure rather than a fenced code block. It is a fidelity stand-in for the
// rich-text mermaid node, not a missing design-system primitive (no DS-GAP).

type MermaidNode = {
  label: string;
  x: number;
  y: number;
};

const NODE_WIDTH = 132;
const NODE_HEIGHT = 40;

const NODES = {
  edit: { label: "Local edit", x: 24, y: 20 },
  queue: { label: "Writer queue", x: 208, y: 20 },
  commit: { label: "Commit + version", x: 208, y: 96 },
  broadcast: { label: "Broadcast to clients", x: 24, y: 96 },
} satisfies Record<string, MermaidNode>;

function nodeCenter(node: MermaidNode) {
  return { cx: node.x + NODE_WIDTH / 2, cy: node.y + NODE_HEIGHT / 2 };
}

type MermaidFigureProps = {
  caption: string;
};

export function MermaidFigure({ caption }: Readonly<MermaidFigureProps>) {
  const edit = nodeCenter(NODES.edit);
  const queue = nodeCenter(NODES.queue);
  const commit = nodeCenter(NODES.commit);
  const broadcast = nodeCenter(NODES.broadcast);

  return (
    <figure className="my-2 overflow-hidden rounded-lg border bg-muted/20">
      <svg
        aria-label={`Diagram: ${caption}`}
        className="h-auto w-full text-foreground"
        role="img"
        viewBox="0 0 364 156"
      >
        <defs>
          <marker
            id="doc-comments-arrow"
            markerHeight="6"
            markerWidth="6"
            orient="auto-start-reverse"
            refX="5"
            refY="3"
            viewBox="0 0 6 6"
          >
            <path d="M0,0 L6,3 L0,6 Z" fill="currentColor" />
          </marker>
        </defs>
        {Object.entries(NODES).map(([id, node]) => (
          <g key={id}>
            <rect
              className="fill-card stroke-border"
              height={NODE_HEIGHT}
              rx="6"
              strokeWidth="1"
              width={NODE_WIDTH}
              x={node.x}
              y={node.y}
            />
            <text
              className="fill-foreground text-[11px]"
              dominantBaseline="middle"
              textAnchor="middle"
              x={node.x + NODE_WIDTH / 2}
              y={node.y + NODE_HEIGHT / 2}
            >
              {node.label}
            </text>
          </g>
        ))}
        <g
          className="stroke-muted-foreground"
          fill="none"
          markerEnd="url(#doc-comments-arrow)"
          strokeWidth="1"
        >
          <line
            x1={edit.cx + NODE_WIDTH / 2}
            x2={queue.cx - NODE_WIDTH / 2 - 6}
            y1={edit.cy}
            y2={queue.cy}
          />
          <line
            x1={queue.cx}
            x2={commit.cx}
            y1={queue.cy + NODE_HEIGHT / 2}
            y2={commit.cy - NODE_HEIGHT / 2 - 6}
          />
          <line
            x1={commit.cx - NODE_WIDTH / 2}
            x2={broadcast.cx + NODE_WIDTH / 2 + 6}
            y1={commit.cy}
            y2={broadcast.cy}
          />
        </g>
      </svg>
      <figcaption className="border-t px-3 py-2 text-muted-foreground text-xs">
        {caption}
      </figcaption>
    </figure>
  );
}
