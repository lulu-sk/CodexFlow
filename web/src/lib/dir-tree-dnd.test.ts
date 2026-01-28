import { describe, it, expect } from "vitest";
import { resolveDirRowDropPosition } from "./dir-tree-dnd";

describe("dir-tree-dnd（目录树拖拽落点计算）", () => {
  it("上下边缘优先判定为 before/after（用于提升为根级与根级排序）", () => {
    expect(resolveDirRowDropPosition(0.0, { allowAsChild: true })).toBe("before");
    expect(resolveDirRowDropPosition(0.24, { allowAsChild: true })).toBe("before");
    expect(resolveDirRowDropPosition(0.76, { allowAsChild: true })).toBe("after");
    expect(resolveDirRowDropPosition(1.0, { allowAsChild: true })).toBe("after");
  });

  it("中间区域：允许 asChild 时返回 asChild", () => {
    expect(resolveDirRowDropPosition(0.5, { allowAsChild: true })).toBe("asChild");
    expect(resolveDirRowDropPosition(0.3, { allowAsChild: true })).toBe("asChild");
    expect(resolveDirRowDropPosition(0.7, { allowAsChild: true })).toBe("asChild");
  });

  it("中间区域：不允许 asChild 时按上下半区回退为 before/after", () => {
    expect(resolveDirRowDropPosition(0.3, { allowAsChild: false })).toBe("before");
    expect(resolveDirRowDropPosition(0.7, { allowAsChild: false })).toBe("after");
  });

  it("edgeThreshold 支持自定义并会被夹紧到 0~0.49", () => {
    expect(resolveDirRowDropPosition(0.19, { allowAsChild: true, edgeThreshold: 0.2 })).toBe("before");
    expect(resolveDirRowDropPosition(0.2, { allowAsChild: true, edgeThreshold: 0.2 })).toBe("asChild");
    expect(resolveDirRowDropPosition(0.81, { allowAsChild: true, edgeThreshold: 0.2 })).toBe("after");
    expect(resolveDirRowDropPosition(0.5, { allowAsChild: false, edgeThreshold: 1 })).toBe("after");
  });
});

