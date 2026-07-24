import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseGrokSessionFile } from "./parser";

const tempDirs: string[] = [];

/**
 * 创建最小 Grok 会话目录，并返回 summary.json 路径。
 */
async function createGrokSession(summary: unknown, updates: unknown[]): Promise<string> {
  return createGrokSessionFromEnvelopes(summary, updates.map(createAcpEnvelope));
}

/**
 * 构造官方现代 ACP session/update 封装。
 */
function createAcpEnvelope(update: unknown): unknown {
  return { method: "session/update", params: { sessionId: "session-test", update } };
}

/**
 * 构造官方 xAI 扩展 session/update 封装。
 */
function createXaiEnvelope(update: unknown): unknown {
  return { method: "_x.ai/session/update", params: { sessionId: "session-test", update } };
}

/**
 * 使用指定 JSONL 封装创建最小 Grok 会话目录。
 */
async function createGrokSessionFromEnvelopes(summary: unknown, envelopes: unknown[]): Promise<string> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-grok-parser-"));
  tempDirs.push(root);
  const sessionDir = path.join(root, "project", "session-test");
  await fs.promises.mkdir(sessionDir, { recursive: true });
  const summaryPath = path.join(sessionDir, "summary.json");
  await fs.promises.writeFile(summaryPath, JSON.stringify(summary), "utf8");
  await fs.promises.writeFile(
    path.join(sessionDir, "updates.jsonl"),
    envelopes.map((envelope) => JSON.stringify(envelope)).join("\n") + "\n",
    "utf8",
  );
  return summaryPath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("parseGrokSessionFile", () => {
  it("摘要优先使用 last_active_at，并跳过隐藏的首条用户消息", async () => {
    const summaryPath = await createGrokSession(
      {
        info: { id: "session-test", cwd: "/workspace/project" },
        created_at: "2026-07-01T08:00:00.000Z",
        updated_at: "2026-07-01T09:00:00.000Z",
        last_active_at: "2026-07-01T10:00:00.000Z",
      },
      [
        {
          sessionUpdate: "user_message_chunk",
          content: { text: "内部上下文", _meta: { hideFromScrollback: true } },
        },
        { sessionUpdate: "user_message_chunk", content: { text: "真实问题" } },
      ],
    );
    const stat = await fs.promises.stat(summaryPath);

    const details = await parseGrokSessionFile(summaryPath, stat, { summaryOnly: true });

    expect(details.providerId).toBe("grok");
    expect(details.resumeId).toBe("session-test");
    expect(details.preview).toBe("真实问题");
    expect(details.title).toBe("真实问题");
    expect(details.rawDate).toBe("2026-07-01T10:00:00.000Z");
    expect(details.date).toBe(Date.parse("2026-07-01T10:00:00.000Z"));
    expect(details.dirKey).toBe("/workspace/project");
    expect(details.messages).toHaveLength(0);
  });

  it("详情模式合并连续流式文本，并保留思考、工具与用量消息", async () => {
    const summaryPath = await createGrokSession(
      {
        info: { id: "session-detail", cwd: "/workspace/project" },
        generated_title: "详情会话",
        last_active_at: "2026-07-02T10:00:00.000Z",
        current_model_id: "grok-code-test",
      },
      [
        { sessionUpdate: "user_message_chunk", content: { text: "请" } },
        { sessionUpdate: "user_message_chunk", content: { text: "处理" } },
        { sessionUpdate: "agent_thought_chunk", content: { text: "分析中" } },
        { sessionUpdate: "agent_message_chunk", content: { text: "已完成" } },
        { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Read", status: "completed" },
        { sessionUpdate: "turn_completed", stopReason: "end_turn", usage: { inputTokens: 10 } },
      ],
    );
    const stat = await fs.promises.stat(summaryPath);

    const details = await parseGrokSessionFile(summaryPath, stat, { summaryOnly: false });

    expect(details.title).toBe("详情会话");
    expect(details.preview).toBe("请处理");
    expect(details.messages[0]).toMatchObject({ role: "meta" });
    expect(details.messages[1]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "请处理", tags: ["grok.user_message"] }],
    });
    expect(details.messages.map((message) => message.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "assistant",
      "assistant",
      "state",
    ]);
    expect(details.messages[2].content[0]).toMatchObject({ type: "reasoning", text: "分析中" });
    expect(details.messages[4].content[0]).toMatchObject({ type: "tool_call" });
    expect(JSON.parse(details.messages[5].content[0].text)).toMatchObject({
      stopReason: "end_turn",
      usage: { inputTokens: 10 },
    });
  });

  it("现代封装与旧版顶层 update 产生相同历史", async () => {
    const summary = { info: { id: "session-format" } };
    const update = {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "兼容旧版历史" },
    };
    const modernPath = await createGrokSession(summary, [update]);
    const legacyPath = await createGrokSessionFromEnvelopes(summary, [
      { sessionId: "session-test", update },
    ]);
    const [modernStat, legacyStat] = await Promise.all([
      fs.promises.stat(modernPath),
      fs.promises.stat(legacyPath),
    ]);

    const [modern, legacy] = await Promise.all([
      parseGrokSessionFile(modernPath, modernStat, { summaryOnly: false }),
      parseGrokSessionFile(legacyPath, legacyStat, { summaryOnly: false }),
    ]);

    expect(legacy.preview).toBe("兼容旧版历史");
    expect(legacy.messages).toEqual(modern.messages);
  });

  it("回退到指定提示词时移除死分支与回退标记", async () => {
    const summaryPath = await createGrokSessionFromEnvelopes(
      { info: { id: "session-rewind" } },
      [
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "第一问" } }),
        createAcpEnvelope({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一答" } }),
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "废弃问题" } }),
        createAcpEnvelope({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "废弃回答" } }),
        createXaiEnvelope({ sessionUpdate: "rewind_marker", target_prompt_index: 1 }),
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "替代问题" } }),
        createAcpEnvelope({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "替代回答" } }),
      ],
    );
    const stat = await fs.promises.stat(summaryPath);

    const details = await parseGrokSessionFile(summaryPath, stat, { summaryOnly: false });
    const transcript = details.messages.flatMap((message) => message.content).map((content) => content.text).join("\n");

    expect(transcript).toContain("第一问");
    expect(transcript).toContain("第一答");
    expect(transcript).toContain("替代问题");
    expect(transcript).toContain("替代回答");
    expect(transcript).not.toContain("废弃问题");
    expect(transcript).not.toContain("废弃回答");
    expect(transcript).not.toContain("rewind_marker");
  });

  it("摘要模式读到回退至零后使用新分支首条提示词", async () => {
    const summaryPath = await createGrokSessionFromEnvelopes(
      { info: { id: "session-rewind-zero" } },
      [
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "已撤销提示词" } }),
        createAcpEnvelope({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已撤销回答" } }),
        createXaiEnvelope({ sessionUpdate: "rewind_marker", target_prompt_index: 0 }),
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "全新提示词" } }),
      ],
    );
    const stat = await fs.promises.stat(summaryPath);

    const details = await parseGrokSessionFile(summaryPath, stat, { summaryOnly: true });

    expect(details.preview).toBe("全新提示词");
    expect(details.title).toBe("全新提示词");
  });

  it("连续回退始终只保留最终有效分支", async () => {
    const summaryPath = await createGrokSessionFromEnvelopes(
      { info: { id: "session-double-rewind" } },
      [
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "保留问题" } }),
        createAcpEnvelope({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "保留回答" } }),
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "第二问题" } }),
        createAcpEnvelope({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第二回答" } }),
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "第三问题" } }),
        createXaiEnvelope({ sessionUpdate: "rewind_marker", target_prompt_index: 2 }),
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "第一替代" } }),
        createAcpEnvelope({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一替代回答" } }),
        createXaiEnvelope({ sessionUpdate: "rewind_marker", target_prompt_index: 1 }),
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "最终问题" } }),
      ],
    );
    const stat = await fs.promises.stat(summaryPath);

    const details = await parseGrokSessionFile(summaryPath, stat, { summaryOnly: false });
    const transcript = details.messages.flatMap((message) => message.content).map((content) => content.text).join("\n");

    expect(transcript).toContain("保留问题");
    expect(transcript).toContain("保留回答");
    expect(transcript).toContain("最终问题");
    expect(transcript).not.toContain("第二问题");
    expect(transcript).not.toContain("第三问题");
    expect(transcript).not.toContain("第一替代");
  });

  it("promptIndex 出现后不把无标记的中间用户块计为回退边界", async () => {
    const summaryPath = await createGrokSessionFromEnvelopes(
      { info: { id: "session-prompt-index" } },
      [
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "P0" }, _meta: { promptIndex: 0 } }),
        createAcpEnvelope({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A0" } }),
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "!pwd" } }),
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "P1" }, _meta: { promptIndex: 1 } }),
        createAcpEnvelope({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "A1" } }),
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "P2" }, _meta: { promptIndex: 2 } }),
        createXaiEnvelope({ sessionUpdate: "rewind_marker", target_prompt_index: 2 }),
        createAcpEnvelope({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "替代 P2" }, _meta: { promptIndex: 2 } }),
      ],
    );
    const stat = await fs.promises.stat(summaryPath);

    const details = await parseGrokSessionFile(summaryPath, stat, { summaryOnly: false });
    const transcript = details.messages.flatMap((message) => message.content).map((content) => content.text).join("\n");

    expect(transcript).toContain("!pwd");
    expect(transcript).toContain("P1");
    expect(transcript).toContain("替代 P2");
    expect(transcript).not.toMatch(/(?:^|\n)P2(?:\n|$)/);
  });

  it("连续取消的提示词按 promptIndex 保持为独立用户消息", async () => {
    const summaryPath = await createGrokSession(
      { info: { id: "session-cancelled-prompts" } },
      [
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "P0" }, _meta: { promptIndex: 0 } },
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "P1" }, _meta: { promptIndex: 1 } },
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "P2" }, _meta: { promptIndex: 2 } },
      ],
    );
    const stat = await fs.promises.stat(summaryPath);

    const details = await parseGrokSessionFile(summaryPath, stat, { summaryOnly: false });

    expect(details.preview).toBe("P0");
    expect(details.messages.filter((message) => message.role === "user")).toEqual([
      { role: "user", content: [{ type: "input_text", text: "P0", tags: ["grok.user_message"] }] },
      { role: "user", content: [{ type: "input_text", text: "P1", tags: ["grok.user_message"] }] },
      { role: "user", content: [{ type: "input_text", text: "P2", tags: ["grok.user_message"] }] },
    ]);
  });

  it("宿主内部轮次不进入摘要或可见历史", async () => {
    const summaryPath = await createGrokSession(
      { info: { id: "session-host-turn" } },
      [
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "/workflows" }, _meta: { hostTurn: true } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "宿主内部输出" }, _meta: { hostTurn: true } },
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "真实问题" }, _meta: { promptIndex: 0 } },
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "真实回答" } },
      ],
    );
    const stat = await fs.promises.stat(summaryPath);

    const details = await parseGrokSessionFile(summaryPath, stat, { summaryOnly: false });
    const transcript = details.messages.flatMap((message) => message.content).map((content) => content.text).join("\n");

    expect(details.preview).toBe("真实问题");
    expect(transcript).toContain("真实问题");
    expect(transcript).toContain("真实回答");
    expect(transcript).not.toContain("/workflows");
    expect(transcript).not.toContain("宿主内部输出");
  });

  it("恢复 image_url Data URL，并与同一用户文本合并", async () => {
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const summaryPath = await createGrokSession(
      { info: { id: "session-image-url" } },
      [
        { sessionUpdate: "user_message_chunk", content: { type: "text", text: "请查看图片" } },
        { sessionUpdate: "user_message_chunk", content: { type: "image_url", url: dataUrl } },
      ],
    );
    const stat = await fs.promises.stat(summaryPath);

    const details = await parseGrokSessionFile(summaryPath, stat, { summaryOnly: false });
    const userMessage = details.messages.find((message) => message.role === "user");

    expect(details.preview).toBe("请查看图片");
    expect(userMessage?.content).toHaveLength(2);
    expect(userMessage?.content[1]).toMatchObject({
      type: "image",
      src: dataUrl,
      mimeType: "image/png",
      tags: ["grok.user_message", "grok.image"],
    });
  });

  it("恢复当前 ACP image 的 data、mimeType 与 uri 形态", async () => {
    const summaryPath = await createGrokSession(
      { info: { id: "session-image" }, generated_title: "图片会话" },
      [
        {
          sessionUpdate: "user_message_chunk",
          content: {
            type: "image",
            data: "aGVsbG8=",
            mimeType: "image/jpeg",
            uri: "file:///tmp/missing-grok-history-image.jpg",
          },
        },
      ],
    );
    const stat = await fs.promises.stat(summaryPath);

    const details = await parseGrokSessionFile(summaryPath, stat, { summaryOnly: false });
    const image = details.messages.find((message) => message.role === "user")?.content[0];

    expect(details.preview).toBeUndefined();
    expect(image).toMatchObject({
      type: "image",
      src: "data:image/jpeg;base64,aGVsbG8=",
      mimeType: "image/jpeg",
    });
    expect(image?.text).not.toContain("aGVsbG8=");
  });
});
