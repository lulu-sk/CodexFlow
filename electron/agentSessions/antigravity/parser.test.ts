import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseAntigravitySessionFile } from "./parser";

type MockStepRow = {
  idx: number;
  step_type: number;
  status: number;
  step_payload: Buffer;
  metadata: Buffer | null;
  task_details: Buffer | null;
};

const mockSqliteState = {
  dbByPath: new Map<string, { rows: MockStepRow[]; trajectoryId: string; cascadeId: string }>(),
};

class MockDatabase {
  private readonly data: { rows: MockStepRow[]; trajectoryId: string; cascadeId: string };

  constructor(filePath: string) {
    const hit = mockSqliteState.dbByPath.get(String(filePath || ""));
    if (!hit) throw new Error(`missing mock sqlite db: ${filePath}`);
    this.data = hit;
  }

  /**
   * 兼容 better-sqlite3 pragma 调用。
   */
  pragma() {
    return undefined;
  }

  /**
   * 返回 parser 所需的最小 SQL 结果。
   */
  prepare(sql: string) {
    const normalized = String(sql || "").toLowerCase();
    const data = this.data;
    return {
      all: (limit?: number) => {
        if (normalized.includes("sqlite_master"))
          return [{ name: "steps" }, { name: "trajectory_meta" }];
        if (normalized.includes("pragma table_info"))
          return [
            { name: "idx" },
            { name: "step_type" },
            { name: "status" },
            { name: "step_payload" },
            { name: "metadata" },
            { name: "task_details" },
          ];
        const rows = data.rows.map((row) => ({ ...row }));
        const max = Math.max(0, Math.floor(Number(limit) || 0));
        return max > 0 ? rows.slice(0, max) : rows;
      },
      get: () => ({ trajectory_id: data.trajectoryId, cascade_id: data.cascadeId }),
    };
  }

  /**
   * 兼容 better-sqlite3 close 调用。
   */
  close() {
    return undefined;
  }
}

beforeEach(() => {
  mockSqliteState.dbByPath.clear();
  (global as any).__antigravityDatabaseCtorForTest = MockDatabase;
});

afterEach(() => {
  mockSqliteState.dbByPath.clear();
  delete (global as any).__antigravityDatabaseCtorForTest;
});

/**
 * 编码 protobuf varint。
 */
function varint(value: number): Buffer {
  const bytes: number[] = [];
  let current = Math.max(0, Math.floor(value));
  while (current >= 0x80) {
    bytes.push((current & 0x7f) | 0x80);
    current = Math.floor(current / 128);
  }
  bytes.push(current);
  return Buffer.from(bytes);
}

/**
 * 编码 length-delimited protobuf 字段。
 */
function bytesField(field: number, value: Buffer | string): Buffer {
  const raw = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return Buffer.concat([varint(field * 8 + 2), varint(raw.length), raw]);
}

/**
 * 构造 Antigravity Step envelope。
 */
function stepPayload(contentField: number, text: string): Buffer {
  return stepPayloadFromTexts(contentField, [text]);
}

/**
 * 构造包含多个文本叶子的 Antigravity Step envelope。
 */
function stepPayloadFromTexts(contentField: number, texts: string[]): Buffer {
  const inner = Buffer.concat(texts.map((text) => bytesField(1, text)));
  return bytesField(contentField, inner);
}

/**
 * 构造接近真实 planner 响应的 protobuf 内容。
 */
function plannerResponseContent(text: string): Buffer {
  return Buffer.concat([
    bytesField(1, text),
    bytesField(6, "bot-5839198b-fac1-42ca-be97-1af244d5656a"),
    bytesField(8, text),
    bytesField(14, "9HK<+s Q x6e.Qo E4= O#b"),
  ]);
}

/**
 * 创建最小 Antigravity SQLite 会话 DB。
 */
async function createSessionDb(rows: Array<{ idx: number; stepType: number; contentField: number; text: string; texts?: string[]; content?: Buffer; metadataText?: string; taskDetailsText?: string }>): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-antigravity-parser-"));
  const fp = path.join(dir, "conversation-test.db");
  await fs.promises.writeFile(fp, "");
  mockSqliteState.dbByPath.set(fp, {
    trajectoryId: "trajectory-test",
    cascadeId: "conversation-test",
    rows: rows.map((row) => ({
      idx: row.idx,
      step_type: row.stepType,
      status: 3,
      step_payload: row.content ? bytesField(row.contentField, row.content) : row.texts ? stepPayloadFromTexts(row.contentField, row.texts) : stepPayload(row.contentField, row.text),
      metadata: row.metadataText ? bytesField(1, row.metadataText) : null,
      task_details: row.taskDetailsText ? bytesField(1, row.taskDetailsText) : null,
    })),
  });
  return fp;
}

describe("parseAntigravitySessionFile", () => {
  it("详情模式能恢复用户输入、助手输出、resumeId 与顺序", async () => {
    const fp = await createSessionDb([
      { idx: 1, stepType: 14, contentField: 19, text: "hello antigravity" },
      { idx: 2, stepType: 15, contentField: 20, text: "hello user" },
    ]);
    const stat = await fs.promises.stat(fp);

    const details = await parseAntigravitySessionFile(fp, stat, { summaryOnly: false });

    expect(details.providerId).toBe("antigravity");
    expect(details.resumeId).toBe("conversation-test");
    expect(details.preview).toBe("hello antigravity");
    expect(details.messages.map((message) => message.role)).toEqual(["meta", "user", "assistant"]);
    expect(details.messages[1].content[0]).toMatchObject({ type: "input_text", text: "hello antigravity" });
    expect(details.messages[2].content[0]).toMatchObject({ type: "output_text", text: "hello user" });
  });

  it("summaryOnly 只提取 preview，不保留正文消息", async () => {
    const fp = await createSessionDb([
      { idx: 1, stepType: 14, contentField: 19, text: "summary preview" },
    ]);
    const stat = await fs.promises.stat(fp);

    const details = await parseAntigravitySessionFile(fp, stat, { summaryOnly: true });

    expect(details.preview).toBe("summary preview");
    expect(details.messages).toHaveLength(0);
  });

  it("summaryOnly 能从 metadata 提取正斜杠 Windows cwd 并归属到项目目录", async () => {
    const fp = await createSessionDb([
      {
        idx: 1,
        stepType: 14,
        contentField: 19,
        text: "summary preview",
        metadataText: "cwd: J:/Projects/Projects/example",
      },
    ]);
    const stat = await fs.promises.stat(fp);

    const details = await parseAntigravitySessionFile(fp, stat, { summaryOnly: true });

    expect(details.cwd).toBe("J:/Projects/Projects/example");
    expect(details.dirKey).toBe("/mnt/j/projects/projects/example");
    expect(details.messages).toHaveLength(0);
  });

  it("能从完整 step_payload 的非正文文本中提取 cwd", async () => {
    const fp = await createSessionDb([
      {
        idx: 1,
        stepType: 14,
        contentField: 19,
        text: "summary preview",
      },
      {
        idx: 2,
        stepType: 23,
        contentField: 30,
        text: "workspace C:/workspaces/demo",
      },
    ]);
    const stat = await fs.promises.stat(fp);

    const details = await parseAntigravitySessionFile(fp, stat, { summaryOnly: true });

    expect(details.cwd).toBe("C:/workspaces/demo");
    expect(details.dirKey).toBe("/mnt/c/workspaces/demo");
  });

  it("真实工作区路径优先于用户主目录，避免历史归到用户目录", async () => {
    const fp = await createSessionDb([
      {
        idx: 1,
        stepType: 14,
        contentField: 19,
        text: "CESHI",
        metadataText: "cwd: C:\\Users\\tester",
      },
      {
        idx: 2,
        stepType: 15,
        contentField: 20,
        text: "{\"DirectoryPath\":\"J:\\\\Projects\\\\Projects\\\\sample\",\"toolAction\":\"Listing workspace directory\",\"toolSummary\":\"Workspace analysis\"}",
      },
    ]);
    const stat = await fs.promises.stat(fp);

    const details = await parseAntigravitySessionFile(fp, stat, { summaryOnly: true });

    expect(details.cwd).toBe("J:\\Projects\\Projects\\sample");
    expect(details.dirKey).toBe("/mnt/j/projects/projects/sample");
  });

  it("能把 Antigravity 内部 file URI 解码成真实工作区，避免中文路径乱码和盘符错位", async () => {
    const fp = await createSessionDb([
      {
        idx: 1,
        stepType: 14,
        contentField: 19,
        text: "绘画测试",
        texts: [
          "绘画测试",
          "C:\\Users\\tester\\.gemini\\antigravity-cli\\skills",
          "J:/Projects/Projects/杂项",
          "file:///J:/Projects/Projects/%E6%9D%82%E9%A1%B9",
        ],
      },
    ]);
    const stat = await fs.promises.stat(fp);

    const details = await parseAntigravitySessionFile(fp, stat, { summaryOnly: true });

    expect(details.cwd).toBe("J:/Projects/Projects/杂项");
    expect(details.dirKey).toBe("/mnt/j/projects/projects/杂项");
  });

  it("SQLite 中没有可靠 cwd 时使用 Antigravity history.jsonl 的 workspace 兜底", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "codexflow-antigravity-history-"));
    const conversationsDir = path.join(dir, "conversations");
    await fs.promises.mkdir(conversationsDir, { recursive: true });
    const fp = path.join(conversationsDir, "conversation-history.db");
    await fs.promises.writeFile(fp, "");
    const timestamp = Date.now();
    await fs.promises.writeFile(
      path.join(dir, "history.jsonl"),
      JSON.stringify({ display: "绘画测试", timestamp, workspace: "J:\\Projects\\Projects\\杂项" }) + "\n",
      "utf8",
    );
    mockSqliteState.dbByPath.set(fp, {
      trajectoryId: "trajectory-history",
      cascadeId: "conversation-history",
      rows: [
        {
          idx: 1,
          step_type: 14,
          status: 3,
          step_payload: stepPayload(19, "绘画测试"),
          metadata: bytesField(1, "cwd: C:\\Users\\tester"),
          task_details: null,
        },
      ],
    });
    const stat = await fs.promises.stat(fp);
    Object.defineProperty(stat, "mtimeMs", { value: timestamp });

    const details = await parseAntigravitySessionFile(fp, stat, { summaryOnly: true });

    expect(details.cwd).toBe("J:\\Projects\\Projects\\杂项");
    expect(details.dirKey).toBe("/mnt/j/projects/projects/杂项");
  });

  it("planner 响应优先选择自然语言正文，不把工具载荷乱码当助手输出", async () => {
    const damagedToolPayload = "\u0001c9dgrkq3\u0000list_dir\uFFFD{\"DirectoryPath\":\"J:\\\\Projects\\\\Projects\\\\sample\",\"toolAction\":\"Listing workspace directory\",\"toolSummary\":\"Workspace analysis\"}\u0004\u001F\uFFFDlist_dir";
    const normalReply = "您好！我已成功连接到工作区 sample。";
    const fp = await createSessionDb([
      { idx: 1, stepType: 14, contentField: 19, text: "CESHI" },
      {
        idx: 2,
        stepType: 15,
        contentField: 20,
        text: normalReply,
        texts: [damagedToolPayload, normalReply],
      },
    ]);
    const stat = await fs.promises.stat(fp);

    const details = await parseAntigravitySessionFile(fp, stat, { summaryOnly: false });
    const assistantText = details.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content.map((item) => item.text))
      .join("\n");

    expect(assistantText).toContain(normalReply);
    expect(assistantText).not.toContain("toolAction");
    expect(assistantText).not.toContain("\uFFFD");
  });

  it("planner 内部 bot 标识不会作为助手正文显示", async () => {
    const fp = await createSessionDb([
      { idx: 1, stepType: 14, contentField: 19, text: "绘画测试" },
      { idx: 2, stepType: 15, contentField: 20, text: "bot-e3cadb31-884e-4d28-9816-e93108acbfe5" },
      { idx: 3, stepType: 15, contentField: 20, text: "这是可读的中文回复。" },
    ]);
    const stat = await fs.promises.stat(fp);

    const details = await parseAntigravitySessionFile(fp, stat, { summaryOnly: false });
    const assistantText = details.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content.map((item) => item.text))
      .join("\n");

    expect(assistantText).toContain("这是可读的中文回复。");
    expect(assistantText).not.toContain("bot-e3cadb31-884e-4d28-9816-e93108acbfe5");
  });

  it("planner 响应能从真实结构的子字段中提取干净助手正文", async () => {
    const normalReply = "你好！很高兴为您服务。请问今天有什么我可以帮您的？";
    const fp = await createSessionDb([
      { idx: 1, stepType: 14, contentField: 19, text: "你好" },
      { idx: 2, stepType: 15, contentField: 20, text: "", content: plannerResponseContent(normalReply) },
    ]);
    const stat = await fs.promises.stat(fp);

    const details = await parseAntigravitySessionFile(fp, stat, { summaryOnly: false });
    const assistantText = details.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content.map((item) => item.text))
      .join("\n");

    expect(assistantText).toBe(normalReply);
    expect(assistantText).not.toContain("bot-");
    expect(assistantText).not.toContain("9HK");
  });

  it("只有工具载荷乱码时显示清理后的工具摘要", async () => {
    const damagedToolPayload = "\u0001c9dgrkq3\u0000list_dir\uFFFD{\"DirectoryPath\":\"J:\\\\Projects\\\\Projects\\\\sample\",\"toolAction\":\"Listing workspace directory\",\"toolSummary\":\"Workspace analysis\"}\u0004\u001F\uFFFDlist_dir";
    const fp = await createSessionDb([
      { idx: 1, stepType: 14, contentField: 19, text: "CESHI" },
      { idx: 2, stepType: 15, contentField: 20, text: damagedToolPayload },
    ]);
    const stat = await fs.promises.stat(fp);

    const details = await parseAntigravitySessionFile(fp, stat, { summaryOnly: false });
    const toolText = details.messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content.map((item) => item.text))
      .join("\n");

    expect(toolText).toContain("list_dir");
    expect(toolText).toContain("DirectoryPath: J:\\Projects\\Projects\\sample");
    expect(toolText).toContain("toolAction: Listing workspace directory");
    expect(toolText).not.toContain("\uFFFD");
  });
});
