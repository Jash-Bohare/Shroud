import React, { useEffect, useState } from "react";
import {
  X,
  ExternalLink,
  CheckCircle,
  XCircle,
  Clock,
  Key,
  Shield,
  Copy,
  Check
} from "lucide-react";
import { zatsToZec, zatsToZecExact } from "../format";
import { api } from "../api";
import { EventView, PurchaseView } from "../types";

interface Props {
  purchaseId: string | null;
  onClose: () => void;
  onRefresh: () => void;
}

export const PurchaseDetailsModal: React.FC<Props> = ({ purchaseId, onClose, onRefresh }) => {
  const [purchase, setPurchase] = useState<(PurchaseView & { events: EventView[] }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [revealedCode, setRevealedCode] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  useEffect(() => {
    if (!purchaseId) {
      setPurchase(null);
      setRevealedCode(null);
      return;
    }

    setLoading(true);
    api
      .getPurchase(purchaseId)
      .then((data) => setPurchase(data))
      .catch((err) => console.error(err))
      .finally(() => setLoading(false));
  }, [purchaseId]);

  // Keep the timeline live while the purchase is still moving
  useEffect(() => {
    if (!purchaseId || !purchase) return;
    const terminal = ["DELIVERED", "DENIED", "REJECTED", "EXPIRED", "FAILED", "REFUNDED"];
    if (terminal.includes(purchase.status)) return;
    const t = setInterval(() => {
      api.getPurchase(purchaseId).then(setPurchase).catch(() => {});
    }, 3000);
    return () => clearInterval(t);
  }, [purchaseId, purchase?.status]);

  if (!purchaseId) return null;

  const handleApprove = async () => {
    if (!purchase) return;
    setActionLoading(true);
    try {
      await api.approvePurchase(purchase.id, purchase.approvalNonce || undefined);
      const updated = await api.getPurchase(purchase.id);
      setPurchase(updated);
      onRefresh();
    } catch (err: any) {
      alert(`Approval failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!purchase) return;
    setActionLoading(true);
    try {
      await api.rejectPurchase(purchase.id);
      const updated = await api.getPurchase(purchase.id);
      setPurchase(updated);
      onRefresh();
    } catch (err: any) {
      alert(`Rejection failed: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleReveal = async () => {
    if (!purchase) return;
    setActionLoading(true);
    try {
      const res = await api.revealCode(purchase.id);
      setRevealedCode(res.code);
    } catch (err: any) {
      alert(`Could not reveal code: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const copyCode = () => {
    if (revealedCode) {
      navigator.clipboard.writeText(revealedCode);
      setCodeCopied(true);
      setTimeout(() => setCodeCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl bg-[#0f172a] border border-slate-700 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-800 bg-[#0b1120]">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-white">Purchase Details</h2>
              <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                {purchase?.id || purchaseId}
              </span>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              Source: <span className="text-amber-400 uppercase font-semibold">{purchase?.source || "agent"}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto space-y-6">
          {loading && !purchase ? (
            <div className="text-center py-10 text-slate-400">Loading purchase timeline...</div>
          ) : purchase ? (
            <>
              {/* Summary Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 p-4 rounded-xl bg-slate-900 border border-slate-800">
                <div>
                  <span className="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">
                    Product
                  </span>
                  <span className="font-semibold text-white text-sm block truncate">
                    {purchase.productName}
                  </span>
                  <span className="text-xs text-slate-400">
                    {purchase.faceCurrency} {purchase.faceValue}
                  </span>
                </div>

                <div>
                  <span className="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">
                    Cost
                  </span>
                  <span className="font-bold text-amber-400 text-sm block">
                    {purchase.priceUsd}
                  </span>
                  <span className="text-xs font-mono text-slate-400 block">
                    ≈ {zatsToZec(purchase.quotedZats)} ZEC
                  </span>
                  {purchase.mode === "demo" && purchase.paidZats && purchase.paidZats !== purchase.quotedZats && (
                    <span className="text-[11px] text-slate-500 block">
                      Demo: vault paid {zatsToZecExact(purchase.paidZats)} TAZ (scaled down)
                    </span>
                  )}
                </div>

                <div>
                  <span className="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">
                    Status
                  </span>
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${
                      purchase.status === "DELIVERED"
                        ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                        : purchase.status === "AWAITING_APPROVAL"
                        ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                        : purchase.status === "DENIED" || purchase.status === "REJECTED" || purchase.status === "FAILED"
                        ? "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                        : "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                    }`}
                  >
                    {purchase.status}
                  </span>
                </div>

                <div>
                  <span className="text-[11px] uppercase tracking-wider text-slate-400 block mb-1">
                    Policy
                  </span>
                  <span className="text-xs font-medium text-slate-300 block">
                    {purchase.policyDecision || "Evaluated"}
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {purchase.settlement === "bitrefill-store-credit"
                      ? "Real Bitrefill order (store credit)"
                      : purchase.settlement === "bitrefill-test-product"
                        ? "Bitrefill test product (demo)"
                        : "1Click swap (live)"}
                  </span>
                </div>
              </div>

              {/* Action Buttons for Awaiting Approval */}
              {purchase.status === "AWAITING_APPROVAL" && (
                <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 space-y-3">
                  <div className="flex items-center gap-2 text-amber-400 text-sm font-semibold">
                    <Shield className="w-4 h-4" />
                    <span>Owner Approval Required</span>
                  </div>
                  <p className="text-xs text-amber-200/80">
                    This purchase exceeds your automated spending policy. You can approve or reject it
                    here or via your Telegram bot inline buttons.
                  </p>
                  <div className="flex items-center gap-3 pt-1">
                    <button
                      onClick={handleApprove}
                      disabled={actionLoading}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-black font-semibold text-xs transition disabled:opacity-50"
                    >
                      <CheckCircle className="w-4 h-4" />
                      <span>Approve Purchase</span>
                    </button>
                    <button
                      onClick={handleReject}
                      disabled={actionLoading}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 font-semibold text-xs border border-rose-500/30 transition disabled:opacity-50"
                    >
                      <XCircle className="w-4 h-4" />
                      <span>Reject</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Delivered Code Display / Reveal Action */}
              {purchase.hasCode && (
                <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                      <Key className="w-4 h-4 text-amber-400" />
                      Redemption Code
                    </span>
                    {!revealedCode && (
                      <button
                        onClick={handleReveal}
                        disabled={actionLoading}
                        className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black font-semibold text-xs rounded-lg transition disabled:opacity-50"
                      >
                        Reveal Code
                      </button>
                    )}
                  </div>

                  {revealedCode && (
                    <div className="flex items-center justify-between p-3 rounded-lg bg-black/60 border border-amber-500/30">
                      <span className="font-mono text-sm text-amber-300 font-bold tracking-wider select-all">
                        {revealedCode}
                      </span>
                      <button
                        onClick={copyCode}
                        className="flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition"
                      >
                        {codeCopied ? (
                          <>
                            <Check className="w-3.5 h-3.5 text-emerald-400" />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copy</span>
                          </>
                        )}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* On-chain Zcash TX link */}
              {purchase.zecTxid && (
                <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-900 border border-slate-800 text-xs">
                  <span className="text-slate-400">On-Chain Shielded Transaction:</span>
                  <a
                    href={`https://testnet.zcashexplorer.app/transactions/${purchase.zecTxid}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 font-mono text-amber-400 hover:text-amber-300 transition"
                  >
                    <span>{purchase.zecTxid.slice(0, 16)}...{purchase.zecTxid.slice(-8)}</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              )}

              {/* Timeline Stepper from events table */}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                  <Clock className="w-4 h-4" />
                  Audit Trail & State Machine Timeline
                </h3>

                <div className="relative pl-6 space-y-4 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-800">
                  {purchase.events && purchase.events.length > 0 ? (
                    purchase.events.map((e, idx) => (
                      <div key={e.id || idx} className="relative">
                        {/* Dot */}
                        <div className="absolute -left-[21px] top-1 w-3 h-3 rounded-full bg-amber-500 border-2 border-slate-900" />
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-bold text-white uppercase">
                              {e.toStatus || e.type}
                            </span>
                            <span className="text-[10px] text-slate-500">
                              by {e.actor}
                            </span>
                            {e.simulated && (
                              <span className="text-[9px] uppercase font-semibold px-1.5 py-0.2 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                simulated
                              </span>
                            )}
                          </div>
                          {e.data && (e.data as any).note && (
                            <p className="text-xs text-slate-400 mt-0.5">
                              {(e.data as any).note}
                            </p>
                          )}
                          <span className="text-[10px] text-slate-500 mt-0.5 block">
                            {new Date(e.createdAt).toLocaleString()}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-slate-500">No events recorded.</div>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
};

