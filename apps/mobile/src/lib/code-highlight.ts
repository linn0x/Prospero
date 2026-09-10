import hljs from "highlight.js/lib/common";
import powershell from "highlight.js/lib/languages/powershell";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import dart from "highlight.js/lib/languages/dart";

hljs.registerLanguage("powershell", powershell);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("dart", dart);

export const MAX_HIGHLIGHT_CHARS = 80_000;
const MAX_HIGHLIGHT_TOKENS = 4_000;
export type SyntaxKind = "plain" | "keyword" | "string" | "comment" | "number" | "function" | "type" | "property" | "operator" | "added" | "removed";
export interface CodeToken { text: string; kind: SyntaxKind; rainbow?: number }
export interface CodeHighlight { tokens: CodeToken[]; language: string | null; limited: boolean }

const EXTENSIONS: Record<string, string> = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  py: "python", pyw: "python", pyi: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", cs: "csharp", swift: "swift", m: "objectivec", mm: "objectivec",
  json: "json", jsonc: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", conf: "ini", properties: "ini",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", svelte: "xml", css: "css", scss: "scss", less: "less",
  sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell", psm1: "powershell", psd1: "powershell",
  sql: "sql", graphql: "graphql", gql: "graphql", php: "php", rb: "ruby", rake: "ruby", pl: "perl", lua: "lua", r: "r", dart: "dart",
  md: "markdown", markdown: "markdown", mdx: "markdown", diff: "diff", patch: "diff",
};

export function codeLanguage(path: string): string | null {
  const name = path.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile";
  if (["makefile", "gnumakefile"].includes(name)) return "makefile";
  if ([".bashrc", ".zshrc", ".profile", ".bash_profile"].includes(name)) return "bash";
  if (name === ".env" || name.startsWith(".env.")) return "ini";
  return EXTENSIONS[name.slice(name.lastIndexOf(".") + 1)] ?? null;
}

export function isMarkdownFile(path: string): boolean { return codeLanguage(path) === "markdown"; }

function syntaxKind(scope: string, parent: SyntaxKind): SyntaxKind {
  if (/comment|doctag/.test(scope)) return "comment";
  if (/string|regexp/.test(scope)) return "string";
  if (/subst|params/.test(scope)) return "plain";
  if (/keyword|literal|selector-tag/.test(scope)) return "keyword";
  if (/number/.test(scope)) return "number";
  if (/title.*class|type|built_in/.test(scope)) return "type";
  if (/title|section/.test(scope)) return "function";
  if (/attr|property|variable|selector/.test(scope)) return "property";
  if (/operator|meta|tag|name/.test(scope)) return "operator";
  if (/addition/.test(scope)) return "added";
  if (/deletion/.test(scope)) return "removed";
  return parent;
}

/** highlight.js emits only escaped text and span tags. Render as native text, never as HTML. */
function nativeTokens(html: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const scopes: SyntaxKind[] = ["plain"];
  const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
  for (const part of html.match(/<span\b[^>]*>|<\/span>|[^<]+/g) ?? []) {
    if (part.startsWith("<span")) {
      scopes.push(syntaxKind(/class="([^"]*)"/.exec(part)?.[1] ?? "", scopes.at(-1)!));
    } else if (part === "</span>") {
      if (scopes.length > 1) scopes.pop();
    } else {
      tokens.push({ text: part.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (entity) => entities[entity]!), kind: scopes.at(-1)! });
    }
    if (tokens.length > MAX_HIGHLIGHT_TOKENS) break;
  }
  return tokens;
}

function rainbowBrackets(tokens: CodeToken[]): CodeToken[] {
  const result: CodeToken[] = [];
  const stack: string[] = [];
  const matching: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (const token of tokens) {
    if (token.kind === "string" || token.kind === "comment") { result.push(token); continue; }
    for (const part of token.text.split(/([()[\]{}])/)) {
      if (!part) continue;
      if (/^[([{]$/.test(part)) {
        result.push({ ...token, text: part, rainbow: stack.length % 6 });
        stack.push(part);
      } else if (matching[part] && stack.at(-1) === matching[part]) {
        stack.pop();
        result.push({ ...token, text: part, rainbow: stack.length % 6 });
      } else result.push({ ...token, text: part });
    }
    if (result.length > MAX_HIGHLIGHT_TOKENS) break;
  }
  return result;
}

export function highlightCode(code: string, languageHint?: string | null, rainbow = true): CodeHighlight {
  const language = languageHint && hljs.getLanguage(languageHint) ? languageHint : null;
  const plain = (limited = false): CodeHighlight => ({ tokens: [{ text: code, kind: "plain" }], language, limited });
  if (code.length > MAX_HIGHLIGHT_CHARS) return plain(true);
  if (!language || language === "plaintext") return plain();
  try {
    const tokens = nativeTokens(hljs.highlight(code, { language, ignoreIllegals: true }).value);
    const result = rainbow ? rainbowBrackets(tokens) : tokens;
    // Never lose source text, even if a grammar or token limit cannot handle the file.
    if (result.length > MAX_HIGHLIGHT_TOKENS || result.map((token) => token.text).join("") !== code) return plain(true);
    return { tokens: result, language, limited: false };
  } catch { return plain(); }
}

export const SYNTAX_COLORS: Record<"light" | "dark", Record<SyntaxKind, string>> = {
  dark: { plain: "#F5F7FA", keyword: "#CF9FFF", string: "#8DDDAD", comment: "#929BA8", number: "#F0BE78",
    function: "#80BFFF", type: "#FFD580", property: "#EFA0BC", operator: "#79D8DD", added: "#8DDDAD", removed: "#FF9C9C" },
  light: { plain: "#11151B", keyword: "#7B32A8", string: "#227042", comment: "#667180", number: "#925B09",
    function: "#205EAD", type: "#795610", property: "#A23067", operator: "#096A72", added: "#227042", removed: "#AD3030" },
};
export const RAINBOW_COLORS = {
  dark: ["#FFD580", "#CF9FFF", "#79D8DD", "#EFA0BC", "#8DDDAD", "#80BFFF"],
  light: ["#795610", "#7B32A8", "#096A72", "#A23067", "#227042", "#205EAD"],
};
