// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import crypto from "node:crypto";

/**
 * 对字符串做 SHA-256 哈希，并输出小写 hex。
 */
export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

