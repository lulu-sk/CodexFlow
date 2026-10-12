import { describe, expect, it } from "vitest";
import { formatAsLocal, historySessionDate, historyTimelineGroupKey, toLocalDisplayTime, type HistorySession } from "./app-shared";

/** 建立旧目录里今天更新的会话，日期使用本地时间以覆盖分组边界。 */
function createResumedSession(overrides: Partial<HistorySession> = {}): HistorySession {
  return {
    providerId: "codex", id: "resumed-session", title: "已有会话", messages: [],
    date: new Date(2026, 3, 29, 10, 30).toISOString(),
    rawDate: new Date(2026, 3, 20, 8, 0).toISOString(),
    filePath: "/workspace/sessions/2026/04/20/rollout-2026-04-20T08-00-00-resumed.jsonl",
    ...overrides,
  };
}

describe("历史日期与续聊分组", () => {
  const today = new Date(2026, 3, 29, 18, 0);

  it("旧会话今天更新后，日期、显示和分组都采用更新时间", () => {
    const session = createResumedSession();
    expect(historyTimelineGroupKey(session, today)).toBe("today");
    expect(historySessionDate(session)?.toISOString()).toBe(session.date);
    expect(toLocalDisplayTime(session)).toBe("2026-04-29 10:30:00");
    expect(session.rawDate).toBe(new Date(2026, 3, 20, 8, 0).toISOString());
  });

  it.each([
    [new Date(2026, 3, 28, 23, 59), "yesterday"],
    [new Date(2026, 3, 25, 12, 0), "last7"],
    [new Date(2026, 2, 29, 12, 0), "month-2026-03"],
  ])("按更新日期 %s 归入 %s", (date, key) => {
    const session = createResumedSession({ date: date.toISOString() });
    expect(historyTimelineGroupKey(session, today)).toBe(key);
    expect(toLocalDisplayTime(session)).toBe(formatAsLocal(date));
  });

  it.each(["", "invalid-date", "0"])("更新时间 %s 不可用时回退到原始时间", (date) => {
    const session = createResumedSession({ date });
    expect(historySessionDate(session)?.toISOString()).toBe(session.rawDate);
    expect(toLocalDisplayTime(session)).toBe("2026-04-20 08:00:00");
  });

  it("只有文件名日期时继续兼容旧记录；完全无日期时归入未知", () => {
    const session = createResumedSession({ date: "", rawDate: "invalid-date" });
    expect(toLocalDisplayTime(session)).toBe("2026-04-20 08:00:00");
    expect(historyTimelineGroupKey(session, today)).toBe("month-2026-04");
    expect(historyTimelineGroupKey(createResumedSession({ date: "", rawDate: "", filePath: "session.jsonl" }), today)).toBe("unknown-date");
  });
});
