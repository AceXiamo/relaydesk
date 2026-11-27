import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkspaceDatabaseKind } from "../app/lib/types.ts";
import { redactSecrets } from "./cli-stream-parser.ts";

export type RelaydeskTaskAction =
  | "list_tasks"
  | "get_task"
  | "comment_task"
  | "update_task"
  | "transition_task"
  | "create_task"
  | "list_releases"
  | "checkpoint_release"
  | "finish_release";

export interface RelaydeskMcpTaskClient {
  call(action: RelaydeskTaskAction, params: Record<string, unknown>): Promise<unknown>;
}

export type RelaydeskDelegateAction =
  | "delegate_task"
  | "check_delegated_task"
  | "wait_delegated_task"
  | "cancel_delegated_task";

export interface RelaydeskMcpDelegateClient {
  call(action: RelaydeskDelegateAction, params: Record<string, unknown>): Promise<unknown>;
}

export interface RelaydeskMcpDatasourceMeta {
  id?: string;
  name: string;
  kind: WorkspaceDatabaseKind;
  source: "workspace_file" | "external";
  file_path?: string;
  env_var?: string;
  host_preview?: string;
  read_only?: boolean;
  notes?: string;
  has_connection_url?: boolean;
}

export interface RelaydeskMcpOptions {
  projectId: string;
  spaceDir: string;
  databases: RelaydeskMcpDatasourceMeta[];
  datasourceEnv?: Record<string, string>;
  allowDatasourceSecrets: boolean;
  secrets?: string[];
  taskClient?: RelaydeskMcpTaskClient;
  delegateClient?: RelaydeskMcpDelegateClient;
  signal?: AbortSignal;
  dbBinaries?: Partial<Record<"psql" | "mysql" | "redis-cli" | "mongosh", string>>;
}

export interface RelaydeskMcpHandle {
  url: string;
  token: string;
  claudeConfigObject(): Record<string, unknown>;
  close(): Promise<void>;
}

const MAX_MCP_BODY_BYTES = 1024 * 1024;
const MAX_SQL_CHARS = 16_000;
const MAX_QUERY_ROWS = 500;
const MAX_CLI_STDOUT_BYTES = 256 * 1024;
const DEFAULT_DB_TIMEOUT_MS = 15_000;

const FORBIDDEN_SQL_KEYWORDS = new RegExp(
  "\\b(?:" +
    [
      "INSERT",
      "UPDATE",
      "DELETE",
      "DROP",
      "ALTER",
      "TRUNCATE",
      "CREATE",
      "REPLACE",
      "MERGE",
      "GRANT",
      "REVOKE",
      "VACUUM",
      "REINDEX",
      "CLUSTER",
      "LOCK",
      "UNLOCK",
      "CALL",
      "DO",
      "COPY",
      "EXEC",
      "EXECUTE",
      "PREPARE",
      "DEALLOCATE",
      "SET",
      "RESET",
      "DISCARD",
      "BEGIN",
      "START",
      "COMMIT",
      "ROLLBACK",
      "SAVEPOINT",
      "RELEASE",
      "LISTEN",
      "NOTIFY",
      "UNLISTEN",
      "CHECKPOINT",
      "ATTACH",
      "DETACH",
      "REFRESH",
      "LOAD",
      "HANDLER",
      "KILL",
      "FLUSH",
      "PURGE",
      "RENAME",
      "REPAIR",
      "OPTIMIZE",
      "INSTALL",
      "UNINSTALL",
      "SHUTDOWN",
    ].join("|") +
    ")\\b",
  "i",
);

const FORBIDDEN_SQL_PHRASES = [
  /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i,
  /\bLOAD_FILE\s*\(/i,
  /\bPG_READ_FILE\s*\(/i,
  /\bPG_READ_BINARY_FILE\s*\(/i,
  /\bPG_LS_DIR\s*\(/i,
  /\bPG_STAT_FILE\s*\(/i,
  /\bPG_TERMINATE_BACKEND\s*\(/i,
  /\bPG_CANCEL_BACKEND\s*\(/i,
  /\bLO_IMPORT\s*\(/i,
  /\bLO_EXPORT\s*\(/i,
  /\bDBLINK(?:_EXEC)?\s*\(/i,
];

const REDIS_READONLY_COMMANDS = new Set([
  "GET",
  "MGET",
  "GETRANGE",
  "STRLEN",
  "EXISTS",
  "TYPE",
  "TTL",
  "PTTL",
  "HGET",
  "HMGET",
  "HGETALL",
  "HKEYS",
  "HVALS",
  "HLEN",
  "HEXISTS",
  "HSCAN",
  "LRANGE",
  "LLEN",
  "LINDEX",
  "LPOS",
  "SMEMBERS",
  "SCARD",
  "SISMEMBER",
  "SMISMEMBER",
  "SSCAN",
  "ZRANGE",
  "ZREVRANGE",
  "ZRANGEBYSCORE",
  "ZREVRANGEBYSCORE",
  "ZCARD",
  "ZSCORE",
  "ZCOUNT",
  "ZRANK",
  "ZREVRANK",
  "ZSCAN",
  "XRANGE",
  "XREVRANGE",
  "XLEN",
  "XINFO",
  "SCAN",
  "DBSIZE",
  "INFO",
  "PING",
  "TIME",
]);

/**
 * Replaces comments and string literals with single spaces so structural SQL checks
 * cannot be fooled by tokens inside quotes or comments.
 */
function stripSqlCommentsAndLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    const next = sql[i + 1];
    // Line comment --
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    // MySQL line comment #
    if (ch === "#") {
      i += 1;
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    // Block comment /* ... */
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(n, i + 2);
      out += " ";
      continue;
    }
    // Single-quoted string '...'
    if (ch === "'") {
      i += 1;
      while (i < n) {
        if (sql[i] === "\\" && i + 1 < n) {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += " '' ";
      continue;
    }
    // Postgres dollar-quoted string $tag$...$tag$
    if (ch === "$") {
      const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += " '' ";
        continue;
      }
    }
    // Double-quoted identifier "..." or backtick identifier `...`
    if (ch === '"' || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += " _ident_ ";
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function validateReadOnlySql(
  rawSql: string,
  kind: "sqlite" | "postgres" | "mysql",
): { ok: true; sql: string } | { ok: false; error: string } {
  const trimmed = String(rawSql ?? "").trim().replace(/;+\s*$/, "");
  if (!trimmed) {
    return { ok: false, error: "SQL query must not be empty" };
  }
  if (trimmed.length > MAX_SQL_CHARS) {
    return { ok: false, error: `SQL query exceeds maximum length (${MAX_SQL_CHARS} chars)` };
  }
  if (trimmed.includes("\0")) {
    return { ok: false, error: "SQL query contains invalid null byte" };
  }

  const normalized = stripSqlCommentsAndLiterals(trimmed).trim();
  if (!normalized) {
    return { ok: false, error: "SQL query contains only comments" };
  }
  if (normalized.includes(";")) {
    return { ok: false, error: "Only a single read-only SQL statement is allowed per query" };
  }

  const firstWord = normalized.split(/\s+/)[0]?.toUpperCase() ?? "";
  if (kind === "sqlite") {
    const allowedSqlite =
      firstWord === "SELECT" ||
      firstWord === "WITH" ||
      firstWord === "EXPLAIN" ||
      firstWord === "VALUES" ||
      /^PRAGMA\s+(?:TABLE_INFO|TABLE_LIST|INDEX_LIST|INDEX_INFO|FOREIGN_KEY_LIST|DATABASE_LIST)\b/i.test(
        normalized,
      );
    if (!allowedSqlite) {
      return {
        ok: false,
        error: "Only read-only SQLite statements (SELECT / WITH / EXPLAIN / VALUES / read-only PRAGMA) are allowed",
      };
    }
  } else {
    const allowedRemote = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES", "TABLE"]);
    if (!allowedRemote.has(firstWord)) {
      return {
        ok: false,
        error: `Only read-only ${kind.toUpperCase()} statements (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN) are allowed`,
      };
    }
  }

  if (FORBIDDEN_SQL_KEYWORDS.test(normalized)) {
    return { ok: false, error: "Write, DDL, transaction-control, or administrative SQL keywords are blocked in read-only query mode" };
  }
  for (const pattern of FORBIDDEN_SQL_PHRASES) {
    if (pattern.test(normalized)) {
      return { ok: false, error: "File-access or server-side administrative SQL functions are blocked in read-only query mode" };
    }
  }

  return { ok: true, sql: trimmed };
}

export function validateRedisReadOnlyCommand(
  input: unknown,
): { ok: true; args: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) {
    return { ok: false, error: "redis_command must be a non-empty array of strings (max 32 args)" };
  }
  const args = input.map((item) => (typeof item === "string" || typeof item === "number" ? String(item) : ""));
  if (args.some((a) => !a || a.includes("\0") || a.length > 2048)) {
    return { ok: false, error: "redis_command contains invalid arguments" };
  }
  const cmd = args[0].toUpperCase();
  if (!REDIS_READONLY_COMMANDS.has(cmd)) {
    return {
      ok: false,
      error: `Redis command "${cmd}" is not permitted in read-only mode (allowed: GET, MGET, HGETALL, LRANGE, SMEMBERS, ZRANGE, SCAN, TYPE, TTL, DBSIZE, INFO, etc.)`,
    };
  }
  return { ok: true, args };
}

export interface MongoReadOnlySpec {
  collection: string;
  operation: "listCollections" | "find" | "findOne" | "countDocuments" | "aggregate";
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, unknown>;
  pipeline?: Record<string, unknown>[];
  limit: number;
}

function hasForbiddenMongoStage(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasForbiddenMongoStage);
  }
  if (!value || typeof value !== "object") return false;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === "$out" || k === "$merge" || k === "$function" || k === "$accumulator" || k === "$where") {
      return true;
    }
    if (hasForbiddenMongoStage(v)) return true;
  }
  return false;
}

export function validateMongoReadOnlyOp(
  input: unknown,
  requestedLimit = 50,
): { ok: true; spec: MongoReadOnlySpec } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "mongo must be an object specifying operation and collection" };
  }
  const obj = input as Record<string, unknown>;
  const operation = String(obj.operation ?? "") as MongoReadOnlySpec["operation"];
  if (!["listCollections", "find", "findOne", "countDocuments", "aggregate"].includes(operation)) {
    return {
      ok: false,
      error: "mongo.operation must be one of listCollections, find, findOne, countDocuments, aggregate",
    };
  }
  const collection = typeof obj.collection === "string" ? obj.collection.trim() : "";
  if (operation !== "listCollections") {
    if (!collection || collection.length > 200 || /[\x00-\x1f]/.test(collection)) {
      return { ok: false, error: "mongo.collection is required and must be valid" };
    }
  }
  if (hasForbiddenMongoStage(obj)) {
    return { ok: false, error: "Forbidden MongoDB stage or operator ($out, $merge, $where, $function) blocked" };
  }
  const limit = Math.max(1, Math.min(200, Math.floor(Number(obj.limit ?? requestedLimit) || 50)));
  const filter = obj.filter && typeof obj.filter === "object" && !Array.isArray(obj.filter)
    ? (obj.filter as Record<string, unknown>)
    : undefined;
  const projection = obj.projection && typeof obj.projection === "object" && !Array.isArray(obj.projection)
    ? (obj.projection as Record<string, unknown>)
    : undefined;
  const sort = obj.sort && typeof obj.sort === "object" && !Array.isArray(obj.sort)
    ? (obj.sort as Record<string, unknown>)
    : undefined;
  const pipeline = Array.isArray(obj.pipeline)
    ? (obj.pipeline.filter((s) => s && typeof s === "object" && !Array.isArray(s)) as Record<string, unknown>[])
    : undefined;
  if (operation === "aggregate" && !pipeline) {
    return { ok: false, error: "mongo.pipeline array is required for aggregate" };
  }
  return { ok: true, spec: { collection, operation, filter, projection, sort, pipeline, limit } };
}

function resolveBinary(
  name: "psql" | "mysql" | "redis-cli" | "mongosh",
  overrides?: Partial<Record<"psql" | "mysql" | "redis-cli" | "mongosh", string>>,
): string | null {
  const custom = overrides?.[name]?.trim();
  if (custom) {
    try {
      accessSync(custom, constants.X_OK);
      return statSync(custom).isFile() ? custom : null;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // continue
    }
  }
  return null;
}

function runSubprocess(params: {
  bin: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ exitCode: number | null; stdout: string; stderr: string; truncated: boolean; timedOut: boolean }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(params.bin, params.args, {
      env: params.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const killChild = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 300).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, params.timeoutMs ?? DEFAULT_DB_TIMEOUT_MS);
    timer.unref();

    const onAbort = () => killChild();
    if (params.signal) {
      if (params.signal.aborted) onAbort();
      else params.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      const len = Buffer.byteLength(chunk);
      if (stdoutBytes + len <= MAX_CLI_STDOUT_BYTES) {
        stdout += chunk;
        stdoutBytes += len;
      } else {
        const remain = Math.max(0, MAX_CLI_STDOUT_BYTES - stdoutBytes);
        if (remain > 0) stdout += Buffer.from(chunk).subarray(0, remain).toString("utf8");
        stdoutBytes = MAX_CLI_STDOUT_BYTES;
        truncated = true;
        killChild();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < 8000) stderr += chunk.slice(0, 8000 - stderr.length);
    });

    const done = (err: Error | null, code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
      if (err) reject(err);
      else resolvePromise({ exitCode: code, stdout, stderr, truncated, timedOut });
    };

    child.on("error", (err) => done(err, null));
    child.on("close", (code) => done(null, code));
    child.stdin.on("error", () => {
      /* ignore EPIPE */
    });
    if (params.stdin !== undefined) {
      child.stdin.end(params.stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

function parseCsvRows(csvText: string, limit: number): {
  columns: string[];
  rows: Record<string, string | null>[];
  truncated: boolean;
} {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < csvText.length) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && csvText[i + 1] === "\n") i += 1;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") {
        records.push(row);
        if (records.length > limit + 1) break;
      }
      row = [];
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    records.push(row);
  }
  if (records.length === 0) {
    return { columns: [], rows: [], truncated: false };
  }
  const columns = records[0];
  const dataRecords = records.slice(1);
  const truncated = dataRecords.length > limit;
  const rows = dataRecords.slice(0, limit).map((vals) => {
    const obj: Record<string, string | null> = {};
    for (let idx = 0; idx < columns.length; idx++) {
      const val = vals[idx] ?? null;
      obj[columns[idx]] = val !== null && val.length > 2000 ? val.slice(0, 2000) + "…" : val;
    }
    return obj;
  });
  return { columns, rows, truncated };
}

function parseTsvRows(tsvText: string, limit: number): {
  columns: string[];
  rows: Record<string, string | null>[];
  truncated: boolean;
} {
  const lines = tsvText.replace(/\r\n/g, "\n").split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return { columns: [], rows: [], truncated: false };
  const columns = lines[0].split("\t");
  const dataLines = lines.slice(1);
  const truncated = dataLines.length > limit;
  const rows = dataLines.slice(0, limit).map((line) => {
    const vals = line.split("\t");
    const obj: Record<string, string | null> = {};
    for (let idx = 0; idx < columns.length; idx++) {
      const raw = vals[idx];
      if (raw === undefined || raw === "NULL") obj[columns[idx]] = null;
      else obj[columns[idx]] = raw.length > 2000 ? raw.slice(0, 2000) + "…" : raw;
    }
    return obj;
  });
  return { columns, rows, truncated };
}

function formatSqliteCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `<BLOB ${value.byteLength} bytes>`;
  }
  const str = String(value);
  return str.length > 2000 ? str.slice(0, 2000) + "…" : str;
}

function resolveSpaceSqlitePath(spaceDir: string, filePath: string): string {
  const filesRoot = resolve(spaceDir, "files");
  const candidate = resolve(filesRoot, filePath);
  const rel = relative(filesRoot, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("Invalid SQLite workspace path");
  }
  if (!existsSync(candidate) || !lstatSync(candidate).isFile()) {
    throw new Error(`SQLite file not found in workspace: files/${filePath}`);
  }
  const realRoot = realpathSync(filesRoot);
  const realFile = realpathSync(candidate);
  const realRel = relative(realRoot, realFile);
  if (!realRel || realRel === ".." || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) {
    throw new Error("SQLite file resolves outside workspace files/");
  }
  return realFile;
}

function buildSafeSubprocessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function buildPostgresExecConfig(connUrl: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const env = buildSafeSubprocessEnv();
  env.PGOPTIONS = "-c default_transaction_read_only=on -c statement_timeout=15000";
  env.PGCONNECT_TIMEOUT = "10";
  const args = ["-X", "-v", "ON_ERROR_STOP=1", "--pset=pager=off", "--csv"];
  try {
    const u = new URL(connUrl);
    if (u.protocol === "postgres:" || u.protocol === "postgresql:") {
      if (u.hostname) env.PGHOST = u.hostname;
      if (u.port) env.PGPORT = u.port;
      if (u.username) env.PGUSER = decodeURIComponent(u.username);
      if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
      const db = u.pathname.replace(/^\//, "");
      if (db) env.PGDATABASE = decodeURIComponent(db);
      const sslmode = u.searchParams.get("sslmode");
      if (sslmode) env.PGSSLMODE = sslmode;
      return { args, env };
    }
  } catch {
    // Fallback to libpq key/value connection string.
  }
  args.push("-d", connUrl);
  return { args, env };
}

function buildMysqlExecConfig(connUrl: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const env = buildSafeSubprocessEnv();
  const args = ["--batch", "--connect-timeout=10", "--default-character-set=utf8mb4"];
  const u = new URL(connUrl);
  if (u.protocol !== "mysql:" && u.protocol !== "mariadb:") {
    throw new Error("MySQL datasource connection URL must start with mysql:// or mariadb://");
  }
  if (u.hostname) args.push("-h", u.hostname);
  if (u.port) args.push("-P", u.port);
  if (u.username) args.push("-u", decodeURIComponent(u.username));
  if (u.password) env.MYSQL_PWD = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, "");
  if (db) args.push("-D", decodeURIComponent(db));
  const sslMode = u.searchParams.get("ssl-mode") || u.searchParams.get("sslmode");
  if (sslMode && /^[A-Za-z_]{1,32}$/.test(sslMode)) {
    args.push(`--ssl-mode=${sslMode}`);
  }
  return { args, env };
}

function buildRedisExecConfig(connUrl: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const env = buildSafeSubprocessEnv();
  const args: string[] = [];
  const u = new URL(connUrl);
  if (u.protocol !== "redis:" && u.protocol !== "rediss:") {
    throw new Error("Redis datasource connection URL must start with redis:// or rediss://");
  }
  if (u.protocol === "rediss:") args.push("--tls");
  if (u.hostname) args.push("-h", u.hostname);
  if (u.port) args.push("-p", u.port);
  if (u.username && u.username !== "default") args.push("--user", decodeURIComponent(u.username));
  if (u.password) env.REDISCLI_AUTH = decodeURIComponent(u.password);
  const dbNum = u.pathname.replace(/^\//, "");
  if (dbNum && /^\d+$/.test(dbNum)) args.push("-n", dbNum);
  args.push("--no-auth-warning");
  return { args, env };
}

function isValidSqlIdentifier(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_$.-]{0,127}$/.test(name);
}

function buildToolDefinitions(hasTasks: boolean, hasDelegate: boolean) {
  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const taskWriteAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
  };
  const taskTools = hasTasks
    ? [
        {
          name: "list_tasks",
          description:
            "List tasks in the current Relaydesk project. Use this to inspect open/recent tickets before updating or cross-referencing.",
          annotations: readOnlyAnnotations,
          inputSchema: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: ["triage", "ready", "working", "waiting", "review", "done"],
                description: "Optional status filter",
              },
              priority: {
                type: "string",
                enum: ["low", "normal", "high", "urgent"],
                description: "Optional priority filter",
              },
              deploy_status: {
                type: "string",
                enum: ["not_required", "pending", "deploying", "deployed", "failed"],
                description: "Optional deploy status filter",
              },
              search: { type: "string", description: "Optional substring search against code, title, or body" },
              include_done: { type: "boolean", description: "Include completed tasks (default true)" },
              limit: { type: "integer", minimum: 1, maximum: 100, description: "Max tasks to return (default 30)" },
            },
          },
        },
        {
          name: "get_task",
          description:
            "Fetch full details, comment/event thread, and linked feedback for a task in the current project. Accepts task ID, number (e.g. 12), or code (e.g. RD-12).",
          annotations: readOnlyAnnotations,
          inputSchema: {
            type: "object",
            required: ["task"],
            properties: {
              task: { type: ["string", "integer"], description: "Task ID, number, or code such as RD-12" },
            },
          },
        },
        {
          name: "comment_task",
          description:
            "Post an agent comment (e.g., root-cause analysis, DB investigation findings, or progress update) onto a task in the current project.",
          annotations: taskWriteAnnotations,
          inputSchema: {
            type: "object",
            required: ["task", "body"],
            properties: {
              task: { type: ["string", "integer"], description: "Task ID, number, or code such as RD-12" },
              body: { type: "string", description: "Internal Markdown comment; never shared with the reporter." },
              public_question: {
                type: "string", enum: ["steps", "expected", "environment", "frequency", "screenshot", "confirm_fix"],
                description: "Explicit opt-in: send a reviewed template to the feedback reporter and move the task to waiting. Never copies the internal comment. An agent with an active lease must transition its own task to waiting first.",
              },
              reopen: {
                type: "boolean",
                description: "If true and the task is waiting/review/done, reopen it to ready (default false)",
              },
            },
          },
        },
        {
          name: "update_task",
          description:
            "Update metadata fields (title, priority, requirements, delivery_ref, body) on an unmerged task in the current project.",
          annotations: taskWriteAnnotations,
          inputSchema: {
            type: "object",
            required: ["task"],
            properties: {
              task: { type: ["string", "integer"], description: "Task ID, number, or code such as RD-12" },
              title: { type: "string", description: "Updated title" },
              priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
              requirements: { type: "string", description: "Updated acceptance criteria / requirements" },
              delivery_ref: { type: "string", description: "PR URL, branch name, or delivery reference" },
              body: { type: "string", description: "Updated task description" },
            },
          },
        },
        {
          name: "transition_task",
          description:
            "Transition a task's workflow status (triage, ready, working, waiting, review, done) or merge it into another task, optionally recording a delivery_ref and comment. Only call when asked or clearly appropriate for the user's request.",
          annotations: taskWriteAnnotations,
          inputSchema: {
            type: "object",
            required: ["task"],
            properties: {
              task: { type: ["string", "integer"], description: "Task ID, number, or code such as RD-12" },
              status: {
                type: "string",
                enum: ["triage", "ready", "working", "waiting", "review", "done"],
                description: "Target workflow status (required unless merge_into is provided)",
              },
              resolution: {
                type: "string",
                enum: ["shipped", "dismissed", "wontfix"],
                description: "Optional resolution when transitioning to done (defaults to shipped)",
              },
              delivery_ref: { type: "string", description: "Optional PR URL or commit/branch reference" },
              needs_deploy: {
                type: "boolean",
                description:
                  "Optional flag when transitioning to done(shipped): set false for docs/tests/config-only changes that do not require production deployment",
              },
              comment: { type: "string", description: "Optional agent comment recorded along with the transition" },
              merge_into: {
                type: ["string", "integer"],
                description: "Optional target task ID/code to merge this duplicate task into",
              },
            },
          },
        },
        {
          name: "create_task",
          description:
            "Create a new follow-up or bug task in the current Relaydesk project.",
          annotations: taskWriteAnnotations,
          inputSchema: {
            type: "object",
            required: ["title"],
            properties: {
              title: { type: "string", description: "Concise task title" },
              body: { type: "string", description: "Detailed description / evidence" },
              requirements: { type: "string", description: "Optional acceptance criteria" },
              priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
              status: { type: "string", enum: ["triage", "ready"], description: "Initial status (default triage)" },
            },
          },
        },
        {
          name: "list_releases",
          description:
            "List recent production release records (REL-xxx) for the current Relaydesk project.",
          annotations: readOnlyAnnotations,
          inputSchema: {
            type: "object",
            properties: {
              status: {
                type: "string",
                enum: ["running", "verifying", "succeeded", "failed", "blocked"],
                description: "Optional release status filter",
              },
              limit: {
                type: "integer",
                minimum: 1,
                maximum: 50,
                description: "Max releases to return (default 20)",
              },
            },
          },
        },
        {
          name: "checkpoint_release",
          description:
            "Persist the target SHA and verification metadata (health URL, deploy log, checks, and optional Pier server/project if using Pier) on a release (REL-xxx) BEFORE executing a cutover/restart so post-restart verification has full context.",
          annotations: taskWriteAnnotations,
          inputSchema: {
            type: "object",
            required: ["release_id"],
            properties: {
              release_id: {
                type: ["string", "integer"],
                description: "Release ID, number (e.g. 3), or code (e.g. REL-3)",
              },
              target_sha: {
                type: "string",
                description: "Target git commit SHA being deployed",
              },
              deploy_ref: {
                type: "string",
                description: "Optional deploy reference (e.g. main@<sha> or image tag)",
              },
              pier_server: {
                type: "string",
                description: "Optional Pier server name (only if this project deploys via Pier)",
              },
              pier_project: {
                type: "string",
                description: "Optional Pier project name (only if this project deploys via Pier)",
              },
              health_url: {
                type: "string",
                description: "Public or internal health check URL to verify after cutover",
              },
              deploy_log: {
                type: "string",
                description: "Remote deploy log path for post-cutover verification",
              },
              checks: {
                type: "array",
                items: { type: "string" },
                description: "List of verification checks to confirm after cutover",
              },
              notes: {
                type: "string",
                description: "Additional verification notes or rollback baseline (e.g. previous SHA)",
              },
            },
          },
        },
        {
          name: "finish_release",
          description:
            "Record the outcome of a Release session (REL-xxx) or re-verification run: succeeded (syncs release and linked tasks, correcting prior false failures while preserving original failure reasons), failed, blocked, or verifying (keep awaiting verification when evidence is still insufficient).",
          annotations: taskWriteAnnotations,
          inputSchema: {
            type: "object",
            required: ["release_id", "status", "summary"],
            properties: {
              release_id: {
                type: ["string", "integer"],
                description: "Release ID, number (e.g. 3), or code (e.g. REL-3)",
              },
              status: {
                type: "string",
                enum: ["succeeded", "failed", "blocked", "verifying"],
                description: "Release outcome (use verifying when evidence is insufficient)",
              },
              summary: {
                type: "string",
                description: "Concise Markdown summary of deployment steps, verification evidence, or failure/block reasons",
              },
              deploy_ref: {
                type: "string",
                description: "Optional deployed commit SHA, image tag, or release identifier",
              },
              target_sha: {
                type: "string",
                description: "Optional verified target commit SHA",
              },
              deployed_task_ids: {
                type: "array",
                items: { type: "string" },
                description:
                  "Optional subset of task IDs or codes (e.g. RD-12) actually deployed when status is succeeded; defaults to all tasks in this release",
              },
            },
          },
        },
      ]
    : [];

  const datasourceTools = [
    {
      name: "list_datasources",
      description:
        "List all databases/datasources configured for this Relaydesk project (workspace SQLite files and external databases) along with read-only MCP query availability.",
      annotations: readOnlyAnnotations,
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "describe_datasource",
      description:
        "Inspect tables, collections, or keyspace schema for a project datasource in strict read-only mode. Pass table name to view columns.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        type: "object",
        required: ["datasource"],
        properties: {
          datasource: {
            type: "string",
            description: "Datasource name, id, or env_var from list_datasources",
          },
          table: {
            type: "string",
            description: "Optional table name (or schema.table for Postgres) to inspect columns",
          },
        },
      },
    },
    {
      name: "query_datasource",
      description:
        "Execute a strictly read-only query against a project datasource (SQLite, PostgreSQL, MySQL, Redis, or MongoDB) without exposing raw credentials. Works even in read-only chat mode.",
      annotations: readOnlyAnnotations,
      inputSchema: {
        type: "object",
        required: ["datasource"],
        properties: {
          datasource: {
            type: "string",
            description: "Datasource name, id, or env_var from list_datasources",
          },
          query: {
            type: "string",
            description: "Single read-only SQL query for sqlite/postgres/mysql (SELECT / WITH / SHOW / DESCRIBE / EXPLAIN)",
          },
          redis_command: {
            type: "array",
            items: { type: "string" },
            description: "Read-only Redis command tokens, e.g. [\"GET\", \"user:1\"] or [\"SCAN\", \"0\", \"COUNT\", \"20\"]",
          },
          mongo: {
            type: "object",
            description: "Structured read-only MongoDB query: { operation: 'listCollections'|'find'|'findOne'|'countDocuments'|'aggregate', collection?, filter?, projection?, sort?, pipeline?, limit? }",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Max rows to return (default 100, max 500)",
          },
        },
      },
    },
  ];

  const delegateTools = hasDelegate
    ? [
        {
          name: "delegate_task",
          description:
            "Delegate a focused sub-task to an independent Relaydesk-managed child session running natively on any available harness (claude, codex, or agy). Preserves each harness's native prompt cache and isolates context. Use mode='async' for longer tasks to avoid blocking past prompt-cache TTLs.",
          annotations: taskWriteAnnotations,
          inputSchema: {
            type: "object",
            required: ["runtime", "prompt"],
            properties: {
              runtime: {
                type: "string",
                enum: ["claude", "codex", "agy"],
                description: "Target CLI harness to execute the delegated subagent natively",
              },
              prompt: {
                type: "string",
                description: "Self-contained, focused task brief for the subagent (it does NOT inherit parent conversation history)",
              },
              title: {
                type: "string",
                description: "Optional short label (2-6 words) shown in the UI subagent dock and panel",
              },
              model: {
                type: "string",
                description: "Optional model ID on the target runtime (defaults to the runtime's default model)",
              },
              reasoning_effort: {
                type: "string",
                enum: ["default", "off", "low", "medium", "high", "max"],
                description: "Optional reasoning effort level",
              },
              sandbox_mode: {
                type: "string",
                enum: ["read-only", "workspace-write"],
                description: "Sandbox mode for the subagent (inherits parent session sandbox by default; pass 'read-only' to narrow; cannot exceed parent session sandbox)",
              },
              mode: {
                type: "string",
                enum: ["wait", "async"],
                description: "'wait' blocks until completion and returns the summary (default); 'async' returns immediately with session_id so you can continue working and call check_delegated_task or wait_delegated_task later",
              },
              timeout_seconds: {
                type: "integer",
                minimum: 10,
                maximum: 300,
                description: "Max seconds to wait in 'wait' mode (default 180, max 300)",
              },
            },
          },
        },
        {
          name: "check_delegated_task",
          description:
            "Inspect the current status, latest activity, and result (if finished) of a delegated subagent session without blocking.",
          annotations: readOnlyAnnotations,
          inputSchema: {
            type: "object",
            required: ["session_id"],
            properties: {
              session_id: {
                type: "string",
                description: "Delegated child session_id returned by delegate_task",
              },
            },
          },
        },
        {
          name: "wait_delegated_task",
          description:
            "Wait for a running delegated subagent session to finish and return its final summary.",
          annotations: readOnlyAnnotations,
          inputSchema: {
            type: "object",
            required: ["session_id"],
            properties: {
              session_id: {
                type: "string",
                description: "Delegated child session_id returned by delegate_task",
              },
              timeout_seconds: {
                type: "integer",
                minimum: 5,
                maximum: 300,
                description: "Max seconds to wait (default 180, max 300)",
              },
            },
          },
        },
        {
          name: "cancel_delegated_task",
          description: "Stop a running delegated subagent session.",
          annotations: taskWriteAnnotations,
          inputSchema: {
            type: "object",
            required: ["session_id"],
            properties: {
              session_id: {
                type: "string",
                description: "Delegated child session_id returned by delegate_task",
              },
            },
          },
        },
      ]
    : [];

  return [...taskTools, ...delegateTools, ...datasourceTools];
}

export async function startRelaydeskMcpServer(options: RelaydeskMcpOptions): Promise<RelaydeskMcpHandle> {
  const token = randomBytes(24).toString("hex");
  const tokenBuf = Buffer.from(token);
  const sessionId = randomUUID();
  const protectedSecrets = [...new Set([...(options.secrets ?? []), token])].filter(Boolean);
  const redact = (text: string) => {
    let out = redactSecrets(text, protectedSecrets);
    for (const s of protectedSecrets) {
      if (s.length < 4) out = out.replaceAll(s, "[redacted]");
    }
    return out;
  };

  const tools = buildToolDefinitions(Boolean(options.taskClient), Boolean(options.delegateClient));
  const dsEnv = options.datasourceEnv ?? {};

  function findDatasource(ref: unknown): RelaydeskMcpDatasourceMeta {
    const q = typeof ref === "string" ? ref.trim() : "";
    if (!q) throw new Error("datasource parameter is required");
    const lower = q.toLowerCase();
    const match = options.databases.find(
      (db) =>
        (db.id && db.id.toLowerCase() === lower) ||
        db.name.toLowerCase() === lower ||
        (db.env_var && db.env_var.toLowerCase() === lower) ||
        (db.file_path && (`files/${db.file_path}`.toLowerCase() === lower || db.file_path.toLowerCase() === lower)),
    );
    if (!match) {
      const available = options.databases.map((d) => d.name).join(", ") || "none";
      throw new Error(`Datasource "${q}" not found in project. Available: ${available}`);
    }
    return match;
  }

  function resolveExternalConnection(db: RelaydeskMcpDatasourceMeta): { url: string; bin: string } {
    if (!options.allowDatasourceSecrets) {
      throw new Error(
        "当前本机节点尚未开启「允许数据源凭证」授权，无法连接外部数据库。请前往「项目设置 → 执行路由与本机节点」为该节点打开后重试。",
      );
    }
    const url = db.env_var ? (dsEnv[db.env_var] ?? "").trim() : "";
    if (!url) {
      throw new Error(
        `Datasource "${db.name}" has no connection URL available in this run. Verify it is configured in Project Space and datasource credentials are enabled.`,
      );
    }
    const binName =
      db.kind === "postgres"
        ? "psql"
        : db.kind === "mysql"
          ? "mysql"
          : db.kind === "redis"
            ? "redis-cli"
            : db.kind === "mongodb"
              ? "mongosh"
              : null;
    if (!binName) {
      throw new Error(`Datasource kind "${db.kind}" is not supported by read-only MCP query tool`);
    }
    const bin = resolveBinary(binName, options.dbBinaries);
    if (!bin) {
      throw new Error(`Required local DB CLI client "${binName}" is not installed on PATH`);
    }
    return { url, bin };
  }

  function listDatasourcesData() {
    return {
      allow_datasource_secrets: options.allowDatasourceSecrets,
      datasources: options.databases.map((db) => {
        if (db.source === "workspace_file") {
          let exists = false;
          try {
            if (db.file_path) {
              resolveSpaceSqlitePath(options.spaceDir, db.file_path);
              exists = true;
            }
          } catch {
            exists = false;
          }
          return {
            id: db.id ?? db.file_path ?? db.name,
            name: db.name,
            kind: db.kind,
            source: db.source,
            file_path: db.file_path ? `files/${db.file_path}` : undefined,
            read_only: true,
            notes: db.notes ?? "",
            queryable_via_mcp: exists,
            ...(exists ? {} : { unavailable_reason: "SQLite file not mirrored in local workspace" }),
          };
        }
        let queryable = false;
        let unavailableReason = "";
        const hasUrl = Boolean(db.env_var && dsEnv[db.env_var]);
        if (!options.allowDatasourceSecrets) {
          unavailableReason = "本机节点未开启「允许数据源凭证」授权（请在项目设置中开启）";
        } else if (!hasUrl) {
          unavailableReason = "数据源未配置连接串";
        } else {
          const binName =
            db.kind === "postgres"
              ? "psql"
              : db.kind === "mysql"
                ? "mysql"
                : db.kind === "redis"
                  ? "redis-cli"
                  : db.kind === "mongodb"
                    ? "mongosh"
                    : null;
          if (!binName) {
            unavailableReason = `暂不支持通过 MCP 直接查询 ${db.kind} 类型数据源`;
          } else if (!resolveBinary(binName, options.dbBinaries)) {
            unavailableReason = `本机未安装 ${binName} 客户端`;
          } else {
            queryable = true;
          }
        }
        return {
          id: db.id ?? db.env_var ?? db.name,
          name: db.name,
          kind: db.kind,
          source: db.source,
          env_var: db.env_var,
          host_preview: db.host_preview ?? "",
          read_only: db.read_only !== false,
          notes: db.notes ?? "",
          queryable_via_mcp: queryable,
          ...(unavailableReason ? { unavailable_reason: unavailableReason } : {}),
        };
      }),
    };
  }

  function querySqliteFile(filePath: string, rawSql: string, limit: number) {
    const check = validateReadOnlySql(rawSql, "sqlite");
    if (!check.ok) throw new Error(check.error);
    const absPath = resolveSpaceSqlitePath(options.spaceDir, filePath);
    const startedAt = Date.now();
    const db = new DatabaseSync(absPath, { readOnly: true });
    try {
      const stmt = db.prepare(check.sql);
      const rows: Record<string, string | number | boolean | null>[] = [];
      let columns: string[] = [];
      let truncated = false;
      for (const rawRow of stmt.iterate()) {
        if (rows.length >= limit) {
          truncated = true;
          break;
        }
        const obj = rawRow as Record<string, unknown>;
        if (columns.length === 0) columns = Object.keys(obj);
        const formatted: Record<string, string | number | boolean | null> = {};
        for (const col of columns) formatted[col] = formatSqliteCell(obj[col]);
        rows.push(formatted);
      }
      return {
        columns,
        rows,
        row_count: rows.length,
        truncated,
        duration_ms: Date.now() - startedAt,
      };
    } finally {
      db.close();
    }
  }

  function describeSqliteFile(filePath: string, table?: string) {
    const absPath = resolveSpaceSqlitePath(options.spaceDir, filePath);
    const db = new DatabaseSync(absPath, { readOnly: true });
    try {
      const rawTables = db
        .prepare(
          "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type ASC, name ASC",
        )
        .all() as Array<{ name: string; type: string; sql: string | null }>;
      const targetTables = table
        ? rawTables.filter((t) => t.name.toLowerCase() === table.toLowerCase())
        : rawTables.slice(0, 60);
      if (table && targetTables.length === 0) {
        throw new Error(`Table "${table}" not found in SQLite database`);
      }
      return {
        file_path: `files/${filePath}`,
        table_count: rawTables.length,
        tables: targetTables.map((t) => {
          const quoted = `"${t.name.replace(/"/g, '""')}"`;
          const cols = db.prepare(`PRAGMA table_info(${quoted})`).all() as Array<{
            name: string;
            type: string;
            notnull: number;
            pk: number;
          }>;
          let rowCount = 0;
          try {
            const cnt = db.prepare(`SELECT COUNT(*) AS cnt FROM ${quoted}`).get() as { cnt?: number };
            rowCount = Number(cnt?.cnt ?? 0);
          } catch {
            rowCount = 0;
          }
          return {
            name: t.name,
            type: t.type,
            row_count: rowCount,
            columns: cols.map((c) => ({
              name: c.name,
              type: c.type || "ANY",
              notnull: Boolean(c.notnull),
              pk: Boolean(c.pk),
            })),
            ...(table ? { sql: t.sql ?? "" } : {}),
          };
        }),
      };
    } finally {
      db.close();
    }
  }

  async function executePostgresQuery(connUrl: string, bin: string, rawSql: string, limit: number) {
    const check = validateReadOnlySql(rawSql, "postgres");
    if (!check.ok) throw new Error(check.error);
    const startedAt = Date.now();
    const execCfg = buildPostgresExecConfig(connUrl);
    const res = await runSubprocess({
      bin,
      args: execCfg.args,
      env: execCfg.env,
      stdin: `${check.sql};\n`,
      signal: options.signal,
    });
    if (res.timedOut) throw new Error("PostgreSQL read-only query timed out (15s limit)");
    if (res.exitCode !== 0 && !res.truncated) {
      throw new Error(`PostgreSQL query failed: ${redact(res.stderr.trim() || `exit ${res.exitCode}`)}`);
    }
    const parsed = parseCsvRows(res.stdout, limit);
    return {
      columns: parsed.columns,
      rows: parsed.rows,
      row_count: parsed.rows.length,
      truncated: parsed.truncated || res.truncated,
      duration_ms: Date.now() - startedAt,
    };
  }

  async function executeMysqlQuery(connUrl: string, bin: string, rawSql: string, limit: number) {
    const check = validateReadOnlySql(rawSql, "mysql");
    if (!check.ok) throw new Error(check.error);
    const startedAt = Date.now();
    const execCfg = buildMysqlExecConfig(connUrl);
    const res = await runSubprocess({
      bin,
      args: execCfg.args,
      env: execCfg.env,
      stdin: `SET SESSION TRANSACTION READ ONLY;\n${check.sql};\n`,
      signal: options.signal,
    });
    if (res.timedOut) throw new Error("MySQL read-only query timed out (15s limit)");
    if (res.exitCode !== 0 && !res.truncated) {
      throw new Error(`MySQL query failed: ${redact(res.stderr.trim() || `exit ${res.exitCode}`)}`);
    }
    const parsed = parseTsvRows(res.stdout, limit);
    return {
      columns: parsed.columns,
      rows: parsed.rows,
      row_count: parsed.rows.length,
      truncated: parsed.truncated || res.truncated,
      duration_ms: Date.now() - startedAt,
    };
  }

  async function executeRedisQuery(connUrl: string, bin: string, redisCmd: unknown) {
    const check = validateRedisReadOnlyCommand(redisCmd);
    if (!check.ok) throw new Error(check.error);
    const startedAt = Date.now();
    const execCfg = buildRedisExecConfig(connUrl);
    const res = await runSubprocess({
      bin,
      args: [...execCfg.args, ...check.args],
      env: execCfg.env,
      signal: options.signal,
    });
    if (res.timedOut) throw new Error("Redis read-only command timed out (15s limit)");
    if (res.exitCode !== 0 && !res.truncated) {
      throw new Error(`Redis command failed: ${redact(res.stderr.trim() || `exit ${res.exitCode}`)}`);
    }
    return {
      command: check.args[0].toUpperCase(),
      output: redact(res.stdout.trim()),
      truncated: res.truncated,
      duration_ms: Date.now() - startedAt,
    };
  }

  async function executeMongoQuery(connUrl: string, bin: string, mongoInput: unknown, limit: number) {
    const check = validateMongoReadOnlyOp(mongoInput, limit);
    if (!check.ok) throw new Error(check.error);
    const startedAt = Date.now();
    const env = buildSafeSubprocessEnv();
    env.RD_MONGO_PAYLOAD = JSON.stringify(check.spec);
    const script = [
      "const spec = JSON.parse(process.env.RD_MONGO_PAYLOAD);",
      "let out;",
      "if (spec.operation === 'listCollections') {",
      "  out = { collections: db.getCollectionNames().slice(0, 200) };",
      "} else {",
      "  const coll = db.getCollection(spec.collection);",
      "  if (spec.operation === 'countDocuments') {",
      "    out = { count: coll.countDocuments(spec.filter || {}, { maxTimeMS: 12000 }) };",
      "  } else if (spec.operation === 'findOne') {",
      "    out = { document: coll.findOne(spec.filter || {}, spec.projection || {}) };",
      "  } else if (spec.operation === 'find') {",
      "    let cur = coll.find(spec.filter || {}, spec.projection || {}).maxTimeMS(12000);",
      "    if (spec.sort) cur = cur.sort(spec.sort);",
      "    const docs = cur.limit(spec.limit + 1).toArray();",
      "    out = { documents: docs.slice(0, spec.limit), count: Math.min(docs.length, spec.limit), truncated: docs.length > spec.limit };",
      "  } else if (spec.operation === 'aggregate') {",
      "    const docs = coll.aggregate([...(spec.pipeline || []), { $limit: spec.limit + 1 }], { maxTimeMS: 12000 }).toArray();",
      "    out = { documents: docs.slice(0, spec.limit), count: Math.min(docs.length, spec.limit), truncated: docs.length > spec.limit };",
      "  }",
      "}",
      "print(EJSON.stringify(out));",
    ].join("\n");
    const res = await runSubprocess({
      bin,
      args: ["--quiet", "--norc", connUrl, "--eval", script],
      env,
      signal: options.signal,
    });
    if (res.timedOut) throw new Error("MongoDB read-only query timed out (15s limit)");
    if (res.exitCode !== 0 && !res.truncated) {
      throw new Error(`MongoDB query failed: ${redact(res.stderr.trim() || `exit ${res.exitCode}`)}`);
    }
    const raw = res.stdout.trim();
    try {
      return {
        ...JSON.parse(raw),
        duration_ms: Date.now() - startedAt,
      };
    } catch {
      return {
        output: redact(raw),
        truncated: res.truncated,
        duration_ms: Date.now() - startedAt,
      };
    }
  }

  async function handleToolCall(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (
      name === "list_tasks" ||
      name === "get_task" ||
      name === "comment_task" ||
      name === "update_task" ||
      name === "transition_task" ||
      name === "create_task" ||
      name === "list_releases" ||
      name === "checkpoint_release" ||
      name === "finish_release"
    ) {
      if (!options.taskClient) {
        throw new Error("Task tools are not available in this session");
      }
      return await options.taskClient.call(name, args);
    }

    if (
      name === "delegate_task" ||
      name === "check_delegated_task" ||
      name === "wait_delegated_task" ||
      name === "cancel_delegated_task"
    ) {
      if (!options.delegateClient) {
        throw new Error("Delegation tools are not available in this session");
      }
      return await options.delegateClient.call(name, args);
    }

    if (name === "list_datasources") {
      return listDatasourcesData();
    }

    if (name === "describe_datasource") {
      const db = findDatasource(args.datasource);
      const table = typeof args.table === "string" ? args.table.trim() : "";
      if (db.source === "workspace_file") {
        if (!db.file_path) throw new Error("SQLite file path missing");
        return describeSqliteFile(db.file_path, table || undefined);
      }
      const { url, bin } = resolveExternalConnection(db);
      if (db.kind === "postgres") {
        if (table) {
          if (!isValidSqlIdentifier(table)) throw new Error("Invalid table identifier");
          const parts = table.split(".");
          const schema = parts.length === 2 ? parts[0] : "public";
          const tbl = parts.length === 2 ? parts[1] : parts[0];
          const sql = `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = '${schema}' AND table_name = '${tbl}' ORDER BY ordinal_position`;
          return await executePostgresQuery(url, bin, sql, 200);
        }
        const sql =
          "SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name LIMIT 150";
        return await executePostgresQuery(url, bin, sql, 150);
      }
      if (db.kind === "mysql") {
        if (table) {
          if (!isValidSqlIdentifier(table)) throw new Error("Invalid table identifier");
          const quoted = table
            .split(".")
            .map((p) => `\`${p.replace(/`/g, "``")}\``)
            .join(".");
          return await executeMysqlQuery(url, bin, `DESCRIBE ${quoted}`, 200);
        }
        return await executeMysqlQuery(url, bin, "SHOW TABLES", 150);
      }
      if (db.kind === "redis") {
        const [info, dbsize, scan] = await Promise.all([
          executeRedisQuery(url, bin, ["INFO", "keyspace"]),
          executeRedisQuery(url, bin, ["DBSIZE"]),
          executeRedisQuery(url, bin, ["SCAN", "0", "COUNT", "30"]),
        ]);
        return { keyspace: info.output, dbsize: dbsize.output, sample_keys: scan.output };
      }
      if (db.kind === "mongodb") {
        return await executeMongoQuery(url, bin, { operation: "listCollections" }, 200);
      }
      throw new Error(`describe_datasource is not supported for kind "${db.kind}"`);
    }

    if (name === "query_datasource") {
      const db = findDatasource(args.datasource);
      const limit = Math.max(1, Math.min(MAX_QUERY_ROWS, Math.floor(Number(args.limit) || 100)));
      if (db.source === "workspace_file") {
        if (!db.file_path) throw new Error("SQLite file path missing");
        return querySqliteFile(db.file_path, String(args.query ?? ""), limit);
      }
      const { url, bin } = resolveExternalConnection(db);
      if (db.kind === "postgres") {
        return await executePostgresQuery(url, bin, String(args.query ?? ""), limit);
      }
      if (db.kind === "mysql") {
        return await executeMysqlQuery(url, bin, String(args.query ?? ""), limit);
      }
      if (db.kind === "redis") {
        return await executeRedisQuery(url, bin, args.redis_command);
      }
      if (db.kind === "mongodb") {
        return await executeMongoQuery(url, bin, args.mongo, limit);
      }
      throw new Error(`query_datasource is not supported for kind "${db.kind}"`);
    }

    throw new Error(`Unknown tool: ${name}`);
  }

  async function processJsonRpcMessage(msg: unknown): Promise<Record<string, unknown> | null> {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
    }
    const req = msg as Record<string, unknown>;
    const hasId = Object.prototype.hasOwnProperty.call(req, "id") && req.id !== undefined;
    const id = hasId ? req.id : null;
    const method = typeof req.method === "string" ? req.method : "";
    const params = req.params && typeof req.params === "object" && !Array.isArray(req.params)
      ? (req.params as Record<string, unknown>)
      : {};

    // Notifications (no id) require no response payload.
    if (!hasId || method.startsWith("notifications/")) {
      return null;
    }

    try {
      if (method === "initialize") {
        const clientVersion =
          typeof params.protocolVersion === "string" && params.protocolVersion
            ? params.protocolVersion
            : "2025-03-26";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: clientVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "relaydesk", version: "1.0.0" },
          },
        };
      }
      if (method === "ping") {
        return { jsonrpc: "2.0", id, result: {} };
      }
      if (method === "tools/list") {
        return { jsonrpc: "2.0", id, result: { tools } };
      }
      if (method === "tools/call") {
        const toolName = typeof params.name === "string" ? params.name : "";
        const toolArgs =
          params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        try {
          const data = await handleToolCall(toolName, toolArgs);
          const text = redact(JSON.stringify(data, null, 2));
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text }],
              isError: false,
            },
          };
        } catch (err) {
          const errText = redact(err instanceof Error ? err.message : String(err));
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `Error: ${errText}` }],
              isError: true,
            },
          };
        }
      }
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: redact(err instanceof Error ? err.message : String(err)) },
      };
    }
  }

  function checkAuth(req: IncomingMessage): boolean {
    const auth = req.headers.authorization ?? "";
    if (!auth.startsWith("Bearer ")) return false;
    const provided = Buffer.from(auth.slice(7));
    if (provided.length !== tokenBuf.length) return false;
    return timingSafeEqual(provided, tokenBuf);
  }

  function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolvePromise, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_MCP_BODY_BYTES) {
          reject(new Error("Request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  function sendJson(res: ServerResponse, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Mcp-Session-Id", sessionId);
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  }

  const server: Server = createServer(async (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname !== "/mcp") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    if (!checkAuth(req)) {
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }
    if (req.method === "GET") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST, DELETE");
      res.end("Method Not Allowed");
      return;
    }
    if (req.method === "DELETE") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST, DELETE");
      res.end("Method Not Allowed");
      return;
    }

    let parsed: unknown;
    try {
      const raw = await readBody(req);
      parsed = JSON.parse(raw);
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    if (Array.isArray(parsed)) {
      const responses = (await Promise.all(parsed.map(processJsonRpcMessage))).filter(Boolean);
      if (responses.length === 0) {
        res.statusCode = 202;
        res.setHeader("Mcp-Session-Id", sessionId);
        res.end();
        return;
      }
      sendJson(res, 200, responses);
      return;
    }

    const response = await processJsonRpcMessage(parsed);
    if (!response) {
      res.statusCode = 202;
      res.setHeader("Mcp-Session-Id", sessionId);
      res.end();
      return;
    }
    sendJson(res, 200, response);
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolvePromise();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("Failed to bind Relaydesk MCP server");
  }
  const url = `http://127.0.0.1:${addr.port}/mcp`;

  return {
    url,
    token,
    claudeConfigObject() {
      return {
        mcpServers: {
          relaydesk: {
            type: "http",
            url,
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        },
      };
    },
    close() {
      return new Promise<void>((resolvePromise) => {
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      });
    },
  };
}
