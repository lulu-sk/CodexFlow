export type ResolvedWorkbenchPanel = {
  width: number;
  proportion: number;
};

export type ResolvedWorkbenchBottomPanels = {
  branchWidth: number;
  detailWidth: number;
  branchProportion: number;
  detailProportion: number;
  centerWidth: number;
};

export const DEFAULT_MAIN_PANEL_PROPORTION = 0.4;
export const DEFAULT_BRANCH_PANEL_PROPORTION = 0.22;
export const DEFAULT_DETAIL_PANEL_PROPORTION = 0.3;

const MAIN_LEFT_PANEL_MIN_WIDTH = 220;
const MAIN_LEFT_PANEL_MAX_WIDTH = 880;
const MAIN_RIGHT_PANEL_MIN_WIDTH = 160;

const BOTTOM_BRANCH_PANEL_MIN_WIDTH = 160;
const BOTTOM_BRANCH_PANEL_MAX_WIDTH = 420;
const BOTTOM_DETAIL_PANEL_MIN_WIDTH = 220;
const BOTTOM_DETAIL_PANEL_MAX_WIDTH = 520;
const BOTTOM_CENTER_PANEL_MIN_WIDTH = 320;

/**
 * 将数值夹紧到指定区间，统一处理布局宽度与比例的边界。
 */
function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * 规范化左侧提交面板的缓存像素宽度，统一复用存储与初始化阶段的边界处理。
 */
export function normalizeMainPanelStoredWidth(value: number | null | undefined): number {
  return Math.round(clampNumber(Number(value) || MAIN_LEFT_PANEL_MIN_WIDTH, MAIN_LEFT_PANEL_MIN_WIDTH, MAIN_LEFT_PANEL_MAX_WIDTH));
}

/**
 * 规范化分栏比例；非法值时回退到给定默认值。
 */
export function normalizeWorkbenchProportion(value: number | null | undefined, fallback: number): number {
  if (value == null) return fallback;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return clampNumber(raw, 0.1, 0.9);
}

/**
 * 根据当前容器宽度推导主提交面板应占的像素宽度，并保留比例用于窗口缩放时自动跟随。
 * - 参考 IDEA `ChangesViewCommitPanelSplitter` 的 proportion 思路，避免固定像素宽度在窗口收窄时浪费空间。
 * - 右侧 Diff 区本身已经使用 `minmax(0,1fr)` + 工具栏横向滚动处理窄宽度，因此这里只保留技术最小宽度，
 *   避免用户手动拖拽时被过高的保底宽度过早锁死。
 */
export function resolveMainPanelLayout(
  containerWidth: number,
  preferredProportion: number | null | undefined,
  fallbackWidth: number,
  splitterSize: number,
): ResolvedWorkbenchPanel {
  const usableWidth = Math.max(0, Math.floor(containerWidth - splitterSize));
  if (usableWidth <= 0) {
    return {
      width: Math.max(0, Math.round(fallbackWidth || MAIN_LEFT_PANEL_MIN_WIDTH)),
      proportion: normalizeWorkbenchProportion(preferredProportion, DEFAULT_MAIN_PANEL_PROPORTION),
    };
  }

  const maxWidth = Math.min(MAIN_LEFT_PANEL_MAX_WIDTH, Math.max(0, usableWidth - MAIN_RIGHT_PANEL_MIN_WIDTH));
  const minWidth = Math.min(MAIN_LEFT_PANEL_MIN_WIDTH, maxWidth);
  const fallbackProportion = clampNumber((Number(fallbackWidth) || MAIN_LEFT_PANEL_MIN_WIDTH) / usableWidth, 0.1, 0.9);
  const normalizedProportion = normalizeWorkbenchProportion(preferredProportion, fallbackProportion);
  const widthFromProportion = usableWidth * normalizedProportion;
  const resolvedWidth = Math.round(clampNumber(widthFromProportion, minWidth, Math.max(minWidth, maxWidth)));
  return {
    width: resolvedWidth,
    proportion: usableWidth > 0 ? clampNumber(resolvedWidth / usableWidth, 0.1, 0.9) : normalizedProportion,
  };
}

/**
 * 根据底部三列容器宽度解析“分支树 / 日志 / 提交详情”的实际宽度。
 * - 分支树与提交详情按比例自动伸缩；
 * - 中央日志列始终优先保留最小阅读空间；
 * - 行为参考 IDEA 在 VCS Log / Changes 中对 splitter proportion 的持久化方式。
 */
export function resolveBottomPanelLayout(
  containerWidth: number,
  preferredBranchProportion: number | null | undefined,
  preferredDetailProportion: number | null | undefined,
  fallbackBranchWidth: number,
  fallbackDetailWidth: number,
  splitterSize: number,
): ResolvedWorkbenchBottomPanels {
  const usableWidth = Math.max(0, Math.floor(containerWidth - splitterSize * 2));
  if (usableWidth <= 0) {
    return {
      branchWidth: Math.max(0, Math.round(fallbackBranchWidth || BOTTOM_BRANCH_PANEL_MIN_WIDTH)),
      detailWidth: Math.max(0, Math.round(fallbackDetailWidth || BOTTOM_DETAIL_PANEL_MIN_WIDTH)),
      branchProportion: normalizeWorkbenchProportion(preferredBranchProportion, DEFAULT_BRANCH_PANEL_PROPORTION),
      detailProportion: normalizeWorkbenchProportion(preferredDetailProportion, DEFAULT_DETAIL_PANEL_PROPORTION),
      centerWidth: 0,
    };
  }

  const maxBranchWidth = Math.min(
    BOTTOM_BRANCH_PANEL_MAX_WIDTH,
    Math.max(BOTTOM_BRANCH_PANEL_MIN_WIDTH, usableWidth - BOTTOM_CENTER_PANEL_MIN_WIDTH - BOTTOM_DETAIL_PANEL_MIN_WIDTH),
  );
  const maxDetailWidth = Math.min(
    BOTTOM_DETAIL_PANEL_MAX_WIDTH,
    Math.max(BOTTOM_DETAIL_PANEL_MIN_WIDTH, usableWidth - BOTTOM_CENTER_PANEL_MIN_WIDTH - BOTTOM_BRANCH_PANEL_MIN_WIDTH),
  );

  const fallbackBranchProportion = clampNumber((Number(fallbackBranchWidth) || BOTTOM_BRANCH_PANEL_MIN_WIDTH) / usableWidth, 0.1, 0.5);
  const fallbackDetailProportion = clampNumber((Number(fallbackDetailWidth) || BOTTOM_DETAIL_PANEL_MIN_WIDTH) / usableWidth, 0.15, 0.55);
  const normalizedBranchProportion = normalizeWorkbenchProportion(preferredBranchProportion, fallbackBranchProportion);
  const normalizedDetailProportion = normalizeWorkbenchProportion(preferredDetailProportion, fallbackDetailProportion);

  let branchWidth = Math.round(clampNumber(usableWidth * normalizedBranchProportion, BOTTOM_BRANCH_PANEL_MIN_WIDTH, maxBranchWidth));
  let detailWidth = Math.round(clampNumber(usableWidth * normalizedDetailProportion, BOTTOM_DETAIL_PANEL_MIN_WIDTH, maxDetailWidth));

  let centerWidth = usableWidth - branchWidth - detailWidth;
  if (centerWidth < BOTTOM_CENTER_PANEL_MIN_WIDTH) {
    const deficit = BOTTOM_CENTER_PANEL_MIN_WIDTH - centerWidth;
    const reducibleDetail = Math.max(0, detailWidth - BOTTOM_DETAIL_PANEL_MIN_WIDTH);
    const detailReduction = Math.min(deficit, reducibleDetail);
    detailWidth -= detailReduction;

    const remainingDeficit = deficit - detailReduction;
    if (remainingDeficit > 0) {
      const reducibleBranch = Math.max(0, branchWidth - BOTTOM_BRANCH_PANEL_MIN_WIDTH);
      branchWidth -= Math.min(remainingDeficit, reducibleBranch);
    }
    centerWidth = usableWidth - branchWidth - detailWidth;
  }

  return {
    branchWidth,
    detailWidth,
    branchProportion: usableWidth > 0 ? clampNumber(branchWidth / usableWidth, 0.1, 0.5) : normalizedBranchProportion,
    detailProportion: usableWidth > 0 ? clampNumber(detailWidth / usableWidth, 0.15, 0.55) : normalizedDetailProportion,
    centerWidth: Math.max(0, centerWidth),
  };
}

/**
 * 根据左侧提交面板宽度与上半区可用高度推导提交消息输入框高度，
 * 在窄窗或矮窗时主动压缩到约 1~2 行，优先把空间让给变更列表。
 */
export function resolveCommitMessageEditorHeight(panelWidth: number, containerHeight: number = Number.POSITIVE_INFINITY): number {
  let resolvedHeight = 56;
  if (panelWidth <= 260) resolvedHeight = 42;
  else if (panelWidth <= 360) resolvedHeight = 48;

  if (Number.isFinite(containerHeight)) {
    if (containerHeight <= 340) resolvedHeight = Math.max(40, resolvedHeight - 8);
    else if (containerHeight <= 460) resolvedHeight = Math.max(40, resolvedHeight - 4);
  }

  return resolvedHeight;
}
