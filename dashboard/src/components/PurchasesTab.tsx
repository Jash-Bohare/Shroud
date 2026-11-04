import React, { useState } from "react";
import { ShoppingBag, ChevronRight, Filter } from "lucide-react";
import { HealthInfo, PurchaseView, Status } from "../types";
import { zatsToZec } from "../format";

interface Props {
  purchases: PurchaseView[];
  onSelectPurchase: (id: string) => void;
  health?: HealthInfo | null;
}

export const PurchasesTab: React.FC<Props> = ({ purchases, onSelectPurchase }) => {
  // Price column is the live quote in ZEC terms; on testnet the vault pays the same amount in TAZ.
  const [filter, setFilter] = useState<string>("ALL");

  const filtered = purchases.filter((p) => {
    if (filter === "ALL") return true;
    if (filter === "DELIVERED") return p.status === "DELIVERED";
    if (filter === "APPROVAL") return p.status === "AWAITING_APPROVAL";
    if (filter === "PROCESSING") {
      return ["APPROVED", "PAYING", "PAID", "SWAPPING", "SWAPPED", "ORDERING"].includes(p.status);
    }
    if (filter === "FAILED") {
      return ["DENIED", "REJECTED", "EXPIRED", "FAILED"].includes(p.status);
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Header & Filter Controls */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-amber-400" />
            <span>Agent Spending History</span>
          </h2>
          <p className="text-xs text-slate-400">
            {purchases.length} total purchases requested across Agent, Telegram & Dashboard
          </p>
        </div>

        {/* Filter Pills */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-900 border border-slate-800 rounded-xl overflow-x-auto text-xs">
          <Filter className="w-3.5 h-3.5 text-slate-500 ml-2" />
          {[
            { id: "ALL", label: "All" },
            { id: "DELIVERED", label: "Delivered" },
            { id: "APPROVAL", label: "Approval Needed" },
            { id: "PROCESSING", label: "In Progress" },
            { id: "FAILED", label: "Denied / Failed" }
          ].map((item) => (
            <button
              key={item.id}
              onClick={() => setFilter(item.id)}
              className={`px-3 py-1 rounded-lg font-medium transition ${
                filter === item.id
                  ? "bg-amber-500 text-black font-semibold shadow"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Purchases Table */}
      <div className="rounded-2xl bg-[#0f172a] border border-slate-800 overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/50 text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                <th className="py-3.5 px-4">Date / Time</th>
                <th className="py-3.5 px-4">Product</th>
                <th className="py-3.5 px-4">Source</th>
                <th className="py-3.5 px-4">USD Cost</th>
                <th className="py-3.5 px-4">Price in ZEC</th>
                <th className="py-3.5 px-4">Status</th>
                <th className="py-3.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-xs">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    No purchases found matching filter.
                  </td>
                </tr>
              ) : (
                filtered.map((p) => {
                  const statusColors: Record<Status, string> = {
                    CREATED: "bg-slate-700/30 text-slate-300 border-slate-600/30",
                    QUOTED: "bg-slate-700/30 text-slate-300 border-slate-600/30",
                    AWAITING_APPROVAL: "bg-amber-500/20 text-amber-300 border-amber-500/40",
                    APPROVED: "bg-blue-500/20 text-blue-300 border-blue-500/30",
                    PAYING: "bg-blue-500/20 text-blue-300 border-blue-500/30",
                    PAID: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
                    SWAPPING: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
                    SWAPPED: "bg-indigo-500/20 text-indigo-300 border-indigo-500/30",
                    ORDERING: "bg-purple-500/20 text-purple-300 border-purple-500/30",
                    DELIVERED: "bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold",
                    DENIED: "bg-rose-500/20 text-rose-300 border-rose-500/30",
                    REJECTED: "bg-rose-500/20 text-rose-300 border-rose-500/30",
                    EXPIRED: "bg-slate-800 text-slate-400 border-slate-700",
                    REFUNDED: "bg-amber-500/20 text-amber-300 border-amber-500/30",
                    FAILED: "bg-rose-500/20 text-rose-300 border-rose-500/30"
                  };

                  return (
                    <tr
                      key={p.id}
                      onClick={() => onSelectPurchase(p.id)}
                      className="hover:bg-slate-800/40 transition cursor-pointer group"
                    >
                      <td className="py-3 px-4 text-slate-400 whitespace-nowrap">
                        {new Date(p.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit"
                        })}{" "}
                        <span className="text-[10px] text-slate-500 block">
                          {new Date(p.createdAt).toLocaleDateString()}
                        </span>
                      </td>

                      <td className="py-3 px-4 font-medium text-white">
                        <div className="flex items-center gap-2">
                          <span className="truncate max-w-[200px]">{p.productName}</span>
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                            {p.productType}
                          </span>
                        </div>
                        <span className="text-[11px] text-slate-400 block">
                          {p.faceCurrency} {p.faceValue}
                        </span>
                      </td>

                      <td className="py-3 px-4">
                        <span className="text-[10px] uppercase font-semibold text-slate-300">
                          {p.source}
                        </span>
                      </td>

                      <td className="py-3 px-4 font-bold text-slate-100">
                        {p.priceUsd}
                      </td>

                      <td className="py-3 px-4 font-mono text-slate-300">
                        {zatsToZec(p.quotedZats)} ZEC
                      </td>

                      <td className="py-3 px-4 whitespace-nowrap">
                        <span
                          className={`inline-block px-2.5 py-1 rounded-full text-[11px] border ${
                            statusColors[p.status] || "bg-slate-800 text-slate-300"
                          }`}
                        >
                          {p.status}
                        </span>
                      </td>

                      <td className="py-3 px-4 text-right">
                        <span className="inline-flex items-center gap-1 text-slate-400 group-hover:text-amber-400 transition text-xs font-semibold">
                          <span>Details</span>
                          <ChevronRight className="w-4 h-4" />
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

