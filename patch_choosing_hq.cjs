const fs = require('fs');
let code = fs.readFileSync('src/components/survival/BuildingDetailModal.tsx', 'utf8');

code = code.replace(
  `          {/* TAB 1: INFO & ATTRIBUTES */}
          {activeTab === 'info' && (
            <div className="space-y-5">
              {reconPercent === 0 && !isHQ ? (`,
  `          {/* TAB 1: INFO & ATTRIBUTES */}
          {activeTab === 'info' && isChoosingHQMode && (
             <div className="space-y-5">
                <div className="bg-slate-900/90 border border-emerald-500/40 rounded-3xl p-6 text-center space-y-4">
                  <div className="mx-auto w-16 h-16 rounded-full bg-emerald-950/80 border border-emerald-500/50 flex items-center justify-center mb-2">
                    <Home className="w-8 h-8 text-emerald-400" />
                  </div>
                  <h3 className="text-xl font-black text-white">Validation du Quartier Général</h3>
                  <p className="text-sm text-slate-300 max-w-md mx-auto">
                    Vous êtes sur le point d'établir votre base dans ce bâtiment. 
                    Il n'y a pas de coût de déplacement pour cette première installation.
                  </p>
                  
                  <div className="flex flex-col items-center justify-center p-4 bg-slate-950 rounded-2xl border border-slate-800 mx-auto max-w-sm mt-4">
                    <span className="text-xs font-bold text-slate-400 uppercase mb-1">Capacité d'accueil</span>
                    <div className="flex items-center gap-2">
                      <Users className="w-5 h-5 text-emerald-400" />
                      <span className="text-2xl font-black text-white">{building.maxHousingCapacity} <span className="text-sm text-slate-400 font-normal">Places / Lits</span></span>
                    </div>
                    {building.maxHousingCapacity < 5 && (
                      <div className="mt-3 text-[11px] font-bold text-rose-400 bg-rose-950/50 px-3 py-1.5 rounded-lg border border-rose-900">
                        ⚠️ Ce bâtiment est trop petit. (Minimum 5 places requises)
                      </div>
                    )}
                  </div>
                </div>
             </div>
          )}
          {activeTab === 'info' && !isChoosingHQMode && (
            <div className="space-y-5">
              {reconPercent === 0 && !isHQ ? (`
);

fs.writeFileSync('src/components/survival/BuildingDetailModal.tsx', code);
