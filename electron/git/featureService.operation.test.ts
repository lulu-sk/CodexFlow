import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { execGitAsync, type GitExecResult } from "./exec";
import { dispatchGitFeatureAction } from "./featureService";
import type { GitConsoleEntry } from "./consoleStore";

type RepoFixture = {
  repo: string;
  userDataPath: string;
  cleanup(): Promise<void>;
};

/**
 * 在测试仓库内执行 Git 命令；命令失败时直接抛出断言，减少样板错误处理。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 20_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 执行一个预期会失败的 Git 命令，并把原始结果返回给调用方继续断言。
 */
async function gitMayFailAsync(repo: string, argv: string[], timeoutMs: number = 20_000): Promise<GitExecResult> {
  return await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
}

/**
 * 创建带用户信息与初始提交的临时仓库，供每个集成用例隔离使用。
 */
async function createRepoFixture(prefix: string): Promise<RepoFixture> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-repo-`));
  const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-userdata-`));
  await gitAsync(repo, ["init", "-b", "master"]);
  await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);
  await gitAsync(repo, ["config", "core.autocrlf", "false"]);
  await gitAsync(repo, ["config", "core.eol", "lf"]);
  await writeFileAsync(repo, "conflict.txt", "base\n");
  await gitAsync(repo, ["add", "conflict.txt"]);
  await gitAsync(repo, ["commit", "-m", "base"]);
  return {
    repo,
    userDataPath,
    async cleanup(): Promise<void> {
      try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
      try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * 向测试仓库写入文件内容，必要时自动补目录。
 */
async function writeFileAsync(repo: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(repo, relativePath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, content, "utf8");
}

/**
 * 在当前分支写入并提交单个文件修改，供 autosquash / 日志动作测试复用。
 */
async function commitFileChangeAsync(repo: string, relativePath: string, content: string, message: string): Promise<void> {
  await writeFileAsync(repo, relativePath, content);
  await gitAsync(repo, ["add", relativePath]);
  await gitAsync(repo, ["commit", "-m", message]);
}

/**
 * 以指定作者身份提交文件变更，供日志作者筛选测试复用。
 */
async function commitFileChangeWithAuthorAsync(
  repo: string,
  relativePath: string,
  content: string,
  message: string,
  authorName: string,
  authorEmail: string,
): Promise<void> {
  await writeFileAsync(repo, relativePath, content);
  await gitAsync(repo, ["add", relativePath]);
  await gitAsync(repo, [
    "-c",
    `user.name=${authorName}`,
    "-c",
    `user.email=${authorEmail}`,
    "commit",
    "-m",
    message,
  ]);
}

/**
 * 重命名一个已跟踪文件，并在同一次提交中写入新内容，便于构造跨 rename 的文件历史链路。
 */
async function renameTrackedFileAsync(
  repo: string,
  oldPath: string,
  newPath: string,
  content: string,
  message: string,
): Promise<void> {
  await gitAsync(repo, ["mv", oldPath, newPath]);
  await writeFileAsync(repo, newPath, content);
  await gitAsync(repo, ["add", newPath]);
  await gitAsync(repo, ["commit", "-m", message]);
}

/**
 * 在指定分支上提交一个会制造冲突的文件修改。
 */
async function commitConflictChangeAsync(repo: string, branch: string, content: string, message: string): Promise<void> {
  const currentBranch = (await gitAsync(repo, ["branch", "--show-current"])).trim();
  if (currentBranch !== branch) {
    await gitAsync(repo, ["checkout", branch]);
  }
  await writeFileAsync(repo, "conflict.txt", content);
  await gitAsync(repo, ["add", "conflict.txt"]);
  await gitAsync(repo, ["commit", "-m", message]);
}

/**
 * 判断 subject 是否属于 stash 生成的三类附加记录，兼容不同 Git 版本对主记录使用 `WIP on` / `On` 的差异。
 */
function isStashSyntheticSubject(subject: string): boolean {
  return /^((WIP )?on master:|index on master:|untracked files on master:)/.test(subject);
}

/**
 * 读取当前仓库的操作状态，断言入口统一复用真实 `status.get` 契约。
 */
async function getOperationStateAsync(userDataPath: string, repo: string): Promise<string> {
  const statusRes = await dispatchGitFeatureAction({
    action: "status.get",
    payload: { repoPath: repo },
    userDataPath,
  });
  expect(statusRes.ok).toBe(true);
  return String(statusRes.data?.operationState || "normal");
}

/**
 * 读取完整 status.get 快照，供 Cherry-pick 建议提交消息与提交收尾流程断言复用。
 */
async function getStatusSnapshotAsync(userDataPath: string, repo: string): Promise<any> {
  const statusRes = await dispatchGitFeatureAction({
    action: "status.get",
    payload: { repoPath: repo },
    userDataPath,
  });
  expect(statusRes.ok).toBe(true);
  return statusRes.data || {};
}

/**
 * 读取指定仓库的 Git 控制台记录，便于验证 Pull 是否真的走了独立命令链。
 */
async function listConsoleEntriesAsync(userDataPath: string, repo: string): Promise<GitConsoleEntry[]> {
  const res = await dispatchGitFeatureAction({
    action: "console.get",
    payload: {
      repoPath: repo,
      limit: 200,
      includeLongText: true,
    },
    userDataPath,
  });
  expect(res.ok).toBe(true);
  return Array.isArray(res.data?.items) ? res.data.items as GitConsoleEntry[] : [];
}

/**
 * 清空 Git 控制台记录，避免其它命令噪声影响 Pull 路径断言。
 */
async function clearConsoleEntriesAsync(userDataPath: string, repo: string): Promise<void> {
  const res = await dispatchGitFeatureAction({
    action: "console.clear",
    payload: {
      repoPath: repo,
    },
    userDataPath,
  });
  expect(res.ok).toBe(true);
}

/**
 * 构造 merge conflict 场景，并使仓库停留在 `merging` 状态。
 */
async function setupMergeConflictAsync(fixture: RepoFixture): Promise<void> {
  await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
  await commitConflictChangeAsync(fixture.repo, "feature", "feature\n", "feature change");
  await gitAsync(fixture.repo, ["checkout", "master"]);
  await commitConflictChangeAsync(fixture.repo, "master", "master\n", "master change");
  const mergeRes = await gitMayFailAsync(fixture.repo, ["merge", "feature"], 30_000);
  expect(mergeRes.ok).toBe(false);
}

/**
 * 构造 rebase conflict 场景，并使仓库停留在 `rebasing` 状态。
 */
async function setupRebaseConflictAsync(fixture: RepoFixture): Promise<void> {
  await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
  await commitConflictChangeAsync(fixture.repo, "feature", "feature\n", "feature change");
  await gitAsync(fixture.repo, ["checkout", "master"]);
  await commitConflictChangeAsync(fixture.repo, "master", "master\n", "master change");
  await gitAsync(fixture.repo, ["checkout", "feature"]);
  const rebaseRes = await gitMayFailAsync(fixture.repo, ["rebase", "master"], 30_000);
  expect(rebaseRes.ok).toBe(false);
}

/**
 * 构造 cherry-pick conflict 场景，并使仓库停留在 `grafting` 状态。
 */
async function setupCherryPickConflictAsync(fixture: RepoFixture): Promise<void> {
  await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
  await commitConflictChangeAsync(fixture.repo, "feature", "feature\n", "feature change");
  await gitAsync(fixture.repo, ["checkout", "master"]);
  await commitConflictChangeAsync(fixture.repo, "master", "master\n", "master change");
  const pickRes = await gitMayFailAsync(fixture.repo, ["cherry-pick", "feature"], 30_000);
  expect(pickRes.ok).toBe(false);
}

/**
 * 构造“先因本地改动覆盖被拦截，再在保存后重试时进入 Cherry-pick 冲突”的链路场景。
 */
async function setupCherryPickRetryConflictAsync(fixture: RepoFixture): Promise<string> {
  await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
  await commitConflictChangeAsync(fixture.repo, "feature", "feature\n", "feature change");
  const featureHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

  await gitAsync(fixture.repo, ["checkout", "master"]);
  await commitConflictChangeAsync(fixture.repo, "master", "master\n", "master change");
  await writeFileAsync(fixture.repo, "conflict.txt", "local\n");
  return featureHash;
}

/**
 * 构造“本地存在不相交 tracked 改动，保存后重试会进入 Cherry-pick 冲突”的场景，
 * 便于验证优选结束后能自动恢复原先保存的本地改动。
 */
async function setupCherryPickPreserveConflictWithUnrelatedLocalChangesAsync(fixture: RepoFixture): Promise<string> {
  await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
  await commitConflictChangeAsync(fixture.repo, "feature", "feature\n", "feature change");
  const featureHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

  await gitAsync(fixture.repo, ["checkout", "master"]);
  await commitConflictChangeAsync(fixture.repo, "master", "master\n", "master change");
  await writeFileAsync(fixture.repo, "local-note.txt", "local note\n");
  await gitAsync(fixture.repo, ["add", "local-note.txt"]);
  return featureHash;
}

/**
 * 构造“首个 cherry-pick 提交会变成 empty，跳过后第二个提交发生冲突”的多提交场景。
 */
async function setupCherryPickEmptyThenConflictAsync(
  fixture: RepoFixture,
): Promise<{ emptyHash: string; conflictHash: string }> {
  await writeFileAsync(fixture.repo, "shared.txt", "base\n");
  await gitAsync(fixture.repo, ["add", "shared.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "add shared"]);

  await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
  await writeFileAsync(fixture.repo, "shared.txt", "shared\n");
  await gitAsync(fixture.repo, ["add", "shared.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "feature empty"]);
  const emptyHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

  await writeFileAsync(fixture.repo, "conflict.txt", "feature conflict\n");
  await gitAsync(fixture.repo, ["add", "conflict.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "feature conflict"]);
  const conflictHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

  await gitAsync(fixture.repo, ["checkout", "master"]);
  await writeFileAsync(fixture.repo, "shared.txt", "shared\n");
  await gitAsync(fixture.repo, ["add", "shared.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "master same"]);

  await writeFileAsync(fixture.repo, "conflict.txt", "master conflict\n");
  await gitAsync(fixture.repo, ["add", "conflict.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "master conflict"]);

  return { emptyHash, conflictHash };
}

/**
 * 构造仅剩 sequencer 队列、但 `CHERRY_PICK_HEAD` 已缺失的 multi-commit cherry-pick 状态，
 * 用于复现真实仓库里“status 仍显示进行中，但 pseudo-ref 已不存在”的场景。
 */
async function setupCherryPickSequencerStateWithoutPseudoRefAsync(fixture: RepoFixture): Promise<void> {
  await writeFileAsync(fixture.repo, "sequence.txt", "base\n");
  await gitAsync(fixture.repo, ["add", "sequence.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "add sequence file"]);

  await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
  await writeFileAsync(fixture.repo, "sequence.txt", "feature step 1\n");
  await gitAsync(fixture.repo, ["add", "sequence.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "feature step 1"]);
  await writeFileAsync(fixture.repo, "sequence-extra.txt", "feature step 2\n");
  await gitAsync(fixture.repo, ["add", "sequence-extra.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "feature step 2"]);
  const firstHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD~1"])).trim();
  const secondHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

  await gitAsync(fixture.repo, ["checkout", "master"]);
  await writeFileAsync(fixture.repo, "sequence.txt", "main conflict\n");
  await gitAsync(fixture.repo, ["add", "sequence.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "main conflict"]);

  const pickRes = await gitMayFailAsync(fixture.repo, ["cherry-pick", firstHash, secondHash], 30_000);
  expect(pickRes.ok).toBe(false);
  await writeFileAsync(fixture.repo, "sequence.txt", "resolved sequence\n");
  await gitAsync(fixture.repo, ["add", "sequence.txt"]);
  await fsp.rm(path.join(fixture.repo, ".git", "CHERRY_PICK_HEAD"), { force: true });

  const statusText = await gitAsync(fixture.repo, ["status"], 20_000);
  expect(statusText).toContain("Cherry-pick currently in progress.");
}

/**
 * 构造 multi-commit cherry-pick 在 continue 后再次冲突的场景，
 * 用于覆盖“第一轮冲突已解决，但推进到下一条提交时再次冲突”的真实工作流。
 */
async function setupCherryPickContinueConflictAsync(fixture: RepoFixture): Promise<void> {
  await writeFileAsync(fixture.repo, "sequence.txt", "base\n");
  await gitAsync(fixture.repo, ["add", "sequence.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "add sequence file"]);

  await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
  await writeFileAsync(fixture.repo, "sequence.txt", "feature step 1\n");
  await gitAsync(fixture.repo, ["add", "sequence.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "feature step 1"]);
  const firstHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

  await writeFileAsync(fixture.repo, "sequence.txt", "feature step 2\n");
  await gitAsync(fixture.repo, ["add", "sequence.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "feature step 2"]);
  const secondHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

  await gitAsync(fixture.repo, ["checkout", "master"]);
  await writeFileAsync(fixture.repo, "sequence.txt", "main conflict\n");
  await gitAsync(fixture.repo, ["add", "sequence.txt"]);
  await gitAsync(fixture.repo, ["commit", "-m", "main conflict"]);

  const pickRes = await gitMayFailAsync(fixture.repo, ["cherry-pick", firstHash, secondHash], 30_000);
  expect(pickRes.ok).toBe(false);

  await writeFileAsync(fixture.repo, "sequence.txt", "resolved first conflict\n");
  await gitAsync(fixture.repo, ["add", "sequence.txt"]);
}

/**
 * 构造 revert conflict 场景，并使仓库停留在 `reverting` 状态。
 */
async function setupRevertConflictAsync(fixture: RepoFixture): Promise<void> {
  await commitConflictChangeAsync(fixture.repo, "master", "first\n", "first change");
  const targetHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();
  await commitConflictChangeAsync(fixture.repo, "master", "second\n", "second change");
  const revertRes = await gitMayFailAsync(fixture.repo, ["revert", targetHash], 30_000);
  expect(revertRes.ok).toBe(false);
}

describe("featureService operation control", () => {
  it.each([
    {
      label: "merge",
      expectedState: "merging",
      setup: setupMergeConflictAsync,
    },
    {
      label: "rebase",
      expectedState: "rebasing",
      setup: setupRebaseConflictAsync,
    },
    {
      label: "cherry-pick",
      expectedState: "grafting",
      setup: setupCherryPickConflictAsync,
    },
    {
      label: "revert",
      expectedState: "reverting",
      setup: setupRevertConflictAsync,
    },
  ])(
    "operation.abort 应支持中止 $label 进行中状态",
    async ({ expectedState, setup }) => {
      const fixture = await createRepoFixture(`codexflow-op-abort-${expectedState}`);
      try {
        await setup(fixture);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe(expectedState);

        const abortRes = await dispatchGitFeatureAction({
          action: "operation.abort",
          payload: { repoPath: fixture.repo },
          userDataPath: fixture.userDataPath,
        });
        expect(abortRes.ok).toBe(true);
        expect(abortRes.data?.shouldRefresh).toBe(true);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("normal");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "operation.continue 在冲突全部解决且仍有待提交更改时，应返回提交完成模式",
    async () => {
      const fixture = await createRepoFixture("codexflow-op-continue");
      try {
        await setupCherryPickConflictAsync(fixture);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");

        await writeFileAsync(fixture.repo, "conflict.txt", "resolved\n");
        await gitAsync(fixture.repo, ["add", "conflict.txt"]);

        const continueRes = await dispatchGitFeatureAction({
          action: "operation.continue",
          payload: { repoPath: fixture.repo },
          userDataPath: fixture.userDataPath,
        });
        expect(continueRes.ok).toBe(true);
        expect(continueRes.data?.completed).toBe(false);
        expect(continueRes.data?.requiresCommitCompletion).toBe(true);
        expect(String(continueRes.data?.operationSuggestedCommitMessage || "")).toContain("feature change");
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "operation.continue 在冲突全部解决且已无优选内容时，应直接 skip 并结束 Cherry-pick",
    async () => {
      const fixture = await createRepoFixture("codexflow-op-continue-empty-finish");
      try {
        await setupCherryPickConflictAsync(fixture);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");

        await writeFileAsync(fixture.repo, "conflict.txt", "master\n");
        await gitAsync(fixture.repo, ["add", "conflict.txt"]);

        const continueRes = await dispatchGitFeatureAction({
          action: "operation.continue",
          payload: { repoPath: fixture.repo },
          userDataPath: fixture.userDataPath,
        });
        expect(continueRes.ok).toBe(true);
        expect(continueRes.data?.completed).toBe(true);
        expect(continueRes.data?.skippedEmptyCherryPick).toBe(true);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("normal");
        expect((await gitAsync(fixture.repo, ["log", "-1", "--format=%s"])).trim()).toBe("master change");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "operation.continue 在推进到下一条 cherry-pick 后再次冲突时，应保留 grafting 状态并返回结构化问题",
    async () => {
      const fixture = await createRepoFixture("codexflow-op-continue-conflict");
      try {
        await setupCherryPickContinueConflictAsync(fixture);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");

        const continueRes = await dispatchGitFeatureAction({
          action: "operation.continue",
          payload: { repoPath: fixture.repo },
          userDataPath: fixture.userDataPath,
        });
        expect(continueRes.ok).toBe(false);
        expect(continueRes.data?.shouldRefresh).toBe(true);
        expect(continueRes.data?.operationState).toBe("grafting");
        expect(continueRes.data?.completed).toBe(false);
        expect(continueRes.data?.operationProblem?.operation).toBe("cherry-pick");
        expect(continueRes.data?.operationProblem?.kind).toBe("merge-conflict");
        expect(continueRes.data?.operationProblem?.title).toBe("Cherry-pick 过程中出现冲突");
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "operation.continue 遇到 empty cherry-pick 时应自动 skip，并推进到后续冲突提交",
    async () => {
      const fixture = await createRepoFixture("codexflow-op-continue-empty-then-conflict");
      try {
        const { emptyHash, conflictHash } = await setupCherryPickEmptyThenConflictAsync(fixture);
        const firstPickRes = await gitMayFailAsync(fixture.repo, ["cherry-pick", emptyHash, conflictHash], 30_000);
        expect(firstPickRes.ok).toBe(false);
        expect(`${String(firstPickRes.stdout || "")}\n${String(firstPickRes.stderr || "")}`).toContain("nothing to commit");
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");

        const continueRes = await dispatchGitFeatureAction({
          action: "operation.continue",
          payload: { repoPath: fixture.repo },
          userDataPath: fixture.userDataPath,
        });

        expect(continueRes.ok).toBe(false);
        expect(continueRes.data?.shouldRefresh).toBe(true);
        expect(continueRes.data?.operationState).toBe("grafting");
        expect(continueRes.data?.operationProblem?.operation).toBe("cherry-pick");
        expect(continueRes.data?.operationProblem?.kind).toBe("merge-conflict");
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "log.action cherryPick 遇到本地改动覆盖时应返回结构化问题，并支持搁置后重试",
    async () => {
      const fixture = await createRepoFixture("codexflow-log-cherrypick-preserve");
      try {
        await clearConsoleEntriesAsync(fixture.userDataPath, fixture.repo);
        await writeFileAsync(fixture.repo, "target.txt", "base1\nbase2\nbase3\nbase4\nbase5\n");
        await gitAsync(fixture.repo, ["add", "target.txt"]);
        await gitAsync(fixture.repo, ["commit", "-m", "add target"]);

        await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
        await writeFileAsync(fixture.repo, "target.txt", "feature1\nbase2\nbase3\nbase4\nbase5\n");
        await gitAsync(fixture.repo, ["add", "target.txt"]);
        await gitAsync(fixture.repo, ["commit", "-m", "feature target"]);
        const featureHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

        await gitAsync(fixture.repo, ["checkout", "master"]);
        await writeFileAsync(fixture.repo, "target.txt", "base1\nbase2\nbase3\nbase4\nlocal5\n");

        const firstRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "cherryPick",
            hash: featureHash,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(firstRes.ok).toBe(false);
        expect(firstRes.data?.operationProblem?.kind).toBe("local-changes-overwritten");
        expect(firstRes.data?.operationProblem?.operation).toBe("cherry-pick");
        expect(firstRes.data?.operationProblem?.title).toBe("优选失败");
        expect(firstRes.data?.operationProblem?.description).toBe("您的本地更改将被优选覆盖。提交、搁置或还原您的更改以继续。");
        expect(firstRes.data?.operationProblem?.files).toContain("target.txt");
        expect(firstRes.data?.operationProblem?.actions?.[0]?.label).toContain("重试");
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("normal");
        const firstConsoleEntries = await listConsoleEntriesAsync(fixture.userDataPath, fixture.repo);
        expect(firstConsoleEntries.some((item) => String(item.command || "").includes("cherry-pick"))).toBe(false);

        const retryPatch = firstRes.data?.operationProblem?.actions?.[0]?.payloadPatch || {};
        const retryRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "cherryPick",
            hash: featureHash,
            autoSaveLocalChanges: true,
            saveChangesPolicy: retryPatch.saveChangesPolicy,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(retryRes.ok).toBe(true);
        expect(await fsp.readFile(path.join(fixture.repo, "target.txt"), "utf8")).toBe("feature1\nbase2\nbase3\nbase4\nlocal5\n");
        expect((await gitAsync(fixture.repo, ["status", "--short"])).trim()).toContain("target.txt");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "log.action cherryPick 在保存本地改动后重试若进入冲突态，应返回结构化 merge-conflict 问题",
    async () => {
      const fixture = await createRepoFixture("codexflow-log-cherrypick-retry-conflict");
      try {
        const featureHash = await setupCherryPickRetryConflictAsync(fixture);

        const firstRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "cherryPick",
            hash: featureHash,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(firstRes.ok).toBe(false);
        expect(firstRes.data?.operationProblem?.kind).toBe("local-changes-overwritten");
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("normal");

        const retryPatch = firstRes.data?.operationProblem?.actions?.[0]?.payloadPatch || {};
        const retryRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "cherryPick",
            hash: featureHash,
            autoSaveLocalChanges: true,
            saveChangesPolicy: retryPatch.saveChangesPolicy,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(retryRes.ok).toBe(false);
        expect(retryRes.data?.shouldRefresh).toBe(true);
        expect(retryRes.data?.operationState).toBe("grafting");
        expect(retryRes.data?.operationProblem?.operation).toBe("cherry-pick");
        expect(retryRes.data?.operationProblem?.kind).toBe("merge-conflict");
        expect(retryRes.data?.operationProblem?.title).toBe("Cherry-pick 过程中出现冲突");
        expect(retryRes.data?.preservingState?.status).toBe("kept-saved");
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "log.action cherryPick 遇到首个 empty commit 时应自动 skip，并推进到后续冲突提交",
    async () => {
      const fixture = await createRepoFixture("codexflow-log-cherrypick-empty-then-conflict");
      try {
        const { emptyHash, conflictHash } = await setupCherryPickEmptyThenConflictAsync(fixture);

        const res = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "cherryPick",
            hashes: [emptyHash, conflictHash],
          },
          userDataPath: fixture.userDataPath,
        });

        expect(res.ok).toBe(false);
        expect(res.data?.shouldRefresh).toBe(true);
        expect(res.data?.operationState).toBe("grafting");
        expect(res.data?.operationProblem?.operation).toBe("cherry-pick");
        expect(res.data?.operationProblem?.kind).toBe("merge-conflict");
        expect(res.data?.operationProblem?.title).toBe("Cherry-pick 过程中出现冲突");
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "log.action cherryPick 在存在不相交的 tracked 本地改动时，也应先按优选失败返回且不启动 cherry-pick",
    async () => {
      const fixture = await createRepoFixture("codexflow-log-cherrypick-any-tracked");
      try {
        await clearConsoleEntriesAsync(fixture.userDataPath, fixture.repo);
        await writeFileAsync(fixture.repo, "target.txt", "base\n");
        await gitAsync(fixture.repo, ["add", "target.txt"]);
        await gitAsync(fixture.repo, ["commit", "-m", "add target"]);

        await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
        await writeFileAsync(fixture.repo, "target.txt", "feature\n");
        await gitAsync(fixture.repo, ["add", "target.txt"]);
        await gitAsync(fixture.repo, ["commit", "-m", "feature target"]);
        const featureHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

        await gitAsync(fixture.repo, ["checkout", "master"]);
        await writeFileAsync(fixture.repo, "unrelated.txt", "local only\n");
        await gitAsync(fixture.repo, ["add", "unrelated.txt"]);

        const firstRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "cherryPick",
            hash: featureHash,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(firstRes.ok).toBe(false);
        expect(firstRes.data?.operationProblem?.kind).toBe("local-changes-overwritten");
        expect(firstRes.data?.operationProblem?.files).toEqual(["target.txt"]);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("normal");
        const firstConsoleEntries = await listConsoleEntriesAsync(fixture.userDataPath, fixture.repo);
        expect(firstConsoleEntries.some((item) => String(item.command || "").includes("cherry-pick"))).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "cherry-pick 冲突全部解决后，status.get 应返回建议提交消息，且 commit.create 应完成当前优选",
    async () => {
      const fixture = await createRepoFixture("codexflow-cherry-pick-commit-finish");
      try {
        await setupCherryPickConflictAsync(fixture);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");

        await writeFileAsync(fixture.repo, "conflict.txt", "resolved\n");
        await gitAsync(fixture.repo, ["add", "conflict.txt"]);

        const statusSnapshot = await getStatusSnapshotAsync(fixture.userDataPath, fixture.repo);
        const suggestedMessage = String(statusSnapshot.operationSuggestedCommitMessage || "").trim();
        expect(statusSnapshot.operationState).toBe("grafting");
        expect(suggestedMessage).toContain("feature change");

        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: fixture.repo,
            message: suggestedMessage,
            pushAfter: false,
            includedItems: [{ path: "conflict.txt", kind: "change" }],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(commitRes.ok, String(commitRes.error || "")).toBe(true);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("normal");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "cherry-pick 冲突解决后若结果为空，commit.create 应自动 skip 并结束当前优选",
    async () => {
      const fixture = await createRepoFixture("codexflow-cherry-pick-commit-empty-skip");
      try {
        await setupCherryPickConflictAsync(fixture);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");

        await writeFileAsync(fixture.repo, "conflict.txt", "master\n");
        await gitAsync(fixture.repo, ["add", "conflict.txt"]);

        const statusSnapshot = await getStatusSnapshotAsync(fixture.userDataPath, fixture.repo);
        const suggestedMessage = String(statusSnapshot.operationSuggestedCommitMessage || "").trim();
        expect(statusSnapshot.operationState).toBe("grafting");
        expect(suggestedMessage).toContain("feature change");

        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: fixture.repo,
            message: suggestedMessage,
            pushAfter: false,
            includedItems: [{ path: "conflict.txt", kind: "change" }],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(commitRes.ok, String(commitRes.error || "")).toBe(true);
        expect(commitRes.data?.skippedEmptyCherryPick).toBe(true);
        expect(commitRes.data?.completed).toBe(true);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("normal");
        expect((await gitAsync(fixture.repo, ["log", "-1", "--format=%s"])).trim()).toBe("master change");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "log.action cherryPick 在保存本地改动后，冲突提交完成时应自动恢复本地改动并保留 -x footer",
    async () => {
      const fixture = await createRepoFixture("codexflow-log-cherrypick-preserve-restore");
      try {
        const featureHash = await setupCherryPickPreserveConflictWithUnrelatedLocalChangesAsync(fixture);

        const firstRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "cherryPick",
            hash: featureHash,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(firstRes.ok).toBe(false);
        expect(firstRes.data?.operationProblem?.kind).toBe("local-changes-overwritten");

        const retryPatch = firstRes.data?.operationProblem?.actions?.[0]?.payloadPatch || {};
        const retryRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "cherryPick",
            hash: featureHash,
            autoSaveLocalChanges: true,
            saveChangesPolicy: retryPatch.saveChangesPolicy,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(retryRes.ok).toBe(false);
        expect(retryRes.data?.operationState).toBe("grafting");
        expect(retryRes.data?.preservingState?.status).toBe("kept-saved");

        await writeFileAsync(fixture.repo, "conflict.txt", "resolved\n");
        await gitAsync(fixture.repo, ["add", "conflict.txt"]);

        const statusSnapshot = await getStatusSnapshotAsync(fixture.userDataPath, fixture.repo);
        const suggestedMessage = String(statusSnapshot.operationSuggestedCommitMessage || "").trim();
        expect(suggestedMessage).toContain("feature change");
        expect(suggestedMessage).toContain(`(cherry picked from commit ${featureHash})`);

        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: fixture.repo,
            message: suggestedMessage,
            pushAfter: false,
            includedItems: [{ path: "conflict.txt", kind: "change" }],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(commitRes.ok, String(commitRes.error || "")).toBe(true);
        expect(commitRes.data?.preservingState?.status).toBe("restored");
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("normal");
        expect(await fsp.readFile(path.join(fixture.repo, "local-note.txt"), "utf8")).toBe("local note\n");
        expect((await gitAsync(fixture.repo, ["status", "--short"])).trim()).toContain("local-note.txt");
        expect((await gitAsync(fixture.repo, ["log", "-1", "--format=%B"])).trim()).toContain(`(cherry picked from commit ${featureHash})`);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "log.action cherryPick 在保存本地改动后，空优选 skip 完成时也应自动恢复本地改动",
    async () => {
      const fixture = await createRepoFixture("codexflow-log-cherrypick-preserve-empty-restore");
      try {
        const featureHash = await setupCherryPickPreserveConflictWithUnrelatedLocalChangesAsync(fixture);

        const firstRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "cherryPick",
            hash: featureHash,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(firstRes.ok).toBe(false);
        expect(firstRes.data?.operationProblem?.kind).toBe("local-changes-overwritten");

        const retryPatch = firstRes.data?.operationProblem?.actions?.[0]?.payloadPatch || {};
        const retryRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "cherryPick",
            hash: featureHash,
            autoSaveLocalChanges: true,
            saveChangesPolicy: retryPatch.saveChangesPolicy,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(retryRes.ok).toBe(false);
        expect(retryRes.data?.operationState).toBe("grafting");
        expect(retryRes.data?.preservingState?.status).toBe("kept-saved");

        await writeFileAsync(fixture.repo, "conflict.txt", "master\n");
        await gitAsync(fixture.repo, ["add", "conflict.txt"]);

        const statusSnapshot = await getStatusSnapshotAsync(fixture.userDataPath, fixture.repo);
        const commitRes = await dispatchGitFeatureAction({
          action: "commit.create",
          payload: {
            repoPath: fixture.repo,
            message: String(statusSnapshot.operationSuggestedCommitMessage || "").trim(),
            pushAfter: false,
            includedItems: [{ path: "conflict.txt", kind: "change" }],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(commitRes.ok, String(commitRes.error || "")).toBe(true);
        expect(commitRes.data?.skippedEmptyCherryPick).toBe(true);
        expect(commitRes.data?.preservingState?.status).toBe("restored");
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("normal");
        expect(await fsp.readFile(path.join(fixture.repo, "local-note.txt"), "utf8")).toBe("local note\n");
        expect((await gitAsync(fixture.repo, ["status", "--short"])).trim()).toContain("local-note.txt");
        expect((await gitAsync(fixture.repo, ["log", "-1", "--format=%s"])).trim()).toBe("master change");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "changes.restoreFromRevision 遇到本地已修改文件时应先确认，再允许覆盖恢复",
    async () => {
      const fixture = await createRepoFixture("codexflow-restore-from-revision-overwrite");
      try {
        await writeFileAsync(fixture.repo, "conflict.txt", "local\n");

        const firstRes = await dispatchGitFeatureAction({
          action: "changes.restoreFromRevision",
          payload: {
            repoPath: fixture.repo,
            files: ["conflict.txt"],
            revision: "HEAD",
          },
          userDataPath: fixture.userDataPath,
        });

        expect(firstRes.ok).toBe(false);
        expect(firstRes.data?.operationProblem?.kind).toBe("local-changes-overwritten");
        expect(firstRes.data?.operationProblem?.title).toBe("获取修订");
        expect(firstRes.data?.operationProblem?.files).toEqual(["conflict.txt"]);
        expect(firstRes.data?.operationProblem?.actions?.[0]?.label).toBe("覆盖已修改的文件");
        expect(await fsp.readFile(path.join(fixture.repo, "conflict.txt"), "utf8")).toBe("local\n");

        const retryRes = await dispatchGitFeatureAction({
          action: "changes.restoreFromRevision",
          payload: {
            repoPath: fixture.repo,
            files: ["conflict.txt"],
            revision: "HEAD",
            overwriteModified: true,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(retryRes.ok).toBe(true);
        expect(await fsp.readFile(path.join(fixture.repo, "conflict.txt"), "utf8")).toBe("base\n");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );
});

describe("featureService branch pull-like actions", () => {
  it(
    "checkout 远端分支时应优先落到本地分支，而不是进入 detached HEAD",
    async () => {
      const fixture = await createRepoFixture("codexflow-branch-checkout-remote-local");
      const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-checkout-remote-local-origin-"));
      try {
        const remoteRepo = path.join(remoteRoot, "origin.git");
        await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);
        await gitAsync(fixture.repo, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(fixture.repo, ["push", "-u", "origin", "HEAD:master"]);
        await gitAsync(fixture.repo, ["checkout", "-b", "feature/demo"]);

        const checkoutRes = await dispatchGitFeatureAction({
          action: "branch.switch",
          payload: {
            repoPath: fixture.repo,
            ref: "origin/master",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(checkoutRes.ok).toBe(true);
        expect((await gitAsync(fixture.repo, ["branch", "--show-current"])).trim()).toBe("master");
        expect((await gitAsync(fixture.repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])).trim()).toBe("origin/master");
      } finally {
        await fixture.cleanup();
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 },
  );

  it(
    "checkoutUpdate 成功后应保留智能签出的恢复结果，供前端继续展示交互入口",
    async () => {
      const fixture = await createRepoFixture("codexflow-branch-checkout-update-smart");
      const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-checkout-update-smart-origin-"));
      try {
        const remoteRepo = path.join(remoteRoot, "origin.git");
        await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);
        await gitAsync(fixture.repo, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(fixture.repo, ["push", "-u", "origin", "HEAD:master"]);

        await writeFileAsync(fixture.repo, "conflict.txt", "line1\nline2\nline3\n");
        await gitAsync(fixture.repo, ["add", "conflict.txt"]);
        await gitAsync(fixture.repo, ["commit", "-m", "prepare smart checkout base"]);
        await gitAsync(fixture.repo, ["push", "origin", "HEAD:master"]);

        await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
        await writeFileAsync(fixture.repo, "conflict.txt", "line1-feature\nline2\nline3\n");
        await gitAsync(fixture.repo, ["add", "conflict.txt"]);
        await gitAsync(fixture.repo, ["commit", "-m", "feature change"]);
        await gitAsync(fixture.repo, ["push", "-u", "origin", "HEAD:feature"]);

        await gitAsync(fixture.repo, ["checkout", "master"]);
        await writeFileAsync(fixture.repo, "conflict.txt", "line1\nline2\nline3-local\n");

        const checkoutUpdateRes = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: fixture.repo,
            action: "checkoutUpdate",
            ref: "feature",
            smartCheckout: true,
            saveChangesPolicy: "stash",
          },
          userDataPath: fixture.userDataPath,
        });

        expect(checkoutUpdateRes.ok).toBe(true);
        expect((await gitAsync(fixture.repo, ["branch", "--show-current"])).trim()).toBe("feature");
        expect(checkoutUpdateRes.data?.smartCheckoutResult).toEqual(expect.objectContaining({
          savedLocalChanges: true,
          restoredLocalChanges: true,
          preservingState: expect.objectContaining({
            status: "restored",
          }),
        }));
        expect(await fsp.readFile(path.join(fixture.repo, "conflict.txt"), "utf8")).toBe("line1-feature\nline2\nline3-local\n");
      } finally {
        await fixture.cleanup();
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 },
  );

  it(
    "mergeIntoBranch 冲突时应返回结构化 operationProblem 并要求刷新",
    async () => {
      const fixture = await createRepoFixture("codexflow-branch-merge-problem");
      try {
        await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
        await commitConflictChangeAsync(fixture.repo, "feature", "feature\n", "feature change");
        await gitAsync(fixture.repo, ["checkout", "master"]);
        await commitConflictChangeAsync(fixture.repo, "master", "master\n", "master change");

        const mergeRes = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: fixture.repo,
            action: "mergeIntoBranch",
            base: "master",
            source: "feature",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(mergeRes.ok).toBe(false);
        expect(mergeRes.data?.shouldRefresh).toBe(true);
        expect(mergeRes.data?.operationProblem?.kind).toBe("merge-conflict");
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("merging");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "rebaseBranchTo 命中 Merge 提交时应返回统一 rebaseWarning",
    async () => {
      const fixture = await createRepoFixture("codexflow-branch-rebase-warning");
      try {
        await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
        await commitConflictChangeAsync(fixture.repo, "feature", "feature\n", "feature change");
        await gitAsync(fixture.repo, ["checkout", "-b", "topic"]);
        await commitConflictChangeAsync(fixture.repo, "topic", "topic\n", "topic change");
        await gitAsync(fixture.repo, ["checkout", "feature"]);
        await gitAsync(fixture.repo, ["merge", "--no-ff", "topic", "-m", "merge topic"]);

        const rebaseRes = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: fixture.repo,
            action: "rebaseBranchTo",
            base: "feature",
            target: "master",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(rebaseRes.ok).toBe(false);
        expect(rebaseRes.data?.resultCode).toBe("CANCEL");
        expect(rebaseRes.data?.rebaseWarning?.type).toBe("merge-commits");
        expect(rebaseRes.data?.rebaseWarning?.alternativeAction?.payloadPatch).toEqual({
          updateMethod: "merge",
        });
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "pullRemote(mode=rebase) 命中 Merge 提交时也应返回统一 rebaseWarning",
    async () => {
      const fixture = await createRepoFixture("codexflow-branch-pull-remote-warning");
      const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-pull-remote-origin-"));
      try {
        const remoteRepo = path.join(remoteRoot, "origin.git");
        await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);
        await gitAsync(fixture.repo, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(fixture.repo, ["push", "-u", "origin", "master"]);

        await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
        await commitConflictChangeAsync(fixture.repo, "feature", "feature\n", "feature change");
        await gitAsync(fixture.repo, ["checkout", "-b", "topic"]);
        await commitConflictChangeAsync(fixture.repo, "topic", "topic\n", "topic change");
        await gitAsync(fixture.repo, ["checkout", "feature"]);
        await gitAsync(fixture.repo, ["merge", "--no-ff", "topic", "-m", "merge topic"]);

        const pullRes = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: fixture.repo,
            action: "pullRemote",
            ref: "origin/master",
            mode: "rebase",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(pullRes.ok).toBe(false);
        expect(pullRes.data?.resultCode).toBe("CANCEL");
        expect(pullRes.data?.rebaseWarning?.type).toBe("merge-commits");
      } finally {
        await fixture.cleanup();
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 90_000 },
  );

  it(
    "pullRemote(mode=merge) 应直接执行 git pull，而不是显式 fetch + update 主链",
    async () => {
      const fixture = await createRepoFixture("codexflow-branch-pull-remote-direct");
      const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-pull-remote-direct-origin-"));
      const peerRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-pull-remote-direct-peer-"));
      try {
        const remoteRepo = path.join(remoteRoot, "origin.git");
        await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);
        await gitAsync(fixture.repo, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(fixture.repo, ["push", "-u", "origin", "HEAD:master"]);

        await gitAsync(peerRoot, ["clone", "--branch", "master", remoteRepo, "writer"]);
        const writerRepo = path.join(peerRoot, "writer");
        await gitAsync(writerRepo, ["config", "user.name", "CodexFlow"]);
        await gitAsync(writerRepo, ["config", "user.email", "codexflow@example.com"]);
        await writeFileAsync(writerRepo, "conflict.txt", "remote change\n");
        await gitAsync(writerRepo, ["add", "conflict.txt"]);
        await gitAsync(writerRepo, ["commit", "-m", "remote update"]);
        await gitAsync(writerRepo, ["push", "origin", "HEAD:master"]);

        await clearConsoleEntriesAsync(fixture.userDataPath, fixture.repo);
        const pullRes = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: fixture.repo,
            action: "pullRemote",
            ref: "origin/master",
            mode: "merge",
            options: ["ffOnly"],
            ffOnly: true,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(pullRes.ok).toBe(true);
        expect(await gitAsync(fixture.repo, ["show", "HEAD:conflict.txt"])).toBe("remote change\n");

        const commands = (await listConsoleEntriesAsync(fixture.userDataPath, fixture.repo))
          .filter((entry) => String(entry.cwd || "").trim() === fixture.repo)
          .map((entry) => String(entry.command || ""));
        expect(commands.some((command) => /\bpull\b/.test(command) && command.includes("--ff-only") && command.includes("origin") && command.includes("master"))).toBe(true);
        expect(commands.some((command) => /\bfetch\b/.test(command))).toBe(false);
      } finally {
        await fixture.cleanup();
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(peerRoot, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 },
  );
});

describe("featureService branch tag actions", () => {
  it(
    "deleteTag 成功后应返回恢复信息，并允许通过 restoreTag 复原标签",
    async () => {
      const fixture = await createRepoFixture("codexflow-branch-delete-tag-recovery");
      try {
        await gitAsync(fixture.repo, ["tag", "release/v1"]);
        const deletedTagTarget = (await gitAsync(fixture.repo, ["rev-parse", "refs/tags/release/v1^{}"])).trim();

        const deleteRes = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: fixture.repo,
            action: "deleteTag",
            name: "release/v1",
          },
          userDataPath: fixture.userDataPath,
        });

        expect(deleteRes.ok).toBe(true);
        expect(deleteRes.data).toEqual(expect.objectContaining({
          deletedTagName: "release/v1",
          deletedTagTarget,
        }));
        expect((await gitAsync(fixture.repo, ["tag", "--list", "release/v1"])).trim()).toBe("");

        const restoreRes = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: fixture.repo,
            action: "restoreTag",
            name: "release/v1",
            target: deletedTagTarget,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(restoreRes.ok).toBe(true);
        expect((await gitAsync(fixture.repo, ["rev-parse", "refs/tags/release/v1^{}"])).trim()).toBe(deletedTagTarget);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );
});

describe("featureService dedicated file history", () => {
  it("log.get 在文件历史模式下应以非 --follow 首段遍历跨 rename 聚合历史", async () => {
    const fixture = await createRepoFixture("codexflow-file-history");
    try {
      await commitFileChangeAsync(fixture.repo, "conflict.txt", "old change\n", "edit old");
      await renameTrackedFileAsync(fixture.repo, "conflict.txt", "renamed.txt", "rename commit\n", "rename file");
      await commitFileChangeAsync(fixture.repo, "renamed.txt", "after rename\n", "edit renamed");
      await clearConsoleEntriesAsync(fixture.userDataPath, fixture.repo);

      const logRes = await dispatchGitFeatureAction({
        action: "log.get",
        payload: {
          repoPath: fixture.repo,
          cursor: 0,
          limit: 20,
          filters: {
            branch: "all",
            author: "",
            path: "renamed.txt",
            revision: "",
            dateFrom: "",
            dateTo: "",
            text: "",
            caseSensitive: false,
            followRenames: true,
            matchMode: "fuzzy",
          },
        },
        userDataPath: fixture.userDataPath,
      });

      expect(logRes.ok).toBe(true);
      const subjects = Array.isArray(logRes.data?.items)
        ? logRes.data.items.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      expect(subjects).toEqual(expect.arrayContaining([
        "edit renamed",
        "rename file",
        "edit old",
        "base",
      ]));
      const historyPathBySubject = Array.isArray(logRes.data?.items)
        ? new Map(logRes.data.items.map((item: { subject?: string; historyPath?: string }) => [
          String(item?.subject || ""),
          String(item?.historyPath || ""),
        ]))
        : new Map<string, string>();
      expect(historyPathBySubject.get("edit renamed")).toBe("renamed.txt");
      expect(historyPathBySubject.get("rename file")).toBe("renamed.txt");
      expect(historyPathBySubject.get("edit old")).toBe("conflict.txt");
      expect(historyPathBySubject.get("base")).toBe("conflict.txt");

      const commands = (await listConsoleEntriesAsync(fixture.userDataPath, fixture.repo))
        .map((entry) => String(entry.command || ""))
        .filter((command) => command.includes(" log ") || command.includes(" diff-tree ") || command.includes(" show "));
      expect(commands.some((command) => command.includes(" log ") && command.includes("--follow"))).toBe(false);
      expect(commands.some((command) => command.includes(" diff-tree --no-commit-id --name-status -r -M"))).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("普通日志模式应返回超过可见页的 graphItems，上下文不足时不要把图谱压缩成单页子图", async () => {
    const fixture = await createRepoFixture("codexflow-log-graph-context");
    try {
      for (let index = 1; index <= 24; index += 1) {
        await commitFileChangeAsync(fixture.repo, "conflict.txt", `change ${index}\n`, `commit ${index}`);
      }

      const logRes = await dispatchGitFeatureAction({
        action: "log.get",
        payload: {
          repoPath: fixture.repo,
          cursor: 0,
          limit: 20,
          filters: {
            branch: "all",
            author: "",
            path: "",
            revision: "",
            dateFrom: "",
            dateTo: "",
            text: "",
            caseSensitive: false,
            followRenames: false,
            matchMode: "fuzzy",
          },
        },
        userDataPath: fixture.userDataPath,
      });

      expect(logRes.ok).toBe(true);
      const visibleSubjects = Array.isArray(logRes.data?.items)
        ? logRes.data.items.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      const graphSubjects = Array.isArray(logRes.data?.graphItems)
        ? logRes.data.graphItems.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];

      expect(visibleSubjects).toHaveLength(20);
      expect(visibleSubjects[0]).toBe("commit 24");
      expect(visibleSubjects[19]).toBe("commit 5");
      expect(graphSubjects.slice(0, visibleSubjects.length)).toEqual(visibleSubjects);
      expect(graphSubjects).toHaveLength(25);
      expect(graphSubjects[20]).toBe("commit 4");
      expect(graphSubjects[24]).toBe("base");
    } finally {
      await fixture.cleanup();
    }
  });

  it("普通日志模式不应把 stash 三连记录混入提交历史", async () => {
    const fixture = await createRepoFixture("codexflow-log-stash-filter");
    try {
      await commitFileChangeAsync(fixture.repo, "conflict.txt", "commit 1\n", "commit 1");
      await commitFileChangeAsync(fixture.repo, "conflict.txt", "commit 2\n", "commit 2");
      await writeFileAsync(fixture.repo, "conflict.txt", "staged stash change\n");
      await gitAsync(fixture.repo, ["add", "conflict.txt"]);
      await writeFileAsync(fixture.repo, "untracked.txt", "untracked stash change\n");
      await gitAsync(fixture.repo, ["stash", "push", "--include-untracked"]);
      await clearConsoleEntriesAsync(fixture.userDataPath, fixture.repo);

      const rawAllSubjects: string[] = (await gitAsync(fixture.repo, ["log", "--all", "--format=%s"]))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      expect(rawAllSubjects.some((subject) => isStashSyntheticSubject(subject))).toBe(true);
      expect(rawAllSubjects.some((subject) => subject.startsWith("index on master:"))).toBe(true);
      expect(rawAllSubjects.some((subject) => subject.startsWith("untracked files on master:"))).toBe(true);

      const logRes = await dispatchGitFeatureAction({
        action: "log.get",
        payload: {
          repoPath: fixture.repo,
          cursor: 0,
          limit: 20,
          filters: {
            branch: "all",
            author: "",
            path: "",
            revision: "",
            dateFrom: "",
            dateTo: "",
            text: "",
            caseSensitive: false,
            followRenames: false,
            matchMode: "fuzzy",
          },
        },
        userDataPath: fixture.userDataPath,
      });

      expect(logRes.ok).toBe(true);
      const visibleSubjects: string[] = Array.isArray(logRes.data?.items)
        ? logRes.data.items.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      const graphSubjects: string[] = Array.isArray(logRes.data?.graphItems)
        ? logRes.data.graphItems.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];

      expect(visibleSubjects.some((subject) => isStashSyntheticSubject(subject))).toBe(false);
      expect(graphSubjects.some((subject) => isStashSyntheticSubject(subject))).toBe(false);

      const commands = (await listConsoleEntriesAsync(fixture.userDataPath, fixture.repo))
        .map((entry) => String(entry.command || ""))
        .filter((command) => command.includes(" log "));
      expect(commands.some((command) =>
        command.includes("log")
        && command.includes("HEAD")
        && command.includes("--branches")
        && command.includes("--remotes")
        && command.includes("--tags"),
      )).toBe(true);
      expect(commands.some((command) => command.includes("log") && command.includes("--all"))).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("featureService log filters", () => {
  it("文本框输入短哈希时应命中对应提交，且 graphItems 与 items 保持一致", async () => {
    const fixture = await createRepoFixture("codexflow-log-hash-filter");
    try {
      await commitFileChangeAsync(fixture.repo, "conflict.txt", "alpha\n", "alpha commit");
      await commitFileChangeAsync(fixture.repo, "conflict.txt", "target\n", "target commit");
      const targetHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();
      await commitFileChangeAsync(fixture.repo, "conflict.txt", "omega\n", "omega commit");

      const logRes = await dispatchGitFeatureAction({
        action: "log.get",
        payload: {
          repoPath: fixture.repo,
          cursor: 0,
          limit: 20,
          filters: {
            branch: "all",
            branchValues: [],
            author: "",
            authorValues: [],
            path: "",
            revision: "",
            dateFrom: "",
            dateTo: "",
            text: targetHash.slice(0, 8),
            caseSensitive: false,
            followRenames: false,
            matchMode: "fuzzy",
          },
        },
        userDataPath: fixture.userDataPath,
      });

      expect(logRes.ok).toBe(true);
      const visibleSubjects = Array.isArray(logRes.data?.items)
        ? logRes.data.items.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      const graphSubjects = Array.isArray(logRes.data?.graphItems)
        ? logRes.data.graphItems.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      expect(visibleSubjects).toEqual(["target commit"]);
      expect(graphSubjects).toEqual(["target commit"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("文本筛选分页应按过滤后结果推进，而不是按原始 git log 游标错位", async () => {
    const fixture = await createRepoFixture("codexflow-log-filtered-pagination");
    try {
      for (let index = 1; index <= 50; index += 1) {
        const subject = index % 2 === 0 ? `keep ${index}` : `skip ${index}`;
        await commitFileChangeAsync(fixture.repo, "conflict.txt", `${subject}\n`, subject);
      }

      const firstRes = await dispatchGitFeatureAction({
        action: "log.get",
        payload: {
          repoPath: fixture.repo,
          cursor: 0,
          limit: 20,
          filters: {
            branch: "all",
            branchValues: [],
            author: "",
            authorValues: [],
            path: "",
            revision: "",
            dateFrom: "",
            dateTo: "",
            text: "keep",
            caseSensitive: false,
            followRenames: false,
            matchMode: "exact",
          },
        },
        userDataPath: fixture.userDataPath,
      });

      expect(firstRes.ok).toBe(true);
      expect(firstRes.data?.nextCursor).toBe(20);
      expect(firstRes.data?.hasMore).toBe(true);
      const firstSubjects = Array.isArray(firstRes.data?.items)
        ? firstRes.data.items.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      const firstGraphSubjects = Array.isArray(firstRes.data?.graphItems)
        ? firstRes.data.graphItems.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      expect(firstSubjects).toHaveLength(20);
      expect(firstSubjects[0]).toBe("keep 50");
      expect(firstSubjects[19]).toBe("keep 12");
      expect(firstGraphSubjects).toEqual(firstSubjects);

      const secondRes = await dispatchGitFeatureAction({
        action: "log.get",
        payload: {
          repoPath: fixture.repo,
          cursor: firstRes.data?.nextCursor || 0,
          limit: 20,
          filters: {
            branch: "all",
            branchValues: [],
            author: "",
            authorValues: [],
            path: "",
            revision: "",
            dateFrom: "",
            dateTo: "",
            text: "keep",
            caseSensitive: false,
            followRenames: false,
            matchMode: "exact",
          },
        },
        userDataPath: fixture.userDataPath,
      });

      expect(secondRes.ok).toBe(true);
      expect(secondRes.data?.hasMore).toBe(false);
      const secondSubjects = Array.isArray(secondRes.data?.items)
        ? secondRes.data.items.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      const secondGraphSubjects = Array.isArray(secondRes.data?.graphItems)
        ? secondRes.data.graphItems.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      expect(secondSubjects).toEqual(["keep 10", "keep 8", "keep 6", "keep 4", "keep 2"]);
      expect(secondGraphSubjects).toEqual(secondSubjects);
    } finally {
      await fixture.cleanup();
    }
  });

  it("作者多选筛选应使用 OR 语义，并保持图谱与可见列表同源", async () => {
    const fixture = await createRepoFixture("codexflow-log-author-multi");
    try {
      await commitFileChangeWithAuthorAsync(fixture.repo, "conflict.txt", "alice\n", "alice commit", "Alice", "alice@example.com");
      await commitFileChangeWithAuthorAsync(fixture.repo, "conflict.txt", "bob\n", "bob commit", "Bob", "bob@example.com");
      await commitFileChangeWithAuthorAsync(fixture.repo, "conflict.txt", "carol\n", "carol commit", "Carol", "carol@example.com");

      const logRes = await dispatchGitFeatureAction({
        action: "log.get",
        payload: {
          repoPath: fixture.repo,
          cursor: 0,
          limit: 20,
          filters: {
            branch: "all",
            branchValues: [],
            author: "",
            authorValues: ["Alice", "Bob"],
            path: "",
            revision: "",
            dateFrom: "",
            dateTo: "",
            text: "",
            caseSensitive: false,
            followRenames: false,
            matchMode: "fuzzy",
          },
        },
        userDataPath: fixture.userDataPath,
      });

      expect(logRes.ok).toBe(true);
      const visibleSubjects = Array.isArray(logRes.data?.items)
        ? logRes.data.items.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      const graphSubjects = Array.isArray(logRes.data?.graphItems)
        ? logRes.data.graphItems.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      expect(visibleSubjects).toEqual(["bob commit", "alice commit"]);
      expect(graphSubjects).toEqual(visibleSubjects);
    } finally {
      await fixture.cleanup();
    }
  });

  it("分支多选筛选应只返回所选分支可达的提交并排除未选分支", async () => {
    const fixture = await createRepoFixture("codexflow-log-branch-multi");
    try {
      await gitAsync(fixture.repo, ["checkout", "-b", "feature"]);
      await commitFileChangeAsync(fixture.repo, "conflict.txt", "feature\n", "feature only");
      await gitAsync(fixture.repo, ["checkout", "master"]);
      await gitAsync(fixture.repo, ["checkout", "-b", "other"]);
      await commitFileChangeAsync(fixture.repo, "conflict.txt", "other\n", "other only");
      await gitAsync(fixture.repo, ["checkout", "master"]);
      await commitFileChangeAsync(fixture.repo, "conflict.txt", "master\n", "master only");

      const logRes = await dispatchGitFeatureAction({
        action: "log.get",
        payload: {
          repoPath: fixture.repo,
          cursor: 0,
          limit: 20,
          filters: {
            branch: "all",
            branchValues: ["master", "feature"],
            author: "",
            authorValues: [],
            path: "",
            revision: "",
            dateFrom: "",
            dateTo: "",
            text: "",
            caseSensitive: false,
            followRenames: false,
            matchMode: "fuzzy",
          },
        },
        userDataPath: fixture.userDataPath,
      });

      expect(logRes.ok).toBe(true);
      const visibleSubjects = Array.isArray(logRes.data?.items)
        ? logRes.data.items.map((item: { subject?: string }) => String(item?.subject || ""))
        : [];
      expect(visibleSubjects).toEqual(expect.arrayContaining(["master only", "feature only", "base"]));
      expect(visibleSubjects).not.toContain("other only");
    } finally {
      await fixture.cleanup();
    }
  });
});

describe("featureService autosquash alignment", () => {
  it("status.get 应在仅剩 sequencer 的 cherry-pick 状态下仍识别为 grafting", async () => {
    const fixture = await createRepoFixture("codexflow-log-availability-sequencer");
    try {
      await setupCherryPickSequencerStateWithoutPseudoRefAsync(fixture);
      expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");

      const headHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();
      const availabilityRes = await dispatchGitFeatureAction({
        action: "log.availability",
        payload: {
          repoPath: fixture.repo,
          hashes: [headHash],
          selectionCount: 1,
        },
        userDataPath: fixture.userDataPath,
      });

      expect(availabilityRes.ok).toBe(true);
      expect(availabilityRes.data?.actions?.cherryPick?.enabled).toBe(false);
      expect(availabilityRes.data?.actions?.cherryPick?.reason).toBe("当前仓库已有进行中的 Git 操作");
    } finally {
      await fixture.cleanup();
    }
  }, { timeout: 90_000 });

  it("log.availability 应在 cherry-pick 进行中时禁用再次优选与还原提交", async () => {
    const fixture = await createRepoFixture("codexflow-log-availability-grafting");
    try {
      await setupCherryPickConflictAsync(fixture);
      expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("grafting");
      const headHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

      const availabilityRes = await dispatchGitFeatureAction({
        action: "log.availability",
        payload: {
          repoPath: fixture.repo,
          hashes: [headHash],
          selectionCount: 1,
        },
        userDataPath: fixture.userDataPath,
      });

      expect(availabilityRes.ok).toBe(true);
      expect(availabilityRes.data?.actions?.cherryPick?.enabled).toBe(false);
      expect(availabilityRes.data?.actions?.cherryPick?.reason).toBe("当前仓库已有进行中的 Git 操作");
      expect(availabilityRes.data?.actions?.revert?.enabled).toBe(false);
      expect(availabilityRes.data?.actions?.revert?.reason).toBe("当前仓库已有进行中的 Git 操作");
    } finally {
      await fixture.cleanup();
    }
  }, { timeout: 90_000 });

  it("log.availability 应以显式 selectionCount 作为 fixup/squashTo 可用性的真相源", async () => {
    const fixture = await createRepoFixture("codexflow-log-availability-selection");
    try {
      const headHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

      const disabledRes = await dispatchGitFeatureAction({
        action: "log.availability",
        payload: {
          repoPath: fixture.repo,
          hashes: [headHash],
          selectionCount: 0,
        },
        userDataPath: fixture.userDataPath,
      });
      expect(disabledRes.ok).toBe(true);
      expect(disabledRes.data?.actions?.fixup?.enabled).toBe(false);
      expect(disabledRes.data?.actions?.squashTo?.enabled).toBe(false);
      expect(disabledRes.data?.actions?.fixup?.reason).toBe("当前没有已选中的可提交改动");

      const enabledRes = await dispatchGitFeatureAction({
        action: "log.availability",
        payload: {
          repoPath: fixture.repo,
          hashes: [headHash],
          selectionCount: 1,
        },
        userDataPath: fixture.userDataPath,
      });
      expect(enabledRes.ok).toBe(true);
      expect(enabledRes.data?.actions?.fixup?.enabled).toBe(true);
      expect(enabledRes.data?.actions?.squashTo?.enabled).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    {
      action: "fixup",
      expectedSubject: "fixup! target commit",
    },
    {
      action: "squashTo",
      expectedSubject: "squash! target commit",
    },
  ])(
    "$action 不应通过 git add -A 偷带整仓改动进入提交",
    async ({ action, expectedSubject }) => {
      const fixture = await createRepoFixture(`codexflow-autosquash-${action}`);
      try {
        await commitFileChangeAsync(fixture.repo, "selected.txt", "base\n", "add selected");
        await commitFileChangeAsync(fixture.repo, "other.txt", "base\n", "add other");
        await commitFileChangeAsync(fixture.repo, "target.txt", "target\n", "target commit");
        const targetHash = (await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

        await writeFileAsync(fixture.repo, "selected.txt", "selected change\n");
        await writeFileAsync(fixture.repo, "other.txt", "other change\n");

        const actionRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action,
            hash: targetHash,
            commitPayload: {
              message: "",
              pushAfter: false,
              selections: [
                {
                  repoRoot: fixture.repo,
                  changeListId: "default",
                  path: "selected.txt",
                  kind: "change",
                  selectionMode: "full-file",
                },
              ],
            },
          },
          userDataPath: fixture.userDataPath,
        });

        expect(actionRes.ok).toBe(true);
        expect((await gitAsync(fixture.repo, ["log", "-1", "--format=%s"])).trim()).toBe(expectedSubject);
        expect((await gitAsync(fixture.repo, ["show", "--pretty=format:", "--name-only", "HEAD"]))
          .split(/\r?\n/)
          .filter(Boolean))
          .toEqual(["selected.txt"]);
        expect((await gitAsync(fixture.repo, ["status", "--porcelain"]))
          .split(/\r?\n/)
          .filter(Boolean))
          .toEqual([" M other.txt"]);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );
});
