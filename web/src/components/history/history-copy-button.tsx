// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback } from "react";
import { Copy as CopyIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button, type ButtonProps } from "@/components/ui/button";
import { copyTextCrossPlatform, type CopyTextOptions } from "@/lib/clipboard";

type HistoryCopyButtonProps = {
  text: string;
  label?: string;
  labelKey?: string;
  copyOptions?: CopyTextOptions;
  onCopyResult?: (success: boolean) => void;
  iconClassName?: string;
} & Omit<ButtonProps, "children" | "onClick">;

const HistoryCopyButton = React.forwardRef<HTMLButtonElement, HistoryCopyButtonProps>((props, ref) => {
  const { text, label, labelKey, copyOptions, onCopyResult, iconClassName, size, variant, className, ...rest } = props;
  const { t } = useTranslation(["history"]);

  // 统一组装复制提示文字，若未显式传入则默认使用 history:copyBlock
  const labelText = String(label ?? (labelKey ? t(labelKey) : t("history:copyBlock")) ?? "");

  const handleCopy = useCallback(async () => {
    const success = await copyTextCrossPlatform(text, {
      preferBrowser: true,
      ...(copyOptions ?? {})
    });
    if (onCopyResult) {
      onCopyResult(success);
    }
    return success;
  }, [copyOptions, onCopyResult, text]);

  return (
    <Button
      ref={ref}
      size={size ?? "icon"}
      variant={variant ?? "ghost"}
      className={className}
      title={labelText}
      aria-label={labelText}
      onClick={handleCopy}
      {...rest}
    >
      <CopyIcon className={iconClassName ?? "h-4 w-4"} />
    </Button>
  );
});

HistoryCopyButton.displayName = "HistoryCopyButton";

export type { HistoryCopyButtonProps };
export default HistoryCopyButton;

