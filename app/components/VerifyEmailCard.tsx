"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { writeSessionToken } from "@/app/lib/session";
import { Feedback, cardClass, inputClass, primaryButtonClass } from "./ui";

type Stage = { name: "email" } | { name: "code"; email: string };

const CODE_LENGTH = 6;

export function VerifyEmailCard() {
  const router = useRouter();
  const requestCode = useAction(api.verification.requestCode);
  const verifyCode = useAction(api.verification.verifyCode);

  const [stage, setStage] = useState<Stage>({ name: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codeFocused, setCodeFocused] = useState(true);
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
        <h2 className="text-2xl font-semibold tracking-[-0.02em]">Check your email</h2>
        <p className="mt-2.5 text-[15px] leading-relaxed text-muted">
          We sent a 6-digit code to{" "}
          <span className="font-medium text-foreground">{stage.email}</span>.
        </p>

        <form onSubmit={onSubmitCode} className="mt-6 space-y-4">
          <label htmlFor="code" className="sr-only">
            Verification code
          </label>
          {/* One real input laid invisibly over six display boxes, so paste,
              autofill and the one-time-code keyboard all keep working. */}
          <div className="relative">
            <div aria-hidden className="flex justify-between gap-2.5">
              {Array.from({ length: CODE_LENGTH }, (_, i) => {
                const caret = codeFocused && !pending && i === code.length;
                return (
                  <div
                    key={i}
                    className={`flex h-[60px] flex-1 items-center justify-center rounded-2xl font-mono text-2xl font-medium ${
                      caret
                        ? "border-2 border-action bg-surface"
                        : "border border-border-subtle bg-background"
                    }`}
                  >
                    {code[i] ?? (caret ? <span className="animate-pulse text-subtle">|</span> : null)}
                  </div>
                );
              })}
            </div>
            <input
              id="code"
              name="code"
              value={code}
              onChange={(e) =>
                setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))
              }
              onFocus={() => setCodeFocused(true)}
              onBlur={() => setCodeFocused(false)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={CODE_LENGTH}
              required
              disabled={pending}
              autoFocus
              className="absolute inset-0 h-full w-full cursor-text opacity-0"
            />
          </div>

          <Feedback error={error} notice={notice} />

          <button
            type="submit"
            disabled={pending || redirecting || code.length < CODE_LENGTH}
            className={`${primaryButtonClass} w-full`}
          >
            {redirecting ? "Taking you in…" : pending ? "Checking…" : "Verify email"}
          </button>
        </form>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
          <button
            type="button"
            onClick={() => sendCode(stage.email, true)}
            disabled={pending || redirecting || cooldown > 0}
            className="text-action underline-offset-4 hover:underline disabled:text-subtle disabled:no-underline"
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
            className="text-action underline-offset-4 hover:underline"
          >
            Use a different email
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="text-2xl font-semibold tracking-[-0.02em]">Get on the list</h2>
      <p className="mt-2.5 text-[15px] leading-relaxed text-muted">
        Drop in your email and we&rsquo;ll send a code to confirm it&rsquo;s really yours.
        No password, no account.
      </p>

      <form onSubmit={onSubmitEmail} className="mt-6 flex flex-col gap-3">
        <label htmlFor="email" className="text-[13px] font-medium">
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

        <Feedback error={error} notice={notice} />

        <button type="submit" disabled={pending} className={`${primaryButtonClass} w-full`}>
          {pending ? "Sending…" : "Send me a code"}
        </button>
      </form>

      <p className="mt-3.5 text-xs text-subtle">
        We only use this to email you about frigid. Unsubscribe any time.
      </p>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className={`w-full max-w-[420px] ${cardClass}`}>{children}</div>;
}
