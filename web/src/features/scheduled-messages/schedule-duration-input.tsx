// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";
import { DURATION_UNITS, MAX_SCHEDULE_DELAY_MS, type ScheduleDuration } from "./schedule-time";

type Props = {
  label: string;
  value: ScheduleDuration;
  disabled?: boolean;
  onChange(value: ScheduleDuration): void;
};

/** 延迟、循环和追加共用可直接输入的时长控件，支持键盘调整数值与单位。 */
export function ScheduleDurationInput({ label, value, disabled, onChange }: Props) {
  const { t } = useTranslation("terminal");
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Input type="number" inputMode="numeric" min={1} max={MAX_SCHEDULE_DELAY_MS / DURATION_UNITS[value.unit]} step={1} aria-label={label} value={value.amount} disabled={disabled} className="min-w-0 flex-1 tabular-nums" onChange={(event) => onChange({ ...value, amount: event.target.value })} />
      <select aria-label={t("schedule.durationUnit", { name: label })} value={value.unit} disabled={disabled} className="h-10 rounded-apple border border-[var(--cf-border)] bg-[var(--cf-surface-solid)] px-3 text-sm text-[var(--cf-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-accent)] disabled:opacity-40" onChange={(event) => onChange({ ...value, unit: event.target.value as ScheduleDuration["unit"] })}>
        {Object.keys(DURATION_UNITS).map((unit) => <option key={unit} value={unit}>{t(`schedule.unit.${unit}`)}</option>)}
      </select>
    </div>
  );
}
