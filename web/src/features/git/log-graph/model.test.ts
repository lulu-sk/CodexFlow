import { describe, expect, it } from "vitest";
import { buildFileHistoryGraphCells, buildLogGraphCells, resolveLogGraphColor } from "./model";
import type { GitLogItem } from "../types";

/**
 * 构造最小日志夹具，避免测试里重复填写无关字段。
 */
function createLogItem(input: Partial<GitLogItem> & Pick<GitLogItem, "hash" | "parents">): GitLogItem {
  return {
    hash: input.hash,
    shortHash: input.hash.slice(0, 8),
    parents: input.parents,
    authorName: "CodexFlow",
    authorEmail: "codexflow@example.com",
    authorDate: "2026-03-17T00:00:00.000Z",
    subject: input.subject || input.hash,
    decorations: input.decorations || "",
    containedInCurrentBranch: input.containedInCurrentBranch,
  };
}

const WT7_TOP_VISIBLE_ITEMS: GitLogItem[] = [
  createLogItem({ hash: "a000069000000000000000000000000000000000", parents: ["a00006c000000000000000000000000000000000"], decorations: "worktree/demo/wt2" }),
  createLogItem({ hash: "a00005a000000000000000000000000000000000", parents: ["a000072000000000000000000000000000000000"], decorations: "worktree/wt1" }),
  createLogItem({ hash: "a000044000000000000000000000000000000000", parents: ["a00007b000000000000000000000000000000000"], decorations: "origin/master, origin/HEAD, master" }),
  createLogItem({ hash: "a000050000000000000000000000000000000000", parents: ["a00007b000000000000000000000000000000000"], decorations: "origin/feature/side-d" }),
  createLogItem({ hash: "a000072000000000000000000000000000000000", parents: ["a00001e000000000000000000000000000000000"] }),
  createLogItem({ hash: "a00001e000000000000000000000000000000000", parents: ["a00005c000000000000000000000000000000000"] }),
  createLogItem({ hash: "a00006c000000000000000000000000000000000", parents: ["a0000a7000000000000000000000000000000000"] }),
  createLogItem({ hash: "a00005c000000000000000000000000000000000", parents: ["a00001f000000000000000000000000000000000"] }),
  createLogItem({ hash: "a00001f000000000000000000000000000000000", parents: ["a00007a000000000000000000000000000000000"] }),
  createLogItem({ hash: "a00007a000000000000000000000000000000000", parents: ["a00002f000000000000000000000000000000000"] }),
  createLogItem({ hash: "a00002f000000000000000000000000000000000", parents: ["a000011000000000000000000000000000000000"] }),
  createLogItem({ hash: "a000011000000000000000000000000000000000", parents: ["a00001d000000000000000000000000000000000"] }),
  createLogItem({ hash: "a00001d000000000000000000000000000000000", parents: ["a00000c000000000000000000000000000000000"] }),
  createLogItem({ hash: "a0000a7000000000000000000000000000000000", parents: ["a0000a5000000000000000000000000000000000"] }),
  createLogItem({ hash: "a00007b000000000000000000000000000000000", parents: ["a00001b000000000000000000000000000000000"] }),
  createLogItem({ hash: "a0000a5000000000000000000000000000000000", parents: ["a000061000000000000000000000000000000000"] }),
  createLogItem({ hash: "a000061000000000000000000000000000000000", parents: ["a00005e000000000000000000000000000000000"] }),
  createLogItem({ hash: "a00005e000000000000000000000000000000000", parents: ["a000013000000000000000000000000000000000"] }),
  createLogItem({ hash: "a00000c000000000000000000000000000000000", parents: ["a000094000000000000000000000000000000000"] }),
  createLogItem({ hash: "a000013000000000000000000000000000000000", parents: ["a000084000000000000000000000000000000000"] }),
];

describe("git log graph model", () => {
  it("颜色应由稳定种子决定，而不是 lane 下标", () => {
    expect(resolveLogGraphColor("local:master")).toBe(resolveLogGraphColor("local:master"));
    expect(resolveLogGraphColor("local:master")).not.toBe(resolveLogGraphColor("local:feature/topic"));
  });

  it("主分支颜色应沿 first-parent 继承，避免同一 head fragment 在不同 lane 漂移", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "m1", parents: ["m0"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "m0", parents: [] }),
    ]);

    expect(cells[0]?.nodeKind).toBe("head");
    expect(cells[1]?.color).toBe(cells[0]?.color);
  });

  it("共享主干中途遇到带 ref 的非 head 提交时，不应改写已继承的 fragment 颜色", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "wt-head", parents: ["mid"], decorations: "HEAD -> worktree/demo/wt1" }),
      createLogItem({ hash: "mid", parents: ["main-ref"] }),
      createLogItem({ hash: "main-ref", parents: ["base"], decorations: "origin/master, master" }),
      createLogItem({ hash: "base", parents: [] }),
    ]);

    expect(cells[0]?.lane).toBe(0);
    expect(cells[1]?.lane).toBe(0);
    expect(cells[2]?.lane).toBe(0);
    expect(cells[3]?.lane).toBe(0);
    expect(cells[1]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 0, to: 0, color: cells[0]?.color }),
    ]));
    expect(cells[0]?.color).toBe(cells[1]?.color);
    expect(cells[1]?.color).toBe(cells[2]?.color);
    expect(cells[2]?.color).toBe(cells[3]?.color);
  });

  it("共享祖先以下应复用更重要分支的颜色，而不是沿用先进入的侧支颜色", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "side-head", parents: ["side-base"], decorations: "worktree/demo/wt2" }),
      createLogItem({ hash: "main-head", parents: ["main-base"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "side-base", parents: ["shared"] }),
      createLogItem({ hash: "main-base", parents: ["shared"] }),
      createLogItem({ hash: "shared", parents: ["root"] }),
      createLogItem({ hash: "root", parents: [] }),
    ]);

    expect(cells[0]?.color).not.toBe(cells[1]?.color);
    expect(cells[2]?.color).toBe(cells[0]?.color);
    expect(cells[3]?.color).toBe(cells[1]?.color);
    expect(cells[4]?.incomingFromLanes).toEqual(expect.arrayContaining([0, 1]));
    expect(cells[4]?.color).toBe(cells[1]?.color);
    expect(cells[5]?.color).toBe(cells[1]?.color);
  });

  it("同一最佳 ref 仅因 decoration 写法不同，不应取到不同颜色", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "head-syntax", parents: ["base"], decorations: "HEAD -> feature/demo" }),
      createLogItem({ hash: "plain-syntax", parents: ["base"], decorations: "feature/demo" }),
      createLogItem({ hash: "base", parents: [] }),
    ]);

    expect(cells[0]?.color).toBe(cells[1]?.color);
  });

  it("主干远端应复用本地主干颜色，避免与旁侧 origin 支线撞成同色", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "remote-main", parents: ["base"], decorations: "origin/master, origin/HEAD" }),
      createLogItem({ hash: "local-main", parents: ["base"], decorations: "master" }),
      createLogItem({ hash: "side-remote", parents: ["base"], decorations: "origin/release/patch-pack" }),
      createLogItem({ hash: "base", parents: [] }),
    ]);

    expect(cells[0]?.color).toBe(cells[1]?.color);
    expect(cells[0]?.color).not.toBe(cells[2]?.color);
  });

  it("merge / split / terminal 场景应输出分支轨道、斜边与终止边", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "merge", parents: ["main", "feature"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "feature", parents: ["base"], decorations: "feature/topic" }),
      createLogItem({ hash: "main", parents: ["base"] }),
      createLogItem({ hash: "base", parents: [] }),
    ]);

    expect(cells[0]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 0, to: 0, style: "solid" }),
      expect.objectContaining({ from: 0, to: 1, style: "solid" }),
    ]));
    expect(cells[1]?.incomingFromLane).toBe(0);
    expect(cells[1]?.lane).toBe(1);
    expect(cells[1]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: 0, incomingFromLane: 0 }),
    ]));
    expect(cells[1]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 1, to: 1, style: "solid" }),
    ]));
    expect(cells[2]?.lane).toBe(0);
    expect(cells[2]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: 1, incomingFromLane: 1 }),
    ]));
    expect(cells[3]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ terminal: true, style: "dashed", arrow: true }),
    ]));
  });

  it("共享祖先应保持首个可见 head 决定的稳定 lane，后续分支不能改写它的路线", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "head-a", parents: ["mid-a"], decorations: "origin/main" }),
      createLogItem({ hash: "head-b", parents: ["mid-b"], decorations: "HEAD -> feature/demo" }),
      createLogItem({ hash: "mid-a", parents: ["shared-root"] }),
      createLogItem({ hash: "mid-b", parents: ["shared-root"] }),
      createLogItem({ hash: "shared-root", parents: [] }),
    ]);

    expect(cells.map((cell) => cell.lane)).toEqual([0, 1, 0, 1, 0]);
    expect(cells[3]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 1, to: 0, style: "solid" }),
    ]));
    expect(cells[4]?.incomingFromLanes).toEqual(expect.arrayContaining([0, 1]));
  });

  it("head 排序应优先对齐 origin/master 这类主干远端，而不是简单按可见行顺序分配 lane", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "remote-feature", parents: ["shared"], decorations: "origin/release/test-pack" }),
      createLogItem({ hash: "remote-main", parents: ["shared"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "shared", parents: [] }),
    ]);

    expect(cells[0]?.lane).toBe(0);
    expect(cells[0]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 0, to: 1, style: "solid" }),
    ]));
    expect(cells[1]?.lane).toBe(0);
    expect(cells[1]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: 1, incomingFromLane: 0 }),
    ]));
  });

  it("回并到左侧主干时，中间可见行应保持右侧竖线，到目标提交行再斜向接入", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "feature-head", parents: ["main-base"], decorations: "feature/demo" }),
      createLogItem({ hash: "main-mid", parents: ["main-base"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "main-base", parents: [] }),
    ]);

    expect(cells[0]?.lane).toBe(0);
    expect(cells[1]?.lane).toBe(0);
    expect(cells[0]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 0, to: 1, style: "solid" }),
    ]));
    expect(cells[1]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: "main-base",
        lane: 1,
        incomingFromLane: 0,
        incomingFromLanes: [0],
      }),
    ]));
    expect(cells[1]?.incomingFromLanes).toEqual([]);
    expect(cells[2]?.incomingFromLanes).toEqual(expect.arrayContaining([0, 1]));
  });

  it("脱敏拓扑复现：a0000550 所在主干线应与旁侧 release 补丁支线区分颜色", () => {
    const items = [
      createLogItem({ hash: "a000036000000000000000000000000000000000", parents: ["a00000d000000000000000000000000000000000"], decorations: "origin/release/patch-pack" }),
      createLogItem({ hash: "a00000d000000000000000000000000000000000", parents: ["a00006a000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000093000000000000000000000000000000000", parents: ["a00003b000000000000000000000000000000000"], decorations: "origin/master, origin/HEAD" }),
      createLogItem({ hash: "a00003b000000000000000000000000000000000", parents: ["a000055000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000055000000000000000000000000000000000", parents: ["a000070000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000070000000000000000000000000000000000", parents: ["a0000a0000000000000000000000000000000000"] }),
      createLogItem({ hash: "a0000a0000000000000000000000000000000000", parents: ["a000009000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000009000000000000000000000000000000000", parents: ["a00003f000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00003f000000000000000000000000000000000", parents: ["a000054000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000054000000000000000000000000000000000", parents: ["a000030000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000030000000000000000000000000000000000", parents: ["a0000a2000000000000000000000000000000000"] }),
      createLogItem({ hash: "a0000a2000000000000000000000000000000000", parents: ["a000047000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000047000000000000000000000000000000000", parents: ["a000007000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00006a000000000000000000000000000000000", parents: ["a000006000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000007000000000000000000000000000000000", parents: [] }),
      createLogItem({ hash: "a000006000000000000000000000000000000000", parents: [] }),
    ];

    const cells = buildLogGraphCells(items);
    const trackAtDf30 = cells[2]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a00006a0")
      && String(track.sourceHash || "").startsWith("a00000d0"),
    );

    expect(trackAtDf30).toBeDefined();
    expect(cells[4]?.color).toBe(cells[2]?.color);
    expect(cells[2]?.color).toBe(resolveLogGraphColor("master"));
    expect(trackAtDf30?.color).toBe(resolveLogGraphColor("origin/release/patch-pack"));
    expect(cells[4]?.color).not.toBe(trackAtDf30?.color);
  });

  it("长边应像 IDEA 一样只保留两端可见段，并在截断点绘制箭头", () => {
    const items: GitLogItem[] = [
      createLogItem({ hash: "feature-head", parents: ["feature-base"], decorations: "feature/demo" }),
      createLogItem({ hash: "main-0", parents: ["main-1"], decorations: "HEAD -> master, origin/master" }),
    ];
    for (let index = 1; index < 31; index += 1) {
      items.push(createLogItem({
        hash: `main-${index}`,
        parents: [index === 30 ? "root" : `main-${index + 1}`],
      }));
    }
    items.push(createLogItem({ hash: "feature-base", parents: ["root"] }));
    items.push(createLogItem({ hash: "root", parents: [] }));

    const cells = buildLogGraphCells(items);

    expect(cells[0]?.lane).toBe(0);
    expect(cells[0]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 0, to: 1, style: "solid" }),
    ]));
    expect(cells[1]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: "feature-base",
        lane: 1,
        outgoingTerminal: true,
        outgoingArrow: true,
      }),
    ]));
    expect(cells[10]?.tracks.some((track) => track.hash === "feature-base")).toBe(false);
    expect(cells[10]?.maxLane).toBe(0);
    expect(cells[31]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: "feature-base",
        lane: 1,
        incomingTerminal: true,
        incomingArrow: true,
      }),
    ]));
    expect(cells[32]?.lane).toBe(1);
    expect(cells[32]?.incomingFromLanes).toEqual([1]);
  });

  it("文件历史模式应退化为单轨时间线，避免完整仓库拓扑撑宽图谱列", () => {
    const cells = buildFileHistoryGraphCells([
      createLogItem({ hash: "head", parents: ["prev"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "prev", parents: ["root"] }),
      createLogItem({ hash: "root", parents: [] }),
    ]);

    expect(cells).toHaveLength(3);
    expect(cells.every((cell) => cell.lane === 0 && cell.maxLane === 0)).toBe(true);
    expect(cells[0]?.incomingFromLane).toBeNull();
    expect(cells[1]?.incomingFromLane).toBe(0);
    expect(cells[0]?.nodeKind).toBe("head");
    expect(cells[0]?.edges).toEqual([
      expect.objectContaining({ from: 0, to: 0, style: "solid" }),
    ]);
    expect(cells[2]?.edges).toEqual([
      expect.objectContaining({ from: 0, to: 0, style: "dashed", terminal: true, arrow: true }),
    ]);
  });

  it("作者筛选后的稀疏结果不应让不可见父提交长期占住 lane", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "merge-hit", parents: ["main-hidden", "feature-hidden"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "fix-hit", parents: ["fix-hidden"] }),
      createLogItem({ hash: "search-hit", parents: ["search-hidden"] }),
    ]);

    expect(cells[0]?.edges).toHaveLength(2);
    expect(cells[0]?.edges.every((edge) => edge.from === 0 && edge.to === 0 && edge.style === "dashed" && edge.terminal && edge.arrow)).toBe(true);
    expect(cells[1]?.lane).toBe(0);
    expect(cells[1]?.tracks).toEqual([]);
    expect(cells[1]?.incomingFromLane).toBeNull();
    expect(cells[1]?.maxLane).toBe(0);
    expect(cells[2]?.lane).toBe(0);
    expect(cells[2]?.tracks).toEqual([]);
    expect(cells[2]?.incomingFromLane).toBeNull();
    expect(cells[2]?.maxLane).toBe(0);
  });

  it("文本筛选后应继续复用隐藏提交维持的主干连线，而不是把可见提交误判成 terminal edge", () => {
    const visibleItems = [
      createLogItem({ hash: "head-visible", parents: ["mid-hidden"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "base-visible", parents: [] }),
    ];
    const graphItems = [
      visibleItems[0]!,
      createLogItem({ hash: "mid-hidden", parents: ["base-visible"] }),
      visibleItems[1]!,
    ];

    const cells = buildLogGraphCells(visibleItems, graphItems);

    expect(cells).toHaveLength(2);
    expect(cells[0]?.edges).toEqual([
      expect.objectContaining({ from: 0, to: 0, style: "solid" }),
    ]);
    expect(cells[1]?.incomingFromLane).toBe(0);
    expect(cells[1]?.incomingFromLanes).toEqual([0]);
  });

  it("按上一行同 hash 对接时应先映射到局部位置，避免混入原始 lane 生成额外斜线", () => {
    const cells = buildLogGraphCells([
      createLogItem({
        hash: "pkg-head",
        parents: ["pkg-a"],
        decorations: "origin/release/test-pack",
      }),
      createLogItem({
        hash: "wt2-head",
        parents: ["wt2-a"],
        decorations: "worktree/demo/wt2",
      }),
      createLogItem({
        hash: "wt1-head",
        parents: ["wt1-a"],
        decorations: "worktree/demo/wt1",
      }),
      createLogItem({ hash: "pkg-a", parents: ["pkg-b"] }),
      createLogItem({ hash: "pkg-b", parents: ["pkg-c"] }),
      createLogItem({ hash: "pkg-c", parents: ["pkg-d"] }),
      createLogItem({
        hash: "main-head",
        parents: ["main-a"],
        decorations: "HEAD -> master, origin/master",
      }),
      createLogItem({ hash: "wt1-a", parents: ["wt1-b"] }),
      createLogItem({ hash: "main-a", parents: ["main-b"] }),
      createLogItem({
        hash: "pkg-d",
        parents: ["pkg-e"],
        decorations: "release/test-pack",
      }),
      createLogItem({ hash: "pkg-e", parents: ["pkg-terminal"] }),
      createLogItem({ hash: "pkg-terminal", parents: [] }),
      createLogItem({ hash: "main-b", parents: ["main-base"] }),
      createLogItem({ hash: "wt2-a", parents: ["wt2-terminal"] }),
      createLogItem({ hash: "wt1-b", parents: ["wt1-c"] }),
      createLogItem({ hash: "wt1-c", parents: ["main-base"] }),
      createLogItem({ hash: "main-base", parents: [] }),
    ]);

    expect(cells).toHaveLength(17);
    expect(cells[3]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: "wt2-a",
        lane: 2,
        incomingFromLane: 2,
        incomingFromLanes: [2],
      }),
    ]));
    expect(cells[7]?.incomingFromLane).toBe(2);
    expect(cells[7]?.incomingFromLanes).toEqual([2]);
  });

  it("当前行若只剩节点，仍应保留斜边目标 lane 的占位，避免把弯折提前到上一行", () => {
    const graphItems = [
      createLogItem({ hash: "head-side", parents: ["side-base"], decorations: "feature/2" }),
      createLogItem({ hash: "head-middle", parents: ["middle-base"], decorations: "feature/1" }),
      createLogItem({ hash: "head-main", parents: ["main-base"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "side-base", parents: ["root"] }),
      createLogItem({ hash: "middle-base", parents: ["root"] }),
      createLogItem({ hash: "main-base", parents: ["root"] }),
      createLogItem({ hash: "root", parents: [] }),
    ];
    const cells = buildLogGraphCells([
      graphItems[0]!,
      graphItems[2]!,
      graphItems[3]!,
      graphItems[6]!,
    ], graphItems);

    expect(cells[0]?.edges).toEqual([
      expect.objectContaining({ from: 0, to: 2, style: "solid", targetHash: "side-base" }),
    ]);
    expect(cells[1]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ lane: 2, hash: "side-base", incomingFromLane: 0 }),
    ]));
  });

  it("当前行 direct edge 不应额外占位，后续过路线列位应按下一行真实可见图元决定", () => {
    const graphItems = [
      createLogItem({ hash: "head-a", parents: ["base-a"], decorations: "feature/a" }),
      createLogItem({ hash: "head-b", parents: ["base-b"], decorations: "feature/b" }),
      createLogItem({ hash: "head-c", parents: ["base-c"], decorations: "feature/c" }),
      createLogItem({ hash: "head-main", parents: ["base-main"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "base-a", parents: ["root"] }),
      createLogItem({ hash: "base-b", parents: ["root"] }),
      createLogItem({ hash: "base-c", parents: ["root"] }),
      createLogItem({ hash: "base-main", parents: ["root"] }),
      createLogItem({ hash: "root", parents: [] }),
    ];
    const cells = buildLogGraphCells([
      graphItems[5]!,
      graphItems[7]!,
      graphItems[8]!,
    ], graphItems);

    expect(cells[0]?.lane).toBe(1);
    expect(cells[0]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 1, to: 2, targetHash: "root" }),
    ]));
    expect(cells[0]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ hash: "base-c", lane: 2 }),
    ]));
  });

  it("目标节点行不应把上一行已结束的 normal incoming edge 再算作当前行占位，否则会把更右侧过路线整体再右推一列", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "head-extra", parents: ["extra-base"], decorations: "feature/b" }),
      createLogItem({ hash: "head-main", parents: ["shared"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "head-side", parents: ["shared"], decorations: "feature/a" }),
      createLogItem({ hash: "extra-base", parents: ["extra-root"] }),
      createLogItem({ hash: "shared", parents: ["root"] }),
      createLogItem({ hash: "extra-root", parents: ["root"] }),
      createLogItem({ hash: "root", parents: [] }),
    ]);

    expect(cells[4]?.lane).toBe(0);
    expect(cells[4]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ hash: "extra-root", lane: 1 }),
    ]));
    expect(cells[4]?.maxLane).toBe(1);
  });

  it("非 graph head 但带 branch ref 的节点也应参与 layout 起点排序，避免被无引用头提交吞进同一条 lane", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "top-plain", parents: ["feature-base"] }),
      createLogItem({ hash: "main-head", parents: ["merge-base"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "feature-base", parents: ["merge-base"], decorations: "feature/demo" }),
      createLogItem({ hash: "merge-base", parents: ["root"] }),
      createLogItem({ hash: "root", parents: [] }),
    ]);

    expect(cells[0]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetHash: "feature-base", to: 1 }),
    ]));
    expect(cells[1]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ hash: "feature-base", lane: 1 }),
    ]));
    expect(cells[2]?.lane).toBe(1);
  });

  it("非 graph head 的 branch ref 只能作为补充起点，不能把真实 head 的长边整体再右推一列", () => {
    const items = [
      createLogItem({ hash: "remote-head", parents: ["main-head"], decorations: "origin/fix/notifications-external-preview" }),
      createLogItem({ hash: "wt2-head", parents: ["wt2-0"], decorations: "HEAD -> worktree/demo/wt2" }),
      createLogItem({ hash: "wt2-0", parents: ["wt2-1"] }),
      createLogItem({ hash: "wt2-1", parents: ["wt2-2"] }),
      createLogItem({ hash: "wt2-2", parents: ["wt2-3"] }),
      createLogItem({ hash: "side-head", parents: ["main-head"], decorations: "origin/fix/history-slash-prefixed-path-open" }),
    ];
    for (let index = 3; index <= 31; index += 1) {
      items.push(createLogItem({
        hash: `wt2-${index}`,
        parents: [index === 31 ? "main-head" : `wt2-${index + 1}`],
      }));
    }
    items.push(createLogItem({ hash: "main-head", parents: ["base"], decorations: "origin/master, master" }));
    items.push(createLogItem({ hash: "base", parents: [] }));

    const cells = buildLogGraphCells(items);

    expect(cells[1]?.lane).toBe(1);
    expect(cells[1]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: "main-head",
        lane: 0,
        incomingFromLane: 0,
      }),
    ]));
    expect(cells[5]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        hash: "wt2-3",
        lane: 1,
      }),
    ]));
    expect(cells[6]?.incomingFromLanes).toEqual([1]);
    expect(cells[35]?.incomingFromLanes).toEqual([1, 0]);
  });

  it("同级分支名应按自然排序决定 lane 先后，避免 feature/10 被错误排到 feature/2 左侧", () => {
    const cells = buildLogGraphCells([
      createLogItem({ hash: "head-10", parents: ["shared"], decorations: "feature/10" }),
      createLogItem({ hash: "head-2", parents: ["shared"], decorations: "feature/2" }),
      createLogItem({ hash: "shared", parents: [] }),
    ]);

    expect(cells[0]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetHash: "shared", to: 1 }),
    ]));
    expect(cells[1]?.lane).toBe(0);
    expect(cells[1]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetHash: "shared", to: 0 }),
    ]));
  });

  it("多条可见支线共用同一稳定列时，不应在中间可见节点处丢失更远来源或把合流提前到目标行之前", () => {
    const items = [
      createLogItem({ hash: "player-pack-head", parents: ["player-pack-base"], decorations: "origin/release/test-pack" }),
      createLogItem({ hash: "master-head", parents: ["master-23-03"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "wt4-head", parents: ["temp-commit"], decorations: "worktree/demo/wt4" }),
      createLogItem({ hash: "master-23-03", parents: ["master-23-02"], decorations: "worktree/demo/wt3" }),
      createLogItem({ hash: "master-23-02", parents: ["master-22-29"] }),
      createLogItem({ hash: "master-22-29", parents: ["master-22-10"] }),
      createLogItem({ hash: "player-pack-base", parents: ["player-pack-22-20"] }),
      createLogItem({ hash: "player-pack-22-20", parents: ["a000086000"] }),
      createLogItem({ hash: "master-22-10", parents: ["master-22-05"] }),
      createLogItem({ hash: "master-22-05", parents: ["master-20-55"] }),
      createLogItem({ hash: "wt1-head", parents: ["wt1-mid"], decorations: "worktree/demo/wt1" }),
      createLogItem({ hash: "wt1-mid", parents: ["wt1-base"] }),
      createLogItem({ hash: "wt2-head", parents: ["temp-commit"], decorations: "worktree/demo/wt2" }),
      createLogItem({ hash: "a000086000", parents: ["task-a"] }),
      createLogItem({ hash: "master-20-55", parents: ["master-20-41"] }),
      createLogItem({ hash: "master-20-41", parents: ["master-18-22"] }),
      createLogItem({ hash: "wt1-base", parents: ["temp-commit"] }),
      createLogItem({ hash: "task-a", parents: ["task-b"] }),
      createLogItem({ hash: "task-b", parents: ["task-c"] }),
      createLogItem({ hash: "master-18-22", parents: ["master-18-20"] }),
      createLogItem({ hash: "master-18-20", parents: ["task-main"] }),
      createLogItem({ hash: "task-c", parents: ["task-d"] }),
      createLogItem({ hash: "task-d", parents: ["side-temp"] }),
      createLogItem({ hash: "task-main", parents: ["root-main"] }),
      createLogItem({ hash: "temp-commit", parents: ["root-main"] }),
      createLogItem({ hash: "side-temp", parents: ["root-main"] }),
      createLogItem({ hash: "root-main", parents: [] }),
    ];

    const cells = buildLogGraphCells(items);

    expect(cells[10]?.lane).toBe(cells[11]?.lane);
    expect(cells[11]?.lane).toBe(cells[16]?.lane);
    expect(cells[16]?.lane).toBe(cells[24]?.lane);

    expect(cells[13]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ hash: "temp-commit", sourceHash: "wt4-head", lane: 4 }),
      expect.objectContaining({ hash: "temp-commit", sourceHash: "wt2-head", lane: 3 }),
      expect.objectContaining({ hash: "wt1-base", sourceHash: "wt1-mid", lane: 2 }),
    ]));

    expect(cells[23]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ hash: "temp-commit", sourceHash: "wt4-head", lane: 4 }),
      expect.objectContaining({ hash: "temp-commit", sourceHash: "wt2-head", lane: 3 }),
      expect.objectContaining({ hash: "temp-commit", sourceHash: "wt1-base", lane: 2 }),
    ]));

    expect(cells[24]?.incomingFromLanes).toEqual([2, 3, 4]);
  });

  it("脱敏拓扑复现：顶部承接与中部长支线不应出现错接和外冲尖角", () => {
    /**
     * 该夹具来自脱敏后的真实提交序列，专门用于锁定两类回归：
     * 1) `a0000030 -> a0000990` 在下一可见行的入射列错接；
     * 2) `a0000780 -> a00001c0` 长支线在 `a0000730/a0000860` 附近外冲再折返。
     */
    const items = [
      createLogItem({ hash: "a000003000000000000000000000000000000000", parents: ["a000099000000000000000000000000000000000"], decorations: "origin/release/test-pack, release/test-pack" }),
      createLogItem({ hash: "a000092000000000000000000000000000000000", parents: ["a000095000000000000000000000000000000000"], decorations: "HEAD -> master, origin/master, origin/HEAD" }),
      createLogItem({ hash: "a000078000000000000000000000000000000000", parents: ["a00001c000000000000000000000000000000000"], decorations: "worktree/demo/wt4" }),
      createLogItem({ hash: "a000095000000000000000000000000000000000", parents: ["a000052000000000000000000000000000000000"], decorations: "worktree/demo/wt3" }),
      createLogItem({ hash: "a000052000000000000000000000000000000000", parents: ["a000057000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000057000000000000000000000000000000000", parents: ["a00001a000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000099000000000000000000000000000000000", parents: ["a000098000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000098000000000000000000000000000000000", parents: ["a000086000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a00001a000000000000000000000000000000000", parents: ["a00007f000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a00007f000000000000000000000000000000000", parents: ["a00003e000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000045000000000000000000000000000000000", parents: ["a000091000000000000000000000000000000000"], decorations: "worktree/demo/wt1" }),
      createLogItem({ hash: "a000091000000000000000000000000000000000", parents: ["a000001000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000073000000000000000000000000000000000", parents: ["a00001c000000000000000000000000000000000"], decorations: "worktree/demo/wt2" }),
      createLogItem({ hash: "a000086000000000000000000000000000000000", parents: ["a000066000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a00003e000000000000000000000000000000000", parents: ["a00009b000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a00009b000000000000000000000000000000000", parents: ["a000040000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000001000000000000000000000000000000000", parents: ["a00001c000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000066000000000000000000000000000000000", parents: ["a00002d000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a00002d000000000000000000000000000000000", parents: ["a000039000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000040000000000000000000000000000000000", parents: ["a00003a000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a00003a000000000000000000000000000000000", parents: ["a00008b000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000039000000000000000000000000000000000", parents: ["a000077000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000077000000000000000000000000000000000", parents: ["a000034000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a00008b000000000000000000000000000000000", parents: ["a000033000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a00001c000000000000000000000000000000000", parents: ["a000033000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000033000000000000000000000000000000000", parents: ["a000023000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000034000000000000000000000000000000000", parents: ["a000056000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000023000000000000000000000000000000000", parents: ["a00009f000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a00009f000000000000000000000000000000000", parents: ["a000020000000000000000000000000000000000"], decorations: "" }),
      createLogItem({ hash: "a000056000000000000000000000000000000000", parents: ["a00002a000000000000000000000000000000000"], decorations: "" }),
    ];

    const cells = buildLogGraphCells(items);

    const topBridgeTrack = cells[1]?.tracks.find((track) =>
      String(track.sourceHash || "").startsWith("a0000030")
      && String(track.hash || "").startsWith("a0000990"),
    );
    expect(topBridgeTrack).toBeDefined();
    expect(topBridgeTrack?.incomingFromLanes).toEqual([1]);

    const longTrackAtD837 = cells[11]?.tracks.find((track) =>
      String(track.sourceHash || "").startsWith("a0000780")
      && String(track.hash || "").startsWith("a00001c0"),
    );
    const longTrackAtA832 = cells[12]?.tracks.find((track) =>
      String(track.sourceHash || "").startsWith("a0000780")
      && String(track.hash || "").startsWith("a00001c0"),
    );
    const longTrackAtC279 = cells[13]?.tracks.find((track) =>
      String(track.sourceHash || "").startsWith("a0000780")
      && String(track.hash || "").startsWith("a00001c0"),
    );

    expect(longTrackAtD837).toBeDefined();
    expect(longTrackAtA832).toBeDefined();
    expect(longTrackAtC279).toBeDefined();
    expect(longTrackAtD837?.lane).toBe(3);
    expect(longTrackAtD837?.outgoingToLane).toBe(4);
    expect(longTrackAtA832?.lane).toBe(4);
    expect(longTrackAtA832?.outgoingToLane).toBe(4);
    expect(longTrackAtC279?.incomingFromLanes).toEqual([4]);
  });

  it("脱敏拓扑复现：长边在当前行已有空列时，不应被隐藏目标继续向更右侧推出一条假分支", () => {
    /**
     * 该夹具来自脱敏截图中下段的脱敏 `--all --date-order` 序列，
     * 专门锁定两类回归：
     * 1) `a00002a0 -> a0000790` 在 `a00002b0` 这一行不应再额外右推一列；
     * 2) `a00000b0 -> a0000250` 在 `a0000240` 这一行不应再额外右推一列。
     * 这两处右推都会在 UI 上形成左图不存在的尖角/凸起和虚构 branch。
     */
    const items = [
      createLogItem({ hash: "a000023000000000000000000000000000000000", parents: ["a00009f000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000034000000000000000000000000000000000", parents: ["a000056000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00009f000000000000000000000000000000000", parents: ["a000020000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000056000000000000000000000000000000000", parents: ["a00002a000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000020000000000000000000000000000000000", parents: ["a000063000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000063000000000000000000000000000000000", parents: ["a00004e000000000000000000000000000000000", "a00002b000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00004e000000000000000000000000000000000", parents: ["a000089000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00002a000000000000000000000000000000000", parents: ["a000079000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00002b000000000000000000000000000000000", parents: ["a000089000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000089000000000000000000000000000000000", parents: ["a00008f000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000079000000000000000000000000000000000", parents: ["a000083000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00008f000000000000000000000000000000000", parents: ["a000046000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000083000000000000000000000000000000000", parents: ["a00000b000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000046000000000000000000000000000000000", parents: ["a00007e000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00007e000000000000000000000000000000000", parents: ["a000067000000000000000000000000000000000", "a000016000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000016000000000000000000000000000000000", parents: ["a000029000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000067000000000000000000000000000000000", parents: ["a000048000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000029000000000000000000000000000000000", parents: ["a000024000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00000b000000000000000000000000000000000", parents: ["a000025000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000024000000000000000000000000000000000", parents: ["a000048000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000025000000000000000000000000000000000", parents: ["a0000a3000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000048000000000000000000000000000000000", parents: ["a000014000000000000000000000000000000000"] }),
      createLogItem({ hash: "a0000a3000000000000000000000000000000000", parents: ["a000048000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000014000000000000000000000000000000000", parents: [] }),
    ];

    const cells = buildLogGraphCells(items);

    const trackAt33af = cells[8]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a0000790")
      && String(track.sourceHash || "").startsWith("a00002a0"),
    );
    const trackAt2d78 = cells[19]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a0000250")
      && String(track.sourceHash || "").startsWith("a00000b0"),
    );

    expect(trackAt33af).toBeDefined();
    expect(trackAt2d78).toBeDefined();
    expect(trackAt33af?.lane).toBe(2);
    expect(trackAt33af?.incomingFromLanes).toEqual([2]);
    expect(trackAt2d78?.lane).toBe(2);
    expect(trackAt2d78?.incomingFromLanes).toEqual([2]);
    expect(cells[8]?.maxLane).toBe(2);
    expect(cells[19]?.maxLane).toBe(2);
  });

  it("脱敏拓扑复现：merge 首父缺失时，不应把可见次父误并入当前 fragment", () => {
    /**
     * 该夹具直接取自脱敏截图的顶部序列。
     * 对齐 IDEA `GraphLayoutBuilder.build + walk(first child without layoutIndex)` 的完整图语义：
     * - `a0000420` 的首父 `a00002c0` 虽然当前页不可见，但仍属于当前 `feature/audio-demo` fragment；
     * - 因此可见次父 `a0000760` 必须落到独立 lane，而不是被误当成当前 fragment 的继续直线；
     * - 后续 `a0000150` 也不能再把 `a0000260` 主链挤到右侧。
     */
    const items = [
      createLogItem({ hash: "a00004d000000000000000000000000000000000", parents: ["a000042000000000000000000000000000000000"], decorations: "origin/feature/audio-demo" }),
      createLogItem({ hash: "a000042000000000000000000000000000000000", parents: ["a00002c000000000000000000000000000000000", "a000076000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000076000000000000000000000000000000000", parents: ["a00004a000000000000000000000000000000000"], decorations: "origin/master, origin/HEAD" }),
      createLogItem({ hash: "a00004a000000000000000000000000000000000", parents: ["a0000a4000000000000000000000000000000000"] }),
      createLogItem({ hash: "a0000a4000000000000000000000000000000000", parents: ["a000026000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000015000000000000000000000000000000000", parents: ["a000096000000000000000000000000000000000"], decorations: "origin/release/test-pack" }),
      createLogItem({ hash: "a000096000000000000000000000000000000000", parents: ["a000068000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000026000000000000000000000000000000000", parents: ["a00009a000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00009a000000000000000000000000000000000", parents: ["a000075000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000068000000000000000000000000000000000", parents: ["a000059000000000000000000000000000000000"] }),
    ];

    const cells = buildLogGraphCells(items);
    const mergeToMaster = cells[1]?.edges.find((edge) =>
      String(edge.sourceHash || "").startsWith("a0000420")
      && String(edge.targetHash || "").startsWith("a0000760"),
    );
    const masterTo6553 = cells[2]?.edges.find((edge) =>
      String(edge.sourceHash || "").startsWith("a0000760")
      && String(edge.targetHash || "").startsWith("a00004a0"),
    );
    const trackAt15a = cells[5]?.tracks.find((track) =>
      String(track.sourceHash || "").startsWith("a0000a40")
      && String(track.hash || "").startsWith("a0000260"),
    );

    expect(mergeToMaster).toBeDefined();
    expect(masterTo6553).toBeDefined();
    expect(trackAt15a).toBeDefined();
    expect(mergeToMaster?.to).toBe(cells[2]?.lane);
    expect(mergeToMaster?.from).not.toBe(mergeToMaster?.to);
    expect(cells[2]?.incomingFromLanes).toEqual([mergeToMaster?.from as number]);
    expect(masterTo6553?.from).toBe(cells[2]?.lane);
    expect(masterTo6553?.to).toBe(cells[3]?.lane);
    expect(cells[5]?.lane).toBe(1);
    expect(trackAt15a?.lane).toBe(0);
    expect(cells[7]?.lane).toBe(0);
  });

  it("脱敏拓扑复现：同一目标的多条兄弟长边在中段不应互换左右列位", () => {
    /**
     * 该夹具直接取自脱敏提交序列中的对应时间段。
     * 当前截图里的剩余问题是 `a0000640/a0000820 -> a0000280` 两条长边在中段互换左右顺序，
     * 导致 `a00004c0/a00002e0` 一带出现 IDEA 中不存在的 X 形折返。
     * 这里要求两条兄弟长边在到达 `a0000280` 前，左右顺序必须持续稳定。
     */
    const items = [
      createLogItem({ hash: "a000064000000000000000000000000000000000", parents: ["a000028000000000000000000000000000000000"], decorations: "worktree/demo/wt3" }),
      createLogItem({ hash: "a00003c000000000000000000000000000000000", parents: ["a000017000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00006e000000000000000000000000000000000", parents: ["a000087000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000017000000000000000000000000000000000", parents: ["a000051000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000051000000000000000000000000000000000", parents: ["a0000a6000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000087000000000000000000000000000000000", parents: ["a000022000000000000000000000000000000000", "a00005d000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000022000000000000000000000000000000000", parents: ["a00004c000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000082000000000000000000000000000000000", parents: ["a000028000000000000000000000000000000000"], decorations: "worktree/demo/wt2" }),
      createLogItem({ hash: "a00005d000000000000000000000000000000000", parents: ["a00004c000000000000000000000000000000000"] }),
      createLogItem({ hash: "a0000a6000000000000000000000000000000000", parents: ["a000074000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00004c000000000000000000000000000000000", parents: ["a000080000000000000000000000000000000000", "a000031000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000080000000000000000000000000000000000", parents: ["a00006b000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000031000000000000000000000000000000000", parents: ["a00006b000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00006b000000000000000000000000000000000", parents: ["a000035000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00002e000000000000000000000000000000000", parents: ["a000028000000000000000000000000000000000"], decorations: "worktree/demo/wt1" }),
      createLogItem({ hash: "a000028000000000000000000000000000000000", parents: ["a000035000000000000000000000000000000000"], decorations: "worktree/demo/wt4" }),
      createLogItem({ hash: "a000074000000000000000000000000000000000", parents: ["a00009d000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000035000000000000000000000000000000000", parents: ["a00006f000000000000000000000000000000000"] }),
    ];

    const cells = buildLogGraphCells(items);
    const assertSiblingOrder = (rowIndex: number): void => {
      const tracks = cells[rowIndex]?.tracks || [];
      const fromWt2 = tracks.find((track) =>
        String(track.hash || "").startsWith("a0000280")
        && String(track.sourceHash || "").startsWith("a0000820"),
      );
      const fromWt3 = tracks.find((track) =>
        String(track.hash || "").startsWith("a0000280")
        && String(track.sourceHash || "").startsWith("a0000640"),
      );

      expect(fromWt2).toBeDefined();
      expect(fromWt3).toBeDefined();
      expect((fromWt2?.lane ?? -1) < (fromWt3?.lane ?? -1)).toBe(true);
    };

    assertSiblingOrder(10);
    assertSiblingOrder(11);
    assertSiblingOrder(12);
    assertSiblingOrder(13);
    assertSiblingOrder(14);

    /**
     * 兄弟长边重排后，track 自身的上半段入射列也必须同步到上一行真实列位。
     * 否则即使左右顺序没换位，`bc76/38989/36484` 这些行仍会沿用重排前旧列位，形成 IDEA 不存在的折返尖角。
     */
    const assertTrackContinuity = (previousRowIndex: number, currentRowIndex: number, sourceHashPrefix: string): void => {
      const previousTrack = (cells[previousRowIndex]?.tracks || []).find((track) =>
        String(track.hash || "").startsWith("a0000280")
        && String(track.sourceHash || "").startsWith(sourceHashPrefix),
      );
      const currentTrack = (cells[currentRowIndex]?.tracks || []).find((track) =>
        String(track.hash || "").startsWith("a0000280")
        && String(track.sourceHash || "").startsWith(sourceHashPrefix),
      );

      expect(previousTrack).toBeDefined();
      expect(currentTrack).toBeDefined();
      expect(currentTrack?.incomingFromLanes).toEqual([previousTrack?.lane as number]);
      expect(currentTrack?.incomingEdges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          fromLane: previousTrack?.lane,
          sourceHash: previousTrack?.sourceHash,
          targetHash: previousTrack?.hash,
        }),
      ]));
    };

    assertTrackContinuity(10, 11, "a0000820");
    assertTrackContinuity(10, 11, "a0000640");
    assertTrackContinuity(13, 14, "a0000820");
    assertTrackContinuity(13, 14, "a0000640");
  });

  it("脱敏拓扑复现：wt7 顶部三条 lane 的接入列、terminal arrow 列与目标节点应保持一致", () => {
    /**
     * 该夹具直接取自脱敏截图对应的顶部序列。
     * 这里锁定三类现象：
     * 1) `a0000600 -> a00005b0` 在 `a00001b0/a00008d0` 两行之间不应提前折回；
     * 2) `a00008d0` 的 terminal arrow 必须和节点本身落在同一列；
     * 3) `a00005b0` 必须从上一行同一列竖直接入，不能再从更靠左的列斜切入点。
     */
    const items = [
      createLogItem({ hash: "a000062000000000000000000000000000000000", parents: ["a000060000000000000000000000000000000000"], decorations: "worktree/demo/wt6, worktree/demo/wt1" }),
      createLogItem({ hash: "a000060000000000000000000000000000000000", parents: ["a00005b000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00001b000000000000000000000000000000000", parents: ["a000027000000000000000000000000000000000"], decorations: "origin/master, origin/HEAD, master" }),
      createLogItem({ hash: "a00008d000000000000000000000000000000000", parents: ["a00005f000000000000000000000000000000000"], decorations: "origin/feature/side-a" }),
      createLogItem({ hash: "a00005b000000000000000000000000000000000", parents: ["a00000e000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00000e000000000000000000000000000000000", parents: ["a000085000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000085000000000000000000000000000000000", parents: ["a000038000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000038000000000000000000000000000000000", parents: ["a00007c000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00007c000000000000000000000000000000000", parents: ["a000043000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000043000000000000000000000000000000000", parents: ["a000032000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000032000000000000000000000000000000000", parents: ["a000065000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000027000000000000000000000000000000000", parents: ["a00008c000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00008c000000000000000000000000000000000", parents: ["a00005f000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000018000000000000000000000000000000000", parents: ["a00005f000000000000000000000000000000000"], decorations: "origin/feature/side-b" }),
    ];

    const cells = buildLogGraphCells(items);
    const topTrackAtFirst1158 = cells[2]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a00005b0")
      && String(track.sourceHash || "").startsWith("a0000600"),
    );
    const topTrackAtSecond1158 = cells[3]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a00005b0")
      && String(track.sourceHash || "").startsWith("a0000600"),
    );

    expect(topTrackAtFirst1158).toBeDefined();
    expect(topTrackAtSecond1158).toBeDefined();
    expect(topTrackAtFirst1158?.outgoingToLane).toBe(2);
    expect(topTrackAtSecond1158?.lane).toBe(2);
    expect(cells[3]?.lane).toBe(2);
    expect(cells[3]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 2, to: 2, terminal: true, arrow: true }),
    ]));
    expect(cells[4]?.lane).toBe(1);
    expect(cells[4]?.incomingFromLanes).toEqual([2]);
  });

  it("脱敏拓扑复现：a00003d / a000008 / a000012 这一段不应把右侧长边提前左挪", () => {
    /**
     * 该夹具直接取自脱敏仓库的对应区间。
     * 对齐 IDEA 后：
     * - `a000012 -> a00003d` 在 `a000008` 这一行仍应保持在节点右侧，但目标行要回到 IDEA 当前行排序后的列位；
     * - `a00003d` 节点在下一行应从上一行同一条 track 的列位接入，而不是再额外右偏一列；
     * - 这段修复只影响 `a000012 -> a00003d` 这条右侧长边，不应误伤 `a000008 -> a00009e` 这一条左侧链路。
     */
    const items = [
      createLogItem({ hash: "a000081000000000000000000000000000000000", parents: ["a000008000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00008a000000000000000000000000000000000", parents: ["a000037000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000037000000000000000000000000000000000", parents: ["a000012000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000049000000000000000000000000000000000", parents: ["a000002000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000002000000000000000000000000000000000", parents: ["a000041000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000041000000000000000000000000000000000", parents: ["a000010000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000012000000000000000000000000000000000", parents: ["a00003d000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000008000000000000000000000000000000000", parents: ["a00009e000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00003d000000000000000000000000000000000", parents: ["a000088000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00009e000000000000000000000000000000000", parents: ["a000004000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000004000000000000000000000000000000000", parents: ["a000053000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000088000000000000000000000000000000000", parents: ["a000019000000000000000000000000000000000"] }),
    ];

    const cells = buildLogGraphCells(items);
    const edgeTo4d57 = cells[6]?.edges.find((edge) =>
      String(edge.sourceHash || "").startsWith("a0000120")
      && String(edge.targetHash || "").startsWith("a00003d0"),
    );
    const trackTo4d57 = cells[7]?.tracks.find((track) =>
      String(track.sourceHash || "").startsWith("a0000120")
      && String(track.hash || "").startsWith("a00003d0"),
    );
    const edgeToE905 = cells[7]?.edges.find((edge) =>
      String(edge.sourceHash || "").startsWith("a0000080")
      && String(edge.targetHash || "").startsWith("a00009e0"),
    );

    expect(edgeTo4d57).toBeDefined();
    expect(cells[7]?.lane).toBeDefined();
    expect(cells[7]?.lane).toBe(0);
    expect(trackTo4d57).toEqual(expect.objectContaining({
      incomingFromLanes: [edgeTo4d57?.to as number],
    }));
    expect((trackTo4d57?.lane ?? -1) > (cells[7]?.lane ?? Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(trackTo4d57?.lane).toBe(1);
    expect(edgeTo4d57?.from).toBe(cells[6]?.lane);
    expect(edgeTo4d57?.to).toBe(trackTo4d57?.lane);
    expect(cells[8]?.incomingFromLanes).toEqual([1]);
    expect(cells[8]?.lane).toBe(1);
    expect(trackTo4d57?.outgoingToLane).toBe(cells[8]?.lane);
    expect(edgeToE905?.from).toBe(cells[7]?.lane);
  });

  it("脱敏拓扑复现：a00005c0 这一行应已经切到 a0000a70 所属颜色，而不是继续沿用右侧说明分支颜色", () => {
    /**
     * 对齐 IDEA `PrintElementPresentationManagerImpl#getColorId`。
     * `a00006c0 -> a0000a70` 这条 normal edge 在 a00005c0 行对应的可见 track，
     * 颜色必须与目标 fragment `a0000a70` 保持一致，并且不能再沿用 `a00005c0` 自身链路的颜色。
     */
    const cells = buildLogGraphCells(WT7_TOP_VISIBLE_ITEMS);
    const edge9eToFfac = cells[6]?.edges.find((edge) =>
      String(edge.sourceHash || "").startsWith("a00006c0")
      && String(edge.targetHash || "").startsWith("a0000a70"),
    );
    const track9eToFfacAt7f99 = cells[7]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a0000a70")
      && String(track.sourceHash || "").startsWith("a00006c0"),
    );

    expect(edge9eToFfac).toBeDefined();
    expect(track9eToFfacAt7f99).toBeDefined();
    expect(track9eToFfacAt7f99?.color).toBe(edge9eToFfac?.color);
    expect(track9eToFfacAt7f99?.color).toBe(cells[13]?.color);
    expect(track9eToFfacAt7f99?.color).not.toBe(cells[7]?.color);
  });

  it("无 decoration 且只有单一真实入射的节点，其整条入射逻辑 edge 应与目标节点颜色一致", () => {
    /**
     * 该夹具直接覆盖脱敏拓扑里 `a0000630 -> a00002b0` 这一类颜色错位。
     * `a00002b0` 本身没有 decoration，且只有一条真实入射；
     * 因此从 `a0000630` 发出的 source edge，以及中间两行的可见 track，
     * 都应在进入 `a00002b0` fragment 后统一切到目标节点颜色，而不是继续沿用旧 fragment 颜色。
     */
    const items = [
      createLogItem({ hash: "a000023000000000000000000000000000000000", parents: ["a00009f000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000034000000000000000000000000000000000", parents: ["a000056000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00009f000000000000000000000000000000000", parents: ["a000020000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000056000000000000000000000000000000000", parents: ["a00002a000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000020000000000000000000000000000000000", parents: ["a000063000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000063000000000000000000000000000000000", parents: ["a00004e000000000000000000000000000000000", "a00002b000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00004e000000000000000000000000000000000", parents: ["a000089000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00002a000000000000000000000000000000000", parents: ["a000079000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00002b000000000000000000000000000000000", parents: ["a000089000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000089000000000000000000000000000000000", parents: ["a00008f000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000079000000000000000000000000000000000", parents: ["a000083000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00008f000000000000000000000000000000000", parents: ["a000046000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000083000000000000000000000000000000000", parents: ["a00000b000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000046000000000000000000000000000000000", parents: [] }),
      createLogItem({ hash: "a00000b000000000000000000000000000000000", parents: [] }),
    ];

    const cells = buildLogGraphCells(items);
    const targetCell = cells[8];
    const sourceEdge = cells[5]?.edges.find((edge) =>
      String(edge.sourceHash || "").startsWith("a0000630")
      && String(edge.targetHash || "").startsWith("a00002b0"),
    );
    const trackAt6c7e = cells[6]?.tracks.find((track) =>
      String(track.sourceHash || "").startsWith("a0000630")
      && String(track.hash || "").startsWith("a00002b0"),
    );
    const trackAt3367 = cells[7]?.tracks.find((track) =>
      String(track.sourceHash || "").startsWith("a0000630")
      && String(track.hash || "").startsWith("a00002b0"),
    );
    const incomingEdge = targetCell?.incomingEdges?.find((edge) =>
      String(edge.sourceHash || "").startsWith("a0000630")
      && String(edge.targetHash || "").startsWith("a00002b0"),
    );

    expect(targetCell).toBeDefined();
    expect(sourceEdge).toBeDefined();
    expect(trackAt6c7e).toBeDefined();
    expect(trackAt3367).toBeDefined();
    expect(incomingEdge).toBeDefined();
    expect(sourceEdge?.color).toBe(targetCell?.color);
    expect(trackAt6c7e?.color).toBe(targetCell?.color);
    expect(trackAt3367?.color).toBe(targetCell?.color);
    expect(incomingEdge?.color).toBe(targetCell?.color);
  });

  it("脱敏拓扑复现：a0000440 与 a0000500 指向 a00007b0 的折线应从 a0000a70 行开始，而不是拖到 a00007b0 行", () => {
    /**
     * 对齐 IDEA `GraphElementComparatorByLayoutIndex` 驱动的可见位置排序。
     * 到了 `a0000a70` 这一行，指向 `a00007b0` 的两条长边已经进入“下一压缩行的目标列”。
     * 因此当前行就必须产出指向目标节点列的 `outgoingToLane`，而不是等到下一行节点处再弯折。
     */
    const cells = buildLogGraphCells(WT7_TOP_VISIBLE_ITEMS);
    const targetLane = cells[14]?.lane;
    const masterTrackAtFfac = cells[13]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a00007b0")
      && String(track.sourceHash || "").startsWith("a0000440"),
    );
    const envTrackAtFfac = cells[13]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a00007b0")
      && String(track.sourceHash || "").startsWith("a0000500"),
    );

    expect(masterTrackAtFfac).toBeDefined();
    expect(envTrackAtFfac).toBeDefined();
    expect(masterTrackAtFfac?.outgoingToLane).toBe(targetLane);
    expect(envTrackAtFfac?.outgoingToLane).toBe(targetLane);
    expect(cells[14]?.incomingFromLanes).toEqual(expect.arrayContaining([
      masterTrackAtFfac?.lane as number,
      envTrackAtFfac?.lane as number,
    ]));
  });

  it("跨度为 3 的多行边在目标前一行也应提前折到目标列，而不是拖到目标节点行", () => {
    /**
     * 该夹具覆盖脱敏拓扑里 `a00002b0/a0000890` 与 `a0000380/a00006f0` 的同类问题。
     * 当一条多行边跨过 3 行，且到达目标节点前一行时已经满足：
     * 1) 上一行与当前行保持同列连续；
     * 2) 下一行就是目标节点，且目标列只需左收 1 列；
     * 3) 当前行目标列为空；
     * 则当前行就应提前折到目标列，避免目标节点前一行仍画成“先直后斜”的错误折线。
     */
    const items = [
      createLogItem({ hash: "merge-head", parents: ["main-head", "branch-head"] }),
      createLogItem({ hash: "main-head", parents: ["main-target"] }),
      createLogItem({ hash: "long-source", parents: ["long-target"] }),
      createLogItem({ hash: "branch-head", parents: ["main-target"] }),
      createLogItem({ hash: "main-target", parents: ["main-tail"] }),
      createLogItem({ hash: "long-target", parents: ["long-tail"] }),
      createLogItem({ hash: "main-tail", parents: [] }),
      createLogItem({ hash: "long-tail", parents: [] }),
    ];

    const cells = buildLogGraphCells(items);
    const trackAtMainTarget = cells[4]?.tracks.find((track) =>
      String(track.hash || "") === "long-target"
      && String(track.sourceHash || "") === "long-source",
    );

    expect(trackAtMainTarget).toBeDefined();
    expect(trackAtMainTarget?.lane).toBe(1);
    expect(trackAtMainTarget?.outgoingToLane).toBe(1);
    expect(cells[5]?.lane).toBe(1);
    expect(cells[5]?.incomingFromLanes).toEqual([1]);
  });

  it("长边 terminal 可见段在目标前一行应直接对接目标节点列", () => {
    /**
     * 对齐 IDEA `PrintElementGeneratorImpl#createEndPositionFunction`。
     * 当一条长边在目标前一行首次作为 terminal 可见段出现时，
     * 当前行下半段就应直接指向下一行目标节点列，而不是额外保留一行竖线。
     */
    const items = [
      createLogItem({ hash: "main-head", parents: ["m1"], decorations: "HEAD -> master, origin/master" }),
      createLogItem({ hash: "side-source", parents: ["target"], decorations: "feature/demo" }),
      ...Array.from({ length: 30 }, (_, index) => {
        const current = `m${index + 1}`;
        const parent = index === 29 ? "target" : `m${index + 2}`;
        return createLogItem({ hash: current, parents: [parent] });
      }),
      createLogItem({ hash: "target", parents: ["root"] }),
      createLogItem({ hash: "root", parents: [] }),
    ];

    const cells = buildLogGraphCells(items);
    const terminalTrackAtTargetPrev = cells[31]?.tracks.find((track) =>
      String(track.hash || "") === "target"
      && String(track.sourceHash || "") === "side-source",
    );

    expect(terminalTrackAtTargetPrev).toBeDefined();
    expect(terminalTrackAtTargetPrev?.incomingTerminal).toBe(true);
    expect(terminalTrackAtTargetPrev?.lane).toBe(1);
    expect(terminalTrackAtTargetPrev?.outgoingToLane).toBe(cells[32]?.lane);
    expect(cells[32]?.incomingFromLanes).toEqual(expect.arrayContaining([0, 1]));
  });

  it("脱敏拓扑复现：a0000650 -> a00004b0 -> a00006d0 为相邻 direct edge 链时，应保持同列直下", () => {
    /**
     * 该夹具直接覆盖脱敏拓扑里 `a0000270/a00008c0/a0000650/a00004b0/a00006d0` 这一段。
     * 对齐 IDEA `PrintElementGeneratorImpl#getSortedVisibleElementsInRow` + `EdgesInRowGenerator#getEdgesInRow`：
     * - 相邻 normal direct edge 不会在当前行留下独立 `GraphEdge` 位置；
     * - 因而 `a0000650 -> a00004b0 -> a00006d0` 这一条短链应继续共用同一局部列位；
     * - 不能把 direct edge 误当成额外泳道，再人为压出一次折线。
     */
    const items = [
      createLogItem({ hash: "a00001b000000000000000000000000000000000", parents: ["a000027000000000000000000000000000000000"], decorations: "origin/master, origin/HEAD, master" }),
      createLogItem({ hash: "a00008d000000000000000000000000000000000", parents: ["a00005f000000000000000000000000000000000"], decorations: "origin/feature/side-a" }),
      createLogItem({ hash: "a000032000000000000000000000000000000000", parents: ["a000065000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000027000000000000000000000000000000000", parents: ["a00008c000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00008c000000000000000000000000000000000", parents: ["a00005f000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000018000000000000000000000000000000000", parents: ["a00005f000000000000000000000000000000000"], decorations: "origin/feature/side-b" }),
      createLogItem({ hash: "a000065000000000000000000000000000000000", parents: ["a00004b000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00004b000000000000000000000000000000000", parents: ["a00006d000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00006d000000000000000000000000000000000", parents: ["a000058000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00005f000000000000000000000000000000000", parents: ["a000058000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000058000000000000000000000000000000000", parents: [] }),
    ];

    const cells = buildLogGraphCells(items);
    const edge907To65 = cells[6]?.edges.find((edge) =>
      String(edge.targetHash || "").startsWith("a00004b0")
      && String(edge.sourceHash || "").startsWith("a0000650"),
    );
    const edge65To9f = cells[7]?.edges.find((edge) =>
      String(edge.targetHash || "").startsWith("a00006d0")
      && String(edge.sourceHash || "").startsWith("a00004b0"),
    );

    expect(edge907To65).toBeDefined();
    expect(edge65To9f).toBeDefined();
    expect(cells[6]?.lane).toBe(cells[7]?.lane);
    expect(cells[7]?.lane).toBe(cells[8]?.lane);
    expect(edge907To65?.from).toBe(cells[6]?.lane);
    expect(edge907To65?.to).toBe(cells[7]?.lane);
    expect(edge65To9f?.from).toBe(cells[7]?.lane);
    expect(edge65To9f?.to).toBe(cells[8]?.lane);
  });

  it("脱敏拓扑复现：wt7 截图整段可见序列应保留 IDEA 的独立轨道与双入射关系", () => {
    /**
     * 该夹具直接取自脱敏截图里的同一组可见提交顺序。
     * 这里锁定三类问题：
     * 1) `fix(worktree)` 必须落在独立列，不能被压回左侧连续紫色轨道；
     * 2) `渲染出错` 一行必须同时保留两条独立入射，不能把中段结构合并成单线；
     * 3) `三者可用性` 一行到底部前，仍需保留两条来源轨道，避免底部历史被错误跳轨。
     */
    const items = [
      createLogItem({ hash: "a00007d000000000000000000000000000000000", parents: ["a000005000000000000000000000000000000000"], decorations: "worktree/demo/wt8" }),
      createLogItem({ hash: "a0000a7000000000000000000000000000000000", parents: ["a0000a5000000000000000000000000000000000"], decorations: "worktree/demo/wt2" }),
      createLogItem({ hash: "a000005000000000000000000000000000000000", parents: ["a000090000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000090000000000000000000000000000000000", parents: ["a00009c000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00009c000000000000000000000000000000000", parents: ["a0000a1000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00007b000000000000000000000000000000000", parents: ["a00001b000000000000000000000000000000000"], decorations: "origin/master, origin/HEAD, master" }),
      createLogItem({ hash: "a0000a1000000000000000000000000000000000", parents: ["a00008e000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00008e000000000000000000000000000000000", parents: ["a00004f000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00004f000000000000000000000000000000000", parents: ["a000071000000000000000000000000000000000"] }),
      createLogItem({ hash: "a0000a5000000000000000000000000000000000", parents: ["a000061000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000071000000000000000000000000000000000", parents: ["a000013000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000061000000000000000000000000000000000", parents: ["a00005e000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00005e000000000000000000000000000000000", parents: ["a000013000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00000c000000000000000000000000000000000", parents: ["a000094000000000000000000000000000000000"], decorations: "worktree/demo/wt1" }),
      createLogItem({ hash: "a000013000000000000000000000000000000000", parents: ["a000084000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000084000000000000000000000000000000000", parents: ["a000097000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000094000000000000000000000000000000000", parents: ["a000062000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000097000000000000000000000000000000000", parents: ["a00000a000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00000a000000000000000000000000000000000", parents: ["a000062000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000062000000000000000000000000000000000", parents: ["a000060000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000060000000000000000000000000000000000", parents: ["a00005b000000000000000000000000000000000"] }),
    ];

    const cells = buildLogGraphCells(items);

    expect(cells[4]?.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 1, to: 2, targetHash: "a0000a1000000000000000000000000000000000" }),
    ]));
    expect(cells[5]?.lane).toBe(2);
    expect(cells[5]?.tracks).toEqual(expect.arrayContaining([
      expect.objectContaining({ hash: "a0000a1000000000000000000000000000000000", lane: 2, incomingFromLanes: [1] }),
    ]));
    expect(cells[14]?.lane).toBe(1);
    expect(cells[14]?.incomingFromLanes).toEqual([1, 2]);
    expect(cells[19]?.incomingFromLanes).toEqual([1, 0]);

    const edgeA64To14 = cells[10]?.edges.find((edge) => String(edge.targetHash || "").startsWith("a0000130"));
    const edge8534To14 = cells[12]?.edges.find((edge) => String(edge.targetHash || "").startsWith("a0000130"));
    const trackA64At11 = cells[11]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a0000130")
      && String(track.sourceHash || "").startsWith("a0000710"),
    );
    const trackA64At13 = cells[13]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a0000130")
      && String(track.sourceHash || "").startsWith("a0000710"),
    );
    const track8534At13 = cells[13]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a0000130")
      && String(track.sourceHash || "").startsWith("a00005e0"),
    );

    expect(edgeA64To14).toBeDefined();
    expect(edge8534To14).toBeDefined();
    expect(trackA64At11?.color).toBe(edgeA64To14?.color);
    expect(trackA64At13?.color).toBe(edgeA64To14?.color);
    expect(track8534At13?.color).toBe(edge8534To14?.color);
    expect(trackA64At13?.color).not.toBe(track8534At13?.color);
  });

  it("脱敏拓扑复现：同一条长边的下半段必须逐行对齐到下一压缩行的真实列位", () => {
    /**
     * 该夹具直接取自脱敏运行时首屏的脱敏 `--all --date-order` 序列。
     * 这里锁定的不是抽象 lane 数，而是同一条长边 `a0000710 -> a0000130` 的跨行连续性：
     * - 当前行 `outgoingToLane` 必须接到下一行同一 edgeKey 的压缩列位；
     * - 下一行 `incomingFromLanes` 也必须回指上一行的真实压缩列位；
     * - 只有到真正落入目标节点的前一行，才允许向目标节点列弯折。
     */
    const items = [
      createLogItem({ hash: "a000011000000000000000000000000000000000", parents: ["a00001d000000000000000000000000000000000"], decorations: "worktree/demo/wt1" }),
      createLogItem({ hash: "a00000f000000000000000000000000000000000", parents: ["a000021000000000000000000000000000000000"], decorations: "worktree/demo/wt8" }),
      createLogItem({ hash: "a00001d000000000000000000000000000000000", parents: ["a00000c000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000021000000000000000000000000000000000", parents: ["a00007d000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00007d000000000000000000000000000000000", parents: ["a000005000000000000000000000000000000000"] }),
      createLogItem({ hash: "a0000a7000000000000000000000000000000000", parents: ["a0000a5000000000000000000000000000000000"], decorations: "worktree/demo/wt2" }),
      createLogItem({ hash: "a000005000000000000000000000000000000000", parents: ["a000090000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000090000000000000000000000000000000000", parents: ["a00009c000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00009c000000000000000000000000000000000", parents: ["a0000a1000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00007b000000000000000000000000000000000", parents: ["a00001b000000000000000000000000000000000"], decorations: "origin/master, origin/HEAD, master" }),
      createLogItem({ hash: "a0000a1000000000000000000000000000000000", parents: ["a00008e000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00008e000000000000000000000000000000000", parents: ["a00004f000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00004f000000000000000000000000000000000", parents: ["a000071000000000000000000000000000000000"] }),
      createLogItem({ hash: "a0000a5000000000000000000000000000000000", parents: ["a000061000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000071000000000000000000000000000000000", parents: ["a000013000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000061000000000000000000000000000000000", parents: ["a00005e000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00005e000000000000000000000000000000000", parents: ["a000013000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00000c000000000000000000000000000000000", parents: ["a000094000000000000000000000000000000000"], decorations: "worktree/demo/wt1" }),
      createLogItem({ hash: "a000013000000000000000000000000000000000", parents: ["a000084000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000084000000000000000000000000000000000", parents: ["a000097000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000094000000000000000000000000000000000", parents: ["a000062000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000097000000000000000000000000000000000", parents: ["a00000a000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00000a000000000000000000000000000000000", parents: ["a000062000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000062000000000000000000000000000000000", parents: ["a000060000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000060000000000000000000000000000000000", parents: ["a00005b000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00001b000000000000000000000000000000000", parents: ["a000027000000000000000000000000000000000"] }),
    ];

    const cells = buildLogGraphCells(items);
    const trackAt14 = cells[15]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a0000130")
      && String(track.sourceHash || "").startsWith("a0000710"),
    );
    const trackAt15 = cells[16]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a0000130")
      && String(track.sourceHash || "").startsWith("a0000710"),
    );
    const trackAt16 = cells[17]?.tracks.find((track) =>
      String(track.hash || "").startsWith("a0000130")
      && String(track.sourceHash || "").startsWith("a0000710"),
    );
    const targetNode = cells[18];

    expect(trackAt14).toBeDefined();
    expect(trackAt15).toBeDefined();
    expect(trackAt16).toBeDefined();
    const sourceCell = cells.find((cell) => String(cell.commitHash || "").startsWith("a0000710"));
    const sourceEdge = sourceCell?.edges.find((edge) =>
      String(edge.targetHash || "").startsWith("a0000130")
      && String(edge.sourceHash || "").startsWith("a0000710"),
    );
    expect(sourceEdge).toBeDefined();
    expect(trackAt14?.outgoingToLane).toBe(trackAt15?.lane);
    expect(trackAt15?.incomingFromLanes).toEqual([trackAt14?.lane as number]);
    expect(trackAt15?.incomingEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromLane: sourceEdge?.from,
        color: sourceEdge?.color,
        sourceHash: sourceEdge?.sourceHash,
      }),
    ]));
    expect(trackAt15?.outgoingToLane).toBe(trackAt16?.lane);
    expect(trackAt16?.incomingFromLanes).toEqual([trackAt15?.lane as number]);
    expect(trackAt16?.outgoingToLane).toBe(targetNode?.lane);
    expect(targetNode?.incomingFromLanes).toEqual(expect.arrayContaining([trackAt16?.lane as number]));
  });

  it("脱敏拓扑复现：上一行 direct edge 接到下一行节点时，必须保留真实来源列与颜色", () => {
    const items = [
      createLogItem({ hash: "a00000c000000000000000000000000000000000", parents: ["a000094000000000000000000000000000000000"], decorations: "worktree/demo/wt1" }),
      createLogItem({ hash: "a000013000000000000000000000000000000000", parents: ["a000084000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000084000000000000000000000000000000000", parents: ["a000097000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000094000000000000000000000000000000000", parents: ["a000062000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000097000000000000000000000000000000000", parents: ["a00000a000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00000a000000000000000000000000000000000", parents: ["a000062000000000000000000000000000000000"] }),
      createLogItem({ hash: "a000062000000000000000000000000000000000", parents: ["a000060000000000000000000000000000000000"], decorations: "worktree/demo/wt6, worktree/demo/wt1" }),
      createLogItem({ hash: "a000060000000000000000000000000000000000", parents: ["a00005b000000000000000000000000000000000"] }),
      createLogItem({ hash: "a00001b000000000000000000000000000000000", parents: ["a000027000000000000000000000000000000000"], decorations: "origin/master, origin/HEAD, master" }),
    ];

    const cells = buildLogGraphCells(items);
    const sourceCell = cells.find((cell) => String(cell.commitHash || "").startsWith("a00000a0"));
    const targetCell = cells.find((cell) => String(cell.commitHash || "").startsWith("a0000620"));
    const sourceEdge = sourceCell?.edges.find((edge) =>
      String(edge.targetHash || "").startsWith("a0000620")
      && String(edge.sourceHash || "").startsWith("a00000a0"),
    );
    const incomingEdge = targetCell?.incomingEdges?.find((edge) =>
      String(edge.sourceHash || "").startsWith("a00000a0"),
    );

    expect(sourceEdge).toBeDefined();
    expect(incomingEdge).toBeDefined();
    expect(incomingEdge?.fromLane).toBe(sourceEdge?.from);
    expect(incomingEdge?.color).toBe(sourceEdge?.color);
  });
});
