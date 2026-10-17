// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { execGitAsync, type GitExecOptions, type GitExecResult } from "../git/exec";
import { normalizeWinPath, uncToWsl, wslToUNC } from "../wsl";

const MAX_HISTORY_TURN_DIFF_BYTES = 16 * 1024 * 1024;

export type RevertHistoryTurnDiffResult =
  | { ok: true; repoRoot: string }
  | { ok: false; code: "invalid_request" | "project_not_found" | "not_git_repo" | "conflict" | "apply_failed"; error: string };

export type RevertHistoryTurnDiffDependencies = {
  runGit: (options: GitExecOptions) => Promise<GitExecResult>;
};

/**
 * 从 Git 执行结果中提取适合直接反馈给用户的错误文本。
 */
function resolveGitFailureText(result: GitExecResult, fallback: string): string {
  return String(result.stderr || result.error || result.stdout || fallback).trim() || fallback;
}

type ApplyPatchLine = {
  kind: "context" | "addition" | "deletion";
  text: string;
};

type ApplyPatchHunk = {
  lines: ApplyPatchLine[];
};

type ApplyPatchOperation = {
  kind: "update" | "add" | "delete";
  filePath: string;
  moveTo?: string;
  hunks: ApplyPatchHunk[];
};

type VirtualFileState = {
  exists: boolean;
  content: string;
};

/**
 * 去除 apply_patch 文件头可能携带的引号，并保留路径原始含义。
 */
function normalizeApplyPatchPath(rawPath: string): string {
  const value = String(rawPath || "").trim();
  if (!value) return "";
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return String(JSON.parse(value) || "").trim(); } catch { return value.slice(1, -1); }
  }
  return value;
}

/**
 * 解析一轮内串联的一个或多个 Codex apply_patch 块。
 */
function parseApplyPatchOperations(patchText: string): ApplyPatchOperation[] {
  const lines = String(patchText || "").replace(/\r\n?/g, "\n").split("\n");
  const operations: ApplyPatchOperation[] = [];
  let insidePatch = false;
  let currentOperation: ApplyPatchOperation | null = null;
  let currentHunk: ApplyPatchHunk | null = null;

  for (const line of lines) {
    if (line === "*** Begin Patch") {
      insidePatch = true;
      currentOperation = null;
      currentHunk = null;
      continue;
    }
    if (line === "*** End Patch") {
      insidePatch = false;
      currentOperation = null;
      currentHunk = null;
      continue;
    }
    if (!insidePatch) continue;

    const fileHeader = /^\*\*\* (Update|Add|Delete) File:\s*(.+)$/.exec(line);
    if (fileHeader) {
      const kind = String(fileHeader[1] || "").toLowerCase() as ApplyPatchOperation["kind"];
      const filePath = normalizeApplyPatchPath(fileHeader[2] || "");
      if (!filePath) throw new Error("apply_patch 中存在空文件路径。");
      currentOperation = { kind, filePath, hunks: [] };
      currentHunk = null;
      operations.push(currentOperation);
      continue;
    }
    if (!currentOperation) continue;

    const moveHeader = /^\*\*\* Move to:\s*(.+)$/.exec(line);
    if (moveHeader) {
      currentOperation.moveTo = normalizeApplyPatchPath(moveHeader[1] || "");
      continue;
    }
    if (line.startsWith("@@")) {
      currentHunk = { lines: [] };
      currentOperation.hunks.push(currentHunk);
      continue;
    }
    if (!line.startsWith("+") && !line.startsWith("-") && !line.startsWith(" ")) continue;
    if (!currentHunk) {
      currentHunk = { lines: [] };
      currentOperation.hunks.push(currentHunk);
    }
    currentHunk.lines.push({
      kind: line.startsWith("+") ? "addition" : (line.startsWith("-") ? "deletion" : "context"),
      text: line.slice(1),
    });
  }
  return operations;
}

/**
 * 将补丁路径解析到仓库内，并检查目标或最近存在父目录的真实位置。
 */
async function resolveApplyPatchFilePath(repoRoot: string, patchPath: string, workingDirectory: string): Promise<string> {
  const normalizedPath = normalizeApplyPatchPath(patchPath);
  const resolved = path.resolve(workingDirectory, normalizedPath);
  if (!normalizedPath || !isPathWithinHistoryRepository(repoRoot, resolved))
    throw new Error("apply_patch 文件路径超出了当前项目范围。");
  const realRoot = await fsp.realpath(repoRoot);
  let existingPath = resolved;
  while (true) {
    try {
      const realTarget = await fsp.realpath(existingPath);
      if (!isPathWithinHistoryRepository(realRoot, realTarget))
        throw new Error("apply_patch 文件路径经链接指向了当前项目范围之外。");
      return resolved;
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
      const existingEntry = await fsp.lstat(existingPath).catch((statError: NodeJS.ErrnoException) => {
        if (statError.code !== "ENOENT") throw statError;
        return null;
      });
      if (existingEntry?.isSymbolicLink())
        throw new Error("apply_patch 文件路径包含无法解析的符号链接。");
      const parent = path.dirname(existingPath);
      if (parent === existingPath) throw new Error("apply_patch 文件路径无法验证。");
      existingPath = parent;
    }
  }
}

/** 检查仓库路径边界，WSL 文件路径保留大小写语义并兼容两种 UNC 主机别名。 */
function isPathWithinHistoryRepository(repoRoot: string, target: string): boolean {
  const rootWsl = process.platform === "win32" ? uncToWsl(normalizeWinPath(repoRoot)) : null;
  const targetWsl = process.platform === "win32" ? uncToWsl(normalizeWinPath(target)) : null;
  if (rootWsl || targetWsl) {
    if (!rootWsl || !targetWsl || rootWsl.distro.toLowerCase() !== targetWsl.distro.toLowerCase()) return false;
    const relative = path.posix.relative(rootWsl.wslPath, targetWsl.wslPath);
    return relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative);
  }
  const relative = path.relative(repoRoot, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 将历史工作目录映射到当前系统并验证仓库范围，拒绝猜测发行版或回退到同名根文件。 */
async function resolveApplyPatchWorkingDirectory(repoRoot: string, rawCwd?: string): Promise<string> {
  if (rawCwd !== undefined && typeof rawCwd !== "string") throw new Error("历史工作目录类型无效。");
  let cwd = String(rawCwd || "").trim();
  if (!cwd) return repoRoot;
  if (cwd.includes("\0") || /[\r\n]/.test(cwd)) throw new Error("历史工作目录无效。");
  if (/^file:/i.test(cwd)) cwd = fileURLToPath(cwd);
  else cwd = normalizeApplyPatchPath(cwd);
  if (process.platform === "win32") {
    const mountedPath = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(cwd);
    if (mountedPath) cwd = `${mountedPath[1]}:\\${String(mountedPath[2] || "").replace(/\//g, "\\")}`;
    else if (cwd.startsWith("/") && !cwd.startsWith("//")) {
      const wslRoot = uncToWsl(normalizeWinPath(repoRoot));
      if (!wslRoot) throw new Error("历史工作目录无法映射到当前仓库，请检查会话运行环境。");
      cwd = wslToUNC(cwd, wslRoot.distro);
    }
    cwd = normalizeWinPath(cwd);
    if (!/^[a-z]:\\|^\\\\/i.test(cwd)) throw new Error("历史工作目录缺少明确的盘符或网络共享。");
  }
  if (!path.isAbsolute(cwd)) throw new Error("历史工作目录必须是当前系统可访问的绝对路径。");
  const resolved = path.resolve(cwd);
  if (!isPathWithinHistoryRepository(repoRoot, resolved))
    throw new Error("历史工作目录超出了当前项目范围。");
  try {
    if (!(await fsp.stat(resolved)).isDirectory()) throw new Error();
  } catch {
    throw new Error("历史工作目录不存在或无法访问。");
  }
  const [realRoot, realCwd] = await Promise.all([fsp.realpath(repoRoot), fsp.realpath(resolved)]);
  if (!isPathWithinHistoryRepository(realRoot, realCwd))
    throw new Error("历史工作目录指向了当前项目范围之外。");
  return resolved;
}

/**
 * 把文本拆成行并记录原换行风格，供反向应用后尽量保持原文件格式。
 */
function splitFileText(content: string): { lines: string[]; newline: string; trailingNewline: boolean } {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n?/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, newline, trailingNewline };
}

/**
 * 按原换行风格重新组合文本行。
 */
function joinFileText(lines: string[], newline: string, trailingNewline: boolean): string {
  const body = lines.join(newline);
  return trailingNewline ? `${body}${newline}` : body;
}

/**
 * 查找一段完整行序列；为避免撤错位置，仅接受唯一匹配。
 */
function findUniqueLineSequence(source: string[], target: string[]): number {
  if (target.length === 0 || target.length > source.length) return -1;
  let matchIndex = -1;
  for (let start = 0; start <= source.length - target.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < target.length; offset += 1) {
      if (source[start + offset] !== target[offset]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    if (matchIndex >= 0) return -1;
    matchIndex = start;
  }
  return matchIndex;
}

/**
 * 在内存中反向应用一个更新操作，匹配失败时不产生任何文件写入。
 */
function reverseUpdateOperation(content: string, operation: ApplyPatchOperation): string {
  const textState = splitFileText(content);
  const lines = [...textState.lines];
  for (let hunkIndex = operation.hunks.length - 1; hunkIndex >= 0; hunkIndex -= 1) {
    const hunk = operation.hunks[hunkIndex];
    const afterLines = hunk.lines
      .filter((line) => line.kind !== "deletion")
      .map((line) => line.text);
    const beforeLines = hunk.lines
      .filter((line) => line.kind !== "addition")
      .map((line) => line.text);
    const matchIndex = findUniqueLineSequence(lines, afterLines);
    if (matchIndex < 0)
      throw new Error(`文件 ${operation.filePath} 已发生后续变化，无法安全定位原改动。`);
    lines.splice(matchIndex, afterLines.length, ...beforeLines);
  }
  return joinFileText(lines, textState.newline, textState.trailingNewline);
}

/**
 * 在内存中正向应用一个更新操作，匹配失败时不产生任何文件写入。
 */
function applyUpdateOperation(content: string, operation: ApplyPatchOperation): string {
  const textState = splitFileText(content);
  const lines = [...textState.lines];
  for (const hunk of operation.hunks) {
    const beforeLines = hunk.lines
      .filter((line) => line.kind !== "addition")
      .map((line) => line.text);
    const afterLines = hunk.lines
      .filter((line) => line.kind !== "deletion")
      .map((line) => line.text);
    const matchIndex = findUniqueLineSequence(lines, beforeLines);
    if (matchIndex < 0)
      throw new Error(`文件 ${operation.filePath} 已发生后续变化，无法安全重新应用。`);
    lines.splice(matchIndex, beforeLines.length, ...afterLines);
  }
  return joinFileText(lines, textState.newline, textState.trailingNewline);
}

/**
 * 从新增或删除文件操作中还原补丁记录的完整文件内容。
 */
function buildWholeFileContent(operation: ApplyPatchOperation, lineKind: ApplyPatchLine["kind"]): string {
  const lines = operation.hunks.flatMap((hunk) => hunk.lines)
    .filter((line) => line.kind === lineKind)
    .map((line) => line.text);
  if (lines.length === 0) throw new Error(`补丁未保留 ${operation.filePath} 的完整内容，无法安全撤销。`);
  return `${lines.join("\n")}\n`;
}

/**
 * 在全部补丁都通过内存校验后，一次性写回 apply_patch 的反向结果。
 */
async function revertApplyPatchHistory(repoRoot: string, patchText: string, workingDirectory: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const operations = parseApplyPatchOperations(patchText);
    if (operations.length === 0) return { ok: false, error: "历史记录中没有可撤销的文件改动。" };
    const virtualFiles = new Map<string, VirtualFileState>();
    const touchedPaths = new Set<string>();

    /**
     * 按需读取文件状态；同一路径的多次修改始终复用内存中的最新结果。
     */
    async function getVirtualFile(filePath: string): Promise<VirtualFileState> {
      const existing = virtualFiles.get(filePath);
      if (existing) return existing;
      try {
        const content = await fsp.readFile(filePath, "utf8");
        const state = { exists: true, content };
        virtualFiles.set(filePath, state);
        return state;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        const state = { exists: false, content: "" };
        virtualFiles.set(filePath, state);
        return state;
      }
    }

    for (let operationIndex = operations.length - 1; operationIndex >= 0; operationIndex -= 1) {
      const operation = operations[operationIndex];
      const sourcePath = await resolveApplyPatchFilePath(repoRoot, operation.filePath, workingDirectory);
      const currentPath = operation.moveTo
        ? await resolveApplyPatchFilePath(repoRoot, operation.moveTo, workingDirectory)
        : sourcePath;
      const currentState = await getVirtualFile(currentPath);

      if (operation.kind === "add") {
        if (!currentState.exists) throw new Error(`新增文件 ${operation.filePath} 已不存在，无法撤销。`);
        const expectedContent = buildWholeFileContent(operation, "addition");
        if (currentState.content.replace(/\r\n?/g, "\n") !== expectedContent)
          throw new Error(`新增文件 ${operation.filePath} 已发生后续变化，无法安全撤销。`);
        virtualFiles.set(currentPath, { exists: false, content: "" });
        touchedPaths.add(currentPath);
        continue;
      }

      if (operation.kind === "delete") {
        if (currentState.exists) throw new Error(`已删除文件 ${operation.filePath} 又被创建，无法安全撤销。`);
        const restoredContent = buildWholeFileContent(operation, "deletion");
        virtualFiles.set(sourcePath, { exists: true, content: restoredContent });
        touchedPaths.add(sourcePath);
        continue;
      }

      if (!currentState.exists) throw new Error(`文件 ${operation.moveTo || operation.filePath} 不存在，无法撤销。`);
      const reversedContent = reverseUpdateOperation(currentState.content, operation);
      if (operation.moveTo) {
        const originalState = await getVirtualFile(sourcePath);
        if (originalState.exists) throw new Error(`原路径 ${operation.filePath} 已存在，无法安全撤销移动。`);
        virtualFiles.set(sourcePath, { exists: true, content: reversedContent });
        virtualFiles.set(currentPath, { exists: false, content: "" });
        touchedPaths.add(sourcePath);
        touchedPaths.add(currentPath);
      } else {
        virtualFiles.set(sourcePath, { exists: true, content: reversedContent });
        touchedPaths.add(sourcePath);
      }
    }

    for (const filePath of touchedPaths) {
      const state = virtualFiles.get(filePath);
      if (!state?.exists) continue;
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, state.content, "utf8");
    }
    for (const filePath of touchedPaths) {
      const state = virtualFiles.get(filePath);
      if (state?.exists) continue;
      await fsp.rm(filePath, { force: true });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error || "无法撤销 apply_patch 改动。") };
  }
}

/**
 * 在全部补丁都通过内存校验后，一次性正向写回 apply_patch 的结果。
 */
async function reapplyApplyPatchHistory(repoRoot: string, patchText: string, workingDirectory: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const operations = parseApplyPatchOperations(patchText);
    if (operations.length === 0) return { ok: false, error: "历史记录中没有可重新应用的文件改动。" };
    const virtualFiles = new Map<string, VirtualFileState>();
    const touchedPaths = new Set<string>();

    /**
     * 按需读取文件状态；同一路径的多次修改始终复用内存中的最新结果。
     */
    async function getVirtualFile(filePath: string): Promise<VirtualFileState> {
      const existing = virtualFiles.get(filePath);
      if (existing) return existing;
      try {
        const content = await fsp.readFile(filePath, "utf8");
        const state = { exists: true, content };
        virtualFiles.set(filePath, state);
        return state;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        const state = { exists: false, content: "" };
        virtualFiles.set(filePath, state);
        return state;
      }
    }

    for (const operation of operations) {
      const sourcePath = await resolveApplyPatchFilePath(repoRoot, operation.filePath, workingDirectory);
      const sourceState = await getVirtualFile(sourcePath);

      if (operation.kind === "add") {
        if (sourceState.exists) throw new Error(`新增文件 ${operation.filePath} 已存在，无法安全重新应用。`);
        virtualFiles.set(sourcePath, { exists: true, content: buildWholeFileContent(operation, "addition") });
        touchedPaths.add(sourcePath);
        continue;
      }

      if (operation.kind === "delete") {
        if (!sourceState.exists) throw new Error(`待删除文件 ${operation.filePath} 不存在，无法重新应用。`);
        const expectedContent = buildWholeFileContent(operation, "deletion");
        if (sourceState.content.replace(/\r\n?/g, "\n") !== expectedContent)
          throw new Error(`文件 ${operation.filePath} 已发生后续变化，无法安全重新应用。`);
        virtualFiles.set(sourcePath, { exists: false, content: "" });
        touchedPaths.add(sourcePath);
        continue;
      }

      if (!sourceState.exists) throw new Error(`文件 ${operation.filePath} 不存在，无法重新应用。`);
      const appliedContent = applyUpdateOperation(sourceState.content, operation);
      if (operation.moveTo) {
        const targetPath = await resolveApplyPatchFilePath(repoRoot, operation.moveTo, workingDirectory);
        const targetState = await getVirtualFile(targetPath);
        if (targetState.exists) throw new Error(`目标路径 ${operation.moveTo} 已存在，无法安全重新应用移动。`);
        virtualFiles.set(sourcePath, { exists: false, content: "" });
        virtualFiles.set(targetPath, { exists: true, content: appliedContent });
        touchedPaths.add(sourcePath);
        touchedPaths.add(targetPath);
      } else {
        virtualFiles.set(sourcePath, { exists: true, content: appliedContent });
        touchedPaths.add(sourcePath);
      }
    }

    for (const filePath of touchedPaths) {
      const state = virtualFiles.get(filePath);
      if (!state?.exists) continue;
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(filePath, state.content, "utf8");
    }
    for (const filePath of touchedPaths) {
      const state = virtualFiles.get(filePath);
      if (state?.exists) continue;
      await fsp.rm(filePath, { force: true });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String((error as Error)?.message || error || "无法重新应用 apply_patch 改动。") };
  }
}

/**
 * 校验并反向应用历史记录中的统一差异；校验失败时不会修改任何文件。
 */
export async function revertHistoryTurnDiff(
  request: { projectWinPath: string; diffText: string; cwd?: string; operation?: "undo" | "reapply" },
  dependencies: RevertHistoryTurnDiffDependencies = { runGit: execGitAsync },
): Promise<RevertHistoryTurnDiffResult> {
  const projectWinPath = String(request?.projectWinPath || "").trim();
  const diffText = String(request?.diffText || "");
  const operation = request?.operation === "reapply" ? "reapply" : "undo";
  if (!projectWinPath || !path.isAbsolute(projectWinPath))
    return { ok: false, code: "invalid_request", error: "项目路径无效。" };
  if (!diffText.trim() || Buffer.byteLength(diffText, "utf8") > MAX_HISTORY_TURN_DIFF_BYTES || diffText.includes("\0"))
    return { ok: false, code: "invalid_request", error: "历史差异为空或超出安全大小限制。" };

  try {
    const stat = await fsp.stat(projectWinPath);
    if (!stat.isDirectory())
      return { ok: false, code: "project_not_found", error: "项目目录不存在。" };
  } catch {
    return { ok: false, code: "project_not_found", error: "项目目录不存在。" };
  }

  const gitPath = process.platform === "win32" ? "git.exe" : "git";
  const rootResult = await dependencies.runGit({
    gitPath,
    cwd: projectWinPath,
    argv: ["rev-parse", "--show-toplevel"],
    timeoutMs: 10_000,
  });
  if (!rootResult.ok)
    return { ok: false, code: "not_git_repo", error: resolveGitFailureText(rootResult, "当前项目不是可用的 Git 仓库。") };

  const repoRoot = path.resolve(String(rootResult.stdout || projectWinPath).trim() || projectWinPath);
  if (/^\*\*\* Begin Patch$/m.test(diffText)) {
    let workingDirectory: string;
    try {
      workingDirectory = await resolveApplyPatchWorkingDirectory(repoRoot, request.cwd);
    } catch (error) {
      return { ok: false, code: "invalid_request", error: String((error as Error)?.message || "历史工作目录不可用。") };
    }
    const applyPatchResult = operation === "undo"
      ? await revertApplyPatchHistory(repoRoot, diffText, workingDirectory)
      : await reapplyApplyPatchHistory(repoRoot, diffText, workingDirectory);
    if (!applyPatchResult.ok)
      return { ok: false, code: "conflict", error: applyPatchResult.error };
    return { ok: true, repoRoot };
  }

  const reverseArgs = operation === "undo" ? ["--reverse"] : [];
  const checkResult = await dependencies.runGit({
    gitPath,
    cwd: repoRoot,
    argv: ["apply", ...reverseArgs, "--check", "--whitespace=nowarn", "--recount", "-"],
    stdin: diffText,
    timeoutMs: 30_000,
  });
  if (!checkResult.ok) {
    return {
      ok: false,
      code: "conflict",
      error: resolveGitFailureText(checkResult, "文件已发生后续变化，无法安全撤销这轮改动。"),
    };
  }

  const applyResult = await dependencies.runGit({
    gitPath,
    cwd: repoRoot,
    argv: ["apply", ...reverseArgs, "--whitespace=nowarn", "--recount", "-"],
    stdin: diffText,
    timeoutMs: 30_000,
  });
  if (!applyResult.ok)
    return { ok: false, code: "apply_failed", error: resolveGitFailureText(applyResult, "撤销改动失败。") };

  return { ok: true, repoRoot };
}
