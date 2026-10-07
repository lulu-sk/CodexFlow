import { describe, expect, it } from "vitest";
import { isCodexHistoryBrowsingScreen, isCodexOwnedTranscriptScreen } from "./codex-tui-screen";

const COMPOSER = "› Ask Codex to do anything\nGPT-6 · Context 35% left";

describe("新版 Codex 历史界面识别", () => {
  it.each([
    "esc latest",
    "enter/esc latest",
    "New activity · esc latest",
    "↑ Loading earlier messages… · enter/esc latest",
    "↑ Loading… · esc latest",
    "Retry history: ⌥</⌃home.  esc latest",
    "⌃c copy · enter copy & follow · esc clear",
    "Find: 查找旧消息\nNo matches · full transcript · esc close",
    "Find: \nType to find · esc close",
  ])("输入框下面的导航提示可识别：%s", (footer) => {
    expect(isCodexHistoryBrowsingScreen(`■ 旧错误\n${COMPOSER}\n${footer}`)).toBe(true);
  });

  it.each([
    "↓ Back to bottom · esc", "↓ Back to bottom", "↓ Bottom · esc",
    "New activity · ↓ Bottom", "New · ↓ Bottom", "↓",
  ])("输入框上面的返回底部提示可识别：%s", (control) => {
    expect(isCodexHistoryBrowsingScreen(`■ 旧错误\n${control}\n${COMPOSER}`)).toBe(true);
  });

  it("正文中的旧导航文字不会污染恢复后的最新画面", () => {
    const screen = `› 旧问题\nesc latest\n› 新问题\n■ 当前错误\n${COMPOSER}\n⚠ 1 warning · f2 to view`;
    expect(isCodexHistoryBrowsingScreen(screen)).toBe(false);
  });

  it("输入框草稿仍能识别历史浏览，普通页脚不算历史", () => {
    expect(isCodexHistoryBrowsingScreen("■ 旧错误\n› 尚未发送的草稿\nesc latest")).toBe(true);
    expect(isCodexHistoryBrowsingScreen(`${COMPOSER}\n? for shortcuts`)).toBe(false);
    expect(isCodexHistoryBrowsingScreen("普通输出：esc latest")).toBe(false);
  });

  it("按实际模式识别自管历史，并排除普通缓冲区和没有输入框的弹窗", () => {
    expect(isCodexOwnedTranscriptScreen("alternate", "any", COMPOSER)).toBe(true);
    expect(isCodexOwnedTranscriptScreen("alternate", "drag", "› 尚未发送的草稿", "› 尚未发送的草稿")).toBe(true);
    expect(isCodexOwnedTranscriptScreen("normal", "any", COMPOSER)).toBe(false);
    expect(isCodexOwnedTranscriptScreen("alternate", "none", COMPOSER)).toBe(false);
    expect(isCodexOwnedTranscriptScreen("alternate", "any", "Select a model\nGPT-6")).toBe(false);
    expect(isCodexOwnedTranscriptScreen("alternate", "any", "› 历史用户输入\nSelect a model\nGPT-6", "GPT-6")).toBe(false);
  });
});
