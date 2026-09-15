import React, { useMemo } from 'react';
import { CityResourceRatios, computeCityResourceRatios } from '../../lib/resourceRatios';
import { Wheat, Trees, Droplets, Wrench, Shield, Compass, BarChart3, Info } from 'lucide-react';

interface Props {
  geoData: any;
  population: number | null;
  areaKm2: number | null;
  cityName: string;
}

export const CityResourceGauges: React.FC<Props> = ({ geoData, population, areaKm2, cityName }) => {
  const ratios: CityResourceRatios = useMemo(() => {
    return computeCityResourceRatios(geoData, population, areaKm2);
  }, [geoData, population, areaKm2]);

  return (
    <div className="bg-slate-900/80 border border-slate-800 p-4 rounded-2xl space-y-4 shadow-xl">
      <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-emerald-950/60 border border-emerald-500/30 text-emerald-400">
            <Compass className="w-4 h-4 animate-pulse" />
          </div>
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wider text-white flex items-center gap-1.5">
              Ressources & Terrains de {cityName}
            </h3>
            <p className="text-[10px] text-slate-400">Calculé en temps réel d'après les surfaces OSM</p>
          </div>
        </div>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-cyan-300 font-bold">
          {ratios.totalAreaKm2} km²
        </span>
      </div>

      {/* Surface Breakdown Badges */}
      <div className="grid grid-cols-4 gap-1.5 text-[10px] text-center font-mono">
        <div className="bg-amber-950/30 border border-amber-500/20 p-1.5 rounded-lg">
          <div className="text-amber-400 font-bold">{ratios.farmlandPct}%</div>
          <div className="text-slate-400 text-[9px] truncate">🌾 Agricole</div>
        </div>
        <div className="bg-emerald-950/30 border border-emerald-500/20 p-1.5 rounded-lg">
          <div className="text-emerald-400 font-bold">{ratios.forestPct}%</div>
          <div className="text-slate-400 text-[9px] truncate">🌲 Forêts</div>
        </div>
        <div className="bg-sky-950/30 border border-sky-500/20 p-1.5 rounded-lg">
          <div className="text-sky-400 font-bold">{ratios.waterPct}%</div>
          <div className="text-slate-400 text-[9px] truncate">💧 Eau</div>
        </div>
        <div className="bg-cyan-950/30 border border-cyan-500/20 p-1.5 rounded-lg">
          <div className="text-cyan-400 font-bold">{ratios.residentialPct}%</div>
          <div className="text-slate-400 text-[9px] truncate">🏠 Habité</div>
        </div>
      </div>

      {/* Resource Gauges */}
      <div className="space-y-3 pt-1">

        {/* 1. Food / Agriculture Gauge */}
        <div className="space-y-1">
          <div className="flex justify-between items-center text-xs">
            <span className="text-amber-300 font-medium flex items-center gap-1.5">
              <Wheat className="w-3.5 h-3.5 text-amber-400" /> Nourriture & Terres Agricoles
            </span>
            <span className="text-[10px] font-mono font-bold text-amber-200">{ratios.foodScore}%</span>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700/50">
            <div
              className="bg-gradient-to-r from-amber-600 via-amber-500 to-yellow-400 h-full transition-all duration-500"
              style={{ width: `${ratios.foodScore}%` }}
            ></div>
          </div>
          <div className="flex justify-between text-[10px] text-slate-400 italic">
            <span>{ratios.foodLabel}</span>
            <span>{((ratios.farmlandM2 || 0) / 10000).toFixed(1)} ha cultivés</span>
          </div>
        </div>

        {/* 2. Wood & Materials Gauge */}
        <div className="space-y-1">
          <div className="flex justify-between items-center text-xs">
            <span className="text-emerald-300 font-medium flex items-center gap-1.5">
              <Trees className="w-3.5 h-3.5 text-emerald-400" /> Bois & Matériaux de Construction
            </span>
            <span className="text-[10px] font-mono font-bold text-emerald-200">{ratios.woodScore}%</span>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700/50">
            <div
              className="bg-gradient-to-r from-emerald-700 via-emerald-500 to-teal-400 h-full transition-all duration-500"
              style={{ width: `${ratios.woodScore}%` }}
            ></div>
          </div>
          <div className="flex justify-between text-[10px] text-slate-400 italic">
            <span>{ratios.woodLabel}</span>
            <span>{((ratios.forestM2 || 0) / 10000).toFixed(1)} ha de forêt</span>
          </div>
        </div>

        {/* 3. Water Gauge */}
        <div className="space-y-1">
          <div className="flex justify-between items-center text-xs">
            <span className="text-sky-300 font-medium flex items-center gap-1.5">
              <Droplets className="w-3.5 h-3.5 text-sky-400" /> Reservoirs & Points d'Eau
            </span>
            <span className="text-[10px] font-mono font-bold text-sky-200">{ratios.waterScore}%</span>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700/50">
            <div
              className="bg-gradient-to-r from-sky-700 via-sky-500 to-cyan-300 h-full transition-all duration-500"
              style={{ width: `${ratios.waterScore}%` }}
            ></div>
          </div>
          <div className="flex justify-between text-[10px] text-slate-400 italic">
            <span>{ratios.waterLabel}</span>
            <span>{((ratios.waterM2 || 0) / 10000).toFixed(1)} ha de surfaces d'eau</span>
          </div>
        </div>

        {/* 4. Equipment / Craft / Loot Gauge */}
        <div className="space-y-1">
          <div className="flex justify-between items-center text-xs">
            <span className="text-purple-300 font-medium flex items-center gap-1.5">
              <Wrench className="w-3.5 h-3.5 text-purple-400" /> Outillage, Loot & Commerces
            </span>
            <span className="text-[10px] font-mono font-bold text-purple-200">{ratios.equipmentScore}%</span>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700/50">
            <div
              className="bg-gradient-to-r from-purple-700 via-indigo-500 to-pink-400 h-full transition-all duration-500"
              style={{ width: `${ratios.equipmentScore}%` }}
            ></div>
          </div>
          <div className="flex justify-between text-[10px] text-slate-400 italic">
            <span>{ratios.equipmentLabel}</span>
            <span>{ratios.poiCount} points d'intérêt répertoriés</span>
          </div>
        </div>

        {/* 5. Shelter Gauge */}
        <div className="space-y-1">
          <div className="flex justify-between items-center text-xs">
            <span className="text-cyan-300 font-medium flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-cyan-400" /> Capacité d'Abri & Bâtiments
            </span>
            <span className="text-[10px] font-mono font-bold text-cyan-200">{ratios.shelterScore}%</span>
          </div>
          <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden border border-slate-700/50">
            <div
              className="bg-gradient-to-r from-cyan-700 via-teal-500 to-emerald-400 h-full transition-all duration-500"
              style={{ width: `${ratios.shelterScore}%` }}
            ></div>
          </div>
          <div className="flex justify-between text-[10px] text-slate-400 italic">
            <span>{ratios.shelterLabel}</span>
            <span>{ratios.buildingCount} bâtiments habitables/utiles</span>
          </div>
        </div>

      </div>

      <div className="pt-1 text-[10px] text-slate-400 bg-slate-950/50 p-2 rounded-xl border border-slate-800 flex items-start gap-1.5 leading-tight">
        <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0 mt-0.5" />
        <span>
          Les ratios déterminent l'abondance du loot en fouille et les risques d'insécurité alimentaire ou de pénuries dans la commune.
        </span>
      </div>
    </div>
  );
};
