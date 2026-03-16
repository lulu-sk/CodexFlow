import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * 中文说明：创建临时 HOME 目录，并同步覆盖 HOME/USERPROFILE，便于测试 os.homedir() 相关逻辑。
 */
function createTempHome(): { home: string; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexflow-codex-home-"));
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  /**
   * 中文说明：恢复环境变量到原值；若原值不存在则删除，避免把 undefined 写成字符串污染后续测试。
   */
  const restoreEnv = (key: string, value: string | undefined) => {
    try {
      if (typeof value === "string") process.env[key] = value;
      else delete process.env[key];
    } catch {}
  };

  const cleanup = () => {
    restoreEnv("HOME", prevHome);
    restoreEnv("USERPROFILE", prevUserProfile);
    try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  };
  return { home, cleanup };
}

/**
 * 中文说明：读取当前 HOME 下的 ~/.codex/config.toml（若不存在则返回空字符串）。
 */
function readCodexConfigToml(home: string): string {
  const configPath = path.join(home, ".codex", "config.toml");
  try { return fs.readFileSync(configPath, "utf8"); } catch { return ""; }
}

/**
 * 中文说明：写入当前 HOME 下的 ~/.codex/config.toml（自动创建目录）。
 */
function writeCodexConfigToml(home: string, content: string): void {
  const dir = path.join(home, ".codex");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.toml"), content, "utf8");
}

/**
 * 中文说明：读取当前 HOME 下生成的 Codex notify 脚本内容（按平台优先级自动选择）。
 */
function readCodexNotifyScript(home: string): string {
  const dir = path.join(home, ".codex");
  const candidates = process.platform === "win32"
    ? ["codexflow_after_agent_notify.ps1", "codexflow_after_agent_notify.sh"]
    : ["codexflow_after_agent_notify.sh", "codexflow_after_agent_notify.ps1"];
  for (const file of candidates) {
    const body = readCodexNotifyScriptByName(home, file);
    if (body) return body;
  }
  return "";
}

/**
 * 中文说明：按文件名读取当前 HOME 下生成的指定 Codex notify 脚本内容。
 */
function readCodexNotifyScriptByName(home: string, fileName: string): string {
  const dir = path.join(home, ".codex");
  try { return fs.readFileSync(path.join(dir, fileName), "utf8"); } catch { return ""; }
}

/**
 * 中文说明：断言 root notify 命令按当前平台写入为正确执行器。
 */
function expectRootNotifyCommand(body: string): void {
  if (process.platform === "win32") {
    expect(body).toContain('notify = ["powershell.exe", ');
  } else {
    expect(body).toContain('notify = ["sh", ');
  }
}

/**
 * 中文说明：断言 notify 脚本文件名按当前平台写入正确。
 */
function expectNotifyScriptFileName(body: string): void {
  if (process.platform === "win32") {
    expect(body).toContain("codexflow_after_agent_notify.ps1");
  } else {
    expect(body).toContain("codexflow_after_agent_notify.sh");
  }
}

/**
 * 中文说明：加载 config.ts，并 mock 掉 getCodexRootsFastAsync，避免测试访问真实环境。
 */
async function loadConfigModule(): Promise<{ ensureAllCodexNotifications: () => Promise<void> }> {
  vi.resetModules();
  vi.doMock("../wsl", () => ({
    getCodexRootsFastAsync: vi.fn(async () => ({ wsl: [], windowsCodex: null })),
    uncToWsl: vi.fn(() => null),
  }));
  return await import("./config");
}

/**
 * 中文说明：临时覆盖 `process.platform`，用于验证不同平台分支的脚本生成逻辑。
 */
async function withMockedPlatform<T>(platform: NodeJS.Platform, action: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return await action();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("electron/codex/config（tui 通知配置修复）", () => {
  it("空配置：补齐 [tui] notifications + notification_method=osc9", async () => {
    const { home, cleanup } = createTempHome();
    try {
      const mod = await loadConfigModule();
      await mod.ensureAllCodexNotifications();
      const body = readCodexConfigToml(home);
      expect(body).toContain("[tui]");
      expect(body).toContain('notification_method = "osc9"');
      expect(body).toContain('notifications = ["agent-turn-complete"]');
      expectRootNotifyCommand(body);
      expectNotifyScriptFileName(body);
      const script = readCodexNotifyScript(home);
      expect(script).toContain("CODEXFLOW_NOTIFY_TAB_ID");
      expect(script).toContain("agent-turn-complete");
      expect(script).toContain("previewEscapedWhitespace");
    } finally {
      cleanup();
    }
  });

  it("root dotted：更新 tui.notifications 并强制 tui.notification_method=osc9（不追加 [tui]）", async () => {
    const { home, cleanup } = createTempHome();
    try {
      writeCodexConfigToml(home, [
        'tui.notifications = ["foo"]',
        'tui.notification_method = "auto"',
        "",
      ].join("\n"));
      const mod = await loadConfigModule();
      await mod.ensureAllCodexNotifications();
      const body = readCodexConfigToml(home);
      expect(body).not.toContain("[tui]");
      expect(body).toContain('tui.notification_method = "osc9"');
      expect(body).toContain('tui.notifications = ["foo", "agent-turn-complete"]');
      expect((body.match(/tui\.notifications\s*=/g) || []).length).toBe(1);
      expect((body.match(/tui\.notification_method\s*=/g) || []).length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("root dotted + 其它 section：补齐 method 时必须插在首个 section 之前", async () => {
    const { home, cleanup } = createTempHome();
    try {
      writeCodexConfigToml(home, [
        'tui.notifications = ["agent-turn-complete"]',
        "",
        "[other]",
        'foo = "bar"',
        "",
      ].join("\n"));
      const mod = await loadConfigModule();
      await mod.ensureAllCodexNotifications();
      const body = readCodexConfigToml(home);
      const idxMethod = body.indexOf('tui.notification_method = "osc9"');
      const idxOther = body.indexOf("[other]");
      expect(idxMethod).toBeGreaterThanOrEqual(0);
      expect(idxOther).toBeGreaterThanOrEqual(0);
      expect(idxMethod).toBeLessThan(idxOther);
      expect(body).not.toContain("[tui]");
    } finally {
      cleanup();
    }
  });

  it("同时存在 [tui] 与 root dotted：移除重复 dotted，并合并 notifications 到 [tui]", async () => {
    const { home, cleanup } = createTempHome();
    try {
      writeCodexConfigToml(home, [
        'tui.notifications = ["x"]',
        'tui.notification_method = "auto"',
        "",
        "[tui]",
        'notifications = ["y"]',
        "",
      ].join("\n"));
      const mod = await loadConfigModule();
      await mod.ensureAllCodexNotifications();
      const body = readCodexConfigToml(home);
      expect(body).toContain("[tui]");
      expect(body).toContain('notification_method = "osc9"');
      expect(body).toContain('notifications = ["y", "x", "agent-turn-complete"]');
      expect(body).not.toContain("tui.notifications");
      expect(body).not.toContain("tui.notification_method");
      expect((body.match(/\bnotifications\s*=/g) || []).length).toBe(1);
      expect((body.match(/\bnotification_method\s*=/g) || []).length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("已有 root notify：替换为 CodexFlow notify 命令并去重", async () => {
    const { home, cleanup } = createTempHome();
    try {
      writeCodexConfigToml(home, [
        'notify = ["echo", "foo"]',
        'notify = ["echo", "bar"]',
        "",
        "[tui]",
        'notifications = ["agent-turn-complete"]',
        'notification_method = "osc9"',
        "",
      ].join("\n"));
      const mod = await loadConfigModule();
      await mod.ensureAllCodexNotifications();
      const body = readCodexConfigToml(home);
      expectRootNotifyCommand(body);
      expectNotifyScriptFileName(body);
      expect(body).not.toContain('notify = ["echo", "foo"]');
      expect((body.match(/\bnotify\s*=/g) || []).length).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("Windows notify 脚本：保留 last-assistant-message 原始转义并显式标记 escaped whitespace", async () => {
    await withMockedPlatform("win32", async () => {
      const { home, cleanup } = createTempHome();
      try {
        const mod = await loadConfigModule();
        await mod.ensureAllCodexNotifications();
        const body = readCodexConfigToml(home);
        expectRootNotifyCommand(body);
        expectNotifyScriptFileName(body);
        const script = readCodexNotifyScriptByName(home, "codexflow_after_agent_notify.ps1");
        expect(script).toContain("$PreviewEscapedWhitespace = $true");
        expect(script).toContain("$RawPayload -match");
        expect(script).toContain("last-assistant-message");
        expect(script).toContain("$Preview = $Preview.Trim()");
        expect(script).not.toContain('-replace "\\s+"');
      } finally {
        cleanup();
      }
    });
  });

  it("Shell notify 脚本：使用转义安全的提取逻辑保留带引号的 JSON 字符串片段", async () => {
    await withMockedPlatform("linux", async () => {
      const { home, cleanup } = createTempHome();
      try {
        const mod = await loadConfigModule();
        await mod.ensureAllCodexNotifications();
        const script = readCodexNotifyScriptByName(home, "codexflow_after_agent_notify.sh");
        expect(script).toContain('match($0, /"last-assistant-message"[[:space:]]*:[[:space:]]*"/)');
        expect(script).toContain('out = out "\\\\" ch');
        expect(script).toContain("sed -e '1s/^[[:space:]]*//' -e '$s/[[:space:]]*$//'");
        expect(script).not.toContain("tr '\\r\\n\\t' '   '");
      } finally {
        cleanup();
      }
    });
  });
});
