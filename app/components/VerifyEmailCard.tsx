"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { writeSessionToken } from "@/app/lib/session";

type Stage = { name: "email" } | { name: "code"; email: string };

const inputClass =
  "w-full rounded-xl border border-border-subtle bg-surface-muted px-4 py-3 text-base " +
  "text-foreground outline-none transition placeholder:text-muted/70 " +
  "focus:border-frost focus:ring-2 focus:ring-frost/30 disabled:opacity-60";

const primaryButtonClass =
  "w-full rounded-full bg-citrus px-5 py-3 text-base font-semibold text-white transition " +
  "hover:bg-citrus-strong focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-citrus disabled:cursor-not-allowed disabled:opacity-60";

export function VerifyEmailCard() {
  const router = useRouter();
  const requestCode = useAction(api.verification.requestCode);
  const verifyCode = useAction(api.verification.verifyCode);

  const [stage, setStage] = useState<Stage>({ name: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  // Set once the code is accepted and stays set: the redirect is in flight and
  // the form must not accept another submission before this screen unmounts.
  const [redirecting, setRedirecting] = useState(false);

  // Drives the resend button's countdown.
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  async function sendCode(address: string, isResend: boolean) {
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await requestCode({ email: address });
      if (!result.ok) {
        setError("That doesn't look like an email address.");
        return;
      }
      setCooldown(result.cooldownSeconds);
      setStage({ name: "code", email: address });
      if (isResend) setNotice("Sent. Check your inbox again.");
    } catch {
      setError("Something went wrong sending that. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  async function onSubmitEmail(event: React.FormEvent) {
    event.preventDefault();
    await sendCode(email, false);
  }

  async function onSubmitCode(event: React.FormEvent) {
    event.preventDefault();
    if (stage.name !== "code") return;

    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await verifyCode({ email: stage.email, code });
      if (result.status === "verified") {
        if (result.sessionToken === undefined) {
          setError("We couldn't start your session. Try that code again.");
          return;
        }
        writeSessionToken(result.sessionToken);
        setRedirecting(true);
        router.replace(result.onboarded === true ? "/home" : "/onboarding");
        return;
      }
      const status = result.status;
      setError(
        status === "expired"
          ? "That code has expired. Send yourself a new one."
          : status === "too_many_attempts"
            ? "Too many attempts on that code. Request a new one."
            : "That code isn't right. Check it and try again.",
      );
    } catch {
      setError("Something went wrong checking that. Try again in a moment.");
    } finally {
      setPending(false);
    }
  }

  if (stage.name === "code") {
    return (
      <Card>
        <h2 className="text-2xl font-semibold tracking-tight">Check your email</h2>
        <p className="mt-3 text-muted">
          We sent a 6-digit code to{" "}
          <span className="font-medium text-foreground">{stage.email}</span>.
        </p>

        <form onSubmit={onSubmitCode} className="mt-6 space-y-4">
          <div>
            <label htmlFor="code" className="mb-2 block text-sm font-medium">
              Verification code
            </label>
            <input
              id="code"
              name="code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              required
              disabled={pending}
              autoFocus
              className={`${inputClass} text-center font-mono text-2xl tracking-[0.4em]`}
            />
          </div>

          <Feedback error={error} notice={notice} />

          <button
            type="submit"
            disabled={pending || redirecting || code.length < 6}
            className={primaryButtonClass}
          >
            {redirecting ? "Taking you in…" : pending ? "Checking…" : "Verify email"}
          </button>
        </form>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm">
          <button
            type="button"
            onClick={() => sendCode(stage.email, true)}
            disabled={pending || redirecting || cooldown > 0}
            className="font-medium text-frost underline-offset-4 hover:underline disabled:text-muted disabled:no-underline"
          >
            {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStage({ name: "email" });
              setCode("");
              setError(null);
              setNotice(null);
            }}
            className="text-muted underline-offset-4 hover:underline"
          >
            Use a different email
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="text-2xl font-semibold tracking-tight">Get on the list</h2>
      <p className="mt-3 text-muted">
        Drop in your email and we&rsquo;ll send a code to confirm it&rsquo;s really yours.
        No password, no account.
      </p>

      <form onSubmit={onSubmitEmail} className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className="mb-2 block text-sm font-medium">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            required
            disabled={pending}
            className={inputClass}
          />
        </div>

        <Feedback error={error} notice={notice} />

        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending ? "Sending…" : "Send me a code"}
        </button>
      </form>

      <p className="mt-4 text-xs text-muted">
        We only use this to email you about frigid. Unsubscribe any time.
      </p>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-full max-w-md rounded-3xl border border-border-subtle bg-surface p-8 shadow-sm sm:p-10">
      {children}
    </div>
  );
}

function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
  if (error === null && notice === null) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={`text-sm ${error !== null ? "text-danger" : "text-frost"}`}
    >
      {error ?? notice}
    </p>
  );
}
