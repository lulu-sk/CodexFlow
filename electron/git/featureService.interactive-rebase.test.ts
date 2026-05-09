import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { execGitAsync } from "./exec";
import { dispatchGitFeatureAction } from "./featureService";

type RepoFixture = {
  repo: string;
  userDataPath: string;
  cleanup(): Promise<void>;
};

/**
 * 在测试仓库执行 Git 命令，失败时直接抛出断言，减少样板处理。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 30_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

/**
 * 创建一个带默认用户信息的线性测试仓库。
 */
async function createRepoFixture(prefix: string): Promise<RepoFixture> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-repo-`));
  const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-userdata-`));
  await gitAsync(repo, ["init", "-b", "master"]);
  await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);
  await gitAsync(repo, ["config", "core.autocrlf", "false"]);
  await gitAsync(repo, ["config", "core.eol", "lf"]);
  await writeFileAsync(repo, "base.txt", "base\n");
  await gitAsync(repo, ["add", "base.txt"]);
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
 * 向测试仓库写入文件内容，必要时自动补齐目录。
 */
async function writeFileAsync(repo: string, relativePath: string, content: string): Promise<void> {
  const absolutePath = path.join(repo, relativePath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await fsp.writeFile(absolutePath, content, "utf8");
}

/**
 * 追加一个简单提交，默认每个提交改不同文件，便于 rebase/reorder 时保持无冲突。
 */
async function appendCommitAsync(repo: string, fileName: string, content: string, message: string): Promise<string> {
  await writeFileAsync(repo, fileName, content);
  await gitAsync(repo, ["add", fileName]);
  await gitAsync(repo, ["commit", "-m", message]);
  return String(await gitAsync(repo, ["rev-parse", "HEAD"])).trim();
}

/**
 * 读取当前仓库的 operationState，复用真实 `status.get` 契约做断言。
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

describe("featureService interactive rebase", () => {
  it(
    "log.rebasePlan.get 应按 oldest -> newest 返回 first-parent 线性计划",
    async () => {
      const fixture = await createRepoFixture("codexflow-rebase-plan");
      try {
        const firstHash = await appendCommitAsync(fixture.repo, "one.txt", "one\n", "one");
        const headHash = await appendCommitAsync(fixture.repo, "two.txt", "two\n", "two");

        const res = await dispatchGitFeatureAction({
          action: "log.rebasePlan.get",
          payload: { repoPath: fixture.repo, targetHash: firstHash },
          userDataPath: fixture.userDataPath,
        });

        expect(res.ok).toBe(true);
        expect(res.data?.targetHash).toBe(firstHash);
        expect(res.data?.headHash).toBe(headHash);
        expect(res.data?.rootMode).toBe(false);
        expect(res.data?.entries?.map((entry: { hash: string }) => entry.hash)).toEqual([firstHash, headHash]);
        expect(res.data?.warnings).toBeUndefined();
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "log.rebasePlan.get 检测到 autosquash 与 updateRefs 时应返回结构化 warning",
    async () => {
      const fixture = await createRepoFixture("codexflow-rebase-plan-warning");
      try {
        await gitAsync(fixture.repo, ["config", "rebase.updateRefs", "true"]);
        const firstHash = await appendCommitAsync(fixture.repo, "one.txt", "one\n", "one");
        await appendCommitAsync(fixture.repo, "two.txt", "two\n", "fixup! one");

        const res = await dispatchGitFeatureAction({
          action: "log.rebasePlan.get",
          payload: { repoPath: fixture.repo, targetHash: firstHash },
          userDataPath: fixture.userDataPath,
        });

        expect(res.ok).toBe(true);
        expect(res.data?.warnings?.map((warning: { code: string }) => warning.code)).toEqual(["autosquash", "update-refs"]);
        expect(res.data?.entries?.[1]?.autosquashCandidate).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "log.rebasePlan.get 命中 merge commit 时应返回结构化 reason code",
    async () => {
      const fixture = await createRepoFixture("codexflow-rebase-plan-merge");
      try {
        const defaultBranch = "master";
        await appendCommitAsync(fixture.repo, "main.txt", "main-1\n", "main-1");
        await gitAsync(fixture.repo, ["checkout", "-b", "feature/rebase-merge"]);
        const featureHash = await appendCommitAsync(fixture.repo, "feature.txt", "feature\n", "feature");
        await gitAsync(fixture.repo, ["checkout", defaultBranch]);
        await appendCommitAsync(fixture.repo, "main.txt", "main-2\n", "main-2");
        await gitAsync(fixture.repo, ["merge", "--no-ff", "feature/rebase-merge", "-m", "merge feature"]);
        const mergeHash = String(await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

        const res = await dispatchGitFeatureAction({
          action: "log.rebasePlan.get",
          payload: { repoPath: fixture.repo, targetHash: mergeHash },
          userDataPath: fixture.userDataPath,
        });

        expect(res.ok).toBe(false);
        expect(res.data?.reasonCode).toBe("merge-commit");
        expect(res.data?.historyRewriteFeedback).toEqual(
          expect.objectContaining({
            action: "interactive-rebase",
            tone: "danger",
            completed: false,
            reasonCode: "merge-commit",
          }),
        );
        expect(String(res.error || "")).toContain("合并提交");
        expect(featureHash).not.toBe(mergeHash);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "log.availability 在 merge commit 上仍应保留 interactive rebase 入口，供前端走终端回退",
    async () => {
      const fixture = await createRepoFixture("codexflow-rebase-availability-merge");
      try {
        await appendCommitAsync(fixture.repo, "main.txt", "main-1\n", "main-1");
        await gitAsync(fixture.repo, ["checkout", "-b", "feature/rebase-availability"]);
        await appendCommitAsync(fixture.repo, "feature.txt", "feature\n", "feature");
        await gitAsync(fixture.repo, ["checkout", "master"]);
        await appendCommitAsync(fixture.repo, "main.txt", "main-2\n", "main-2");
        await gitAsync(fixture.repo, ["merge", "--no-ff", "feature/rebase-availability", "-m", "merge feature"]);
        const mergeHash = String(await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();

        const availabilityRes = await dispatchGitFeatureAction({
          action: "log.availability",
          payload: {
            repoPath: fixture.repo,
            hashes: [mergeHash],
            selectionCount: 1,
          },
          userDataPath: fixture.userDataPath,
        });

        expect(availabilityRes.ok).toBe(true);
        expect(availabilityRes.data?.actions?.interactiveRebase?.enabled).toBe(true);
        expect(String(availabilityRes.data?.actions?.interactiveRebase?.reason || "")).toBe("");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "log.rebasePlan.run 应支持重排并 reword 历史提交",
    async () => {
      const fixture = await createRepoFixture("codexflow-rebase-run-reword");
      try {
        const firstHash = await appendCommitAsync(fixture.repo, "one.txt", "one\n", "one");
        await appendCommitAsync(fixture.repo, "two.txt", "two\n", "two");

        const planRes = await dispatchGitFeatureAction({
          action: "log.rebasePlan.get",
          payload: { repoPath: fixture.repo, targetHash: firstHash },
          userDataPath: fixture.userDataPath,
        });
        expect(planRes.ok).toBe(true);
        const entries = planRes.data?.entries || [];
        expect(entries).toHaveLength(2);

        const runRes = await dispatchGitFeatureAction({
          action: "log.rebasePlan.run",
          payload: {
            repoPath: fixture.repo,
            targetHash: planRes.data?.targetHash,
            headHash: planRes.data?.headHash,
            entries: [
              { hash: entries[1]?.hash, action: "pick" },
              { hash: entries[0]?.hash, action: "reword", message: "one rewritten" },
            ],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(runRes.ok).toBe(true);
        expect(runRes.data?.completed).toBe(true);
        expect(runRes.data?.historyRewriteFeedback).toEqual(
          expect.objectContaining({
            action: "interactive-rebase",
            tone: "info",
            completed: true,
            shouldRefresh: true,
          }),
        );

        const subjects = String(await gitAsync(fixture.repo, ["log", "--format=%s", "--max-count=2"])).trim().split(/\r?\n/);
        expect(subjects).toEqual(["one rewritten", "two"]);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "log.rebasePlan.run 应支持 squash 并写入自定义最终消息",
    async () => {
      const fixture = await createRepoFixture("codexflow-rebase-run-squash");
      try {
        const firstHash = await appendCommitAsync(fixture.repo, "one.txt", "one\n", "one");
        await appendCommitAsync(fixture.repo, "two.txt", "two\n", "two");

        const planRes = await dispatchGitFeatureAction({
          action: "log.rebasePlan.get",
          payload: { repoPath: fixture.repo, targetHash: firstHash },
          userDataPath: fixture.userDataPath,
        });
        expect(planRes.ok).toBe(true);
        const entries = planRes.data?.entries || [];

        const runRes = await dispatchGitFeatureAction({
          action: "log.rebasePlan.run",
          payload: {
            repoPath: fixture.repo,
            targetHash: planRes.data?.targetHash,
            headHash: planRes.data?.headHash,
            entries: [
              { hash: entries[0]?.hash, action: "pick" },
              { hash: entries[1]?.hash, action: "squash", message: "combined history" },
            ],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(runRes.ok).toBe(true);
        expect(runRes.data?.completed).toBe(true);

        const subjects = String(await gitAsync(fixture.repo, ["log", "--format=%s", "--max-count=2"])).trim().split(/\r?\n/);
        expect(subjects[0]).toBe("combined history");
        expect(subjects[1]).toBe("base");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "log.rebasePlan.run 遇到 edit 时应保持仓库停留在 rebasing 状态",
    async () => {
      const fixture = await createRepoFixture("codexflow-rebase-run-edit");
      try {
        const firstHash = await appendCommitAsync(fixture.repo, "one.txt", "one\n", "one");
        await appendCommitAsync(fixture.repo, "two.txt", "two\n", "two");

        const planRes = await dispatchGitFeatureAction({
          action: "log.rebasePlan.get",
          payload: { repoPath: fixture.repo, targetHash: firstHash },
          userDataPath: fixture.userDataPath,
        });
        expect(planRes.ok).toBe(true);
        const entries = planRes.data?.entries || [];

        const runRes = await dispatchGitFeatureAction({
          action: "log.rebasePlan.run",
          payload: {
            repoPath: fixture.repo,
            targetHash: planRes.data?.targetHash,
            headHash: planRes.data?.headHash,
            entries: [
              { hash: entries[0]?.hash, action: "edit" },
              { hash: entries[1]?.hash, action: "pick" },
            ],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(runRes.ok).toBe(true);
        expect(runRes.data?.operationState).toBe("rebasing");
        expect(runRes.data?.historyRewriteFeedback).toEqual(
          expect.objectContaining({
            action: "interactive-rebase",
            tone: "warn",
            completed: false,
            operationState: "rebasing",
          }),
        );
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("rebasing");

        const abortRes = await dispatchGitFeatureAction({
          action: "operation.abort",
          payload: { repoPath: fixture.repo },
          userDataPath: fixture.userDataPath,
        });
        expect(abortRes.ok).toBe(true);
        expect(await getOperationStateAsync(fixture.userDataPath, fixture.repo)).toBe("normal");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "log.rebasePlan.run 过期 headHash 应返回 unexpected-hash 反馈",
    async () => {
      const fixture = await createRepoFixture("codexflow-rebase-run-unexpected");
      try {
        const firstHash = await appendCommitAsync(fixture.repo, "one.txt", "one\n", "one");
        await appendCommitAsync(fixture.repo, "two.txt", "two\n", "two");

        const planRes = await dispatchGitFeatureAction({
          action: "log.rebasePlan.get",
          payload: { repoPath: fixture.repo, targetHash: firstHash },
          userDataPath: fixture.userDataPath,
        });
        expect(planRes.ok).toBe(true);

        const runRes = await dispatchGitFeatureAction({
          action: "log.rebasePlan.run",
          payload: {
            repoPath: fixture.repo,
            targetHash: planRes.data?.targetHash,
            headHash: "deadbeef",
            entries: planRes.data?.entries?.map((entry: { hash: string }) => ({ hash: entry.hash, action: "pick" })),
          },
          userDataPath: fixture.userDataPath,
        });

        expect(runRes.ok).toBe(false);
        expect(runRes.data?.historyRewriteFeedback).toEqual(
          expect.objectContaining({
            action: "interactive-rebase",
            reasonCode: "unexpected-hash",
            completed: false,
          }),
        );
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "log.rebasePlan.run 缺失计划条目应返回 unresolved-hash 反馈",
    async () => {
      const fixture = await createRepoFixture("codexflow-rebase-run-unresolved");
      try {
        const firstHash = await appendCommitAsync(fixture.repo, "one.txt", "one\n", "one");
        await appendCommitAsync(fixture.repo, "two.txt", "two\n", "two");

        const planRes = await dispatchGitFeatureAction({
          action: "log.rebasePlan.get",
          payload: { repoPath: fixture.repo, targetHash: firstHash },
          userDataPath: fixture.userDataPath,
        });
        expect(planRes.ok).toBe(true);

        const runRes = await dispatchGitFeatureAction({
          action: "log.rebasePlan.run",
          payload: {
            repoPath: fixture.repo,
            targetHash: planRes.data?.targetHash,
            headHash: planRes.data?.headHash,
            entries: [{ hash: planRes.data?.entries?.[0]?.hash, action: "pick" }],
          },
          userDataPath: fixture.userDataPath,
        });

        expect(runRes.ok).toBe(false);
        expect(runRes.data?.historyRewriteFeedback).toEqual(
          expect.objectContaining({
            action: "interactive-rebase",
            reasonCode: "unresolved-hash",
            completed: false,
          }),
        );
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "log.action editMessage 与 deleteCommit 应返回统一 historyRewriteFeedback",
    async () => {
      const fixture = await createRepoFixture("codexflow-log-history-feedback");
      try {
        const firstHash = await appendCommitAsync(fixture.repo, "one.txt", "one\n", "one");
        const headHash = await appendCommitAsync(fixture.repo, "two.txt", "two\n", "two");

        const editRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "editMessage",
            hash: firstHash,
            message: "one rewritten from log action",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(editRes.ok).toBe(true);
        expect(editRes.data?.historyRewriteFeedback).toEqual(
          expect.objectContaining({
            action: "edit-message",
            tone: "info",
            shouldRefresh: true,
            completed: true,
          }),
        );

        const rewrittenHeadHash = String(await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim();
        const deleteRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "deleteCommit",
            hash: rewrittenHeadHash,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(deleteRes.ok).toBe(true);
        expect(deleteRes.data?.historyRewriteFeedback).toEqual(
          expect.objectContaining({
            action: "delete-commit",
            tone: "info",
            title: "已删除 1 个提交",
            message: "已改写当前分支历史并移除目标提交",
            detailLines: ["“two”"],
            undo: expect.objectContaining({
              label: "撤销",
              payload: expect.objectContaining({
                kind: "delete-commit",
                repoRoot: expect.stringContaining("codexflow-log-history-feedback-repo-"),
                oldHead: rewrittenHeadHash,
              }),
            }),
            shouldRefresh: true,
            completed: true,
          }),
        );
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "log.action deleteCommit 在有本地改动时应自动保存恢复，并支持撤销删除提交",
    async () => {
      const fixture = await createRepoFixture("codexflow-delete-commit-undo");
      try {
        await appendCommitAsync(fixture.repo, "one.txt", "one\n", "one");
        const headHash = await appendCommitAsync(fixture.repo, "two.txt", "two\n", "two");
        await writeFileAsync(fixture.repo, ".claude/skills/demo/SKILL.md", "demo\n");

        const deleteRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "deleteCommit",
            hash: headHash,
            saveChangesPolicy: "shelve",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(deleteRes.ok).toBe(true);
        expect(String(await gitAsync(fixture.repo, ["ls-files", "--others", "--exclude-standard"]))).toContain(".claude/skills/demo/SKILL.md");
        expect(String(await gitAsync(fixture.repo, ["stash", "list"])).trim()).toBe("");

        const undoPayload = deleteRes.data?.historyRewriteFeedback?.undo?.payload;
        expect(undoPayload).toEqual(expect.objectContaining({
          kind: "delete-commit",
          oldHead: headHash,
        }));

        const undoRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "deleteCommitUndo",
            oldHead: undoPayload.oldHead,
            newHead: undoPayload.newHead,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(undoRes.ok).toBe(true);
        expect(undoRes.data?.historyRewriteFeedback).toEqual(
          expect.objectContaining({
            action: "delete-commit",
            title: "已撤销删除提交",
            tone: "info",
            shouldRefresh: true,
            completed: true,
          }),
        );
        expect(String(await gitAsync(fixture.repo, ["rev-parse", "HEAD"])).trim()).toBe(headHash);
        expect(String(await fsp.readFile(path.join(fixture.repo, ".claude/skills/demo/SKILL.md"), "utf8"))).toBe("demo\n");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "log.action deleteCommitUndo 在 HEAD 已变化时应拒绝撤销",
    async () => {
      const fixture = await createRepoFixture("codexflow-delete-commit-head-moved");
      try {
        await appendCommitAsync(fixture.repo, "one.txt", "one\n", "one");
        const headHash = await appendCommitAsync(fixture.repo, "two.txt", "two\n", "two");

        const deleteRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "deleteCommit",
            hash: headHash,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(deleteRes.ok).toBe(true);

        const undoPayload = deleteRes.data?.historyRewriteFeedback?.undo?.payload;
        expect(undoPayload?.newHead).toBeTruthy();

        await appendCommitAsync(fixture.repo, "after-delete.txt", "after\n", "after delete");

        const undoRes = await dispatchGitFeatureAction({
          action: "log.action",
          payload: {
            repoPath: fixture.repo,
            action: "deleteCommitUndo",
            oldHead: undoPayload.oldHead,
            newHead: undoPayload.newHead,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(undoRes.ok).toBe(false);
        expect(undoRes.data?.historyRewriteFeedback).toEqual(
          expect.objectContaining({
            action: "delete-commit",
            reasonCode: "head-moved",
            completed: false,
          }),
        );
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );
});
