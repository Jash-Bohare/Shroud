import React, { useEffect, useState, useCallback } from "react";
import {
  api,
  clearToken,
  connectEventStream,
  getToken,
  setToken,
  takeTokenFromUrl,
  verifyToken
} from "./api";
import { AuditorTab } from "./components/AuditorTab";
import { Navbar } from "./components/Navbar";
import { OverviewTab } from "./components/OverviewTab";
import { PurchaseDetailsModal } from "./components/PurchaseDetailsModal";
import { PurchasesTab } from "./components/PurchasesTab";
import { ReceiptsTab } from "./components/ReceiptsTab";
import { RulesTab } from "./components/RulesTab";
import { TokenModal } from "./components/TokenModal";
import {
  BudgetView,
  HealthInfo,
  Policy,
  PurchaseView,
  ReceiptRecord,
  WalletInfo
} from "./types";

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>("overview");
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [tokenError, setTokenError] = useState<string | null>(null);

  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [budget, setBudget] = useState<BudgetView | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [purchases, setPurchases] = useState<PurchaseView[]>([]);
  const [receipts, setReceipts] = useState<ReceiptRecord[]>([]);

  const [selectedPurchaseId, setSelectedPurchaseId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);

  const loadAll = useCallback(async () => {
    try {
      const h = await api.getHealth();
      setHealth(h);
    } catch {}

    if (!getToken()) {
      setIsAuthenticated(false);
      return;
    }

    try {
      const [w, b, pol, purch, rec] = await Promise.all([
        api.getWallet().catch(() => null),
        api.getBudget().catch(() => null),
        api.getPolicy().catch(() => null),
        api.getPurchases().catch(() => ({ items: [] })),
        api.getReceipts().catch(() => ({ items: [] }))
      ]);

      if (w) setWallet(w);
      if (b) setBudget(b);
      if (pol) setPolicy(pol);
      if (purch) setPurchases(purch.items || []);
      if (rec) setReceipts(rec.items || []);
      setIsAuthenticated(true);
      setTokenError(null);
    } catch (err: any) {
      if (err.message === "UNAUTHORIZED") {
        setIsAuthenticated(false);
        setTokenError("Invalid or expired dashboard token");
      }
    }
  }, []);

  // Sign in from a #token= link or a saved session, but only after the API accepts it
  useEffect(() => {
    (async () => {
      const fromUrl = takeTokenFromUrl();
      const candidate = fromUrl || getToken();
      if (candidate) {
        const ok = await verifyToken(candidate).catch(() => false);
        if (ok) {
          setToken(candidate);
          setIsAuthenticated(true);
          loadAll();
          return;
        }
        clearToken();
        setTokenError(fromUrl ? "That sign-in link's token was not accepted." : "Saved token is no longer valid.");
      }
      api.getHealth().then(setHealth).catch(() => {});
    })();
  }, [loadAll]);

  // Live data: balances change when deposits confirm and receipts appear after mining,
  // neither of which emits a purchase event.
  useEffect(() => {
    if (!isAuthenticated) return;
    const t = setInterval(() => {
      api.getWallet().then(setWallet).catch(() => {});
      api.getBudget().then(setBudget).catch(() => {});
      api.getReceipts().then((r) => setReceipts(r.items || [])).catch(() => {});
    }, 20_000);
    return () => clearInterval(t);
  }, [isAuthenticated]);

  // Connect Server-Sent Events stream for real-time reactivity
  useEffect(() => {
    if (!isAuthenticated) return;

    const cleanup = connectEventStream(
      (p: PurchaseView) => {
        setPurchases((prev) => {
          const index = prev.findIndex((item) => item.id === p.id);
          if (index >= 0) {
            const next = [...prev];
            next[index] = p;
            return next;
          }
          return [p, ...prev];
        });
        // Refresh budget whenever purchase status changes
        api.getBudget().then(setBudget).catch(() => {});
        api.getWallet().then(setWallet).catch(() => {});
        if (p.status === "DELIVERED") {
          api.getReceipts().then((r) => setReceipts(r.items || [])).catch(() => {});
        }
      },
      (newPolicy: Policy) => {
        setPolicy(newPolicy);
        api.getBudget().then(setBudget).catch(() => {});
      }
    );

    return cleanup;
  }, [isAuthenticated]);

  const handleSaveToken = async (newToken: string) => {
    const ok = await verifyToken(newToken).catch(() => false);
    if (!ok) {
      setTokenError("Token not accepted. Check DASHBOARD_TOKEN in your .env (and that npm run dev is running).");
      return;
    }
    setToken(newToken);
    setIsAuthenticated(true);
    setTokenError(null);
    loadAll();
  };

  const handleLogout = () => {
    clearToken();
    setIsAuthenticated(false);
  };

  const handleTogglePause = async () => {
    if (!policy) return;
    try {
      if (policy.paused) {
        const updated = await api.resumePolicy();
        setPolicy(updated);
      } else {
        const updated = await api.pausePolicy();
        setPolicy(updated);
      }
      const b = await api.getBudget();
      setBudget(b);
    } catch (err: any) {
      alert(`Could not toggle pause: ${err.message}`);
    }
  };

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await api.syncWallet();
      const w = await api.getWallet();
      setWallet(w);
    } catch (err: any) {
      alert(`Sync failed: ${err.message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col">
      <TokenModal
        isOpen={!isAuthenticated}
        onSave={handleSaveToken}
        error={tokenError}
      />

      <Navbar
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        health={health}
        policy={policy}
        onTogglePause={handleTogglePause}
        onSync={handleSync}
        isSyncing={isSyncing}
        onLogout={handleLogout}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {activeTab === "overview" && (
          <OverviewTab
            wallet={wallet}
            budget={budget}
            policy={policy}
            health={health}
          />
        )}

        {activeTab === "purchases" && (
          <PurchasesTab
            purchases={purchases}
            health={health}
            onSelectPurchase={(id) => setSelectedPurchaseId(id)}
          />
        )}

        {activeTab === "rules" && (
          <RulesTab
            policy={policy}
            onRefresh={loadAll}
          />
        )}

        {activeTab === "receipts" && (
          <ReceiptsTab
            receipts={receipts}
            health={health}
          />
        )}

        {activeTab === "auditor" && (
          <AuditorTab
            wallet={wallet}
          />
        )}
      </main>

      <PurchaseDetailsModal
        purchaseId={selectedPurchaseId}
        onClose={() => setSelectedPurchaseId(null)}
        onRefresh={loadAll}
      />
    </div>
  );
};
export default App;

