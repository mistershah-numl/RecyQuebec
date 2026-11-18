import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getProfile, updateProfile } from "@/lib/jobs.functions";

export const Route = createFileRoute("/_authenticated/profile/")({
  head: () => ({
    meta: [
      { title: "Profile — RECYC Contact OSINT" },
      { name: "description", content: "Manage your RECYC Contact OSINT account details." },
      { property: "og:title", content: "Profile — RECYC Contact OSINT" },
      { property: "og:description", content: "Update your display name and account details." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ProfilePage,
});

function ProfilePage() {
  const fetchProfile = useServerFn(getProfile);
  const save = useServerFn(updateProfile);
  const { data, refetch } = useQuery({ queryKey: ["profile"], queryFn: () => fetchProfile() });
  const [fullName, setFullName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) setFullName((data as any).full_name ?? "");
  }, [data]);

  return (
    <AppShell title="Profile" description="Your account details">
      <Card className="max-w-lg">
        <CardHeader>
          <CardTitle className="text-base">Account</CardTitle>
          <CardDescription>{(data as any)?.email ?? ""}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Full name</Label>
            <Input id="name" value={fullName} maxLength={120} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <Button
            disabled={saving || !fullName.trim()}
            onClick={async () => {
              setSaving(true);
              try {
                await save({ data: { full_name: fullName.trim() } });
                await refetch();
                toast.success("Profile updated.");
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Save profile"}
          </Button>
        </CardContent>
      </Card>
    </AppShell>
  );
}
