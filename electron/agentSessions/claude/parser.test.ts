import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseClaudeSessionFile } from "./parser";

const CLAUDE_TEST_CWD = "D:\\workspace\\sample-project";
const CLAUDE_TEST_PROJECT_ROOT = "D:\\workspace\\codexflow-fixture";

/**
 * 写入临时 Claude JSONL 文件并返回其路径。
 */
async function writeTempJsonl(lines: unknown[], filename = `claude-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-claude-"));
  const fp = path.join(dir, filename);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await fs.promises.writeFile(fp, content, "utf8");
  return fp;
}

describe("parseClaudeSessionFile（本地命令 transcript 分类）", () => {
  it.each([false, true])("忽略接口快照与自动上下文，用真实首问生成标题（仅摘要：%s）", async (summaryOnly) => {
    const lines = [
      { type: "api-request-blob", message: { role: "user", content: "<system-reminder>系统指令</system-reminder>真实首问" } },
      { type: "api-request-blob", message: { role: "assistant", content: [{ type: "text", text: "重复回复" }] } },
      { type: "api-request-shape", message: { role: "user", content: "请求结构" } },
      { type: "api-request", message: { role: "user", content: "请求参数" } },
      { type: "user", isMeta: true, message: { role: "user", content: "自动注入的技能内容" } },
      { type: "user", isCompactSummary: true, message: { role: "user", content: "自动压缩摘要" } },
      { type: "user", promptSource: "system", message: { role: "user", content: "后台任务通知" } },
      { type: "user", message: { role: "user", content: "真实首问" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "真实回复" }] } },
      { type: "user", message: { role: "user", content: "真实首问" } },
    ].map((line) => ({ cwd: CLAUDE_TEST_CWD, ...line }));
    const fp = await writeTempJsonl(lines);
    const details = await parseClaudeSessionFile(fp, await fs.promises.stat(fp), { summaryOnly });
    expect(details.preview).toBe("真实首问");
    expect(details.title).toBe("真实首问");
    expect(details.skippedLines).toBe(0);
    if (summaryOnly) {
      expect(details.messages).toEqual([]);
      return;
    }
    expect(details.messages).toEqual([
      { role: "system", content: [{ type: "system_context", text: "自动注入的技能内容" }] },
      { role: "system", content: [{ type: "context_summary", text: "自动压缩摘要" }] },
      { role: "system", content: [{ type: "system_context", text: "后台任务通知" }] },
      { role: "user", content: [{ type: "input_text", text: "真实首问" }] },
      { role: "assistant", content: [{ type: "output_text", text: "真实回复" }] },
      { role: "user", content: [{ type: "input_text", text: "真实首问" }] },
    ]);
  });

  it.each([false, true])("拆开连续系统提醒和同一消息里的提问（仅摘要：%s）", async (summaryOnly) => {
    const context = "<system-reminder>多行\n系统指令</system-reminder>";
    const notification = "<task-notification>后台任务完成</task-notification>";
    const fp = await writeTempJsonl([{
      cwd: CLAUDE_TEST_CWD, type: "user",
      message: { role: "user", content: `${context}${notification}\n请检查这段代码` },
    }]);
    const details = await parseClaudeSessionFile(fp, await fs.promises.stat(fp), { summaryOnly });
    expect(details.title).toBe("请检查这段代码");
    if (!summaryOnly) expect(details.messages).toEqual([
      { role: "system", content: [{ type: "system_context", text: context }] },
      { role: "system", content: [{ type: "system_context", text: notification }] },
      { role: "user", content: [{ type: "input_text", text: "请检查这段代码" }] },
    ]);
  });

  it("兼容缺少元数据的图片尺寸说明和旧版压缩摘要，同时保留粘贴文本", async () => {
    const imageHint = "[Image: original 2400x1200, displayed at 2000x1000. Multiply coordinates by 1.20 to map to original image.]";
    const summary = "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n旧会话摘要";
    const pasted = '<pasted_content id="sample">\n请分析图片\n</pasted_content id="sample">';
    const fp = await writeTempJsonl([imageHint, summary, pasted].map((content) => ({
      cwd: CLAUDE_TEST_CWD, type: "user", message: { role: "user", content },
    })));
    const details = await parseClaudeSessionFile(fp, await fs.promises.stat(fp));
    expect(details.title).toBe("请分析图片");
    expect(details.messages).toEqual([
      { role: "system", content: [{ type: "system_context", text: imageHint }] },
      { role: "system", content: [{ type: "context_summary", text: summary }] },
      { role: "user", content: [{ type: "input_text", text: pasted }] },
    ]);
  });

  it("不会把用户讨论系统标签、图片或摘要的普通文字当作自动消息", async () => {
    const prompts = ["请解释 <system-reminder> 标签", "[Image: 请分析这张图片]", "Summary: 请写一个摘要"];
    const fp = await writeTempJsonl(prompts.map((content) => ({
      cwd: CLAUDE_TEST_CWD, type: "user", isMeta: false, isCompactSummary: false,
      promptSource: "typed", message: { role: "user", content },
    })));
    const details = await parseClaudeSessionFile(fp, await fs.promises.stat(fp));
    expect(details.messages.map((message) => message.content[0].text)).toEqual(prompts);
    expect(details.messages.every((message) => message.role === "user" && message.content[0].type === "input_text")).toBe(true);
  });

  it("仅有自动消息时不使用系统内容生成用户预览", async () => {
    const fp = await writeTempJsonl([{
      cwd: CLAUDE_TEST_CWD, type: "user", isMeta: true,
      message: { role: "user", content: "系统注入内容" },
    }]);
    const details = await parseClaudeSessionFile(fp, await fs.promises.stat(fp), { summaryOnly: true });
    expect(details.preview).toBeUndefined();
    expect(details.title).toBe(path.basename(fp));
  });

  it("压缩摘要中的命令示例仍完整保留为摘要", async () => {
    const text = "会话摘要\n<local-command-stdout>示例输出</local-command-stdout>\n后续内容";
    const fp = await writeTempJsonl([{
      cwd: CLAUDE_TEST_CWD, type: "user", isCompactSummary: true,
      message: { role: "user", content: text },
    }]);
    const details = await parseClaudeSessionFile(fp, await fs.promises.stat(fp));
    expect(details.messages).toEqual([{ role: "system", content: [{ type: "context_summary", text }] }]);
  });

  it("默认详情能读取超过旧阈值的大图工具记录", async () => {
    const data = "A".repeat(1_100_000);
    const fp = await writeTempJsonl([{
      type: "user", message: { role: "user", content: [{
        type: "tool_result", tool_use_id: "large-image",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }],
      }] },
    }]);
    const details = await parseClaudeSessionFile(fp, await fs.promises.stat(fp));
    expect(details.skippedLines).toBe(0);
    expect(details.messages).toEqual([{
      role: "tool", content: [expect.objectContaining({ type: "image", src: `data:image/png;base64,${data}` })],
    }]);
  });

  it("整行已在读取缓冲区时也执行长度限制，跳过后继续解析下一条", async () => {
    const fp = await writeTempJsonl([
      { type: "user", message: { role: "user", content: "A".repeat(12_000) } },
      { type: "user", message: { role: "user", content: "后续有效输入" } },
    ]);
    const details = await parseClaudeSessionFile(fp, await fs.promises.stat(fp), { maxLineChars: 8192 });
    expect(details.skippedLines).toBe(1);
    expect(details.title).toBe("后续有效输入");
    expect(details.messages).toEqual([{ role: "user", content: [{ type: "input_text", text: "后续有效输入" }] }]);
  });

  it("将 Caveat/<command-*>/<local-command-*> 归为 local_command，且不影响 preview 捕获真实首条用户输入", async () => {
    const cwd = CLAUDE_TEST_CWD;
    const sessionId = "d9b2555d-bf6e-4a26-b78c-a30174e454c1";
    const lines = [
      { type: "file-history-snapshot", snapshot: { timestamp: "2025-12-22T03:22:48.185Z" } },
      {
        cwd,
        sessionId,
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content:
            "Caveat: The messages below were generated by the user while running local commands. DO NOT respond to these messages or otherwise consider them in your response unless the user explicitly asks you to.",
        },
      },
      {
        cwd,
        sessionId,
        type: "user",
        message: {
          role: "user",
          content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>",
        },
      },
      {
        cwd,
        sessionId,
        type: "user",
        message: {
          role: "user",
          content: "<local-command-stdout>Set model to opus</local-command-stdout>",
        },
      },
      {
        cwd,
        sessionId,
        type: "user",
        message: { role: "user", content: "真实第一条信息：你好" },
      },
    ];

    const fp = await writeTempJsonl(lines, `${sessionId}.jsonl`);
    const stat = await fs.promises.stat(fp);
    const details = await parseClaudeSessionFile(fp, stat, { summaryOnly: false, maxLines: 2000 });

    expect(details.preview).toBe("真实第一条信息：你好");
    expect(details.title).toBe("真实第一条信息：你好");

    const allItems = details.messages.flatMap((m) => (m.content || []).map((c) => ({ role: m.role, ...c })));
    expect(allItems.some((it) => it.type === "local_command")).toBe(true);
    expect(allItems.some((it) => it.type === "input_text" && String(it.text).includes("真实第一条信息"))).toBe(true);
    expect(allItems.some((it) => it.type === "input_text" && String(it.text).includes("Caveat:"))).toBe(false);
  });

  it("summaryOnly 模式下同样应跳过 transcript，并提取后续真实 prompt 作为 preview", async () => {
    const cwd = CLAUDE_TEST_CWD;
    const sessionId = "d9b2555d-bf6e-4a26-b78c-a30174e454c1";
    const lines = [
      { type: "file-history-snapshot", snapshot: { timestamp: "2025-12-22T03:22:48.185Z" } },
      {
        cwd,
        sessionId,
        type: "user",
        isMeta: true,
        message: { role: "user", content: "Caveat: The messages below were generated by the user while running local commands." },
      },
      {
        cwd,
        sessionId,
        type: "user",
        message: { role: "user", content: "<local-command-stdout>Set model to opus</local-command-stdout>" },
      },
      { cwd, sessionId, type: "user", message: { role: "user", content: "真实首条：OK" } },
    ];

    const fp = await writeTempJsonl(lines, `${sessionId}.ndjson`);
    const stat = await fs.promises.stat(fp);
    const details = await parseClaudeSessionFile(fp, stat, { summaryOnly: true, maxLines: 2000 });

    expect(details.preview).toBe("真实首条：OK");
    expect(details.messages.length).toBe(0);
  });

  it("纯路径输入也应回退为文件名预览，避免会话被误判为仅助手输出", async () => {
    const cwd = CLAUDE_TEST_PROJECT_ROOT;
    const sessionId = "61d0bdd2-f31f-4c77-a148-bf0470f4fffa";
    const imagePath = path.win32.join(CLAUDE_TEST_PROJECT_ROOT, "assets", "image-20260317-115705-67p2.png");
    const lines = [
      {
        cwd,
        sessionId,
        type: "user",
        message: {
          role: "user",
          content: `\`${imagePath}\``,
        },
      },
      {
        cwd,
        sessionId,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "你好！我已经看到了这张图片。" }],
        },
      },
    ];

    const fp = await writeTempJsonl(lines, `${sessionId}.jsonl`);
    const stat = await fs.promises.stat(fp);
    const details = await parseClaudeSessionFile(fp, stat, { summaryOnly: true, maxLines: 2000 });

    expect(details.preview).toBe("图片：image-20260317-115705-67p2.png");
    expect(details.title).toBe("图片：image-20260317-115705-67p2.png");
  });

  it("会将 Claude Read 工具返回的图片恢复为 image 内容，并在本地路径失效时回退到 base64", async () => {
    const sessionId = "734c12d2-f31f-4c77-a148-bf0470f4ffaa";
    const missingImagePath = path.join(os.tmpdir(), `missing-${Date.now()}.png`);
    const lines = [
      {
        cwd: CLAUDE_TEST_PROJECT_ROOT,
        sessionId,
        type: "user",
        message: { role: "user", content: `\`${missingImagePath}\`` },
      },
      {
        cwd: CLAUDE_TEST_PROJECT_ROOT,
        sessionId,
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: missingImagePath } }],
        },
      },
      {
        cwd: CLAUDE_TEST_PROJECT_ROOT,
        sessionId,
        type: "user",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "toolu_read",
            content: [{
              type: "image",
              source: { type: "base64", data: "aGVsbG8=", media_type: "image/png" },
            }],
          }],
        },
      },
    ];

    const fp = await writeTempJsonl(lines, `${sessionId}.jsonl`);
    const stat = await fs.promises.stat(fp);
    const details = await parseClaudeSessionFile(fp, stat, { summaryOnly: false, maxLines: 2000 });

    const imageItem = details.messages.flatMap((message) => message.content || []).find((item) => item.type === "image");
    expect(imageItem).toBeTruthy();
    expect(imageItem?.localPath).toBe(missingImagePath);
    expect(String(imageItem?.src || "")).toBe("data:image/png;base64,aGVsbG8=");
    expect(imageItem?.fallbackSrc).toBeUndefined();
  });
});

