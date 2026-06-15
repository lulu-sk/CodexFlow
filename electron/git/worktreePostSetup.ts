// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { execGitAsync } from "./exec";
import { toFsPathAbs, toFsPathKey } from "./pathKey";

export type WorktreePostSetupItem = {
  relativePath: string;
  label?: string;
};

export type WorktreePostSetupConfig = {
  items?: WorktreePostSetupItem[];
  command?: string;
  applyAfterReset?: boolean;
};

export type WorktreePostSetupApplyResult = {
  ok: boolean;
  copied?: string[];
  warnings?: string[];
  command?: {
    skipped?: boolean;
    command?: string;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
  };
  error?: string;
};

type SymlinkPrefixChecker = (targetPath: string) => Promise<void>;

export const WORKTREE_POST_SETUP_BLOCKED_PATHS = new Set([
  ".git",
  "node_modules",
  "dist",
  "web/dist",
]);

const POST_SETUP_COMMAND_TIMEOUT_MS = 30 * 60_000;
const POST_SETUP_COMMAND_OUTPUT_LIMIT = 64_000;

/**
 * 把用户输入的路径片段归一化为项目内相对路径。
 */
export function normalizeWorktreePostSetupRelativePath(input: unknown): string {
  const raw = String(input ?? "").trim().replace(/\\/g, "/");
  if (!raw) return "";
  if (/^[A-Za-z]:\//.test(raw) || raw.startsWith("//") || raw.startsWith("/")) return "";
  const parts: string[] = [];
  for (const partRaw of raw.split("/")) {
    const part = partRaw.trim();
    if (!part || part === ".") continue;
    if (part === "..") return "";
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * 判断相对路径是否属于禁止复制的本地重型/危险目录。
 */
export function isBlockedWorktreePostSetupRelativePath(relativePath: string): boolean {
  const normalized = normalizeWorktreePostSetupRelativePath(relativePath).toLowerCase();
  if (!normalized) return true;
  for (const blocked of WORKTREE_POST_SETUP_BLOCKED_PATHS) {
    if (normalized === blocked || normalized.startsWith(`${blocked}/`)) return true;
  }
  return false;
}

/**
 * 归一化 worktree 后置设置，过滤无效项并保持重置后默认应用。
 */
export function normalizeWorktreePostSetupConfig(input: unknown): WorktreePostSetupConfig {
  const obj = input && typeof input === "object" ? (input as any) : {};
  const itemsRaw = Array.isArray(obj.items) ? obj.items : [];
  const items: WorktreePostSetupItem[] = [];
  const seen = new Set<string>();
  for (const item of itemsRaw) {
    const relativePath = normalizeWorktreePostSetupRelativePath((item as any)?.relativePath ?? item);
    if (!relativePath) continue;
    const key = relativePath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const label = String((item as any)?.label || relativePath).trim();
    items.push({ relativePath, label: label || relativePath });
  }
  return {
    items,
    command: String(obj.command ?? "").trim(),
    applyAfterReset: typeof obj.applyAfterReset === "boolean" ? obj.applyAfterReset : true,
  };
}

/**
 * 判断 child 是否位于 parent 目录内部或等于 parent。
 */
function isInsideOrSamePath(parent: string, child: string): boolean {
  const parentAbs = path.resolve(parent);
  const childAbs = path.resolve(child);
  const rel = path.relative(parentAbs, childAbs);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * 确认指定路径本身不是符号链接。
 */
async function assertPathIsNotSymlinkAsync(targetPath: string, label: string): Promise<void> {
  const st = await fsp.lstat(targetPath);
  if (st.isSymbolicLink()) throw new Error(`${label}: symbolic link is not supported`);
}

/**
 * 确认 root 到 target 的既有路径链路中没有符号链接。
 */
async function assertNoSymlinkPathPrefixAsync(root: string, target: string): Promise<void> {
  const rootAbs = path.resolve(root);
  const targetAbs = path.resolve(target);
  const rel = path.relative(rootAbs, targetAbs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path escapes project");
  if (!rel) return;

  let cursor = rootAbs;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const st = await fsp.lstat(cursor);
      if (st.isSymbolicLink()) {
        const display = path.relative(rootAbs, cursor).replace(/\\/g, "/");
        throw new Error(`${display}: symbolic link is not supported`);
      }
    } catch (error: any) {
      if (String(error?.code || "") === "ENOENT") return;
      throw error;
    }
  }
}

/**
 * 创建带缓存的路径前缀符号链接检查器，避免复制大目录时反复检查同一批父目录。
 */
function createSymlinkPrefixChecker(root: string): SymlinkPrefixChecker {
  const rootAbs = path.resolve(root);
  const checked = new Map<string, Promise<void>>();

  return async (target: string): Promise<void> => {
    const targetAbs = path.resolve(target);
    const rel = path.relative(rootAbs, targetAbs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path escapes project");
    if (!rel) return;

    let cursor = rootAbs;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const current = cursor;
      let pending = checked.get(current);
      if (!pending) {
        pending = (async () => {
          try {
            const st = await fsp.lstat(current);
            if (st.isSymbolicLink()) {
              const display = path.relative(rootAbs, current).replace(/\\/g, "/");
              throw new Error(`${display}: symbolic link is not supported`);
            }
          } catch (error: any) {
            if (String(error?.code || "") === "ENOENT") return;
            throw error;
          }
        })();
        checked.set(current, pending);
      }
      await pending;
    }
  };
}

/**
 * 安全拼接项目内相对路径，越界时返回空串。
 */
function resolveProjectRelativePath(root: string, relativePath: string): string {
  const normalized = normalizeWorktreePostSetupRelativePath(relativePath);
  if (!normalized) return "";
  const resolved = path.resolve(root, ...normalized.split("/"));
  return isInsideOrSamePath(root, resolved) ? resolved : "";
}

/**
 * 递归复制文件或目录；目标已存在时覆盖同名文件并合并目录。
 */
async function copyPathRecursiveAsync(source: string, target: string, guards: {
  assertSourcePrefix: SymlinkPrefixChecker;
  assertTargetPrefix: SymlinkPrefixChecker;
}): Promise<void> {
  await guards.assertSourcePrefix(source);
  await guards.assertTargetPrefix(target);
  const st = await fsp.lstat(source);
  if (st.isSymbolicLink()) throw new Error("symbolic link is not supported");
  if (st.isDirectory()) {
    await fsp.mkdir(target, { recursive: true });
    const entries = await fsp.readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await copyPathRecursiveAsync(path.join(source, entry.name), path.join(target, entry.name), guards);
    }
    return;
  }
  if (st.isFile()) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.copyFile(source, target);
  }
}

/**
 * 截断命令输出，避免 IPC/日志持有过大的 stdout/stderr。
 */
function appendLimitedOutput(current: string, chunk: Buffer | string): string {
  const next = current + String(chunk ?? "");
  if (next.length <= POST_SETUP_COMMAND_OUTPUT_LIMIT) return next;
  return next.slice(next.length - POST_SETUP_COMMAND_OUTPUT_LIMIT);
}

/**
 * 格式化后置准备步骤耗时，便于创建日志展示。
 */
function formatPostSetupDuration(ms: number): string {
  const value = Math.max(0, Math.floor(Number(ms) || 0));
  if (value < 1000) return `${value}ms`;
  const seconds = Math.round(value / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return rest > 0 ? `${minutes}m${rest}s` : `${minutes}m`;
}

/**
 * 从命令输出块中提取最后一行可读进度，避免初始化命令长时间运行时 UI 看起来不动。
 */
function pickLastProgressLineFromChunk(chunk: Buffer | string): string {
  const text = String(chunk ?? "").replace(/\r/g, "\n");
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] || "";
  if (!last) return "";
  return last.length > 80 ? `${last.slice(0, 80)}...` : last;
}

/**
 * 按当前平台选择执行用户命令的 shell。
 */
function buildPostSetupShellCommand(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") return { file: "cmd.exe", args: ["/d", "/s", "/c", command] };
  return { file: "/bin/sh", args: ["-lc", command] };
}

/**
 * 在目标 worktree 内执行用户配置的初始化命令，并强制设置超时。
 */
async function runPostSetupCommandAsync(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  onLog?: (text: string) => void,
  onProgress?: (detail: string) => void,
): Promise<NonNullable<WorktreePostSetupApplyResult["command"]>> {
  const trimmed = String(command || "").trim();
  if (!trimmed) return { skipped: true };
  const shell = buildPostSetupShellCommand(trimmed);
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let child: ReturnType<typeof spawn> | null = null;
    let timer: NodeJS.Timeout | null = null;
    const startedAt = Date.now();
    let lastProgressAt = 0;

    /**
     * 写入后置准备日志；日志失败不影响创建流程。
     */
    const log = (text: string): void => {
      try { onLog?.(String(text ?? "")); } catch {}
    };

    /**
     * 将初始化命令的最新输出同步到创建条目状态，并做轻量节流。
     */
    const progressFromOutput = (chunk: Buffer | string): void => {
      const line = pickLastProgressLineFromChunk(chunk);
      if (!line) return;
      const now = Date.now();
      if (now - lastProgressAt < 250) return;
      lastProgressAt = now;
      try { onProgress?.(`初始化命令：${line}`); } catch {}
    };

    /**
     * 结束命令执行并清理计时器与 abort 监听。
     */
    const finalize = (result: NonNullable<WorktreePostSetupApplyResult["command"]>) => {
      if (finished) return;
      finished = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try { signal?.removeEventListener("abort", onAbort); } catch {}
      const durationText = formatPostSetupDuration(Date.now() - startedAt);
      if (result.skipped !== true) {
        const error = String(result.error || "").trim();
        if (error) log(`[后置准备] 初始化命令结束但有警告（${durationText}）：${error}\n`);
        else log(`[后置准备] 初始化命令完成（${durationText}）\n`);
      }
      resolve({ command: trimmed, stdout, stderr, ...result });
    };

    /**
     * 尽力终止命令进程树。
     */
    const killChild = () => {
      try {
        if (process.platform === "win32" && child?.pid) {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.on("error", () => {
            try { child?.kill(); } catch {}
          });
          killer.unref?.();
        } else {
          try { child?.kill("SIGTERM"); } catch {}
          try { child?.kill("SIGKILL"); } catch {}
        }
      } catch {
        try { child?.kill(); } catch {}
      }
    };

    /**
     * 响应外部取消信号。
     */
    const onAbort = () => {
      killChild();
      finalize({ exitCode: -1, error: "aborted" });
    };

    try {
      if (signal?.aborted) {
        finalize({ exitCode: -1, error: "aborted" });
        return;
      }
      log("[后置准备] 正在执行初始化命令…\n");
      child = spawn(shell.file, shell.args, {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CF_WORKTREE_POST_SETUP: "1",
        },
      });
      child.stdout?.on("data", (chunk) => {
        stdout = appendLimitedOutput(stdout, chunk);
        progressFromOutput(chunk);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = appendLimitedOutput(stderr, chunk);
        progressFromOutput(chunk);
      });
      child.on("error", (error: any) => {
        finalize({ exitCode: -1, error: String(error?.message || error) });
      });
      child.on("close", (code) => {
        const exitCode = typeof code === "number" ? code : -1;
        finalize({ exitCode, error: exitCode === 0 ? undefined : `command exited with ${exitCode}` });
      });
      timer = setTimeout(() => {
        killChild();
        finalize({ exitCode: -1, error: `command timeout after ${POST_SETUP_COMMAND_TIMEOUT_MS}ms` });
      }, POST_SETUP_COMMAND_TIMEOUT_MS);
      try { signal?.addEventListener("abort", onAbort, { once: true }); } catch {}
    } catch (error: any) {
      finalize({ exitCode: -1, error: String(error?.message || error) });
    }
  });
}

/**
 * 批量读取旧版 AI 规则文件中被 Git ignore 的文件名，减少 Windows 下重复启动 Git 的开销。
 */
async function listIgnoredLegacyRuleFilesAsync(args: {
  sourceDir: string;
  gitPath?: string;
  names: readonly string[];
}): Promise<Set<string>> {
  const existing = args.names.filter((name) => {
    try { return fs.existsSync(path.join(args.sourceDir, name)); } catch { return false; }
  });
  if (existing.length === 0) return new Set();

  const checked = await execGitAsync({
    gitPath: args.gitPath,
    argv: ["-C", args.sourceDir, "check-ignore", "--stdin"],
    stdin: `${existing.join("\n")}\n`,
    timeoutMs: 4000,
  });
  if (!checked.ok && checked.exitCode !== 1) return new Set();

  return new Set(
    String(checked.stdout || "")
      .split(/\r?\n/)
      .map((item) => item.trim().replace(/\\/g, "/"))
      .filter(Boolean),
  );
}

/**
 * 兼容旧版“创建时拷贝 AI 规则文件”开关，只拷贝被 Git 忽略的规则文件。
 */
async function copyLegacyRuleFilesAsync(args: {
  sourceDir: string;
  targetDir: string;
  gitPath?: string;
}): Promise<{ copied: string[]; warnings: string[] }> {
  const copied: string[] = [];
  const warnings: string[] = [];
  const names = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const;
  const ignoredNames = await listIgnoredLegacyRuleFilesAsync({ sourceDir: args.sourceDir, gitPath: args.gitPath, names });
  const assertSourcePrefix = createSymlinkPrefixChecker(args.sourceDir);
  const assertTargetPrefix = createSymlinkPrefixChecker(args.targetDir);
  for (const name of names) {
    try {
      const src = path.join(args.sourceDir, name);
      if (!fs.existsSync(src)) continue;
      if (!ignoredNames.has(name)) continue;
      const dst = path.join(args.targetDir, name);
      await assertSourcePrefix(src);
      await assertTargetPrefix(dst);
      const st = await fsp.lstat(src);
      if (st.isSymbolicLink()) throw new Error("symbolic link is not supported");
      if (!st.isFile()) continue;
      await fsp.copyFile(src, dst);
      copied.push(name);
    } catch (error: any) {
      warnings.push(`${name}: ${String(error?.message || error)}`);
    }
  }
  return { copied, warnings };
}

/**
 * 复制项目级保留项，并可选执行初始化命令。
 */
export async function applyWorktreePostSetupAsync(args: {
  sourceDir: string;
  targetDir: string;
  config?: WorktreePostSetupConfig;
  copyRules?: boolean;
  gitPath?: string;
  signal?: AbortSignal;
  onLog?: (text: string) => void;
  onProgress?: (detail: string) => void;
}): Promise<WorktreePostSetupApplyResult> {
  const sourceDir = toFsPathAbs(args.sourceDir);
  const targetDir = toFsPathAbs(args.targetDir);
  if (!sourceDir || !targetDir) return { ok: false, error: "missing sourceDir or targetDir" };
  if (!toFsPathKey(sourceDir) || !toFsPathKey(targetDir)) return { ok: false, error: "invalid sourceDir or targetDir" };
  try {
    await assertPathIsNotSymlinkAsync(sourceDir, "sourceDir");
    await assertPathIsNotSymlinkAsync(targetDir, "targetDir");
  } catch (error: any) {
    return { ok: false, error: String(error?.message || error) };
  }

  const config = normalizeWorktreePostSetupConfig(args.config);
  const copied: string[] = [];
  const warnings: string[] = [];
  const startedAt = Date.now();
  const hasActions = (config.items?.length || 0) > 0 || args.copyRules === true || !!String(config.command || "").trim();
  const log = (text: string): void => {
    try { args.onLog?.(String(text ?? "")); } catch {}
  };
  const progress = (detail: string): void => {
    try { args.onProgress?.(String(detail || "").trim()); } catch {}
  };

  if (hasActions) {
    progress("正在应用保留项与初始化设置");
    log("[后置准备] 开始应用保留项与初始化设置…\n");
  }
  const assertSourcePrefix = createSymlinkPrefixChecker(sourceDir);
  const assertTargetPrefix = createSymlinkPrefixChecker(targetDir);

  for (const item of config.items || []) {
    const relativePath = normalizeWorktreePostSetupRelativePath(item.relativePath);
    if (!relativePath) continue;
    if (isBlockedWorktreePostSetupRelativePath(relativePath)) {
      warnings.push(`${relativePath}: blocked path`);
      continue;
    }
    const src = resolveProjectRelativePath(sourceDir, relativePath);
    const dst = resolveProjectRelativePath(targetDir, relativePath);
    if (!src || !dst) {
      warnings.push(`${relativePath}: invalid path`);
      continue;
    }
    if (!isInsideOrSamePath(sourceDir, src) || !isInsideOrSamePath(targetDir, dst)) {
      warnings.push(`${relativePath}: path escapes project`);
      continue;
    }
    try {
      const itemStartedAt = Date.now();
      progress(`正在复制保留项：${relativePath}`);
      log(`[后置准备] 正在复制保留项：${relativePath}\n`);
      await copyPathRecursiveAsync(src, dst, { assertSourcePrefix, assertTargetPrefix });
      progress(`保留项复制完成：${relativePath}`);
      log(`[后置准备] 保留项复制完成：${relativePath}（${formatPostSetupDuration(Date.now() - itemStartedAt)}）\n`);
      copied.push(relativePath);
    } catch (error: any) {
      warnings.push(`${relativePath}: ${String(error?.message || error)}`);
    }
  }

  if (args.copyRules === true) {
    const ruleStartedAt = Date.now();
    progress("正在检查并复制 AI 规则文件");
    log("[后置准备] 正在检查并复制 AI 规则文件…\n");
    const legacy = await copyLegacyRuleFilesAsync({ sourceDir, targetDir, gitPath: args.gitPath });
    copied.push(...legacy.copied.filter((item) => !copied.includes(item)));
    warnings.push(...legacy.warnings);
    progress("AI 规则文件处理完成");
    log(`[后置准备] AI 规则文件处理完成（${formatPostSetupDuration(Date.now() - ruleStartedAt)}）\n`);
  }

  if (String(config.command || "").trim()) progress("正在执行初始化命令");
  const command = await runPostSetupCommandAsync(config.command || "", targetDir, args.signal, args.onLog, args.onProgress);
  if (command.error) warnings.push(`command: ${command.error}`);
  if (hasActions) {
    progress("后置准备完成");
    log(`[后置准备] 完成（${formatPostSetupDuration(Date.now() - startedAt)}）\n`);
  }

  return {
    ok: true,
    copied,
    warnings: warnings.length > 0 ? warnings : undefined,
    command,
  };
}
