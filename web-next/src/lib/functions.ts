"use client";

import { auth } from "@/lib/firebase";

const baseUrl = process.env.NEXT_PUBLIC_FUNCTIONS_BASE_URL || "https://asia-south1-magneetoz.cloudfunctions.net";

export async function callFunction<TResponse>(
  name: string,
  body: Record<string, unknown>,
  timeoutMs = 30000
): Promise<TResponse> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = await auth.currentUser?.getIdToken();
    const response = await fetch(`${baseUrl}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error || data?.message || "Request failed");
    return data as TResponse;
  } finally {
    window.clearTimeout(timer);
  }
}
