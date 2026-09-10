import { parseMarkdown, type InlineSpan } from "./markdown";
import { resolveProjectFileReference, type ProjectFileReference } from "./file-references";

/** Only collect explicit file references from the final answer, never guesses from tool logs. */
export function resultFiles(source: string, projectRoot: string): ProjectFileReference[] {
  const files = new Map<string, ProjectFileReference>();
  const add = (target: string, explicit: boolean) => {
    const reference = resolveProjectFileReference(target, projectRoot, explicit);
    if (reference && !files.has(reference.path)) files.set(reference.path, reference);
  };
  const spans = (values: InlineSpan[]) => {
    for (const span of values) {
      if (span.href) add(span.href, true);
      else if (span.code) add(span.text, false);
    }
  };
  for (const block of parseMarkdown(source)) {
    if ("spans" in block) spans(block.spans);
    else if (block.type === "image") add(block.target, true);
    else if (block.type === "table") {
      block.headers.forEach(spans);
      block.rows.forEach((row) => row.forEach(spans));
    }
  }
  return [...files.values()];
}
