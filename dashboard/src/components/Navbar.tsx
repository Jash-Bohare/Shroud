import React from "react";
import {
  Shield,
  LayoutDashboard,
  ShoppingBag,
  Sliders,
  Receipt,
  Eye,
  Power,
  RefreshCw,
  LogOut
} from "lucide-react";
import { HealthInfo, Policy } from "../types";

interface Props {
  activeTab: string;
  setActiveTab: (tab: string) => void;
  health: HealthInfo | null;
  policy: Policy | null;
  onTogglePause: () => void;
  onSync: () => void;
  isSyncing: boolean;
  onLogout: () => void;
}

export const Navbar: React.FC<Props> = ({
  activeTab,
  setActiveTab,
  health,
  policy,
  onTogglePause,
  onSync,
  isSyncing,
  onLogout
}) => {
  const isPaused = policy?.paused ?? false;

  return (
    <header className="border-b border-slate-800 bg-[#0b1120]/90 backdrop-blur sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-amber-500/20 to-amber-600/10 border border-amber-500/30 text-amber-400">
              <Shield className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-lg tracking-tight text-white">SHROUD</span>
                {health && (
                  <span
                    className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full border ${
                      health.mode === "demo" && health.fulfilment !== "bitrefill-store-credit"
                        ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
                        : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                    }`}
                  >
                    {health.network === "test" ? "Zcash testnet" : "Zcash mainnet"}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400">Shielded Spending Vault</p>
            </div>
          </div>

          {/* Nav Tabs */}
          <nav className="hidden md:flex items-center gap-1">
            <button
              onClick={() => setActiveTab("overview")}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition ${
                activeTab === "overview"
                  ? "bg-slate-800 text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
              }`}
            >
              <LayoutDashboard className="w-4 h-4" />
              Overview
            </button>
            <button
              onClick={() => setActiveTab("purchases")}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition ${
                activeTab === "purchases"
                  ? "bg-slate-800 text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
              }`}
            >
              <ShoppingBag className="w-4 h-4" />
              Purchases
            </button>
            <button
              onClick={() => setActiveTab("rules")}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition ${
                activeTab === "rules"
                  ? "bg-slate-800 text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
              }`}
            >
              <Sliders className="w-4 h-4" />
              Rules
            </button>
            <button
              onClick={() => setActiveTab("receipts")}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition ${
                activeTab === "receipts"
                  ? "bg-slate-800 text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
              }`}
            >
              <Receipt className="w-4 h-4" />
              Receipts
            </button>
            <button
              onClick={() => setActiveTab("auditor")}
              className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-medium transition ${
                activeTab === "auditor"
                  ? "bg-slate-800 text-white shadow-sm"
                  : "text-slate-400 hover:text-slate-200 hover:bg-slate-800/50"
              }`}
            >
              <Eye className="w-4 h-4" />
              Auditor
            </button>
          </nav>

          {/* Quick Actions & Status */}
          <div className="flex items-center gap-2.5">
            {/* Kill Switch Toggle */}
            <button
              onClick={onTogglePause}
              title={isPaused ? "Resume automated payments" : "Emergency Pause (Kill switch)"}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                isPaused
                  ? "bg-rose-500/20 text-rose-300 border-rose-500/40 hover:bg-rose-500/30"
                  : "bg-emerald-500/10 text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20"
              }`}
            >
              <Power className={`w-3.5 h-3.5 ${isPaused ? "text-rose-400 animate-pulse" : "text-emerald-400"}`} />
              <span>{isPaused ? "PAUSED" : "ACTIVE"}</span>
            </button>

            {/* Sync Vault Button */}
            <button
              onClick={onSync}
              disabled={isSyncing}
              title="Sync Zcash vault chain tip"
              className="p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 transition disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isSyncing ? "animate-spin text-amber-400" : ""}`} />
            </button>

            {/* Disconnect */}
            <button
              onClick={onLogout}
              title="Lock / Disconnect session"
              className="p-2 rounded-lg bg-slate-800 hover:bg-rose-500/20 hover:text-rose-300 text-slate-400 border border-slate-700 transition"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tabs on small screens */}
        <nav className="md:hidden flex gap-1 overflow-x-auto pb-3 -mx-1 px-1">
          {[
            ["overview", "Overview"],
            ["purchases", "Purchases"],
            ["rules", "Rules"],
            ["receipts", "Receipts"],
            ["auditor", "Auditor"]
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                activeTab === id ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>
    </header>
  );
};

