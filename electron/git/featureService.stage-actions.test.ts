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
 * 在测试仓库内执行 Git 命令；失败时直接抛出断言，便于聚焦 stage 动作语义本身。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 20_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
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
 * 创建带基础提交的临时仓库，供 stage 动作与 diff 集成测试隔离使用。
 */
async function createRepoFixture(prefix: string): Promise<RepoFixture> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-repo-`));
  const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-userdata-`));
  await gitAsync(repo, ["init", "-b", "master"]);
  await gitAsync(repo, ["config", "user.name", "CodexFlow"]);
  await gitAsync(repo, ["config", "user.email", "codexflow@example.com"]);
  await writeFileAsync(repo, "tracked.txt", "base\n");
  await writeFileAsync(repo, "keep.txt", "keep\n");
  await gitAsync(repo, ["add", "tracked.txt", "keep.txt"]);
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
 * 读取 `git status --porcelain` 输出，便于断言 stage/stash 后的工作区形态。
 */
async function readStatusAsync(repo: string): Promise<string> {
  return (await gitAsync(repo, ["status", "--porcelain"])).replace(/\r\n/g, "\n");
}

describe("featureService stage actions", () => {
  it(
    "changes.unstage 应仅恢复索引，保留工作区修改",
    async () => {
      const fixture = await createRepoFixture("codexflow-unstage");
      try {
        await writeFileAsync(fixture.repo, "tracked.txt", "staged only\n");
        await gitAsync(fixture.repo, ["add", "tracked.txt"]);

        const res = await dispatchGitFeatureAction({
          action: "changes.unstage",
          payload: {
            repoPath: fixture.repo,
            files: ["tracked.txt"],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);

        expect((await gitAsync(fixture.repo, ["diff", "--cached", "--name-only"])).trim()).toBe("");
        expect((await gitAsync(fixture.repo, ["diff", "--name-only"])).trim()).toBe("tracked.txt");
        expect(await fsp.readFile(path.join(fixture.repo, "tracked.txt"), "utf8")).toBe("staged only\n");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "changes.revertUnstaged 应把工作区回退到 Index，但保留已暂存内容",
    async () => {
      const fixture = await createRepoFixture("codexflow-revert-unstaged");
      try {
        await writeFileAsync(fixture.repo, "tracked.txt", "staged version\n");
        await gitAsync(fixture.repo, ["add", "tracked.txt"]);
        await writeFileAsync(fixture.repo, "tracked.txt", "working version\n");

        const res = await dispatchGitFeatureAction({
          action: "changes.revertUnstaged",
          payload: {
            repoPath: fixture.repo,
            files: ["tracked.txt"],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);

        expect((await fsp.readFile(path.join(fixture.repo, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("staged version\n");
        expect((await gitAsync(fixture.repo, ["diff", "--name-only"])).trim()).toBe("");
        expect((await gitAsync(fixture.repo, ["diff", "--cached", "--name-only"])).trim()).toBe("tracked.txt");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "changes.delete 删除包含 staged tracked 文件的目录时，应按文件系统语义直接删除而不是执行 git rm",
    async () => {
      const fixture = await createRepoFixture("codexflow-delete-directory");
      try {
        await writeFileAsync(fixture.repo, "web/src/App.tsx", "base\n");
        await gitAsync(fixture.repo, ["add", "web/src/App.tsx"]);
        await gitAsync(fixture.repo, ["commit", "-m", "add web app"]);

        await writeFileAsync(fixture.repo, "web/src/App.tsx", "staged change\n");
        await gitAsync(fixture.repo, ["add", "web/src/App.tsx"]);

        const res = await dispatchGitFeatureAction({
          action: "changes.delete",
          payload: {
            repoPath: fixture.repo,
            files: ["web/src/App.tsx"],
            deleteTargets: ["web"],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);

        await expect(fsp.access(path.join(fixture.repo, "web"))).rejects.toThrow();
        expect((await gitAsync(fixture.repo, ["diff", "--cached", "--name-only"])).trim()).toBe("web/src/App.tsx");
        expect((await gitAsync(fixture.repo, ["diff", "--name-only"])).trim()).toBe("web/src/App.tsx");
        expect(await readStatusAsync(fixture.repo)).toContain("MD web/src/App.tsx");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "changes.stage 在 intent-to-add 模式下应只登记路径，不直接把工作区内容写入 Index",
    async () => {
      const fixture = await createRepoFixture("codexflow-intent-to-add");
      try {
        await writeFileAsync(fixture.repo, "new.txt", "intent only\n");

        const res = await dispatchGitFeatureAction({
          action: "changes.stage",
          payload: {
            repoPath: fixture.repo,
            files: ["new.txt"],
            mode: "intentToAdd",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);

        expect((await gitAsync(fixture.repo, ["ls-files", "--stage", "--", "new.txt"])).trim()).toContain("new.txt");
        expect((await gitAsync(fixture.repo, ["show", ":new.txt"])).replace(/\r\n/g, "\n")).toBe("");
        expect(await readStatusAsync(fixture.repo)).toContain("new.txt");
        expect(await readStatusAsync(fixture.repo)).not.toContain("?? new.txt");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "stash.create 传入 files 时应只暂存选中的 staged/unstaged/untracked 路径",
    async () => {
      const fixture = await createRepoFixture("codexflow-stage-stash");
      try {
        await writeFileAsync(fixture.repo, "tracked.txt", "selected\n");
        await writeFileAsync(fixture.repo, "keep.txt", "left behind\n");
        await writeFileAsync(fixture.repo, "new.txt", "new file\n");

        const res = await dispatchGitFeatureAction({
          action: "stash.create",
          payload: {
            repoPath: fixture.repo,
            message: "selected only",
            includeUntracked: true,
            files: ["tracked.txt", "new.txt"],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);

        const status = await readStatusAsync(fixture.repo);
        expect(status).toContain(" M keep.txt");
        expect(status).not.toContain("tracked.txt");
        expect(status).not.toContain("new.txt");
        expect((await gitAsync(fixture.repo, ["stash", "list"])).split(/\r?\n/)[0] || "").toContain("selected only");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "stash.create 按路径执行后若暂存区仍有其他 staged 变更，应返回 warning",
    async () => {
      const fixture = await createRepoFixture("codexflow-stage-stash-warning");
      try {
        await writeFileAsync(fixture.repo, "tracked.txt", "selected\n");
        await writeFileAsync(fixture.repo, "keep.txt", "keep staged\n");
        await gitAsync(fixture.repo, ["add", "keep.txt"]);

        const res = await dispatchGitFeatureAction({
          action: "stash.create",
          payload: {
            repoPath: fixture.repo,
            files: ["tracked.txt"],
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);
        expect(String(res.data?.warning || "")).toContain("暂存区仍保留其他已暂存更改");

        const status = await readStatusAsync(fixture.repo);
        expect(status).toContain("M  keep.txt");
        expect(status).not.toContain("tracked.txt");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "stash.create 启用 keepIndex 时应保留当前暂存区内容，只把工作区改动压入 stash",
    async () => {
      const fixture = await createRepoFixture("codexflow-stage-stash-keep-index");
      try {
        await writeFileAsync(fixture.repo, "tracked.txt", "staged keep index\n");
        await gitAsync(fixture.repo, ["add", "tracked.txt"]);
        await writeFileAsync(fixture.repo, "keep.txt", "worktree only\n");

        const res = await dispatchGitFeatureAction({
          action: "stash.create",
          payload: {
            repoPath: fixture.repo,
            message: "keep index",
            keepIndex: true,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok).toBe(true);

        expect((await gitAsync(fixture.repo, ["diff", "--cached", "--name-only"])).trim()).toBe("tracked.txt");
        expect((await gitAsync(fixture.repo, ["diff", "--name-only"])).trim()).toBe("");
        expect((await fsp.readFile(path.join(fixture.repo, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("staged keep index\n");
        expect((await gitAsync(fixture.repo, ["stash", "list"])).split(/\r?\n/)[0] || "").toContain("keep index");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "stash.apply 传入 reinstateIndex 时应恢复 Index 状态",
    async () => {
      const fixture = await createRepoFixture("codexflow-stage-stash-reinstate");
      try {
        await writeFileAsync(fixture.repo, "tracked.txt", "reinstate index\n");
        await gitAsync(fixture.repo, ["add", "tracked.txt"]);
        await dispatchGitFeatureAction({
          action: "stash.create",
          payload: {
            repoPath: fixture.repo,
            message: "reinstate",
          },
          userDataPath: fixture.userDataPath,
        });

        const res = await dispatchGitFeatureAction({
          action: "stash.apply",
          payload: {
            repoPath: fixture.repo,
            ref: "stash@{0}",
            pop: false,
            reinstateIndex: true,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok, String(res.error || "")).toBe(true);

        expect((await gitAsync(fixture.repo, ["diff", "--cached", "--name-only"])).trim()).toBe("tracked.txt");
        expect((await fsp.readFile(path.join(fixture.repo, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("reinstate index\n");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "stash.apply 传入 branchName 时应走 stash branch 语义并切换到新分支",
    async () => {
      const fixture = await createRepoFixture("codexflow-stage-stash-branch");
      try {
        await writeFileAsync(fixture.repo, "tracked.txt", "branch from stash\n");
        await dispatchGitFeatureAction({
          action: "stash.create",
          payload: {
            repoPath: fixture.repo,
            message: "branch restore",
          },
          userDataPath: fixture.userDataPath,
        });

        const res = await dispatchGitFeatureAction({
          action: "stash.apply",
          payload: {
            repoPath: fixture.repo,
            ref: "stash@{0}",
            pop: false,
            branchName: "feature/from-stash",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(res.ok, String(res.error || "")).toBe(true);
        expect(res.data?.branchName).toBe("feature/from-stash");
        expect((await gitAsync(fixture.repo, ["branch", "--show-current"])).trim()).toBe("feature/from-stash");
        expect((await fsp.readFile(path.join(fixture.repo, "tracked.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("branch from stash\n");
        expect((await gitAsync(fixture.repo, ["stash", "list"])).trim()).toBe("");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "stage compare diff modes 应返回正确的左右文本与 patch 方向",
    async () => {
      const fixture = await createRepoFixture("codexflow-stage-diff-modes");
      try {
        await writeFileAsync(fixture.repo, "tracked.txt", "stage version\n");
        await gitAsync(fixture.repo, ["add", "tracked.txt"]);
        await writeFileAsync(fixture.repo, "tracked.txt", "working version\n");

        const localToStaged = await dispatchGitFeatureAction({
          action: "diff.get",
          payload: {
            repoPath: fixture.repo,
            path: "tracked.txt",
            mode: "localToStaged",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(localToStaged.ok).toBe(true);
        expect(localToStaged.data).toEqual(expect.objectContaining({
          leftTitle: "Working Tree",
          rightTitle: "Index",
          leftText: "working version\n",
          rightText: "stage version\n",
        }));

        const stagedToLocal = await dispatchGitFeatureAction({
          action: "diff.get",
          payload: {
            repoPath: fixture.repo,
            path: "tracked.txt",
            mode: "stagedToLocal",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(stagedToLocal.ok).toBe(true);
        expect(stagedToLocal.data).toEqual(expect.objectContaining({
          leftTitle: "Index",
          rightTitle: "Working Tree",
          leftText: "stage version\n",
          rightText: "working version\n",
        }));

        const localToStagedPatch = await dispatchGitFeatureAction({
          action: "diff.patch",
          payload: {
            repoPath: fixture.repo,
            path: "tracked.txt",
            mode: "localToStaged",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(localToStagedPatch.ok).toBe(true);
        expect(String(localToStagedPatch.data?.patch || "")).toContain("-working version");
        expect(String(localToStagedPatch.data?.patch || "")).toContain("+stage version");

        const stagedToLocalPatch = await dispatchGitFeatureAction({
          action: "diff.patch",
          payload: {
            repoPath: fixture.repo,
            path: "tracked.txt",
            mode: "stagedToLocal",
          },
          userDataPath: fixture.userDataPath,
        });
        expect(stagedToLocalPatch.ok).toBe(true);
        expect(String(stagedToLocalPatch.data?.patch || "")).toContain("-stage version");
        expect(String(stagedToLocalPatch.data?.patch || "")).toContain("+working version");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );

  it(
    "shelf diff modes 应通过统一 shelf 预览链路返回显示差异、与本地比较和创建补丁所需内容",
    async () => {
      const fixture = await createRepoFixture("codexflow-shelf-diff-modes");
      try {
        await writeFileAsync(fixture.repo, "tracked.txt", "shelf version\n");

        const createShelfRes = await dispatchGitFeatureAction({
          action: "shelf.create",
          payload: {
            repoPath: fixture.repo,
            message: "manual shelf",
            selection: {
              selectedPaths: ["tracked.txt"],
              availablePaths: ["tracked.txt"],
              changeListsEnabled: false,
            },
          },
          userDataPath: fixture.userDataPath,
        });
        expect(createShelfRes.ok, String(createShelfRes.error || "")).toBe(true);

        const shelfListRes = await dispatchGitFeatureAction({
          action: "shelf.list",
          payload: {
            repoPath: fixture.repo,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(shelfListRes.ok, String(shelfListRes.error || "")).toBe(true);
        const shelfRef = String(shelfListRes.data?.items?.[0]?.ref || "").trim();
        expect(shelfRef).toContain("shelf@{");

        const shelfDiffRes = await dispatchGitFeatureAction({
          action: "diff.get",
          payload: {
            repoPath: fixture.repo,
            path: "tracked.txt",
            mode: "shelf",
            shelfRef,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(shelfDiffRes.ok, String(shelfDiffRes.error || "")).toBe(true);
        expect({
          ...shelfDiffRes.data,
          leftText: String(shelfDiffRes.data?.leftText || "").replace(/\r\n/g, "\n"),
          rightText: String(shelfDiffRes.data?.rightText || "").replace(/\r\n/g, "\n"),
        }).toEqual(expect.objectContaining({
          mode: "shelf",
          leftTitle: "Base",
          rightTitle: "Shelf",
          shelfRef,
          leftText: "base\n",
          rightText: "shelf version\n",
        }));
        expect(shelfDiffRes.data?.hunks?.length).toBeGreaterThan(0);

        const compareLocalRes = await dispatchGitFeatureAction({
          action: "diff.get",
          payload: {
            repoPath: fixture.repo,
            path: "tracked.txt",
            mode: "shelfToWorking",
            shelfRef,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(compareLocalRes.ok, String(compareLocalRes.error || "")).toBe(true);
        expect({
          ...compareLocalRes.data,
          leftText: String(compareLocalRes.data?.leftText || "").replace(/\r\n/g, "\n"),
          rightText: String(compareLocalRes.data?.rightText || "").replace(/\r\n/g, "\n"),
        }).toEqual(expect.objectContaining({
          mode: "shelfToWorking",
          leftTitle: "Shelf",
          rightTitle: "Working Tree",
          shelfRef,
          leftText: "shelf version\n",
          rightText: "base\n",
        }));

        const shelfPatchRes = await dispatchGitFeatureAction({
          action: "diff.patch",
          payload: {
            repoPath: fixture.repo,
            path: "tracked.txt",
            mode: "shelf",
            shelfRef,
          },
          userDataPath: fixture.userDataPath,
        });
        expect(shelfPatchRes.ok, String(shelfPatchRes.error || "")).toBe(true);
        expect(String(shelfPatchRes.data?.patch || "")).toContain("-base");
        expect(String(shelfPatchRes.data?.patch || "")).toContain("+shelf version");
      } finally {
        await fixture.cleanup();
      }
    },
    { timeout: 90_000 },
  );
});
