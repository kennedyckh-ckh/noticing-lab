"use client";
import { useState } from "react";
import { api, errorMessage, type Me } from "@/lib/client/api";
import { Banner, Button, Card, Label, Shell, inputClass } from "@/components/ui";
import { SignOut, useMe } from "@/components/useMe";

export default function ChangePasswordPage() {
  const me = useMe();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== again) return setError("The two new passwords do not match");
    setBusy(true);
    try {
      await api("POST", "/api/auth/change-password", { current, next });
      const r = await api<Me>("GET", "/api/auth/me");
      window.location.href = r.user.role === "facilitator" ? "/facilitator" : "/";
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Shell right={<SignOut />} title="Choose a new password">
      <div className="mx-auto max-w-md">
        <Card title="Choose a new password" subtitle={me?.must_change_password ? "Your facilitator gave you a temporary password. Please replace it before you continue." : undefined}>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label htmlFor="cur">Current (temporary) password</Label>
              <input id="cur" type="password" autoComplete="current-password" required className={inputClass} value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="new" hint="At least 8 characters">
                New password
              </Label>
              <input id="new" type="password" autoComplete="new-password" required minLength={8} className={inputClass} value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="again">New password again</Label>
              <input id="again" type="password" autoComplete="new-password" required className={inputClass} value={again} onChange={(e) => setAgain(e.target.value)} />
            </div>
            {error && <Banner tone="red">{error}</Banner>}
            <Button type="submit" loading={busy}>
              Save new password
            </Button>
          </form>
        </Card>
      </div>
    </Shell>
  );
}
