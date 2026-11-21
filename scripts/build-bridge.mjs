#!/usr/bin/env node
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entryFile = resolve(rootDir, "agent/bridge/index.ts");
const defaultOutFile = resolve(rootDir, "build/bridge/relaydesk-bridge.mjs");

function loadEsbuild() {
  try {
    const req = createRequire(import.meta.resolve("vite"));
    return req("esbuild");
  } catch {
    const req = createRequire(import.meta.url);
    return req("esbuild");
  }
}

export async function buildBridgeBundle(outFile = defaultOutFile) {
  const esbuild = loadEsbuild();
  const targetPath = resolve(outFile);
  mkdirSync(dirname(targetPath), { recursive: true });

  await esbuild.build({
    entryPoints: [entryFile],
    outfile: targetPath,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    minify: false,
    legalComments: "none",
    external: ["bufferutil", "utf-8-validate"],
    banner: {
      js: [
        "#!/usr/bin/env node",
        'import { createRequire as __relaydeskCreateRequire } from "node:module";',
        "const require = __relaydeskCreateRequire(import.meta.url);",
      ].join("\n"),
    },
  });

  chmodSync(targetPath, 0o755);
  const content = readFileSync(targetPath);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const size = statSync(targetPath).size;
  return { outFile: targetPath, sha256, size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const customOut = process.argv[2];
  const result = await buildBridgeBundle(customOut);
  console.log(
    `[build-bridge] built ${result.outFile} (${(result.size / 1024).toFixed(1)} KiB, sha256=${result.sha256.slice(0, 12)}…)`,
  );
}
