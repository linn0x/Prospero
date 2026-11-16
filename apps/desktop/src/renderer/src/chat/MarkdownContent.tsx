import { memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkGemoji from "remark-gemoji";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { common, type LanguageFn } from "lowlight";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import { Check, Copy, FileImage } from "lucide-react";
import type { Element, Nodes } from "hast";
import { Button } from "../components/ui/button";
import { useLocale } from "../locale";
import { reportError } from "../state";
import { externalMarkdownUrl, normalizeMathDelimiters } from "./markdown";
import { resolveProjectFileReference } from "./file-references";
import { openProjectFile } from "../project-tools/tool-state";
import { terminalPlainText } from "../terminal-text";
import "katex/dist/katex.min.css";

export const MARKDOWN_STREAM_THROTTLE_MS = 65;

const zigLanguage: LanguageFn = (hljs) => ({
  name: "Zig",
  aliases: ["zig"],
  keywords: {
    keyword:
      "addrspace align allowzero and anyframe anytype asm async await break callconv catch comptime const continue defer else enum errdefer error export extern fn for if inline noalias nosuspend noinline opaque or orelse packed pub resume return linksection struct suspend switch test threadlocal try union unreachable usingnamespace var volatile while",
    literal: "true false null undefined",
    type:
      "bool f16 f32 f64 f80 f128 usize isize c_char c_short c_ushort c_int c_uint c_long c_ulong c_longlong c_ulonglong c_longdouble anyerror void noreturn type comptime_int comptime_float",
  },
  contains: [
    hljs.C_LINE_COMMENT_MODE,
    hljs.QUOTE_STRING_MODE,
    hljs.APOS_STRING_MODE,
    hljs.C_NUMBER_MODE,
    { className: "built_in", begin: /@[A-Za-z_]\w*/ },
    { className: "type", begin: /\b[iu]\d+\b/ },
  ],
});

export const MARKDOWN_HIGHLIGHT_LANGUAGES: Record<string, LanguageFn> = {
  ...common,
  dockerfile,
  ...(common.ini ? { toml: common.ini } : {}),
  zig: zigLanguage,
};

const highlightAliases: Record<string, string[]> = {
  dockerfile: ["docker"],
  ini: ["toml"],
};

const remarkPlugins: NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]> = [remarkGfm, remarkMath, remarkGemoji];
const rehypePlugins: NonNullable<ComponentProps<typeof ReactMarkdown>["rehypePlugins"]> = [
  rehypeKatex,
  [rehypeHighlight, { detect: false, languages: MARKDOWN_HIGHLIGHT_LANGUAGES, aliases: highlightAliases }],
];

function nodeText(node: Nodes): string {
  return node.type === "text" ? node.value : "children" in node ? node.children.map(nodeText).join("") : "";
}

function CodeBlock({ node, children, onError }: Omit<ComponentProps<"pre">, "onError"> & { node?: Element | undefined; onError: (message?: string) => void }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const code = node?.children.find((child): child is Element => child.type === "element" && child.tagName === "code");
  const language = Array.isArray(code?.properties.className) ? code.properties.className.find((name) => String(name).startsWith("language-"))?.toString().slice(9) : undefined;
  const copy = async (): Promise<void> => {
    try { await window.prospero.writeClipboard(code ? nodeText(code).replace(/\n$/, "") : ""); setCopied(true); }
    catch (reason) { onError(reportError(reason)); }
  };
  return <section className="chat-code-block"><header><span>{language || t("代码", "Code")}</span><Button variant="ghost" size="xs" onClick={() => void copy()} onBlur={() => setCopied(false)}>{copied ? <Check /> : <Copy />}{copied ? t("已复制", "Copied") : t("复制", "Copy")}</Button></header><pre>{children}</pre></section>;
}

export function createMarkdownStreamThrottle(
  onCommit: (next: string) => void,
  intervalMs = MARKDOWN_STREAM_THROTTLE_MS,
) {
  let latest = "";
  let rendered = "";
  let lastCommitAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    init(initial: string): void {
      latest = initial;
      rendered = initial;
      if (lastCommitAt === null) lastCommitAt = Date.now();
    },
    push(value: string, streaming?: boolean): void {
      latest = value;
      if (streaming === false) {
        cancel();
        if (rendered !== value) {
          rendered = value;
          lastCommitAt = Date.now();
          onCommit(value);
        }
        return;
      }
      if (rendered === value) {
        if (lastCommitAt === null) lastCommitAt = Date.now();
        return;
      }
      const now = Date.now();
      const elapsed = lastCommitAt === null ? intervalMs : now - lastCommitAt;
      if (elapsed >= intervalMs && timer === undefined) {
        rendered = value;
        lastCommitAt = now;
        onCommit(value);
        return;
      }
      if (timer === undefined) {
        const wait = Math.max(1, intervalMs - Math.max(0, elapsed));
        timer = setTimeout(() => {
          timer = undefined;
          rendered = latest;
          lastCommitAt = Date.now();
          onCommit(latest);
        }, wait);
      }
    },
    dispose: cancel,
  };
}

function useThrottledMarkdownValue(value: string, streaming?: boolean): string {
  const [rendered, setRendered] = useState(value);
  const controllerRef = useRef<ReturnType<typeof createMarkdownStreamThrottle> | null>(null);
  if (controllerRef.current === null) {
    const controller = createMarkdownStreamThrottle(setRendered);
    controller.init(value);
    controllerRef.current = controller;
  }

  useEffect(() => {
    controllerRef.current?.push(value, streaming);
  }, [value, streaming]);

  useEffect(() => () => {
    controllerRef.current?.dispose();
  }, []);

  return streaming === false ? value : rendered;
}

export function splitStreamingMarkdown(content: string): { prefix: string; tail: string } | null {
  if (content.length < 400) return null;
  if (/^\s*\[[^\]]+\]:/m.test(content) || /\[\^[^\]]+\]/.test(content)) return null;

  const lines = content.split("\n");
  let inFence: { char: string; length: number } | null = null;
  let inMathBlock = false;
  let offset = 0;
  let lastSafeSplitOffset = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();

    if (inFence) {
      const closeMatch = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (closeMatch && closeMatch[1]![0] === inFence.char && closeMatch[1]!.length >= inFence.length) {
        inFence = null;
      }
    } else {
      const openMatch = trimmed.match(/^(`{3,}|~{3,})/);
      if (openMatch) {
        const marker = openMatch[1]!;
        const rest = trimmed.slice(marker.length);
        if (!rest.includes(marker)) {
          inFence = { char: marker[0]!, length: marker.length };
        }
      } else {
        const mathMatches = line.match(/\$\$/g);
        if (mathMatches && mathMatches.length % 2 === 1) {
          inMathBlock = !inMathBlock;
        }
      }
    }

    const lineEndOffset = offset + line.length + (i < lines.length - 1 ? 1 : 0);
    if (!inFence && !inMathBlock && trimmed === "" && i + 1 < lines.length) {
      const nextLine = lines[i + 1]!;
      const nextTrimmed = nextLine.trim();
      if (
        nextTrimmed.length > 0 &&
        !/^(?: {2,}|\t)/.test(nextLine) &&
        !/^\s*(?:[-*+]|\d+[.)]|\||>)/.test(nextLine)
      ) {
        lastSafeSplitOffset = lineEndOffset;
      }
    }
    offset = lineEndOffset;
  }

  if (lastSafeSplitOffset <= 0 || lastSafeSplitOffset >= content.length) return null;
  return {
    prefix: content.slice(0, lastSafeSplitOffset),
    tail: content.slice(lastSafeSplitOffset),
  };
}

const MemoizedMarkdownChunk = memo(function MemoizedMarkdownChunk({
  content,
  onError,
  projectRoot,
}: {
  content: string;
  onError: (message?: string) => void;
  projectRoot?: string | undefined;
}) {
  const { t } = useLocale();
  const components = useMemo<Components>(() => {
    const open = (href: string): void => { void window.prospero.openExternal(href).catch((reason: unknown) => onError(reportError(reason))); };
    return {
      pre: ({ node, children }) => <CodeBlock node={node} onError={onError}>{children}</CodeBlock>,
      a: ({ href, children }) => {
        const file = projectRoot && href ? resolveProjectFileReference(href, projectRoot, true) : null;
        if (file && projectRoot) return <a href={href} title={file.path} onClick={event => { event.preventDefault(); openProjectFile(projectRoot, file); }}>{children}</a>;
        const url = externalMarkdownUrl(href);
        return url ? <a href={url} onClick={(event) => { event.preventDefault(); open(url); }}>{children}</a> : <span>{children}</span>;
      },
      img: ({ src, alt }) => {
        const target = typeof src === "string" ? src : "";
        const file = projectRoot ? resolveProjectFileReference(target, projectRoot, true) : null;
        if (file && projectRoot) return <a className="chat-image-link" href={target} onClick={event => { event.preventDefault(); openProjectFile(projectRoot, file); }}><FileImage aria-hidden="true" />{alt || file.path}</a>;
        const url = externalMarkdownUrl(target);
        return url ? <a className="chat-image-link" href={url} onClick={(event) => { event.preventDefault(); open(url); }}><FileImage aria-hidden="true" />{alt || t("查看图片", "View image")}</a> : <span>{alt}</span>;
      },
      table: ({ children }) => <div className="chat-table-scroll" tabIndex={0} role="region" aria-label={t("表格", "Table")}><table>{children}</table></div>,
    };
  }, [onError, t, projectRoot]);
  const urlTransform = useCallback(
    (url: string) => (projectRoot && resolveProjectFileReference(url, projectRoot, true) ? url : defaultUrlTransform(url)),
    [projectRoot],
  );
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={urlTransform} skipHtml>
      {content}
    </ReactMarkdown>
  );
});

const MemoizedMarkdownBody = memo(function MemoizedMarkdownBody({
  value,
  onError,
  projectRoot,
  streaming,
}: {
  value: string;
  onError: (message?: string) => void;
  projectRoot?: string | undefined;
  streaming?: boolean | undefined;
}) {
  const content = useMemo(() => normalizeMathDelimiters(terminalPlainText(value)), [value]);
  const split = useMemo(() => (streaming ? splitStreamingMarkdown(content) : null), [content, streaming]);
  return (
    <div className="chat-prose chat-markdown">
      {split ? (
        <>
          <MemoizedMarkdownChunk content={split.prefix} onError={onError} projectRoot={projectRoot} />
          <MemoizedMarkdownChunk content={split.tail} onError={onError} projectRoot={projectRoot} />
        </>
      ) : (
        <MemoizedMarkdownChunk content={content} onError={onError} projectRoot={projectRoot} />
      )}
    </div>
  );
});

export const MarkdownContent = memo(function MarkdownContent({
  value,
  onError,
  projectRoot,
  streaming,
}: {
  value: string;
  onError: (message?: string) => void;
  projectRoot?: string | undefined;
  streaming?: boolean | undefined;
}) {
  const throttled = useThrottledMarkdownValue(value, streaming);
  return <MemoizedMarkdownBody value={throttled} onError={onError} projectRoot={projectRoot} streaming={streaming} />;
});
