"use client";

import { useEffect, useRef, useState } from "react";
import { RecaptchaVerifier, signInWithPhoneNumber, type ConfirmationResult } from "firebase/auth";
import { auth } from "@/lib/firebase";

export function AuthModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState<ConfirmationResult | null>(null);
  const verifier = useRef<RecaptchaVerifier | null>(null);
  const verifying = useRef(false);

  useEffect(() => {
    if (!open) return;
    return () => {
      verifier.current?.clear();
      verifier.current = null;
    };
  }, [open]);

  async function ensureVerifier() {
    if (verifier.current) return verifier.current;
    const container = document.getElementById("next-recaptcha");
    if (container) container.innerHTML = "";
    verifier.current = new RecaptchaVerifier(auth, "next-recaptcha", { size: "invisible" });
    await verifier.current.render();
    return verifier.current;
  }

  async function sendOtp() {
    const clean = phone.replace(/\D/g, "").slice(-10);
    if (!/^[6-9]\d{9}$/.test(clean)) {
      alert("Enter a valid mobile number");
      return;
    }
    setBusy(true);
    try {
      const result = await signInWithPhoneNumber(auth, `+91${clean}`, await ensureVerifier());
      setConfirmation(result);
      setOtp("");
      startOtpAutofill();
    } catch (error) {
      verifier.current?.clear();
      verifier.current = null;
      alert(error instanceof Error ? error.message : "Unable to send OTP");
    } finally {
      setBusy(false);
    }
  }

  async function verify(code = otp) {
    if (!confirmation || verifying.current || !/^\d{6}$/.test(code)) return;
    verifying.current = true;
    setBusy(true);
    try {
      await confirmation.confirm(code);
      onClose();
    } catch {
      alert("Wrong OTP. Please try again.");
    } finally {
      verifying.current = false;
      setBusy(false);
    }
  }

  async function startOtpAutofill() {
    if (!("OTPCredential" in window)) return;
    try {
      const controller = new AbortController();
      window.setTimeout(() => controller.abort(), 60000);
      const credential = await navigator.credentials.get({
        otp: { transport: ["sms"] },
        signal: controller.signal
      } as CredentialRequestOptions);
      const code = (credential as unknown as { code?: string })?.code;
      if (code) {
        setOtp(code);
        verify(code);
      }
    } catch {
      // Browser support is best-effort only.
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] grid place-items-center bg-black/70 p-4 backdrop-blur-xl">
      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-[#07111f] p-5 shadow-glow">
        <h2 className="text-xl font-black">Secure Login</h2>
        <p className="mt-1 text-sm text-white/60">OTP login with invisible security check.</p>
        <div id="next-recaptcha" className="pointer-events-none absolute h-px w-px overflow-hidden opacity-0" />
        <label className="mt-5 block text-xs font-black uppercase text-white/55">Mobile number</label>
        <div className="mt-2 flex rounded-2xl border border-white/10 bg-white/[.06]">
          <span className="grid w-14 place-items-center text-sm font-black">+91</span>
          <input
            value={phone}
            onChange={(event) => setPhone(event.target.value.replace(/\D/g, "").slice(0, 10))}
            inputMode="numeric"
            autoComplete="tel"
            className="h-12 min-w-0 flex-1 bg-transparent px-3 font-bold outline-none"
            placeholder="10 digit number"
          />
        </div>
        <button disabled={busy} onClick={sendOtp} className="mt-4 h-12 w-full rounded-full bg-brand font-black text-white disabled:opacity-50">
          {busy ? "Please wait..." : "Send OTP"}
        </button>
        {confirmation ? (
          <>
            <label className="mt-5 block text-xs font-black uppercase text-white/55">OTP</label>
            <input
              value={otp}
              onChange={(event) => {
                const code = event.target.value.replace(/\D/g, "").slice(0, 6);
                setOtp(code);
                if (code.length === 6) verify(code);
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              className="mt-2 h-12 w-full rounded-2xl border border-white/10 bg-white/[.06] px-4 font-bold outline-none"
              placeholder="6 digit OTP"
            />
          </>
        ) : null}
        <button onClick={onClose} className="mt-4 h-11 w-full rounded-full bg-white/10 font-black text-white">Close</button>
      </div>
    </div>
  );
}
