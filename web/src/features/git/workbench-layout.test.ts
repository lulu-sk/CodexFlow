import { describe, expect, it } from "vitest";

import {
  DEFAULT_BRANCH_PANEL_PROPORTION,
  DEFAULT_DETAIL_PANEL_PROPORTION,
  DEFAULT_MAIN_PANEL_PROPORTION,
  normalizeMainPanelStoredWidth,
  normalizeWorkbenchProportion,
  resolveBottomPanelLayout,
  resolveCommitMessageEditorHeight,
  resolveMainPanelLayout,
} from "./workbench-layout";

const SPLITTER_SIZE = 2;

describe("workbench-layout", () => {
  /**
   * 验证主提交面板会按比例随容器宽度变化，而不是固定为旧像素值。
   */
  it("主提交面板按比例自适应", () => {
    const wide = resolveMainPanelLayout(1200, DEFAULT_MAIN_PANEL_PROPORTION, 320, SPLITTER_SIZE);
    const narrow = resolveMainPanelLayout(860, wide.proportion, wide.width, SPLITTER_SIZE);
    expect(wide.width).toBeGreaterThan(narrow.width);
    expect(Math.abs(narrow.proportion - wide.proportion)).toBeLessThan(0.02);
  });

  /**
   * 验证超宽窗口下左侧提交面板不再被旧的固定上限卡死，仍可保留右侧最小阅读区。
   */
  it("超宽窗口下主提交面板可大于旧上限", () => {
    const resolved = resolveMainPanelLayout(1600, DEFAULT_MAIN_PANEL_PROPORTION, 420, SPLITTER_SIZE);
    expect(resolved.width).toBeGreaterThan(560);
    expect(1600 - SPLITTER_SIZE - resolved.width).toBeGreaterThanOrEqual(320);
  });

  /**
   * 验证手动拖拽放大左栏时，不会再被过高的右侧保底宽度提前卡在狭窄值。
   */
  it("主提交面板拖拽放大时不会被过早锁死", () => {
    const resolved = resolveMainPanelLayout(720, null, 480, SPLITTER_SIZE);
    expect(resolved.width).toBeGreaterThanOrEqual(480);
  });

  /**
   * 验证缺省比例值会正确回退，而不是把 `null` 误判为 0 后强行夹到 0.1。
   */
  it("空比例会回退到 fallback", () => {
    expect(normalizeWorkbenchProportion(null, 0.62)).toBe(0.62);
    expect(normalizeWorkbenchProportion(undefined, 0.38)).toBe(0.38);
  });

  /**
   * 验证旧缓存中的异常窄宽度会被规范到新的合法区间内，避免初始化后再次卡死。
   */
  it("主提交面板缓存宽度会被统一规范", () => {
    expect(normalizeMainPanelStoredWidth(180)).toBe(220);
    expect(normalizeMainPanelStoredWidth(1200)).toBe(880);
  });

  /**
   * 验证底部三列在窗口收窄时优先回收左右栏，给中间日志保留阅读空间。
   */
  it("底部三列收窄时保留中心区域", () => {
    const wide = resolveBottomPanelLayout(1200, DEFAULT_BRANCH_PANEL_PROPORTION, DEFAULT_DETAIL_PANEL_PROPORTION, 220, 320, SPLITTER_SIZE);
    const narrow = resolveBottomPanelLayout(860, wide.branchProportion, wide.detailProportion, wide.branchWidth, wide.detailWidth, SPLITTER_SIZE);
    expect(wide.branchWidth).toBeGreaterThan(narrow.branchWidth);
    expect(wide.detailWidth).toBeGreaterThan(narrow.detailWidth);
    expect(narrow.centerWidth).toBeGreaterThanOrEqual(320);
  });

  /**
   * 验证在极窄宽度下，底部布局仍能给详情栏和分支栏保留最小可用空间。
   */
  it("极窄宽度下仍返回稳定布局", () => {
    const resolved = resolveBottomPanelLayout(740, DEFAULT_BRANCH_PANEL_PROPORTION, DEFAULT_DETAIL_PANEL_PROPORTION, 220, 320, SPLITTER_SIZE);
    expect(resolved.branchWidth).toBeGreaterThanOrEqual(160);
    expect(resolved.detailWidth).toBeGreaterThanOrEqual(220);
    expect(resolved.centerWidth).toBeGreaterThanOrEqual(0);
  });

  /**
   * 验证提交消息输入框会随左栏宽度与上半区高度同步收敛，避免占据过高比例。
   */
  it("提交消息输入框高度随左栏收敛", () => {
    expect(resolveCommitMessageEditorHeight(240)).toBe(42);
    expect(resolveCommitMessageEditorHeight(300)).toBe(48);
    expect(resolveCommitMessageEditorHeight(420)).toBe(56);
    expect(resolveCommitMessageEditorHeight(420, 320)).toBe(48);
    expect(resolveCommitMessageEditorHeight(300, 320)).toBe(40);
  });
});
