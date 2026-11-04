import {
  BudgetView,
  HealthInfo,
  Policy,
  PurchaseView,
  ReceiptRecord,
  WalletInfo
} from "./types";

const TOKEN_KEY = "shroud_token";

export function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token.trim());
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

/** Checks a token against the API without storing it. */
export async function verifyToken(token: string): Promise<boolean> {
  const res = await fetch("/api/policy", { headers: { Authorization: `Bearer ${token.trim()}` } });
  return res.ok;
}

/**
 * One-click sign-in: `npm run dashboard:link` prints http://localhost:5173/#token=...
 * The fragment never reaches any server; we read it once and remove it from the URL.
 */
export function takeTokenFromUrl(): string | null {
  const m = window.location.hash.match(/token=([^&]+)/);
  if (!m) return null;
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return decodeURIComponent(m[1]);
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers || {});
  headers.set("Content-Type", "application/json");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(path, {
    ...options,
    headers
  });

  if (res.status === 401) {
    throw new Error("UNAUTHORIZED");
  }

  if (!res.ok) {
    const errorJson = await res.json().catch(() => ({}));
    const message = errorJson.error?.message || `Request failed with status ${res.status}`;
    throw new Error(message);
  }

  return res.json();
}

export const api = {
  getHealth: () => request<HealthInfo>("/api/health"),
  getWallet: () => request<WalletInfo>("/api/wallet"),
  syncWallet: () => request<{ ok: boolean; durationMs: number }>("/api/wallet/sync", { method: "POST" }),
  getBudget: () => request<BudgetView>("/api/budget"),
  getPolicy: () => request<Policy>("/api/policy"),
  updatePolicy: (policy: Partial<Policy>) =>
    request<Policy>("/api/policy", {
      method: "PUT",
      body: JSON.stringify(policy)
    }),
  pausePolicy: () => request<Policy>("/api/policy/pause", { method: "POST" }),
  resumePolicy: () => request<Policy>("/api/policy/resume", { method: "POST" }),
  getPurchases: (status?: string) => {
    const query = status ? `?status=${status}` : "";
    return request<{ items: PurchaseView[] }>(`/api/purchases${query}`);
  },
  getPurchase: (id: string) => request<PurchaseView & { events: any[] }>(`/api/purchases/${id}`),
  approvePurchase: (id: string, nonce?: string) =>
    request<PurchaseView>(`/api/purchases/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ nonce })
    }),
  rejectPurchase: (id: string) =>
    request<PurchaseView>(`/api/purchases/${id}/reject`, { method: "POST" }),
  revealCode: (id: string) =>
    request<{ code: string }>(`/api/purchases/${id}/reveal`, { method: "POST" }),
  getReceipts: () => request<{ items: ReceiptRecord[] }>("/api/receipts")
};

export function connectEventStream(
  onPurchase: (p: PurchaseView) => void,
  onPolicy: (policy: Policy) => void
): () => void {
  const token = getToken();
  // EventSource can't send headers, so the API also accepts the token as ?token= (api/middleware.ts).
  const url = token ? `/api/events/stream?token=${encodeURIComponent(token)}` : "/api/events/stream";
  const es = new EventSource(url);

  es.addEventListener("purchase", (e) => {
    try {
      const data = JSON.parse(e.data);
      onPurchase(data);
    } catch {}
  });

  es.addEventListener("policy", (e) => {
    try {
      const data = JSON.parse(e.data);
      onPolicy(data);
    } catch {}
  });

  return () => {
    es.close();
  };
}

