const fs = require('fs');
let code = fs.readFileSync('src/components/survival/BuildingDetailModal.tsx', 'utf8');

code = code.replace(
  `          {onSetHQ && !isHQ && (
            <button
              onClick={() => {
                onSetHQ(building);
                onClose();
              }}
              className="px-6 py-2.5 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-bold text-xs rounded-2xl shadow-xl shadow-emerald-950/80 flex items-center gap-2 transition-all cursor-pointer ring-2 ring-emerald-400/30"
            >
              <CheckCircle2 className="w-4.5 h-4.5" />
              <span>Valider ce bâtiment comme QG ({building.maxHousingCapacity} lits)</span>
            </button>
          )}`,
  `          {onSetHQ && !isHQ && (
            <button
              onClick={() => {
                if (isChoosingHQMode && building.maxHousingCapacity < 5) return;
                onSetHQ(building);
                onClose();
              }}
              className={\`px-6 py-2.5 font-bold text-xs rounded-2xl flex items-center gap-2 transition-all \${
                isChoosingHQMode && building.maxHousingCapacity < 5 
                  ? 'bg-slate-800 text-slate-500 cursor-not-allowed opacity-50'
                  : 'bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white cursor-pointer shadow-xl shadow-emerald-950/80 ring-2 ring-emerald-400/30'
              }\`}
              disabled={isChoosingHQMode && building.maxHousingCapacity < 5}
            >
              <CheckCircle2 className="w-4.5 h-4.5" />
              <span>Valider ce bâtiment comme QG ({building.maxHousingCapacity} lits)</span>
            </button>
          )}`
);

fs.writeFileSync('src/components/survival/BuildingDetailModal.tsx', code);
