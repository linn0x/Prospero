import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { Nodes } from "mdast";
import { resolveProjectFileReference, type ProjectFileReference } from "./file-references";

const parser = unified().use(remarkParse).use(remarkGfm);

/** Collect explicit Markdown links/images, including references, from the final answer. */
export function resultFiles(value: string, root: string): ProjectFileReference[] {
  const tree = parser.parse(value);
  const definitions = new Map<string, string>();
  const files = new Map<string, ProjectFileReference>();
  const walk = (node: Nodes, visit: (node: Nodes) => void): void => {
    visit(node);
    if ("children" in node) node.children.forEach(child => walk(child, visit));
  };
  walk(tree, node => { if (node.type === "definition") definitions.set(node.identifier.toUpperCase(), node.url); });
  walk(tree, node => {
    const target = node.type === "link" || node.type === "image" ? node.url
      : node.type === "linkReference" || node.type === "imageReference" ? definitions.get(node.identifier.toUpperCase()) : undefined;
    if (!target) return;
    const file = resolveProjectFileReference(target, root, true);
    if (file && !files.has(file.path)) files.set(file.path, file);
  });
  return [...files.values()];
}
