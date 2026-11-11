"use client";
import { useState } from "react";
import { api, errorMessage, type Me } from "@/lib/client/api";
import { Banner, Button, Card, Label, inputClass } from "@/components/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showDemo = process.env.NEXT_PUBLIC_SHOW_DEMO === "1";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<Me>("POST", "/api/auth/login", { email, password });
      window.location.href = r.user.must_change_password ? "/change-password" : r.user.role === "facilitator" ? "/facilitator" : "/";
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-800 via-blue-700 to-violet-800 p-5">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center text-white">
          <h1 className="text-3xl font-semibold tracking-tight">Noticing Lab</h1>
          <p className="mt-1 text-blue-100">Video-based professional development for teachers</p>
        </div>
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <input id="email" type="email" autoComplete="username" required className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <input id="password" type="password" autoComplete="current-password" required className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error && <Banner tone="red">{error}</Banner>}
            <Button type="submit" loading={busy} className="w-full">
              Sign in
            </Button>
            <p className="text-center text-xs text-slate-500">Accounts are created by your facilitator. Forgot your password? Ask your facilitator.</p>
          </form>
        </Card>
        {showDemo && (
          <div className="mt-4 rounded-xl bg-white/10 p-4 text-sm text-blue-50">
            <p className="font-medium">Demo accounts (password: demo-pass-123)</p>
            <p className="mt-1">facilitator@example.org &middot; alex@example.org, bao@example.org (Group 1) &middot; chen@, dev@ (Group 2) &middot; eli@, fay@ (Group 3)</p>
            <p className="mt-1">Join code: DEMO42</p>
          </div>
        )}
      </div>
    </div>
  );
}
