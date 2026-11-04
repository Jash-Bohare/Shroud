import React, { useState } from "react";
import { KeyRound, ShieldAlert } from "lucide-react";

interface Props {
  isOpen: boolean;
  onSave: (token: string) => void;
  error?: string | null;
}

export const TokenModal: React.FC<Props> = ({ isOpen, onSave, error }) => {
  const [tokenInput, setTokenInput] = useState("");

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (tokenInput.trim()) {
      onSave(tokenInput.trim());
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md rounded-2xl bg-[#0f172a] border border-slate-700/80 p-6 shadow-2xl">
        <div className="flex items-center gap-3 text-amber-500 mb-4">
          <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <KeyRound className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Dashboard Access</h2>
            <p className="text-xs text-slate-400">Your Shroud runs on this computer. This token proves it's you.</p>
          </div>
        </div>

        {error && (
          <div className="mb-4 flex items-center gap-2 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs">
            <ShieldAlert className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-300 mb-1.5">
              Dashboard Token (Bearer)
            </label>
            <input
              type="password"
              placeholder="Paste DASHBOARD_TOKEN"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              className="w-full px-3.5 py-2.5 bg-slate-900 border border-slate-700 rounded-xl text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-amber-500/50"
              autoFocus
            />
            <div className="text-[11px] text-slate-500 mt-2 space-y-1">
              <p>
                <strong className="text-slate-300">Easiest:</strong> run <code>npm run dashboard:link</code> in the
                Shroud folder and open the link it prints. You're signed in automatically.
              </p>
              <p>
                <strong className="text-slate-300">Or</strong> paste the <code>DASHBOARD_TOKEN</code> value from your{" "}
                <code>.env</code>. It stops other websites in your browser from reading or controlling your vault.
              </p>
            </div>
          </div>

          <button
            type="submit"
            disabled={!tokenInput.trim()}
            className="w-full py-2.5 px-4 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-black font-semibold text-sm rounded-xl transition duration-150"
          >
            Unlock Dashboard
          </button>
        </form>
      </div>
    </div>
  );
};

