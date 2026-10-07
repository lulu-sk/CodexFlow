import { describe, expect, it } from "vitest";
import { createCodexTurnCompletionProbe, inspectCodexTurnCompletion, observeCodexTurnCompletionBoundary } from "./codex-turn-completion";

const PROMPT = "检查当前问题";
const COMPOSER = "› Ask Codex to do anything\nGPT-6 · Context 35% left · Fast off";

/** 构造去标识化的本轮完成画面。 */
function completionScreen(marker = "Worked for 11m 12s · 02:48", reply = "• 已完成检查。", footer = ""): string {
  return `› ${PROMPT}\n${reply}\n${marker}\n\n${COMPOSER}\n${footer}`;
}

/** 连续检查两次，模拟每秒读取稳定的终端屏幕。 */
function confirmScreen(screen: string, baseline = "", prompt = PROMPT): boolean {
  const first = inspectCodexTurnCompletion(createCodexTurnCompletionProbe(baseline), screen, prompt, false, 1000);
  expect(first.completed).toBe(false);
  return inspectCodexTurnCompletion(first.probe, screen, prompt, false, 2000).completed;
}

describe("Codex 完成画面计时兜底", () => {
  it("提示词被折行或省略时，实际活动栏到稳定完成画面的变化仍可结束", () => {
    const active = `› [Pasted Content 2048 chars]\n• Working (1s • esc to interrupt)\n${COMPOSER}`;
    const observed = inspectCodexTurnCompletion(createCodexTurnCompletionProbe(""), active, PROMPT, false, 0);
    expect(observed.probe.activityObserved).toBe(true);
    const finished = `• 已完成检查。\nWorked for 17m 19s • 02:58\n${COMPOSER}`;
    const first = inspectCodexTurnCompletion(observed.probe, finished, PROMPT, false, 1000);
    expect(first.completed).toBe(false);
    expect(inspectCodexTurnCompletion(first.probe, finished, PROMPT, false, 2000).completed).toBe(true);
    expect(confirmScreen(finished)).toBe(false);
  });

  it("本轮确实运行过时，相同时长和分钟的完成标记也能结束下一轮", () => {
    const screen = `• 已完成检查。\nWorked for 12s • 02:58\n${COMPOSER}`;
    const observed = inspectCodexTurnCompletion(createCodexTurnCompletionProbe(screen), `• Working (1s • esc to interrupt)\n${COMPOSER}`, "", false, 0);
    const first = inspectCodexTurnCompletion(observed.probe, screen, "", false, 1000);
    expect(inspectCodexTurnCompletion(first.probe, screen, "", false, 2000).completed).toBe(true);
  });

  it("历史、回放以及正文里的运行字样不能建立本轮活动证据", () => {
    const active = `• Working (1s • esc to interrupt)\n${COMPOSER}`;
    for (const [screen, blocked] of [[active, true], [`${active}\nenter/esc latest`, false], [`› ${PROMPT}\n说明 Working (1s • esc to interrupt) 的含义\n${COMPOSER}`, false]] as const)
      expect(inspectCodexTurnCompletion(createCodexTurnCompletionProbe(""), screen, "", blocked).probe.activityObserved).not.toBe(true);
  });

  it("已观察到活动也不能放行输入前的旧标记、重连或历史画面", () => {
    const observed = inspectCodexTurnCompletion(createCodexTurnCompletionProbe(""), `• Working (1s • esc to interrupt)\n${COMPOSER}`, PROMPT, false, 0);
    for (const screen of [
      `─ Worked for 12s ─\n• 旧回复。\n› ${PROMPT}\n${COMPOSER}`,
      `${completionScreen()}\nenter/esc latest`,
      `${completionScreen()}\nReconnecting... 1/5`,
    ]) {
      const first = inspectCodexTurnCompletion(observed.probe, screen, PROMPT, false, 1000);
      expect(inspectCodexTurnCompletion(first.probe, screen, PROMPT, false, 2000).completed).toBe(false);
    }
  });

  it("长任务输入滚出读取范围后，保留的本轮边界仍能确认完成", () => {
    const active = `› ${PROMPT}\n• Working (1s • esc to interrupt)\n${COMPOSER}`;
    const observed = inspectCodexTurnCompletion(createCodexTurnCompletionProbe(""), active, PROMPT, false, 0);
    const screen = `• 已完成检查。\nWorked for 35m 31s • 23:48\n${COMPOSER}\n⚠ 1 warning · f2 to view`;
    const first = inspectCodexTurnCompletion(observed.probe, screen, PROMPT, false, 1000);
    expect(first.completed).toBe(false);
    expect(inspectCodexTurnCompletion(first.probe, screen, PROMPT, false, 2000).completed).toBe(true);
    expect(confirmScreen(screen)).toBe(false);
  });

  it("已保留的输入边界不能放行发送前画面、其他提示词或位于输入前的旧标记", () => {
    const baseline = completionScreen();
    const probe = observeCodexTurnCompletionBoundary(createCodexTurnCompletionProbe(baseline), `› ${PROMPT}`, PROMPT, false);
    expect(inspectCodexTurnCompletion(probe, baseline, PROMPT, false).completed).toBe(false);
    const screen = `Worked for 12s\n${COMPOSER}`;
    const first = inspectCodexTurnCompletion(probe, screen, "其他问题", false, 1000);
    expect(inspectCodexTurnCompletion(first.probe, screen, "其他问题", false, 2000).completed).toBe(false);
    const oldMarker = `─ Worked for 12s ─\n• 旧回复。\n› ${PROMPT}\n${COMPOSER}`;
    expect(inspectCodexTurnCompletion(probe, oldMarker, PROMPT, false).probe.candidate).toBeUndefined();
  });

  it("回放不能建立输入证据；保留边界后，浏览历史和重连也不能确认完成", () => {
    const probe = createCodexTurnCompletionProbe("");
    expect(observeCodexTurnCompletionBoundary(probe, `› ${PROMPT}`, PROMPT, true).boundaryPrompt).toBeUndefined();
    expect(observeCodexTurnCompletionBoundary(probe, `› ${PROMPT}\nenter/esc latest`, PROMPT, false).boundaryPrompt).toBeUndefined();
    const observed = observeCodexTurnCompletionBoundary(probe, `› ${PROMPT}`, PROMPT, false);
    for (const suffix of ["enter/esc latest", "Reconnecting... 1/5", "Pursuing goal (1s)"]) {
      const screen = `Worked for 12s\n${COMPOSER}\n${suffix}`;
      const first = inspectCodexTurnCompletion(observed, screen, PROMPT, false, 1000);
      expect(inspectCodexTurnCompletion(first.probe, screen, PROMPT, false, 2000).completed).toBe(false);
    }
  });

  it("新版浏览历史时旧完成标记不结束本轮计时，返回最新后仍可结束", () => {
    const screen = completionScreen();
    expect(confirmScreen(`${screen}\nenter/esc latest`)).toBe(false);
    expect(confirmScreen(screen)).toBe(true);
  });

  it.each([
    "Worked for 11m 12s · 02:48",
    "Worked for <1s • 2:48 AM",
    "Worked for 1s • Oct 1 at 2:48 PM",
    "Worked for 1h 0m 5s • Oct 1, 2025 at 2:48 PM • Local tools: 2 calls (1s)",
    "Worked for 12s",
  ])("新版无横线完成分隔行：%s", (marker) => {
    expect(confirmScreen(completionScreen(marker))).toBe(true);
  });

  it("旧版横线分隔行位于最终回复之前时也能确认完成", () => {
    const screen = `› ${PROMPT}\n─ Worked for 2m 16s ─\n• 已完成检查。\n\n${COMPOSER}`;
    expect(confirmScreen(screen)).toBe(true);
  });

  it("带后台终端栏和普通 warning 页脚的完成画面仍可结束计时", () => {
    const screen = `› ${PROMPT}\n• 已完成检查。\nWorked for 12s • 02:48\n1 background terminal running · /ps to view · /stop to close\n${COMPOSER}\n⚠ 1 warning · f2 to view`;
    expect(confirmScreen(screen)).toBe(true);
  });

  it("没有明确完成标记时，可输入框不能结束计时", () => {
    expect(confirmScreen(`› ${PROMPT}\n• 还在处理。\n${COMPOSER}`)).toBe(false);
  });

  it("发送前已经存在的完成画面不能结束新轮次，包括重复提示词", () => {
    const oldScreen = completionScreen();
    expect(confirmScreen(oldScreen, oldScreen)).toBe(false);
    expect(confirmScreen(`› 上一轮问题\n• 已完成。\nWorked for 12s\n${COMPOSER}`)).toBe(false);
  });

  it("本轮输入在旧完成标记之后时不应结束", () => {
    const screen = `─ Worked for 12s ─\n• 旧回复。\n› ${PROMPT}\n${COMPOSER}`;
    expect(confirmScreen(screen)).toBe(false);
  });

  it.each([
    "• Working (12s • esc to interrupt)",
    "• Thinking (12s • esc to interrupt)",
    "Reconnecting... 1/5",
    "Pursuing goal (12s)",
    "Goal unmet (12s)",
    "Goal abandoned",
  ])("完成标记后仍有活动状态时不能结束：%s", (status) => {
    expect(confirmScreen(completionScreen("─ Worked for 12s ─", "• 回复。", status))).toBe(false);
  });

  it("新版完成标记后又有输出时，不能把旧时长当成本轮结束", () => {
    const screen = `› ${PROMPT}\nWorked for 12s\n• 正在执行工具。\n${COMPOSER}`;
    expect(confirmScreen(screen)).toBe(false);
  });

  it("失败画面不能被兜底标成完成", () => {
    const screen = `› ${PROMPT}\n─ Worked for 12s ─\n■ Conversation interrupted\n${COMPOSER}`;
    expect(confirmScreen(screen)).toBe(false);
  });

  it("输出未解析完、同步帧未结束、历史或缩放回放期间清除候选", () => {
    const screen = completionScreen();
    const first = inspectCodexTurnCompletion(createCodexTurnCompletionProbe(""), screen, PROMPT, false);
    const blocked = inspectCodexTurnCompletion(first.probe, screen, PROMPT, true);
    expect(blocked.completed).toBe(false);
    expect(inspectCodexTurnCompletion(blocked.probe, screen, PROMPT, false).completed).toBe(false);
  });

  it("候选画面改变后需要重新等待稳定", () => {
    const first = inspectCodexTurnCompletion(createCodexTurnCompletionProbe(""), completionScreen(), PROMPT, false);
    const changed = inspectCodexTurnCompletion(first.probe, completionScreen("Worked for 12m 0s · 02:49"), PROMPT, false);
    expect(changed.completed).toBe(false);
  });

  it("快速重复渲染不能代替屏幕稳定等待", () => {
    const screen = completionScreen();
    const first = inspectCodexTurnCompletion(createCodexTurnCompletionProbe(""), screen, PROMPT, false, 1000);
    const immediate = inspectCodexTurnCompletion(first.probe, screen, PROMPT, false, 1001);
    expect(immediate.completed).toBe(false);
    expect(inspectCodexTurnCompletion(immediate.probe, screen, PROMPT, false, 2000).completed).toBe(true);
  });

  it("未掌握本轮提示词时保持保守行为", () => {
    expect(confirmScreen(completionScreen(), "", "")).toBe(false);
  });
});
