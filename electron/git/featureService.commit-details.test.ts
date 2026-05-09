import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import * as gitExecModule from "./exec";
import { dispatchGitFeatureAction } from "./featureService";
import type { GitConsoleEntry } from "./consoleStore";
import { toFsPathKey } from "./pathKey";

type RepoFixture = {
  repo: string;
  userDataPath: string;
  targetHash: string;
  cleanup(): Promise<void>;
};

type RepoFixtureOptions = {
  headMode?: "target" | "restored" | "conflict";
};

type DetailsChange = {
  path: string;
  status: string;
  oldPath?: string;
};

const TARGET_SELECTED_CHANGES: DetailsChange[] = [
  { path: "a.txt", status: "M" },
];

const TARGET_ALL_CHANGES: DetailsChange[] = [
  { path: "a.txt", status: "M" },
  { path: "b.txt", status: "M" },
];

/**
 * 在测试仓库内执行 Git 命令；失败时直接抛出断言，避免历史改写测试被样板代码淹没。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 20_000): Promise<string> {
  const res = await gitExecModule.execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
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
 * 判断仓根列表是否包含目标仓库，避免 Windows 临时目录大小写或分隔符差异导致断言误判。
 */
function containsRepoRoot(repoRoots: unknown, repoRoot: string): boolean {
  const expectedKey = toFsPathKey(repoRoot);
  return (Array.isArray(repoRoots) ? repoRoots : [])
    .some((item) => toFsPathKey(String(item || "")) === expectedKey);
}

/**
 * 创建一个带目标提交的线性仓库，便于验证 committed changes action 的 availability 与历史改写。
 */
async function createRepoFixture(prefix: string, options?: RepoFixtureOptions): Promise<RepoFixture> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-repo-`));
  const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-userdata-`));
  await gitAsync(repo, ["init", "-b", "master"]);
  await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);
  await writeFileAsync(repo, "a.txt", "base a\n");
  await writeFileAsync(repo, "b.txt", "base b\n");
  await writeFileAsync(repo, "scratch.txt", "base scratch\n");
  await gitAsync(repo, ["add", "a.txt", "b.txt", "scratch.txt"]);
  await gitAsync(repo, ["commit", "-m", "base"]);
  await writeFileAsync(repo, "a.txt", "mixed a\n");
  await writeFileAsync(repo, "b.txt", "mixed b\n");
  await gitAsync(repo, ["add", "a.txt", "b.txt"]);
  await gitAsync(repo, ["commit", "-m", "mixed"]);
  const targetHash = (await gitAsync(repo, ["rev-parse", "HEAD"])).trim();
  if (options?.headMode === "restored") {
    await writeFileAsync(repo, "a.txt", "base a\n");
    await writeFileAsync(repo, "b.txt", "base b\n");
    await gitAsync(repo, ["add", "a.txt", "b.txt"]);
    await gitAsync(repo, ["commit", "-m", "restore"]);
  }
  if (options?.headMode === "conflict") {
    await writeFileAsync(repo, "a.txt", "conflict a\n");
    await gitAsync(repo, ["add", "a.txt"]);
    await gitAsync(repo, ["commit", "-m", "conflict"]);
  }
  return {
    repo,
    userDataPath,
    targetHash,
    async cleanup(): Promise<void> {
      try { await fsp.rm(repo, { recursive: true, force: true }); } catch {}
      try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
    },
  };
}

/**
 * 读取指定提交的 name-only 列表，方便断言重写后各提交只保留预期文件。
 */
async function getCommitFileListAsync(repo: string, revision: string): Promise<string[]> {
  return String(await gitAsync(repo, ["show", "--format=", "--name-only", revision]))
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean);
}

describe("featureService commit details actions", () => {
  /**
   * 筛出单提交详情那 5 条昂贵 Git 命令，便于断言缓存是否真正拦住重复读取。
   */
  function collectExpensiveDetailCalls(
    entries: GitConsoleEntry[],
    repo: string,
    hash: string,
  ): GitConsoleEntry[] {
    const escapedHash = hash.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(`\\bshow -s --date=iso-strict\\b.* ${escapedHash}$`),
      new RegExp(`\\bdiff-tree --no-commit-id --name-status -r -M ${escapedHash}$`),
      new RegExp(`\\bshow --numstat --format= ${escapedHash}$`),
      new RegExp(`\\bbranch --contains ${escapedHash}$`),
      new RegExp(`\\btag --contains ${escapedHash}$`),
    ];
    return entries.filter((entry) => {
      if (String(entry.cwd || "") !== repo) return false;
      const command = String(entry.command || "");
      return patterns.some((pattern) => pattern.test(command));
    });
  }

  /**
   * 读取指定仓库当前的 Git 控制台记录，供缓存测试直接统计真实昂贵命令次数。
   */
  async function listConsoleEntriesAsync(repo: string): Promise<GitConsoleEntry[]> {
    const res = await dispatchGitFeatureAction({
      action: "console.get",
      payload: {
        repoPath: repo,
        limit: 200,
        includeLongText: true,
      },
      userDataPath: repo,
    });
    expect(res.ok).toBe(true);
    return Array.isArray(res.data?.items) ? res.data.items as GitConsoleEntry[] : [];
  }

  /**
   * 清空指定仓库的 Git 控制台记录，避免跨断言残留影响统计。
   */
  async function clearConsoleEntriesAsync(repo: string): Promise<void> {
    const res = await dispatchGitFeatureAction({
      action: "console.clear",
      payload: {
        repoPath: repo,
      },
      userDataPath: repo,
    });
    expect(res.ok).toBe(true);
  }

  it(
    "log.details 对同一提交应复用缓存与在途请求，避免 amend/详情面板重复执行 Git 详情查询",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-cache");
      try {
        await clearConsoleEntriesAsync(fixture.repo);
        const payload = {
          repoPath: fixture.repo,
          hashes: [fixture.targetHash],
        };
        const userDataPath = fixture.userDataPath;

        const [firstRes, secondRes] = await Promise.all([
          dispatchGitFeatureAction({
            action: "log.details",
            payload,
            userDataPath,
          }),
          dispatchGitFeatureAction({
            action: "log.details",
            payload,
            userDataPath,
          }),
        ]);
        expect(firstRes.ok).toBe(true);
        expect(secondRes.ok).toBe(true);

        const thirdRes = await dispatchGitFeatureAction({
          action: "log.details",
          payload,
          userDataPath,
        });
        expect(thirdRes.ok).toBe(true);

        const expensiveDetailCalls = collectExpensiveDetailCalls(
          await listConsoleEntriesAsync(fixture.repo),
          fixture.repo,
          fixture.targetHash,
        );
        expect(expensiveDetailCalls).toHaveLength(5);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "只读动作夹在中间时，log.details 仍应复用同一提交详情缓存",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-cache-readonly");
      try {
        await clearConsoleEntriesAsync(fixture.repo);
        const userDataPath = fixture.userDataPath;
        const payload = {
          repoPath: fixture.repo,
          hashes: [fixture.targetHash],
        };

        const firstRes = await dispatchGitFeatureAction({
          action: "log.details",
          payload,
          userDataPath,
        });
        expect(firstRes.ok).toBe(true);

        const availabilityRes = await dispatchGitFeatureAction({
          action: "log.availability",
          payload: {
            repoPath: fixture.repo,
            hashes: [fixture.targetHash],
            selectionCount: 1,
          },
          userDataPath,
        });
        expect(availabilityRes.ok).toBe(true);

        const secondRes = await dispatchGitFeatureAction({
          action: "log.details",
          payload,
          userDataPath,
        });
        expect(secondRes.ok).toBe(true);

        const expensiveDetailCalls = collectExpensiveDetailCalls(
          await listConsoleEntriesAsync(fixture.repo),
          fixture.repo,
          fixture.targetHash,
        );
        expect(expensiveDetailCalls).toHaveLength(5);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "短 hash 与完整 hash 应视为不同请求键，不做跨键详情缓存复用",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-cache-hash-alias");
      try {
        await clearConsoleEntriesAsync(fixture.repo);
        const userDataPath = fixture.userDataPath;
        const shortHash = fixture.targetHash.slice(0, 7);

        const firstRes = await dispatchGitFeatureAction({
          action: "log.details",
          payload: {
            repoPath: fixture.repo,
            hashes: [shortHash],
          },
          userDataPath,
        });
        expect(firstRes.ok).toBe(true);

        const secondRes = await dispatchGitFeatureAction({
          action: "log.details",
          payload: {
            repoPath: fixture.repo,
            hashes: [fixture.targetHash],
          },
          userDataPath,
        });
        expect(secondRes.ok).toBe(true);

        const expensiveDetailCalls = [
          ...collectExpensiveDetailCalls(
            await listConsoleEntriesAsync(fixture.repo),
            fixture.repo,
            shortHash,
          ),
          ...collectExpensiveDetailCalls(
            await listConsoleEntriesAsync(fixture.repo),
            fixture.repo,
            fixture.targetHash,
          ),
        ];
        expect(expensiveDetailCalls).toHaveLength(10);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "完整 hash 命中后，再用短 hash 读取时也不应跨键复用详情缓存",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-cache-full-then-short");
      try {
        await clearConsoleEntriesAsync(fixture.repo);
        const userDataPath = fixture.userDataPath;
        const shortHash = fixture.targetHash.slice(0, 7);

        const firstRes = await dispatchGitFeatureAction({
          action: "log.details",
          payload: {
            repoPath: fixture.repo,
            hashes: [fixture.targetHash],
          },
          userDataPath,
        });
        expect(firstRes.ok).toBe(true);

        const secondRes = await dispatchGitFeatureAction({
          action: "log.details",
          payload: {
            repoPath: fixture.repo,
            hashes: [shortHash],
          },
          userDataPath,
        });
        expect(secondRes.ok).toBe(true);

        const expensiveDetailCalls = [
          ...collectExpensiveDetailCalls(
            await listConsoleEntriesAsync(fixture.repo),
            fixture.repo,
            shortHash,
          ),
          ...collectExpensiveDetailCalls(
            await listConsoleEntriesAsync(fixture.repo),
            fixture.repo,
            fixture.targetHash,
          ),
        ];
        expect(expensiveDetailCalls).toHaveLength(10);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "短 hash 与完整 hash 并发读取同一提交时，也应保持各自独立的请求键",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-cache-concurrent-alias");
      try {
        await clearConsoleEntriesAsync(fixture.repo);
        const userDataPath = fixture.userDataPath;
        const shortHash = fixture.targetHash.slice(0, 7);

        const [firstRes, secondRes] = await Promise.all([
          dispatchGitFeatureAction({
            action: "log.details",
            payload: {
              repoPath: fixture.repo,
              hashes: [fixture.targetHash],
            },
            userDataPath,
          }),
          dispatchGitFeatureAction({
            action: "log.details",
            payload: {
              repoPath: fixture.repo,
              hashes: [shortHash],
            },
            userDataPath,
          }),
        ]);
        expect(firstRes.ok).toBe(true);
        expect(secondRes.ok).toBe(true);

        const expensiveDetailCalls = [
          ...collectExpensiveDetailCalls(
            await listConsoleEntriesAsync(fixture.repo),
            fixture.repo,
            shortHash,
          ),
          ...collectExpensiveDetailCalls(
            await listConsoleEntriesAsync(fixture.repo),
            fixture.repo,
            fixture.targetHash,
          ),
        ];
        expect(expensiveDetailCalls).toHaveLength(10);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "log.details.availability 应按 selected committed changes 推导 edit/extract/drop gating",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-availability");
      try {
        const availableRes = await dispatchGitFeatureAction({
          action: "log.details.availability",
          payload: {
            repoPath: fixture.repo,
            hash: fixture.targetHash,
            selectedChanges: TARGET_SELECTED_CHANGES,
            allChanges: TARGET_ALL_CHANGES,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(availableRes.ok).toBe(true);
        expect(availableRes.data?.actions.editSource).toEqual({
          visible: true,
          enabled: true,
          reason: undefined,
        });
        expect(availableRes.data?.actions.openRepositoryVersion.enabled).toBe(true);
        expect(availableRes.data?.actions.revertSelectedChanges.enabled).toBe(true);
        expect(availableRes.data?.actions.applySelectedChanges.enabled).toBe(true);
        expect(availableRes.data?.actions.extractSelectedChanges.enabled).toBe(true);
        expect(availableRes.data?.actions.dropSelectedChanges.enabled).toBe(true);

        const allSelectedRes = await dispatchGitFeatureAction({
          action: "log.details.availability",
          payload: {
            repoPath: fixture.repo,
            hash: fixture.targetHash,
            selectedChanges: TARGET_ALL_CHANGES,
            allChanges: TARGET_ALL_CHANGES,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(allSelectedRes.ok).toBe(true);
        expect(allSelectedRes.data?.actions.extractSelectedChanges.enabled).toBe(false);
        expect(String(allSelectedRes.data?.actions.extractSelectedChanges.reason || "")).toContain("全部更改");
        expect(allSelectedRes.data?.actions.dropSelectedChanges.enabled).toBe(false);

        await fsp.rm(path.join(fixture.repo, "a.txt"), { force: true });
        const missingSourceRes = await dispatchGitFeatureAction({
          action: "log.details.availability",
          payload: {
            repoPath: fixture.repo,
            hash: fixture.targetHash,
            selectedChanges: TARGET_SELECTED_CHANGES,
            allChanges: TARGET_ALL_CHANGES,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(missingSourceRes.ok).toBe(true);
        expect(missingSourceRes.data?.actions.editSource.visible).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "openRepositoryVersion 应导出所选文件的仓库版本临时文件",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-open-repository-version");
      try {
        const res = await dispatchGitFeatureAction({
          action: "log.details.action",
          payload: {
            repoPath: fixture.repo,
            action: "openRepositoryVersion",
            hash: fixture.targetHash,
            selectedChanges: TARGET_SELECTED_CHANGES,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);
        const files = Array.isArray(res.data?.files) ? res.data?.files : [];
        expect(files).toHaveLength(1);
        expect(String(files[0]?.path || "")).toBe("a.txt");
        expect(path.basename(String(files[0]?.tempPath || ""))).toContain("a");
        expect(await fsp.readFile(String(files[0]?.tempPath || ""), "utf8")).toBe("mixed a\n");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "revertSelectedChanges 应把所选提交更改以反向 patch 应用到当前工作区",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-revert-selected");
      try {
        const res = await dispatchGitFeatureAction({
          action: "log.details.action",
          payload: {
            repoPath: fixture.repo,
            action: "revertSelectedChanges",
            hash: fixture.targetHash,
            selectedChanges: TARGET_SELECTED_CHANGES,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);
        expect((await fsp.readFile(path.join(fixture.repo, "a.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("base a\n");
        expect((await fsp.readFile(path.join(fixture.repo, "b.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("mixed b\n");
        expect(await gitAsync(fixture.repo, ["status", "--porcelain"])).toContain(" M a.txt");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "applySelectedChanges 应把所选提交更改以正向 patch 应用到当前工作区",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-apply-selected", { headMode: "restored" });
      try {
        const res = await dispatchGitFeatureAction({
          action: "log.details.action",
          payload: {
            repoPath: fixture.repo,
            action: "applySelectedChanges",
            hash: fixture.targetHash,
            selectedChanges: TARGET_SELECTED_CHANGES,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);
        expect((await fsp.readFile(path.join(fixture.repo, "a.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("mixed a\n");
        expect((await fsp.readFile(path.join(fixture.repo, "b.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("base b\n");
        expect(await gitAsync(fixture.repo, ["status", "--porcelain"])).toContain(" M a.txt");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "applySelectedChanges 在指定目标更改列表时，应把恢复后的文件归入该列表",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-apply-selected-target", { headMode: "restored" });
      try {
        const created = await dispatchGitFeatureAction({
          action: "changelist.create",
          payload: {
            repoPath: fixture.repo,
            name: "功能A",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(created.ok).toBe(true);

        const res = await dispatchGitFeatureAction({
          action: "log.details.action",
          payload: {
            repoPath: fixture.repo,
            action: "applySelectedChanges",
            hash: fixture.targetHash,
            selectedChanges: TARGET_SELECTED_CHANGES,
            targetChangeListId: created.data?.id,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);

        const status = await dispatchGitFeatureAction({
          action: "status.get",
          payload: {
            repoPath: fixture.repo,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(status.ok).toBe(true);
        expect(status.data?.entries?.find((item: { path: string; changeListId?: string }) => item.path === "a.txt")?.changeListId).toBe(created.data?.id);
        expect(status.data?.changeLists?.lists?.find((item: { id: string; files?: string[] }) => item.id === created.data?.id)?.files).toContain("a.txt");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "applySelectedChanges 触发补丁冲突时，应回传结构化 conflictRepoRoots 并保留目标更改列表归属",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-apply-selected-conflict", { headMode: "conflict" });
      try {
        const created = await dispatchGitFeatureAction({
          action: "changelist.create",
          payload: {
            repoPath: fixture.repo,
            name: "冲突列表",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(created.ok).toBe(true);

        const res = await dispatchGitFeatureAction({
          action: "log.details.action",
          payload: {
            repoPath: fixture.repo,
            action: "applySelectedChanges",
            hash: fixture.targetHash,
            selectedChanges: TARGET_SELECTED_CHANGES,
            targetChangeListId: created.data?.id,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(false);
        expect(containsRepoRoot(res.data?.conflictRepoRoots, fixture.repo)).toBe(true);

        const status = await dispatchGitFeatureAction({
          action: "status.get",
          payload: {
            repoPath: fixture.repo,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(status.ok).toBe(true);
        expect(status.data?.entries?.find((item: { path: string; changeListId?: string }) => item.path === "a.txt")?.changeListId).toBe(created.data?.id);
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 120_000 },
  );

  it(
    "extractSelectedChanges 应改写提交历史，并在前后保护本地未提交改动",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-extract");
      try {
        await writeFileAsync(fixture.repo, "scratch.txt", "local scratch\n");

        const res = await dispatchGitFeatureAction({
          action: "log.details.action",
          payload: {
            repoPath: fixture.repo,
            action: "extractSelectedChanges",
            hash: fixture.targetHash,
            selectedChanges: TARGET_SELECTED_CHANGES,
            allChanges: TARGET_ALL_CHANGES,
            message: "extract a",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);
        expect(res.data?.historyRewriteFeedback?.action).toBe("extract-selected-changes");
        expect((await fsp.readFile(path.join(fixture.repo, "scratch.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("local scratch\n");
        expect(await gitAsync(fixture.repo, ["status", "--porcelain"])).toContain("scratch.txt");
        expect(await getCommitFileListAsync(fixture.repo, "HEAD")).toEqual(["a.txt"]);
        expect(await getCommitFileListAsync(fixture.repo, "HEAD~1")).toEqual(["b.txt"]);
        expect(await gitAsync(fixture.repo, ["show", "HEAD:a.txt"])).toBe("mixed a\n");
        expect(await gitAsync(fixture.repo, ["show", "HEAD:b.txt"])).toBe("mixed b\n");
        expect(await gitAsync(fixture.repo, ["log", "--format=%s", "-2"])).toContain("extract a");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 180_000 },
  );

  it(
    "dropSelectedChanges 应直接重写目标提交，而不是退化为工作区删除文件",
    async () => {
      const fixture = await createRepoFixture("codexflow-details-drop");
      try {
        const res = await dispatchGitFeatureAction({
          action: "log.details.action",
          payload: {
            repoPath: fixture.repo,
            action: "dropSelectedChanges",
            hash: fixture.targetHash,
            selectedChanges: TARGET_SELECTED_CHANGES,
            allChanges: TARGET_ALL_CHANGES,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);
        expect(res.data?.historyRewriteFeedback?.action).toBe("drop-selected-changes");
        expect(await getCommitFileListAsync(fixture.repo, "HEAD")).toEqual(["b.txt"]);
        expect(await gitAsync(fixture.repo, ["show", "HEAD:a.txt"])).toBe("base a\n");
        expect(await gitAsync(fixture.repo, ["show", "HEAD:b.txt"])).toBe("mixed b\n");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 180_000 },
  );
});
