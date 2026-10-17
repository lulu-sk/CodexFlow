// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { Readable } from "node:stream";

/** 按换行字节拆分历史流，完整行到齐后只解码一次，兼容 CRLF 与孤立 CR。 */
export async function readBufferHistoryLines(input: Readable, onLine: (line: string) => boolean): Promise<void> {
  let parts: Buffer[] = [];
  let bytes = 0;
  let skipLeadingLF = false;
  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk)) throw new TypeError("历史读取流必须输出字节缓冲区");
    if (chunk.length === 0) continue;
    let start = skipLeadingLF && chunk[0] === 10 ? 1 : 0;
    skipLeadingLF = false;
    let lf = chunk.indexOf(10, start);
    let cr = chunk.indexOf(13, start);
    while (lf !== -1 || cr !== -1) {
      const end = lf === -1 ? cr : cr === -1 ? lf : Math.min(lf, cr);
      let line: string;
      if (parts.length > 0) {
        if (end > start) {
          parts.push(chunk.subarray(start, end));
          bytes += end - start;
        }
        line = Buffer.concat(parts, bytes).toString("utf8");
        parts = [];
        bytes = 0;
      } else {
        line = chunk.toString("utf8", start, end);
      }
      if (!onLine(line)) return;
      start = end + 1;
      if (end === cr) {
        if (start < chunk.length && chunk[start] === 10) start += 1;
        else if (start === chunk.length) skipLeadingLF = true;
      }
      if (lf !== -1 && lf < start) lf = chunk.indexOf(10, start);
      if (cr !== -1 && cr < start) cr = chunk.indexOf(13, start);
    }
    if (start < chunk.length) {
      parts.push(chunk.subarray(start));
      bytes += chunk.length - start;
    }
  }
  if (parts.length > 0) onLine(Buffer.concat(parts, bytes).toString("utf8"));
}
