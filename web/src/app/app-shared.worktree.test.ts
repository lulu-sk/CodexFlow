import { describe, expect, it } from "vitest";

import { compileWorktreePromptText, resolveGrokAttachmentPaths, toWorktreePromptRelPath } from "./app-shared";

describe("app-shared（worktree 初始提示词编译）", () => {
  it("toWorktreePromptRelPath：将项目内 Windows 绝对路径转换为相对路径", () => {
    expect(toWorktreePromptRelPath({
      pathText: "C:\\repo\\docs\\task.md",
      projectWinRoot: "C:\\repo",
      projectWslRoot: "/mnt/c/repo",
    })).toBe("docs/task.md");
  });

  it("toWorktreePromptRelPath：保留项目外 Windows 绝对路径样式", () => {
    expect(toWorktreePromptRelPath({
      pathText: "D:\\shared\\brief.md",
      projectWinRoot: "C:\\repo",
      projectWslRoot: "/mnt/c/repo",
    })).toBe("D:\\shared\\brief.md");
  });

  it("toWorktreePromptRelPath：保留项目外 WSL 绝对路径样式", () => {
    expect(toWorktreePromptRelPath({
      pathText: "/mnt/d/shared/brief.md",
      projectWinRoot: "C:\\repo",
      projectWslRoot: "/mnt/c/repo",
    })).toBe("/mnt/d/shared/brief.md");
  });

  it("compileWorktreePromptText：按 PowerShell 终端选择 Windows 路径并转换项目内相对路径", () => {
    expect(compileWorktreePromptText({
      chips: [{
        fileName: "task.md",
        winPath: "C:\\repo\\docs\\task.md",
        wslPath: "/mnt/c/repo/docs/task.md",
      } as any],
      draft: "请先阅读上下文",
      projectWinRoot: "C:\\repo",
      projectWslRoot: "/mnt/c/repo",
      terminalMode: "pwsh",
    })).toBe("`docs/task.md`\n\n请先阅读上下文");
  });

  it("compileWorktreePromptText：按目标终端保留项目外绝对路径样式", () => {
    const chips = [{
      fileName: "brief.md",
      winPath: "D:\\shared\\brief.md",
      wslPath: "/mnt/d/shared/brief.md",
    } as any];

    expect(compileWorktreePromptText({
      chips,
      draft: "",
      projectWinRoot: "C:\\repo",
      projectWslRoot: "/mnt/c/repo",
      terminalMode: "windows",
    })).toBe("`D:\\shared\\brief.md`");

    expect(compileWorktreePromptText({
      chips,
      draft: "",
      projectWinRoot: "C:\\repo",
      projectWslRoot: "/mnt/c/repo",
      terminalMode: "wsl",
    })).toBe("`/mnt/d/shared/brief.md`");
  });

  it("Grok 图片由独立粘贴事件发送，正文只保留普通文件与草稿", () => {
    expect(compileWorktreePromptText({
      chips: [
        {
          chipKind: "image",
          type: "image/png",
          fileName: "screen.png",
          winPath: "X:\\workspace\\screen.png",
          wslPath: "/mnt/x/workspace/screen.png",
        } as any,
        {
          chipKind: "file",
          fileName: "task.md",
          winPath: "X:\\workspace\\docs\\task.md",
          wslPath: "/mnt/x/workspace/docs/task.md",
        } as any,
      ],
      draft: "请结合截图处理",
      projectWinRoot: "X:\\workspace",
      projectWslRoot: "/mnt/x/workspace",
      terminalMode: "pwsh",
      excludeImageChips: true,
    })).toBe("`docs/task.md`\n\n请结合截图处理");
  });

  it("resolveGrokAttachmentPaths：按目标终端解析图片绝对路径并去重", () => {
    const chips = [
      {
        chipKind: "image",
        type: "image/png",
        fileName: "screen.png",
        winPath: "X:\\workspace\\screen.png",
        wslPath: "/mnt/x/workspace/screen.png",
      } as any,
      {
        chipKind: "image",
        type: "image/png",
        fileName: "duplicate.png",
        winPath: "x:\\workspace\\screen.png",
        wslPath: "/mnt/x/workspace/screen.png",
      } as any,
      { chipKind: "file", fileName: "task.md", winPath: "X:\\workspace\\task.md" } as any,
    ];

    expect(resolveGrokAttachmentPaths({
      chips,
      projectWinRoot: "X:\\workspace",
      projectWslRoot: "/mnt/x/workspace",
      terminalMode: "pwsh",
    })).toEqual(["X:\\workspace\\screen.png"]);
    expect(resolveGrokAttachmentPaths({
      chips,
      projectWinRoot: "X:\\workspace",
      projectWslRoot: "/mnt/x/workspace",
      terminalMode: "wsl",
    })).toEqual(["/mnt/x/workspace/screen.png"]);
  });
});
