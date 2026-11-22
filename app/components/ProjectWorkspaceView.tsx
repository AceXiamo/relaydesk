import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "~/lib/api.ts";
import { formatRelativeTime } from "~/lib/format.ts";
import type {
  ChatContextRef,
  ProjectDetail,
  ProjectReposSyncStatus,
  WorkspaceDatabaseEntry,
  WorkspaceDatabaseKind,
  WorkspaceDbClientInfo,
  WorkspaceFileDetail,
  WorkspaceFileEntry,
  WorkspaceHandbook,
  WorkspaceQueryResult,
  WorkspaceRepoFileContent,
  WorkspaceRepoFileEntry,
  WorkspaceSqliteSchema,
} from "~/lib/types.ts";
import { Icon } from "./Icon.tsx";
import { MarkdownContent } from "./MarkdownContent.tsx";
import { Select } from "./Select.tsx";
import { Button, EmptyState, Modal, useToast } from "./ui.tsx";

export type WorkspaceTab = "files" | "databases" | "handbook" | "deploy" | "repos";

interface ProjectWorkspaceViewProps {
  project: ProjectDetail | null;
  initialTab?: WorkspaceTab | null;
  onConsumeInitialTab?: () => void;
  onNewProject: () => void;
  onOpenChatWithContext: (
    ref?: ChatContextRef,
    initialPrompt?: string,
    opts?: { enableNetwork?: boolean },
  ) => void;
}

const HANDBOOK_TEMPLATE = `# 项目空间手册（HANDBOOK）

> 本手册保存在当前项目空间，网页端 Codex / Claude 对话与项目资料分析会自动读取此上下文。请勿在此填写生产密码、私钥或原始用户隐私记录。

## 项目概览
- 核心职责与模块划分：
- 入口文件与目录结构：

## 开发与验证命令
- 安装依赖：\`pnpm install\`
- 启动开发：\`pnpm dev\`
- 运行测试：\`pnpm test\`

## 文件与数据库约定
- 项目空间 \`files/\` 目录存放需求文档、接口规范、测试夹具与只读 SQLite 样本库。
- 涉及数据排查时，优先基于表结构和只读查询给出 SQL 与结论。
`;

const DEPLOY_DOC_TEMPLATE = `# 生产部署文档（DEPLOY.md）

> 本文件由 Release Agent 在生产发布（Release）会话中自动读取并严格执行。请写明可复现的发布步骤、健康检查方式与回滚方案；切勿直接存放明文密码或私钥。

## 1. 发布前检查
- 确认当前分支工作区干净，并拉取最新远端代码：\`git pull --ff-only\`
- 运行必要校验：\`pnpm typecheck && pnpm test && pnpm build\`

## 2. 生产部署步骤
- 示例（请替换为本项目的实际部署命令或工具）：
  - 使用 SSH / Pier / Docker Compose / PM2 / Vercel 等发布命令更新生产实例
  - 若涉及数据库迁移，请注明备份与迁移命令

## 3. 健康检查与冒烟验证
- 服务重启后等待就绪，检查健康端点：\`curl -fsS https://your-domain.example/api/health\`
- 核对线上版本 SHA 与容器日志无启动报错

## 4. 回滚策略
- 若健康检查失败或核心页面异常，说明如何回退到上一个可用镜像 / commit 并恢复服务
`;

const SAMPLE_SQLITE_INIT = `-- 示例表结构（可按需修改或留空创建空库）
CREATE TABLE IF NOT EXISTS feedback_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO feedback_metrics (category, count) VALUES
  ('bug', 12),
  ('feature', 8),
  ('performance', 3);
`;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fileIconName(entry: WorkspaceFileEntry): string {
  if (entry.type === "dir") return "folder";
  if (entry.is_sqlite) return "database";
  if (entry.ext === ".md" || entry.ext === ".txt") return "file-text";
  if (entry.ext === ".csv" || entry.ext === ".tsv") return "file-spreadsheet";
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".sql", ".json", ".yml", ".yaml", ".sh"].includes(entry.ext)) {
    return "file-code-2";
  }
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(entry.ext)) return "image";
  return "file";
}

function buildDatasourceCliExample(db: WorkspaceDatabaseEntry): string {
  const envRef = db.env_var ? `$${db.env_var}` : "$RELAYDESK_DB_MAIN";
  switch (db.kind) {
    case "postgres":
      return `psql "${envRef}" -c "\\dt"`;
    case "mysql":
      return `mysql "${envRef}" -e "SHOW TABLES;"`;
    case "redis":
      return `redis-cli -u "${envRef}" INFO keyspace`;
    case "mongodb":
      return `mongosh "${envRef}" --eval "db.getCollectionNames()"`;
    case "sqlite":
      return `sqlite3 "${envRef}" ".tables"`;
    default:
      return `# 使用环境变量 "${envRef}" 连接该数据源`;
  }
}

function findMatchingDbClient(
  clients: WorkspaceDbClientInfo[],
  kind: WorkspaceDatabaseKind,
): WorkspaceDbClientInfo | null {
  return clients.find((c) => c.kinds.includes(kind)) ?? null;
}

export function ProjectWorkspaceView({
  project,
  initialTab,
  onConsumeInitialTab,
  onNewProject,
  onOpenChatWithContext,
}: ProjectWorkspaceViewProps) {
  const toast = useToast();
  const [tab, setTab] = useState<WorkspaceTab>(initialTab ?? "files");
  const [mobilePane, setMobilePane] = useState<"list" | "detail">("list");

  useEffect(() => {
    if (initialTab) {
      setTab(initialTab);
      setMobilePane("list");
      onConsumeInitialTab?.();
    }
  }, [initialTab, onConsumeInitialTab]);

  // Files state
  const [files, setFiles] = useState<WorkspaceFileEntry[]>([]);
  const [filesTotalBytes, setFilesTotalBytes] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);
  const [fileSearch, setFileSearch] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileDetail, setFileDetail] = useState<WorkspaceFileDetail | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [fileDraft, setFileDraft] = useState("");
  const [fileDirty, setFileDirty] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [mdPreview, setMdPreview] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // Create file / dir modal
  const [createModal, setCreateModal] = useState<null | "file" | "dir">(null);
  const [newPath, setNewPath] = useState("");
  const [newContent, setNewContent] = useState("");
  const [creatingItem, setCreatingItem] = useState(false);

  // Databases state
  const [databases, setDatabases] = useState<WorkspaceDatabaseEntry[]>([]);
  const [dbClients, setDbClients] = useState<WorkspaceDbClientInfo[]>([]);
  const [refreshingClients, setRefreshingClients] = useState(false);
  const [dbLoading, setDbLoading] = useState(false);
  const [selectedDbId, setSelectedDbId] = useState<string | null>(null);
  const [dbSchema, setDbSchema] = useState<WorkspaceSqliteSchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [sqlInput, setSqlInput] = useState("");
  const [queryRunning, setQueryRunning] = useState(false);
  const [queryResult, setQueryResult] = useState<WorkspaceQueryResult | null>(null);
  const [queryError, setQueryError] = useState("");

  // Add DB modals
  const [sqliteModalOpen, setSqliteModalOpen] = useState(false);
  const [sqliteName, setSqliteName] = useState("");
  const [sqliteInitSql, setSqliteInitSql] = useState(SAMPLE_SQLITE_INIT);
  const [creatingDb, setCreatingDb] = useState(false);

  const [extDbModalOpen, setExtDbModalOpen] = useState(false);
  const [editingExtDb, setEditingExtDb] = useState<WorkspaceDatabaseEntry | null>(null);
  const [extDbName, setExtDbName] = useState("");
  const [extDbKind, setExtDbKind] = useState<WorkspaceDatabaseKind>("postgres");
  const [extDbEnvVar, setExtDbEnvVar] = useState("");
  const [extDbUrl, setExtDbUrl] = useState("");
  const [extDbClearUrl, setExtDbClearUrl] = useState(false);
  const [extDbReadOnly, setExtDbReadOnly] = useState(true);
  const [extDbNotes, setExtDbNotes] = useState("");
  const [savingExtDb, setSavingExtDb] = useState(false);

  // Handbook state
  const [handbook, setHandbook] = useState<WorkspaceHandbook | null>(null);
  const [handbookDraft, setHandbookDraft] = useState("");
  const [handbookDirty, setHandbookDirty] = useState(false);
  const [handbookSaving, setHandbookSaving] = useState(false);
  const [handbookPreview, setHandbookPreview] = useState(false);

  // Deploy doc (DEPLOY.md) state
  const [deployDoc, setDeployDoc] = useState<WorkspaceHandbook | null>(null);
  const [deployDocDraft, setDeployDocDraft] = useState("");
  const [deployDocDirty, setDeployDocDirty] = useState(false);
  const [deployDocSaving, setDeployDocSaving] = useState(false);
  const [deployDocPreview, setDeployDocPreview] = useState(false);

  // Repos state
  const [reposStatus, setReposStatus] = useState<ProjectReposSyncStatus | null>(null);
  const [repoSyncing, setRepoSyncing] = useState(false);
  const [activeRepo, setActiveRepo] = useState("");
  const [repoSubpath, setRepoSubpath] = useState("");
  const [repoEntries, setRepoEntries] = useState<WorkspaceRepoFileEntry[]>([]);
  const [repoListLoading, setRepoListLoading] = useState(false);
  const [repoFile, setRepoFile] = useState<WorkspaceRepoFileContent | null>(null);
  const [repoFileLoading, setRepoFileLoading] = useState(false);

  const fileUploadInputRef = useRef<HTMLInputElement>(null);
  const sqliteUploadInputRef = useRef<HTMLInputElement>(null);

  const projectId = project?.id ?? null;

  const refreshFiles = useCallback(async () => {
    if (!projectId) return;
    setFilesLoading(true);
    try {
      const res = await api.listWorkspaceFiles(projectId);
      setFiles(res.files);
      setFilesTotalBytes(res.total_bytes);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载空间文件失败");
    } finally {
      setFilesLoading(false);
    }
  }, [projectId, toast]);

  const refreshDatabases = useCallback(
    async (refreshClients = false) => {
      if (!projectId) return;
      if (refreshClients) {
        setRefreshingClients(true);
      } else {
        setDbLoading(true);
      }
      try {
        const res = await api.listWorkspaceDatabases(projectId, refreshClients);
        setDatabases(res.databases);
        setDbClients(res.clients ?? []);
        setSelectedDbId((curr) =>
          curr && res.databases.some((d) => d.id === curr) ? curr : (res.databases[0]?.id ?? null),
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "加载数据库列表失败");
      } finally {
        setDbLoading(false);
        setRefreshingClients(false);
      }
    },
    [projectId, toast],
  );

  const refreshHandbook = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await api.getWorkspaceHandbook(projectId);
      setHandbook(res.handbook);
      setHandbookDraft(res.handbook.content);
      setHandbookDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载项目手册失败");
    }
  }, [projectId, toast]);

  const refreshDeployDoc = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await api.getWorkspaceDeployDoc(projectId);
      setDeployDoc(res.deploy_doc);
      setDeployDocDraft(res.deploy_doc.content);
      setDeployDocDirty(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "加载部署文档失败");
    }
  }, [projectId, toast]);

  const refreshReposStatus = useCallback(async () => {
    if (!projectId) return;
    try {
      const st = await api.getProjectReposStatus(projectId);
      setReposStatus(st);
      setActiveRepo((curr) => {
        if (curr && st.repos.some((r) => r.repo === curr)) return curr;
        return st.repos.find((r) => r.ready)?.repo ?? st.repos[0]?.repo ?? "";
      });
    } catch {
      setReposStatus(null);
    }
  }, [projectId]);

  useEffect(() => {
    setSelectedFilePath(null);
    setFileDetail(null);
    setFileDraft("");
    setFileDirty(false);
    setSelectedDbId(null);
    setDbSchema(null);
    setQueryResult(null);
    setQueryError("");
    setRepoFile(null);
    setRepoSubpath("");
    if (!projectId) return;
    void refreshFiles();
    void refreshDatabases();
    void refreshHandbook();
    void refreshDeployDoc();
    void refreshReposStatus();
  }, [projectId, refreshFiles, refreshDatabases, refreshHandbook, refreshDeployDoc, refreshReposStatus]);

  const openFile = useCallback(
    async (relPath: string) => {
      if (!projectId) return;
      setSelectedFilePath(relPath);
      setFileLoading(true);
      setMdPreview(false);
      try {
        const res = await api.getWorkspaceFile(projectId, relPath);
        setFileDetail(res.file);
        setFileDraft(res.file.content ?? "");
        setFileDirty(false);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "读取文件失败");
      } finally {
        setFileLoading(false);
      }
    },
    [projectId, toast],
  );

  const saveCurrentFile = useCallback(async () => {
    if (!projectId || !fileDetail || !fileDetail.is_text || fileSaving) return;
    setFileSaving(true);
    try {
      const res = await api.saveWorkspaceFile(projectId, fileDetail.path, fileDraft);
      setFileDetail(res.file);
      setFileDirty(false);
      toast.success(`已保存 ${fileDetail.path}`);
      void refreshFiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存文件失败");
    } finally {
      setFileSaving(false);
    }
  }, [projectId, fileDetail, fileDraft, fileSaving, toast, refreshFiles]);

  const handleDeleteFile = async (entry: WorkspaceFileEntry) => {
    if (!projectId) return;
    const kindLabel = entry.type === "dir" ? "文件夹及其内容" : "文件";
    if (!window.confirm(`确定删除${kindLabel}「${entry.path}」吗？此操作不可撤销。`)) return;
    try {
      await api.deleteWorkspaceFile(projectId, entry.path);
      toast.success(`已删除 ${entry.path}`);
      if (selectedFilePath === entry.path || selectedFilePath?.startsWith(entry.path + "/")) {
        setSelectedFilePath(null);
        setFileDetail(null);
        setFileDirty(false);
      }
      await refreshFiles();
      if (entry.is_sqlite || entry.type === "dir") {
        await refreshDatabases();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    }
  };

  const handleUploadFiles = async (fileList: FileList | File[], prefixDir = "") => {
    if (!projectId || !fileList.length) return;
    setUploading(true);
    let okCount = 0;
    let lastUploaded: WorkspaceFileDetail | null = null;
    try {
      for (const file of Array.from(fileList)) {
        const cleanName = file.name.replace(/[/\\]/g, "_");
        const targetPath = prefixDir ? `${prefixDir}/${cleanName}` : cleanName;
        const res = await api.uploadWorkspaceFile(projectId, targetPath, file);
        okCount += 1;
        lastUploaded = res.file;
      }
      toast.success(`已上传 ${okCount} 个文件到项目空间`);
      await refreshFiles();
      await refreshDatabases();
      if (lastUploaded && tab === "files") {
        void openFile(lastUploaded.path);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传文件失败");
    } finally {
      setUploading(false);
    }
  };

  const handleCreateItem = async () => {
    if (!projectId || !createModal || !newPath.trim() || creatingItem) return;
    setCreatingItem(true);
    try {
      const target = newPath.trim();
      if (createModal === "dir") {
        await api.createWorkspaceDir(projectId, target);
        toast.success(`已创建目录 ${target}`);
      } else {
        const res = await api.saveWorkspaceFile(projectId, target, newContent);
        toast.success(`已创建文件 ${res.file.path}`);
        setSelectedFilePath(res.file.path);
        setFileDetail(res.file);
        setFileDraft(res.file.content ?? "");
        setFileDirty(false);
      }
      setCreateModal(null);
      setNewPath("");
      setNewContent("");
      await refreshFiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建失败");
    } finally {
      setCreatingItem(false);
    }
  };

  // Load schema when selected database changes
  const selectedDb = useMemo(
    () => databases.find((d) => d.id === selectedDbId) ?? null,
    [databases, selectedDbId],
  );

  useEffect(() => {
    setDbSchema(null);
    setQueryResult(null);
    setQueryError("");
    if (!projectId || !selectedDb || !selectedDb.queryable) return;
    let active = true;
    setSchemaLoading(true);
    api
      .getWorkspaceDatabaseSchema(projectId, selectedDb.id)
      .then((res) => {
        if (!active) return;
        setDbSchema(res.schema);
        const firstTable = res.schema.tables[0]?.name;
        if (firstTable) {
          setSqlInput(`SELECT * FROM "${firstTable.replace(/"/g, '""')}" LIMIT 50;`);
        } else {
          setSqlInput("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view');");
        }
      })
      .catch((err) => {
        if (active) {
          setQueryError(err instanceof Error ? err.message : "读取表结构失败");
        }
      })
      .finally(() => {
        if (active) setSchemaLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, selectedDb]);

  const handleRunSql = async (sqlOverride?: string) => {
    if (!projectId || !selectedDb || !selectedDb.queryable || queryRunning) return;
    const sql = (sqlOverride ?? sqlInput).trim();
    if (!sql) return;
    setQueryRunning(true);
    setQueryError("");
    try {
      const res = await api.queryWorkspaceDatabase(projectId, selectedDb.id, sql, 100);
      setQueryResult(res.result);
    } catch (err) {
      setQueryResult(null);
      setQueryError(err instanceof Error ? err.message : "查询执行失败");
    } finally {
      setQueryRunning(false);
    }
  };

  const handleCreateSqlite = async () => {
    if (!projectId || !sqliteName.trim() || creatingDb) return;
    setCreatingDb(true);
    try {
      const res = await api.createWorkspaceSqlite(projectId, {
        name: sqliteName.trim(),
        init_sql: sqliteInitSql.trim(),
      });
      toast.success(`已创建 SQLite 数据库 ${res.database.name}`);
      setSqliteModalOpen(false);
      setSqliteName("");
      await refreshDatabases();
      await refreshFiles();
      setSelectedDbId(res.database.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "创建数据库失败");
    } finally {
      setCreatingDb(false);
    }
  };

  const openAddExternalDbModal = () => {
    setEditingExtDb(null);
    setExtDbName("");
    setExtDbKind("postgres");
    setExtDbEnvVar("");
    setExtDbUrl("");
    setExtDbClearUrl(false);
    setExtDbReadOnly(true);
    setExtDbNotes("");
    setExtDbModalOpen(true);
  };

  const openEditExternalDbModal = (db: WorkspaceDatabaseEntry) => {
    setEditingExtDb(db);
    setExtDbName(db.name);
    setExtDbKind(db.kind);
    setExtDbEnvVar(db.env_var ?? "");
    setExtDbUrl("");
    setExtDbClearUrl(false);
    setExtDbReadOnly(db.read_only);
    setExtDbNotes(db.notes ?? "");
    setExtDbModalOpen(true);
  };

  const handleSaveExternalDb = async () => {
    if (!projectId || !extDbName.trim() || savingExtDb) return;
    setSavingExtDb(true);
    try {
      if (editingExtDb) {
        const res = await api.updateWorkspaceDatasource(projectId, editingExtDb.id, {
          name: extDbName.trim(),
          kind: extDbKind,
          env_var: extDbEnvVar.trim() || undefined,
          ...(extDbClearUrl
            ? { clear_connection_url: true }
            : extDbUrl.trim()
              ? { connection_url: extDbUrl.trim() }
              : {}),
          read_only: extDbReadOnly,
          notes: extDbNotes.trim(),
        });
        toast.success(`已更新数据源 ${res.database.name}`);
        setExtDbModalOpen(false);
        setEditingExtDb(null);
        await refreshDatabases();
        setSelectedDbId(res.database.id);
      } else {
        const res = await api.addWorkspaceDatasource(projectId, {
          name: extDbName.trim(),
          kind: extDbKind,
          env_var: extDbEnvVar.trim() || undefined,
          connection_url: extDbUrl.trim(),
          read_only: extDbReadOnly,
          notes: extDbNotes.trim(),
        });
        toast.success(`已添加数据源 ${res.database.name}`);
        setExtDbModalOpen(false);
        setExtDbName("");
        setExtDbEnvVar("");
        setExtDbUrl("");
        setExtDbNotes("");
        await refreshDatabases();
        setSelectedDbId(res.database.id);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存数据源失败");
    } finally {
      setSavingExtDb(false);
    }
  };

  const copyText = (value: string, label: string) => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(
      () => toast.success(`已复制${label}`),
      () => toast.error("复制失败"),
    );
  };

  const handleDeleteDatabase = async (db: WorkspaceDatabaseEntry) => {
    if (!projectId) return;
    const msg =
      db.source === "workspace_file"
        ? `确定删除项目空间 SQLite 文件「${db.file_path}」吗？文件将被永久移除。`
        : `确定移除外部数据源「${db.name}」配置吗？`;
    if (!window.confirm(msg)) return;
    try {
      await api.deleteWorkspaceDatabase(projectId, db.id);
      toast.success(`已删除 ${db.name}`);
      await refreshDatabases();
      await refreshFiles();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
    }
  };

  const handleSaveHandbook = async () => {
    if (!projectId || handbookSaving) return;
    setHandbookSaving(true);
    try {
      const res = await api.saveWorkspaceHandbook(projectId, handbookDraft);
      setHandbook(res.handbook);
      setHandbookDirty(false);
      toast.success("项目手册已保存，Codex 对话将自动加载");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存项目手册失败");
    } finally {
      setHandbookSaving(false);
    }
  };

  const handleSaveDeployDoc = async () => {
    if (!projectId || deployDocSaving) return;
    setDeployDocSaving(true);
    try {
      const res = await api.saveWorkspaceDeployDoc(projectId, deployDocDraft);
      setDeployDoc(res.deploy_doc);
      setDeployDocDirty(false);
      toast.success("部署文档 DEPLOY.md 已保存，Release Agent 将按此执行发版");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存部署文档失败");
    } finally {
      setDeployDocSaving(false);
    }
  };

  // Repo browsing
  const loadRepoDir = useCallback(
    async (repo: string, subpath: string) => {
      if (!projectId || !repo) {
        setRepoEntries([]);
        return;
      }
      setRepoListLoading(true);
      try {
        const res = await api.listWorkspaceRepoFiles(projectId, {
          repo,
          path: subpath || undefined,
        });
        setRepoEntries(res.entries);
      } catch {
        setRepoEntries([]);
      } finally {
        setRepoListLoading(false);
      }
    },
    [projectId],
  );

  useEffect(() => {
    if (tab !== "repos" || !activeRepo) return;
    const ready = reposStatus?.repos.find((r) => r.repo === activeRepo)?.ready;
    if (!ready) {
      setRepoEntries([]);
      return;
    }
    void loadRepoDir(activeRepo, repoSubpath);
  }, [tab, activeRepo, repoSubpath, reposStatus, loadRepoDir]);

  const handleSyncRepos = async () => {
    if (!projectId || repoSyncing) return;
    setRepoSyncing(true);
    try {
      const st = await api.syncProjectRepos(projectId);
      setReposStatus(st);
      const firstReady = st.repos.find((r) => r.ready)?.repo;
      if (firstReady && !activeRepo) setActiveRepo(firstReady);
      toast.success("仓库镜像已同步");
      if (firstReady) void loadRepoDir(activeRepo || firstReady, repoSubpath);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "同步仓库失败");
    } finally {
      setRepoSyncing(false);
    }
  };

  const openRepoFile = async (repo: string, path: string) => {
    if (!projectId) return;
    setRepoFileLoading(true);
    try {
      const res = await api.getWorkspaceRepoFile(projectId, {
        repo,
        path,
        start_line: 1,
        end_line: 200,
      });
      setRepoFile(res.file);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "读取仓库文件失败");
    } finally {
      setRepoFileLoading(false);
    }
  };

  const filteredFiles = useMemo(() => {
    const q = fileSearch.trim().toLowerCase();
    if (!q) return files;
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, fileSearch]);

  if (!project) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <EmptyState
          icon="folder-open"
          title="尚未选择项目"
          description="先创建一个项目，即可在项目空间管理文件、数据库、手册并直接与 Codex 对话。"
          action={
            <Button variant="primary" icon="plus" onClick={onNewProject}>
              新建项目
            </Button>
          }
        />
      </div>
    );
  }

  const fileCountOnly = files.filter((f) => f.type === "file").length;
  const readyRepoCount = reposStatus?.repos.filter((r) => r.ready).length ?? 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[var(--surface-canvas)]">
      {/* Header */}
      <header className="shrink-0 border-b border-[var(--border-subtle)] bg-[var(--surface-card)] px-3.5 sm:px-5 py-3 sm:py-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2.5 sm:gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <h1 className="text-[14.5px] sm:text-[15px] font-semibold text-[var(--text-primary)] truncate">
                项目空间 · {project.name}
              </h1>
              <span className="text-[10.5px] sm:text-[11px] font-mono px-2 py-0.5 rounded-full bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-[var(--border-subtle)]">
                {fileCountOnly} 文件 · {formatBytes(filesTotalBytes)}
              </span>
              <span className="text-[10.5px] sm:text-[11px] font-mono px-2 py-0.5 rounded-full bg-[var(--surface-subtle)] text-[var(--text-muted)] border border-[var(--border-subtle)]">
                {databases.length} 数据库
              </span>
            </div>
            <p className="hidden sm:block text-[12px] text-[var(--text-muted)] mt-0.5">
              集中管理项目文档、测试夹具、SQLite/外部数据源与项目手册；所有资料会自动挂载给网页 Codex 对话。
            </p>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon="upload"
              loading={uploading}
              onClick={() => fileUploadInputRef.current?.click()}
            >
              上传文件
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="sparkles"
              onClick={() => onOpenChatWithContext()}
            >
              <span className="hidden sm:inline">打开 Codex 对话</span>
              <span className="sm:hidden">Codex 对话</span>
            </Button>
          </div>
        </div>

        {/* Hidden file inputs */}
        <input
          ref={fileUploadInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              void handleUploadFiles(e.target.files);
              e.target.value = "";
            }
          }}
        />
        <input
          ref={sqliteUploadInputRef}
          type="file"
          accept=".sqlite,.sqlite3,.db"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              void handleUploadFiles(e.target.files, "databases");
              e.target.value = "";
            }
          }}
        />

        {/* Tabs */}
        <div className="flex items-center gap-1 mt-3 -mb-3 sm:-mb-3.5 overflow-x-auto no-scrollbar whitespace-nowrap">
          {(
            [
              { id: "files", label: "文件管理", icon: "folder-open", count: fileCountOnly },
              { id: "databases", label: "数据库 / 数据源", icon: "database", count: databases.length },
              {
                id: "handbook",
                label: "项目手册",
                icon: "book-open",
                badge: handbook?.exists ? "已配置" : "未填写",
                badgeReady: Boolean(handbook?.exists),
              },
              {
                id: "deploy",
                label: "部署文档",
                icon: "rocket",
                badge: deployDoc?.exists ? "已配置" : "未填写",
                badgeReady: Boolean(deployDoc?.exists),
              },
              {
                id: "repos",
                label: "绑定仓库",
                icon: "folder-git-2",
                count: readyRepoCount,
              },
            ] as const
          ).map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setTab(item.id);
                  setMobilePane("list");
                }}
                className={`relative shrink-0 inline-flex items-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors cursor-pointer ${
                  active
                    ? "text-indigo-600 dark:text-indigo-400"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                }`}
              >
                <Icon name={item.icon} size={14} />
                <span>{item.label}</span>
                {"count" in item && (
                  <span className="text-[11px] font-mono px-1.5 py-0.2 rounded-full bg-[var(--surface-subtle)] text-[var(--text-muted)]">
                    {item.count}
                  </span>
                )}
                {"badge" in item && (
                  <span
                    className={`text-[10.5px] px-1.5 py-0.2 rounded-full ${
                      item.badgeReady
                        ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                        : "bg-[var(--surface-subtle)] text-[var(--text-muted)]"
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
                {active && (
                  <span className="absolute left-2 right-2 bottom-0 h-[2px] rounded-full bg-indigo-500" />
                )}
              </button>
            );
          })}
        </div>
      </header>

      {/* TAB 1: FILES */}
      {tab === "files" && (
        <div
          className="flex-1 flex min-h-0 overflow-hidden"
          onDragOver={(e) => {
            e.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragActive(false);
            if (e.dataTransfer.files?.length) {
              void handleUploadFiles(e.dataTransfer.files);
            }
          }}
        >
          {/* Left Tree */}
          <div
            className={`${
              mobilePane === "detail" && (selectedFilePath || fileLoading)
                ? "hidden md:flex"
                : "flex"
            } w-full md:w-[300px] shrink-0 md:border-r border-[var(--border-subtle)] bg-[var(--surface-card)] flex-col min-h-0`}
          >
            <div className="p-3 border-b border-[var(--border-subtle)] space-y-2">
              <div className="flex items-center gap-1.5">
                <Button
                  size="xs"
                  variant="secondary"
                  icon="file-plus-2"
                  className="flex-1"
                  onClick={() => {
                    setCreateModal("file");
                    setNewPath("notes/spec.md");
                    setNewContent("# 接口或需求说明\n\n");
                  }}
                >
                  新建文件
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  icon="folder-plus"
                  onClick={() => {
                    setCreateModal("dir");
                    setNewPath("docs");
                    setNewContent("");
                  }}
                >
                  目录
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  icon="refresh-cw"
                  title="刷新列表"
                  onClick={() => void refreshFiles()}
                />
              </div>
              <div className="relative">
                <Icon
                  name="search"
                  size={13}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
                />
                <input
                  type="text"
                  value={fileSearch}
                  onChange={(e) => setFileSearch(e.target.value)}
                  placeholder="筛选空间文件…"
                  className="w-full h-8 pl-8 pr-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[12.5px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {dragActive && (
                <div className="p-4 mb-2 rounded-xl border-2 border-dashed border-indigo-500 bg-indigo-500/10 text-center text-[12px] text-indigo-600 dark:text-indigo-300 font-medium">
                  松开鼠标即可上传到项目空间
                </div>
              )}
              {filesLoading ? (
                <div className="p-6 text-center text-[12.5px] text-[var(--text-muted)] flex items-center justify-center gap-2">
                  <Icon name="loader-2" size={14} className="animate-spin" />
                  正在加载…
                </div>
              ) : filteredFiles.length === 0 ? (
                <div className="p-6 text-center space-y-2.5">
                  <div className="w-9 h-9 rounded-xl bg-[var(--surface-subtle)] text-[var(--text-muted)] flex items-center justify-center mx-auto">
                    <Icon name="folder-open" size={18} />
                  </div>
                  <p className="text-[12.5px] text-[var(--text-muted)]">
                    {fileSearch ? "没有匹配的文件" : "项目空间还是空的"}
                  </p>
                  {!fileSearch && (
                    <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">
                      可拖拽上传文档、CSV、JSON、SQLite 文件，或点击上方「新建文件」。
                    </p>
                  )}
                </div>
              ) : (
                filteredFiles.map((entry) => {
                  const active = selectedFilePath === entry.path;
                  const depth = entry.path.split("/").length - 1;
                  return (
                    <div
                      key={entry.path}
                      style={{ paddingLeft: `${8 + depth * 14}px` }}
                      className={`group flex items-center justify-between gap-1.5 pr-1.5 py-1.5 rounded-lg text-[12.5px] transition-colors ${
                        active
                          ? "bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 font-medium"
                          : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          if (entry.type === "file") {
                            setMobilePane("detail");
                            void openFile(entry.path);
                          }
                        }}
                        className={`flex items-center gap-2 min-w-0 flex-1 text-left ${
                          entry.type === "file" ? "cursor-pointer" : "cursor-default"
                        }`}
                      >
                        <Icon
                          name={fileIconName(entry)}
                          size={14}
                          className={
                            entry.is_sqlite
                              ? "text-emerald-500"
                              : entry.type === "dir"
                                ? "text-amber-500"
                                : active
                                  ? "text-indigo-500"
                                  : "text-[var(--text-muted)]"
                          }
                        />
                        <span className="truncate font-mono text-[12px]">{entry.name}</span>
                      </button>
                      <div className="flex items-center gap-1 shrink-0">
                        {entry.type === "file" && (
                          <span className="text-[10.5px] font-mono text-[var(--text-muted)] md:group-hover:hidden">
                            {formatBytes(entry.size)}
                          </span>
                        )}
                        <button
                          type="button"
                          title="删除"
                          aria-label={`删除 ${entry.name}`}
                          onClick={() => void handleDeleteFile(entry)}
                          className="inline-flex md:hidden md:group-hover:inline-flex p-1.5 md:p-1 rounded text-[var(--text-muted)] hover:text-rose-500 hover:bg-rose-500/10 cursor-pointer"
                        >
                          <Icon name="trash-2" size={12} />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Right File Viewer / Editor */}
          <div
            className={`${
              mobilePane === "detail" && (selectedFilePath || fileLoading)
                ? "flex"
                : "hidden md:flex"
            } flex-1 flex-col min-w-0 min-h-0`}
          >
            {fileLoading ? (
              <div className="flex-1 flex items-center justify-center text-[13px] text-[var(--text-muted)] gap-2">
                <Icon name="loader-2" size={15} className="animate-spin text-indigo-500" />
                正在读取文件…
              </div>
            ) : !fileDetail ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <EmptyState
                  icon="file-text"
                  title="选择左侧文件进行查看或编辑"
                  description="支持在线编辑 Markdown / JSON / SQL / CSV / 代码文件，也支持上传 SQLite 数据库与其他二进制附件。"
                  action={
                    <div className="flex items-center gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="file-plus-2"
                        onClick={() => {
                          setCreateModal("file");
                          setNewPath("notes/spec.md");
                          setNewContent("# 项目资料\n\n");
                        }}
                      >
                        新建文本文件
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        icon="upload"
                        onClick={() => fileUploadInputRef.current?.click()}
                      >
                        上传本地文件
                      </Button>
                    </div>
                  }
                />
              </div>
            ) : (
              <>
                <div className="shrink-0 px-3 sm:px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--surface-card)] flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      type="button"
                      onClick={() => setMobilePane("list")}
                      className="md:hidden inline-flex items-center gap-1 h-8 px-2 -ml-1 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] shrink-0 cursor-pointer"
                    >
                      <Icon name="arrow-left" size={14} />
                      <span>列表</span>
                    </button>
                    <Icon name={fileIconName(fileDetail)} size={15} className="text-indigo-500 shrink-0" />
                    <span className="font-mono text-[13px] font-medium text-[var(--text-primary)] truncate">
                      files/{fileDetail.path}
                    </span>
                    <span className="text-[11px] font-mono text-[var(--text-muted)]">
                      {formatBytes(fileDetail.size)}
                    </span>
                    {fileDirty && (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/12 text-amber-600 dark:text-amber-400">
                        未保存
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    {fileDetail.ext === ".md" && (
                      <Button
                        size="xs"
                        variant={mdPreview ? "secondary" : "ghost"}
                        icon={mdPreview ? "pen-line" : "eye"}
                        onClick={() => setMdPreview((v) => !v)}
                      >
                        {mdPreview ? "编辑" : "预览"}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="secondary"
                      icon="sparkles"
                      onClick={() =>
                        onOpenChatWithContext(
                          {
                            kind: "file",
                            label: fileDetail.path,
                            ref: fileDetail.path,
                          },
                          `请阅读并分析项目空间文件 files/${fileDetail.path}：`,
                        )
                      }
                    >
                      在 Codex 中讨论
                    </Button>
                    <a
                      href={`/api/projects/${encodeURIComponent(project.id)}/workspace/file?path=${encodeURIComponent(fileDetail.path)}&download=1`}
                      className="inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs font-medium border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      <Icon name="download" size={13} />
                      下载
                    </a>
                    {fileDetail.is_text && (
                      <Button
                        size="xs"
                        variant="primary"
                        icon="save"
                        loading={fileSaving}
                        disabled={!fileDirty}
                        onClick={() => void saveCurrentFile()}
                      >
                        保存
                      </Button>
                    )}
                  </div>
                </div>

                {fileDetail.is_sqlite ? (
                  <div className="flex-1 flex items-center justify-center p-8">
                    <div className="max-w-md w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6 text-center space-y-3">
                      <div className="w-11 h-11 rounded-xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 flex items-center justify-center mx-auto">
                        <Icon name="database" size={22} />
                      </div>
                      <h3 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
                        SQLite 数据库文件
                      </h3>
                      <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed">
                        <code className="font-mono">files/{fileDetail.path}</code> 已自动识别为项目数据库，可直接查看表结构、执行只读 SQL 查询，或交由 Codex 分析。
                      </p>
                      <div className="flex items-center justify-center gap-2 pt-1">
                        <Button
                          variant="primary"
                          size="sm"
                          icon="table-2"
                          onClick={() => {
                            const match = databases.find((d) => d.file_path === fileDetail.path);
                            if (match) setSelectedDbId(match.id);
                            setTab("databases");
                          }}
                        >
                          在数据库面板打开
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          icon="sparkles"
                          onClick={() =>
                            onOpenChatWithContext(
                              {
                                kind: "database",
                                label: fileDetail.name,
                                ref: `files/${fileDetail.path}`,
                              },
                              `请检查 SQLite 数据库 files/${fileDetail.path} 的表结构并总结关键数据。`,
                            )
                          }
                        >
                          让 Codex 分析
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : !fileDetail.is_text ? (
                  <div className="flex-1 flex items-center justify-center p-8">
                    <EmptyState
                      icon="file"
                      title="二进制文件不支持文本编辑"
                      description={`文件大小 ${formatBytes(fileDetail.size)}，更新于 ${formatRelativeTime(fileDetail.updated_at)}。你可以下载该文件或在 Codex 对话中引用其路径。`}
                    />
                  </div>
                ) : mdPreview ? (
                  <div className="flex-1 overflow-y-auto p-6">
                    <div className="max-w-3xl mx-auto rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6">
                      <MarkdownContent content={fileDraft} />
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col min-h-0 p-3">
                    {fileDetail.truncated && (
                      <div className="mb-2 px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-700 dark:text-amber-300 text-[12px]">
                        文件超过 512 KB，仅展示前半部分；保存将覆盖全文，请谨慎编辑。
                      </div>
                    )}
                    <textarea
                      value={fileDraft}
                      onChange={(e) => {
                        setFileDraft(e.target.value);
                        setFileDirty(true);
                      }}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                          e.preventDefault();
                          void saveCurrentFile();
                        }
                      }}
                      spellCheck={false}
                      className="flex-1 w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 font-mono text-[13px] leading-relaxed text-[var(--text-primary)] resize-none focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: DATABASES */}
      {tab === "databases" && (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* Left Database List */}
          <div
            className={`${
              mobilePane === "detail" && selectedDb
                ? "hidden md:flex"
                : "flex"
            } w-full md:w-[310px] shrink-0 md:border-r border-[var(--border-subtle)] bg-[var(--surface-card)] flex-col min-h-0`}
          >
            <div className="p-3 border-b border-[var(--border-subtle)] space-y-2">
              <div className="grid grid-cols-2 gap-1.5">
                <Button
                  size="xs"
                  variant="primary"
                  icon="plus"
                  onClick={() => {
                    setSqliteName("app-sample");
                    setSqliteInitSql(SAMPLE_SQLITE_INIT);
                    setSqliteModalOpen(true);
                  }}
                >
                  新建 SQLite
                </Button>
                <Button
                  size="xs"
                  variant="secondary"
                  icon="upload"
                  onClick={() => sqliteUploadInputRef.current?.click()}
                >
                  上传 SQLite
                </Button>
              </div>
              <Button
                size="xs"
                variant="secondary"
                icon="plug"
                className="w-full"
                onClick={openAddExternalDbModal}
              >
                添加外部数据源（PG / MySQL / Redis…）
              </Button>
            </div>

            <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
              {dbLoading ? (
                <div className="p-6 text-center text-[12.5px] text-[var(--text-muted)]">
                  正在加载数据库…
                </div>
              ) : databases.length === 0 ? (
                <div className="p-6 text-center space-y-2">
                  <div className="w-9 h-9 rounded-xl bg-[var(--surface-subtle)] text-[var(--text-muted)] flex items-center justify-center mx-auto">
                    <Icon name="database" size={18} />
                  </div>
                  <p className="text-[12.5px] text-[var(--text-muted)]">暂无项目数据库</p>
                  <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">
                    新建或上传 <code className="font-mono">.sqlite</code> 文件可在线跑只读 SQL；配置外部数据源则会自动以环境变量注入给 Codex / Claude。
                  </p>
                </div>
              ) : (
                databases.map((db) => {
                  const active = db.id === selectedDbId;
                  return (
                    <div
                      key={db.id}
                      className={`group rounded-xl border p-2.5 transition-colors cursor-pointer ${
                        active
                          ? "border-indigo-500/50 bg-indigo-500/8"
                          : "border-[var(--border-subtle)] bg-[var(--surface-elevated)] hover:border-[var(--border-strong)]"
                      }`}
                      onClick={() => {
                        setSelectedDbId(db.id);
                        setMobilePane("detail");
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon
                            name="database"
                            size={15}
                            className={
                              db.source === "workspace_file"
                                ? "text-emerald-500"
                                : "text-indigo-500"
                            }
                          />
                          <span className="text-[13px] font-medium text-[var(--text-primary)] truncate">
                            {db.name}
                          </span>
                        </div>
                        <div className="flex items-center gap-0.5 shrink-0">
                          {db.source === "external" && (
                            <button
                              type="button"
                              title="编辑配置"
                              aria-label={`编辑 ${db.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                openEditExternalDbModal(db);
                              }}
                              className="opacity-80 md:opacity-0 md:group-hover:opacity-100 p-1.5 md:p-1 rounded text-[var(--text-muted)] hover:text-indigo-500 hover:bg-indigo-500/10 transition cursor-pointer"
                            >
                              <Icon name="pen-line" size={12} />
                            </button>
                          )}
                          <button
                            type="button"
                            title="删除"
                            aria-label={`删除 ${db.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteDatabase(db);
                            }}
                            className="opacity-80 md:opacity-0 md:group-hover:opacity-100 p-1.5 md:p-1 rounded text-[var(--text-muted)] hover:text-rose-500 hover:bg-rose-500/10 transition cursor-pointer"
                          >
                            <Icon name="trash-2" size={12} />
                          </button>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <span className="text-[10.5px] uppercase font-mono px-1.5 py-0.5 rounded bg-[var(--surface-subtle)] text-[var(--text-secondary)]">
                          {db.kind}
                        </span>
                        {db.source === "workspace_file" ? (
                          <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                            {db.table_count ?? 0} 张表 · {formatBytes(db.size ?? 0)}
                          </span>
                        ) : (
                          <>
                            <span className="text-[10.5px] px-1.5 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
                              {db.read_only ? "只读外部库" : "外部库"}
                            </span>
                            {db.has_connection_url && db.env_var && (
                              <span
                                title={`子进程自动注入环境变量 $${db.env_var}`}
                                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 truncate max-w-[165px]"
                              >
                                ${db.env_var}
                              </span>
                            )}
                          </>
                        )}
                      </div>
                      {db.host_preview && (
                        <div className="text-[11px] font-mono text-[var(--text-muted)] truncate mt-1">
                          {db.host_preview}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Detected Local DB CLI Clients Footer */}
            <div className="shrink-0 p-3 border-t border-[var(--border-subtle)] bg-[var(--surface-subtle)] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11.5px] font-medium text-[var(--text-secondary)] flex items-center gap-1.5">
                  <Icon name="terminal" size={12} className="text-indigo-500" />
                  本机数据库 CLI
                </span>
                <button
                  type="button"
                  disabled={refreshingClients}
                  onClick={() => void refreshDatabases(true)}
                  className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer disabled:opacity-50"
                  title="重新检测宿主机已安装的数据库客户端"
                >
                  <Icon
                    name="refresh-cw"
                    size={11}
                    className={refreshingClients ? "animate-spin" : ""}
                  />
                  刷新
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {dbClients.map((client) => (
                  <button
                    key={client.id}
                    type="button"
                    title={
                      client.installed
                        ? `${client.label} 已安装 (${client.bin_path ?? client.id})`
                        : `未检测到 ${client.id}，点击复制安装命令：${client.install_hint}`
                    }
                    onClick={() => {
                      if (!client.installed) {
                        copyText(client.install_hint, `${client.id} 安装命令`);
                      }
                    }}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono border transition ${
                      client.installed
                        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 cursor-default"
                        : "border-[var(--border-subtle)] bg-[var(--surface-card)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)] cursor-pointer"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full ${
                        client.installed ? "bg-emerald-500" : "bg-zinc-400 dark:bg-zinc-600"
                      }`}
                    />
                    {client.id}
                  </button>
                ))}
              </div>
              <p className="text-[10.5px] text-[var(--text-muted)] leading-relaxed">
                Agent 会直接调用本机 CLI + 环境变量连库；灰色项点击可复制安装命令。
              </p>
            </div>
          </div>

          {/* Right Database Inspector & SQL Console */}
          <div
            className={`${
              mobilePane === "detail" && selectedDb
                ? "flex"
                : "hidden md:flex"
            } flex-1 flex-col min-w-0 min-h-0 overflow-hidden`}
          >
            {!selectedDb ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <EmptyState
                  icon="database"
                  title="选择或添加一个项目数据库"
                  description="SQLite 文件支持在线浏览 Schema 与只读 SQL；外部数据库会以环境变量注入给 Codex / Claude 直接连库排查。"
                  action={
                    <div className="flex items-center gap-2">
                      <Button
                        variant="primary"
                        size="sm"
                        icon="plus"
                        onClick={() => {
                          setSqliteName("app-sample");
                          setSqliteInitSql(SAMPLE_SQLITE_INIT);
                          setSqliteModalOpen(true);
                        }}
                      >
                        新建 SQLite 数据库
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        icon="plug"
                        onClick={openAddExternalDbModal}
                      >
                        添加外部数据源
                      </Button>
                    </div>
                  }
                />
              </div>
            ) : !selectedDb.queryable ? (
              (() => {
                const matchedClient = findMatchingDbClient(dbClients, selectedDb.kind);
                const cliExample = buildDatasourceCliExample(selectedDb);
                return (
                  <div className="flex-1 overflow-y-auto p-3.5 sm:p-6">
                    <div className="md:hidden mb-3">
                      <button
                        type="button"
                        onClick={() => setMobilePane("list")}
                        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-card)] text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
                      >
                        <Icon name="arrow-left" size={13} />
                        <span>返回数据源列表</span>
                      </button>
                    </div>
                    <div className="max-w-2xl rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 sm:p-6 space-y-5">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 rounded-xl bg-indigo-500/12 text-indigo-500 flex items-center justify-center shrink-0">
                            <Icon name="database" size={20} />
                          </div>
                          <div className="min-w-0">
                            <h2 className="text-[15px] font-semibold text-[var(--text-primary)] truncate">
                              {selectedDb.name}
                            </h2>
                            <p className="text-[12px] font-mono text-[var(--text-muted)] truncate">
                              {selectedDb.kind.toUpperCase()} · {selectedDb.host_preview || "未填写连接串"}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            variant="secondary"
                            icon="pen-line"
                            onClick={() => openEditExternalDbModal(selectedDb)}
                          >
                            编辑配置
                          </Button>
                          <Button
                            size="sm"
                            variant="primary"
                            icon="sparkles"
                            onClick={() => {
                              const envHint =
                                selectedDb.has_connection_url && selectedDb.env_var
                                  ? `已通过环境变量 $${selectedDb.env_var} 注入连接串`
                                  : "尚未配置连接串（仅登记了元数据说明）";
                              onOpenChatWithContext(
                                {
                                  kind: "database",
                                  label: selectedDb.name,
                                  ref: selectedDb.env_var
                                    ? `$${selectedDb.env_var}`
                                    : selectedDb.host_preview || selectedDb.name,
                                },
                                selectedDb.has_connection_url && selectedDb.env_var
                                  ? `请使用本机数据库 CLI 通过环境变量 $${selectedDb.env_var} 连接数据源「${selectedDb.name}」（${envHint}），先检查表结构/核心数据概览（注意遵守${selectedDb.read_only ? "严格只读" : "读写"}策略，且不要打印环境变量原始值）。`
                                  : `请结合数据源「${selectedDb.name}」的说明帮我设计排查 SQL 或分析方案：`,
                                { enableNetwork: true },
                              );
                            }}
                          >
                            在 Codex 中连库排查
                          </Button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12.5px]">
                        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-3 space-y-1">
                          <div className="flex items-center justify-between text-[11px] text-[var(--text-muted)]">
                            <span>子进程环境变量</span>
                            {selectedDb.env_var && (
                              <button
                                type="button"
                                onClick={() => copyText(`$${selectedDb.env_var}`, "环境变量名")}
                                className="inline-flex items-center gap-1 hover:text-[var(--text-primary)] cursor-pointer"
                              >
                                <Icon name="copy" size={11} />
                                复制
                              </button>
                            )}
                          </div>
                          <div className="font-mono font-medium text-[var(--text-primary)] truncate">
                            {selectedDb.env_var ? `$${selectedDb.env_var}` : "未分配"}
                          </div>
                          <div className="text-[11px] text-[var(--text-muted)]">
                            {selectedDb.has_connection_url
                              ? "对话启动时自动注入，输出流全程脱敏"
                              : "填写连接串后才会自动注入到子进程"}
                          </div>
                        </div>

                        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-subtle)] p-3 space-y-1">
                          <div className="text-[11px] text-[var(--text-muted)]">访问策略 & 凭据</div>
                          <div className="font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                            <Icon
                              name={selectedDb.read_only ? "shield-check" : "shield-alert"}
                              size={14}
                              className={
                                selectedDb.read_only ? "text-emerald-500" : "text-amber-500"
                              }
                            />
                            {selectedDb.read_only ? "严格只读" : "读写模式"}
                            <span className="text-[11px] font-normal text-[var(--text-muted)]">
                              · {selectedDb.has_connection_url ? "0600 仅写保存" : "仅元数据"}
                            </span>
                          </div>
                          <div className="text-[11px] text-[var(--text-muted)]">
                            {selectedDb.read_only && selectedDb.kind === "postgres"
                              ? "自动注入 PGOPTIONS 只读事务保护"
                              : selectedDb.read_only
                                ? "Prompt 约束仅执行只读查询，建议使用只读账号"
                                : "允许执行写入操作，请谨慎使用"}
                          </div>
                        </div>
                      </div>

                      {/* Matched Local CLI Client Status */}
                      <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3.5 space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--text-primary)]">
                            <Icon name="terminal" size={14} className="text-indigo-500" />
                            <span>
                              Agent 直连方式
                              {matchedClient ? `（${matchedClient.label}）` : ""}
                            </span>
                          </div>
                          {matchedClient && (
                            <span
                              className={`inline-flex items-center gap-1.5 text-[11px] px-2 py-0.5 rounded-full ${
                                matchedClient.installed
                                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                  : "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                              }`}
                            >
                              <span
                                className={`w-1.5 h-1.5 rounded-full ${
                                  matchedClient.installed ? "bg-emerald-500" : "bg-amber-500"
                                }`}
                              />
                              {matchedClient.installed
                                ? `本机已安装 ${matchedClient.id}`
                                : `宿主机未安装 ${matchedClient.id}`}
                            </span>
                          )}
                        </div>

                        {selectedDb.has_connection_url ? (
                          <div className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface-subtle)] border border-[var(--border-subtle)] px-3 py-2 font-mono text-[11.5px] text-[var(--text-secondary)]">
                            <code className="truncate">{cliExample}</code>
                            <button
                              type="button"
                              onClick={() => copyText(cliExample, "示例命令")}
                              className="shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                              title="复制命令"
                            >
                              <Icon name="copy" size={13} />
                            </button>
                          </div>
                        ) : (
                          <p className="text-[12px] text-[var(--text-muted)]">
                            尚未保存连接串。点击右上角「编辑配置」填入只读连接串后，Codex / Claude 即可免密使用环境变量直连。
                          </p>
                        )}

                        {matchedClient && !matchedClient.installed && (
                          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-[11.5px] text-amber-700 dark:text-amber-300">
                            <span>
                              建议在宿主机安装客户端：{" "}
                              <code className="font-mono">{matchedClient.install_hint}</code>
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                copyText(matchedClient.install_hint, `${matchedClient.id} 安装命令`)
                              }
                              className="inline-flex items-center gap-1 font-medium hover:underline cursor-pointer"
                            >
                              <Icon name="copy" size={12} />
                              复制安装命令
                            </button>
                          </div>
                        )}

                        <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">
                          点击「在 Codex 中连库排查」会自动为会话开启「允许联网」开关；使用 Codex CLI 时沙箱会透传{" "}
                          <code className="font-mono">network_access=true</code>，Claude Code 直接复用本机网络。
                        </p>
                      </div>

                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[12px] font-medium text-[var(--text-primary)]">
                            Schema / 业务说明（自动提供给 Codex）
                          </span>
                          <button
                            type="button"
                            onClick={() => openEditExternalDbModal(selectedDb)}
                            className="text-[11.5px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer"
                          >
                            编辑说明
                          </button>
                        </div>
                        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3.5 text-[12.5px] text-[var(--text-secondary)] whitespace-pre-wrap leading-relaxed">
                          {selectedDb.notes || "暂无补充说明。建议填写核心表名、字段含义与常用查询约定。"}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()
            ) : (
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                {/* Top bar */}
                <div className="shrink-0 px-3 sm:px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--surface-card)] flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <button
                      type="button"
                      onClick={() => setMobilePane("list")}
                      className="md:hidden inline-flex items-center gap-1 h-8 px-2 -ml-1 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] shrink-0 cursor-pointer"
                    >
                      <Icon name="arrow-left" size={14} />
                      <span>列表</span>
                    </button>
                    <Icon name="database" size={15} className="text-emerald-500 shrink-0" />
                    <span className="text-[13.5px] font-semibold text-[var(--text-primary)] truncate">
                      {selectedDb.name}
                    </span>
                    <span className="text-[11px] font-mono text-[var(--text-muted)]">
                      files/{selectedDb.file_path}
                    </span>
                  </div>
                  <Button
                    size="xs"
                    variant="primary"
                    icon="sparkles"
                    onClick={() =>
                      onOpenChatWithContext(
                        {
                          kind: "database",
                          label: selectedDb.name,
                          ref: `files/${selectedDb.file_path}`,
                        },
                        `请检查 SQLite 数据库 files/${selectedDb.file_path} 的表结构与数据分布，并告诉我关键发现。`,
                      )
                    }
                  >
                    让 Codex 分析此库
                  </Button>
                </div>

                {/* Split: Schema + SQL Console */}
                <div className="flex-1 grid grid-cols-1 xl:grid-cols-[260px_1fr] min-h-0 overflow-hidden">
                  {/* Schema sidebar */}
                  <div className="border-b xl:border-b-0 xl:border-r border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-y-auto p-3 space-y-2.5 max-h-[240px] xl:max-h-none">
                    <div className="text-[11.5px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                      表结构 ({dbSchema?.tables.length ?? 0})
                    </div>
                    {schemaLoading ? (
                      <div className="text-[12px] text-[var(--text-muted)] flex items-center gap-1.5">
                        <Icon name="loader-2" size={13} className="animate-spin" />
                        读取中…
                      </div>
                    ) : !dbSchema || dbSchema.tables.length === 0 ? (
                      <p className="text-[12px] text-[var(--text-muted)]">暂无用户数据表</p>
                    ) : (
                      dbSchema.tables.map((t) => (
                        <div
                          key={t.name}
                          className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] overflow-hidden"
                        >
                          <button
                            type="button"
                            onClick={() => {
                              const q = `SELECT * FROM "${t.name.replace(/"/g, '""')}" LIMIT 50;`;
                              setSqlInput(q);
                              void handleRunSql(q);
                            }}
                            className="w-full px-2.5 py-2 flex items-center justify-between gap-2 text-left hover:bg-[var(--surface-hover)] cursor-pointer"
                          >
                            <span className="flex items-center gap-1.5 min-w-0">
                              <Icon name="table-2" size={13} className="text-indigo-500" />
                              <span className="font-mono text-[12px] font-medium text-[var(--text-primary)] truncate">
                                {t.name}
                              </span>
                            </span>
                            <span className="text-[10.5px] font-mono text-[var(--text-muted)] shrink-0">
                              {t.row_count} 行
                            </span>
                          </button>
                          <div className="px-2.5 pb-2 pt-1 border-t border-[var(--border-subtle)] space-y-1">
                            {t.columns.map((col) => (
                              <div
                                key={col.name}
                                className="flex items-center justify-between gap-2 text-[11px] font-mono"
                              >
                                <span className="text-[var(--text-secondary)] truncate">
                                  {col.pk ? "🔑 " : ""}
                                  {col.name}
                                </span>
                                <span className="text-[var(--text-muted)] shrink-0">
                                  {col.type}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* SQL Query Console & Results */}
                  <div className="flex flex-col min-w-0 min-h-0 overflow-hidden p-3.5 gap-3">
                    <div className="shrink-0 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] overflow-hidden">
                      <div className="px-3 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between gap-2">
                        <span className="text-[12px] font-medium text-[var(--text-secondary)]">
                          只读 SQL 查询（SELECT / WITH / EXPLAIN）
                        </span>
                        <Button
                          size="xs"
                          variant="primary"
                          icon="play"
                          loading={queryRunning}
                          disabled={!sqlInput.trim()}
                          onClick={() => void handleRunSql()}
                        >
                          运行查询 (⌘Enter)
                        </Button>
                      </div>
                      <textarea
                        rows={4}
                        value={sqlInput}
                        onChange={(e) => setSqlInput(e.target.value)}
                        onKeyDown={(e) => {
                          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                            e.preventDefault();
                            void handleRunSql();
                          }
                        }}
                        spellCheck={false}
                        placeholder='SELECT * FROM "my_table" LIMIT 50;'
                        className="w-full p-3 font-mono text-[12.5px] bg-transparent text-[var(--text-primary)] resize-y focus:outline-none"
                      />
                    </div>

                    {queryError && (
                      <div className="shrink-0 rounded-xl border border-rose-500/25 bg-rose-500/10 px-3.5 py-2.5 text-[12.5px] text-rose-600 dark:text-rose-300">
                        {queryError}
                      </div>
                    )}

                    <div className="flex-1 min-h-0 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] flex flex-col overflow-hidden">
                      <div className="shrink-0 px-3.5 py-2 border-b border-[var(--border-subtle)] flex items-center justify-between text-[12px] text-[var(--text-muted)]">
                        <span>查询结果</span>
                        {queryResult && (
                          <span className="font-mono">
                            {queryResult.row_count} 行{queryResult.truncated ? "（已截断）" : ""} ·{" "}
                            {queryResult.duration_ms} ms
                          </span>
                        )}
                      </div>
                      <div className="flex-1 overflow-auto">
                        {!queryResult ? (
                          <div className="h-full flex items-center justify-center p-6 text-[12.5px] text-[var(--text-muted)]">
                            点击左侧数据表或输入 SQL 后点击「运行查询」
                          </div>
                        ) : queryResult.columns.length === 0 ? (
                          <div className="h-full flex items-center justify-center p-6 text-[12.5px] text-[var(--text-muted)]">
                            查询成功，返回 0 行结果
                          </div>
                        ) : (
                          <table className="w-full border-collapse text-left font-mono text-[12px]">
                            <thead className="sticky top-0 bg-[var(--surface-subtle)] border-b border-[var(--border-subtle)]">
                              <tr>
                                {queryResult.columns.map((col) => (
                                  <th
                                    key={col}
                                    className="px-3 py-2 font-semibold text-[var(--text-primary)] whitespace-nowrap border-r border-[var(--border-subtle)] last:border-r-0"
                                  >
                                    {col}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {queryResult.rows.map((row, idx) => (
                                <tr
                                  key={idx}
                                  className="border-b border-[var(--border-subtle)] last:border-b-0 hover:bg-[var(--surface-hover)]"
                                >
                                  {queryResult.columns.map((col) => {
                                    const val = row[col];
                                    return (
                                      <td
                                        key={col}
                                        className="px-3 py-1.5 text-[var(--text-secondary)] max-w-[320px] truncate border-r border-[var(--border-subtle)] last:border-r-0"
                                        title={val === null ? "NULL" : String(val)}
                                      >
                                        {val === null ? (
                                          <span className="text-[var(--text-muted)] italic">NULL</span>
                                        ) : (
                                          String(val)
                                        )}
                                      </td>
                                    );
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: HANDBOOK */}
      {tab === "handbook" && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden p-4 gap-3">
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[12.5px] text-[var(--text-secondary)]">
              保存为项目空间根目录下 <code className="font-mono text-[var(--text-primary)]">HANDBOOK.md</code>，网页 Codex / Claude 对话启动时会自动载入。
              {handbook?.updated_at && (
                <span className="text-[var(--text-muted)] ml-2">
                  上次更新：{formatRelativeTime(handbook.updated_at)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!handbookDraft.trim() && (
                <Button
                  size="xs"
                  variant="secondary"
                  icon="file-text"
                  onClick={() => {
                    setHandbookDraft(HANDBOOK_TEMPLATE);
                    setHandbookDirty(true);
                  }}
                >
                  填入推荐模板
                </Button>
              )}
              <Button
                size="xs"
                variant={handbookPreview ? "secondary" : "ghost"}
                icon={handbookPreview ? "pen-line" : "eye"}
                onClick={() => setHandbookPreview((v) => !v)}
              >
                {handbookPreview ? "返回编辑" : "Markdown 预览"}
              </Button>
              <Button
                size="xs"
                variant="primary"
                icon="save"
                loading={handbookSaving}
                disabled={!handbookDirty}
                onClick={() => void handleSaveHandbook()}
              >
                保存手册 (⌘S)
              </Button>
            </div>
          </div>

          {handbookPreview ? (
            <div className="flex-1 overflow-y-auto rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6">
              {handbookDraft.trim() ? (
                <MarkdownContent content={handbookDraft} />
              ) : (
                <p className="text-[13px] text-[var(--text-muted)]">手册内容为空</p>
              )}
            </div>
          ) : (
            <textarea
              value={handbookDraft}
              onChange={(e) => {
                setHandbookDraft(e.target.value);
                setHandbookDirty(true);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void handleSaveHandbook();
                }
              }}
              placeholder="在这里记录项目的目录结构、构建测试命令、数据库说明与排查约定…"
              className="flex-1 w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 font-mono text-[13px] leading-relaxed text-[var(--text-primary)] resize-none focus:outline-none focus:border-indigo-500"
            />
          )}
        </div>
      )}

      {/* TAB 3.5: DEPLOY.md */}
      {tab === "deploy" && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden p-4 gap-3">
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-2">
            <div className="text-[12.5px] text-[var(--text-secondary)]">
              保存为项目空间根目录下{" "}
              <code className="font-mono text-[var(--text-primary)]">DEPLOY.md</code>
              ，生产发布时 Release Agent 会同步读取并按此执行部署与验收。
              {deployDoc?.updated_at && (
                <span className="text-[var(--text-muted)] ml-2">
                  上次更新：{formatRelativeTime(deployDoc.updated_at)}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!deployDocDraft.trim() && (
                <Button
                  size="xs"
                  variant="secondary"
                  icon="file-text"
                  onClick={() => {
                    setDeployDocDraft(DEPLOY_DOC_TEMPLATE);
                    setDeployDocDirty(true);
                  }}
                >
                  填入推荐模板
                </Button>
              )}
              <Button
                size="xs"
                variant={deployDocPreview ? "secondary" : "ghost"}
                icon={deployDocPreview ? "pen-line" : "eye"}
                onClick={() => setDeployDocPreview((v) => !v)}
              >
                {deployDocPreview ? "返回编辑" : "Markdown 预览"}
              </Button>
              <Button
                size="xs"
                variant="primary"
                icon="save"
                loading={deployDocSaving}
                disabled={!deployDocDirty}
                onClick={() => void handleSaveDeployDoc()}
              >
                保存部署文档 (⌘S)
              </Button>
            </div>
          </div>

          {deployDocPreview ? (
            <div className="flex-1 overflow-y-auto rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-6">
              {deployDocDraft.trim() ? (
                <MarkdownContent content={deployDocDraft} />
              ) : (
                <p className="text-[13px] text-[var(--text-muted)]">部署文档内容为空</p>
              )}
            </div>
          ) : (
            <textarea
              value={deployDocDraft}
              onChange={(e) => {
                setDeployDocDraft(e.target.value);
                setDeployDocDirty(true);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                  e.preventDefault();
                  void handleSaveDeployDoc();
                }
              }}
              placeholder="在这里编写生产环境的发布命令、SSH / Docker / Pier 步骤、健康检查与回滚方式…"
              className="flex-1 w-full rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-5 font-mono text-[13px] leading-relaxed text-[var(--text-primary)] resize-none focus:outline-none focus:border-indigo-500"
            />
          )}
        </div>
      )}

      {/* TAB 4: BOUND REPOSITORIES */}
      {tab === "repos" && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="shrink-0 px-3.5 sm:px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--surface-card)] flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 min-w-0 flex-1 sm:flex-initial">
              {reposStatus && reposStatus.repos.length > 0 ? (
                <div className="w-full sm:w-[260px]">
                  <Select
                    ariaLabel="选择绑定仓库"
                    fullWidth
                    value={activeRepo}
                    options={reposStatus.repos.map((r) => ({
                      value: r.repo,
                      label: `${r.repo}${r.ready ? "" : "（未同步）"}`,
                    }))}
                    onChange={(val) => {
                      setActiveRepo(val);
                      setRepoSubpath("");
                      setRepoFile(null);
                      setMobilePane("list");
                    }}
                  />
                </div>
              ) : (
                <span className="text-[12.5px] text-[var(--text-muted)]">尚未绑定 GitHub 仓库</span>
              )}
              {reposStatus?.synced_at && (
                <span className="text-[11.5px] text-[var(--text-muted)]">
                  最近同步：{formatRelativeTime(reposStatus.synced_at)}
                </span>
              )}
            </div>
            <Button
              size="xs"
              variant="secondary"
              icon="refresh-cw"
              loading={repoSyncing}
              onClick={() => void handleSyncRepos()}
            >
              立即同步代码镜像
            </Button>
          </div>

          <div className="flex-1 flex min-h-0 overflow-hidden">
            {/* Repo File Tree */}
            <div
              className={`${
                mobilePane === "detail" && (repoFile || repoFileLoading)
                  ? "hidden md:flex"
                  : "flex"
              } w-full md:w-[300px] shrink-0 md:border-r border-[var(--border-subtle)] bg-[var(--surface-card)] flex-col min-h-0`}
            >
              {repoSubpath && (
                <button
                  type="button"
                  onClick={() => {
                    const parts = repoSubpath.split("/");
                    parts.pop();
                    setRepoSubpath(parts.join("/"));
                  }}
                  className="shrink-0 px-3 py-2 border-b border-[var(--border-subtle)] flex items-center gap-1.5 text-[12px] text-indigo-600 dark:text-indigo-400 hover:bg-[var(--surface-hover)] cursor-pointer"
                >
                  <Icon name="arrow-left" size={13} />
                  <span className="font-mono truncate">../ ({repoSubpath})</span>
                </button>
              )}
              <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                {repoListLoading ? (
                  <div className="p-6 text-center text-[12.5px] text-[var(--text-muted)]">
                    加载目录…
                  </div>
                ) : repoEntries.length === 0 ? (
                  <div className="p-6 text-center space-y-2">
                    <p className="text-[12.5px] text-[var(--text-muted)]">
                      {readyRepoCount === 0
                        ? "当前仓库尚未同步到本地镜像，请点击上方「立即同步代码镜像」。"
                        : "当前目录为空"}
                    </p>
                  </div>
                ) : (
                  repoEntries.map((item) => (
                    <button
                      key={`${item.repo}:${item.path}`}
                      type="button"
                      onClick={() => {
                        if (item.type === "dir") {
                          setRepoSubpath(item.path);
                        } else {
                          setMobilePane("detail");
                          void openRepoFile(item.repo, item.path);
                        }
                      }}
                      className={`w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-left text-[12.5px] transition-colors cursor-pointer ${
                        repoFile?.path === item.path && repoFile?.repo === item.repo
                          ? "bg-indigo-500/12 text-indigo-600 dark:text-indigo-300 font-medium"
                          : "text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Icon
                          name={item.type === "dir" ? "folder" : "file-code-2"}
                          size={14}
                          className={
                            item.type === "dir" ? "text-amber-500" : "text-[var(--text-muted)]"
                          }
                        />
                        <span className="font-mono text-[12px] truncate">
                          {item.path.split("/").pop()}
                        </span>
                      </span>
                      {item.size !== undefined && (
                        <span className="text-[10.5px] font-mono text-[var(--text-muted)] shrink-0">
                          {formatBytes(item.size)}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Repo File Content */}
            <div
              className={`${
                mobilePane === "detail" && (repoFile || repoFileLoading)
                  ? "flex"
                  : "hidden md:flex"
              } flex-1 flex-col min-w-0 min-h-0`}
            >
              {repoFileLoading ? (
                <div className="flex-1 flex items-center justify-center text-[13px] text-[var(--text-muted)] gap-2">
                  <Icon name="loader-2" size={15} className="animate-spin text-indigo-500" />
                  读取仓库文件…
                </div>
              ) : !repoFile ? (
                <div className="flex-1 flex items-center justify-center p-8">
                  <EmptyState
                    icon="code-2"
                    title="浏览绑定仓库源码"
                    description="已同步的仓库镜像会同时以只读方式挂载到 Codex 对话工作区的 repos/ 目录，方便随时结合代码排查问题。"
                  />
                </div>
              ) : (
                <>
                  <div className="shrink-0 px-3 sm:px-4 py-2.5 border-b border-[var(--border-subtle)] bg-[var(--surface-card)] flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <button
                        type="button"
                        onClick={() => setMobilePane("list")}
                        className="md:hidden inline-flex items-center gap-1 h-8 px-2 -ml-1 rounded-lg text-[12px] font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] shrink-0 cursor-pointer"
                      >
                        <Icon name="arrow-left" size={14} />
                        <span>列表</span>
                      </button>
                      <span className="font-mono text-[12.5px] text-[var(--text-primary)] truncate">
                        {repoFile.repo} / {repoFile.path}
                      </span>
                    </div>
                    <Button
                      size="xs"
                      variant="primary"
                      icon="sparkles"
                      onClick={() =>
                        onOpenChatWithContext(
                          {
                            kind: "repo_file",
                            label: `${repoFile.repo}:${repoFile.path}`,
                            ref: repoFile.path,
                            repo: repoFile.repo,
                          },
                          `请结合仓库文件 ${repoFile.repo}:${repoFile.path} 帮我分析：`,
                        )
                      }
                    >
                      在 Codex 中讨论此文件
                    </Button>
                  </div>
                  <div className="flex-1 overflow-auto p-4">
                    {repoFile.error ? (
                      <div className="text-[13px] text-rose-500">{repoFile.error}</div>
                    ) : (
                      <pre className="rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-card)] p-4 font-mono text-[12px] leading-relaxed text-[var(--text-primary)] overflow-x-auto whitespace-pre">
                        {repoFile.content}
                      </pre>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal: New File / Dir */}
      <Modal
        open={createModal !== null}
        onClose={() => setCreateModal(null)}
        title={createModal === "dir" ? "新建目录" : "新建项目空间文件"}
        subtitle="路径相对于当前项目空间 files/ 根目录，自动创建父目录。"
      >
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
              {createModal === "dir" ? "目录路径" : "文件路径"}
            </span>
            <input
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              placeholder={createModal === "dir" ? "docs/api" : "docs/api-spec.md"}
              className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] font-mono text-[13px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
            />
          </label>
          {createModal === "file" && (
            <label className="block space-y-1.5">
              <span className="text-[12.5px] font-medium text-[var(--text-primary)]">初始内容</span>
              <textarea
                rows={7}
                value={newContent}
                onChange={(e) => setNewContent(e.target.value)}
                className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3 font-mono text-[12.5px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
              />
            </label>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setCreateModal(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={creatingItem}
              disabled={!newPath.trim()}
              onClick={() => void handleCreateItem()}
            >
              创建
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal: Create SQLite DB */}
      <Modal
        open={sqliteModalOpen}
        onClose={() => setSqliteModalOpen(false)}
        title="新建项目 SQLite 数据库"
        subtitle="将在项目空间 files/databases/ 下创建独立 SQLite 文件，可直接查询和供 Codex 分析。"
        maxWidth="lg"
      >
        <div className="space-y-3">
          <label className="block space-y-1.5">
            <span className="text-[12.5px] font-medium text-[var(--text-primary)]">数据库名称</span>
            <input
              type="text"
              value={sqliteName}
              onChange={(e) => setSqliteName(e.target.value)}
              placeholder="例如：analytics 或 staging-sample"
              className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] font-mono text-[13px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
              初始化 SQL（可选，留空创建空库）
            </span>
            <textarea
              rows={8}
              value={sqliteInitSql}
              onChange={(e) => setSqliteInitSql(e.target.value)}
              spellCheck={false}
              className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3 font-mono text-[12px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={() => setSqliteModalOpen(false)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={creatingDb}
              disabled={!sqliteName.trim()}
              onClick={() => void handleCreateSqlite()}
            >
              创建数据库
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal: Add / Edit External Datasource */}
      <Modal
        open={extDbModalOpen}
        onClose={() => {
          setExtDbModalOpen(false);
          setEditingExtDb(null);
        }}
        title={editingExtDb ? `编辑外部数据源 · ${editingExtDb.name}` : "添加外部数据源"}
        subtitle="连接串仅写保存在 0600 私有文件中，启动 Codex / Claude 对话时自动注入为环境变量且输出流全程脱敏。"
        maxWidth="lg"
      >
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-1.5">
              <span className="text-[12.5px] font-medium text-[var(--text-primary)]">数据源名称</span>
              <input
                type="text"
                value={extDbName}
                onChange={(e) => setExtDbName(e.target.value)}
                placeholder="例如：prod_ro 或 订单库"
                className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] text-[13px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
              />
            </label>
            <div className="space-y-1.5">
              <span className="block text-[12.5px] font-medium text-[var(--text-primary)]">类型</span>
              <Select<WorkspaceDatabaseKind>
                ariaLabel="选择数据源类型"
                fullWidth
                value={extDbKind}
                options={[
                  { value: "postgres", label: "PostgreSQL" },
                  { value: "mysql", label: "MySQL" },
                  { value: "redis", label: "Redis" },
                  { value: "mongodb", label: "MongoDB" },
                  { value: "sqlite", label: "外部 SQLite 路径" },
                  { value: "other", label: "其他数据库 / CLI" },
                ]}
                onChange={setExtDbKind}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <label className="block space-y-1.5">
              <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                注入环境变量名（可选）
              </span>
              <input
                type="text"
                value={extDbEnvVar}
                onChange={(e) => setExtDbEnvVar(e.target.value)}
                placeholder="留空自动生成 RELAYDESK_DB_..."
                className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] font-mono text-[12.5px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
              />
            </label>
            <label className="flex items-center gap-2 h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-subtle)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={extDbReadOnly}
                onChange={(e) => setExtDbReadOnly(e.target.checked)}
                className="rounded border-[var(--border-strong)] accent-indigo-600"
              />
              <span className="text-[12.5px] text-[var(--text-primary)]">
                严格只读（推荐，PG 自动加只读事务）
              </span>
            </label>
          </div>

          <div className="space-y-1.5">
            <label className="block space-y-1.5">
              <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                {editingExtDb
                  ? editingExtDb.has_connection_url
                    ? "更新连接串（留空则保留现有连接串）"
                    : "连接串（可选，仅写存储）"
                  : "连接串（可选，仅写存储）"}
              </span>
              <input
                type="password"
                autoComplete="new-password"
                disabled={extDbClearUrl}
                value={extDbUrl}
                onChange={(e) => setExtDbUrl(e.target.value)}
                placeholder={
                  extDbKind === "postgres"
                    ? "postgresql://readonly:secret@host:5432/dbname"
                    : extDbKind === "mysql"
                      ? "mysql://readonly:secret@host:3306/dbname"
                      : extDbKind === "redis"
                        ? "redis://:secret@host:6379/0"
                        : extDbKind === "mongodb"
                          ? "mongodb://readonly:secret@host:27017/dbname"
                          : "/path/to/database.sqlite"
                }
                className="w-full h-9 px-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-elevated)] font-mono text-[12.5px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500 disabled:opacity-50"
              />
            </label>
            {editingExtDb?.has_connection_url && (
              <label className="inline-flex items-center gap-2 text-[12px] text-[var(--text-muted)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={extDbClearUrl}
                  onChange={(e) => {
                    setExtDbClearUrl(e.target.checked);
                    if (e.target.checked) setExtDbUrl("");
                  }}
                  className="rounded border-[var(--border-strong)] accent-rose-600"
                />
                <span>清除已保存的连接串（仅保留元数据说明）</span>
              </label>
            )}
          </div>

          <label className="block space-y-1.5">
            <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
              Schema / 核心表说明（推荐填写）
            </span>
            <textarea
              rows={4}
              value={extDbNotes}
              onChange={(e) => setExtDbNotes(e.target.value)}
              placeholder="列出关键表名、字段含义、常用关联关系，便于 Codex 准确生成查询命令…"
              className="w-full rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-elevated)] p-3 text-[12.5px] text-[var(--text-primary)] focus:outline-none focus:border-indigo-500"
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setExtDbModalOpen(false);
                setEditingExtDb(null);
              }}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={savingExtDb}
              disabled={!extDbName.trim()}
              onClick={() => void handleSaveExternalDb()}
            >
              {editingExtDb ? "保存修改" : "保存数据源"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
