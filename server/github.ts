import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubError";
  }
}

export function githubTokenPath(dbPath: string): string {
  return join(dirname(dbPath), ".github-token");
}

export function hasGithubToken(dbPath: string): boolean {
  return existsSync(githubTokenPath(dbPath));
}

export function readGithubToken(dbPath: string): string | null {
  const path = githubTokenPath(dbPath);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8").trim() || null;
}

export function saveGithubToken(dbPath: string, token: string): void {
  const path = githubTokenPath(dbPath);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.github-token.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, token, { mode: 0o600, encoding: "utf8" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

export function deleteGithubToken(dbPath: string): void {
  const path = githubTokenPath(dbPath);
  try {
    unlinkSync(path);
  } catch {
    // ignore if absent
  }
}

export async function fetchGithubRepositories(
  token: string,
  page = 1,
): Promise<{ repos: string[]; more: boolean }> {
  const url = `https://api.github.com/user/repos?sort=updated&per_page=100&page=${page}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Relaydesk",
      },
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new GithubError("GitHub 拒绝了请求，请检查 token、组织授权和 API 配额。");
    }
    if (!response.ok) {
      throw new GithubError(`GitHub 返回 ${response.status}，请稍后重试。`);
    }
    const rows = (await response.json()) as Array<{ full_name?: string }>;
    if (!Array.isArray(rows)) {
      throw new GithubError("无法读取 GitHub 仓库，请稍后重试。");
    }
    const link = response.headers.get("link") ?? "";
    const repos = rows
      .map((r) => r?.full_name)
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    return { repos, more: link.includes('rel="next"') };
  } catch (err) {
    if (err instanceof GithubError) throw err;
    throw new GithubError("无法读取 GitHub 仓库，请稍后重试。");
  } finally {
    clearTimeout(timer);
  }
}
