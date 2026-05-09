import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { execGitAsync } from "../exec";
import { dispatchGitFeatureAction } from "../featureService";
import { GitChangesSaver } from "./changeSaver";

type ClonePairContext = {
  remoteRepo: string;
  localRepo: string;
  otherRepo: string;
  userDataPath: string;
  cleanupPaths: string[];
};

type NestedWorkspaceContext = ClonePairContext & {
  workspaceRoot: string;
  childRemoteRepo: string;
  childLocalRepo: string;
  childOtherRepo: string;
};

type SubmoduleWorkspaceContext = {
  parentRemoteRepo: string;
  parentLocalRepo: string;
  parentOtherRepo: string;
  subRemoteRepo: string;
  subUpdaterRepo: string;
  userDataPath: string;
  cleanupPaths: string[];
};

/**
 * 在指定仓库执行 Git 命令；失败时直接抛出包含 stderr 的断言，便于快速定位场景问题。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 30_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 在任意目录执行 Git 命令，用于 bare 仓库初始化、clone 或 submodule 等不适合固定 `-C repo` 的场景。
 */
async function gitInDirAsync(cwd: string, argv: string[], timeoutMs: number = 30_000): Promise<string> {
  const res = await execGitAsync({ cwd, argv, timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 为测试仓库写入统一用户配置与 LF 行尾，避免不同平台默认配置导致断言波动。
 */
async function configureRepoAsync(repo: string): Promise<void> {
  await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);
  await gitAsync(repo, ["config", "core.autocrlf", "false"]);
  await gitAsync(repo, ["config", "core.eol", "lf"]);
}

/**
 * 初始化一个工作仓库并显式切到 `main`，避免不同 Git 版本默认分支差异污染测试。
 */
async function initWorkingRepoAsync(repo: string): Promise<void> {
  await gitAsync(repo, ["init"]);
  await configureRepoAsync(repo);
  await gitAsync(repo, ["checkout", "-b", "main"]);
}

/**
 * 写入文件并创建提交，供远端/本地分支场景快速搭建历史。
 */
async function writeAndCommitAsync(repo: string, relativePath: string, content: string, message: string): Promise<string> {
  const targetPath = path.join(repo, relativePath);
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.writeFile(targetPath, content, "utf8");
  await gitAsync(repo, ["add", relativePath]);
  await gitAsync(repo, ["commit", "-m", message]);
  return (await gitAsync(repo, ["rev-parse", "HEAD"])).trim();
}

/**
 * 读取文件内容并统一返回 UTF-8 文本，便于断言本地改动是否被保留或远端提交是否已同步。
 */
async function readFileAsync(repo: string, relativePath: string): Promise<string> {
  return await fsp.readFile(path.join(repo, relativePath), "utf8");
}

/**
 * 从 Update Project 返回值中提取最终使用的更新方式，兼容顶层与 root 级结果结构。
 */
function resolvedMethodOf(result: { data?: any }): string {
  return String(result.data?.roots?.[0]?.method || result.data?.roots?.[0]?.data?.method || result.data?.method || "").trim();
}

/**
 * 为测试场景创建 bare 远端、主克隆、副本克隆与 userData 目录，作为单仓更新基线。
 */
async function createTrackedClonePairAsync(prefix: string, options?: { initialFiles?: Array<{ path: string; content: string }> }): Promise<ClonePairContext> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-update-${prefix}-`));
  const seedRepo = path.join(tempRoot, "seed");
  const remoteRepo = path.join(tempRoot, "origin.git");
  const localRepo = path.join(tempRoot, "local");
  const otherRepo = path.join(tempRoot, "other");
  const userDataPath = path.join(tempRoot, "user-data");
  await fsp.mkdir(seedRepo, { recursive: true });
  await fsp.mkdir(userDataPath, { recursive: true });

  await initWorkingRepoAsync(seedRepo);
  const initialFiles = options?.initialFiles && options.initialFiles.length > 0
    ? options.initialFiles
    : [{ path: "README.md", content: "# demo\n" }];
  for (const file of initialFiles) {
    const targetPath = path.join(seedRepo, file.path);
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, file.content, "utf8");
  }
  await gitAsync(seedRepo, ["add", "."]);
  await gitAsync(seedRepo, ["commit", "-m", "init"]);

  await gitInDirAsync(tempRoot, ["init", "--bare", remoteRepo]);
  await gitAsync(seedRepo, ["remote", "add", "origin", remoteRepo]);
  await gitAsync(seedRepo, ["push", "-u", "origin", "main"]);

  await gitInDirAsync(tempRoot, ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "clone", "-b", "main", remoteRepo, localRepo]);
  await gitInDirAsync(tempRoot, ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "clone", "-b", "main", remoteRepo, otherRepo]);
  await configureRepoAsync(localRepo);
  await configureRepoAsync(otherRepo);

  return {
    remoteRepo,
    localRepo,
    otherRepo,
    userDataPath,
    cleanupPaths: [tempRoot],
  };
}

/**
 * 构建带嵌套独立子仓的多仓工作区，用于验证 repository graph、skip roots 与多仓聚合结果。
 */
async function createNestedWorkspaceAsync(prefix: string): Promise<NestedWorkspaceContext> {
  const base = await createTrackedClonePairAsync(prefix, {
    initialFiles: [
      { path: ".gitignore", content: "packages/\n" },
      { path: "README.md", content: "# parent\n" },
    ],
  });
  const workspaceRoot = base.localRepo;
  const childPair = await createTrackedClonePairAsync(`${prefix}-child`, {
    initialFiles: [{ path: "child.txt", content: "child\n" }],
  });
  const childLocalRepo = path.join(workspaceRoot, "packages", "child");
  const childOtherRepo = path.join(base.otherRepo, "packages", "child-peer");
  await fsp.mkdir(path.dirname(childLocalRepo), { recursive: true });
  await fsp.mkdir(path.dirname(childOtherRepo), { recursive: true });
  await gitInDirAsync(path.dirname(childLocalRepo), ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "clone", "-b", "main", childPair.remoteRepo, childLocalRepo]);
  await gitInDirAsync(path.dirname(childOtherRepo), ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "clone", "-b", "main", childPair.remoteRepo, childOtherRepo]);
  await configureRepoAsync(childLocalRepo);
  await configureRepoAsync(childOtherRepo);
  return {
    ...base,
    workspaceRoot,
    childRemoteRepo: childPair.remoteRepo,
    childLocalRepo,
    childOtherRepo,
    cleanupPaths: [...base.cleanupPaths, ...childPair.cleanupPaths],
  };
}

/**
 * 构建父仓 + 子模块测试工作区，分别复用父仓与子模块远端，覆盖 detached/on-branch 两类语义。
 */
async function createSubmoduleWorkspaceAsync(prefix: string): Promise<SubmoduleWorkspaceContext> {
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `codexflow-update-submodule-${prefix}-`));
  const subSeedRepo = path.join(tempRoot, "sub-seed");
  const subRemoteRepo = path.join(tempRoot, "sub-origin.git");
  const parentSeedRepo = path.join(tempRoot, "parent-seed");
  const parentRemoteRepo = path.join(tempRoot, "parent-origin.git");
  const parentLocalRepo = path.join(tempRoot, "parent-local");
  const parentOtherRepo = path.join(tempRoot, "parent-other");
  const subUpdaterRepo = path.join(tempRoot, "sub-updater");
  const userDataPath = path.join(tempRoot, "user-data");
  await fsp.mkdir(userDataPath, { recursive: true });
  await fsp.mkdir(subSeedRepo, { recursive: true });
  await fsp.mkdir(parentSeedRepo, { recursive: true });

  await initWorkingRepoAsync(subSeedRepo);
  await writeAndCommitAsync(subSeedRepo, "lib.txt", "submodule init\n", "sub: init");
  await gitInDirAsync(tempRoot, ["init", "--bare", subRemoteRepo]);
  await gitAsync(subSeedRepo, ["remote", "add", "origin", subRemoteRepo]);
  await gitAsync(subSeedRepo, ["push", "-u", "origin", "main"]);

  await initWorkingRepoAsync(parentSeedRepo);
  await writeAndCommitAsync(parentSeedRepo, "README.md", "# parent\n", "parent: init");
  await gitInDirAsync(tempRoot, ["init", "--bare", parentRemoteRepo]);
  await gitAsync(parentSeedRepo, ["remote", "add", "origin", parentRemoteRepo]);
  await gitAsync(parentSeedRepo, ["push", "-u", "origin", "main"]);
  await gitInDirAsync(parentSeedRepo, ["-c", "protocol.file.allow=always", "submodule", "add", "-b", "main", subRemoteRepo, "modules/lib"]);
  await gitAsync(parentSeedRepo, ["commit", "-am", "parent: add submodule"]);
  await gitAsync(parentSeedRepo, ["push"]);

  await gitInDirAsync(tempRoot, ["-c", "protocol.file.allow=always", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "clone", "-b", "main", "--recurse-submodules", parentRemoteRepo, parentLocalRepo]);
  await gitInDirAsync(tempRoot, ["-c", "protocol.file.allow=always", "-c", "core.autocrlf=false", "-c", "core.eol=lf", "clone", "-b", "main", "--recurse-submodules", parentRemoteRepo, parentOtherRepo]);
  await gitInDirAsync(tempRoot, ["-c", "core.autocrlf=false", "-c", "core.eol=lf", "clone", "-b", "main", subRemoteRepo, subUpdaterRepo]);
  await configureRepoAsync(parentLocalRepo);
  await configureRepoAsync(parentOtherRepo);
  await configureRepoAsync(path.join(parentLocalRepo, "modules", "lib"));
  await configureRepoAsync(path.join(parentOtherRepo, "modules", "lib"));
  await configureRepoAsync(subUpdaterRepo);

  return {
    parentRemoteRepo,
    parentLocalRepo,
    parentOtherRepo,
    subRemoteRepo,
    subUpdaterRepo,
    userDataPath,
    cleanupPaths: [tempRoot],
  };
}

/**
 * 统一调用 Git feature action，减少测试体内重复样板代码。
 */
async function dispatchAsync(userDataPath: string, action: string, repoPath: string, payload?: any): Promise<any> {
  return await dispatchGitFeatureAction({
    action,
    payload: { repoPath, ...(payload || {}) },
    userDataPath,
  });
}

/**
 * 清理单测过程中创建的临时目录；忽略删除失败，避免掩盖真正断言错误。
 */
async function cleanupAsync(paths: string[]): Promise<void> {
  for (const target of paths) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
    } catch {}
  }
}

describe("update flow alignment", () => {
  it(
    "单仓 Rebase：无本地提交时应同步远端并产出 ranges / notification",
    async () => {
      const ctx = await createTrackedClonePairAsync("rebase-no-local");
      try {
        await writeAndCommitAsync(ctx.otherRepo, "remote.txt", "remote one\n", "remote: one");
        await gitAsync(ctx.otherRepo, ["push"]);

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.localRepo, { updateMethod: "rebase" });
        expect(res.ok).toBe(true);
        expect(res.data?.roots?.[0]?.updatedRange?.start).toBeTruthy();
        expect(res.data?.updatedRoots).toContain(ctx.localRepo);
        expect(await readFileAsync(ctx.localRepo, "remote.txt")).toContain("remote one");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "单仓 Rebase：存在本地提交与 AD 变更时仍应完成更新并保留本地提交",
    async () => {
      const ctx = await createTrackedClonePairAsync("rebase-local-ad", {
        initialFiles: [{ path: "shared.txt", content: "base\n" }],
      });
      try {
        await writeAndCommitAsync(ctx.localRepo, "local.txt", "local change\n", "local: keep");
        await gitAsync(ctx.otherRepo, ["rm", "shared.txt"]);
        await fsp.writeFile(path.join(ctx.otherRepo, "added.txt"), "added by remote\n", "utf8");
        await gitAsync(ctx.otherRepo, ["add", "added.txt"]);
        await gitAsync(ctx.otherRepo, ["commit", "-m", "remote: add-delete"]);
        await gitAsync(ctx.otherRepo, ["push"]);

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.localRepo, { updateMethod: "rebase" });
        expect(res.ok).toBe(true);
        const subjects = (await gitAsync(ctx.localRepo, ["log", "--format=%s", "-2"])).trim().split(/\r?\n/);
        expect(subjects[0]).toBe("local: keep");
        expect(subjects[1]).toBe("remote: add-delete");
        expect(await readFileAsync(ctx.localRepo, "added.txt")).toContain("added by remote");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "单仓 Rebase：updatedRange 应基于 local/upstream merge-base，而不是更新前 HEAD",
    async () => {
      const ctx = await createTrackedClonePairAsync("rebase-updated-range", {
        initialFiles: [{ path: "base.txt", content: "base\n" }],
      });
      try {
        const initialMergeBase = (await gitAsync(ctx.localRepo, ["rev-parse", "HEAD"])).trim();
        await writeAndCommitAsync(ctx.localRepo, "local.txt", "local keep\n", "local: keep");
        await writeAndCommitAsync(ctx.otherRepo, "remote.txt", "remote incoming\n", "remote: incoming");
        const remoteTip = (await gitAsync(ctx.otherRepo, ["rev-parse", "HEAD"])).trim();
        await gitAsync(ctx.otherRepo, ["push"]);

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.localRepo, { updateMethod: "rebase" });
        expect(res.ok).toBe(true);
        expect(res.data?.roots?.[0]?.updatedRange).toEqual({
          start: initialMergeBase,
          end: remoteTip,
        });
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "单仓 Rebase：选择 shelve 时应使用独立搁置记录保存并恢复本地改动",
    async () => {
      const ctx = await createTrackedClonePairAsync("rebase-shelve", {
        initialFiles: [{ path: "shared.txt", content: "base\n" }],
      });
      try {
        await writeAndCommitAsync(ctx.localRepo, "local-commit.txt", "local commit\n", "local: commit");
        await fsp.writeFile(path.join(ctx.localRepo, "shared.txt"), "base\nlocal worktree\n", "utf8");
        await fsp.writeFile(path.join(ctx.localRepo, "local-untracked.txt"), "local untracked\n", "utf8");
        await writeAndCommitAsync(ctx.otherRepo, "remote.txt", "remote data\n", "remote: update");
        await gitAsync(ctx.otherRepo, ["push"]);

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.localRepo, {
          updateMethod: "rebase",
          saveChangesPolicy: "shelve",
        });
        expect(res.ok).toBe(true);
        expect(await readFileAsync(ctx.localRepo, "shared.txt")).toContain("local worktree");
        expect(await readFileAsync(ctx.localRepo, "local-untracked.txt")).toContain("local untracked");
        expect(await readFileAsync(ctx.localRepo, "remote.txt")).toContain("remote data");
        expect((await gitAsync(ctx.localRepo, ["stash", "list"])).trim()).toBe("");
        expect(res.data?.roots?.[0]?.data?.saveChangesPolicy).toBe("shelve");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "单仓 Merge：shelve 恢复遇到更新后已存在的同内容文件时，应视为恢复成功",
    async () => {
      const ctx = await createTrackedClonePairAsync("merge-shelve-same-content", {
        initialFiles: [{ path: "shared.txt", content: "base\n" }],
      });
      try {
        await fsp.writeFile(path.join(ctx.localRepo, "same.txt"), "same content\n", "utf8");
        await writeAndCommitAsync(ctx.otherRepo, "same.txt", "same content\n", "remote: add same file");
        await gitAsync(ctx.otherRepo, ["push"]);

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.localRepo, {
          updateMethod: "merge",
          saveChangesPolicy: "shelve",
        });
        expect(res.ok).toBe(true);
        expect(res.data?.preservingState?.status).toBe("restored");
        expect(await readFileAsync(ctx.localRepo, "same.txt")).toBe("same content\n");
        expect((await gitAsync(ctx.localRepo, ["status", "--short"])).trim()).toBe("");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "Reset 更新应直接保留非冲突本地改动",
    async () => {
      const ctx = await createTrackedClonePairAsync("reset-preserve", {
        initialFiles: [
          { path: "local.txt", content: "local base\n" },
          { path: "remote.txt", content: "remote base\n" },
        ],
      });
      try {
        await fsp.writeFile(path.join(ctx.localRepo, "local.txt"), "local base\nlocal worktree\n", "utf8");
        await writeAndCommitAsync(ctx.otherRepo, "remote.txt", "remote updated\n", "remote: update");
        await gitAsync(ctx.otherRepo, ["push"]);

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.localRepo, { updateMethod: "reset" });
        expect(res.ok).toBe(true);
        expect(
          res.data?.roots?.[0]?.data?.branchReset
          ?? res.data?.roots?.[0]?.branchReset
          ?? res.data?.branchReset,
        ).toBe(true);
        expect(await readFileAsync(ctx.localRepo, "local.txt")).toContain("local worktree");
        expect(await readFileAsync(ctx.localRepo, "remote.txt")).toContain("remote updated");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "Reset 更新在 shelve 恢复失败时应返回 preservingState 并保留独立搁置记录",
    async () => {
      const ctx = await createTrackedClonePairAsync("reset-shelve-restore-fail", {
        initialFiles: [{ path: "shared.txt", content: "base\n" }],
      });
      try {
        await fsp.writeFile(path.join(ctx.localRepo, "shared.txt"), "local rewrite\n", "utf8");
        await fsp.writeFile(path.join(ctx.otherRepo, "shared.txt"), "remote rewrite\n", "utf8");
        await gitAsync(ctx.otherRepo, ["add", "shared.txt"]);
        await gitAsync(ctx.otherRepo, ["commit", "-m", "remote: rewrite"]);
        await gitAsync(ctx.otherRepo, ["push"]);

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.localRepo, {
          updateMethod: "reset",
          saveChangesPolicy: "shelve",
        });
        expect(res.ok).toBe(true);
        expect(res.data?.preservingState?.status).toBe("restore-failed");
        expect(res.data?.preservingState?.saveChangesPolicy).toBe("shelve");
        expect(String(res.data?.preservingState?.savedLocalChangesRef || "")).toContain("shelf@{");
        expect(String(res.data?.preservingState?.savedLocalChangesDisplayName || "")).toContain("搁置记录");
        expect(await readFileAsync(ctx.localRepo, "shared.txt")).toContain("remote rewrite");
        expect((await gitAsync(ctx.localRepo, ["stash", "list"])).trim()).toBe("");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "Reset 更新遇到未跟踪文件冲突时应返回 smart dialog 问题",
    async () => {
      const ctx = await createTrackedClonePairAsync("reset-untracked", {
        initialFiles: [{ path: "base.txt", content: "base\n" }],
      });
      try {
        await fsp.mkdir(path.join(ctx.localRepo, "incoming"), { recursive: true });
        await fsp.writeFile(path.join(ctx.localRepo, "incoming", "keep.txt"), "local untracked\n", "utf8");
        await writeAndCommitAsync(ctx.otherRepo, "incoming", "remote tracked\n", "remote: tracked incoming");
        await gitAsync(ctx.otherRepo, ["push"]);

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.localRepo, { updateMethod: "reset" });
        expect(res.ok).toBe(false);
        expect(res.data?.operationProblem?.kind || res.data?.roots?.[0]?.data?.operationProblem?.kind).toBe("untracked-overwritten");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "tracked branch 缺失时应可先预览修复、应用配置，再继续完成更新",
    async () => {
      const ctx = await createTrackedClonePairAsync("tracked-branch-fix", {
        initialFiles: [{ path: "base.txt", content: "base\n" }],
      });
      try {
        await gitAsync(ctx.localRepo, ["branch", "--unset-upstream"]);
        const previewRes = await dispatchAsync(ctx.userDataPath, "update.trackedBranchPreview", ctx.localRepo, {});
        expect(previewRes.ok).toBe(true);
        expect(previewRes.data?.issues?.[0]?.issueCode).toBe("no-tracked-branch");
        expect(previewRes.data?.defaultUpdateMethod).toBe("merge");

        const applyRes = await dispatchAsync(ctx.userDataPath, "update.trackedBranchApply", ctx.localRepo, {
          updateMethod: "rebase",
          selections: [{
            repoRoot: ctx.localRepo,
            remote: "origin",
            remoteBranch: "main",
            setAsTracked: true,
          }],
        });
        expect(applyRes.ok).toBe(true);
        expect(applyRes.data?.persistedRoots).toContain(ctx.localRepo);
        expect(applyRes.data?.updatePayloadPatch?.updateMethod).toBe("rebase");
        expect((await gitAsync(ctx.localRepo, ["config", "--get", "branch.main.remote"])).trim()).toBe("origin");
        expect((await gitAsync(ctx.localRepo, ["config", "--get", "branch.main.merge"])).trim()).toBe("refs/heads/main");

        await writeAndCommitAsync(ctx.otherRepo, "incoming.txt", "incoming\n", "remote: tracked branch fixed");
        await gitAsync(ctx.otherRepo, ["push"]);

        const pullRes = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.localRepo, applyRes.data?.updatePayloadPatch || {});
        expect(pullRes.ok).toBe(true);
        expect(resolvedMethodOf(pullRes)).toBe("rebase");
        expect(await readFileAsync(ctx.localRepo, "incoming.txt")).toContain("incoming");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "默认不应递归扫描普通嵌套仓，只更新显式请求仓库",
    async () => {
      const ctx = await createNestedWorkspaceAsync("multi-root");
      try {
        await gitAsync(ctx.childLocalRepo, ["checkout", "--detach"]);
        await writeAndCommitAsync(ctx.otherRepo, "parent-remote.txt", "parent remote\n", "parent: remote");
        await gitAsync(ctx.otherRepo, ["push"]);
        await writeAndCommitAsync(ctx.childOtherRepo, "child-remote.txt", "child remote\n", "child: remote");
        await gitAsync(ctx.childOtherRepo, ["push"]);

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.workspaceRoot, {});
        expect(res.ok).toBe(true);
        expect(res.data?.updatedRoots).toContain(ctx.localRepo);
        expect((res.data?.roots || []).some((root: any) => root.repoRoot === ctx.childLocalRepo)).toBe(false);
        expect(await readFileAsync(ctx.localRepo, "parent-remote.txt")).toContain("parent remote");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 150_000 },
  );

  it(
    "显式传入 repoRoots 时应纳入多个独立仓，并对 detached root 返回跳过结果",
    async () => {
      const ctx = await createNestedWorkspaceAsync("explicit-multi-root");
      try {
        await gitAsync(ctx.childLocalRepo, ["checkout", "--detach"]);
        await writeAndCommitAsync(ctx.otherRepo, "parent-remote.txt", "parent remote\n", "parent: remote");
        await gitAsync(ctx.otherRepo, ["push"]);
        await writeAndCommitAsync(ctx.childOtherRepo, "child-remote.txt", "child remote\n", "child: remote");
        await gitAsync(ctx.childOtherRepo, ["push"]);

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.workspaceRoot, {
          repoRoots: [ctx.localRepo, ctx.childLocalRepo],
        });
        expect(res.ok).toBe(true);
        expect((res.data?.roots || []).some((root: any) => root.repoRoot === ctx.childLocalRepo)).toBe(true);
        expect(res.data?.skippedRoots.some((root: any) => root.repoRoot === ctx.childLocalRepo && root.reasonCode === "detached-head")).toBe(true);
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 150_000 },
  );

  it(
    "多仓 flow.pull preserving 应只调用一次全局 saver，并在成功后恢复两仓本地改动",
    async () => {
      const ctx = await createNestedWorkspaceAsync("global-preserving");
      const saveSpy = vi.spyOn(GitChangesSaver.prototype, "trySaveLocalChanges");
      try {
        await fsp.writeFile(path.join(ctx.localRepo, "README.md"), "# parent\nlocal parent\n", "utf8");
        await gitAsync(ctx.localRepo, ["add", "README.md"]);
        await fsp.writeFile(path.join(ctx.childLocalRepo, "child.txt"), "child\nlocal child\n", "utf8");
        await gitAsync(ctx.childLocalRepo, ["add", "child.txt"]);
        await writeAndCommitAsync(ctx.otherRepo, "parent-remote.txt", "parent remote\n", "parent: remote");
        await gitAsync(ctx.otherRepo, ["push"]);
        await writeAndCommitAsync(ctx.childOtherRepo, "child-remote.txt", "child remote\n", "child: remote");
        await gitAsync(ctx.childOtherRepo, ["push"]);

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.workspaceRoot, {
          repoRoots: [ctx.localRepo, ctx.childLocalRepo],
          updateMethod: "merge",
          saveChangesPolicy: "stash",
        });

        expect(res.ok).toBe(true);
        expect(saveSpy).toHaveBeenCalledTimes(1);
        expect(saveSpy).toHaveBeenCalledWith([ctx.localRepo, ctx.childLocalRepo]);
        expect(await readFileAsync(ctx.localRepo, "README.md")).toContain("local parent");
        expect(await readFileAsync(ctx.childLocalRepo, "child.txt")).toContain("local child");
        expect(await readFileAsync(ctx.localRepo, "parent-remote.txt")).toContain("parent remote");
        expect(await readFileAsync(ctx.childLocalRepo, "child-remote.txt")).toContain("child remote");
        expect((await gitAsync(ctx.localRepo, ["diff", "--cached", "--name-only"])).trim()).toBe("README.md");
        expect((await gitAsync(ctx.childLocalRepo, ["diff", "--cached", "--name-only"])).trim()).toBe("child.txt");
        expect((await gitAsync(ctx.localRepo, ["stash", "list"])).trim()).toBe("");
        expect((await gitAsync(ctx.childLocalRepo, ["stash", "list"])).trim()).toBe("");
        expect(res.data?.savedLocalChangesEntries).toHaveLength(2);
        expect((res.data?.roots || []).map((root: any) => root.preservingState?.status)).toEqual(expect.arrayContaining(["restored", "restored"]));
      } finally {
        saveSpy.mockRestore();
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 180_000 },
  );

  it(
    "已保存的多仓默认范围应在 flow.pull 未显式传参时自动注入",
    async () => {
      const ctx = await createNestedWorkspaceAsync("stored-multi-root");
      try {
        await gitAsync(ctx.childLocalRepo, ["checkout", "--detach"]);
        const storePath = path.join(ctx.userDataPath, "git", "update-options.json");
        await fsp.mkdir(path.dirname(storePath), { recursive: true });
        await fsp.writeFile(storePath, JSON.stringify({
          version: 1,
          options: {
            updateMethod: "merge",
            saveChangesPolicy: "shelve",
            scope: {
              syncStrategy: "linked",
              linkedRepoRoots: [ctx.childLocalRepo],
              skippedRepoRoots: [],
              includeNestedRoots: false,
              rootScanMaxDepth: 8,
            },
          },
        }, null, 2), "utf8");

        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.workspaceRoot, {});
        expect(res.ok).toBe(true);
        expect((res.data?.roots || []).some((root: any) => root.repoRoot === ctx.childLocalRepo)).toBe(true);
        expect(res.data?.skippedRoots.some((root: any) => root.repoRoot === ctx.childLocalRepo && root.reasonCode === "detached-head")).toBe(true);
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 150_000 },
  );

  it(
    "多仓中任一显式 root 的远端分支删除后应整体返回未就绪",
    async () => {
      const ctx = await createNestedWorkspaceAsync("multi-root-remote-missing");
      try {
        await gitAsync(ctx.childRemoteRepo, ["update-ref", "-d", "refs/heads/main"]);
        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.workspaceRoot, {
          repoRoots: [ctx.localRepo, ctx.childLocalRepo],
        });
        expect(res.ok).toBe(false);
        const childRoot = (res.data?.roots || []).find((root: any) => root.repoRoot === ctx.childLocalRepo);
        expect(childRoot?.failureCode || childRoot?.skippedReasonCode).toBe("remote-missing");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 150_000 },
  );

  it(
    "远端分支真实存在但本地 tracking ref 缺失时，preview 不应误报 remote-missing",
    async () => {
      const ctx = await createTrackedClonePairAsync("preview-remote-missing");
      try {
        await gitAsync(ctx.localRepo, ["update-ref", "-d", "refs/remotes/origin/main"]);
        const previewRes = await dispatchAsync(ctx.userDataPath, "update.trackedBranchPreview", ctx.localRepo, {});
        expect(previewRes.ok).toBe(true);
        expect((previewRes.data?.issues || []).some((issue: any) => issue.issueCode === "remote-missing")).toBe(false);
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 120_000 },
  );

  it(
    "全部 detached HEAD 时应直接报告无可更新 root",
    async () => {
      const ctx = await createTrackedClonePairAsync("all-detached");
      try {
        await gitAsync(ctx.localRepo, ["checkout", "--detach"]);
        const res = await dispatchAsync(ctx.userDataPath, "flow.pull", ctx.localRepo, {});
        expect(res.ok).toBe(false);
        const detachedRoot = (res.data?.roots || []).find((root: any) => root.failureCode === "detached-head");
        expect(detachedRoot?.resultCode).toBe("NOT_READY");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 90_000 },
  );

  it(
    "Detached HEAD 不应再进入 tracked branch 修复对话框主路径",
    async () => {
      const ctx = await createTrackedClonePairAsync("detached-repair");
      try {
        await gitAsync(ctx.localRepo, ["checkout", "--detach"]);
        const previewRes = await dispatchAsync(ctx.userDataPath, "update.trackedBranchPreview", ctx.localRepo, {});
        expect(previewRes.ok).toBe(true);
        expect(previewRes.data?.issues || []).toHaveLength(0);
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 90_000 },
  );

  it(
    "Detached HEAD 直接应用 tracked branch 修复时应返回错误",
    async () => {
      const ctx = await createTrackedClonePairAsync("detached-invalid-branch");
      try {
        await gitAsync(ctx.localRepo, ["checkout", "--detach"]);
        const applyRes = await dispatchAsync(ctx.userDataPath, "update.trackedBranchApply", ctx.localRepo, {
          updateMethod: "merge",
          selections: [{
            repoRoot: ctx.localRepo,
            remote: "origin",
            remoteBranch: "main",
            setAsTracked: true,
          }],
        });
        expect(applyRes.ok).toBe(false);
        expect(String(applyRes.error || "")).toContain("Detached HEAD");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 90_000 },
  );

  it(
    "Detached 子模块应由父仓递归更新，而 on-branch 子模块应作为独立 root 更新",
    async () => {
      const detachedCtx = await createSubmoduleWorkspaceAsync("detached");
      const onBranchCtx = await createSubmoduleWorkspaceAsync("on-branch");
      try {
        const detachedNewCommit = await writeAndCommitAsync(detachedCtx.subUpdaterRepo, "lib.txt", "submodule detached update\n", "sub: detached update");
        await gitAsync(detachedCtx.subUpdaterRepo, ["push"]);
        await gitAsync(path.join(detachedCtx.parentOtherRepo, "modules", "lib"), ["fetch", "origin"]);
        await gitAsync(path.join(detachedCtx.parentOtherRepo, "modules", "lib"), ["checkout", detachedNewCommit]);
        await gitAsync(detachedCtx.parentOtherRepo, ["add", "modules/lib"]);
        await gitAsync(detachedCtx.parentOtherRepo, ["commit", "-m", "parent: bump submodule"]);
        await gitAsync(detachedCtx.parentOtherRepo, ["push"]);

        const detachedRes = await dispatchAsync(detachedCtx.userDataPath, "flow.pull", detachedCtx.parentLocalRepo, {});
        expect(detachedRes.ok).toBe(true);
        const detachedRoot = (detachedRes.data?.roots || []).find((root: any) => root.repoRoot.endsWith(path.join("modules", "lib")));
        expect(detachedRoot?.submoduleUpdate?.mode).toBe("detached");
        expect(detachedRoot?.ok).toBe(true);
        expect((await gitAsync(path.join(detachedCtx.parentLocalRepo, "modules", "lib"), ["rev-parse", "HEAD"])).trim()).toBe(detachedNewCommit);

        await gitAsync(path.join(onBranchCtx.parentLocalRepo, "modules", "lib"), ["switch", "main"]);
        const onBranchNewCommit = await writeAndCommitAsync(onBranchCtx.subUpdaterRepo, "lib.txt", "submodule branch update\n", "sub: on-branch update");
        await gitAsync(onBranchCtx.subUpdaterRepo, ["push"]);

        const onBranchRes = await dispatchAsync(onBranchCtx.userDataPath, "flow.pull", onBranchCtx.parentLocalRepo, {});
        expect(onBranchRes.ok).toBe(true);
        const onBranchRoot = (onBranchRes.data?.roots || []).find((root: any) => root.repoRoot.endsWith(path.join("modules", "lib")));
        expect(onBranchRoot?.ok).toBe(true);
        expect((await gitAsync(path.join(onBranchCtx.parentLocalRepo, "modules", "lib"), ["rev-parse", "HEAD"])).trim()).toBe(onBranchNewCommit);
      } finally {
        await cleanupAsync([...detachedCtx.cleanupPaths, ...onBranchCtx.cleanupPaths]);
      }
    },
    { timeout: 240_000 },
  );

  it(
    "push rejected 不应再由主进程黑盒自动更新，而应返回结构化决策流",
    async () => {
      const ctx = await createTrackedClonePairAsync("push-rejected");
      try {
        await writeAndCommitAsync(ctx.otherRepo, "remote.txt", "remote first\n", "remote: first");
        await gitAsync(ctx.otherRepo, ["push"]);
        await writeAndCommitAsync(ctx.localRepo, "local.txt", "local first\n", "local: first");

        const pushRes = await dispatchGitFeatureAction({
          action: "push.execute",
          payload: {
            repoPath: ctx.localRepo,
            updateIfRejected: true,
          },
          userDataPath: ctx.userDataPath,
        });
        expect(pushRes.ok).toBe(false);
        expect(pushRes.data?.pushRejected?.type).toBe("no-fast-forward");
        expect(pushRes.data?.pushRejected?.actions?.map((action: any) => action.kind)).toEqual([
          "update-with-merge",
          "update-with-rebase",
          "force-with-lease",
          "cancel",
        ]);
        const headSubject = (await gitAsync(ctx.localRepo, ["log", "--format=%s", "-1"])).trim();
        expect(headSubject).toBe("local: first");
      } finally {
        await cleanupAsync(ctx.cleanupPaths);
      }
    },
    { timeout: 120_000 },
  );
});
