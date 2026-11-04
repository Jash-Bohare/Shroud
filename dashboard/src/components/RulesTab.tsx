import React, { useState, useEffect } from "react";
import { Sliders, Save, AlertCircle, CheckCircle2, ShieldCheck } from "lucide-react";
import { api } from "../api";
import { Policy, ProductType } from "../types";

interface Props {
  policy: Policy | null;
  onRefresh: () => void;
}

export const RulesTab: React.FC<Props> = ({ policy, onRefresh }) => {
  const [formData, setFormData] = useState({
    maxPerPurchaseUsd: "25.00",
    dailyLimitUsd: "50.00",
    monthlyLimitUsd: "200.00",
    maxPurchasesPerDay: 5,
    requireApprovalAboveUsd: "10.00",
    approveAllFirstTimeProducts: false,
    allowedTypes: ["giftcard", "esim", "refill"] as ProductType[],
    allowedCountries: "",
    blockedProductIds: ""
  });

  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (policy) {
      setFormData({
        maxPerPurchaseUsd: (policy.maxPerPurchaseCents / 100).toFixed(2),
        dailyLimitUsd: (policy.dailyLimitCents / 100).toFixed(2),
        monthlyLimitUsd: (policy.monthlyLimitCents / 100).toFixed(2),
        maxPurchasesPerDay: policy.maxPurchasesPerDay,
        requireApprovalAboveUsd: (policy.requireApprovalAboveCents / 100).toFixed(2),
        approveAllFirstTimeProducts: policy.approveAllFirstTimeProducts,
        allowedTypes: policy.allowedTypes,
        allowedCountries: policy.allowedCountries.join(", "),
        blockedProductIds: policy.blockedProductIds.join(", ")
      });
    }
  }, [policy]);

  const handleTypeToggle = (type: ProductType) => {
    setFormData((prev) => {
      const exists = prev.allowedTypes.includes(type);
      const next = exists ? prev.allowedTypes.filter((t) => t !== type) : [...prev.allowedTypes, type];
      return { ...prev, allowedTypes: next };
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMsg(null);

    try {
      const payload: Partial<Policy> = {
        maxPerPurchaseCents: Math.round(parseFloat(formData.maxPerPurchaseUsd) * 100),
        dailyLimitCents: Math.round(parseFloat(formData.dailyLimitUsd) * 100),
        monthlyLimitCents: Math.round(parseFloat(formData.monthlyLimitUsd) * 100),
        maxPurchasesPerDay: Number(formData.maxPurchasesPerDay),
        requireApprovalAboveCents: Math.round(parseFloat(formData.requireApprovalAboveUsd) * 100),
        approveAllFirstTimeProducts: formData.approveAllFirstTimeProducts,
        allowedTypes: formData.allowedTypes,
        allowedCountries: formData.allowedCountries
          ? formData.allowedCountries.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
          : [],
        blockedProductIds: formData.blockedProductIds
          ? formData.blockedProductIds.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
          : []
      };

      await api.updatePolicy(payload);
      setStatusMsg({ type: "success", text: "Rules saved. They apply to the very next purchase (no restart needed)." });
      onRefresh();
    } catch (err: any) {
      setStatusMsg({ type: "error", text: `Update failed: ${err.message}` });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Sliders className="w-5 h-5 text-amber-400" />
            <span>Deterministic Policy Engine Rules</span>
          </h2>
          <p className="text-xs text-slate-400">
            Enforced locally on every AI agent spending request. Policy rules R1–R12 are evaluated deterministically.
          </p>
        </div>
      </div>

      {statusMsg && (
        <div
          className={`flex items-center gap-2 p-4 rounded-xl border text-sm ${
            statusMsg.type === "success"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
              : "bg-rose-500/10 border-rose-500/30 text-rose-300"
          }`}
        >
          {statusMsg.type === "success" ? (
            <CheckCircle2 className="w-5 h-5 shrink-0" />
          ) : (
            <AlertCircle className="w-5 h-5 shrink-0" />
          )}
          <span>{statusMsg.text}</span>
        </div>
      )}

      <form onSubmit={handleSave} className="rounded-2xl bg-[#0f172a] border border-slate-800 p-6 shadow-xl space-y-6">
        {/* Limits Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Max Per Purchase (USD)
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-2.5 text-sm text-slate-400">$</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={formData.maxPerPurchaseUsd}
                onChange={(e) => setFormData({ ...formData, maxPerPurchaseUsd: e.target.value })}
                className="w-full pl-8 pr-3.5 py-2 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                required
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Rule R3: Hard ceiling per item</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Daily Limit (24h Rolling)
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-2.5 text-sm text-slate-400">$</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={formData.dailyLimitUsd}
                onChange={(e) => setFormData({ ...formData, dailyLimitUsd: e.target.value })}
                className="w-full pl-8 pr-3.5 py-2 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                required
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Rule R4: Rolling 24-hour limit</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Monthly Limit (30d Rolling)
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-2.5 text-sm text-slate-400">$</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={formData.monthlyLimitUsd}
                onChange={(e) => setFormData({ ...formData, monthlyLimitUsd: e.target.value })}
                className="w-full pl-8 pr-3.5 py-2 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                required
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Rule R5: Rolling 30-day limit</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Max Purchases / Day
            </label>
            <input
              type="number"
              step="1"
              min="1"
              value={formData.maxPurchasesPerDay}
              onChange={(e) => setFormData({ ...formData, maxPurchasesPerDay: parseInt(e.target.value) || 1 })}
              className="w-full px-3.5 py-2 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
              required
            />
            <p className="text-[11px] text-slate-500 mt-1">Rule R6: Frequency cap</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Auto-Approve Threshold
            </label>
            <div className="relative">
              <span className="absolute left-3.5 top-2.5 text-sm text-slate-400">$</span>
              <input
                type="number"
                step="0.01"
                min="0.00"
                value={formData.requireApprovalAboveUsd}
                onChange={(e) => setFormData({ ...formData, requireApprovalAboveUsd: e.target.value })}
                className="w-full pl-8 pr-3.5 py-2 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
                required
              />
            </div>
            <p className="text-[11px] text-slate-500 mt-1">Rule R7: Purchases above this need approval</p>
          </div>

          <div className="flex items-center gap-3 pt-6">
            <input
              type="checkbox"
              id="approveAllFirstTime"
              checked={formData.approveAllFirstTimeProducts}
              onChange={(e) => setFormData({ ...formData, approveAllFirstTimeProducts: e.target.checked })}
              className="w-4 h-4 rounded text-amber-500 bg-slate-900 border-slate-700 focus:ring-amber-500"
            />
            <label htmlFor="approveAllFirstTime" className="text-xs text-slate-300 cursor-pointer">
              Approve 1st-time items (Rule R8)
            </label>
          </div>
        </div>

        {/* Allowed Product Categories */}
        <div className="pt-4 border-t border-slate-800">
          <label className="block text-xs font-semibold text-slate-300 mb-2">
            Allowed Product Categories (Rule R9)
          </label>
          <div className="flex flex-wrap gap-2">
            {(["giftcard", "esim", "refill", "bill"] as ProductType[]).map((cat) => {
              const active = formData.allowedTypes.includes(cat);
              return (
                <button
                  type="button"
                  key={cat}
                  onClick={() => handleTypeToggle(cat)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition border ${
                    active
                      ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
                      : "bg-slate-900 text-slate-500 border-slate-800 hover:text-slate-300"
                  }`}
                >
                  {cat.toUpperCase()} {active ? "✓" : "+"}
                </button>
              );
            })}
          </div>
        </div>

        {/* Countries & Blocked SKUs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 pt-4 border-t border-slate-800">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Allowed Countries (Rule R10)
            </label>
            <input
              type="text"
              placeholder="e.g. IN, US, SG (leave empty for any)"
              value={formData.allowedCountries}
              onChange={(e) => setFormData({ ...formData, allowedCountries: e.target.value })}
              className="w-full px-3.5 py-2 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            />
            <p className="text-[11px] text-slate-500 mt-1">Comma-separated ISO-2 country codes</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1.5">
              Blocked Product IDs / SKUs (Rule R11)
            </label>
            <input
              type="text"
              placeholder="e.g. crypto-voucher, steam-usd"
              value={formData.blockedProductIds}
              onChange={(e) => setFormData({ ...formData, blockedProductIds: e.target.value })}
              className="w-full px-3.5 py-2 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white focus:outline-none focus:ring-2 focus:ring-amber-500/50"
            />
            <p className="text-[11px] text-slate-500 mt-1">Products completely forbidden from purchase</p>
          </div>
        </div>

        {/* Submit */}
        <div className="pt-4 border-t border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Rules are signed & persisted in SQLite <code>settings</code></span>
          </div>

          <button
            type="submit"
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-semibold text-sm transition shadow-lg disabled:opacity-50"
          >
            <Save className="w-4 h-4" />
            <span>{saving ? "Saving Policy..." : "Update Policy"}</span>
          </button>
        </div>
      </form>
    </div>
  );
};

