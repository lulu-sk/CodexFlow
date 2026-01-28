// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import crypto from "node:crypto";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execGitAsync, spawnGitAsync, type GitExecResult } from "./exec";
import { toFsPathAbs } from "./pathKey";

export type WorktreeStateFingerprint = {
  /** index 文件（字节级）sha256（hex）。 */
  indexSha256: string;
  /** 未暂存差异（Working Tree vs Index）：`git diff --binary` 的 stdout sha256（hex）。 */
  unstagedDiffSha256: string;
  /** 未跟踪清单：`git ls-files --others --exclude-standard -z` 的 stdout sha256（hex）。 */
  untrackedListSha256: string;
};

export type WorktreeStateSnapshot = {
  /** 快照 id（用于定位快照目录与日志追溯）。 */
  id: string;
  /** 创建时间（毫秒时间戳）。 */
  createdAt: number;
  /** 目标 worktree 根路径（绝对路径）。 */
  repoMainPath: string;
  /** 由 stash 保存的工作区快照（commit sha）。 */
  stashSha: string;
  /** 创建 stash 时使用的 message（用于 `git stash list` 追溯）。 */
  stashMessage: string;
  /** 快照目录（位于 gitdir 下的 codexflow/recycle-snapshots/<id>）。 */
  snapshotDir: string;
  /** index 快照文件路径（字节级备份，位于 snapshotDir/index）。 */
  indexSnapshotPath: string;
  /** 指纹（用于 restore 后校验）。 */
  fingerprint: WorktreeStateFingerprint;
};

export type WorktreeStateSnapshotCreateResult =
  | { ok: true; snapshot: WorktreeStateSnapshot }
  | { ok: false; locked: boolean; stderr: string; stdout: string; error: string };

export type WorktreeStateSnapshotRestoreResult =
  | { ok: true }
  | { ok: false; locked: boolean; stderr: string; stdout: string; error: string };

/**
 * 中文说明：生成“手动强恢复快照”的命令（用于 UI/日志兜底提示）。
 * - 目的：当自动恢复失败或用户需要手动回放时，提供可复制执行的命令模板。
 * - 注意：命令包含 `reset --hard` 与 `clean -fd`，会丢弃目标仓库当前未提交修改；请确认当前 worktree 可被清空后再执行。
 */
export function buildRestoreCommandsForWorktreeStateSnapshot(snapshot: WorktreeStateSnapshot): string {
  const repoMainPath = String(snapshot?.repoMainPath || "").trim();
  const stashSha = String(snapshot?.stashSha || "").trim();
  const indexSnapshotPath = String(snapshot?.indexSnapshotPath || "").trim();
  if (!repoMainPath || !stashSha || !indexSnapshotPath) return "";

  const q = (s: string) => `"${String(s ?? "").replace(/"/g, '\\"')}"`;
  const git = (argv: string) => `git ${argv}`.trim();
  const cd = `cd ${q(repoMainPath)}`;

  // 中文说明：在 repo 根目录下执行，可直接用 `git rev-parse --git-path index` 得到正确的 index 相对路径（兼容 worktree 场景）。
  // `$(...)` 在 Bash/PowerShell 中都可用；`cp` 在 Bash 中为命令，在 PowerShell 中为 Copy-Item 的别名。
  const copyIndex = `cp ${q(indexSnapshotPath)} \"$(git rev-parse --git-path index)\"`;

  return [
    "# 手动强恢复（事务化快照）：只覆盖、不合并",
    cd,
    git("reset --hard"),
    git("clean -fd"),
    git(`read-tree -u --reset ${stashSha}`),
    "# 若该 stash 包含未跟踪文件（存在第三父提交），再执行下一行：",
    git(`checkout -f ${stashSha}^3 -- .`),
    "# 字节级恢复 index（用于 100% 还原 staged 语义）",
    copyIndex,
    git("update-index -q --refresh"),
    "# 确认恢复无误后，可删除该 stash：",
    git(`stash drop ${stashSha}`),
  ].join("\n");
}

/**
 * 中文说明：判断一次 git 执行失败是否属于“仓库被锁”场景（常见：`.git/index.lock`）。
 */
function isGitLockedFailure(res: { error?: string; stderr?: string; stdout?: string }): boolean {
  const msg = `${String(res?.error || "")}\n${String(res?.stderr || "")}\n${String(res?.stdout || "")}`;
  return /index\.lock|another git process|Unable to create .*\.lock|could not lock|cannot lock|fatal: Unable to create/i.test(msg);
}

/**
 * 中文说明：解析 `git rev-parse --git-path <name>` 为绝对路径。
 */
async function resolveGitPathAbsAsync(args: {
  repoMainPath: string;
  gitPath?: string;
  name: string;
  timeoutMs?: number;
}): Promise<{ ok: true; absPath: string } | { ok: false; locked: boolean; stderr: string; stdout: string; error?: string }> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const name = String(args.name || "").trim();
  const timeoutMs = Math.max(200, Math.min(30_000, Number(args.timeoutMs ?? 8000)));
  const res = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "rev-parse", "--git-path", name], timeoutMs });
  if (!res.ok) return { ok: false, locked: isGitLockedFailure(res), stderr: String(res.stderr || ""), stdout: String(res.stdout || ""), error: res.error };
  const out = String(res.stdout || "").trim();
  const absPath = path.isAbsolute(out) ? out : path.resolve(repoMainPath, out);
  return { ok: true, absPath };
}

/**
 * 中文说明：读取 `refs/stash` 的 sha（无 stash 时返回空字符串）。
 */
async function readStashTopShaAsync(args: { repoMainPath: string; gitPath?: string }): Promise<{ ok: boolean; sha: string; locked: boolean; stderr: string; stdout: string; error?: string }> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const res = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "rev-parse", "-q", "--verify", "refs/stash"], timeoutMs: 8000 });
  if (res.ok) return { ok: true, sha: String(res.stdout || "").trim(), locked: false, stderr: "", stdout: "" };
  // 约定：exitCode=1 表示 refs/stash 不存在（无 stash），按 ok 处理
  if (res.exitCode === 1) return { ok: true, sha: "", locked: false, stderr: "", stdout: "" };
  return { ok: false, sha: "", locked: isGitLockedFailure(res), stderr: String(res.stderr || ""), stdout: String(res.stdout || ""), error: res.error };
}

/**
 * 中文说明：以流式方式计算“文件 sha256（hex）”，避免一次性读入大文件。
 */
async function hashFileSha256Async(filePath: string): Promise<string> {
  const fp = String(filePath || "");
  return await new Promise<string>((resolve, reject) => {
    try {
      const h = crypto.createHash("sha256");
      const rs = fs.createReadStream(fp);
      rs.on("data", (chunk: Buffer | string) => h.update(chunk));
      rs.on("error", reject);
      rs.on("end", () => resolve(h.digest("hex")));
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * 中文说明：以流式方式计算某条 git 命令 stdout 的 sha256（hex），避免缓存大输出到内存。
 * - 仅用于“指纹”计算，不用于展示；stderr 会做长度上限截断用于诊断。
 */
async function hashGitStdoutSha256Async(args: {
  repoMainPath: string;
  gitPath?: string;
  argv: string[];
  timeoutMs?: number;
}): Promise<{ ok: boolean; sha256: string; locked: boolean; exitCode: number; stderr: string; error?: string }> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = String(args.gitPath || "").trim() || "git";
  const argv = Array.isArray(args.argv) ? args.argv.map((x) => String(x)) : [];
  const timeoutMs = Math.max(200, Math.min(30 * 60_000, Number(args.timeoutMs ?? 60_000)));

  return await new Promise((resolve) => {
    let finished = false;
    let timedOut = false;
    let exitCode = -1;
    let stderr = "";
    const stderrLimit = 64 * 1024;
    const h = crypto.createHash("sha256");
    let timeoutHandle: any = null;

    const finalize = (res: { ok: boolean; sha256: string; locked: boolean; exitCode: number; stderr: string; error?: string }) => {
      if (finished) return;
      finished = true;
      if (timeoutHandle) {
        try { clearTimeout(timeoutHandle); } catch {}
        timeoutHandle = null;
      }
      resolve(res);
    };

    try {
      const child = spawn(gitPath, argv, { cwd: undefined, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch {}
        setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 800);
      }, timeoutMs);

      child.stdout?.on("data", (buf: Buffer) => {
        try { h.update(buf); } catch {}
      });
      child.stderr?.on("data", (buf: Buffer) => {
        const chunk = Buffer.isBuffer(buf) ? buf.toString("utf8") : String(buf || "");
        if (stderr.length < stderrLimit) stderr += chunk.slice(0, Math.max(0, stderrLimit - stderr.length));
      });

      child.on("error", (err: any) => {
        const msg = String(err?.message || err);
        finalize({ ok: false, sha256: "", locked: isGitLockedFailure({ error: msg, stderr, stdout: "" }), exitCode: -1, stderr, error: msg });
      });

      child.on("close", (code: number | null) => {
        exitCode = typeof code === "number" ? code : -1;
        if (timedOut) {
          finalize({ ok: false, sha256: "", locked: false, exitCode, stderr, error: `timeout after ${timeoutMs}ms` });
          return;
        }
        if (exitCode === 0) {
          finalize({ ok: true, sha256: h.digest("hex"), locked: false, exitCode: 0, stderr: "" });
          return;
        }
        const err = `exit ${exitCode}`;
        finalize({ ok: false, sha256: "", locked: isGitLockedFailure({ error: err, stderr, stdout: "" }), exitCode, stderr, error: err });
      });
    } catch (e: any) {
      finalize({ ok: false, sha256: "", locked: false, exitCode: -1, stderr: "", error: String(e?.message || e) });
    }
  });
}

/**
 * 中文说明：生成用于快照的轻量唯一 id。
 */
function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * 中文说明：将对象写入 JSON（失败忽略，避免影响主流程）。
 */
async function tryWriteJsonAsync(filePath: string, data: unknown): Promise<void> {
  try {
    await fsp.writeFile(String(filePath || ""), JSON.stringify(data, null, 2), "utf8");
  } catch {}
}

/**
 * 中文说明：创建主 worktree 的“事务化快照”。
 * - Working Tree：用单个 stash（-u）保存 tracked+untracked 的内容级快照；
 * - Index：用 `.git/index` 的字节级快照保存 staged 语义（含冲突 stage/特殊位等）；
 * - 同时记录“指纹”，用于 restore 后自动校验（Working Tree vs Index / untracked 列表 / index hash）。
 */
export async function createWorktreeStateSnapshotAsync(args: {
  repoMainPath: string;
  gitPath?: string;
  stashMessage: string;
  onLog?: (text: string) => void;
}): Promise<WorktreeStateSnapshotCreateResult> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const stashMessage = String(args.stashMessage || "").trim() || `codexflow:snapshot ${new Date().toISOString()}`;
  const log = (text: string) => {
    try { args.onLog?.(String(text ?? "")); } catch {}
  };

  const id = uid();
  const createdAt = Date.now();

  // 1) 预先计算指纹（必须在 stash 前）
  const snapshotDirRes = await resolveGitPathAbsAsync({ repoMainPath, gitPath, name: path.posix.join("codexflow", "recycle-snapshots", id) });
  if (!snapshotDirRes.ok) return { ok: false, locked: snapshotDirRes.locked, stderr: snapshotDirRes.stderr, stdout: snapshotDirRes.stdout, error: snapshotDirRes.error || "无法解析快照目录" };
  const snapshotDir = snapshotDirRes.absPath;
  try {
    await fsp.mkdir(snapshotDir, { recursive: true });
  } catch (e: any) {
    return { ok: false, locked: false, stderr: "", stdout: "", error: String(e?.message || e) };
  }

  const indexPathRes = await resolveGitPathAbsAsync({ repoMainPath, gitPath, name: "index" });
  if (!indexPathRes.ok) return { ok: false, locked: indexPathRes.locked, stderr: indexPathRes.stderr, stdout: indexPathRes.stdout, error: indexPathRes.error || "无法解析 index 路径" };
  const indexPath = indexPathRes.absPath;
  const indexSnapshotPath = path.join(snapshotDir, "index");
  try {
    await fsp.copyFile(indexPath, indexSnapshotPath);
  } catch (e: any) {
    return { ok: false, locked: false, stderr: "", stdout: "", error: String(e?.message || e) };
  }

  const diffHash = await hashGitStdoutSha256Async({ repoMainPath, gitPath, argv: ["-C", repoMainPath, "diff", "--binary"], timeoutMs: 10 * 60_000 });
  if (!diffHash.ok) return { ok: false, locked: diffHash.locked, stderr: diffHash.stderr, stdout: "", error: diffHash.error || "读取未暂存差异失败" };

  const untrackedHash = await hashGitStdoutSha256Async({
    repoMainPath,
    gitPath,
    argv: ["-C", repoMainPath, "ls-files", "--others", "--exclude-standard", "-z"],
    timeoutMs: 60_000,
  });
  if (!untrackedHash.ok) return { ok: false, locked: untrackedHash.locked, stderr: untrackedHash.stderr, stdout: "", error: untrackedHash.error || "读取未跟踪清单失败" };

  let indexSha256 = "";
  try {
    indexSha256 = await hashFileSha256Async(indexSnapshotPath);
  } catch (e: any) {
    return { ok: false, locked: false, stderr: "", stdout: "", error: String(e?.message || e) };
  }

  // 2) 创建 stash（保存 Working Tree + Index 的关联）
  const prev = await readStashTopShaAsync({ repoMainPath, gitPath });
  if (!prev.ok) {
    return { ok: false, locked: prev.locked, stderr: prev.stderr, stdout: prev.stdout, error: prev.error || "无法读取 refs/stash" };
  }

  log(`\n$ git stash push -u -m \"${stashMessage.replace(/\"/g, '\\"')}\"\n`);
  const push = await spawnGitAsync({
    gitPath,
    argv: ["-C", repoMainPath, "stash", "push", "-u", "-m", stashMessage],
    timeoutMs: 10 * 60_000,
    onStdout: log,
    onStderr: log,
  });
  if (!push.ok) {
    const locked = isGitLockedFailure(push);
    return { ok: false, locked, stderr: String(push.stderr || ""), stdout: String(push.stdout || ""), error: push.error || "创建 stash 失败" };
  }

  const next = await readStashTopShaAsync({ repoMainPath, gitPath });
  if (!next.ok) return { ok: false, locked: next.locked, stderr: next.stderr, stdout: next.stdout, error: next.error || "无法读取 stash 结果" };
  if (!next.sha || next.sha === prev.sha) {
    const hint = `${String(push.stderr || "")}\n${String(push.stdout || "")}`.trim() || push.error || "stash 未生成（可能无可保存内容）";
    return { ok: false, locked: false, stderr: String(push.stderr || ""), stdout: String(push.stdout || ""), error: hint };
  }

  const fingerprint: WorktreeStateFingerprint = {
    indexSha256,
    unstagedDiffSha256: diffHash.sha256,
    untrackedListSha256: untrackedHash.sha256,
  };

  const snapshot: WorktreeStateSnapshot = {
    id,
    createdAt,
    repoMainPath,
    stashSha: next.sha,
    stashMessage,
    snapshotDir,
    indexSnapshotPath,
    fingerprint,
  };

  await tryWriteJsonAsync(path.join(snapshotDir, "snapshot.json"), snapshot);
  return { ok: true, snapshot };
}

/**
 * 中文说明：强恢复主 worktree 到快照状态（只覆盖、不合并），并做指纹校验。
 * - 先将工作区重置到确定态（reset --hard + clean -fd），避免残留文件影响恢复。
 * - 再从 stash commit 的 tree 回放 tracked 内容（read-tree -u --reset）。
 * - 若存在 untracked parent（^3），再 checkout 回放未跟踪文件内容。
 * - 最后用 index 字节级快照原样覆盖恢复，保证 staged/unstaged 语义不漂移。
 */
export async function restoreWorktreeStateSnapshotAsync(args: {
  repoMainPath: string;
  gitPath?: string;
  snapshot: WorktreeStateSnapshot;
  onLog?: (text: string) => void;
}): Promise<WorktreeStateSnapshotRestoreResult> {
  const repoMainPath = toFsPathAbs(args.repoMainPath);
  const gitPath = args.gitPath;
  const snapshot = args.snapshot;
  const log = (text: string) => {
    try { args.onLog?.(String(text ?? "")); } catch {}
  };

  const run = async (argv: string[], timeoutMs: number): Promise<GitExecResult> => {
    log(`\n$ git ${argv.join(" ")}\n`);
    return await spawnGitAsync({ gitPath, argv, timeoutMs, onStdout: log, onStderr: log });
  };

  // 1) 清空到确定态（避免残留影响恢复）
  const reset = await run(["-C", repoMainPath, "reset", "--hard"], 10 * 60_000);
  if (!reset.ok) return { ok: false, locked: isGitLockedFailure(reset), stderr: String(reset.stderr || ""), stdout: String(reset.stdout || ""), error: reset.error || "reset --hard 失败" };

  const clean = await run(["-C", repoMainPath, "clean", "-fd"], 10 * 60_000);
  if (!clean.ok) return { ok: false, locked: isGitLockedFailure(clean), stderr: String(clean.stderr || ""), stdout: String(clean.stdout || ""), error: clean.error || "clean -fd 失败" };

  // 2) 回放 tracked 工作区内容（commit 的 tree）
  const readTree = await run(["-C", repoMainPath, "read-tree", "-u", "--reset", snapshot.stashSha], 10 * 60_000);
  if (!readTree.ok) return { ok: false, locked: isGitLockedFailure(readTree), stderr: String(readTree.stderr || ""), stdout: String(readTree.stdout || ""), error: readTree.error || "read-tree 回放失败" };

  // 3) 回放 untracked（若 stash 有第三父提交）
  const u3 = await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "rev-parse", "-q", "--verify", `${snapshot.stashSha}^3`], timeoutMs: 8000 });
  const untrackedCommit = u3.ok ? String(u3.stdout || "").trim() : "";
  if (untrackedCommit) {
    const checkoutU = await run(["-C", repoMainPath, "checkout", "-f", untrackedCommit, "--", "."], 10 * 60_000);
    if (!checkoutU.ok) {
      return { ok: false, locked: isGitLockedFailure(checkoutU), stderr: String(checkoutU.stderr || ""), stdout: String(checkoutU.stdout || ""), error: checkoutU.error || "恢复未跟踪文件失败" };
    }
  }

  // 4) 字节级恢复 index
  const idx = await resolveGitPathAbsAsync({ repoMainPath, gitPath, name: "index" });
  if (!idx.ok) return { ok: false, locked: idx.locked, stderr: idx.stderr, stdout: idx.stdout, error: idx.error || "无法解析 index 路径" };
  try {
    await fsp.copyFile(snapshot.indexSnapshotPath, idx.absPath);
  } catch (e: any) {
    const msg = String(e?.message || e);
    return { ok: false, locked: /lock|EBUSY|EACCES|EPERM/i.test(msg), stderr: "", stdout: "", error: msg };
  }

  // 5) 轻量刷新 stat cache（失败不影响语义）
  try { await execGitAsync({ gitPath, argv: ["-C", repoMainPath, "update-index", "-q", "--refresh"], timeoutMs: 30_000 }); } catch {}

  // 6) 指纹校验（确保“未暂存/未跟踪”没被打乱；index 用字节 hash 校验）
  try {
    const nowIndexHash = await hashFileSha256Async(idx.absPath);
    if (nowIndexHash !== snapshot.fingerprint.indexSha256) {
      return { ok: false, locked: false, stderr: "", stdout: "", error: "恢复后 index 校验失败（hash 不一致）" };
    }
  } catch (e: any) {
    return { ok: false, locked: false, stderr: "", stdout: "", error: String(e?.message || e) };
  }

  const diffHash = await hashGitStdoutSha256Async({ repoMainPath, gitPath, argv: ["-C", repoMainPath, "diff", "--binary"], timeoutMs: 10 * 60_000 });
  if (!diffHash.ok) return { ok: false, locked: diffHash.locked, stderr: diffHash.stderr, stdout: "", error: diffHash.error || "恢复后读取未暂存差异失败" };
  if (diffHash.sha256 !== snapshot.fingerprint.unstagedDiffSha256) {
    return { ok: false, locked: false, stderr: "", stdout: "", error: "恢复后未暂存差异校验失败（hash 不一致）" };
  }

  const untrackedHash = await hashGitStdoutSha256Async({
    repoMainPath,
    gitPath,
    argv: ["-C", repoMainPath, "ls-files", "--others", "--exclude-standard", "-z"],
    timeoutMs: 60_000,
  });
  if (!untrackedHash.ok) return { ok: false, locked: untrackedHash.locked, stderr: untrackedHash.stderr, stdout: "", error: untrackedHash.error || "恢复后读取未跟踪清单失败" };
  if (untrackedHash.sha256 !== snapshot.fingerprint.untrackedListSha256) {
    return { ok: false, locked: false, stderr: "", stdout: "", error: "恢复后未跟踪清单校验失败（hash 不一致）" };
  }

  return { ok: true };
}

/**
 * 中文说明：清理快照目录（失败忽略，不影响主流程）。
 */
export async function cleanupWorktreeStateSnapshotAsync(args: { snapshotDir: string }): Promise<{ ok: boolean; error?: string }> {
  const dir = String(args.snapshotDir || "").trim();
  if (!dir) return { ok: true };
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
