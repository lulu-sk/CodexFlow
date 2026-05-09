import os from "node:os";
import path from "node:path";
import { promises as fsp } from "node:fs";
import { describe, expect, it } from "vitest";
import { execGitAsync } from "./exec";
import { dispatchGitFeatureAction } from "./featureService";

/**
 * 在指定仓库执行 Git 命令，并在失败时输出完整 stderr，方便定位测试夹具问题。
 */
async function gitAsync(repo: string, argv: string[], timeoutMs: number = 20_000): Promise<string> {
  const res = await execGitAsync({ argv: ["-C", repo, ...argv], timeoutMs });
  expect(res.ok, `git ${argv.join(" ")} failed: ${res.stderr || res.error || res.stdout}`).toBe(true);
  return String(res.stdout || "");
}

describe("featureService branch sync popup", () => {
  it(
    "tracked branch 未 fetch 时应显示 hasUnfetched，fetch 后应切换为明确 incoming/outgoing 计数",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-sync-"));
      const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-sync-remote-"));
      const otherRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-sync-other-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-sync-userdata-"));
      try {
        const remoteRepo = path.join(remoteRoot, "origin.git");
        await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);

        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await gitAsync(root, ["config", "core.autocrlf", "false"]);
        await gitAsync(root, ["config", "core.eol", "lf"]);

        await fsp.writeFile(path.join(root, "README.md"), "# demo\n", "utf8");
        await gitAsync(root, ["add", "README.md"]);
        await gitAsync(root, ["commit", "-m", "init"]);
        const defaultBranch = String(await gitAsync(root, ["branch", "--show-current"])).trim() || "main";
        await gitAsync(root, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(root, ["push", "-u", "origin", defaultBranch]);

        const collaborator = path.join(otherRoot, "collaborator");
        await gitAsync(otherRoot, ["clone", remoteRepo, collaborator], 60_000);
        await gitAsync(collaborator, ["config", "user.name", "Collaborator"]);
        await gitAsync(collaborator, ["config", "user.email", "collaborator@example.com"]);
        await gitAsync(collaborator, ["config", "core.autocrlf", "false"]);
        await gitAsync(collaborator, ["config", "core.eol", "lf"]);

        await fsp.writeFile(path.join(root, "local.txt"), "local ahead\n", "utf8");
        await gitAsync(root, ["add", "local.txt"]);
        await gitAsync(root, ["commit", "-m", "local ahead"]);

        await fsp.writeFile(path.join(collaborator, "remote.txt"), "remote ahead\n", "utf8");
        await gitAsync(collaborator, ["add", "remote.txt"]);
        await gitAsync(collaborator, ["commit", "-m", "remote ahead"]);
        await gitAsync(collaborator, ["push", "origin", defaultBranch], 60_000);

        const beforeFetch = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(beforeFetch.ok).toBe(true);
        expect(beforeFetch.data?.currentBranchSync).toEqual(expect.objectContaining({
          upstream: `origin/${defaultBranch}`,
          outgoing: 1,
          hasUnfetched: true,
        }));
        expect(beforeFetch.data?.currentBranchSync?.tooltip).toContain("存在未获取的传入提交");
        const currentLocalRow = beforeFetch.data?.groups?.local?.find((item: { name: string }) => item.name === defaultBranch);
        expect(currentLocalRow?.sync?.hasUnfetched).toBe(true);

        const fetchRes = await dispatchGitFeatureAction({
          action: "flow.fetch",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(fetchRes.ok).toBe(true);

        const afterFetch = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(afterFetch.ok).toBe(true);
        expect(afterFetch.data?.currentBranchSync).toEqual(expect.objectContaining({
          upstream: `origin/${defaultBranch}`,
          incoming: 1,
          outgoing: 1,
          hasUnfetched: false,
          status: "diverged",
        }));
        expect(afterFetch.data?.currentBranchSync?.tooltip).toContain("落后 1 个提交，领先 1 个提交");
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(otherRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 },
  );

  it(
    "branch popup 远端分组应过滤裸远端符号引用，只保留真实远端分支",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-remote-filter-"));
      const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-remote-filter-remote-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-remote-filter-userdata-"));
      try {
        const remoteRepo = path.join(remoteRoot, "origin.git");
        await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);

        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await fsp.writeFile(path.join(root, "README.md"), "# remote filter\n", "utf8");
        await gitAsync(root, ["add", "README.md"]);
        await gitAsync(root, ["commit", "-m", "init"]);
        const defaultBranch = String(await gitAsync(root, ["branch", "--show-current"])).trim() || "main";
        await gitAsync(root, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(root, ["push", "-u", "origin", defaultBranch], 60_000);

        const popupRes = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(popupRes.ok).toBe(true);

        const remoteNames = new Set((popupRes.data?.groups?.remote || []).map((item: { name: string }) => item.name));
        expect(remoteNames.has("origin")).toBe(false);
        expect(remoteNames.has(`origin/${defaultBranch}`)).toBe(true);
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 },
  );

  it(
    "toggleFavorite 应持久化本地分支收藏并回填到 popup favorites 分组",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-favorite-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-favorite-userdata-"));
      try {
        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await fsp.writeFile(path.join(root, "README.md"), "# favorite\n", "utf8");
        await gitAsync(root, ["add", "README.md"]);
        await gitAsync(root, ["commit", "-m", "init"]);
        const defaultBranch = String(await gitAsync(root, ["branch", "--show-current"])).trim() || "main";

        const toggleOn = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: root,
            action: "toggleFavorite",
            refKind: "local",
            name: defaultBranch,
            favorite: true,
          },
          userDataPath,
        });
        expect(toggleOn.ok).toBe(true);
        expect(toggleOn.data?.favorite).toBe(true);

        const popupAfterToggleOn = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(popupAfterToggleOn.ok).toBe(true);
        expect(popupAfterToggleOn.data?.groups?.favorites).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: defaultBranch,
              favorite: true,
            }),
          ]),
        );

        const toggleOff = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: root,
            action: "toggleFavorite",
            refKind: "local",
            name: defaultBranch,
            favorite: false,
          },
          userDataPath,
        });
        expect(toggleOff.ok).toBe(true);
        expect(toggleOff.data?.favorite).toBe(false);

        const popupAfterToggleOff = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(popupAfterToggleOff.ok).toBe(true);
        expect((popupAfterToggleOff.data?.groups?.favorites || []).some((item: { name: string }) => item.name === defaultBranch)).toBe(false);
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 },
  );

  it(
    "setSyncEnabled=false 后 branch popup 不应再返回 currentBranchSync 与行级 sync",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-sync-toggle-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-sync-toggle-userdata-"));
      try {
        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await fsp.writeFile(path.join(root, "README.md"), "# sync toggle\n", "utf8");
        await gitAsync(root, ["add", "README.md"]);
        await gitAsync(root, ["commit", "-m", "init"]);

        const disableRes = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: root,
            action: "setSyncEnabled",
            enabled: false,
          },
          userDataPath,
        });
        expect(disableRes.ok).toBe(true);
        expect(disableRes.data?.enabled).toBe(false);

        const popupRes = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(popupRes.ok).toBe(true);
        expect(popupRes.data?.syncEnabled).toBe(false);
        expect(popupRes.data?.currentBranchSync).toBeUndefined();
        expect((popupRes.data?.groups?.local || []).every((item: { sync?: unknown }) => item.sync == null)).toBe(true);
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "setShowOnlyMy=true 后 branch popup 应仅保留当前作者的本地与远端分支",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-show-only-my-"));
      const remoteRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-show-only-my-remote-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-show-only-my-userdata-"));
      try {
        const remoteRepo = path.join(remoteRoot, "origin.git");
        await gitAsync(remoteRoot, ["init", "--bare", remoteRepo]);

        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await fsp.writeFile(path.join(root, "README.md"), "# show only my\n", "utf8");
        await gitAsync(root, ["add", "README.md"]);
        await gitAsync(root, ["commit", "-m", "init"]);
        const defaultBranch = String(await gitAsync(root, ["branch", "--show-current"])).trim() || "main";
        await gitAsync(root, ["remote", "add", "origin", remoteRepo]);
        await gitAsync(root, ["push", "-u", "origin", defaultBranch], 60_000);

        await gitAsync(root, ["checkout", "-b", "feature/mine"]);
        await fsp.writeFile(path.join(root, "mine.txt"), "mine\n", "utf8");
        await gitAsync(root, ["add", "mine.txt"]);
        await gitAsync(root, ["commit", "-m", "mine"]);

        await gitAsync(root, ["checkout", defaultBranch]);
        await gitAsync(root, ["checkout", "-b", "feature/mine-remote"]);
        await fsp.writeFile(path.join(root, "mine-remote.txt"), "mine remote\n", "utf8");
        await gitAsync(root, ["add", "mine-remote.txt"]);
        await gitAsync(root, ["commit", "-m", "mine remote"]);
        await gitAsync(root, ["push", "-u", "origin", "feature/mine-remote"], 60_000);
        await gitAsync(root, ["checkout", defaultBranch]);
        await gitAsync(root, ["branch", "-D", "feature/mine-remote"]);

        await gitAsync(root, ["checkout", "-b", "feature/other"]);
        await gitAsync(root, ["config", "user.name", "Other"]);
        await gitAsync(root, ["config", "user.email", "other@example.com"]);
        await fsp.writeFile(path.join(root, "other.txt"), "other\n", "utf8");
        await gitAsync(root, ["add", "other.txt"]);
        await gitAsync(root, ["commit", "-m", "other"]);

        await gitAsync(root, ["checkout", defaultBranch]);
        await gitAsync(root, ["checkout", "-b", "feature/other-remote"]);
        await fsp.writeFile(path.join(root, "other-remote.txt"), "other remote\n", "utf8");
        await gitAsync(root, ["add", "other-remote.txt"]);
        await gitAsync(root, ["commit", "-m", "other remote"]);
        await gitAsync(root, ["push", "-u", "origin", "feature/other-remote"], 60_000);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await gitAsync(root, ["checkout", defaultBranch]);
        await gitAsync(root, ["branch", "-D", "feature/other-remote"]);
        await gitAsync(root, ["checkout", "feature/mine"]);

        const beforeFilter = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(beforeFilter.ok).toBe(true);
        expect((beforeFilter.data?.groups?.local || []).some((item: { name: string }) => item.name === "feature/mine")).toBe(true);
        expect((beforeFilter.data?.groups?.local || []).some((item: { name: string }) => item.name === "feature/other")).toBe(true);

        const enableFilter = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: root,
            action: "setShowOnlyMy",
            enabled: true,
          },
          userDataPath,
        });
        expect(enableFilter.ok).toBe(true);
        expect(enableFilter.data?.showOnlyMy).toBe(true);

        const afterFilter = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(afterFilter.ok).toBe(true);
        expect(afterFilter.data?.showOnlyMy).toBe(true);
        const localNames = new Set((afterFilter.data?.groups?.local || []).map((item: { name: string }) => item.name));
        const remoteNames = new Set((afterFilter.data?.groups?.remote || []).map((item: { name: string }) => item.name));
        expect(localNames.has("feature/mine")).toBe(true);
        expect(localNames.has("feature/other")).toBe(false);
        expect(remoteNames.has("origin/feature/mine-remote")).toBe(true);
        expect(remoteNames.has("origin/feature/other-remote")).toBe(false);
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(remoteRoot, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 },
  );

  it(
    "branch.action addRemote/editRemote/removeRemote 应驱动 branch popup remotes 快照刷新",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-remote-config-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-remote-config-userdata-"));
      try {
        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await fsp.writeFile(path.join(root, "README.md"), "# remotes\n", "utf8");
        await gitAsync(root, ["add", "README.md"]);
        await gitAsync(root, ["commit", "-m", "init"]);

        const addRemote = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: root,
            action: "addRemote",
            name: "origin",
            url: "https://example.com/origin.git",
            pushUrl: "ssh://git@example.com/origin.git",
          },
          userDataPath,
        });
        expect(addRemote.ok).toBe(true);

        const afterAdd = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(afterAdd.ok).toBe(true);
        expect(afterAdd.data?.remotes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "origin",
              fetchUrl: "https://example.com/origin.git",
              pushUrl: "ssh://git@example.com/origin.git",
            }),
          ]),
        );

        const editRemote = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: root,
            action: "editRemote",
            name: "origin",
            nextName: "upstream",
            url: "https://example.com/upstream.git",
            pushUrl: "ssh://git@example.com/upstream.git",
          },
          userDataPath,
        });
        expect(editRemote.ok).toBe(true);
        expect(editRemote.data?.name).toBe("upstream");
        expect(editRemote.data?.previousName).toBe("origin");

        const afterEdit = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(afterEdit.ok).toBe(true);
        expect(afterEdit.data?.remotes).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "upstream",
              fetchUrl: "https://example.com/upstream.git",
              pushUrl: "ssh://git@example.com/upstream.git",
            }),
          ]),
        );
        expect((afterEdit.data?.remotes || []).some((item: { name: string }) => item.name === "origin")).toBe(false);

        const removeRemote = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: root,
            action: "removeRemote",
            name: "upstream",
          },
          userDataPath,
        });
        expect(removeRemote.ok).toBe(true);

        const afterRemove = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(afterRemove.ok).toBe(true);
        expect(afterRemove.data?.remotes || []).toHaveLength(0);
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 },
  );

  it(
    "branch popup 在存在 submodule 时应返回多仓仓库列表快照",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-multiroot-"));
      const libRepo = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-multiroot-lib-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-multiroot-userdata-"));
      try {
        await gitAsync(libRepo, ["init"]);
        await gitAsync(libRepo, ["config", "user.name", "CodexFlow"]);
        await gitAsync(libRepo, ["config", "user.email", "codexflow@example.com"]);
        await fsp.writeFile(path.join(libRepo, "lib.txt"), "lib\n", "utf8");
        await gitAsync(libRepo, ["add", "lib.txt"]);
        await gitAsync(libRepo, ["commit", "-m", "lib init"]);

        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await fsp.writeFile(path.join(root, "README.md"), "# root\n", "utf8");
        await gitAsync(root, ["add", "README.md"]);
        await gitAsync(root, ["commit", "-m", "root init"]);
        await gitAsync(root, ["-c", "protocol.file.allow=always", "submodule", "add", libRepo, "modules/lib"], 60_000);
        await gitAsync(root, ["commit", "-am", "add submodule"]);

        const popupRes = await dispatchGitFeatureAction({
          action: "branch.popup",
          payload: { repoPath: root },
          userDataPath,
        });
        expect(popupRes.ok).toBe(true);
        expect(popupRes.data?.multiRoot).toBe(true);
        expect(popupRes.data?.repositories).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              repoRoot: root,
              kind: "repository",
            }),
            expect.objectContaining({
              repoRoot: path.join(root, "modules", "lib"),
              kind: "submodule",
              rootName: "lib",
            }),
          ]),
        );
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(libRepo, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 120_000 },
  );

  it(
    "branch.action compareFiles 应返回两分支之间的重命名文件并携带 oldPath",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-compare-files-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-compare-files-userdata-"));
      try {
        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await fsp.mkdir(path.join(root, "docs"), { recursive: true });
        await fsp.writeFile(path.join(root, "docs", "README.md"), "base line\n", "utf8");
        await gitAsync(root, ["add", "docs/README.md"]);
        await gitAsync(root, ["commit", "-m", "init compare"]);
        const defaultBranch = String(await gitAsync(root, ["branch", "--show-current"])).trim() || "main";

        await gitAsync(root, ["checkout", "-b", "feature/rename"]);
        await gitAsync(root, ["mv", "docs/README.md", "docs/guide.md"]);
        await gitAsync(root, ["add", "docs/guide.md"]);
        await gitAsync(root, ["commit", "-m", "rename guide"]);

        const compareRes = await dispatchGitFeatureAction({
          action: "branch.action",
          payload: {
            repoPath: root,
            action: "compareFiles",
            leftRef: defaultBranch,
            rightRef: "feature/rename",
          },
          userDataPath,
        });
        expect(compareRes.ok, String(compareRes.error || "")).toBe(true);
        expect(String(compareRes.data?.repoRoot || "").replace(/\\/g, "/")).toBe(root.replace(/\\/g, "/"));
        expect(compareRes.data?.leftRef).toBe(defaultBranch);
        expect(compareRes.data?.rightRef).toBe("feature/rename");
        expect(compareRes.data?.files).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: "docs/guide.md",
              oldPath: "docs/README.md",
            }),
          ]),
        );
        const renamedFile = compareRes.data?.files?.find((item: { path: string }) => item.path === "docs/guide.md");
        expect(String(renamedFile?.status || "")).toMatch(/^R/);
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );

  it(
    "diff.get 在 revisionToRevision 模式下应支持 rename oldPath 并返回左右版本内容",
    async () => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-compare-diff-"));
      const userDataPath = await fsp.mkdtemp(path.join(os.tmpdir(), "codexflow-branch-compare-diff-userdata-"));
      try {
        await gitAsync(root, ["init"]);
        await gitAsync(root, ["config", "user.name", "CodexFlow"]);
        await gitAsync(root, ["config", "user.email", "codexflow@example.com"]);
        await fsp.mkdir(path.join(root, "docs"), { recursive: true });
        await fsp.writeFile(path.join(root, "docs", "README.md"), "base line\n", "utf8");
        await gitAsync(root, ["add", "docs/README.md"]);
        await gitAsync(root, ["commit", "-m", "init compare diff"]);
        const defaultBranch = String(await gitAsync(root, ["branch", "--show-current"])).trim() || "main";

        await gitAsync(root, ["checkout", "-b", "feature/rename"]);
        await gitAsync(root, ["mv", "docs/README.md", "docs/guide.md"]);
        await fsp.writeFile(path.join(root, "docs", "guide.md"), "base line\nbranch line\n", "utf8");
        await gitAsync(root, ["add", "docs/guide.md"]);
        await gitAsync(root, ["commit", "-m", "rename guide"]);

        const diffRes = await dispatchGitFeatureAction({
          action: "diff.get",
          payload: {
            repoPath: root,
            path: "docs/guide.md",
            oldPath: "docs/README.md",
            mode: "revisionToRevision",
            hash: "feature/rename",
            hashes: [defaultBranch, "feature/rename"],
          },
          userDataPath,
        });
        expect(diffRes.ok, String(diffRes.error || "")).toBe(true);
        expect(diffRes.data?.mode).toBe("revisionToRevision");
        expect(diffRes.data?.oldPath).toBe("docs/README.md");
        expect(diffRes.data?.hashes).toEqual([defaultBranch, "feature/rename"]);
        expect(diffRes.data?.leftText).toContain("base line");
        expect(diffRes.data?.leftText).not.toContain("branch line");
        expect(diffRes.data?.rightText).toContain("branch line");
        expect(diffRes.data?.hunks?.length).toBeGreaterThan(0);
      } finally {
        try { await fsp.rm(root, { recursive: true, force: true }); } catch {}
        try { await fsp.rm(userDataPath, { recursive: true, force: true }); } catch {}
      }
    },
    { timeout: 60_000 },
  );
});
