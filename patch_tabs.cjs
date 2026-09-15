const fs = require('fs');
let code = fs.readFileSync('src/components/survival/BuildingDetailModal.tsx', 'utf8');

code = code.replace(
  `          <button
            onClick={() => setActiveTab('loot')}
            className={\`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 \${
              activeTab === 'loot'
                ? 'bg-[#090d16] border-t border-x border-cyan-500/50 text-cyan-400 shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
            }\`}
          >
            <Package className="w-3.5 h-3.5" />
            <span>Stuff & Stockage ({(reconPercent === 0 && !isHQ) ? '?' : buildingItems.length})</span>
          </button>`,
  `          {!isChoosingHQMode && (
            <button
              onClick={() => setActiveTab('loot')}
              className={\`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 \${
                activeTab === 'loot'
                  ? 'bg-[#090d16] border-t border-x border-cyan-500/50 text-cyan-400 shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }\`}
            >
              <Package className="w-3.5 h-3.5" />
              <span>Stuff & Stockage ({(reconPercent === 0 && !isHQ) ? '?' : buildingItems.length})</span>
            </button>
          )}`
);

code = code.replace(
  `          {charactersInThisBuilding.length > 0 && (
            <button
              onClick={() => setActiveTab('squad')}
              className={\`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 \${
                activeTab === 'squad'
                  ? 'bg-[#090d16] border-t border-x border-cyan-500/50 text-cyan-400 shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }\`}
            >
              <Users className="w-3.5 h-3.5" />
              <span>Mon Équipe ({charactersInThisBuilding.length})</span>
            </button>
          )}`,
  `          {!isChoosingHQMode && charactersInThisBuilding.length > 0 && (
            <button
              onClick={() => setActiveTab('squad')}
              className={\`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 \${
                activeTab === 'squad'
                  ? 'bg-[#090d16] border-t border-x border-cyan-500/50 text-cyan-400 shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }\`}
            >
              <Users className="w-3.5 h-3.5" />
              <span>Mon Équipe ({charactersInThisBuilding.length})</span>
            </button>
          )}`
);

code = code.replace(
  `          <button
            onClick={() => setActiveTab('chars')}
            className={\`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 \${
              activeTab === 'chars'
                ? 'bg-[#090d16] border-t border-x border-rose-500/50 text-rose-400 shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
            }\`}
          >
            <Skull className="w-3.5 h-3.5" />
            <span>Occupants ({(reconPercent === 0 && !isHQ) ? '?' : buildingChars.length})</span>
          </button>`,
  `          {!isChoosingHQMode && (
            <button
              onClick={() => setActiveTab('chars')}
              className={\`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 \${
                activeTab === 'chars'
                  ? 'bg-[#090d16] border-t border-x border-rose-500/50 text-rose-400 shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }\`}
            >
              <Skull className="w-3.5 h-3.5" />
              <span>Occupants ({(reconPercent === 0 && !isHQ) ? '?' : buildingChars.length})</span>
            </button>
          )}`
);

code = code.replace(
  `          <button
            onClick={() => setActiveTab('vehicles')}
            className={\`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 \${
              activeTab === 'vehicles'
                ? 'bg-[#090d16] border-t border-x border-amber-500/50 text-amber-400 shadow-md'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
            }\`}
          >
            <Car className="w-3.5 h-3.5" />
            <span>
              Véhicules ({(reconPercent === 0 && !isHQ) ? '?' : Math.max(1, Math.ceil((reconPercent / 100) * buildingVehicles.length))})
            </span>
          </button>`,
  `          {!isChoosingHQMode && (
            <button
              onClick={() => setActiveTab('vehicles')}
              className={\`px-4 py-2 text-xs font-bold rounded-t-xl transition-all cursor-pointer flex items-center gap-2 \${
                activeTab === 'vehicles'
                  ? 'bg-[#090d16] border-t border-x border-amber-500/50 text-amber-400 shadow-md'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/50'
              }\`}
            >
              <Car className="w-3.5 h-3.5" />
              <span>
                Véhicules ({(reconPercent === 0 && !isHQ) ? '?' : Math.max(1, Math.ceil((reconPercent / 100) * buildingVehicles.length))})
              </span>
            </button>
          )}`
);

fs.writeFileSync('src/components/survival/BuildingDetailModal.tsx', code);
