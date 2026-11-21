import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Icons used across the Relaydesk console. Bundled at build time from
// @iconify-json/lucide so the app makes zero external icon CDN requests.
const LUCIDE_ICONS = [
  "alert-circle",
  "alert-triangle",
  "archive",
  "arrow-down",
  "arrow-left",
  "arrow-right",
  "arrow-up",
  "arrow-up-down",
  "arrow-up-right",
  "at-sign",
  "book-open",
  "bot",
  "building-2",
  "camera",
  "check",
  "check-check",
  "check-circle-2",
  "chevron-down",
  "chevron-left",
  "chevron-right",
  "chevrons-up-down",
  "circle",
  "circle-dashed",
  "circle-dot",
  "clock",
  "cloud",
  "code-2",
  "command",
  "copy",
  "corner-down-left",
  "cpu",
  "database",
  "download",
  "external-link",
  "eye",
  "eye-off",
  "file",
  "file-check-2",
  "file-code-2",
  "file-plus-2",
  "file-spreadsheet",
  "file-text",
  "filter",
  "folder",
  "folder-git-2",
  "folder-open",
  "folder-plus",
  "git-branch",
  "git-commit-horizontal",
  "git-merge",
  "git-pull-request",
  "github",
  "hand",
  "hard-drive",
  "image",
  "inbox",
  "key-round",
  "layers",
  "link-2",
  "list-filter",
  "loader-2",
  "lock",
  "log-out",
  "menu",
  "message-square",
  "message-square-plus",
  "moon",
  "more-horizontal",
  "panel-left-close",
  "panel-left-open",
  "panel-right-close",
  "panel-right-open",
  "paperclip",
  "pause-circle",
  "pen-line",
  "play",
  "plug",
  "plus",
  "radio",
  "refresh-cw",
  "save",
  "search",
  "send",
  "settings",
  "shield",
  "shield-alert",
  "shield-check",
  "signal",
  "signal-high",
  "signal-low",
  "signal-medium",
  "sliders-horizontal",
  "sparkles",
  "square",
  "sun",
  "table-2",
  "terminal",
  "trash-2",
  "unlink",
  "upload",
  "user",
  "user-check",
  "wallet",
  "wifi",
  "wifi-off",
  "wrench",
  "x",
  "x-circle",
  "zap",
];

function lucideSubsetPlugin(): Plugin {
  const virtualId = "virtual:lucide-subset";
  const resolvedId = "\0" + virtualId;
  return {
    name: "relaydesk-lucide-subset",
    resolveId(id) {
      if (id === virtualId) return resolvedId;
      return null;
    },
    load(id) {
      if (id !== resolvedId) return null;
      const jsonPath = require.resolve("@iconify-json/lucide/icons.json");
      const full = JSON.parse(readFileSync(jsonPath, "utf-8"));
      const icons: Record<string, unknown> = {};
      for (const name of LUCIDE_ICONS) {
        if (full.icons[name]) {
          icons[name] = full.icons[name];
        }
      }
      const subset = {
        prefix: full.prefix,
        width: full.width ?? 24,
        height: full.height ?? 24,
        icons,
      };
      return `export default ${JSON.stringify(subset)};`;
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), lucideSubsetPlugin(), reactRouter()],
  resolve: {
    alias: {
      "~": "/app",
    },
    dedupe: ["react", "react-dom", "react-router"],
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "react-router",
      "@iconify/react",
      "react-markdown",
      "remark-gfm",
    ],
  },
  server: {
    port: 8787,
  },
});
