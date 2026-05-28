import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseGeminiSessionFile } from "./parser";

const GEMINI_PREVIEW_TEST_PATH = "/mnt/c/codexflow-fixture/assets/CodexFlow/image-20260131-003734-k8xy.png";

/**
 * 写入临时 Gemini session JSON 文件并返回其路径。
 *
 * @param obj 需要写入的 JSON 对象
 * @param filename 文件名
 * @returns 临时文件路径
 */
async function writeTempJson(obj: unknown, filename = `gemini-${Date.now()}-${Math.random().toString(16).slice(2)}.json`): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-gemini-"));
  const fp = path.join(dir, filename);
  await fs.promises.writeFile(fp, JSON.stringify(obj), "utf8");
  return fp;
}

/**
 * 在临时目录的指定相对路径写入 JSON 文件并返回文件路径。
 *
 * @param obj 需要写入的 JSON 对象
 * @param relPath 相对临时目录的目标路径
 * @returns 临时文件路径
 */
async function writeTempJsonAtRelPath(obj: unknown, relPath: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-gemini-"));
  const fp = path.join(dir, relPath);
  await fs.promises.mkdir(path.dirname(fp), { recursive: true });
  await fs.promises.writeFile(fp, JSON.stringify(obj), "utf8");
  return fp;
}

/**
 * 在临时目录写入 Gemini JSONL 会话文件并返回路径。
 *
 * @param records JSONL 记录列表
 * @param relPath 相对临时目录的目标路径
 * @returns 临时文件路径
 */
async function writeTempJsonlAtRelPath(records: unknown[], relPath: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-gemini-jsonl-"));
  const fp = path.join(dir, relPath);
  await fs.promises.mkdir(path.dirname(fp), { recursive: true });
  await fs.promises.writeFile(fp, records.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
  return fp;
}

/**
 * 创建临时图片文件占位，供 Gemini 图片路径优先逻辑测试使用。
 *
 * @param fileName 文件名
 * @returns 临时图片文件路径
 */
async function writeTempImageFile(fileName = "gemini-inline-image.png"): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-gemini-image-"));
  const fp = path.join(dir, fileName);
  await fs.promises.writeFile(fp, "fake-image", "utf8");
  return fp;
}

describe("parseGeminiSessionFile（超大文件 summaryOnly 预览兜底）", () => {
  it("当文件超过 maxBytes 时仍能从前缀提取 preview/sessionId/rawDate", async () => {
    const sessionId = "d3862d4d-7d74-46c4-9858-45cf754919ca";
    const startTime = "2026-01-30T16:39:19.465Z";
    const lastUpdated = "2026-01-30T17:05:47.475Z";

    const payload: any = {
      startTime,
      lastUpdated,
      sessionId,
      projectHash: "2c076481a534981f1d988b55053bccf053f1bec6932623a652d533211c63c763",
      messages: [
        {
          id: "m1",
          timestamp: startTime,
          type: "user",
          content: `\`${GEMINI_PREVIEW_TEST_PATH}\`\n\n真实首条：你好`,
        },
        {
          id: "m2",
          timestamp: lastUpdated,
          type: "gemini",
          content: "",
          toolCalls: [
            {
              id: "tool-1",
              name: "SearchText",
              result: "x".repeat(220 * 1024), // 制造足够大的文件，触发 maxBytes 保护分支
            },
          ],
        },
      ],
    };

    const fp = await writeTempJson(payload, `session-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const stat = await fs.promises.stat(fp);
    const details = await parseGeminiSessionFile(fp, stat, { summaryOnly: true, maxBytes: 64 * 1024 });

    expect(details.preview).toBe("真实首条：你好");
    expect(details.title).toBe("真实首条：你好");
    expect(details.resumeId).toBe(sessionId);
    expect(details.rawDate).toBe(lastUpdated);
    expect(details.messages.length).toBe(0);
  });

  it("当路径不含 hash 目录时，仍可从 JSON 头部提取 projectHash", async () => {
    const projectHash = "567266847957ce43ba0e98d21b65cf333047f193f52e511da7be4fcbf53e53ba";
    const fp = await writeTempJsonAtRelPath(
      {
        sessionId: "cc28c19a-73b0-470a-b8cf-738ec6a547a8",
        projectHash,
        startTime: "2026-03-04T17:09:47.101Z",
        lastUpdated: "2026-03-04T17:09:55.680Z",
        messages: [
          { type: "user", content: [{ text: "hello gemini" }] },
          { type: "gemini", content: "你好！" },
        ],
      },
      `codexflow/chats/session-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    const stat = await fs.promises.stat(fp);
    const details = await parseGeminiSessionFile(fp, stat, { summaryOnly: true, maxBytes: 128 * 1024 });

    expect(details.projectHash).toBe(projectHash);
    expect(details.preview).toBe("hello gemini");
    expect(details.resumeId).toBe("cc28c19a-73b0-470a-b8cf-738ec6a547a8");
  });

  it("会优先使用 Gemini 会话中的 inlineData 预览，并保留本地图片路径回退", async () => {
    const localImagePath = await writeTempImageFile();
    const fp = await writeTempJson(
      {
        sessionId: "gemini-image-session",
        startTime: "2026-03-10T13:15:53.072Z",
        lastUpdated: "2026-03-10T13:22:34.015Z",
        messages: [
          {
            type: "user",
            content: [
              { text: `@${localImagePath} 请优化这个界面` },
              { inlineData: { data: "aGVsbG8=", mimeType: "image/png" } },
            ],
          },
        ],
      },
      `session-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
    );
    const stat = await fs.promises.stat(fp);
    const details = await parseGeminiSessionFile(fp, stat, { summaryOnly: false, maxBytes: 128 * 1024 });

    const imageItem = details.messages.flatMap((message) => message.content || []).find((item) => item.type === "image");
    expect(imageItem).toBeTruthy();
    expect(imageItem?.localPath).toBe(localImagePath);
    expect(String(imageItem?.src || "")).toBe("data:image/png;base64,aGVsbG8=");
    expect(String(imageItem?.fallbackSrc || "")).toMatch(/^file:\/\//);
  });

  it("支持新版 Gemini JSONL 会话格式并保留助手回复", async () => {
    const projectHash = "567266847957ce43ba0e98d21b65cf333047f193f52e511da7be4fcbf53e53ba";
    const sessionId = "cc28c19a-73b0-470a-b8cf-738ec6a547a8";
    const fp = await writeTempJsonlAtRelPath(
      [
        {
          sessionId,
          projectHash,
          startTime: "2026-05-28T04:50:00.000Z",
          lastUpdated: "2026-05-28T04:50:00.000Z",
          directories: ["G:\\Projects\\CodexFlow"],
        },
        {
          id: "user-1",
          timestamp: "2026-05-28T04:50:01.000Z",
          type: "user",
          content: [{ text: "test" }],
        },
        {
          id: "gemini-1",
          timestamp: "2026-05-28T04:50:02.000Z",
          type: "gemini",
          content: [{ text: "你好，请问有什么我可以帮您的？" }],
          model: "gemini-3.5-flash",
        },
        {
          $set: {
            lastUpdated: "2026-05-28T04:50:03.000Z",
          },
        },
      ],
      `${projectHash}/chats/session-2026-05-28T04-50-${sessionId.slice(0, 8)}.jsonl`,
    );
    const stat = await fs.promises.stat(fp);

    const summary = await parseGeminiSessionFile(fp, stat, { summaryOnly: true, maxBytes: 128 * 1024 });
    expect(summary.preview).toBe("test");
    expect(summary.title).toBe("test");
    expect(summary.resumeId).toBe(sessionId);
    expect(summary.projectHash).toBe(projectHash);
    expect(summary.cwd).toBe("G:\\Projects\\CodexFlow");
    expect(summary.rawDate).toBe("2026-05-28T04:50:03.000Z");

    const details = await parseGeminiSessionFile(fp, stat, { summaryOnly: false, maxBytes: 128 * 1024 });
    expect(details.messages).toHaveLength(2);
    expect(details.messages[0]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "test" }],
    });
    expect(details.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "output_text", text: "你好，请问有什么我可以帮您的？" }],
    });
  });

  it("新版 Gemini JSONL 会跳过自动 session_context 预览并归类为 meta", async () => {
    const fp = await writeTempJsonlAtRelPath(
      [
        {
          sessionId: "session-context-case",
          projectHash: "567266847957ce43ba0e98d21b65cf333047f193f52e511da7be4fcbf53e53ba",
          startTime: "2026-05-28T05:10:00.000Z",
          directories: ["G:\\Projects\\CodexFlow"],
        },
        {
          id: "context-1",
          type: "user",
          content: [{ text: "<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat." }],
        },
        {
          id: "user-1",
          type: "user",
          content: [{ text: "真实问题" }],
        },
      ],
      "project/chats/session-2026-05-28T05-10-context.jsonl",
    );
    const stat = await fs.promises.stat(fp);

    const summary = await parseGeminiSessionFile(fp, stat, { summaryOnly: true, maxBytes: 128 * 1024 });
    expect(summary.preview).toBe("真实问题");
    expect(summary.title).toBe("真实问题");

    const details = await parseGeminiSessionFile(fp, stat, { summaryOnly: false, maxBytes: 128 * 1024 });
    expect(details.messages[0]).toEqual({
      role: "system",
      content: [{ type: "meta", text: "<session_context>\nThis is the Gemini CLI. We are setting up the context for our chat." }],
    });
    expect(details.messages[1]).toEqual({
      role: "user",
      content: [{ type: "input_text", text: "真实问题" }],
    });
  });

  it("新版 Gemini JSONL 优先使用 metadata directories 推断项目目录", async () => {
    const projectHash = "567266847957ce43ba0e98d21b65cf333047f193f52e511da7be4fcbf53e53ba";
    const fp = await writeTempJsonlAtRelPath(
      [
        {
          sessionId: "directory-priority-case",
          projectHash,
          startTime: "2026-05-28T05:20:00.000Z",
          directories: ["G:\\Projects\\CodexFlow"],
        },
        {
          id: "user-1",
          type: "user",
          content: [{ text: "请查看 C:\\Temp\\other-project\\note.txt 并继续" }],
        },
      ],
      `${projectHash}/chats/session-2026-05-28T05-20-directory.jsonl`,
    );
    const stat = await fs.promises.stat(fp);

    const summary = await parseGeminiSessionFile(fp, stat, { summaryOnly: true, maxBytes: 128 * 1024 });
    expect(summary.cwd).toBe("G:\\Projects\\CodexFlow");
    expect(summary.dirKey).toBe("/mnt/g/projects/codexflow");
  });

  it("支持新版 Gemini JSONL 的消息更新与工具结果展示", async () => {
    const fp = await writeTempJsonlAtRelPath(
      [
        {
          sessionId: "tool-session",
          projectHash: "2c076481a534981f1d988b55053bccf053f1bec6932623a652d533211c63c763",
          startTime: "2026-05-28T05:00:00.000Z",
        },
        {
          id: "user-1",
          type: "user",
          content: [{ text: "列出文件" }],
        },
        {
          id: "gemini-1",
          type: "gemini",
          content: "",
          toolCalls: [
            {
              id: "call-1",
              name: "ReadFolder",
              args: { path: "." },
              status: "executing",
            },
          ],
        },
        {
          id: "gemini-1",
          type: "gemini",
          content: [{ text: "已经列出文件。" }],
          toolCalls: [
            {
              id: "call-1",
              name: "ReadFolder",
              args: { path: "." },
              status: "success",
              result: [{ text: "package.json\nREADME.md" }],
            },
          ],
        },
      ],
      "project/chats/session-2026-05-28T05-00-tool.jsonl",
    );
    const stat = await fs.promises.stat(fp);
    const details = await parseGeminiSessionFile(fp, stat, { summaryOnly: false, maxBytes: 128 * 1024 });

    expect(details.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant", "tool"]);
    expect(details.messages[1].content[0]).toEqual({ type: "output_text", text: "已经列出文件。" });
    expect(details.messages[2].content[0].type).toBe("tool_call");
    expect(details.messages[2].content[0].text).toContain("ReadFolder");
    expect(details.messages[3].content[0]).toEqual({ type: "tool_result", text: "package.json\nREADME.md" });
  });
});

