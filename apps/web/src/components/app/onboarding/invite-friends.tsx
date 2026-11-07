"use client";

import { CheckIcon, CopyIcon, MailIcon, QrCodeIcon, Share2Icon } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";
import { QrCode } from "@/components/app/settings/two-factor-settings";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmt } from "@/lib/i18n";
import { useMessages } from "@/lib/i18n/client";

/** Opening it signs the visitor up (if needed) and lands on Add Friend with this code prefilled. */
const friendLink = (origin: string, userId: string) => `${origin}/app?add=${encodeURIComponent(userId)}`;

const noSubscribe = () => () => {};
const enc = encodeURIComponent;

/** Every way to hand out your friend link: copy, native share, messengers, a Discord-ready message and a QR code. */
export function InviteFriends({ userId }: { userId: string }) {
  const t = useMessages().onboarding;
  const id = useId();
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => "");
  const canShare = useSyncExternalStore(noSubscribe, () => typeof navigator.share === "function", () => false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [qr, setQr] = useState(false);
  const link = friendLink(origin, userId);
  const text = fmt(t.shareText, { link });

  async function copy(value: string, onDone: () => void) {
    try {
      await navigator.clipboard.writeText(value);
      onDone();
    } catch {
      setNotice({ ok: false, text: t.copyFailed });
    }
  }

  const channels = [
    { name: "WhatsApp", href: `https://wa.me/?text=${enc(text)}` },
    { name: "Telegram", href: `https://t.me/share/url?url=${enc(link)}&text=${enc(fmt(t.shareText, { link: "" }).trim())}` },
    { name: "X", href: `https://x.com/intent/post?text=${enc(text)}` },
  ];
  const outline = buttonVariants({ variant: "outline" });

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-link`}>{t.yourLink}</Label>
        <div className="flex gap-2">
          <Input id={`${id}-link`} value={link} readOnly onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1" />
          <Button onClick={() => void copy(link, () => { setCopied(true); setNotice(null); window.setTimeout(() => setCopied(false), 2000); })}>
            {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}{copied ? t.copied : t.copy}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => void copy(fmt(t.discordText, { link }), () => setNotice({ ok: true, text: t.discordCopied }))}>
          <CopyIcon aria-hidden />{t.copyForDiscord}
        </Button>
        {canShare && (
          <Button variant="outline" onClick={() => void navigator.share({ title: t.emailSubject, text: fmt(t.shareText, { link: "" }).trim(), url: link }).catch(() => {})}>
            <Share2Icon aria-hidden />{t.share}
          </Button>
        )}
        {channels.map((c) => (
          <a key={c.name} href={c.href} target="_blank" rel="noopener noreferrer" className={outline}>{c.name}</a>
        ))}
        <a href={`mailto:?subject=${enc(t.emailSubject)}&body=${enc(text)}`} className={outline}><MailIcon aria-hidden />{t.email}</a>
        <Button variant="outline" aria-expanded={qr} onClick={() => setQr((v) => !v)}>
          <QrCodeIcon aria-hidden />{qr ? t.hideQr : t.showQr}
        </Button>
      </div>
      {qr && origin && <QrCode value={link} label={t.qrLabel} />}
      {notice && <p role={notice.ok ? "status" : "alert"} className={`text-sm ${notice.ok ? "text-success" : "text-destructive"}`}>{notice.text}</p>}
    </div>
  );
}
