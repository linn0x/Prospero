#!/usr/bin/env node
/**
 * 生成 src/components/terminal-html.ts:把 apps/daemon/term.html(唯一源)里
 * 引用的 xterm 资产内联,产出一个自包含 HTML 字符串给 WebView 直接渲染。
 *
 * 为什么内联:WebView 若从 daemon 的 HTTP 加载页面,daemon 短暂不可用就会
 * 永久停在错误页(重连后不会自动重载);内联后终端渲染完全不依赖 daemon HTTP,
 * 并省掉每次开会话 ~745KB 的网络传输(直接服务 A1「attach <200ms」)。
 *
 * 用法:node scripts/build-terminal-html.mjs(xterm 依赖升级后重跑)
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const nm = path.join(repoRoot, "node_modules");

const read = (p) => readFileSync(p, "utf8");

const assets = {
  "/assets/xterm.css": read(path.join(nm, "@xterm/xterm/css/xterm.css")),
  "/assets/xterm.js": read(path.join(nm, "@xterm/xterm/lib/xterm.js")),
  "/assets/fit.js": read(path.join(nm, "@xterm/addon-fit/lib/addon-fit.js")),
  "/assets/webgl.js": read(path.join(nm, "@xterm/addon-webgl/lib/addon-webgl.js")),
};

let html = read(path.join(repoRoot, "apps/daemon/term.html"));

// 注意:替换串必须走函数形式 —— vendor 代码里的 `$'` / `$&` 在字符串形式的
// replace 里会被当作特殊模式展开,导致内容错乱。
const cssTag = '<link rel="stylesheet" href="/assets/xterm.css" />';
if (!html.includes(cssTag)) throw new Error("term.html 缺少 xterm.css 引用");
html = html.replace(cssTag, () => `<style>\n${assets["/assets/xterm.css"]}\n</style>`);

for (const src of ["/assets/xterm.js", "/assets/fit.js", "/assets/webgl.js"]) {
  const tag = `<script src="${src}"></script>`;
  if (!html.includes(tag)) throw new Error(`term.html 缺少预期的 script 标签: ${src}`);
  // </script> 出现在被内联的代码里会提前闭合标签,做转义
  const code = assets[src].replace(/<\/script>/gi, "<\\/script>");
  html = html.replace(tag, () => `<script>\n${code}\n</script>`);
}

// 只检查标签引用(内联的 vendor 代码里可能自带 "/assets/" 字面量)
const leftover = html.match(/(?:src|href)="\/assets\/[^"]*"/g);
if (leftover) {
  throw new Error(`仍有未内联的资产引用: ${leftover.join(", ")}`);
}

const out = `// 本文件由 scripts/build-terminal-html.mjs 自动生成,请勿手工编辑。
// 源:apps/daemon/term.html + node_modules/@xterm/*
export const TERMINAL_HTML = ${JSON.stringify(html)};
`;

const outPath = path.join(here, "../src/components/terminal-html.ts");
writeFileSync(outPath, out);
console.log(`已生成 ${path.relative(repoRoot, outPath)}(${Math.round(out.length / 1024)} KB)`);
