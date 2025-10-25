// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

const DEFAULT_OSC_PREFIX = "\u001b]9;";
const DEFAULT_MAX_BUFFER_LENGTH = 8192;
const DEFAULT_TAIL_WINDOW = 256;

export type OscTrimReason = "unchanged" | "from-prefix" | "partial-prefix" | "tail";

export type OscTrimOptions = {
  prefix?: string;
  maxLength?: number;
  tailWindow?: number;
};

export type OscTrimResult = {
  buffer: string;
  reason: OscTrimReason;
  trimmedBytes: number;
  partialPrefixLength: number;
};

export function trimOscBuffer(
  buffer: string,
  options: OscTrimOptions = {},
): OscTrimResult {
  const prefix = options.prefix ?? DEFAULT_OSC_PREFIX;
  const maxLength = options.maxLength ?? DEFAULT_MAX_BUFFER_LENGTH;
  const tailWindow = Math.max(options.tailWindow ?? DEFAULT_TAIL_WINDOW, prefix.length);
  if (buffer.length <= maxLength) {
    return {
      buffer,
      reason: "unchanged",
      trimmedBytes: 0,
      partialPrefixLength: 0,
    };
  }

  const oscStart = buffer.lastIndexOf(prefix);
  if (oscStart >= 0) {
    const candidate = buffer.slice(oscStart);
    if (candidate.length <= maxLength) {
      return {
        buffer: candidate,
        reason: "from-prefix",
        trimmedBytes: oscStart,
        partialPrefixLength: prefix.length,
      };
    }
    // 当从最近一次 OSC 起始到当前的片段仍然超过 maxLength 时，
    // 也要强制保留“完整起始符 + 末尾尾段”，确保后续终止符（BEL/ST）到来时能被正确识别为一条通知。
    // 这样可以避免在大量输出刷屏时，起始符被整体丢弃导致整条 OSC 消息永远无法解析。
    const tailCapacity = Math.max(0, maxLength - prefix.length);
    const keptTail = tailCapacity > 0 ? candidate.slice(-tailCapacity) : "";
    const kept = prefix + keptTail;
    const trimmedBytes = buffer.length - kept.length;
    return {
      buffer: kept,
      reason: "from-prefix",
      trimmedBytes: trimmedBytes > 0 ? trimmedBytes : 0,
      partialPrefixLength: prefix.length,
    };
  }

  const tailSliceLength = Math.min(tailWindow, buffer.length);
  const tailSlice = buffer.slice(-tailSliceLength);
  const partialLength = getPartialPrefixLength(tailSlice, prefix);
  if (partialLength > 0) {
    const keepLength = Math.max(partialLength, tailSliceLength);
    const trimmedBytes = buffer.length - keepLength;
    return {
      buffer: buffer.slice(-keepLength),
      reason: "partial-prefix",
      trimmedBytes,
      partialPrefixLength: partialLength,
    };
  }

  const keepLength = tailSliceLength;
  const trimmedBytes = buffer.length - keepLength;
  return {
    buffer: buffer.slice(-keepLength),
    reason: "tail",
    trimmedBytes,
    partialPrefixLength: 0,
  };
}

function getPartialPrefixLength(sample: string, prefix: string): number {
  const limit = Math.min(prefix.length, sample.length);
  for (let len = limit; len > 0; len--) {
    if (prefix.startsWith(sample.slice(-len))) {
      return len;
    }
  }
  return 0;
}

export const oscBufferDefaults = {
  prefix: DEFAULT_OSC_PREFIX,
  maxLength: DEFAULT_MAX_BUFFER_LENGTH,
  tailWindow: DEFAULT_TAIL_WINDOW,
} as const;
