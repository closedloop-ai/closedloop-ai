"use client";

import {
  ChevronRight,
  File,
  FileCode,
  FileJson2,
  FileText,
  LayoutDashboard,
  Terminal,
} from "lucide-react";
import { useState } from "react";
import type { FileTreeNode } from "@/types/run-viewer";

type FileTreeSidebarProps = {
  tree: FileTreeNode;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
};

const HIDDEN_DIRS = new Set([".learnings", ".symphony"]);

function getFileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (ext === "md") {
    return <FileText className="size-3.5 text-blue-400" />;
  }
  if (ext === "json" || ext === "jsonl") {
    return <FileJson2 className="size-3.5 text-amber-400" />;
  }
  if (
    ext === "yaml" ||
    ext === "yml" ||
    ext === "ts" ||
    ext === "tsx" ||
    ext === "js"
  ) {
    return <FileCode className="size-3.5 text-green-400" />;
  }
  if (ext === "log" || ext === "sh") {
    return <Terminal className="size-3.5 text-violet-400" />;
  }
  return <File className="size-3.5 text-muted-foreground" />;
}

function TreeNode({
  node,
  selectedPath,
  onSelectFile,
  depth,
}: Readonly<{
  node: FileTreeNode;
  selectedPath: string | null;
  onSelectFile: (path: string | null) => void;
  depth: number;
}>) {
  const isHidden = HIDDEN_DIRS.has(node.name);
  const [expanded, setExpanded] = useState(!isHidden);

  if (node.isDirectory) {
    return (
      <div>
        <button
          className={`flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors hover:bg-muted/50 ${
            isHidden ? "text-muted-foreground/50" : ""
          }`}
          onClick={() => setExpanded(!expanded)}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <ChevronRight
            className={`size-3 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <span className="truncate font-medium text-xs">{node.name}</span>
        </button>
        {expanded && (
          <div>
            {node.children.map((child) => (
              <TreeNode
                depth={depth + 1}
                key={child.path}
                node={child}
                onSelectFile={onSelectFile}
                selectedPath={selectedPath}
              />
            ))}
          </div>
        )}
      </div>
    );
  }

  const isSelected = selectedPath === node.path;

  return (
    <button
      className={`flex w-full items-center gap-1.5 px-2 py-1 text-left transition-colors ${
        isSelected ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"
      }`}
      onClick={() => onSelectFile(node.path)}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      {getFileIcon(node.name)}
      <span className="truncate text-xs">{node.name}</span>
    </button>
  );
}

export function FileTreeSidebar({
  tree,
  selectedPath,
  onSelectFile,
}: Readonly<FileTreeSidebarProps>) {
  const isOverview = selectedPath === null;

  return (
    <div className="h-full overflow-auto py-1">
      <button
        className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors ${
          isOverview ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"
        }`}
        onClick={() => onSelectFile(null)}
      >
        <LayoutDashboard className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-xs">Overview</span>
      </button>
      {tree.children.map((node) => (
        <TreeNode
          depth={0}
          key={node.path}
          node={node}
          onSelectFile={onSelectFile}
          selectedPath={selectedPath}
        />
      ))}
    </div>
  );
}
