import { existsSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { buildWorkspaceFileUrl } from "../app/lib/workspace-media.ts";
import type { ChatToolImage } from "../app/lib/types.ts";

export function chatImageAttachments(projectId: string, spaceDir: string, cwd: string, refs: string[]) {
  const root = resolve(spaceDir, "files");
  const byPath = new Map<string, ChatToolImage>();
  for (const ref of refs) {
    const path = resolve(root, ref);
    if (!path.startsWith(root + sep) || !existsSync(path)) continue;
    byPath.set(path, { url: buildWorkspaceFileUrl(projectId, relative(root, path), "inline"), alt: basename(path) });
  }
  return {
    paths: [...byPath.keys()],
    // Only return URLs for this turn's supplied attachments, never arbitrary Read paths.
    lookup(filePath: string) {
      const prefix = "$RELAYDESK_SPACE_DIR/";
      const path = filePath.startsWith(prefix) ? join(spaceDir, filePath.slice(prefix.length)) : resolve(cwd, filePath);
      return byPath.get(path);
    },
  };
}
