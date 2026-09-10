import { useCallback, useEffect, useRef } from "react";
import { router } from "expo-router";
import { toB64 } from "@prospero/protocol";
import { Markdown } from "./Markdown";
import type { HostConnection } from "@/lib/connection";
import { downloadFileChunks } from "@/lib/file-transfer";
import { resolveMarkdownFileReference, type ProjectFileReference } from "@/lib/file-references";

export function MarkdownFile({ source, filePath, projectRoot, hostId, sid, conn }: {
  source: string; filePath: string; projectRoot?: string; hostId: string; sid: string; conn: HostConnection | null;
}) {
  const images = useRef(new Map<string, Promise<string>>());
  useEffect(() => { images.current = new Map(); }, [conn, sid, filePath]);
  const resolveReference = useCallback((target: string, explicit: boolean) =>
    resolveMarkdownFileReference(target, filePath, projectRoot ?? "/", explicit), [filePath, projectRoot]);
  const openFile = useCallback((reference: ProjectFileReference) => {
    router.push({ pathname: "/host/[hostId]/preview/[sid]", params: {
      hostId, sid, path: reference.path,
      ...(reference.line ? { line: String(reference.line) } : {}),
      ...(reference.column ? { column: String(reference.column) } : {}),
    } });
  }, [hostId, sid]);
  const loadImage = useCallback((reference: ProjectFileReference): Promise<string> => {
    const cache = images.current;
    const cached = cache.get(reference.path);
    if (cached) return cached;
    const request = (async () => {
      if (!conn) throw new Error("设备未连接");
      const extension = reference.path.split(".").at(-1)?.toLowerCase() ?? "";
      const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as Record<string, string>)[extension];
      if (!mime) throw new Error("不支持这种图片格式");
      const chunks: Uint8Array[] = [];
      const size = await downloadFileChunks(async (offset, length) => {
        const chunk = await conn.fsGetChunk(sid, reference.path, offset, length);
        if (chunk.total > 6 * 1024 * 1024) throw new Error("图片超过 6 MB，请点按打开文件");
        return chunk;
      }, (chunk) => chunks.push(chunk), 192 * 1024);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return `data:${mime};base64,${toB64(bytes)}`;
    })().catch((error: unknown) => { cache.delete(reference.path); throw error; });
    // Limit retained image data when a document contains many images.
    if (cache.size >= 12) cache.delete(cache.keys().next().value!);
    cache.set(reference.path, request);
    return request;
  }, [conn, sid]);
  return <Markdown source={source} projectRoot={projectRoot} resolveFileReference={resolveReference}
    onOpenFile={openFile} loadProjectImage={loadImage} />;
}
