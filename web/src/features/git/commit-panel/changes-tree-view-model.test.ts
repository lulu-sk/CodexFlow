import { describe, expect, it } from "vitest";
import {
  buildChangeEntryGroups,
  buildCommitNodeMap,
  buildCommitTreeGroupState,
  buildCommitTreeGroupSummary,
  buildCommitPanelRenderRows,
  buildCommitTree,
  buildCommitTreeGroups,
  formatCommitTreeGroupSummary,
  flattenCommitTree,
  isCommitTreeGroupVisible,
} from "./changes-tree-view-model";
import { DEFAULT_COMMIT_PANEL_MANY_FILES_THRESHOLD } from "./config";
import { resolveGitTextWith } from "../git-i18n";

describe("commit panel tree view model", () => {
  it("changelist 模式下应保留 changelist 节点，并把 unversioned/ignored 作为 helper node 展示", () => {
    const groups = buildChangeEntryGroups({
      entries: [
        { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        { path: "tmp/new.ts", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "default" },
      ],
      ignoredEntries: [
        { path: "dist/a.js", x: "!", y: "!", staged: false, unstaged: false, untracked: false, ignored: true, renamed: false, deleted: false, statusText: "已忽略", changeListId: "" },
      ],
      changeLists: [{ id: "default", name: "默认" }],
      options: { stagingAreaEnabled: false, changeListsEnabled: true },
    });
    expect(groups.map((group) => group.kind)).toEqual(["changelist", "unversioned", "ignored"]);
  });

  it("冲突节点应按 sort weight 排在 changelist 前面", () => {
    const groups = buildChangeEntryGroups({
      entries: [
        { path: "src/conflict.ts", x: "U", y: "U", staged: true, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "冲突", changeListId: "default", conflictState: "conflict" },
        { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      ],
      ignoredEntries: [],
      changeLists: [{ id: "default", name: "默认" }],
      options: { stagingAreaEnabled: false, changeListsEnabled: true },
    });
    expect(groups.map((group) => group.kind)).toEqual(["conflict", "changelist"]);
    expect(groups[0]?.sortWeight).toBe(0);
  });

  it("conflict/resolved-conflict 节点应生成上游语义对应的 hover/open 动作", () => {
    const treeGroups = buildCommitTreeGroups([
      {
        key: "special:conflicts",
        label: "冲突",
        entries: [{ path: "src/conflict.ts", x: "U", y: "U", staged: true, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "冲突", changeListId: "default", conflictState: "conflict" }],
        kind: "conflict",
      },
      {
        key: "special:resolved-conflicts",
        label: "已解决冲突",
        entries: [{ path: "src/resolved.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已解决冲突", changeListId: "default", conflictState: "resolved" }],
        kind: "resolved-conflict",
      },
    ], ["directory"], {});
    const conflictNode = treeGroups[0]?.treeRows.find((row) => row.node.isFile)?.node;
    const resolvedNode = treeGroups[1]?.treeRows.find((row) => row.node.isFile)?.node;
    expect(conflictNode?.hoverAction?.action).toBe("open-merge");
    expect(conflictNode?.openHandler?.action).toBe("open-merge");
    expect(conflictNode?.selectionFlags?.hideInclusionCheckbox).toBe(true);
    expect(resolvedNode?.hoverAction?.action).toBe("rollback-resolved");
    expect(resolvedNode?.openHandler).toBeUndefined();
    expect(resolvedNode?.selectionFlags?.hideInclusionCheckbox).toBe(true);
  });

  it("staged/unstaged/unversioned 节点应生成 stage/reset hover 动作，并允许目录节点复用", () => {
    const treeGroups = buildCommitTreeGroups([
      {
        key: "staging:staged",
        label: "已暂存",
        entries: [{ path: "src/staged/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }],
        kind: "staged",
      },
      {
        key: "staging:unstaged",
        label: "未暂存",
        entries: [{ path: "src/unstaged/b.ts", x: ".", y: "M", staged: false, unstaged: true, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "未暂存", changeListId: "default" }],
        kind: "unstaged",
      },
      {
        key: "special:unversioned",
        label: "未跟踪文件",
        entries: [{ path: "src/new/c.ts", x: "?", y: "?", staged: false, unstaged: true, untracked: true, ignored: false, renamed: false, deleted: false, statusText: "未跟踪", changeListId: "" }],
        kind: "unversioned",
      },
    ], ["directory"], {});
    const stagedDirectoryNode = treeGroups[0]?.treeRows.find((row) => !row.node.isFile)?.node;
    const unstagedFileNode = treeGroups[1]?.treeRows.find((row) => row.node.isFile)?.node;
    const unversionedFileNode = treeGroups[2]?.treeRows.find((row) => row.node.isFile)?.node;
    expect(stagedDirectoryNode?.hoverAction?.action).toBe("unstage");
    expect(stagedDirectoryNode?.openHandler).toBeUndefined();
    expect(unstagedFileNode?.hoverAction?.action).toBe("stage");
    expect(unversionedFileNode?.hoverAction?.action).toBe("stage");
  });

  it("目录树应生成稳定节点并可扁平化输出", () => {
    const tree = buildCommitTree([
      { path: "src/app/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "src/app/b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ], "cl:default", true);
    const rows = flattenCommitTree(tree, {});
    expect(rows[0]?.node.isFile).toBe(false);
    expect(rows.some((row) => row.node.fullPath === "src/app/a.ts")).toBe(true);
  });

  it("连续单子目录应折叠为上游风格的组合路径显示", () => {
    const tree = buildCommitTree([
      { path: "web/src/App.tsx", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "web/src/lib/render.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ], "cl:default", ["directory"]);

    expect(tree[0]?.kind).toBe("directory");
    expect(tree[0]?.fullPath).toBe("web/src");
    expect(tree[0]?.textPresentation).toBe("web\\src");
    expect(tree[0]?.children.map((child) => child.fullPath)).toEqual(["web/src/lib", "web/src/App.tsx"]);
  });

  it("单一项目根仓不应额外显示仓库根节点", () => {
    const tree = buildCommitTree([
      {
        path: "Client/Assets/AddressableAssetsData/AssetGroups/Default Local Group.asset",
        x: "M",
        y: ".",
        staged: true,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: false,
        statusText: "已暂存",
        changeListId: "default",
        repositoryId: "example-repo",
        repositoryRoot: "",
        repositoryName: "ExampleRepo",
      },
      {
        path: "Client/Assets/Art/icon.png",
        x: "M",
        y: ".",
        staged: true,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: false,
        statusText: "已暂存",
        changeListId: "default",
        repositoryId: "example-repo",
        repositoryRoot: "",
        repositoryName: "ExampleRepo",
      },
    ], "cl:default", ["repository", "directory"]);

    expect(tree[0]?.kind).toBe("directory");
    expect(tree[0]?.textPresentation).toBe("Client\\Assets");
    const assetChildTexts = (tree[0]?.children.map((child) => child.textPresentation) || [])
      .filter((text): text is string => Boolean(text))
      .sort((left, right) => left.localeCompare(right, "zh-CN"));

    expect(assetChildTexts).toEqual([
      "AddressableAssetsData\\AssetGroups",
      "Art",
    ]);
  });

  it("多仓场景应保留仓库根节点并按仓库根裁剪目录前缀", () => {
    const tree = buildCommitTree([
      {
        path: "Client/Assets/Art/icon.png",
        x: "M",
        y: ".",
        staged: true,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: false,
        statusText: "已暂存",
        changeListId: "default",
        repositoryId: "root",
        repositoryRoot: "",
        repositoryName: "Root",
      },
      {
        path: "modules/lib/src/index.ts",
        x: "M",
        y: ".",
        staged: true,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: false,
        statusText: "已暂存",
        changeListId: "default",
        repositoryId: "modules/lib",
        repositoryRoot: "modules/lib",
        repositoryName: "lib",
      },
    ], "cl:default", ["repository", "directory"]);

    const rootNode = tree.find((node) => node.name === "Root");
    const libNode = tree.find((node) => node.name === "lib");
    expect(tree.map((node) => node.kind)).toEqual(["repository", "repository"]);
    expect(rootNode?.children[0]?.textPresentation).toBe("Client\\Assets\\Art");
    expect(libNode?.children[0]?.textPresentation).toBe("src");
  });

  it("节点索引应覆盖被折叠的隐藏子节点，供选择恢复与 Select In 使用", () => {
    const groups = buildCommitTreeGroups([{
      key: "cl:default",
      label: "默认",
      entries: [{ path: "src/nested/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }],
      kind: "changelist",
      changeListId: "default",
    }], ["directory"], {
      "ct:cl:default:default:src": true,
      "ct:cl:default:default:src/nested": false,
    });
    const nodeMap = buildCommitNodeMap(groups);
    expect(nodeMap.has("ct:cl:default:default:src/nested/a.ts")).toBe(true);
  });

  it("grouping key 集应按 repository -> module -> directory 组装树层级", () => {
    const tree = buildCommitTree([
      {
        path: "packages/app/src/main.ts",
        x: "M",
        y: ".",
        staged: true,
        unstaged: false,
        untracked: false,
        ignored: false,
        renamed: false,
        deleted: false,
        statusText: "已暂存",
        changeListId: "default",
        repositoryId: "modules/lib",
        repositoryRoot: "modules/lib",
        repositoryName: "lib",
        moduleId: "packages/app",
        moduleName: "@repo/app",
      },
    ], "cl:default", ["repository", "module", "directory"]);
    expect(tree[0]?.kind).toBe("repository");
    expect(tree[0]?.children[0]?.kind).toBe("module");
    expect(tree[0]?.children[0]?.children[0]?.kind).toBe("directory");
    expect(tree[0]?.children[0]?.children[0]?.name).toBe("src");
    expect(tree[0]?.children[0]?.children[0]?.children[0]?.kind).toBe("file");
  });

  it("空 changelist 应保留可见分组行，避免创建后被 UI 整体过滤", () => {
    const groups = buildCommitTreeGroups([
      {
        key: "cl:default",
        label: "默认",
        entries: [],
        kind: "changelist",
        changeListId: "default",
      },
    ], true, {});
    const rows = buildCommitPanelRenderRows(groups, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("group");
    if (rows[0]?.kind === "group") expect(rows[0].group.changeListId).toBe("default");
  });

  it("render rows 应暴露统一 text presentation，供 speed search/copy provider 复用", () => {
    const groups = buildCommitTreeGroups([{
      key: "cl:default",
      label: "默认",
      entries: [{ path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" }],
      kind: "changelist",
      changeListId: "default",
      helper: false,
      summary: { fileCount: 1, directoryCount: 1 },
      state: { updating: false, outdatedFileCount: 0 },
      renderPayload: {
        textPresentation: "默认",
        manyFiles: false,
        browseActionVisible: false,
        updating: false,
        outdatedFileCount: 0,
        infoMarkerVisible: true,
        isDefault: true,
      },
      selectionFlags: {
        selectable: true,
        inclusionVisible: true,
        inclusionEnabled: true,
        hideInclusionCheckbox: false,
        helper: false,
      },
    }], true, {});
    const rows = buildCommitPanelRenderRows(groups, {});
    expect(rows[0]?.textPresentation).toBe("默认");
    expect(rows[1]?.textPresentation).toBe("src");
    expect(rows[2]?.textPresentation).toBe("a.ts");
  });

  it("ignored/unversioned 超过上游 many files 阈值时，不应继续在树中展开全部子节点", () => {
    const entries = Array.from({ length: DEFAULT_COMMIT_PANEL_MANY_FILES_THRESHOLD + 1 }, (_, index) => ({
      path: `dist/${index}.txt`,
      x: "!",
      y: "!",
      staged: false,
      unstaged: false,
      untracked: false,
      ignored: true,
      renamed: false,
      deleted: false,
      statusText: "已忽略",
      changeListId: "",
    }));
    const groups = buildChangeEntryGroups({
      entries: [],
      ignoredEntries: entries,
      changeLists: [{ id: "default", name: "默认" }],
      options: { stagingAreaEnabled: false, changeListsEnabled: true },
    });
    expect(groups[0]?.manyFiles || groups[1]?.manyFiles).toBe(true);

    const treeGroups = buildCommitTreeGroups(groups, true, {});
    const ignoredGroup = treeGroups.find((group) => group.kind === "ignored");
    expect(ignoredGroup?.manyFiles).toBe(true);
    expect(ignoredGroup?.treeRows).toHaveLength(0);
  });

  it("many files 阈值应来自外部配置，而不是写死在 view model 内", () => {
    const entries = Array.from({ length: 3 }, (_, index) => ({
      path: `dist/${index}.txt`,
      x: "!",
      y: "!",
      staged: false,
      unstaged: false,
      untracked: false,
      ignored: true,
      renamed: false,
      deleted: false,
      statusText: "已忽略",
      changeListId: "",
    }));
    const groups = buildChangeEntryGroups({
      entries: [],
      ignoredEntries: entries,
      changeLists: [{ id: "default", name: "默认" }],
      options: { stagingAreaEnabled: false, changeListsEnabled: true },
      manyFilesThreshold: 2,
    });
    expect(groups.find((group) => group.kind === "ignored")?.manyFiles).toBe(true);
  });

  it("helper node 计数文案应区分目录和文件", () => {
    const summary = buildCommitTreeGroupSummary([
      { path: "src/app/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "src/lib/b.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      { path: "README.md", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
    ]);
    expect(summary).toEqual({ directoryCount: 3, fileCount: 3 });
    expect(formatCommitTreeGroupSummary(summary)).toBe("3 个目录，3 个文件");
  });

  it("helper node 计数文案经 translate 回调返回模板时仍应完成兜底插值", () => {
    const summary = { directoryCount: 2, fileCount: 4 };
    const translate = (key: string, fallback: string, values?: Record<string, unknown>): string => {
      return resolveGitTextWith(
        (_innerKey, options) => String(options.defaultValue || ""),
        key,
        fallback,
        values,
      );
    };
    expect(formatCommitTreeGroupSummary(summary, translate)).toBe("2 个目录，4 个文件");
  });

  it("helper node 状态应统一进入 view model，而不是由 UI 零散拼接", () => {
    expect(buildCommitTreeGroupState({
      updating: true,
      frozenReason: "当前仓库处于 rebasing 状态",
      outdatedFileCount: 2,
    })).toEqual({
      updating: true,
      frozenReason: "当前仓库处于 rebasing 状态",
      outdatedFileCount: 2,
    });
  });

  it("modifier group 应进入统一排序与节点元数据链路，而不是只在 UI 临时拼接", () => {
    const groups = buildChangeEntryGroups({
      entries: [
        { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
      ],
      ignoredEntries: [],
      changeLists: [{ id: "default", name: "默认" }],
      options: { stagingAreaEnabled: false, changeListsEnabled: true },
      modifierGroups: [{
        key: "modifier:edited-commit:amend",
        label: "修改上一提交",
        entries: [
          { path: "src/a.ts", x: "M", y: ".", staged: true, unstaged: false, untracked: false, ignored: false, renamed: false, deleted: false, statusText: "已暂存", changeListId: "default" },
        ],
        kind: "edited-commit",
        helper: true,
        sourceKind: "modifier",
        sourceId: "amend",
      }],
    });
    expect(groups.map((group) => group.kind)).toEqual(["changelist", "edited-commit"]);
    const treeGroups = buildCommitTreeGroups(groups, ["directory"], {});
    const amendNode = treeGroups
      .find((group) => group.kind === "edited-commit")
      ?.treeRows
      .find((row) => row.node.isFile)?.node;
    expect(amendNode?.sourceKind).toBe("modifier");
    expect(amendNode?.sourceId).toBe("amend");
    expect(amendNode?.selectionFlags?.hideInclusionCheckbox).toBe(true);
  });

  it("edited-commit loading group 即使暂时没有文件也应保留可见头部，避免 amend 加载期间整块消失", () => {
    const treeGroups = buildCommitTreeGroups([
      {
        key: "modifier:edited-commit:amend",
        label: "正在读取上一提交",
        entries: [],
        kind: "edited-commit",
        helper: true,
        sourceKind: "modifier",
        sourceId: "amend",
        state: buildCommitTreeGroupState({ updating: true }),
        summary: { directoryCount: 0, fileCount: 0 },
        sortWeight: 10,
        stableId: "modifier:edited-commit:amend",
        selectionFlags: {
          selectable: true,
          inclusionVisible: false,
          inclusionEnabled: false,
          hideInclusionCheckbox: true,
          helper: true,
        },
        renderPayload: {
          textPresentation: "正在读取上一提交",
          manyFiles: false,
          browseActionVisible: false,
          updating: true,
          outdatedFileCount: 0,
          infoMarkerVisible: false,
          isDefault: false,
        },
        actionGroupId: "commit.main.popup",
        toolbarActionGroupId: "commit.main.toolbar",
      },
    ], ["directory"], {});

    expect(isCommitTreeGroupVisible(treeGroups[0]!)).toBe(true);
  });
});
