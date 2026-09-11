// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

/**
 * 读取期间若通知改变了会话绑定，立即按新上下文重查，避免把一次有效点击丢成空结果。
 * 只重试上下文确实变化的请求；持续变化时交由已有后台重试接续。
 */
export async function lookupHistoryWithStableContext<C extends { signature: string }, S, R>(options: {
  getContext: () => C | null;
  load: (context: C) => Promise<S[]>;
  resolve: (context: C, sessions: S[]) => R | null;
}): Promise<R | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const context = options.getContext();
    if (!context) return null;
    const sessions = await options.load(context);
    const current = options.getContext();
    if (!current) return null;
    if (current.signature !== context.signature) continue;
    return options.resolve(current, sessions);
  }
  return null;
}
