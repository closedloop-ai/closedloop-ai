"use client";

import { AlertCircle, CheckCircle, ChevronRight, Circle } from "lucide-react";
import { useMemo, useState } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { decodeText } from "@/lib/engineer/run-viewer-utils";
import { getTextContent } from "@/lib/engineer/utils";

type PlanTask = {
  id?: string;
  title?: string;
  description?: string;
  status?: string;
  completed?: boolean;
  manual?: boolean;
  [key: string]: unknown;
};

type OpenQuestion = {
  id?: string;
  description?: string;
  addressed?: boolean;
  resolution?: string;
  [key: string]: unknown;
};

type PlanData = {
  content?: string;
  tasks?: PlanTask[];
  open_questions?: (string | OpenQuestion)[];
  gaps?: unknown[];
  [key: string]: unknown;
};

type PlanJsonViewerProps = {
  data: Uint8Array;
};

const mdComponents: Components = {
  h1: ({ children }) => (
    <h1 className="mt-4 mb-2 border-b pb-1 font-bold text-lg first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-4 mb-2 font-semibold text-base">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1 font-semibold text-sm">{children}</h3>
  ),
  p: ({ children }) => <p className="my-2 text-sm">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc space-y-0.5 pl-4 text-sm">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal space-y-0.5 pl-4 text-sm">{children}</ol>
  ),
  li: ({ children, ...props }) => {
    const content = getTextContent(children);
    if (content.startsWith("[ ]")) {
      return (
        <li className="flex items-start gap-2 text-sm" {...props}>
          <span className="mt-0.5 size-3.5 shrink-0 rounded border" />
          <span>{content.slice(4)}</span>
        </li>
      );
    }
    if (content.startsWith("[x]") || content.startsWith("[X]")) {
      return (
        <li className="flex items-start gap-2 text-sm" {...props}>
          <CheckCircle className="mt-0.5 size-3.5 shrink-0 text-emerald-500" />
          <span className="text-muted-foreground line-through">
            {content.slice(4)}
          </span>
        </li>
      );
    }
    return (
      <li className="text-sm" {...props}>
        {children}
      </li>
    );
  },
  code: ({ className, children, ...props }) => {
    if (!className) {
      return (
        <code className="rounded bg-muted px-1 py-0.5 text-xs" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg bg-muted p-2 text-xs">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
  th: ({ children }) => (
    <th className="border border-border px-2 py-1.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-1.5">{children}</td>
  ),
};

function TaskStatusIcon({
  isCompleted,
  isManual,
}: Readonly<{ isCompleted: boolean; isManual: boolean }>) {
  if (isCompleted) {
    return <CheckCircle className="size-4 shrink-0 text-emerald-500" />;
  }
  if (isManual) {
    return <AlertCircle className="size-4 shrink-0 text-amber-500" />;
  }
  return <Circle className="size-4 shrink-0 text-muted-foreground" />;
}

function TaskItem({ task }: Readonly<{ task: PlanTask }>) {
  const [expanded, setExpanded] = useState(false);
  const isCompleted = task.completed || task.status === "completed";
  const isManual = task.manual || task.status === "manual";

  return (
    <div className="overflow-hidden rounded-md border">
      <button
        className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-muted/50"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight
          className={`size-4 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
        />
        <TaskStatusIcon isCompleted={isCompleted} isManual={isManual} />
        <span
          className={`font-medium text-sm ${isCompleted ? "text-muted-foreground line-through" : ""}`}
        >
          {task.title || task.id || "Untitled task"}
        </span>
      </button>
      {expanded && task.description && (
        <div className="ml-11 border-t px-4 pt-0 pb-3">
          <div className="mt-2 whitespace-pre-wrap text-muted-foreground text-xs">
            {task.description}
          </div>
        </div>
      )}
    </div>
  );
}

function OpenQuestionItem({
  question,
}: Readonly<{ question: string | OpenQuestion }>) {
  if (typeof question === "string") {
    return <span>{question}</span>;
  }
  const label = question.description || JSON.stringify(question);
  return (
    <div className="space-y-0.5">
      <span className="font-medium">
        {question.id ? `${question.id}: ` : ""}
        {label}
      </span>
      {question.addressed && question.resolution && (
        <div className="text-muted-foreground text-xs">
          <CheckCircle className="mr-1 inline size-3 text-emerald-500" />
          {question.resolution}
        </div>
      )}
    </div>
  );
}

export function PlanJsonViewer({ data }: Readonly<PlanJsonViewerProps>) {
  const plan = useMemo((): PlanData | null => {
    try {
      return JSON.parse(decodeText(data)) as PlanData;
    } catch {
      return null;
    }
  }, [data]);

  if (!plan) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        Invalid plan.json
      </div>
    );
  }

  const tasks = Array.isArray(plan.tasks) ? plan.tasks : [];
  const completed = tasks.filter(
    (t) => t.completed || t.status === "completed"
  );
  const pending = tasks.filter(
    (t) =>
      !t.completed &&
      t.status !== "completed" &&
      !t.manual &&
      t.status !== "manual"
  );
  const manual = tasks.filter((t) => t.manual || t.status === "manual");

  return (
    <div className="h-full space-y-6 overflow-auto p-6">
      {plan.content && (
        <div className="prose-sm max-w-none">
          <ReactMarkdown components={mdComponents} remarkPlugins={[remarkGfm]}>
            {plan.content}
          </ReactMarkdown>
        </div>
      )}

      {tasks.length > 0 && (
        <div className="space-y-4">
          <h3 className="font-medium text-muted-foreground text-sm uppercase tracking-wider">
            Tasks ({completed.length}/{tasks.length} completed)
          </h3>

          {pending.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-medium text-muted-foreground text-xs">
                Pending ({pending.length})
              </h4>
              {pending.map((task, i) => (
                <TaskItem key={task.id || i} task={task} />
              ))}
            </div>
          )}

          {completed.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-medium text-muted-foreground text-xs">
                Completed ({completed.length})
              </h4>
              {completed.map((task, i) => (
                <TaskItem key={task.id || i} task={task} />
              ))}
            </div>
          )}

          {manual.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-medium text-muted-foreground text-xs">
                Manual ({manual.length})
              </h4>
              {manual.map((task, i) => (
                <TaskItem key={task.id || i} task={task} />
              ))}
            </div>
          )}
        </div>
      )}

      {Array.isArray(plan.open_questions) && plan.open_questions.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-muted-foreground text-sm uppercase tracking-wider">
            Open Questions
          </h3>
          <ul className="space-y-2">
            {plan.open_questions.map((q, i) => (
              <li
                className="flex items-start gap-2 text-sm"
                key={
                  typeof q === "string"
                    ? q
                    : q.id || q.description || `q-${String(i)}`
                }
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-500" />
                <OpenQuestionItem question={q} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {Array.isArray(plan.gaps) && plan.gaps.length > 0 && (
        <div className="space-y-2">
          <h3 className="font-medium text-muted-foreground text-sm uppercase tracking-wider">
            Gaps
          </h3>
          <ul className="space-y-1">
            {plan.gaps.map((g, i) => (
              <li
                className="flex items-start gap-2 text-sm"
                key={typeof g === "string" ? g : `gap-${String(i)}`}
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />
                <span>{typeof g === "string" ? g : JSON.stringify(g)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
