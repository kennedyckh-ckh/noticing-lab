"use client";
import { useState } from "react";
import { api, errorMessage, type Me } from "@/lib/client/api";

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
    <main className="login-page">
      <section className="photo-panel" aria-label="Noticing Lab introduction">
        {/* A local public asset avoids external image services or API keys. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="classroom-photo" src="/images/login-photo.jpg" alt="" fetchPriority="high" />
        <div className="photo-shade" />
        <div className="photo-content">
          <p className="wordmark">Noticing Lab<span className="brand-dot" aria-hidden="true" /></p>
          <div className="photo-caption">
            <p className="eyebrow">A closer look at classroom learning</p>
            <h1>Look closely.<br />Interpret with evidence.<br />Learn together.</h1>
            <p className="photo-description">Video-based professional development for teachers</p>
          </div>
          <p className="photo-footer">Different perspectives. Shared inquiry.</p>
        </div>
      </section>
      <section className="form-panel" aria-labelledby="sign-in-heading">
        <div className="form-wrap">
          <p className="form-kicker">Your professional learning space</p>
          <h2 id="sign-in-heading">Welcome to Noticing Lab</h2>
          <p className="form-intro">Sign in to join your workshop.</p>
          <div className="sign-in-card">
            <form onSubmit={submit} aria-busy={busy}>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input id="email" name="email" type="email" autoComplete="username" autoCapitalize="none" spellCheck={false} required disabled={busy} value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="password">Password</label>
                <input id="password" name="password" type="password" autoComplete="current-password" required disabled={busy} value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              {error && <div className="login-error" role="alert">{error}</div>}
              <button className="sign-in-button" type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
                {!busy && <span aria-hidden="true">→</span>}
              </button>
              <p className="account-help">Accounts are created by your facilitator.<br />Forgot your password? Ask your facilitator.</p>
            </form>
          </div>
          {showDemo && (
            <aside className="demo-panel">
              <p><strong>Demo accounts (password: demo-pass-123)</strong></p>
              <p>facilitator@example.org · alex@example.org, bao@example.org (Group 1) · chen@, dev@ (Group 2) · eli@, fay@ (Group 3)</p>
              <p>Join code: DEMO42</p>
            </aside>
          )}
          <p className="form-footer">Notice · Reflect · Discuss</p>
        </div>
      </section>
      <style jsx>{`
        .login-page {
          --login-ink: #203d38;
          --login-teal: #236455;
          --login-muted: #61716b;
          --login-small: 0.8125rem;
          --login-body: 1rem;
          --login-title: clamp(1.5rem, 1.2rem + 0.8vw, 2rem);
          display: grid;
          grid-template-columns: 55% 45%;
          min-height: 100vh;
          min-height: 100svh;
          background: #f6f5ef;
          color: var(--login-ink);
        }
        .photo-panel { position: relative; min-height: 100%; overflow: hidden; background: #253b32; color: #fff; }
        .classroom-photo { position: absolute; width: 100%; height: 100%; object-fit: cover; object-position: 48% center; }
        .photo-shade { position: absolute; inset: 0; background: linear-gradient(180deg, rgba(9, 26, 21, .50) 0%, rgba(9, 26, 21, .08) 30%, rgba(9, 26, 21, .82) 100%); }
        .photo-content { position: relative; display: flex; flex-direction: column; justify-content: space-between; min-height: 100vh; min-height: 100svh; padding: clamp(2rem, 4vw, 4rem); gap: 3rem; }
        .wordmark { display: flex; align-items: center; gap: .625rem; font-size: 1.5rem; font-weight: 650; letter-spacing: -.035em; }
        .brand-dot { width: .5rem; height: .5rem; background: #c8dbc2; border-radius: 50%; }
        .photo-caption { margin-top: auto; max-width: 32rem; }
        .eyebrow { font-size: var(--login-small); letter-spacing: .11em; text-transform: uppercase; color: #e4eee4; margin-bottom: 1rem; }
        h1 { font-size: clamp(1.5rem, 1rem + 1.55vw, 2.25rem); line-height: 1.3; letter-spacing: -.035em; font-weight: 550; margin: 0; text-wrap: balance; }
        .photo-description { max-width: 24rem; margin-top: 1.25rem; font-size: var(--login-body); line-height: 1.65; color: #edf0e9; }
        .photo-footer { padding-top: 1.5rem; border-top: 1px solid rgba(255,255,255,.28); font-size: var(--login-small); color: #e0e9df; }
        .form-panel { display: flex; align-items: center; justify-content: center; padding: 3rem clamp(1.5rem, 4vw, 4rem); }
        .form-wrap { width: 100%; max-width: 26rem; }
        .form-kicker { font-size: var(--login-small); font-weight: 600; letter-spacing: .04em; color: var(--login-teal); margin-bottom: 1rem; }
        h2 { font-size: var(--login-title); font-weight: 600; letter-spacing: -.04em; line-height: 1.25; margin: 0; }
        .form-intro { color: var(--login-muted); font-size: var(--login-body); margin: .75rem 0 2rem; line-height: 1.6; }
        .sign-in-card { background: #fff; border: 1px solid #e1e6de; border-radius: 1rem; padding: 2rem; box-shadow: 0 8px 32px rgba(30,52,43,.035); }
        .field + .field { margin-top: 1.5rem; }
        label { display: block; font-size: .875rem; font-weight: 600; margin-bottom: .5rem; }
        input { display: block; width: 100%; min-height: 3.125rem; border: 1px solid #b8c6be; border-radius: .5rem; padding: .75rem .875rem; font: inherit; font-size: var(--login-body); color: var(--login-ink); background: #fff; transition: border-color .15s, box-shadow .15s; }
        input:focus { outline: none; border-color: var(--login-teal); box-shadow: 0 0 0 3px #e0eee6; }
        input:disabled { background: #f4f6f2; opacity: .8; }
        .sign-in-button { display: flex; justify-content: center; align-items: center; gap: .75rem; width: 100%; min-height: 3.125rem; margin-top: 1.75rem; background: var(--login-teal); color: #fff; border: 0; border-radius: .5rem; padding: .75rem 1rem; font: inherit; font-weight: 600; cursor: pointer; transition: background .15s; }
        .sign-in-button:hover:not(:disabled) { background: #184d40; }
        .sign-in-button:focus-visible { outline: 3px solid #236455; outline-offset: 4px; }
        .sign-in-button:disabled { opacity: .7; cursor: wait; }
        .account-help { margin-top: 1.5rem; text-align: center; font-size: var(--login-small); line-height: 1.7; color: var(--login-muted); }
        .login-error { margin-top: 1.25rem; border: 1px solid #e4b7b1; background: #fff3f0; color: #9a2727; padding: .875rem; border-radius: .5rem; font-size: .875rem; }
        .form-footer { text-align: center; color: var(--login-muted); font-size: var(--login-small); margin-top: 2rem; letter-spacing: .08em; }
        .demo-panel { margin-top: 1.5rem; padding: 1rem; border-radius: .5rem; background: #e8eee4; font-size: var(--login-small); line-height: 1.6; overflow-wrap: anywhere; }
        .demo-panel p + p { margin-top: .5rem; }
        @media (max-width: 900px) {
          .login-page { grid-template-columns: 1fr; }
          .photo-panel { min-height: auto; }
          .photo-content { min-height: 19rem; padding: 1.5rem; gap: 2rem; }
          .classroom-photo { object-position: center 55%; }
          .photo-caption { margin-top: 0; }
          .eyebrow, .photo-footer { display: none; }
          h1 { font-size: 1.5rem; line-height: 1.25; }
          .photo-description { font-size: .875rem; margin-top: .75rem; }
          .form-panel { padding: 2rem 1.25rem; }
          .form-intro { margin-bottom: 1.5rem; }
          .sign-in-card { padding: 1.5rem; }
          .form-footer { margin-top: 1.5rem; }
        }
        @media (prefers-reduced-motion: reduce) { input, .sign-in-button { transition: none; } }
      `}</style>
    </main>
  );
}
