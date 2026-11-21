import { isIP } from "node:net";

export function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "::1" || lower === "[::1]") return true;
  const bare = lower.startsWith("[") && lower.endsWith("]") ? lower.slice(1, -1) : lower;
  const ipVersion = isIP(bare);
  if (ipVersion === 4) {
    return bare.startsWith("127.");
  }
  if (ipVersion === 6) {
    return bare === "::1" || bare === "0:0:0:0:0:0:0:1" || bare.startsWith("::ffff:127.");
  }
  return false;
}
