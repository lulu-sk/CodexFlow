// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

module.exports = {
  darkMode: ['class'],
  content: [
    './web/index.html',
    './web/src/**/*.{ts,tsx,js,jsx,html}',
  ],
  theme: {
    extend: {
      // 现代精致的圆角尺寸
      borderRadius: {
        'apple-sm': '6px',
        'apple': '10px',
        'apple-lg': '14px',
        'apple-xl': '18px',
      },
      // 精致的多层次阴影
      boxShadow: {
        'apple-xs': '0 1px 2px 0 rgba(0, 0, 0, 0.04), 0 1px 3px 0 rgba(0, 0, 0, 0.04)',
        'apple-sm': '0 2px 4px 0 rgba(0, 0, 0, 0.06), 0 2px 6px 0 rgba(0, 0, 0, 0.05)',
        'apple': '0 4px 8px 0 rgba(0, 0, 0, 0.08), 0 2px 4px 0 rgba(0, 0, 0, 0.06)',
        'apple-md': '0 6px 12px 0 rgba(0, 0, 0, 0.1), 0 2px 6px 0 rgba(0, 0, 0, 0.08)',
        'apple-lg': '0 10px 20px 0 rgba(0, 0, 0, 0.12), 0 4px 8px 0 rgba(0, 0, 0, 0.1)',
        'apple-xl': '0 20px 40px 0 rgba(0, 0, 0, 0.15), 0 8px 16px 0 rgba(0, 0, 0, 0.12)',
        'apple-inner': 'inset 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
        // 暗色模式阴影（更柔和）
        'apple-dark-xs': '0 1px 2px 0 rgba(0, 0, 0, 0.3), 0 1px 3px 0 rgba(0, 0, 0, 0.2)',
        'apple-dark-sm': '0 2px 4px 0 rgba(0, 0, 0, 0.4), 0 2px 6px 0 rgba(0, 0, 0, 0.3)',
        'apple-dark': '0 4px 8px 0 rgba(0, 0, 0, 0.5), 0 2px 4px 0 rgba(0, 0, 0, 0.4)',
        'apple-dark-md': '0 6px 12px 0 rgba(0, 0, 0, 0.6), 0 2px 6px 0 rgba(0, 0, 0, 0.5)',
        'apple-dark-lg': '0 10px 20px 0 rgba(0, 0, 0, 0.7), 0 4px 8px 0 rgba(0, 0, 0, 0.6)',
        'apple-dark-xl': '0 20px 40px 0 rgba(0, 0, 0, 0.8), 0 8px 16px 0 rgba(0, 0, 0, 0.7)',
      },
      // 流畅的动画时长
      transitionDuration: {
        'apple': '200ms',
        'apple-fast': '150ms',
        'apple-slow': '300ms',
      },
      // 平滑的缓动函数
      transitionTimingFunction: {
        'apple': 'cubic-bezier(0.4, 0, 0.2, 1)',
        'apple-in': 'cubic-bezier(0.4, 0, 1, 1)',
        'apple-out': 'cubic-bezier(0, 0, 0.2, 1)',
      },
      // 毛玻璃效果
      backdropBlur: {
        'apple': '20px',
        'apple-lg': '40px',
      },
      // 精细的字体粗细层次
      fontWeight: {
        'apple-regular': '400',
        'apple-medium': '500',
        'apple-semibold': '600',
      },
    },
  },
  // 说明：用于为 Markdown 等富文本提供更好的排版默认值（prose 系列类名）
  plugins: [require("@tailwindcss/typography")],
};

