import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { execGitAsync } from "./exec";
import { dispatchGitFeatureAction } from "./featureService";
import { DEFAULT_CHANGE_LIST_ID } from "./changelists";

/**
 * 在指定仓库执行 Git 命令，失败时抛出带 stderr 的断言，便于快速定位测试问题。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 20_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 创建一个带默认用户信息的临时 Git 仓库。
 */
async function createRepoAsync(prefix: string): Promise<string> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  await gitAsync(repo, ["init"]);
  await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);
  await gitAsync(repo, ["config", "core.autocrlf", "false"]);
  await gitAsync(repo, ["config", "core.eol", "lf"]);
  return repo;
}

/**
 * 统一把路径断言规整为 `/` 分隔，避免 Windows/Posix 展示差异导致的伪失败。
 */
function normalizePathForAssert(value: string): string {
  return String(value || "").replace(/\\/g, "/");
}

/**
 * 创建一个已配置 origin/upstream 的临时仓库，供 commit-and-push 集成测试复用。
 */
async function createRepoWithRemoteAsync(prefix: string): Promise<{
  repo: string;
  remoteRoot: string;
  defaultBranch: string;
}> {
  const repo = await createRepoAsync(prefix);
  const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}remote-`));
  await gitAsync(remoteRoot, ["init", "--bare"]);
  await fsp.writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
  await gitAsync(repo, ["add", "base.txt"]);
  await gitAsync(repo, ["commit", "-m", "init"]);
  await gitAsync(repo, ["remote", "add", "origin", remoteRoot]);
  const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";
  await gitAsync(repo, ["push", "-u", "origin", defaultBranch]);
  return {
    repo,
    remoteRoot,
    defaultBranch,
  };
}

describe("commit panel integration", () => {
  it(
    "worktree 发生 merge 冲突时，status.get 与 conflictResolver.get 应仍按独立仓根返回冲突状态",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const worktreeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-wt-"));
      const worktreePath = path.join(worktreeRoot, "wt1");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const conflictPath = path.join(repo, "conflict.txt");
        await fsp.writeFile(conflictPath, "base\n", "utf8");
        await gitAsync(repo, ["add", "conflict.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/worktree-conflict"]);
        await fsp.writeFile(conflictPath, "feature\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(conflictPath, "main\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        await gitAsync(repo, ["worktree", "add", "-b", "wt/worktree-conflict", worktreePath, defaultBranch]);

        const mergeRes = await execGitAsync({
          argv: ["-C", worktreePath, "merge", "feature/worktree-conflict"],
          timeoutMs: 20_000,
        });
        expect(mergeRes.ok).toBe(false);
        expect(`${mergeRes.stdout}\n${mergeRes.stderr}`.toLowerCase()).toContain("conflict");

        const statusRes = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: worktreePath },
          userDataPath,
        });
        expect(statusRes.ok).toBe(true);
        expect(normalizePathForAssert(statusRes.data?.repoRoot || "")).toBe(normalizePathForAssert(worktreePath));
        expect(statusRes.data?.operationState).toBe("merging");
        expect(statusRes.data?.entries?.find((entry: { path: string }) => entry.path === "conflict.txt")?.conflictState).toBe("conflict");

        const resolverRes = await dispatchGitFeatureAction({
          action: "changes.conflictResolver.get",
          payload: { repoPath: worktreePath, paths: ["conflict.txt"] },
          userDataPath,
        });
        expect(resolverRes.ok).toBe(true);
        expect(resolverRes.data?.unresolvedCount).toBe(1);
        expect(resolverRes.data?.unresolvedEntries?.[0]?.path).toBe("conflict.txt");
        expect(resolverRes.data?.unresolvedEntries?.[0]?.canOpenMerge).toBe(true);
      } finally {
        try { await execGitAsync({ argv: ["-C", worktreePath, "merge", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await execGitAsync({ argv: ["-C", repo, "worktree", "remove", "--force", worktreePath], timeoutMs: 20_000 }); } catch {}
        try { await fsp.rm(worktreeRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "创建 changelist 后应可见、可设为活动列表且重复名被拒绝",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "a.txt"), "a\n", "utf8");
        await gitAsync(repo, ["add", "a.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        await fsp.writeFile(path.join(repo, "a.txt"), "b\n", "utf8");

        const created = await dispatchGitFeatureAction({
          action: "changelist.create",
          payload: { repoPath: repo, name: "功能A" },
          userDataPath,
        });
        expect(created.ok).toBe(true);
        expect(created.data?.activeListId).toBe(DEFAULT_CHANGE_LIST_ID);

        const activated = await dispatchGitFeatureAction({
          action: "changelist.setActive",
          payload: { repoPath: repo, id: created.data?.id },
          userDataPath,
        });
        expect(activated.ok).toBe(true);
        expect(activated.data?.activeListId).toBe(created.data?.id);

        const duplicate = await dispatchGitFeatureAction({
          action: "changelist.create",
          payload: { repoPath: repo, name: "功能A" },
          userDataPath,
        });
        expect(duplicate.ok).toBe(false);
        expect(String(duplicate.error || "")).toContain("已存在同名更改列表");

        const status = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(status.ok).toBe(true);
        expect(status.data?.changeLists?.activeListId).toBe(created.data?.id);
        expect(status.data?.changeLists?.lists?.map((item: { name: string }) => item.name)).toContain("功能A");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "ignored 开关应走独立链路，status.get 不返回 ignored，status.getIgnored 单独返回 ignored 节点",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, ".gitignore"), "dist/\n", "utf8");
        await fsp.writeFile(path.join(repo, "tracked.txt"), "init\n", "utf8");
        await gitAsync(repo, ["add", ".gitignore", "tracked.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        await fsp.mkdir(path.join(repo, "dist"), { recursive: true });
        await fsp.writeFile(path.join(repo, "dist", "cache.txt"), "cached\n", "utf8");
        await fsp.writeFile(path.join(repo, "tracked.txt"), "changed\n", "utf8");

        const status = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(status.ok).toBe(true);
        expect(status.data?.entries?.map((item: { path: string }) => item.path)).toContain("tracked.txt");
        expect(status.data?.entries?.map((item: { path: string }) => item.path)).not.toContain("dist/cache.txt");

        const ignored = await dispatchGitFeatureAction({
          action: "status.getIgnored",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(ignored.ok).toBe(true);
        expect(ignored.data?.entries?.map((item: { path: string }) => item.path)).toContain("dist/cache.txt");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "status.get 应返回默认提交作者，供前端提交检查直接复用",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "author.txt"), "author\n", "utf8");
        await gitAsync(repo, ["add", "author.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        await fsp.writeFile(path.join(repo, "author.txt"), "author changed\n", "utf8");

        const status = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(status.ok).toBe(true);
        expect(status.data?.defaultCommitAuthor).toBe("CodexFlow <codexflow@example.com>");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "status.get 应展开未跟踪目录为文件条目",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "tracked.txt"), "init\n", "utf8");
        await gitAsync(repo, ["add", "tracked.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        await fsp.mkdir(path.join(repo, ".idea"), { recursive: true });
        await fsp.writeFile(path.join(repo, ".idea", "workspace.xml"), "<project />\n", "utf8");

        const status = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(status.ok).toBe(true);
        const paths = (status.data?.entries || []).map((item: { path: string }) => normalizePathForAssert(item.path));
        expect(paths).toContain(".idea/workspace.xml");
        expect(paths).not.toContain(".idea");
        expect(paths).not.toContain(".idea/");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "status.get 应返回 stash pathspec 能力布尔值，供 Stage Stash enablement 直接复用",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "tracked.txt"), "init\n", "utf8");
        await gitAsync(repo, ["add", "tracked.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        await fsp.writeFile(path.join(repo, "tracked.txt"), "changed\n", "utf8");

        const status = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(status.ok).toBe(true);
        expect(typeof status.data?.stashPushPathspecSupported).toBe("boolean");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "ignored special node 的 ignore 目标预览与写入应对齐上游语义",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "tracked.txt"), "init\n", "utf8");
        await gitAsync(repo, ["add", "tracked.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        await fsp.mkdir(path.join(repo, "build"), { recursive: true });
        await fsp.writeFile(path.join(repo, "build", "cache.log"), "temp\n", "utf8");

        const preview = await dispatchGitFeatureAction({
          action: "changes.ignoreTargets",
          payload: { repoPath: repo, paths: ["build/cache.log"] },
          userDataPath,
        });
        expect(preview.ok).toBe(true);
        expect(preview.data?.targets?.some((item: { kind: string }) => item.kind === "create-ignore-file")).toBe(true);
        expect(preview.data?.targets?.some((item: { kind: string }) => item.kind === "git-exclude")).toBe(true);

        const gitExcludeTarget = preview.data?.targets?.find((item: { kind: string }) => item.kind === "git-exclude");
        expect(gitExcludeTarget).toBeTruthy();

        const ignored = await dispatchGitFeatureAction({
          action: "changes.ignore",
          payload: {
            repoPath: repo,
            paths: ["build/cache.log"],
            target: gitExcludeTarget,
          },
          userDataPath,
        });
        expect(ignored.ok).toBe(true);
        expect(ignored.data?.addedCount).toBe(1);

        const status = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(status.ok).toBe(true);
        expect(status.data?.entries?.map((item: { path: string }) => item.path)).not.toContain("build/cache.log");

        const ignoredStatus = await dispatchGitFeatureAction({
          action: "status.getIgnored",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(ignoredStatus.ok).toBe(true);
        expect(ignoredStatus.data?.entries?.map((item: { path: string }) => item.path)).toContain("build/cache.log");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "status.get 应返回 module grouping 元数据与可用 key 集",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "package.json"), JSON.stringify({
          name: "root-app",
          private: true,
          workspaces: ["packages/*"],
        }, null, 2), "utf8");
        await fsp.mkdir(path.join(repo, "packages", "app"), { recursive: true });
        await fsp.writeFile(path.join(repo, "packages", "app", "package.json"), JSON.stringify({
          name: "@repo/app",
        }, null, 2), "utf8");
        await fsp.writeFile(path.join(repo, "packages", "app", "index.ts"), "export const value = 1;\n", "utf8");
        await gitAsync(repo, ["add", "package.json", "packages/app/package.json", "packages/app/index.ts"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        await fsp.writeFile(path.join(repo, "packages", "app", "index.ts"), "export const value = 2;\n", "utf8");

        const status = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(status.ok).toBe(true);
        expect(status.data?.viewOptions?.availableGroupingKeys).toContain("module");
        const changedEntry = status.data?.entries?.find((item: { path: string }) => item.path === "packages/app/index.ts");
        expect(changedEntry?.moduleId).toBe("packages/app");
        expect(changedEntry?.moduleName).toBe("@repo/app");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "status.get 应跳过当前仓库不可用的 grouping key，避免恢复脏持久化值",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "tracked.txt"), "init\n", "utf8");
        await gitAsync(repo, ["add", "tracked.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        await fsp.writeFile(path.join(repo, "tracked.txt"), "changed\n", "utf8");

        const stored = await dispatchGitFeatureAction({
          action: "changesView.setGroupingKeys",
          payload: { repoPath: repo, groupingKeys: ["directory", "module", "repository"] },
          userDataPath,
        });
        expect(stored.ok).toBe(true);

        const status = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(status.ok).toBe(true);
        expect(status.data?.viewOptions?.availableGroupingKeys).toEqual(["directory"]);
        expect(status.data?.viewOptions?.groupingKeys).toEqual(["directory"]);
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "view/localChanges 更新后，status.get 应返回最新平台快照，并在 staging mode 下阻止 changelist 操作",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const peerRepo = await createRepoAsync("codexflow-commit-panel-peer-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "tracked.txt"), "init\n", "utf8");
        await gitAsync(repo, ["add", "tracked.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        await fsp.writeFile(path.join(repo, "tracked.txt"), "changed\n", "utf8");
        await fsp.writeFile(path.join(peerRepo, "peer.txt"), "peer\n", "utf8");
        await gitAsync(peerRepo, ["add", "peer.txt"]);
        await gitAsync(peerRepo, ["commit", "-m", "init"]);

        const updatedViewOption = await dispatchGitFeatureAction({
          action: "changesView.setOption",
          payload: { repoPath: repo, key: "detailsPreviewShown", value: false },
          userDataPath,
        });
        expect(updatedViewOption.ok).toBe(true);
        expect(updatedViewOption.data?.viewOptions?.detailsPreviewShown).toBe(false);

        const updatedOpenMode = await dispatchGitFeatureAction({
          action: "changesView.setOption",
          payload: { repoPath: repo, key: "diffPreviewOnDoubleClickOrEnter", value: false },
          userDataPath,
        });
        expect(updatedOpenMode.ok).toBe(true);
        expect(updatedOpenMode.data?.viewOptions?.diffPreviewOnDoubleClickOrEnter).toBe(false);

        const updatedShowIgnored = await dispatchGitFeatureAction({
          action: "changesView.setOption",
          payload: { repoPath: repo, key: "showIgnored", value: true },
          userDataPath,
        });
        expect(updatedShowIgnored.ok).toBe(true);
        expect(updatedShowIgnored.data?.viewOptions?.showIgnored).toBe(true);

        const updatedGroupingKeys = await dispatchGitFeatureAction({
          action: "changesView.setGroupingKeys",
          payload: { repoPath: repo, groupingKeys: ["directory", "repository"] },
          userDataPath,
        });
        expect(updatedGroupingKeys.ok).toBe(true);
        expect(updatedGroupingKeys.data?.viewOptions?.groupingKeys).toEqual(["directory", "repository"]);

        const enableStaging = await dispatchGitFeatureAction({
          action: "localChanges.setOption",
          payload: { repoPath: repo, key: "stagingAreaEnabled", value: true },
          userDataPath,
        });
        expect(enableStaging.ok).toBe(true);
        expect(enableStaging.data?.localChanges).toEqual({
          stagingAreaEnabled: true,
          changeListsEnabled: false,
          commitAllEnabled: true,
        });

        const disableCommitAll = await dispatchGitFeatureAction({
          action: "localChanges.setOption",
          payload: { repoPath: repo, key: "commitAllEnabled", value: false },
          userDataPath,
        });
        expect(disableCommitAll.ok).toBe(true);
        expect(disableCommitAll.data?.localChanges).toEqual({
          stagingAreaEnabled: true,
          changeListsEnabled: false,
          commitAllEnabled: false,
        });

        const blockedCreate = await dispatchGitFeatureAction({
          action: "changelist.create",
          payload: { repoPath: repo, name: "功能A" },
          userDataPath,
        });
        expect(blockedCreate.ok).toBe(false);
        expect(String(blockedCreate.error || "")).toContain("暂存区域模式下不支持更改列表操作");

        const stagingStatus = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(stagingStatus.ok).toBe(true);
        expect(stagingStatus.data?.viewOptions?.detailsPreviewShown).toBe(false);
        expect(stagingStatus.data?.viewOptions?.diffPreviewOnDoubleClickOrEnter).toBe(false);
        expect(stagingStatus.data?.viewOptions?.availableGroupingKeys).toEqual(["directory"]);
        expect(stagingStatus.data?.viewOptions?.groupingKeys).toEqual(["directory"]);
        expect(stagingStatus.data?.viewOptions?.showIgnored).toBe(true);
        expect(stagingStatus.data?.localChanges).toEqual({
          stagingAreaEnabled: true,
          changeListsEnabled: false,
          commitAllEnabled: false,
        });
        expect(stagingStatus.data?.changeLists?.lists?.map((item: { name: string }) => item.name)).toContain("默认");

        const peerStatus = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: peerRepo },
          userDataPath,
        });
        expect(peerStatus.ok).toBe(true);
        expect(peerStatus.data?.viewOptions?.detailsPreviewShown).toBe(false);
        expect(peerStatus.data?.viewOptions?.diffPreviewOnDoubleClickOrEnter).toBe(false);
        expect(peerStatus.data?.viewOptions?.showIgnored).toBe(false);
        expect(peerStatus.data?.localChanges).toEqual({
          stagingAreaEnabled: true,
          changeListsEnabled: false,
          commitAllEnabled: false,
        });

        const enableCommitAll = await dispatchGitFeatureAction({
          action: "localChanges.setOption",
          payload: { repoPath: repo, key: "commitAllEnabled", value: true },
          userDataPath,
        });
        expect(enableCommitAll.ok).toBe(true);
        expect(enableCommitAll.data?.localChanges).toEqual({
          stagingAreaEnabled: true,
          changeListsEnabled: false,
          commitAllEnabled: true,
        });

        const enableChangeLists = await dispatchGitFeatureAction({
          action: "localChanges.setOption",
          payload: { repoPath: repo, key: "changeListsEnabled", value: true },
          userDataPath,
        });
        expect(enableChangeLists.ok).toBe(true);
        expect(enableChangeLists.data?.localChanges).toEqual({
          stagingAreaEnabled: false,
          changeListsEnabled: true,
          commitAllEnabled: true,
        });

        const created = await dispatchGitFeatureAction({
          action: "changelist.create",
          payload: { repoPath: repo, name: "功能A", setActive: true },
          userDataPath,
        });
        expect(created.ok).toBe(true);
        expect(created.data?.activeListId).toBe(created.data?.id);

        const changelistStatus = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(changelistStatus.ok).toBe(true);
        expect(changelistStatus.data?.localChanges).toEqual({
          stagingAreaEnabled: false,
          changeListsEnabled: true,
          commitAllEnabled: true,
        });
        expect(changelistStatus.data?.changeLists?.activeListId).toBe(created.data?.id);
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(peerRepo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "changelist 的重命名、切换、移动与删除动作应继续按平台链路工作",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "a.txt"), "a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "b\n", "utf8");
        await gitAsync(repo, ["add", "a.txt", "b.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        await fsp.writeFile(path.join(repo, "a.txt"), "a changed\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "b changed\n", "utf8");

        const first = await dispatchGitFeatureAction({
          action: "changelist.create",
          payload: { repoPath: repo, name: "功能A" },
          userDataPath,
        });
        expect(first.ok).toBe(true);
        const firstListId = String(first.data?.id || "");

        const second = await dispatchGitFeatureAction({
          action: "changelist.create",
          payload: { repoPath: repo, name: "功能B" },
          userDataPath,
        });
        expect(second.ok).toBe(true);
        const secondListId = String(second.data?.id || "");

        const renamed = await dispatchGitFeatureAction({
          action: "changelist.rename",
          payload: { repoPath: repo, id: firstListId, name: "功能A-已重命名" },
          userDataPath,
        });
        expect(renamed.ok).toBe(true);
        expect(renamed.data?.name).toBe("功能A-已重命名");

        const setActive = await dispatchGitFeatureAction({
          action: "changelist.setActive",
          payload: { repoPath: repo, id: secondListId },
          userDataPath,
        });
        expect(setActive.ok).toBe(true);
        expect(setActive.data?.activeListId).toBe(secondListId);

        const moved = await dispatchGitFeatureAction({
          action: "changelist.moveFiles",
          payload: {
            repoPath: repo,
            paths: ["a.txt"],
            targetListId: firstListId,
          },
          userDataPath,
        });
        expect(moved.ok).toBe(true);
        expect(moved.data?.moved).toBe(1);

        const movedStatus = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(movedStatus.ok).toBe(true);
        const listNames = movedStatus.data?.changeLists?.lists?.map((item: { name: string }) => item.name) || [];
        expect(listNames).toContain("功能A-已重命名");
        const entryA = movedStatus.data?.entries?.find((item: { path: string }) => item.path === "a.txt");
        const entryB = movedStatus.data?.entries?.find((item: { path: string }) => item.path === "b.txt");
        expect(entryA?.changeListId).toBe(firstListId);
        expect(entryB?.changeListId).toBe(secondListId);
        expect(movedStatus.data?.changeLists?.activeListId).toBe(secondListId);

        const deleted = await dispatchGitFeatureAction({
          action: "changelist.delete",
          payload: { repoPath: repo, id: firstListId, targetListId: secondListId },
          userDataPath,
        });
        expect(deleted.ok).toBe(true);
        expect(deleted.data?.movedToListId).toBe(secondListId);

        const deletedStatus = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(deletedStatus.ok).toBe(true);
        expect(deletedStatus.data?.changeLists?.lists?.map((item: { id: string }) => item.id)).not.toContain(firstListId);
        expect(deletedStatus.data?.changeLists?.activeListId).toBe(secondListId);
        const entryAfterDelete = deletedStatus.data?.entries?.find((item: { path: string }) => item.path === "a.txt");
        expect(entryAfterDelete?.changeListId).toBe(secondListId);
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "merge 冲突解决并加入索引后，status.get 应把文件标记为 resolved conflict",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const conflictPath = path.join(repo, "conflict.txt");
        await fsp.writeFile(conflictPath, "base\n", "utf8");
        await gitAsync(repo, ["add", "conflict.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/conflict"]);
        await fsp.writeFile(conflictPath, "feature\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(conflictPath, "main\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        const mergeRes = await execGitAsync({
          argv: ["-C", repo, "merge", "feature/conflict"],
          timeoutMs: 20_000,
        });
        expect(mergeRes.ok).toBe(false);
        expect(`${mergeRes.stdout}\n${mergeRes.stderr}`.toLowerCase()).toContain("conflict");

        const unresolvedStatus = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(unresolvedStatus.ok).toBe(true);
        const unresolvedEntry = unresolvedStatus.data?.entries?.find((item: { path: string }) => item.path === "conflict.txt");
        expect(unresolvedEntry?.conflictState).toBe("conflict");
        expect(unresolvedEntry?.statusText).toBe("冲突");

        await fsp.writeFile(conflictPath, "resolved\n", "utf8");
        await gitAsync(repo, ["add", "conflict.txt"]);

        const resolvedStatus = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(resolvedStatus.ok).toBe(true);
        const resolvedEntry = resolvedStatus.data?.entries?.find((item: { path: string }) => item.path === "conflict.txt");
        expect(resolvedEntry?.conflictState).toBe("resolved");
        expect(resolvedEntry?.statusText).toBe("已解决冲突");
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "merge", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "resolved unchanged conflict 即使已不再出现在 porcelain 结果里，也应注入提交树状态",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const conflictPath = path.join(repo, "conflict.txt");
        await fsp.writeFile(conflictPath, "base\n", "utf8");
        await gitAsync(repo, ["add", "conflict.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/conflict"]);
        await fsp.writeFile(conflictPath, "feature\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(conflictPath, "main\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        const mergeRes = await execGitAsync({
          argv: ["-C", repo, "merge", "feature/conflict"],
          timeoutMs: 20_000,
        });
        expect(mergeRes.ok).toBe(false);

        await fsp.writeFile(conflictPath, "main\n", "utf8");
        await gitAsync(repo, ["add", "conflict.txt"]);

        const porcelain = await execGitAsync({
          argv: ["-C", repo, "status", "--porcelain=v2", "-z"],
          timeoutMs: 12_000,
        });
        expect(porcelain.ok).toBe(true);
        expect(String(porcelain.stdout || "")).not.toContain("conflict.txt");

        const resolvedStatus = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(resolvedStatus.ok).toBe(true);
        const resolvedEntry = resolvedStatus.data?.entries?.find((item: { path: string }) => item.path === "conflict.txt");
        expect(resolvedEntry?.conflictState).toBe("resolved");
        expect(resolvedEntry?.statusText).toBe("已解决冲突");
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "merge", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "merge 过程中普通 staged/unstaged 文件不应被误标为 resolved conflict",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "conflict.txt"), "base\n", "utf8");
        await fsp.writeFile(path.join(repo, "regular.txt"), "regular\n", "utf8");
        await gitAsync(repo, ["add", "conflict.txt", "regular.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/conflict"]);
        await fsp.writeFile(path.join(repo, "conflict.txt"), "feature\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "conflict.txt"), "main\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        const mergeRes = await execGitAsync({
          argv: ["-C", repo, "merge", "feature/conflict"],
          timeoutMs: 20_000,
        });
        expect(mergeRes.ok).toBe(false);

        await fsp.writeFile(path.join(repo, "conflict.txt"), "resolved\n", "utf8");
        await gitAsync(repo, ["add", "conflict.txt"]);
        await fsp.writeFile(path.join(repo, "regular.txt"), "regular changed\n", "utf8");

        const status = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(status.ok).toBe(true);

        const resolvedEntry = status.data?.entries?.find((item: { path: string }) => item.path === "conflict.txt");
        const regularEntry = status.data?.entries?.find((item: { path: string }) => item.path === "regular.txt");
        expect(resolvedEntry?.conflictState).toBe("resolved");
        expect(regularEntry?.conflictState).toBeUndefined();
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "merge", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "merge --abort 后 resolved conflict 状态不应残留",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "conflict.txt"), "base\n", "utf8");
        await gitAsync(repo, ["add", "conflict.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/conflict"]);
        await fsp.writeFile(path.join(repo, "conflict.txt"), "feature\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "conflict.txt"), "main\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        const mergeRes = await execGitAsync({
          argv: ["-C", repo, "merge", "feature/conflict"],
          timeoutMs: 20_000,
        });
        expect(mergeRes.ok).toBe(false);

        await fsp.writeFile(path.join(repo, "conflict.txt"), "resolved\n", "utf8");
        await gitAsync(repo, ["add", "conflict.txt"]);

        const resolvedStatus = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(resolvedStatus.ok).toBe(true);
        expect(resolvedStatus.data?.entries?.find((item: { path: string }) => item.path === "conflict.txt")?.conflictState).toBe("resolved");

        await gitAsync(repo, ["merge", "--abort"]);

        const abortedStatus = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(abortedStatus.ok).toBe(true);
        expect(abortedStatus.data?.entries?.find((item: { path: string }) => item.path === "conflict.txt")).toBeUndefined();
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "changes.conflictMerge.get 应返回 base/ours/theirs/working 四份冲突快照",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "conflict.txt"), "base\n", "utf8");
        await gitAsync(repo, ["add", "conflict.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/conflict"]);
        await fsp.writeFile(path.join(repo, "conflict.txt"), "feature\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "conflict.txt"), "main\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        const mergeRes = await execGitAsync({
          argv: ["-C", repo, "merge", "feature/conflict"],
          timeoutMs: 20_000,
        });
        expect(mergeRes.ok).toBe(false);

        const snapshot = await dispatchGitFeatureAction({
          action: "changes.conflictMerge.get",
          payload: { repoPath: repo, path: "conflict.txt" },
          userDataPath,
        });
        expect(snapshot.ok).toBe(true);
        expect(snapshot.data?.path).toBe("conflict.txt");
        expect(snapshot.data?.base?.text).toBe("base\n");
        expect(snapshot.data?.ours?.text).toBe("main\n");
        expect(snapshot.data?.theirs?.text).toBe("feature\n");
        expect(String(snapshot.data?.working?.text || "")).toContain("<<<<<<<");
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "merge", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "changes.conflictMerge.get 遇到超大文本冲突时应直接拒绝应用内合并，避免进入重型 metadata 构建",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const largeConflictText = Array.from({ length: 20_001 }, (_, index) => `line-${index}`).join("\n");
        await fsp.writeFile(path.join(repo, "conflict.txt"), `base\n${largeConflictText}\n`, "utf8");
        await gitAsync(repo, ["add", "conflict.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/large-conflict"]);
        await fsp.writeFile(path.join(repo, "conflict.txt"), `feature\n${largeConflictText}\n`, "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "conflict.txt"), `main\n${largeConflictText}\n`, "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        const mergeRes = await execGitAsync({
          argv: ["-C", repo, "merge", "feature/large-conflict"],
          timeoutMs: 20_000,
        });
        expect(mergeRes.ok).toBe(false);

        const snapshot = await dispatchGitFeatureAction({
          action: "changes.conflictMerge.get",
          payload: { repoPath: repo, path: "conflict.txt" },
          userDataPath,
        });
        expect(snapshot.ok).toBe(false);
        expect(String(snapshot.error || "")).toContain("无法在应用内合并");
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "merge", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "rebase 冲突时 changes.conflictMerge.get 应按上游语义反转 ours/theirs 标签",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "conflict.txt"), "base\n", "utf8");
        await gitAsync(repo, ["add", "conflict.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/rebase-conflict"]);
        await fsp.writeFile(path.join(repo, "conflict.txt"), "feature\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "conflict.txt"), "main\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        await gitAsync(repo, ["checkout", "feature/rebase-conflict"]);
        const rebaseRes = await execGitAsync({
          argv: ["-C", repo, "rebase", defaultBranch],
          timeoutMs: 20_000,
        });
        expect(rebaseRes.ok).toBe(false);

        const snapshot = await dispatchGitFeatureAction({
          action: "changes.conflictMerge.get",
          payload: { repoPath: repo, path: "conflict.txt" },
          userDataPath,
        });
        expect(snapshot.ok).toBe(true);
        expect(snapshot.data?.reverseSides).toBe(true);
        expect(snapshot.data?.base?.text).toBe("base\n");
        expect(snapshot.data?.ours?.text).toBe("main\n");
        expect(snapshot.data?.theirs?.text).toBe("feature\n");
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "rebase", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "changes.conflictResolver.get 应返回批量 resolver 所需的 binary 与 sides 元数据",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "text.txt"), "base\n", "utf8");
        await fsp.writeFile(path.join(repo, "bin.dat"), Buffer.from([0, 1, 2, 3]));
        await gitAsync(repo, ["add", "text.txt", "bin.dat"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/conflict-resolver"]);
        await fsp.writeFile(path.join(repo, "text.txt"), "feature\n", "utf8");
        await fsp.writeFile(path.join(repo, "bin.dat"), Buffer.from([0, 9, 9, 9]));
        await gitAsync(repo, ["add", "text.txt", "bin.dat"]);
        await gitAsync(repo, ["commit", "-m", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "text.txt"), "main\n", "utf8");
        await fsp.writeFile(path.join(repo, "bin.dat"), Buffer.from([0, 8, 8, 8]));
        await gitAsync(repo, ["add", "text.txt", "bin.dat"]);
        await gitAsync(repo, ["commit", "-m", "main change"]);

        const mergeRes = await execGitAsync({
          argv: ["-C", repo, "merge", "feature/conflict-resolver"],
          timeoutMs: 20_000,
        });
        expect(mergeRes.ok).toBe(false);

        const resolverRes = await dispatchGitFeatureAction({
          action: "changes.conflictResolver.get",
          payload: { repoPath: repo, paths: ["text.txt", "bin.dat"] },
          userDataPath,
        });

        expect(resolverRes.ok).toBe(true);
        expect(resolverRes.data?.unresolvedEntries?.find((entry: { path: string }) => entry.path === "text.txt")?.canOpenMerge).toBe(true);
        expect(resolverRes.data?.unresolvedEntries?.find((entry: { path: string }) => entry.path === "bin.dat")?.canOpenMerge).toBe(false);
        expect(resolverRes.data?.unresolvedEntries?.find((entry: { path: string }) => entry.path === "bin.dat")?.ours?.isBinary).toBe(true);
        expect(resolverRes.data?.resolvedHolder?.source).toBe("resolve-undo");
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "merge", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "changes.conflictResolver.apply 应支持批量采用 ours 并把冲突标记为 resolved",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "a.txt"), "base-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "base-b\n", "utf8");
        await gitAsync(repo, ["add", "a.txt", "b.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/conflict-batch"]);
        await fsp.writeFile(path.join(repo, "a.txt"), "feature-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "feature-b\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "a.txt"), "main-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "main-b\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        const mergeRes = await execGitAsync({
          argv: ["-C", repo, "merge", "feature/conflict-batch"],
          timeoutMs: 20_000,
        });
        expect(mergeRes.ok).toBe(false);

        const applyRes = await dispatchGitFeatureAction({
          action: "changes.conflictResolver.apply",
          payload: { repoPath: repo, paths: ["a.txt", "b.txt"], side: "ours" },
          userDataPath,
        });
        expect(applyRes.ok).toBe(true);
        expect(applyRes.data?.appliedPaths).toEqual(["a.txt", "b.txt"]);

        expect(await fsp.readFile(path.join(repo, "a.txt"), "utf8")).toBe("main-a\n");
        expect(await fsp.readFile(path.join(repo, "b.txt"), "utf8")).toBe("main-b\n");

        const statusRes = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(statusRes.ok).toBe(true);
        expect(statusRes.data?.entries?.find((entry: { path: string }) => entry.path === "a.txt")?.conflictState).toBe("resolved");
        expect(statusRes.data?.entries?.find((entry: { path: string }) => entry.path === "b.txt")?.conflictState).toBe("resolved");
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "merge", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "changes.conflictResolver.get 应通过统一 resolved holder 同时返回 unresolved 与 resolved 条目",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "a.txt"), "base-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "base-b\n", "utf8");
        await gitAsync(repo, ["add", "a.txt", "b.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/conflict-holder"]);
        await fsp.writeFile(path.join(repo, "a.txt"), "feature-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "feature-b\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "a.txt"), "main-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "main-b\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        const mergeRes = await execGitAsync({
          argv: ["-C", repo, "merge", "feature/conflict-holder"],
          timeoutMs: 20_000,
        });
        expect(mergeRes.ok).toBe(false);

        await gitAsync(repo, ["checkout", "--ours", "--", "a.txt"]);
        await gitAsync(repo, ["add", "a.txt"]);

        const resolverRes = await dispatchGitFeatureAction({
          action: "changes.conflictResolver.get",
          payload: { repoPath: repo, paths: ["b.txt"] },
          userDataPath,
        });

        expect(resolverRes.ok).toBe(true);
        expect(resolverRes.data?.unresolvedCount).toBe(1);
        expect(resolverRes.data?.resolvedCount).toBe(1);
        expect(resolverRes.data?.unresolvedEntries?.map((entry: { path: string }) => entry.path)).toEqual(["b.txt"]);
        expect(resolverRes.data?.resolvedEntries?.map((entry: { path: string }) => entry.path)).toEqual(["a.txt"]);
        expect(resolverRes.data?.resolvedHolder?.paths).toContain("a.txt");
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "merge", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "rebase 过程中 resolved conflict 应复用统一 holder，并继续出现在 status.get 中",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "a.txt"), "base-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "base-b\n", "utf8");
        await gitAsync(repo, ["add", "a.txt", "b.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/rebase-resolved-holder"]);
        await fsp.writeFile(path.join(repo, "a.txt"), "feature-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "feature-b\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "a.txt"), "main-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "main-b\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        await gitAsync(repo, ["checkout", "feature/rebase-resolved-holder"]);
        const rebaseRes = await execGitAsync({
          argv: ["-C", repo, "rebase", defaultBranch],
          timeoutMs: 20_000,
        });
        expect(rebaseRes.ok).toBe(false);

        await gitAsync(repo, ["checkout", "--ours", "--", "a.txt"]);
        await gitAsync(repo, ["add", "a.txt"]);

        const statusRes = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });

        expect(statusRes.ok).toBe(true);
        expect(statusRes.data?.operationState).toBe("rebasing");
        expect(statusRes.data?.entries?.find((entry: { path: string }) => entry.path === "a.txt")?.conflictState).toBe("resolved");
        expect(statusRes.data?.entries?.find((entry: { path: string }) => entry.path === "b.txt")?.conflictState).toBe("conflict");
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "rebase", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "cherry-pick 过程中 resolved conflict 应继续保留在 resolver 与 status.get 中",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "a.txt"), "base-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "base-b\n", "utf8");
        await gitAsync(repo, ["add", "a.txt", "b.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/cherry-pick-resolved-holder"]);
        await fsp.writeFile(path.join(repo, "a.txt"), "feature-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "feature-b\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);
        const featureHash = (await gitAsync(repo, ["rev-parse", "HEAD"])).trim();

        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "a.txt"), "main-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "main-b\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);

        const cherryPickRes = await execGitAsync({
          argv: ["-C", repo, "cherry-pick", featureHash],
          timeoutMs: 20_000,
        });
        expect(cherryPickRes.ok).toBe(false);

        await gitAsync(repo, ["checkout", "--ours", "--", "a.txt"]);
        await gitAsync(repo, ["add", "a.txt"]);

        const resolverRes = await dispatchGitFeatureAction({
          action: "changes.conflictResolver.get",
          payload: { repoPath: repo, paths: ["b.txt"] },
          userDataPath,
        });
        expect(resolverRes.ok).toBe(true);
        expect(resolverRes.data?.unresolvedCount).toBe(1);
        expect(resolverRes.data?.resolvedCount).toBe(1);
        expect(resolverRes.data?.resolvedEntries?.map((entry: { path: string }) => entry.path)).toEqual(["a.txt"]);
        expect(resolverRes.data?.unresolvedEntries?.map((entry: { path: string }) => entry.path)).toEqual(["b.txt"]);

        const statusRes = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(statusRes.ok).toBe(true);
        expect(statusRes.data?.operationState).toBe("grafting");
        expect(statusRes.data?.entries?.find((entry: { path: string }) => entry.path === "a.txt")?.conflictState).toBe("resolved");
        expect(statusRes.data?.entries?.find((entry: { path: string }) => entry.path === "b.txt")?.conflictState).toBe("conflict");
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "cherry-pick", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "移动 ignored/unversioned 到 changelist 后应自动 add-to-vcs，且 commit.create 不应因 pushAfter 直接绕过 push dialog 执行推送",
    async () => {
      const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-remote-"));
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const remoteRepo = path.join(remoteRoot, "origin.git");
        await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);

        await fsp.writeFile(path.join(repo, ".gitignore"), "dist/\n", "utf8");
        await fsp.writeFile(path.join(repo, "keep.txt"), "init\n", "utf8");
        await fsp.writeFile(path.join(repo, "submit.txt"), "init\n", "utf8");
        await gitAsync(repo, ["add", ".gitignore", "keep.txt", "submit.txt"]);
        await gitAsync(repo, ["commit", "-m", "init"]);
        await gitAsync(repo, ["remote", "add", "origin", remoteRepo]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";
        await gitAsync(repo, ["push", "-u", "origin", defaultBranch]);

        await fsp.writeFile(path.join(repo, "keep.txt"), "keep staged\n", "utf8");
        await fsp.writeFile(path.join(repo, "submit.txt"), "submit staged\n", "utf8");
        await fsp.writeFile(path.join(repo, "new.txt"), "new file\n", "utf8");
        await fsp.mkdir(path.join(repo, "dist"), { recursive: true });
        await fsp.writeFile(path.join(repo, "dist", "cache.txt"), "ignored file\n", "utf8");
        await gitAsync(repo, ["add", "keep.txt", "submit.txt"]);

        const created = await dispatchGitFeatureAction({
          action: "changelist.create",
          payload: { repoPath: repo, name: "交付" },
          userDataPath,
        });
        expect(created.ok).toBe(true);
        const targetListId = String(created.data?.id || "");

        const moved = await dispatchGitFeatureAction({
          action: "changelist.moveFiles",
          payload: {
            repoPath: repo,
            paths: ["new.txt", "dist/cache.txt"],
            targetListId,
          },
          userDataPath,
        });
        expect(moved.ok).toBe(true);
        expect(moved.data?.addedToVcsCount).toBe(2);

        const remoteHeadBefore = (await gitAsync(repo, ["ls-remote", "--heads", "origin", defaultBranch])).trim().split(/\s+/)[0] || "";

        const commit = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "submit selected",
            pushAfter: true,
            includedItems: [
              { path: "submit.txt", kind: "change" },
              { path: "new.txt", kind: "unversioned" },
              { path: "dist/cache.txt", kind: "ignored" },
            ],
          },
          userDataPath,
        });
        expect(commit.ok).toBe(true);
        expect(String(commit.data?.commitHash || "")).toMatch(/^[0-9a-f]{40}$/i);
        expect(String(commit.data?.commitHash || "")).toBe((await gitAsync(repo, ["rev-parse", "HEAD"])).trim());
        expect(commit.data?.pushAfterCommit).toEqual({
          repoRoots: [normalizePathForAssert(repo)],
          commitHashes: [{
            repoRoot: normalizePathForAssert(repo),
            commitHash: String(commit.data?.commitHash || ""),
          }],
          targetHash: String(commit.data?.commitHash || ""),
        });
        expect(commit.data?.postCommitPush).toEqual({
          mode: "preview",
          context: {
            repoRoots: [normalizePathForAssert(repo)],
            commitHashes: [{
              repoRoot: normalizePathForAssert(repo),
              commitHash: String(commit.data?.commitHash || ""),
            }],
            targetHash: String(commit.data?.commitHash || ""),
          },
          protectedTarget: true,
        });

        const cachedNames = (await gitAsync(repo, ["diff", "--cached", "--name-only"])).split(/\r?\n/).filter(Boolean);
        expect(cachedNames).toEqual(["keep.txt"]);
        const remoteHeadAfter = (await gitAsync(repo, ["ls-remote", "--heads", "origin", defaultBranch])).trim().split(/\s+/)[0] || "";
        expect(remoteHeadAfter).toBe(remoteHeadBefore);
      } finally {
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 应按上游 stageForCommit 语义提交被忽略规则覆盖的显式选区",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, ".gitignore"), ".codexflow/packs/\n", "utf8");
        await fsp.writeFile(path.join(repo, "base.txt"), "base\n", "utf8");
        await gitAsync(repo, ["add", ".gitignore", "base.txt"]);
        await gitAsync(repo, ["commit", "-m", "init ignored selection"]);

        await fsp.mkdir(path.join(repo, ".codexflow", "packs"), { recursive: true });
        await fsp.writeFile(path.join(repo, ".codexflow", "packs", "current-ops.yaml"), "name: current\n", "utf8");

        const commit = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "commit ignored explicit selection",
            pushAfter: false,
            includedItems: [
              { path: ".codexflow/packs/current-ops.yaml", kind: "unversioned" },
            ],
          },
          userDataPath,
        });
        expect(commit.ok, String(commit.error || "")).toBe(true);

        const commitFiles = (await gitAsync(repo, ["show", "--name-only", "--format=", "HEAD"])).split(/\r?\n/).filter(Boolean);
        expect(commitFiles).toEqual([".codexflow/packs/current-ops.yaml"]);
        expect(await gitAsync(repo, ["show", "HEAD:.codexflow/packs/current-ops.yaml"])).toBe("name: current\n");
        expect((await gitAsync(repo, ["status", "--porcelain"])).trim()).toBe("");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 在关闭预览偏好后应直接推送，并把 postCommitPush 标记为 pushed",
    async () => {
      const { repo, remoteRoot, defaultBranch } = await createRepoWithRemoteAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "direct-push.txt"), "payload\n", "utf8");

        const savePreferences = await dispatchGitFeatureAction({
          action: "commit.preferences.set",
          payload: {
            repoPath: repo,
            commitAndPush: {
              previewOnCommitAndPush: false,
            },
          },
          userDataPath,
        });
        expect(savePreferences.ok).toBe(true);

        const commit = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "direct push",
            pushAfter: true,
            includedItems: [{ path: "direct-push.txt", kind: "unversioned" }],
          },
          userDataPath,
        });
        expect(commit.ok, String(commit.error || "")).toBe(true);
        expect(commit.data?.pushAfterCommit).toBeUndefined();
        expect(commit.data?.postCommitPush).toEqual(expect.objectContaining({
          mode: "pushed",
        }));

        const remoteHead = (await gitAsync(repo, ["ls-remote", "--heads", "origin", defaultBranch])).trim().split(/\s+/)[0] || "";
        const localHead = (await gitAsync(repo, ["rev-parse", "HEAD"])).trim();
        expect(remoteHead).toBe(localHead);
      } finally {
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 在仅保护分支预览模式下，命中主分支时仍应打开 preview 而不是直接推送",
    async () => {
      const { repo, remoteRoot, defaultBranch } = await createRepoWithRemoteAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "protected-preview.txt"), "payload\n", "utf8");
        const remoteHeadBefore = (await gitAsync(repo, ["ls-remote", "--heads", "origin", defaultBranch])).trim().split(/\s+/)[0] || "";

        const savePreferences = await dispatchGitFeatureAction({
          action: "commit.preferences.set",
          payload: {
            repoPath: repo,
            commitAndPush: {
              previewOnCommitAndPush: true,
              previewProtectedOnly: true,
            },
          },
          userDataPath,
        });
        expect(savePreferences.ok).toBe(true);

        const commit = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "protected preview",
            pushAfter: true,
            includedItems: [{ path: "protected-preview.txt", kind: "unversioned" }],
          },
          userDataPath,
        });
        expect(commit.ok).toBe(true);
        expect(commit.data?.postCommitPush).toEqual(expect.objectContaining({
          mode: "preview",
          protectedTarget: true,
        }));

        const remoteHeadAfter = (await gitAsync(repo, ["ls-remote", "--heads", "origin", defaultBranch])).trim().split(/\s+/)[0] || "";
        expect(remoteHeadAfter).toBe(remoteHeadBefore);
      } finally {
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 在无法直接推送时，即使关闭预览偏好也应回退到 preview",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "fallback-preview.txt"), "payload\n", "utf8");
        const savePreferences = await dispatchGitFeatureAction({
          action: "commit.preferences.set",
          payload: {
            repoPath: repo,
            commitAndPush: {
              previewOnCommitAndPush: false,
            },
          },
          userDataPath,
        });
        expect(savePreferences.ok).toBe(true);

        const commit = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "fallback preview",
            pushAfter: true,
            includedItems: [{ path: "fallback-preview.txt", kind: "unversioned" }],
          },
          userDataPath,
        });
        expect(commit.ok).toBe(true);
        expect(commit.data?.postCommitPush).toEqual(expect.objectContaining({
          mode: "preview",
        }));
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 自动推送失败时应返回 commitSucceeded 与 failed 状态，而不是回滚已创建的提交",
    async () => {
      const { repo, remoteRoot } = await createRepoWithRemoteAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await gitAsync(repo, ["remote", "set-url", "origin", path.join(remoteRoot, "missing-remote.git")]);
        await fsp.writeFile(path.join(repo, "push-failed.txt"), "payload\n", "utf8");

        const savePreferences = await dispatchGitFeatureAction({
          action: "commit.preferences.set",
          payload: {
            repoPath: repo,
            commitAndPush: {
              previewOnCommitAndPush: false,
            },
          },
          userDataPath,
        });
        expect(savePreferences.ok).toBe(true);

        const commit = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "push failed",
            pushAfter: true,
            includedItems: [{ path: "push-failed.txt", kind: "unversioned" }],
          },
          userDataPath,
        });
        expect(commit.ok).toBe(false);
        expect(commit.data?.commitSucceeded).toBe(true);
        expect(commit.data?.postCommitPush).toEqual(expect.objectContaining({
          mode: "failed",
        }));
        expect((await gitAsync(repo, ["log", "-1", "--format=%s"])).trim()).toBe("push failed");
      } finally {
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 在 merge 中排除同仓其他 tracked changes 时应先要求 mergeExclusionConfirmed",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "merge.txt"), "base\n", "utf8");
        await fsp.writeFile(path.join(repo, "left.txt"), "base\n", "utf8");
        await gitAsync(repo, ["add", "merge.txt", "left.txt"]);
        await gitAsync(repo, ["commit", "-m", "init merge exclusion"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/merge-exclusion"]);
        await fsp.writeFile(path.join(repo, "merge.txt"), "feature\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature change"]);
        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "merge.txt"), "main\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main change"]);
        const mergeRes = await execGitAsync({ argv: ["-C", repo, "merge", "feature/merge-exclusion"], timeoutMs: 20_000 });
        expect(mergeRes.ok).toBe(false);
        await fsp.writeFile(path.join(repo, "merge.txt"), "resolved\n", "utf8");
        await gitAsync(repo, ["add", "merge.txt"]);
        await fsp.writeFile(path.join(repo, "left.txt"), "left working tree\n", "utf8");

        const denied = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "merge partial",
            pushAfter: false,
            includedItems: [{ path: "merge.txt", kind: "change" }],
          },
          userDataPath,
        });
        expect(denied.ok).toBe(false);
        expect(
          denied.data?.mergeExclusionRequired === true
          || String(denied.error || "").includes("Merge 变更未纳入本次提交"),
        ).toBe(true);

        const allowed = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "merge partial",
            pushAfter: false,
            mergeExclusionConfirmed: true,
            includedItems: [{ path: "merge.txt", kind: "change" }],
          },
          userDataPath,
        });
        expect(allowed.ok, String(allowed.error || "")).toBe(true);
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 在 Detached HEAD 时应先返回 confirmationChecks，确认后才继续提交",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "detached.txt"), "base\n", "utf8");
        await gitAsync(repo, ["add", "detached.txt"]);
        await gitAsync(repo, ["commit", "-m", "init detached"]);
        await gitAsync(repo, ["checkout", "--detach"]);

        await fsp.writeFile(path.join(repo, "detached.txt"), "detached change\n", "utf8");

        const denied = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "detached commit",
            pushAfter: false,
            includedItems: [{ path: "detached.txt", kind: "change" }],
          },
          userDataPath,
        });
        expect(denied.ok).toBe(false);
        expect(denied.data?.confirmationChecks).toEqual([
          expect.objectContaining({ id: "detached-head" }),
        ]);

        const allowed = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "detached commit",
            pushAfter: false,
            confirmedChecks: ["detached-head"],
            includedItems: [{ path: "detached.txt", kind: "change" }],
          },
          userDataPath,
        });
        expect(allowed.ok, String(allowed.error || "")).toBe(true);
      } finally {
        try { await gitAsync(repo, ["switch", "-"]); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 应对 CRLF 与大文件返回 confirmationChecks，确认后允许继续提交",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const largeContent = `${"x".repeat(10 * 1024 * 1024 + 1024)}\n`;
        await fsp.writeFile(path.join(repo, "crlf.txt"), "line-1\r\nline-2\r\n", "utf8");
        await fsp.writeFile(path.join(repo, "large.txt"), largeContent, "utf8");

        const denied = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "warning checks",
            pushAfter: false,
            includedItems: [
              { path: "crlf.txt", kind: "unversioned" },
              { path: "large.txt", kind: "unversioned" },
            ],
          },
          userDataPath,
        });
        expect(denied.ok).toBe(false);
        expect((denied.data?.confirmationChecks || []).map((item: { id: string }) => item.id)).toEqual([
          "large-file",
          "crlf",
        ]);

        const allowed = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "warning checks",
            pushAfter: false,
            confirmedChecks: ["large-file", "crlf"],
            includedItems: [
              { path: "crlf.txt", kind: "unversioned" },
              { path: "large.txt", kind: "unversioned" },
            ],
          },
          userDataPath,
        });
        expect(allowed.ok, String(allowed.error || "")).toBe(true);
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 在仍有未解决冲突时应直接阻断，并返回 blockingCheck",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "a.txt"), "base-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "base-b\n", "utf8");
        await gitAsync(repo, ["add", "a.txt", "b.txt"]);
        await gitAsync(repo, ["commit", "-m", "init conflict precheck"]);
        const defaultBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim() || "master";

        await gitAsync(repo, ["checkout", "-b", "feature/conflict-precheck"]);
        await fsp.writeFile(path.join(repo, "a.txt"), "feature-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "feature-b\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "feature conflict"]);
        await gitAsync(repo, ["checkout", defaultBranch]);
        await fsp.writeFile(path.join(repo, "a.txt"), "main-a\n", "utf8");
        await fsp.writeFile(path.join(repo, "b.txt"), "main-b\n", "utf8");
        await gitAsync(repo, ["commit", "-am", "main conflict"]);

        const mergeRes = await execGitAsync({
          argv: ["-C", repo, "merge", "feature/conflict-precheck"],
          timeoutMs: 20_000,
        });
        expect(mergeRes.ok).toBe(false);
        await gitAsync(repo, ["checkout", "--ours", "--", "a.txt"]);
        await gitAsync(repo, ["add", "a.txt"]);

        const denied = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "conflict blocked",
            pushAfter: false,
            includedItems: [{ path: "a.txt", kind: "change" }],
          },
          userDataPath,
        });
        expect(denied.ok).toBe(false);
        expect(denied.data?.blockingCheck).toEqual(expect.objectContaining({
          id: "unresolved-conflicts",
        }));
      } finally {
        try { await execGitAsync({ argv: ["-C", repo, "merge", "--abort"], timeoutMs: 10_000 }); } catch {}
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 应支持 hunk 级 partial commit，并把未选中的 hunk 留在工作区",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const partialFilePath = path.join(repo, "partial.txt");
        await fsp.writeFile(partialFilePath, [
          "line-01",
          "line-02",
          "line-03",
          "line-04",
          "line-05",
          "line-06",
          "line-07",
          "line-08",
          "line-09",
          "line-10",
          "",
        ].join("\n"), "utf8");
        await gitAsync(repo, ["add", "partial.txt"]);
        await gitAsync(repo, ["commit", "-m", "init partial"]);

        await fsp.writeFile(partialFilePath, [
          "line-01 changed",
          "line-02",
          "line-03",
          "line-04",
          "line-05",
          "line-06",
          "line-07",
          "line-08",
          "line-09",
          "line-10 changed",
          "",
        ].join("\n"), "utf8");

        const diffRes = await dispatchGitFeatureAction({
          action: "diff.get",
          payload: {
            repoPath: repo,
            path: "partial.txt",
            mode: "working",
          },
          userDataPath,
        });
        expect(diffRes.ok).toBe(true);
        expect(diffRes.data?.hunks?.map((item: { id: string }) => item.id)).toHaveLength(2);

        const firstHunk = diffRes.data?.hunks?.[0];
        expect(firstHunk).toBeTruthy();

        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "partial commit",
            pushAfter: false,
            selections: [
              {
                repoRoot: repo,
                changeListId: "default",
                path: "partial.txt",
                kind: "change",
                selectionMode: "partial",
                snapshotFingerprint: diffRes.data?.fingerprint,
                patch: `${diffRes.data?.patchHeader || ""}${firstHunk.patch}`,
                selectedHunkIds: [firstHunk.id],
              },
            ],
          },
          userDataPath,
        });
        expect(commitRes.ok, String(commitRes.error || "")).toBe(true);

        const headText = await gitAsync(repo, ["show", "HEAD:partial.txt"]);
        expect(headText).toContain("line-01 changed");
        expect(headText).toContain("line-10\n");
        expect(headText).not.toContain("line-10 changed");

        const workingText = await fsp.readFile(partialFilePath, "utf8");
        expect(workingText).toContain("line-01 changed");
        expect(workingText).toContain("line-10 changed");

        const workingDiff = await gitAsync(repo, ["diff", "--unified=0", "--", "partial.txt"]);
        expect(workingDiff).not.toContain("line-01 changed");
        expect(workingDiff).toContain("line-10 changed");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 应支持 hunk 内 line 级 partial commit，并把未选中的 changed line 留在工作区",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const partialFilePath = path.join(repo, "partial-lines.txt");
        await fsp.writeFile(partialFilePath, [
          "line-01",
          "line-02",
          "line-03",
          "line-04",
          "",
        ].join("\n"), "utf8");
        await gitAsync(repo, ["add", "partial-lines.txt"]);
        await gitAsync(repo, ["commit", "-m", "init partial lines"]);

        await fsp.writeFile(partialFilePath, [
          "line-01 changed",
          "line-02",
          "line-03 changed",
          "line-04",
          "",
        ].join("\n"), "utf8");

        const diffRes = await dispatchGitFeatureAction({
          action: "diff.get",
          payload: {
            repoPath: repo,
            path: "partial-lines.txt",
            mode: "working",
          },
          userDataPath,
        });
        expect(diffRes.ok).toBe(true);
        expect(diffRes.data?.hunks?.map((item: { id: string }) => item.id)).toHaveLength(1);

        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "partial line commit",
            pushAfter: false,
            selections: [
              {
                repoRoot: repo,
                changeListId: "default",
                path: "partial-lines.txt",
                kind: "change",
                selectionMode: "partial",
                snapshotFingerprint: diffRes.data?.fingerprint,
                patch: [
                  String(diffRes.data?.patchHeader || ""),
                  "@@ -1,4 +1,4 @@\n",
                  " line-01\n",
                  " line-02\n",
                  "-line-03\n",
                  "+line-03 changed\n",
                  " line-04\n",
                ].join(""),
                selectedHunkIds: [String(diffRes.data?.hunks?.[0]?.id || "")].filter(Boolean),
              },
            ],
          },
          userDataPath,
        });
        expect(commitRes.ok, String(commitRes.error || "")).toBe(true);

        const headText = await gitAsync(repo, ["show", "HEAD:partial-lines.txt"]);
        expect(headText).toContain("line-01\n");
        expect(headText).toContain("line-03 changed");
        expect(headText).not.toContain("line-01 changed");

        const workingText = await fsp.readFile(partialFilePath, "utf8");
        expect(workingText).toContain("line-01 changed");
        expect(workingText).toContain("line-03 changed");

        const workingDiff = await gitAsync(repo, ["diff", "--unified=0", "--", "partial-lines.txt"]);
        expect(workingDiff).toContain("line-01 changed");
        expect(workingDiff).not.toContain("line-03 changed");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 应把 signOff、skipHooks、author、authorDate 与 cleanupMessage 落到真实 git commit 参数",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const trackedFilePath = path.join(repo, "advanced-options.txt");
        const hookMarkerPath = path.join(repo, "hook-ran.txt");
        const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
        await fsp.writeFile(trackedFilePath, "init\n", "utf8");
        await gitAsync(repo, ["add", "advanced-options.txt"]);
        await gitAsync(repo, ["commit", "-m", "init advanced options"]);

        await fsp.writeFile(trackedFilePath, "changed\n", "utf8");
        await gitAsync(repo, ["add", "advanced-options.txt"]);
        await fsp.writeFile(hookPath, `#!/bin/sh\necho hook > "${hookMarkerPath}"\nexit 1\n`, "utf8");
        await fsp.chmod(hookPath, 0o755);

        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: [
              "advanced options",
              "",
              "# remove me",
              "body line",
              "",
            ].join("\n"),
            pushAfter: false,
            includedItems: [{ path: "advanced-options.txt", kind: "change" }],
            signOff: true,
            skipHooks: true,
            author: "Alice Example <alice@example.com>",
            authorDate: "2024-05-06T07:08:09",
            cleanupMessage: true,
          },
          userDataPath,
        });
        expect(commitRes.ok).toBe(true);

        const hookMarkerExists = await fsp.access(hookMarkerPath).then(() => true).catch(() => false);
        expect(hookMarkerExists).toBe(false);

        const author = (await gitAsync(repo, ["log", "-1", "--format=%an <%ae>"])).trim();
        expect(author).toBe("Alice Example <alice@example.com>");

        const authorDate = (await gitAsync(repo, ["log", "-1", "--format=%ai"])).trim();
        expect(authorDate.startsWith("2024-05-06 07:08:09 ")).toBe(true);

        const messageBody = await gitAsync(repo, ["log", "-1", "--format=%B"]);
        expect(messageBody).toContain("advanced options");
        expect(messageBody).toContain("body line");
        expect(messageBody).not.toContain("# remove me");
        expect(messageBody).toContain("Signed-off-by: CodexFlow <codexflow@example.com>");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "status.get 与 commit.preferences 应按 hooks 可用性和全局策略返回一致快照",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const statusBefore = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(statusBefore.ok).toBe(true);
        expect(statusBefore.data?.commitHooks).toEqual(expect.objectContaining({
          available: false,
          disabledByPolicy: false,
          runByDefault: true,
        }));

        const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
        await fsp.writeFile(hookPath, "#!/bin/sh\nexit 0\n", "utf8");
        await fsp.chmod(hookPath, 0o755);

        const statusWithHook = await dispatchGitFeatureAction({
          action: "status.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(statusWithHook.ok).toBe(true);
        expect(statusWithHook.data?.commitHooks).toEqual(expect.objectContaining({
          available: true,
          disabledByPolicy: false,
          runByDefault: true,
        }));

        const saved = await dispatchGitFeatureAction({
          action: "commit.preferences.set",
          payload: {
            repoPath: repo,
            hooks: {
              disableRunCommitHooks: true,
            },
          },
          userDataPath,
        });
        expect(saved.ok).toBe(true);
        expect(saved.data?.commitHooks).toEqual(expect.objectContaining({
          available: true,
          disabledByPolicy: true,
          runByDefault: false,
        }));

        const loaded = await dispatchGitFeatureAction({
          action: "commit.preferences.get",
          payload: { repoPath: repo },
          userDataPath,
        });
        expect(loaded.ok).toBe(true);
        expect(loaded.data?.commitHooks).toEqual(expect.objectContaining({
          available: true,
          disabledByPolicy: true,
          runByDefault: false,
        }));
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 在启用将文件移动单独提交时应先提交文件移动，再提交剩余改动",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const oldFilePath = path.join(repo, "old-name.txt");
        const newFilePath = path.join(repo, "new-name.txt");
        const siblingFilePath = path.join(repo, "note.txt");
        await fsp.writeFile(oldFilePath, ["line-01", "line-02", "line-03", ""].join("\n"), "utf8");
        await fsp.writeFile(siblingFilePath, "init note\n", "utf8");
        await gitAsync(repo, ["add", "old-name.txt", "note.txt"]);
        await gitAsync(repo, ["commit", "-m", "init rename split"]);

        await fsp.rename(oldFilePath, newFilePath);
        await fsp.writeFile(newFilePath, ["line-01", "line-02 updated", "line-03", ""].join("\n"), "utf8");
        await fsp.writeFile(siblingFilePath, "updated note\n", "utf8");

        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "feature commit",
            pushAfter: false,
            commitRenamesSeparately: true,
            includedItems: [
              { path: "new-name.txt", oldPath: "old-name.txt", kind: "change" },
              { path: "note.txt", kind: "change" },
            ],
          },
          userDataPath,
        });
        expect(commitRes.ok, String(commitRes.error || "")).toBe(true);
        expect(String(commitRes.data?.renameCommitHash || "")).toMatch(/^[0-9a-f]{40}$/i);
        expect(String(commitRes.data?.commitHash || "")).toMatch(/^[0-9a-f]{40}$/i);

        const logSubjects = (await gitAsync(repo, ["log", "-2", "--format=%s"])).trim().split(/\r?\n/).filter(Boolean);
        expect(logSubjects).toEqual(["feature commit", "文件移动: feature commit"]);

        const renameCommitFiles = (await gitAsync(repo, ["show", "--name-only", "--format=", "HEAD~1"])).split(/\r?\n/).filter(Boolean);
        expect(renameCommitFiles).toEqual(["new-name.txt"]);

        const mainCommitFiles = (await gitAsync(repo, ["show", "--name-only", "--format=", "HEAD"])).split(/\r?\n/).filter(Boolean);
        expect(mainCommitFiles).toEqual(["note.txt"]);

        const cachedDiff = (await gitAsync(repo, ["diff", "--cached", "--name-only"])).trim();
        const workingDiff = (await gitAsync(repo, ["diff", "--name-only"])).trim();
        expect(cachedDiff).toBe("");
        expect(workingDiff).toBe("");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 在 selection.oldPath 已失效时仍应按上游语义忽略 remove miss，并成功提交有效路径",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "base.txt"), "init\n", "utf8");
        await gitAsync(repo, ["add", "base.txt"]);
        await gitAsync(repo, ["commit", "-m", "init stale old path"]);

        await fsp.writeFile(path.join(repo, "fresh.txt"), "fresh content\n", "utf8");

        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "commit stale old path",
            pushAfter: false,
            includedItems: [
              { path: "fresh.txt", oldPath: "missing.txt", kind: "change" },
            ],
          },
          userDataPath,
        });
        expect(commitRes.ok, String(commitRes.error || "")).toBe(true);

        const headSubject = (await gitAsync(repo, ["log", "-1", "--format=%s"])).trim();
        expect(headSubject).toBe("commit stale old path");

        const commitFiles = (await gitAsync(repo, ["show", "--name-only", "--format=", "HEAD"])).split(/\r?\n/).filter(Boolean);
        expect(commitFiles).toEqual(["fresh.txt"]);

        const headFreshText = await gitAsync(repo, ["show", "HEAD:fresh.txt"]);
        expect(headFreshText).toBe("fresh content\n");

        const cachedDiff = (await gitAsync(repo, ["diff", "--cached", "--name-only"])).trim();
        const workingDiff = (await gitAsync(repo, ["diff", "--name-only"])).trim();
        expect(cachedDiff).toBe("");
        expect(workingDiff).toBe("");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 在 amend 模式下应允许不选择任何文件，只修改上一提交信息并保留工作区改动",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        const trackedFilePath = path.join(repo, "amend-message-only.txt");
        await fsp.writeFile(trackedFilePath, "init\n", "utf8");
        await gitAsync(repo, ["add", "amend-message-only.txt"]);
        await gitAsync(repo, ["commit", "-m", "init amend target"]);

        await fsp.writeFile(trackedFilePath, "working tree change\n", "utf8");

        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "amended message only",
            pushAfter: false,
            amend: true,
            includedItems: [],
          },
          userDataPath,
        });
        expect(commitRes.ok).toBe(true);

        const subject = (await gitAsync(repo, ["log", "-1", "--format=%s"])).trim();
        expect(subject).toBe("amended message only");

        const headText = await gitAsync(repo, ["show", "HEAD:amend-message-only.txt"]);
        expect(headText).toBe("init\n");

        const workingText = await fsp.readFile(trackedFilePath, "utf8");
        expect(workingText).toBe("working tree change\n");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 应按 selection.repoRoot 分仓执行多仓提交，而不是把外层 repoPath 当作唯一根",
    async () => {
      const repoA = await createRepoAsync("codexflow-commit-panel-a-");
      const repoB = await createRepoAsync("codexflow-commit-panel-b-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repoA, "a.txt"), "init-a\n", "utf8");
        await gitAsync(repoA, ["add", "a.txt"]);
        await gitAsync(repoA, ["commit", "-m", "init-a"]);

        await fsp.writeFile(path.join(repoB, "b.txt"), "init-b\n", "utf8");
        await gitAsync(repoB, ["add", "b.txt"]);
        await gitAsync(repoB, ["commit", "-m", "init-b"]);

        await fsp.writeFile(path.join(repoA, "a.txt"), "changed-a\n", "utf8");
        await fsp.writeFile(path.join(repoB, "b.txt"), "changed-b\n", "utf8");

        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repoA,
            message: "multi-root commit",
            pushAfter: false,
            selections: [
              {
                repoRoot: repoA,
                changeListId: "default",
                path: "a.txt",
                kind: "change",
                selectionMode: "full-file",
              },
              {
                repoRoot: repoB,
                changeListId: "default",
                path: "b.txt",
                kind: "change",
                selectionMode: "full-file",
              },
            ],
          },
          userDataPath,
        });
        expect(commitRes.ok, String(commitRes.error || "")).toBe(true);
        expect(commitRes.data?.commitHashes).toEqual([
          expect.objectContaining({ repoRoot: repoA, commitHash: expect.stringMatching(/^[0-9a-f]{40}$/i) }),
          expect.objectContaining({ repoRoot: repoB, commitHash: expect.stringMatching(/^[0-9a-f]{40}$/i) }),
        ]);

        expect((await gitAsync(repoA, ["log", "-1", "--format=%s"])).trim()).toBe("multi-root commit");
        expect((await gitAsync(repoB, ["log", "-1", "--format=%s"])).trim()).toBe("multi-root commit");
        expect((await gitAsync(repoA, ["status", "--short"])).trim()).toBe("");
        expect((await gitAsync(repoB, ["status", "--short"])).trim()).toBe("");
      } finally {
        try { await fsp.rm(repoA, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(repoB, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "commit.create 在 reset-add staged saver 策略下应保留未选中文件的 staged 状态",
    async () => {
      const repo = await createRepoAsync("codexflow-commit-panel-");
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-commit-panel-user-"));
      try {
        await fsp.writeFile(path.join(repo, "keep.txt"), "init keep\n", "utf8");
        await fsp.writeFile(path.join(repo, "submit.txt"), "init submit\n", "utf8");
        await gitAsync(repo, ["add", "keep.txt", "submit.txt"]);
        await gitAsync(repo, ["commit", "-m", "init staged saver"]);

        await fsp.writeFile(path.join(repo, "keep.txt"), "keep staged\n", "utf8");
        await fsp.writeFile(path.join(repo, "submit.txt"), "submit staged\n", "utf8");
        await gitAsync(repo, ["add", "keep.txt", "submit.txt"]);

        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: repo,
            message: "submit selected",
            pushAfter: false,
            stagedSaverStrategy: "reset-add",
            includedItems: [
              { path: "submit.txt", kind: "change" },
            ],
          },
          userDataPath,
        });
        expect(commitRes.ok, String(commitRes.error || "")).toBe(true);

        expect((await gitAsync(repo, ["log", "-1", "--format=%s"])).trim()).toBe("submit selected");
        expect(await gitAsync(repo, ["show", "HEAD:submit.txt"])).toBe("submit staged\n");
        expect(await gitAsync(repo, ["show", "HEAD:keep.txt"])).toBe("init keep\n");

        const cachedNames = (await gitAsync(repo, ["diff", "--cached", "--name-only"])).split(/\r?\n/).filter(Boolean);
        expect(cachedNames).toEqual(["keep.txt"]);

        const workingNames = (await gitAsync(repo, ["diff", "--name-only"])).trim();
        expect(workingNames).toBe("");
      } finally {
        try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );
});
