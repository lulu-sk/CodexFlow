import { describe, expect, it } from "vitest";
import { calculateWorktreeTimeoutEstimate, parseGitCountObjectsOutput } from "./worktreeTimeout";

describe("worktree timeout estimate", () => {
  it("应解析 git count-objects 输出中的对象库大小", () => {
    const parsed = parseGitCountObjectsOutput([
      "count: 12",
      "size: 34",
      "in-pack: 56",
      "packs: 1",
      "size-pack: 789",
    ].join("\n"));

    expect(parsed.looseObjectBytes).toBe(34 * 1024);
    expect(parsed.packedObjectBytes).toBe(789 * 1024);
    expect(parsed.objectBytes).toBe((34 + 789) * 1024);
  });

  it("应为小仓库保留最小超时，避免过低误杀", () => {
    const estimate = calculateWorktreeTimeoutEstimate({
      metrics: {
        trackedFileCount: 12,
        checkoutFileCount: 12,
        checkoutBytes: 64 * 1024,
        indexBytes: 32 * 1024,
        objectBytes: 2 * 1024 * 1024,
      },
      worktreeCount: 1,
      maxParallel: 1,
    });

    expect(estimate.perWorktreeAddTimeoutMs).toBe(3 * 60_000);
    expect(estimate.taskTimeoutMs).toBeGreaterThan(estimate.perWorktreeAddTimeoutMs);
  });

  it("仓库规模探测失败时应回退到旧的 15 分钟下限", () => {
    const estimate = calculateWorktreeTimeoutEstimate({
      metrics: {},
      worktreeCount: 1,
      maxParallel: 1,
    });

    expect(estimate.perWorktreeAddTimeoutMs).toBe(15 * 60_000);
    expect(estimate.taskTimeoutMs).toBeGreaterThan(estimate.perWorktreeAddTimeoutMs);
  });

  it("应随仓库规模和实际创建数量增加超时", () => {
    const small = calculateWorktreeTimeoutEstimate({
      metrics: {
        trackedFileCount: 1000,
        checkoutFileCount: 1000,
        checkoutBytes: 20 * 1024 * 1024,
        indexBytes: 1 * 1024 * 1024,
        objectBytes: 50 * 1024 * 1024,
      },
      worktreeCount: 1,
      maxParallel: 1,
    });
    const large = calculateWorktreeTimeoutEstimate({
      metrics: {
        trackedFileCount: 120_000,
        checkoutFileCount: 120_000,
        checkoutBytes: 24 * 1024 * 1024 * 1024,
        indexBytes: 180 * 1024 * 1024,
        objectBytes: 8 * 1024 * 1024 * 1024,
      },
      worktreeCount: 8,
      maxParallel: 4,
    });

    expect(large.perWorktreeAddTimeoutMs).toBeGreaterThan(small.perWorktreeAddTimeoutMs);
    expect(large.taskTimeoutMs).toBeGreaterThan(large.perWorktreeAddTimeoutMs);
    expect(large.worktreeCount).toBe(8);
    expect(large.maxParallel).toBe(4);
  });
});
