export type DirRowDropPosition = "before" | "after" | "asChild";

export type ResolveDirRowDropPositionOptions = {
  /** 是否允许将源节点放置为目标节点的子级 */
  allowAsChild: boolean;
  /** 行内上下边缘阈值（0~0.49），落在边缘会被判定为 before/after */
  edgeThreshold?: number;
};

/**
 * 计算目录树“根节点行”上的拖拽放置位置：
 * - 上下边缘：before / after（用于根级排序，也用于将子节点提升为根级）
 * - 中间区域：若允许则 asChild，否则按上下半区回退为 before/after
 * @param ratio 鼠标在行内的相对位置（0~1，0=顶部，1=底部）
 * @param options 计算选项
 * @returns 放置位置
 */
export function resolveDirRowDropPosition(ratio: number, options: ResolveDirRowDropPositionOptions): DirRowDropPosition {
  const rawRatio = Number.isFinite(ratio) ? ratio : 0.5;
  const clampedRatio = Math.max(0, Math.min(1, rawRatio));
  const rawEdge = Number.isFinite(options.edgeThreshold) ? (options.edgeThreshold as number) : 0.25;
  const edgeThreshold = Math.max(0, Math.min(0.49, rawEdge));

  if (clampedRatio < edgeThreshold) return "before";
  if (clampedRatio > 1 - edgeThreshold) return "after";
  if (options.allowAsChild) return "asChild";
  return clampedRatio < 0.5 ? "before" : "after";
}

