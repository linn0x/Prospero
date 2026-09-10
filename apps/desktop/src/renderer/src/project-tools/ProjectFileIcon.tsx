import { Braces, File, FileCode2, FileImage, FileJson2, FileText, GitBranch, Settings2, SquareTerminal } from "lucide-react";

export function ProjectFileIcon({ path }: { path: string }) {
  const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  const extension = name.split(".").at(-1) ?? "";
  const kind = name.startsWith(".git") ? "git" : /^(png|jpg|jpeg|gif|webp|svg|ico|avif)$/.test(extension) ? "image" : /^(md|mdx|txt|log)$/.test(extension) ? "text" : /^(json|jsonc)$/.test(extension) ? "json" : /^(toml|yaml|yml|ini|env|conf)$/.test(extension) || name.startsWith(".") ? "config" : /^(sh|bash|zsh|ps1|bat|cmd)$/.test(extension) ? "shell" : /^(css|scss|sass|less)$/.test(extension) ? "style" : /^(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|c|cpp|h|swift|rb|html)$/.test(extension) ? "code" : "file";
  const Icon = { git: GitBranch, image: FileImage, text: FileText, json: FileJson2, config: Settings2, shell: SquareTerminal, style: Braces, code: FileCode2, file: File }[kind];
  return <Icon className="project-file-icon" data-file-kind={kind} aria-hidden="true" />;
}
