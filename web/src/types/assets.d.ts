// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

declare module "*.svg?url" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const src: string;
  export default src;
}
