import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Send } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getEmailSettings, listTemplates, sendCampaign } from "@/lib/outreach.functions";
import { DEFAULT_TEMPLATE, MERGE_FIELDS, mergeDataFor, renderTemplate } from "@/lib/template";

export type EmailRecipient = {
  email: string;
  company_name?: string | null;
  contact_name?: string | null;
  title?: string | null;
  phone?: string | null;
  city?: string | null;
  domain?: string | null;
  crm_contact_id?: string | null;
  job_id?: string | null;
};

/** Compose + send a mass email to the selected contacts. */
export function SendEmailDialog({
  open,
  onOpenChange,
  recipients,
  onSent,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  recipients: EmailRecipient[];
  onSent?: () => void;
}) {
  const fetchTemplates = useServerFn(listTemplates);
  const fetchSettings = useServerFn(getEmailSettings);
  const send = useServerFn(sendCampaign);

  const { data: templates } = useQuery({
    queryKey: ["email-templates"],
    queryFn: () => fetchTemplates(),
    enabled: open,
  });
  const { data: settings } = useQuery({
    queryKey: ["email-settings"],
    queryFn: () => fetchSettings(),
    enabled: open,
  });

  const [templateId, setTemplateId] = useState<string>("none");
  const [subject, setSubject] = useState(DEFAULT_TEMPLATE.subject);
  const [body, setBody] = useState(DEFAULT_TEMPLATE.body);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (templateId === "none") return;
    const t = (templates?.rows ?? []).find((x: any) => x.id === templateId);
    if (t) {
      setSubject(t.subject);
      setBody(t.body);
    }
  }, [templateId, templates]);

  const valid = useMemo(
    () => recipients.filter((r) => r.email && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(r.email)),
    [recipients],
  );
  const preview = valid[0];
  const dryRun = (settings as any)?.email_dry_run !== false;

  async function onSend() {
    setSending(true);
    try {
      const res: any = await send({
        data: {
          recipients: valid,
          subject,
          body,
          template_id: templateId === "none" ? null : templateId,
        },
      });
      toast.success(
        res.dry_run
          ? `Test mode: ${res.sent} email(s) rendered and logged, nothing was sent.`
          : `${res.sent} email(s) sent${res.failed ? `, ${res.failed} failed` : ""}.`,
      );
      onOpenChange(false);
      onSent?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send email to {valid.length} contact(s)</DialogTitle>
          <DialogDescription>
            {recipients.length !== valid.length
              ? `${recipients.length - valid.length} selected row(s) have no usable email address and will be skipped. `
              : ""}
            {dryRun
              ? "Test mode is ON — messages are rendered and logged but not delivered. Turn it off in API Settings when you are ready."
              : "Live mode — messages go out through your configured SMTP server."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Template</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger>
                <SelectValue placeholder="Start from scratch" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Start from scratch</SelectItem>
                {(templates?.rows ?? []).map((t: any) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input id="subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="body">Message</Label>
            <Textarea id="body" rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Merge fields: {MERGE_FIELDS.map((f) => `{{${f}}}`).join(" · ")}
            </p>
          </div>

          {preview ? (
            <div className="rounded-lg border border-border p-3 text-sm">
              <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
                Preview for {preview.email}
              </p>
              <p className="font-medium break-words">{renderTemplate(subject, mergeDataFor(preview))}</p>
              <p className="mt-2 whitespace-pre-wrap break-words text-muted-foreground">
                {renderTemplate(body, mergeDataFor(preview))}
              </p>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={onSend} disabled={sending || valid.length === 0}>
            {sending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
            {dryRun ? "Run test send" : `Send ${valid.length} email(s)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
