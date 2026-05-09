import { describe, expect, it } from "vitest";
import {
  buildCommitTreeSharedMenuSections,
  shouldShowCommitTreeSharedDeleteAction,
} from "./context-menu-model";

/**
 * 把共享菜单模型压平成稳定 id 列表，便于断言层级与顺序。
 */
function flattenMenuIds(sections: ReturnType<typeof buildCommitTreeSharedMenuSections>): string[][] {
  return sections.map((section) => section.map((node) => node.id));
}

describe("commit tree context menu model", () => {
  it("应按 IDEA 提交工具窗口结构输出共享菜单，并移除 changelist 管理段", () => {
    const sections = buildCommitTreeSharedMenuSections({
      selection: {
        canCommit: true,
        canRollback: true,
        canMoveToList: true,
        canShowDiff: true,
        canOpenSource: true,
        canDelete: true,
        canAddToVcs: false,
        canIgnore: false,
        canShowHistory: true,
        canShelve: true,
      },
      singleSelection: true,
    });

    expect(flattenMenuIds(sections)).toEqual([
      ["commitFile", "rollback", "move", "showDiff", "showStandaloneDiff", "editSource"],
      ["delete"],
      ["createPatch", "copyPatch", "shelve"],
      ["refresh", "localHistory", "git"],
    ]);
    expect(sections.flatMap((section) => section.map((node) => node.id))).not.toContain("newChangelist");
  });

  it("存在未跟踪文件时应暴露 add-to-vcs 与 ignore，且历史子菜单在非单选时禁用", () => {
    const sections = buildCommitTreeSharedMenuSections({
      selection: {
        canCommit: false,
        canRollback: false,
        canMoveToList: false,
        canShowDiff: false,
        canOpenSource: false,
        canDelete: false,
        canAddToVcs: true,
        canIgnore: true,
        canShowHistory: true,
        canShelve: false,
      },
      singleSelection: false,
    });

    expect(flattenMenuIds(sections)[1]).toEqual(["delete", "addToVcs", "ignore"]);
    const localHistory = sections[3]?.find((node) => node.id === "localHistory");
    expect(localHistory?.kind).toBe("submenu");
    expect(localHistory?.disabled).toBe(true);
  });

  it("目录类单选应保留删除入口，并隐藏 edit-source", () => {
    const sections = buildCommitTreeSharedMenuSections({
      selection: {
        canCommit: true,
        canRollback: true,
        canMoveToList: true,
        canShowDiff: true,
        canOpenSource: false,
        canDelete: true,
        canAddToVcs: false,
        canIgnore: false,
        canShowHistory: true,
        canShelve: false,
      },
      singleSelection: true,
      showAddToVcs: true,
      showDelete: true,
      showEditSource: false,
    });

    expect(flattenMenuIds(sections)).toEqual([
      ["commitFile", "rollback", "move", "showDiff", "showStandaloneDiff"],
      ["delete", "addToVcs"],
      ["createPatch", "copyPatch", "shelve"],
      ["refresh", "localHistory", "git"],
    ]);
  });

  it("删除入口显示规则应对目录类单选对齐 IDEA", () => {
    expect(shouldShowCommitTreeSharedDeleteAction({
      exactlySelectedFileCount: 0,
      singleSelection: true,
      selectedNodeKind: "directory",
      selectedNodeDisplayPath: ".serena",
    })).toBe(true);
    expect(shouldShowCommitTreeSharedDeleteAction({
      exactlySelectedFileCount: 0,
      singleSelection: true,
      selectedNodeKind: "repository",
    })).toBe(true);
    expect(shouldShowCommitTreeSharedDeleteAction({
      exactlySelectedFileCount: 0,
      singleSelection: false,
      selectedNodeKind: "directory",
    })).toBe(false);
  });

  it("折叠后的多级目录展示节点不应显示删除入口", () => {
    expect(shouldShowCommitTreeSharedDeleteAction({
      exactlySelectedFileCount: 0,
      singleSelection: true,
      selectedNodeKind: "directory",
      selectedNodeDisplayPath: ".claude\\skills\\gitnexus",
    })).toBe(false);
  });

  it("amend 来源应对齐 IDEA：启用提交/回滚，但继续禁用搁置", () => {
    const sections = buildCommitTreeSharedMenuSections({
      selection: {
        canCommit: true,
        canRollback: true,
        canMoveToList: true,
        canShowDiff: true,
        canOpenSource: true,
        canDelete: true,
        canAddToVcs: false,
        canIgnore: false,
        canShowHistory: true,
        canShelve: false,
      },
      singleSelection: true,
    });

    expect(sections[0][0]).toMatchObject({ id: "commitFile", disabled: false });
    expect(sections[0][1]).toMatchObject({ id: "rollback", disabled: false });
    expect(sections[0][2]).toMatchObject({ id: "move", disabled: false });
    expect(sections[0][3]).toMatchObject({ id: "showDiff", disabled: false });
    expect(sections[0][4]).toMatchObject({ id: "showStandaloneDiff", disabled: false });
    expect(sections[0][5]).toMatchObject({ id: "editSource", disabled: false });
    expect(sections[1][0]).toMatchObject({ id: "delete", disabled: false });
    expect(sections[2][0]).toMatchObject({ id: "createPatch", disabled: false });
    expect(sections[2][1]).toMatchObject({ id: "copyPatch", disabled: false });
    expect(sections[2][2]).toMatchObject({ id: "shelve", disabled: true });
    const localHistory = sections[3]?.find((node) => node.id === "localHistory");
    expect(localHistory?.kind).toBe("submenu");
    expect(localHistory?.disabled).toBe(false);
  });
});
