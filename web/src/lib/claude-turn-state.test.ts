import { describe, expect, it } from "vitest";
import { inspectClaudeTurnState, readClaudeTurnPhase } from "./claude-turn-state";

const IDLE = "任务完成。\n────────────────\n❯ \n────────────────\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
const WORKING = `${IDLE} · esc to interrupt`;

describe("Claude 运行状态与停止候选确认", () => {
  it("输入框仍可见时，运行页脚能识别普通任务和 goal 续跑", () => {
    expect(readClaudeTurnPhase(WORKING)).toBe("working");
    expect(readClaudeTurnPhase(`Goal not yet met… continuing\n${WORKING}`)).toBe("working");
    expect(readClaudeTurnPhase(`* Noodling… (45m 50s · ↓ 210.0k tokens)\n◎ /goal active (45m)\n${IDLE}`)).toBe("working");
  });

  it("正文和历史里的运行字样不影响当前空闲页脚", () => {
    expect(readClaudeTurnPhase(`说明 esc to interrupt 的用法\n${IDLE}`)).toBe("idle");
    expect(readClaudeTurnPhase(`❯ 旧问题\n${WORKING}\n\n${IDLE}`)).toBe("idle");
    expect(readClaudeTurnPhase(IDLE.replace("❯", ">"))).toBe("idle");
  });

  it("Stop 到达时仍在执行，不能完成；真正空闲后才确认", () => {
    const busy = inspectClaudeTurnState({}, WORKING, true, false, 0);
    expect(busy).toEqual({ probe: {}, working: true, completed: false });
    const first = inspectClaudeTurnState(busy.probe, IDLE, true, false, 1000);
    expect(first.completed).toBe(false);
    expect(inspectClaudeTurnState(first.probe, IDLE, true, false, 3499).completed).toBe(false);
    expect(inspectClaudeTurnState(first.probe, IDLE, true, false, 3500).completed).toBe(true);
  });

  it("goal 检查和自动继续会重置空闲确认，不把中间停顿当成完成", () => {
    const idle = inspectClaudeTurnState({}, IDLE, true, false, 1000);
    const busy = inspectClaudeTurnState(idle.probe, WORKING, true, false, 2000);
    expect(busy.completed).toBe(false);
    const next = inspectClaudeTurnState(busy.probe, IDLE, true, false, 4000);
    expect(next.completed).toBe(false);
    expect(inspectClaudeTurnState(next.probe, IDLE, true, false, 6500).completed).toBe(true);
  });

  it("无 Stop、输出未解析、调整窗口大小或画面缺失均不能确认完成", () => {
    const idle = inspectClaudeTurnState({}, IDLE, true, false, 1000);
    for (const [screen, candidate, blocked] of [[IDLE, false, false], [IDLE, true, true], ["", true, false], ["❯ \n", true, false]] as const) {
      const result = inspectClaudeTurnState(idle.probe, screen, candidate, blocked, 5000);
      expect(result.completed).toBe(false);
      expect(result.probe.idleSince).toBeUndefined();
    }
    expect(inspectClaudeTurnState({}, WORKING, true, true).working).toBe(false);
  });

  it("权限选择等对话框不是空闲完成画面", () => {
    const dialog = "❯ \nDo you want to proceed?\n❯ 1. Yes\n2. No\nesc to cancel";
    expect(readClaudeTurnPhase(dialog)).toBe("unknown");
    expect(readClaudeTurnPhase(`${dialog}\n⏵⏵ bypass permissions on (shift+tab to cycle)`)).toBe("unknown");
    const longFooter = `${IDLE}\n${"选项\n".repeat(7)}`;
    expect(readClaudeTurnPhase(longFooter)).toBe("unknown");
  });
});
