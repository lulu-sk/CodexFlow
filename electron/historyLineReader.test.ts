import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import readline from "node:readline";
import { readBufferHistoryLines } from "./historyLineReader";

/** 将测试字节切成固定大小的小块，覆盖换行符与多字节字符跨块。 */
function splitChunks(bytes: Buffer, size: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let index = 0; index < bytes.length; index += size) chunks.push(bytes.subarray(index, index + size));
  return chunks;
}

/** 用与文件读取一致的字节流模式取得 Node 原有的行拆分结果。 */
async function readReferenceLines(chunks: Buffer[]): Promise<string[]> {
  const input = Readable.from(chunks, { objectMode: false }).setEncoding("utf8");
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const result: string[] = [];
  for await (const line of lines) result.push(line);
  return result;
}

describe("历史字节流读行", () => {
  it.each([1, 2, 3, 7, 64])("每块 %i 字节时保持中文、emoji 和各类换行的完整语义", async (size) => {
    const samples = ["甲🙂\r\n乙\n\n丙\r丁\r\n尾", "\r\r\n\n", "", "末尾\n", "\n\r\n末尾\r"];
    for (const sample of samples) {
      const chunks = splitChunks(Buffer.from(sample), size);
      const expected = await readReferenceLines(chunks);
      const actual: string[] = [];
      await readBufferHistoryLines(Readable.from(chunks), (line) => {
        actual.push(line);
        return true;
      });
      expect(actual).toEqual(expected);
    }
  });

  it("无效 UTF-8 和空缓冲区不会改变换行位置或替换字符", async () => {
    const bytes = Buffer.from([0xe4, 0xb8, 0xad, 0xc2, 10, 0xff, 13, 10]);
    const chunks = splitChunks(bytes, 1).flatMap((chunk) => [Buffer.alloc(0), chunk]);
    const actual: string[] = [];
    await readBufferHistoryLines(Readable.from(chunks), (line) => {
      actual.push(line);
      return true;
    });
    expect(actual).toEqual(await readReferenceLines(chunks));
    expect(actual).toEqual(["中\uFFFD", "\uFFFD"]);
  });

  it("超过读取块的大行只在完整字节到齐后解码，且保留其后的尾行", async () => {
    const largeLine = "x".repeat(1024 * 1024 - 1) + "甲🙂尾";
    const chunks = splitChunks(Buffer.from(`${largeLine}\r\n尾条🙂`), 64 * 1024);
    const actual: string[] = [];
    await readBufferHistoryLines(Readable.from(chunks), (line) => {
      actual.push(line);
      return true;
    });
    expect(actual).toEqual(await readReferenceLines(chunks));
    expect(actual).toEqual([largeLine, "尾条🙂"]);
  });

  it("达到上限后不再处理同一块中的后续行，并关闭读取流", async () => {
    const input = Readable.from([Buffer.from("第一行\n第二行\n第三行\n")]);
    const actual: string[] = [];
    await readBufferHistoryLines(input, (line) => {
      actual.push(line);
      return actual.length < 2;
    });
    expect(actual).toEqual(["第一行", "第二行"]);
    expect(input.destroyed).toBe(true);
  });

  it("底层流失败时拒绝读取并关闭流", async () => {
    const error = new Error("测试读取失败");
    const input = new Readable({
      /** 发出固定读取错误，验证失败不会被当成正常文件结束。 */
      read() {
        this.destroy(error);
      },
    });
    await expect(readBufferHistoryLines(input, () => true)).rejects.toBe(error);
    expect(input.destroyed).toBe(true);
  });

  it("行处理失败时拒绝读取并关闭流", async () => {
    const error = new Error("测试行处理失败");
    const input = Readable.from([Buffer.from("第一行\n第二行\n")]);
    await expect(readBufferHistoryLines(input, () => {
      throw error;
    })).rejects.toBe(error);
    expect(input.destroyed).toBe(true);
  });
});
