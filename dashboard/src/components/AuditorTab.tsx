import React, { useState } from "react";
import { Eye, Shield, Copy, Check, FileCode, CheckCircle2 } from "lucide-react";
import { WalletInfo } from "../types";

interface Props {
  wallet: WalletInfo | null;
}

export const AuditorTab: React.FC<Props> = ({ wallet }) => {
  const [copied, setCopied] = useState(false);

  // Real zcash-devtool flow (verified against `wallet init-fvk --help`): the owner reads the
  // Receipts account UFVK, the auditor builds a watch-only wallet from it and lists receipts.
  const command = [
    "# 1. Owner: print accounts and copy the UFVK line of the \"receipts\" account",
    "zcash-devtool wallet -w ~/shroud-data/wallet list-accounts",
    "",
    "# 2. Auditor: create a watch-only wallet from that viewing key",
    "zcash-devtool wallet -w ~/auditor-wallet init-fvk --name auditor --fvk <RECEIPTS_UFVK> --birthday <RECEIPTS_BIRTHDAY_HEIGHT>",
    "",
    "# 3. Auditor: sync and read the SHRD1 receipt memos",
    "zcash-devtool wallet -w ~/auditor-wallet sync",
    "zcash-devtool wallet -w ~/auditor-wallet list-tx --mode csv"
  ].join("\n");

  const copyCommand = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Eye className="w-5 h-5 text-amber-400" />
            <span>Auditor Perspective (Selective Disclosure)</span>
          </h2>
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
            Viewing key
          </span>
        </div>
        <p className="text-xs text-slate-400 mt-1">
          Cryptographic selective disclosure using Zcash Viewing Keys. Prove compliance without exposing spend keys.
        </p>
      </div>

      {/* Main explanation card */}
      <div className="rounded-2xl bg-[#0f172a] border border-slate-800 p-6 shadow-xl space-y-5">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20 shrink-0">
            <Shield className="w-6 h-6" />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-white">How Selective Disclosure Works</h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              In traditional finance and transparent blockchains, proving an expense reveals your
              entire wallet balance, past transactions, and counterparty graph. With Zcash zero-knowledge
              proofs, your vault spends privately from the shielded pool.
            </p>
            <p className="text-xs text-slate-300 leading-relaxed">
              Every payment also sends an encrypted receipt to a separate <strong>Receipts Account</strong>.
              To prove your spending to an accountant or regulator, you share only that account's{" "}
              <strong>viewing key (UFVK)</strong>. It reveals the receipts, but not your{" "}
              <strong>Vault Account</strong> balance or history, and it can never spend.
            </p>
          </div>
        </div>

        {/* Viewing Key Export Command */}
        <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <FileCode className="w-4 h-4 text-amber-400" />
              Share receipts with an auditor (zcash-devtool)
            </span>
            <button
              onClick={copyCommand}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-medium transition"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy commands</span>
                </>
              )}
            </button>
          </div>

          <pre className="p-3 bg-black/60 rounded-lg border border-slate-800 font-mono text-xs text-amber-300 whitespace-pre-wrap break-all select-all">
            {command}
          </pre>
          {wallet?.receiptsAddress && (
            <p className="text-[11px] text-slate-400 break-all">
              Receipts account address: <span className="font-mono text-slate-300">{wallet.receiptsAddress}</span>
            </p>
          )}
          <p className="text-[11px] text-slate-500">
            The UFVK is a privacy secret: anyone holding it can read every receipt. Share it only with the auditor.
          </p>
        </div>

        {/* Benefits List */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 text-xs space-y-2">
            <div className="flex items-center gap-2 text-white font-semibold">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Zero Spend Authority</span>
            </div>
            <p className="text-slate-400 leading-relaxed">
              The auditor cannot spend, transfer, or move any funds. The viewing key only lets them
              decrypt the Receipts account's shielded memos.
            </p>
          </div>

          <div className="p-4 rounded-xl bg-slate-900/60 border border-slate-800 text-xs space-y-2">
            <div className="flex items-center gap-2 text-white font-semibold">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>Full Audit Trail</span>
            </div>
            <p className="text-slate-400 leading-relaxed">
              Every purchase writes an encrypted SHRD1 memo on-chain with the product, face value,
              USD price, ZEC paid and timestamp, in the same transaction as the payment.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

