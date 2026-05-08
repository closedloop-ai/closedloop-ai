export type FileTreeNode = {
  name: string;
  path: string;
  isDirectory: boolean;
  children: FileTreeNode[];
};

export type RunData = {
  files: Map<string, Uint8Array>;
  tree: FileTreeNode;
};
