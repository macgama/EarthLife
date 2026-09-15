import React from 'react';
import { X, Sparkles, Package, Users, Skull, AlertCircle } from 'lucide-react';
import { ScavengeDiscovery } from '../../lib/character';

export interface ActiveScavengeToast {
  id: string;
  buildingName: string;
  discovery: ScavengeDiscovery;
}

interface ScavengeToastOverlayProps {
  toasts: ActiveScavengeToast[];
  onDismiss: (id: string) => void;
}

export const ScavengeToastOverlay: React.FC<ScavengeToastOverlayProps> = ({
  toasts,
  onDismiss
}) => {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-4 z-[99999] flex flex-col gap-3 max-w-md w-full pointer-events-none">
      {toasts.map((toast) => {
        const { discovery, buildingName } = toast;

        const isItem = discovery.type === 'item';
        const isZombie = discovery.type === 'zombie';
        const isSurvivor = discovery.type === 'survivor';

        const borderClass = isZombie 
          ? 'border-rose-500/80 bg-slate-950/95 shadow-[0_0_30px_rgba(244,63,94,0.4)]'
          : isSurvivor 
          ? 'border-emerald-500/80 bg-slate-950/95 shadow-[0_0_30px_rgba(16,185,129,0.4)]'
          : 'border-amber-500/80 bg-slate-950/95 shadow-[0_0_30px_rgba(245,158,11,0.4)]';

        const headerBadge = isZombie
          ? 'bg-rose-950 text-rose-300 border-rose-500/50'
          : isSurvivor
          ? 'bg-emerald-950 text-emerald-300 border-emerald-500/50'
          : 'bg-amber-950 text-amber-300 border-amber-500/50';

        return (
          <div
            key={toast.id}
            className={`pointer-events-auto p-4 rounded-2xl border-2 backdrop-blur-md transition-all animate-bounceIn flex items-start gap-3.5 relative overflow-hidden ${borderClass}`}
          >
            {/* Ambient Background Glow */}
            <div className="absolute -top-10 -right-10 w-24 h-24 rounded-full bg-amber-500/10 blur-xl pointer-events-none" />

            {/* Icon */}
            <div className="w-12 h-12 rounded-2xl bg-slate-900 border border-slate-700 flex items-center justify-center text-2xl shrink-0 shadow-md">
              {discovery.icon}
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0 pr-6">
              <div className="flex items-center gap-2 mb-1">
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase border ${headerBadge}`}>
                  🔍 Fouille : {buildingName}
                </span>
              </div>

              <h4 className="text-xs font-bold text-white tracking-wide">
                {discovery.title}
              </h4>

              <p className="text-[11px] text-slate-300 mt-0.5 leading-snug line-clamp-2">
                {discovery.description}
              </p>

              {/* Specific Items Badges */}
              {discovery.itemsFound && discovery.itemsFound.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {discovery.itemsFound.map((item, i) => (
                    <span 
                      key={i} 
                      className="px-2 py-0.5 rounded-lg bg-amber-950/80 border border-amber-500/40 text-[10px] font-mono font-bold text-amber-300 flex items-center gap-1"
                    >
                      <span>{item.icon}</span>
                      <span>{item.name} x{item.quantity}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* Close Button */}
            <button
              onClick={() => onDismiss(toast.id)}
              className="absolute top-2.5 right-2.5 p-1 rounded-full text-slate-400 hover:text-white hover:bg-slate-800 transition-all cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
};
