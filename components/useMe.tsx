"use client";
import { useCallback, useEffect, useState } from "react";
import { api, type Me } from "@/lib/client/api";
import { Button, Shell } from "@/components/ui";

export function useMe() {
  const [me, setMe] = useState<Me["user"] | null>(null);
  useEffect(() => {
    api<Me>("GET", "/api/auth/me")
      .then((r) => setMe(r.user))
      .catch(() => undefined); // api() redirects to /login on 401
  }, []);
  return me;
}

export function SignOut() {
  const out = useCallback(async () => {
    await api("POST", "/api/auth/logout").catch(() => undefined);
    window.location.href = "/login";
  }, []);
  return (
    <Button variant="ghost" size="sm" className="text-white hover:bg-white/10" onClick={out}>
      Sign out
    </Button>
  );
}

export function PageLoading({ label = "Loading" }: { label?: string }) {
  return (
    <Shell>
      <p className="py-16 text-center text-slate-600">{label}...</p>
    </Shell>
  );
}
