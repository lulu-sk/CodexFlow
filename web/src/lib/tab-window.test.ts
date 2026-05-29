import { describe, expect, it } from "vitest";

import { MAIN_APP_WINDOW_ID, moveTabBetweenProjects } from "./tab-window";

describe("tab-window", () => {
  it("moveTabBetweenProjects：应把标签迁移到目标项目首位并保留窗口归属", () => {
    const input = {
      alpha: [
        { id: "git-alpha", windowId: "detached-git" },
        { id: "term-alpha", windowId: MAIN_APP_WINDOW_ID },
      ],
      beta: [
        { id: "term-beta", windowId: MAIN_APP_WINDOW_ID },
      ],
    };

    const result = moveTabBetweenProjects(input, "git-alpha", "beta");

    expect(result.changed).toBe(true);
    expect(result.sourceProjectId).toBe("alpha");
    expect(result.nextTabsByProject.alpha).toEqual([
      { id: "term-alpha", windowId: MAIN_APP_WINDOW_ID },
    ]);
    expect(result.nextTabsByProject.beta).toEqual([
      { id: "git-alpha", windowId: "detached-git" },
      { id: "term-beta", windowId: MAIN_APP_WINDOW_ID },
    ]);
  });

  it("moveTabBetweenProjects：目标项目与源项目相同时不应改动", () => {
    const input = {
      alpha: [
        { id: "git-alpha", windowId: MAIN_APP_WINDOW_ID },
      ],
    };

    const result = moveTabBetweenProjects(input, "git-alpha", "alpha");

    expect(result.changed).toBe(false);
    expect(result.sourceProjectId).toBe("alpha");
    expect(result.nextTabsByProject).toBe(input);
  });

  it("moveTabBetweenProjects：缺少标签或目标项目时应直接返回原状态", () => {
    const input = {
      alpha: [
        { id: "git-alpha", windowId: MAIN_APP_WINDOW_ID },
      ],
    };

    expect(moveTabBetweenProjects(input, "missing", "beta")).toEqual({
      nextTabsByProject: input,
      sourceProjectId: "",
      changed: false,
    });
    expect(moveTabBetweenProjects(input, "git-alpha", "")).toEqual({
      nextTabsByProject: input,
      sourceProjectId: "",
      changed: false,
    });
  });
});
