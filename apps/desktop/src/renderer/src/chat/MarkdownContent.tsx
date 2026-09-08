import { memo, useMemo, useState, type ComponentProps } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkGemoji from "remark-gemoji";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import { Check, Copy, FileImage } from "lucide-react";
import type { Element, Nodes } from "hast";
import { Button } from "../components/ui/button";
import { useLocale } from "../locale";
import { reportError } from "../state";
import { externalMarkdownUrl, normalizeMathDelimiters } from "./markdown";
import "katex/dist/katex.min.css";

const remarkPlugins = [remarkGfm, remarkMath, remarkGemoji];
const rehypePlugins = [rehypeKatex, rehypeHighlight];
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

export const MarkdownContent = memo(function MarkdownContent({ value, onError }: { value: string; onError: (message?: string) => void }) {
  const { t } = useLocale();
  const content = useMemo(() => normalizeMathDelimiters(value), [value]);
  const components = useMemo<Components>(() => {
    const open = (href: string): void => { void window.prospero.openExternal(href).catch((reason: unknown) => onError(reportError(reason))); };
    return {
      pre: ({ node, children }) => <CodeBlock node={node} onError={onError}>{children}</CodeBlock>,
      a: ({ href, children }) => { const url = externalMarkdownUrl(href); return url ? <a href={url} onClick={(event) => { event.preventDefault(); open(url); }}>{children}</a> : <span>{children}</span>; },
      img: ({ src, alt }) => { const url = externalMarkdownUrl(typeof src === "string" ? src : undefined); return url ? <a className="chat-image-link" href={url} onClick={(event) => { event.preventDefault(); open(url); }}><FileImage aria-hidden="true" />{alt || t("查看图片", "View image")}</a> : <span>{alt}</span>; },
      table: ({ children }) => <div className="chat-table-scroll" tabIndex={0} role="region" aria-label={t("表格", "Table")}><table>{children}</table></div>,
    };
  }, [onError, t]);
  return <div className="chat-prose chat-markdown"><ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} skipHtml>{content}</ReactMarkdown></div>;
});
