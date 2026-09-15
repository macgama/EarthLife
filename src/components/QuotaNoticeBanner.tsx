import React, { useEffect, useState } from 'react';
import { AlertTriangle, HardDrive, X } from 'lucide-react';
import { subscribeQuotaState } from '../lib/quotaStorage';

export function QuotaNoticeBanner() {
  const [exceeded, setExceeded] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    return subscribeQuotaState((isExceeded) => {
      setExceeded(isExceeded);
    });
  }, []);

  if (!exceeded || dismissed) return null;

  return (
    <div className="bg-amber-950/90 border-b border-amber-500/40 text-amber-200 px-4 py-2.5 shadow-lg backdrop-blur-md z-[9999] flex items-center justify-between gap-3 text-xs md:text-sm">
      <div className="flex items-center gap-2.5">
        <div className="p-1.5 bg-amber-500/20 rounded-lg text-amber-400 shrink-0">
          <AlertTriangle className="w-4 h-4" />
        </div>
        <div>
          <span className="font-semibold text-amber-300">Quota Firestore atteint (limite gratuite de la base de données)</span>
          <span className="hidden sm:inline mx-1.5 text-amber-500">•</span>
          <span className="block sm:inline text-amber-200/80">
            Passage automatique en mode sauvegarde locale (<HardDrive className="w-3 h-3 inline mx-0.5" /> localStorage). L'application continue de fonctionner sans perte de données.
          </span>
        </div>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-amber-400 hover:text-amber-100 hover:bg-amber-800/40 p-1 rounded-md transition-colors shrink-0"
        title="Fermer cet avertissement"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
