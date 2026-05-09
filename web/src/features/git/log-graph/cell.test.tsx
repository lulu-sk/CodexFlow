// @vitest-environment jsdom

import React, { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { GitLogGraphCell } from "./cell";
import type { GitGraphCell } from "./model";
import {
  resolveLogGraphCellWidth,
  resolveLogGraphHalfEdgeBoundaryY,
  resolveLogGraphHeadOuterCircleRadius,
  resolveLogGraphHeadSelectedOuterCircleRadius,
  resolveLogGraphLaneCenter,
  resolveLogGraphRowCenter,
  resolveLogGraphSelectedCircleRadius,
  resolveLogGraphTerminalGap,
} from "./metrics";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const TEST_ROW_HEIGHT = 32;
const TEST_CENTER_Y = 16;
const TEST_BOUNDARY_Y_UP = -1;
const TEST_BOUNDARY_Y_DOWN = 33;
const TEST_LANE_0_X = 11;
const TEST_LANE_1_X = 34;
const TEST_LANE_2_X = 57;
const TEST_RADIUS = 5;
const TEST_SELECTED_RADIUS = 6;
const TEST_TERMINAL_GAP = 3.5;
const TEST_HEAD_RADIUS = 8;
const TEST_SELECTED_HEAD_RADIUS = 9;
const TEST_DOWN_TERMINAL_ARROW = "M 34 28.5 L 39.258 20.468 M 34 28.5 L 28.742 20.468";

/**
 * 创建并挂载一个 React Root，供图谱单元在 jsdom 中渲染。
 */
function createMountedRoot(): { host: HTMLDivElement; root: Root; unmount: () => void } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  return {
    host,
    root,
    unmount: () => {
      try {
        act(() => {
          root.unmount();
        });
      } catch {}
      try {
        host.remove();
      } catch {}
    },
  };
}

/**
 * 渲染单个图谱单元，便于检查 SVG 线条和节点结构。
 */
async function renderGraphCell(cell: GitGraphCell, selected = false): Promise<{ unmount: () => void }> {
  const mounted = createMountedRoot();
  await act(async () => {
    mounted.root.render(
      <GitLogGraphCell
        cell={cell}
        selected={selected}
        rowHeight={TEST_ROW_HEIGHT}
      />,
    );
  });
  return {
    unmount: mounted.unmount,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("GitLogGraphCell", () => {
  it("32px 行高下的基础几何应与日志列表行心对齐", () => {
    expect(resolveLogGraphRowCenter(TEST_ROW_HEIGHT)).toBe(TEST_CENTER_Y);
    expect(resolveLogGraphHalfEdgeBoundaryY(TEST_ROW_HEIGHT, "up")).toBe(TEST_BOUNDARY_Y_UP);
    expect(resolveLogGraphHalfEdgeBoundaryY(TEST_ROW_HEIGHT, "down")).toBe(TEST_BOUNDARY_Y_DOWN);
    expect(resolveLogGraphLaneCenter(0, TEST_ROW_HEIGHT)).toBe(TEST_LANE_0_X);
    expect(resolveLogGraphLaneCenter(1, TEST_ROW_HEIGHT)).toBe(TEST_LANE_1_X);
    expect(resolveLogGraphLaneCenter(2, TEST_ROW_HEIGHT)).toBe(TEST_LANE_2_X);
    expect(resolveLogGraphSelectedCircleRadius(TEST_ROW_HEIGHT)).toBe(TEST_SELECTED_RADIUS);
    expect(resolveLogGraphTerminalGap(TEST_ROW_HEIGHT)).toBe(TEST_TERMINAL_GAP);
    expect(resolveLogGraphHeadOuterCircleRadius(TEST_ROW_HEIGHT)).toBe(TEST_HEAD_RADIUS);
    expect(resolveLogGraphHeadSelectedOuterCircleRadius(TEST_ROW_HEIGHT)).toBe(TEST_SELECTED_HEAD_RADIUS);
  });

  it("32px 行高下的圆点中心应落在 CSS flex 居中的真实中线", async () => {
    const rendered = await renderGraphCell({
      lane: 0,
      color: "#7051b5",
      tracks: [],
      edges: [],
      incomingFromLane: null,
      nodeKind: "default",
      maxLane: 0,
    });
    try {
      const circle = document.querySelector("circle");
      expect(circle).not.toBeNull();
      expect(Number(circle?.getAttribute("cy") || "0")).toBe(TEST_ROW_HEIGHT / 2);
    } finally {
      rendered.unmount();
    }
  });

  it("斜向父边应在当前行下半段先折到边界中点，避免依赖跨行 overflow", async () => {
    const rendered = await renderGraphCell({
      lane: 0,
      color: "#3574F0",
      tracks: [],
      edges: [{ from: 0, to: 1, color: "#3574F0", style: "solid" }],
      incomingFromLane: null,
      nodeKind: "default",
      maxLane: 1,
    });
    try {
      const diagonalLine = Array.from(document.querySelectorAll("line")).find((line) => line.getAttribute("x1") !== line.getAttribute("x2"));
      expect(diagonalLine).not.toBeUndefined();
      expect(Number(diagonalLine?.getAttribute("x1") || "0")).toBeCloseTo(TEST_LANE_0_X, 4);
      expect(Number(diagonalLine?.getAttribute("x2") || "0")).toBeCloseTo(TEST_LANE_1_X, 4);
      expect(Number(diagonalLine?.getAttribute("y1") || "0")).toBeCloseTo(TEST_CENTER_Y, 4);
      expect(Number(diagonalLine?.getAttribute("y2") || "0")).toBeCloseTo(TEST_CENTER_Y + TEST_ROW_HEIGHT, 4);
      expect(diagonalLine?.getAttribute("clip-path")).toContain("cf-log-graph-clip-");
    } finally {
      rendered.unmount();
    }
  });

  it("当前节点若由上一行斜向接入，应从边界中点接到当前行中心", async () => {
    const rendered = await renderGraphCell({
      lane: 1,
      color: "#7051b5",
      tracks: [],
      edges: [],
      incomingFromLane: 0,
      nodeKind: "default",
      maxLane: 1,
    });
    try {
      const incomingLine = Array.from(document.querySelectorAll("line")).find((line) => {
        const y2 = Number(line.getAttribute("y2") || "0");
        return Math.abs(y2 - TEST_CENTER_Y) < 0.001
          && line.getAttribute("x1") !== line.getAttribute("x2");
      });
      expect(incomingLine).not.toBeUndefined();
      expect(incomingLine?.getAttribute("x1")).not.toBe(incomingLine?.getAttribute("x2"));
      expect(Number(incomingLine?.getAttribute("x1") || "0")).toBeCloseTo(TEST_LANE_0_X, 4);
      expect(Number(incomingLine?.getAttribute("x2") || "0")).toBeCloseTo(TEST_LANE_1_X, 4);
      expect(Number(incomingLine?.getAttribute("y1") || "0")).toBeCloseTo(TEST_CENTER_Y - TEST_ROW_HEIGHT, 4);
      expect(incomingLine?.getAttribute("clip-path")).toContain("cf-log-graph-clip-");
    } finally {
      rendered.unmount();
    }
  });

  it("共享祖先节点应同时保留同 lane 竖向入射与侧向入射", async () => {
    const rendered = await renderGraphCell({
      lane: 0,
      color: "#3574F0",
      tracks: [],
      edges: [],
      incomingFromLane: 1,
      incomingFromLanes: [0, 1],
      nodeKind: "default",
      maxLane: 1,
    });
    try {
      const incomingLines = Array.from(document.querySelectorAll("line")).filter((line) => {
        const y2 = Number(line.getAttribute("y2") || "0");
        return Math.abs(y2 - TEST_CENTER_Y) < 0.001;
      });
      expect(incomingLines.length).toBe(2);
      expect(incomingLines.some((line) => line.getAttribute("x1") === line.getAttribute("x2"))).toBe(true);
      expect(incomingLines.some((line) => line.getAttribute("x1") !== line.getAttribute("x2"))).toBe(true);
    } finally {
      rendered.unmount();
    }
  });

  it("背景 track 若由斜线接入，应先从边界中点接入再向下延伸", async () => {
    const rendered = await renderGraphCell({
      lane: 0,
      color: "#3574F0",
      tracks: [{ lane: 1, incomingFromLane: 0, color: "#4b9b5f", style: "solid" }],
      edges: [],
      incomingFromLane: null,
      nodeKind: "default",
      maxLane: 1,
    });
    try {
      const lines = Array.from(document.querySelectorAll("line"));
      expect(lines.some((line) => {
        const y2 = Number(line.getAttribute("y2") || "0");
        return Math.abs(y2 - TEST_CENTER_Y) < 0.001
          && line.getAttribute("x1") !== line.getAttribute("x2");
      })).toBe(true);
      expect(lines.some((line) => {
        const x1 = Number(line.getAttribute("x1") || "0");
        const x2 = Number(line.getAttribute("x2") || "0");
        const y1 = Number(line.getAttribute("y1") || "0");
        const y2 = Number(line.getAttribute("y2") || "0");
        return Math.abs(x1 - TEST_LANE_1_X) < 0.001
          && Math.abs(x2 - TEST_LANE_1_X) < 0.001
          && Math.abs(y1 - TEST_CENTER_Y) < 0.001
          && Math.abs(y2 - TEST_BOUNDARY_Y_DOWN) < 0.001;
      })).toBe(true);
    } finally {
      rendered.unmount();
    }
  });

  it("背景 track 若下一行继续换列，应在本行下半段先折到边界中点", async () => {
    const rendered = await renderGraphCell({
      lane: 0,
      color: "#3574F0",
      tracks: [{
        lane: 1,
        incomingFromLane: 1,
        incomingFromLanes: [1],
        outgoingToLane: 2,
        color: "#73a63b",
        style: "solid",
      }],
      edges: [],
      incomingFromLane: null,
      nodeKind: "default",
      maxLane: 2,
    });
    try {
      const diagonalLine = Array.from(document.querySelectorAll("line")).find((line) => {
        const x1 = Number(line.getAttribute("x1") || "0");
        const x2 = Number(line.getAttribute("x2") || "0");
        const y1 = Number(line.getAttribute("y1") || "0");
        return x1 !== x2
          && Math.abs(y1 - TEST_CENTER_Y) < 0.001;
      });
      expect(diagonalLine).not.toBeUndefined();
      expect(Number(diagonalLine?.getAttribute("x1") || "0")).toBeCloseTo(TEST_LANE_1_X, 4);
      expect(Number(diagonalLine?.getAttribute("x2") || "0")).toBeCloseTo(TEST_LANE_2_X, 4);
      expect(Number(diagonalLine?.getAttribute("y2") || "0")).toBeCloseTo(TEST_CENTER_Y + TEST_ROW_HEIGHT, 4);
      expect(diagonalLine?.getAttribute("clip-path")).toContain("cf-log-graph-clip-");
    } finally {
      rendered.unmount();
    }
  });

  it("terminal edge 应使用更长的虚线节距，并保留清晰箭头", async () => {
    const rendered = await renderGraphCell({
      lane: 0,
      color: "#369650",
      tracks: [],
      edges: [{ from: 0, to: 0, color: "#369650", style: "dashed", terminal: true, arrow: true }],
      incomingFromLane: null,
      nodeKind: "default",
      maxLane: 0,
    });
    try {
      const dashedLine = document.querySelector("line[stroke-dasharray]") as SVGLineElement | null;
      const dashArray = String(dashedLine?.getAttribute("stroke-dasharray") || "");
      const dashLength = Number(dashArray.split(" ")[0] || "0");
      expect(dashLength).toBeCloseTo(18, 2);
      expect(document.querySelectorAll("path")).toHaveLength(1);
    } finally {
      rendered.unmount();
    }
  });

  it("背景 track 的向下 terminal arrow 应贴近行底边绘制", async () => {
    const rendered = await renderGraphCell({
      lane: 0,
      color: "#3574F0",
      tracks: [{
        lane: 1,
        incomingFromLane: 1,
        incomingFromLanes: [1],
        color: "#73a63b",
        style: "solid",
        outgoingTerminal: true,
        outgoingArrow: true,
      }],
      edges: [],
      incomingFromLane: null,
      nodeKind: "default",
      maxLane: 1,
    });
    try {
      const arrowPath = document.querySelector("path");
      expect(arrowPath).not.toBeNull();
      expect(arrowPath?.getAttribute("d")).toBe(TEST_DOWN_TERMINAL_ARROW);
      const verticalLine = Array.from(document.querySelectorAll("line")).find((line) => {
        const x1 = Number(line.getAttribute("x1") || "0");
        const x2 = Number(line.getAttribute("x2") || "0");
        const y2 = Number(line.getAttribute("y2") || "0");
        return Math.abs(x1 - TEST_LANE_1_X) < 0.001
          && Math.abs(x2 - TEST_LANE_1_X) < 0.001
          && Math.abs(y2 - (TEST_ROW_HEIGHT - TEST_TERMINAL_GAP)) < 0.001;
      });
      expect(verticalLine).not.toBeUndefined();
    } finally {
      rendered.unmount();
    }
  });

  it("背景 track 的向上 terminal arrow 应贴近行顶边绘制", async () => {
    const rendered = await renderGraphCell({
      lane: 0,
      color: "#3574F0",
      tracks: [{
        lane: 1,
        incomingFromLane: 1,
        incomingFromLanes: [1],
        color: "#73a63b",
        style: "solid",
        incomingTerminal: true,
        incomingArrow: true,
      }],
      edges: [],
      incomingFromLane: null,
      nodeKind: "default",
      maxLane: 1,
    });
    try {
      const arrowPath = document.querySelector("path");
      expect(arrowPath).not.toBeNull();
      const verticalLine = Array.from(document.querySelectorAll("line")).find((line) => {
        const x1 = Number(line.getAttribute("x1") || "0");
        const x2 = Number(line.getAttribute("x2") || "0");
        const y1 = Number(line.getAttribute("y1") || "0");
        return Math.abs(x1 - TEST_LANE_1_X) < 0.001
          && Math.abs(x2 - TEST_LANE_1_X) < 0.001
          && Math.abs(y1 - TEST_TERMINAL_GAP) < 0.001;
      });
      expect(verticalLine).not.toBeUndefined();
    } finally {
      rendered.unmount();
    }
  });

  it("图谱宽度应只取当前行可见 lane，不能被遗留的全局最大 lane 撑宽", async () => {
    const rendered = await renderGraphCell({
      lane: 0,
      color: "#3574F0",
      tracks: [],
      edges: [],
      incomingFromLane: null,
      nodeKind: "default",
      maxLane: 4,
    });
    try {
      const svg = document.querySelector("svg");
      expect(Number(svg?.getAttribute("width") || "0")).toBeCloseTo(resolveLogGraphCellWidth({
        lane: 0,
        color: "#3574F0",
        tracks: [],
        edges: [],
        incomingFromLane: null,
        nodeKind: "default",
        maxLane: 4,
      }, TEST_ROW_HEIGHT), 4);
    } finally {
      rendered.unmount();
    }
  });

  it("普通节点默认应无 outline，选中 HEAD 节点应退化为 IDEA 的单个放大实心圆", async () => {
    const rendered = await renderGraphCell({
      lane: 0,
      color: "#b28b33",
      tracks: [],
      edges: [],
      incomingFromLane: null,
      nodeKind: "head",
      maxLane: 0,
    }, true);
    try {
      expect(document.querySelectorAll("circle")).toHaveLength(1);
      const circle = document.querySelector("circle");
      expect(circle?.getAttribute("stroke")).toBe("none");
      expect(Number(circle?.getAttribute("r") || "0")).toBe(TEST_SELECTED_HEAD_RADIUS);
    } finally {
      rendered.unmount();
    }
  });

  it("节点入射半段应优先使用逐条来源列与颜色，不能统一退化成节点自身颜色", async () => {
    const rendered = await renderGraphCell({
      lane: 1,
      color: "#7051b5",
      tracks: [],
      edges: [],
      incomingFromLane: null,
      incomingFromLanes: [],
      incomingEdges: [
        { fromLane: 0, color: "#4b9b5f", style: "solid", sourceHash: "left-parent" },
        { fromLane: 2, color: "#3574F0", style: "solid", sourceHash: "right-parent" },
      ],
      nodeKind: "default",
      maxLane: 2,
    });
    try {
      const incomingLines = Array.from(document.querySelectorAll("line")).filter((line) => {
        const y2 = Number(line.getAttribute("y2") || "0");
        return Math.abs(y2 - TEST_CENTER_Y) < 0.001;
      });
      expect(incomingLines.some((line) => line.getAttribute("stroke") === "#4b9b5f")).toBe(true);
      expect(incomingLines.some((line) => line.getAttribute("stroke") === "#3574F0")).toBe(true);
      expect(incomingLines.some((line) => {
        const x1 = Number(line.getAttribute("x1") || "0");
        const x2 = Number(line.getAttribute("x2") || "0");
        return Math.abs(x1 - TEST_LANE_0_X) < 0.001
          && Math.abs(x2 - TEST_LANE_1_X) < 0.001;
      })).toBe(true);
      expect(incomingLines.some((line) => {
        const x1 = Number(line.getAttribute("x1") || "0");
        const x2 = Number(line.getAttribute("x2") || "0");
        return Math.abs(x1 - TEST_LANE_2_X) < 0.001
          && Math.abs(x2 - TEST_LANE_1_X) < 0.001;
      })).toBe(true);
    } finally {
      rendered.unmount();
    }
  });

  it("多行同时渲染时，同形斜线也必须使用逐行唯一的 clipPath id", async () => {
    const mounted = createMountedRoot();
    await act(async () => {
      mounted.root.render(
        <div>
          <GitLogGraphCell
            cell={{
              lane: 1,
              color: "#4b9b5f",
              tracks: [],
              edges: [{ from: 1, to: 0, color: "#4b9b5f", style: "solid", sourceHash: "left-a", targetHash: "target-a" }],
              incomingFromLane: null,
              nodeKind: "default",
              maxLane: 1,
              commitHash: "row-a",
            }}
            selected={false}
            rowHeight={TEST_ROW_HEIGHT}
          />
          <GitLogGraphCell
            cell={{
              lane: 1,
              color: "#b28b33",
              tracks: [],
              edges: [{ from: 1, to: 0, color: "#b28b33", style: "solid", sourceHash: "left-b", targetHash: "target-b" }],
              incomingFromLane: null,
              nodeKind: "default",
              maxLane: 1,
              commitHash: "row-b",
            }}
            selected={false}
            rowHeight={TEST_ROW_HEIGHT}
          />
        </div>,
      );
    });
    try {
      const clipPaths = Array.from(document.querySelectorAll("clipPath"));
      const clipPathIds = clipPaths.map((element) => String(element.getAttribute("id") || ""));
      expect(clipPathIds).toHaveLength(2);
      expect(new Set(clipPathIds).size).toBe(2);

      const clippedLines = Array.from(document.querySelectorAll("line[clip-path]"));
      expect(clippedLines).toHaveLength(2);
      expect(new Set(clippedLines.map((line) => String(line.getAttribute("clip-path") || ""))).size).toBe(2);
    } finally {
      mounted.unmount();
    }
  });

  it("窄 SVG 行中的半段斜线不应被当前行宽度在水平方向裁掉", async () => {
    const rendered = await renderGraphCell({
      lane: 1,
      color: "#63a663",
      tracks: [{
        lane: 0,
        incomingFromLane: 2,
        incomingFromLanes: [2],
        outgoingToLane: 1,
        color: "#a68563",
        style: "solid",
        hash: "brown-target",
        sourceHash: "brown-source",
        sourceRow: 176,
      }],
      edges: [{
        from: 1,
        to: 0,
        color: "#63a663",
        style: "solid",
        sourceHash: "green-source",
        targetHash: "green-target",
      }],
      incomingFromLane: 1,
      incomingFromLanes: [1],
      nodeKind: "default",
      maxLane: 1,
      commitHash: "narrow-clip-row",
    });
    try {
      const incomingLine = Array.from(document.querySelectorAll("line")).find((line) => {
        const x1 = Number(line.getAttribute("x1") || "0");
        const x2 = Number(line.getAttribute("x2") || "0");
        const y2 = Number(line.getAttribute("y2") || "0");
        return Math.abs(x1 - TEST_LANE_2_X) < 0.001
          && Math.abs(x2 - TEST_LANE_0_X) < 0.001
          && Math.abs(y2 - TEST_CENTER_Y) < 0.001;
      });
      expect(incomingLine).not.toBeUndefined();

      const clipPathRef = String(incomingLine?.getAttribute("clip-path") || "");
      expect(clipPathRef).toContain("cf-log-graph-clip-");

      const clipPathId = clipPathRef.replace(/^url\(#/, "").replace(/\)$/, "");
      const clipPath = document.getElementById(clipPathId);
      expect(clipPath).not.toBeNull();
      expect(clipPath?.getAttribute("clipPathUnits")).toBe("userSpaceOnUse");

      const clipRect = clipPath?.querySelector("rect");
      expect(clipRect).not.toBeNull();
      expect(Number(clipRect?.getAttribute("x") || "0")).toBeLessThan(-1000);
      expect(Number(clipRect?.getAttribute("width") || "0")).toBeGreaterThan(1000);
    } finally {
      rendered.unmount();
    }
  });

  it("普通节点未选中时应只渲染单个实心圆，不再额外绘制 outline stroke", async () => {
    const rendered = await renderGraphCell({
      lane: 0,
      color: "#7051b5",
      tracks: [],
      edges: [],
      incomingFromLane: null,
      nodeKind: "default",
      maxLane: 0,
    });
    try {
      const circle = document.querySelector("circle");
      expect(circle).not.toBeNull();
      expect(document.querySelectorAll("circle")).toHaveLength(1);
      expect(circle?.getAttribute("stroke")).toBe("none");
      expect(Number(circle?.getAttribute("cx") || "0")).toBe(TEST_LANE_0_X);
      expect(Number(circle?.getAttribute("cy") || "0")).toBe(TEST_CENTER_Y);
      expect(Number(circle?.getAttribute("r") || "0")).toBe(TEST_RADIUS);
    } finally {
      rendered.unmount();
    }
  });
});
