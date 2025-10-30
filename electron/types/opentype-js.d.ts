// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

declare module 'opentype.js' {
  type BufferLike = ArrayBuffer | ArrayBufferView;
  export interface OpenTypeFont { tables?: any; }
  const opentype: {
    parse: (buffer: BufferLike) => OpenTypeFont;
  };
  export default opentype;
}


