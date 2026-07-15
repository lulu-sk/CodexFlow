// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import type { ProviderEnv } from "@/types/host";

export type ProviderEnvironmentRequest = {
  providerId: string;
  sequence: number;
};

/** 判断两个 Provider 运行环境是否表示同一个终端目标。 */
export function areProviderEnvironmentsEqual(
  left: Required<ProviderEnv>,
  right: Required<ProviderEnv>,
): boolean {
  return left.terminal === right.terminal
    && String(left.distro || "").trim().toLowerCase() === String(right.distro || "").trim().toLowerCase();
}

/** 判断异步环境检查是否仍对应用户最后一次选择。 */
export function isCurrentProviderEnvironmentRequest(
  request: ProviderEnvironmentRequest,
  activeProviderId: string,
  currentSequence: number,
): boolean {
  return request.providerId === activeProviderId && request.sequence === currentSequence;
}
