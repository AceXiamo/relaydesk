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
  "bot",
  "building-2",
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
  "code-2",
  "command",
  "copy",
  "corner-down-left",
  "cpu",
  "external-link",
  "eye",
  "eye-off",
  "file-check-2",
  "file-text",
  "filter",
  "folder-git-2",
  "git-branch",
  "git-merge",
  "github",
  "hand",
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
  "pause-circle",
  "pen-line",
  "plug",
  "plus",
  "radio",
  "refresh-cw",
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
  "sun",
  "terminal",
  "trash-2",
  "unlink",
  "user",
  "user-check",
  "wallet",
  "wifi",
  "wifi-off",
  "x",
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
    ],
  },
  server: {
    port: 8787,
  },
});
