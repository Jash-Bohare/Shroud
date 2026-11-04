import React from "react";
import { Receipt, ExternalLink, ShieldCheck, Lock } from "lucide-react";
import { HealthInfo, ReceiptRecord } from "../types";

interface Props {
  receipts: ReceiptRecord[];
  health?: HealthInfo | null;
}

export const ReceiptsTab: React.FC<Props> = ({ receipts }) => {
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Receipt className="w-5 h-5 text-amber-400" />
            <span>On-Chain Shielded Receipts</span>
          </h2>
          <p className="text-xs text-slate-400">
            Decrypted directly from shielded memos on Zcash testnet (Receipts account).
          </p>
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs text-amber-400">
          <Lock className="w-3.5 h-3.5" />
          <span>Protocol Memo Format: <code>SHRD1</code></span>
        </div>
      </div>

      <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 text-xs text-slate-300 flex items-start gap-3">
        <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold text-white">Trial-Decrypted Receipts:</span>{" "}
          When the vault pays for an order, it encodes an encrypted receipt in the transaction memo
          addressed to your dedicated Receipts account. Because it uses shielded notes, only the owner
          (or an auditor holding the viewing key) can decrypt and verify these receipts.
        </div>
      </div>

      {/* Receipts Table */}
      <div className="rounded-2xl bg-[#0f172a] border border-slate-800 overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/50 text-[11px] uppercase tracking-wider text-slate-400 font-semibold">
                <th className="py-3.5 px-4">Date / Height</th>
                <th className="py-3.5 px-4">Product</th>
                <th className="py-3.5 px-4">USD Value</th>
                <th className="py-3.5 px-4">Zats Paid</th>
                <th className="py-3.5 px-4">Transaction (TXID)</th>
                <th className="py-3.5 px-4">Settlement</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80 text-xs">
              {receipts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-slate-500">
                    No on-chain receipts decrypted in this wallet yet.
                  </td>
                </tr>
              ) : (
                receipts.map((r) => (
                  <tr key={r.txid + r.receipt.id} className="hover:bg-slate-800/40 transition">
                    <td className="py-3 px-4 text-slate-400 whitespace-nowrap">
                      {new Date(r.receipt.t * 1000).toLocaleString([], {
                        dateStyle: "short",
                        timeStyle: "short"
                      })}
                      <span className="text-[10px] text-slate-500 block font-mono">
                        Block: {r.minedHeight ?? "pending"}
                      </span>
                    </td>

                    <td className="py-3 px-4 font-semibold text-white">
                      <div>{r.receipt.n}</div>
                      <span className="text-[11px] text-slate-400 font-normal">
                        {r.receipt.fc} {r.receipt.fv} (ID: {r.receipt.id})
                      </span>
                    </td>

                    <td className="py-3 px-4 font-bold text-amber-400">
                      ${(r.receipt.u / 100).toFixed(2)}
                    </td>

                    <td className="py-3 px-4 font-mono text-slate-300">
                      {r.receipt.z} zats
                    </td>

                    <td className="py-3 px-4">
                      <a
                        href={`https://testnet.zcashexplorer.app/transactions/${r.txid}`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 font-mono text-xs text-amber-400 hover:text-amber-300 transition"
                      >
                        <span>{r.txid.slice(0, 14)}...{r.txid.slice(-6)}</span>
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    </td>

                    <td className="py-3 px-4">
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                        {r.receipt.x === "desk-balance"
                          ? "Real order · store credit"
                          : r.receipt.m === "live"
                            ? "1Click swap"
                            : "Test product"}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

