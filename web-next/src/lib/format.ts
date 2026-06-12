export function formatCurrency(value = 0) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

export function normalizeImageUrl(src?: string) {
  const clean = String(src || "").trim();
  if (!clean) return "/logo_tran.jpeg";
  if (/^(https?:)?\/\//i.test(clean) || clean.startsWith("/")) return clean;
  return `/${clean.replace(/^\.?\//, "")}`;
}

export function timestampToDate(value: unknown) {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate() as Date;
  }
  if (value && typeof value === "object" && "seconds" in value) {
    return new Date(Number((value as { seconds: number }).seconds) * 1000);
  }
  return null;
}
