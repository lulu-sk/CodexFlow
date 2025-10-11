// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2025 Lulu (GitHub: lulu-sk, https://github.com/lulu-sk)

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { fetchRemoteAbout, LOCAL_DEFAULT_ABOUT, type AboutData, type DonateItem, checkForUpdate, type UpdateCheck } from "@/lib/about";
import { CANONICAL_DONATION_ITEMS } from "@/lib/donate";

const TEXT_ONLY_DONATION_NAMES = new Set(["支付宝", "微信"]);
const PROJECT_HOMEPAGE_URL = "https://github.com/lulu-sk/CodexFlow";

type Props = {
  onCheckUpdate?: (payload: { result: UpdateCheck; resolvedNotes?: string }) => void;
};

export function AboutSupport(props: Props) {
  const { t, i18n } = useTranslation("about");
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<AboutData>(LOCAL_DEFAULT_ABOUT);
  const [dataSource, setDataSource] = useState<'network' | 'cache' | 'local'>("local");
  const [version, setVersion] = useState<string>("");
  const [licensePath, setLicensePath] = useState<string>("");
  const [noticePath, setNoticePath] = useState<string>("");
  const [donateDialogOpen, setDonateDialogOpen] = useState(false);
  const [donateSelected, setDonateSelected] = useState<DonateItem | null>(null);
  const [homepageDialogOpen, setHomepageDialogOpen] = useState(false);
  const isImageOnly = donateSelected ? (TEXT_ONLY_DONATION_NAMES.has(donateSelected.name) && Boolean(donateSelected.image)) : false;
  const normalizedLanguage = useMemo(() => {
    const raw = String(i18n.language || "").toLowerCase();
    const base = raw.split("-")[0] || raw;
    return { raw, base };
  }, [i18n.language]);
  const resolveLocalizedText = useCallback(
    (locales?: Record<string, string>, fallback?: string) => {
      if (locales && typeof locales === "object") {
        if (normalizedLanguage.raw && locales[normalizedLanguage.raw]) return locales[normalizedLanguage.raw];
        if (normalizedLanguage.base && locales[normalizedLanguage.base]) return locales[normalizedLanguage.base];
        const first = Object.values(locales)[0];
        if (first) return first;
      }
      return fallback || "";
    },
    [normalizedLanguage]
  );

  const fallbackParagraphs = useMemo(() => {
    const paras = t("content.paragraphs", { returnObjects: true });
    return Array.isArray(paras) ? paras.filter((p) => typeof p === "string") as string[] : [];
  }, [t, normalizedLanguage.raw]);
  const formatDonateName = useCallback((item?: DonateItem | null) => {
    if (!item) return "";
    const localizedByRemote = resolveLocalizedText(item.nameLocales, item.name);
    if (localizedByRemote) return localizedByRemote;
    if (item.name === "支付宝") return t("donate.channels.alipay");
    if (item.name === "微信") return t("donate.channels.wechat");
    if (item.name === "PayPal.me") return t("donate.channels.paypal");
    return item.name;
  }, [resolveLocalizedText, t]);
  const selectedDonateName = useMemo(() => formatDonateName(donateSelected) || donateSelected?.name || "", [donateSelected, formatDonateName, normalizedLanguage.raw]);
  const donateDescription = t("donate.description");
  const showDonateDescription = donateDescription && donateDescription !== "donate.description";
  const resolvedRemoteHtml = useMemo(() => {
    const map = data.aboutHtmlLocales;
    const fallbackHtml = dataSource !== "local" ? String(data.aboutHtml || "").trim() : "";
    if (map && Object.keys(map).length > 0) {
      const preferred = resolveLocalizedText(map, undefined);
      if (preferred) return preferred;
      if (data.aboutHtmlLocale && map[data.aboutHtmlLocale]) return map[data.aboutHtmlLocale];
      return fallbackHtml;
    }
    return fallbackHtml;
  }, [data.aboutHtml, data.aboutHtmlLocale, data.aboutHtmlLocales, dataSource, resolveLocalizedText]);
  const shouldUseFallbackContent = !resolvedRemoteHtml;

  useEffect(() => {
    (async () => {
      try { setVersion(await window.host.app.getVersion()); } catch {}
      try { const p = await window.host.app.getPaths(); setLicensePath(String(p.licensePath || '')); setNoticePath(String(p.noticePath || '')); } catch {}
      try {
        setLoading(true);
        const res = await fetchRemoteAbout({ force: false });
        setData(res.data);
        setDataSource(res.from);
      } catch {
        setData(LOCAL_DEFAULT_ABOUT);
        setDataSource("local");
      } finally { setLoading(false); }
    })();
  }, []);

  return (
    <div className="p-2">
      <Card>
        <CardContent className="space-y-3">
          <div className="text-sm text-slate-600">
            {shouldUseFallbackContent ? (
              <div className="prose prose-sm max-w-none">
                <h2>{t("content.heading")}</h2>
                {fallbackParagraphs.map((p, idx) => (
                  <p key={idx}>{p}</p>
                ))}
              </div>
            ) : (
              <div className="prose prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: resolvedRemoteHtml }} />
            )}
          </div>

          <div className="flex justify-end">
            <div className="text-xs text-slate-500">{version ? `v${version}` : ''}</div>
          </div>

          <Separator />

          <div className="flex flex-wrap gap-2 items-center">
            <Button size="sm" variant="secondary" onClick={async () => { try { if (licensePath) await window.host.utils.openPath(licensePath); } catch {} }}>
              {t("actions.openLicense")}
            </Button>
            <Button size="sm" variant="secondary" onClick={async () => { try { if (noticePath) await window.host.utils.openPath(noticePath); } catch {} }}>
              {t("actions.openNotice")}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { setHomepageDialogOpen(true); }}>
              {t("actions.openHomepage")}
            </Button>

            <Button size="sm" variant="outline" onClick={async () => {
              try {
                const v = version || '';
                // 点击检查更新时顺便刷新 about 信息
                setLoading(true);
                const refresh = await fetchRemoteAbout({ force: true }).catch(() => null);
                if (refresh && refresh.data) { setData(refresh.data); setDataSource(refresh.from); }
                const res = await checkForUpdate(v, { force: true });
                if (props.onCheckUpdate) {
                  const resolvedNotes = res.latest ? resolveLocalizedText(res.latest.notesLocales, res.latest.notes) : undefined;
                  props.onCheckUpdate({ result: res, resolvedNotes });
                }
              } catch {} finally { setLoading(false); }
            }}>
              {loading ? t("actions.checking") : t("actions.check")}
            </Button>
          </div>

          <Separator />

          <div>
            <div className="flex items-start justify-between mb-2 gap-3">
              <div>
                <div className="text-sm font-medium">{t("donate.sectionTitle")}</div>
                {showDonateDescription ? <div className="mt-1 text-xs text-slate-500">{donateDescription}</div> : null}
              </div>
              {data.integrity?.donationSignatureValid === false ? (
                <div className="text-xs text-red-500 whitespace-nowrap">{t("donate.signatureInvalid")}</div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {/* 默认展示固定三项：支付宝、微信、PayPal；核心渠道不可被远端覆盖 */}
              {(data.donate && data.donate.length > 0 ? data.donate.slice(0, 6) : Array.from(CANONICAL_DONATION_ITEMS)).map((d, idx) => (
                <Button key={idx} size="sm" variant="outline" onClick={(e) => { e.preventDefault(); setDonateSelected(d); setDonateDialogOpen(true); }}>
                  {d.image && !TEXT_ONLY_DONATION_NAMES.has(d.name) ? <img src={d.image} alt={formatDonateName(d) || d.name} className="h-5 w-5 inline-block mr-2 align-middle" /> : null}
                  <span className="align-middle">{formatDonateName(d) || d.name}</span>
                </Button>
              ))}
          </div>
          </div>

          {data.announces && data.announces.length > 0 && (
            <div>
              <Separator className="my-2" />
              <div className="text-sm font-medium mb-2">{t("announce.sectionTitle")}</div>
              <ScrollArea className="h-36 border rounded">
                <div className="p-2 space-y-2">
                  {data.announces.map((a) => (
                    <div key={a.id} className="text-sm text-slate-700">
                      <span className="mr-2 text-slate-400">[{a.id}]</span>
                      <span>{resolveLocalizedText(a.textLocales, a.text)}</span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          <Separator />

          <div className="text-xs text-slate-500">
            {t("privacy")}
          </div>
        </CardContent>
      </Card>

      <Dialog open={homepageDialogOpen} onOpenChange={setHomepageDialogOpen}>
        <DialogContent className="w-[320px] sm:w-[360px]">
          <DialogHeader>
            <DialogTitle>{t("actions.openHomepage")}</DialogTitle>
            <DialogDescription>{t("homepage.dialogOpenLinkHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setHomepageDialogOpen(false); }}>
              {t("common:cancel")}
            </Button>
            <Button onClick={async () => {
              try {
                await window.host.utils.openExternalUrl(PROJECT_HOMEPAGE_URL);
              } catch {} finally {
                setHomepageDialogOpen(false);
              }
            }}>
              {t("homepage.dialogOpenLink")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 捐赠弹窗：显示二维码或跳转链接 */}
      <Dialog open={donateDialogOpen} onOpenChange={setDonateDialogOpen}>
        <DialogContent className="w-[320px] sm:w-[360px] p-0 overflow-hidden">
          {donateSelected ? (
            isImageOnly ? (
              <div className="w-full">
                <img src={donateSelected.image} alt={t("donate.dialogImageAlt", { name: selectedDonateName || donateSelected.name || "" })} className="block w-full h-auto object-contain" />
              </div>
            ) : (
              <div className="px-5 py-5">
                <DialogHeader className="mb-4">
                  <DialogTitle>{selectedDonateName || t("donate.dialogTitle")}</DialogTitle>
                </DialogHeader>
                <div className="space-y-3">
                  {donateSelected.url ? (
                    <div className="space-y-3">
                      <div className="text-sm text-slate-600">{t("donate.dialogOpenLinkHint")}</div>
                      <div className="flex justify-end">
                        <Button onClick={() => { try { window.host.utils.openExternalUrl(String(donateSelected.url)); } catch {} }}>
                          {t("donate.dialogOpenLink")}
                        </Button>
                      </div>
                    </div>
                  ) : donateSelected.image ? (
                    <div className="flex items-center justify-center">
                      <img src={donateSelected.image} alt={t("donate.dialogImageAlt", { name: selectedDonateName || donateSelected.name || "" })} className="h-72 w-72 object-contain" />
                    </div>
                  ) : (
                    <div className="h-48 w-48 bg-slate-100 border rounded mx-auto flex items-center justify-center">{t("donate.defaultPlaceholder")}</div>
                  )}
                </div>
              </div>
            )
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default AboutSupport;
