// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import * as React from 'react';
import { cn } from '@/lib/utils';

export function Label(props: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('text-sm text-[var(--cf-text-secondary)]', props.className)} {...props} />;
}

