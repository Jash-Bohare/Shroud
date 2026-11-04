import React, { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Wallet,
  TrendingDown,
  ShieldCheck,
  Copy,
  Check,
  ExternalLink,
  Coins,
  AlertTriangle
} from "lucide-react";
import { BudgetView, HealthInfo, Policy, WalletInfo } from "../types";

interface Props {
  wallet: WalletInfo | null;
  budget: BudgetView | null;
  policy: Policy | null;
  health: HealthInfo | null;
}

function centsToUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export const OverviewTab: React.FC<Props> = ({ wallet, budget, policy, health }) => {
  const [copied, setCopied] = useState(false);

  const copyAddress = () => {
    if (wallet?.fundingAddress) {
      navigator.clipboard.writeText(wallet.fundingAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Only live values: show "—" until the API answers, never placeholder limits.
  const loaded = !!(policy && budget);
  const dailyLimitCents = policy?.dailyLimitCents ?? 0;
  const leftTodayCents = budget?.leftTodayCents ?? 0;
  const spentTodayCents = Math.max(0, dailyLimitCents - leftTodayCents);
  const dailyPct = dailyLimitCents ? Math.min(100, Math.round((spentTodayCents / dailyLimitCents) * 100)) : 0;

  const monthlyLimitCents = policy?.monthlyLimitCents ?? 0;
  const leftMonthCents = budget?.leftMonthCents ?? 0;
  const spentMonthCents = Math.max(0, monthlyLimitCents - leftMonthCents);
  const monthlyPct = monthlyLimitCents ? Math.min(100, Math.round((spentMonthCents / monthlyLimitCents) * 100)) : 0;

  const unit = health?.network === "main" ? "ZEC" : "TAZ";
  const money = (c: number) => (loaded ? centsToUsd(c) : "—");
  const real = budget?.realOrders ?? null;

  return (
    <div className="space-y-6">
      {/* Kill Switch Alert Banner if Paused */}
      {policy?.paused && (
        <div className="flex items-center gap-3 p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300">
          <AlertTriangle className="w-5 h-5 shrink-0 text-rose-400" />
          <div className="text-sm">
            <span className="font-semibold">Kill Switch Active:</span> Automated agent spending is
            currently paused. Incoming purchases will be denied until resumed.
          </div>
        </div>
      )}

      {/* How orders are fulfilled right now (live from the API) */}
      {health && health.mode === "demo" && (
        <div
          className={`flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-4 rounded-2xl border text-sm ${
            health.fulfilment === "bitrefill-store-credit"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
              : "bg-slate-800/60 border-slate-700 text-slate-300"
          }`}
        >
          <div>
            <span className="font-semibold">
              {health.fulfilment === "bitrefill-store-credit"
                ? "Real Bitrefill orders"
                : "Bitrefill test products"}
            </span>{" "}
            {health.fulfilment === "bitrefill-store-credit"
              ? "— the agent buys the actual product, paid from your Bitrefill store credit after the shielded payment confirms."
              : "— orders are fulfilled with Bitrefill's free test product (no real money)."}
          </div>
          {real && real.orderMode === "balance" && (
            <div className="text-xs font-mono whitespace-nowrap">
              {centsToUsd(real.leftCents)} left of {centsToUsd(real.maxTotalCents)} · max {centsToUsd(real.maxOrderCents)}/order
            </div>
          )}
        </div>
      )}

      {/* Grid of Key Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Card 1: Vault Balance */}
        <div className="rounded-2xl bg-[#0f172a] border border-slate-800 p-6 shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Shielded Vault Balance
              </span>
              <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
                <Wallet className="w-5 h-5" />
              </div>
            </div>

            <div className="mb-2">
              <div className="text-3xl font-extrabold text-white tracking-tight flex items-baseline gap-2">
                <span>{wallet?.balance.spendableZec ?? "—"}</span>
                <span className="text-amber-400 text-lg font-bold">{unit}</span>
              </div>
              <div className="text-sm font-medium text-slate-400">
                {unit === "TAZ"
                  ? "Testnet coins (no real value)"
                  : wallet?.balance.usdEstimate
                    ? `≈ ${wallet.balance.usdEstimate} USD`
                    : "USD value unavailable"}
              </div>
            </div>
          </div>

          <div className="pt-4 mt-4 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
            <span>Pending Notes:</span>
            <span className="font-mono text-slate-300">
              {wallet ? (Number(wallet.balance.pendingZats) / 100_000_000).toFixed(4) : "—"} {unit}
            </span>
          </div>
        </div>

        {/* Card 2: 24h Daily Budget */}
        <div className="rounded-2xl bg-[#0f172a] border border-slate-800 p-6 shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Daily Budget (24h)
              </span>
              <div className="p-2 rounded-xl bg-blue-500/10 text-blue-400 border border-blue-500/20">
                <TrendingDown className="w-5 h-5" />
              </div>
            </div>

            <div className="mb-3">
              <div className="text-3xl font-extrabold text-white tracking-tight">
                {money(leftTodayCents)}
              </div>
              <div className="text-xs text-slate-400 mt-1">
                left of {money(dailyLimitCents)} limit ({money(spentTodayCents)} spent)
              </div>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
              <div
                className={`h-2.5 rounded-full transition-all duration-300 ${
                  dailyPct > 85 ? "bg-rose-500" : dailyPct > 60 ? "bg-amber-500" : "bg-blue-500"
                }`}
                style={{ width: `${dailyPct}%` }}
              />
            </div>
          </div>

          <div className="pt-4 mt-4 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
            <span>Purchases Left Today:</span>
            <span className="font-bold text-slate-200">
              {budget ? budget.purchasesLeftToday : "—"}
            </span>
          </div>
        </div>

        {/* Card 3: Monthly Limit (30d) */}
        <div className="rounded-2xl bg-[#0f172a] border border-slate-800 p-6 shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Monthly Budget (30d)
              </span>
              <div className="p-2 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20">
                <Coins className="w-5 h-5" />
              </div>
            </div>

            <div className="mb-3">
              <div className="text-3xl font-extrabold text-white tracking-tight">
                {money(leftMonthCents)}
              </div>
              <div className="text-xs text-slate-400 mt-1">
                left of {money(monthlyLimitCents)} limit ({money(spentMonthCents)} spent)
              </div>
            </div>

            {/* Progress Bar */}
            <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
              <div
                className={`h-2.5 rounded-full transition-all duration-300 ${
                  monthlyPct > 85 ? "bg-rose-500" : monthlyPct > 60 ? "bg-amber-500" : "bg-purple-500"
                }`}
                style={{ width: `${monthlyPct}%` }}
              />
            </div>
          </div>

          <div className="pt-4 mt-4 border-t border-slate-800/80 flex items-center justify-between text-xs text-slate-400">
            <span>Auto-approve purchases up to:</span>
            <span className="font-semibold text-emerald-400">
              {policy ? centsToUsd(policy.requireApprovalAboveCents) : "—"}
            </span>
          </div>
        </div>
      </div>

      {/* Funding & Shielded Privacy Information */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Funding Address & QR */}
        <div className="lg:col-span-2 rounded-2xl bg-[#0f172a] border border-slate-800 p-6 shadow-xl">
          <div className="flex items-center gap-2 mb-4 text-white font-semibold text-base">
            <ShieldCheck className="w-5 h-5 text-amber-400" />
            <span>Vault Shielded Funding Address</span>
          </div>

          <p className="text-xs text-slate-400 mb-4 leading-relaxed">
            Send Zcash (TAZ on testnet) to this Unified Address. The vault receives notes directly into
            the Ironwood shielded pool. No transparent address is used when the agent spends.
          </p>

          <div className="flex flex-col sm:flex-row items-center gap-6 p-4 rounded-xl bg-slate-900 border border-slate-800">
            {/* QR Code */}
            <div className="p-3 bg-white rounded-xl shadow-md shrink-0">
              {wallet?.fundingAddress ? (
                <QRCodeSVG value={wallet.fundingAddress} size={130} />
              ) : (
                <div className="w-[130px] h-[130px] bg-slate-200 animate-pulse rounded" />
              )}
            </div>

            {/* Address & Copy Action */}
            <div className="w-full overflow-hidden space-y-3">
              <div className="p-3 rounded-lg bg-black/40 border border-slate-800 font-mono text-[11px] text-amber-300 break-all select-all leading-tight">
                {wallet?.fundingAddress || "Loading vault funding address..."}
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={copyAddress}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
                >
                  {copied ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy Address</span>
                    </>
                  )}
                </button>

                {health?.mode === "demo" && (
                  <a
                    href="https://fauzec.com"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 text-xs font-medium transition border border-amber-500/20"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Get Testnet TAZ (fauzec.com)</span>
                  </a>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Security & System Info */}
        <div className="rounded-2xl bg-[#0f172a] border border-slate-800 p-6 shadow-xl flex flex-col justify-between">
          <div>
            <h3 className="font-semibold text-white text-base mb-3">System Architecture</h3>
            <ul className="space-y-3 text-xs text-slate-300">
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 font-bold">✓</span>
                <span>
                  <strong>Shielded Vault:</strong> Ironwood shielded pool via <code>zcash-devtool</code>.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 font-bold">✓</span>
                <span>
                  <strong>Deterministic Policy:</strong> 12 rules in code: caps, daily/monthly budgets, approvals, kill switch.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 font-bold">✓</span>
                <span>
                  <strong>Encrypted Memos:</strong> Receipts encrypted on-chain via <code>SHRD1</code> memo format.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 font-bold">✓</span>
                <span>
                  <strong>AI Guardrails:</strong> Zero transaction signing or address generation in agent tool definitions.
                </span>
              </li>
            </ul>
          </div>

          <div className="p-3 mt-4 rounded-xl bg-slate-900 border border-slate-800 text-[11px] text-slate-400">
            Running <strong>Shroud v0.1</strong> for Free Society Hackathon, Mumbai.
          </div>
        </div>
      </div>
    </div>
  );
};

