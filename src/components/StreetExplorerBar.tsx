import React, { useState } from 'react';
import { Search, MapPin, Loader2, Navigation, Sparkles } from 'lucide-react';
import { searchStreetInCity, fetchStreetOrAreaFeatures } from '../lib/api';

interface StreetExplorerBarProps {
  cityId: string;
  cityName: string;
  cityLat?: number;
  cityLon?: number;
  onNavigateToCoords: (lat: number, lon: number, zoom?: number) => void;
  onStreetLoaded?: (streetName: string, count: number) => void;
}

export function StreetExplorerBar({
  cityId,
  cityName,
  cityLat,
  cityLon,
  onNavigateToCoords,
  onStreetLoaded
}: StreetExplorerBarProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [loadingStreet, setLoadingStreet] = useState(false);
  const [lastLoadedStreet, setLastLoadedStreet] = useState<string | null>(null);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setResults([]);
    try {
      const res = await searchStreetInCity(cityName, query);
      setResults(res);
      if (res.length === 0) {
        setLastLoadedStreet(`Aucune rue trouvée pour "${query}"`);
      }
    } catch (e) {
      console.warn("Street search error:", e);
    } finally {
      setSearching(false);
    }
  };

  const handleSelectStreet = async (item: any) => {
    setResults([]);
    setQuery(item.name);
    setLoadingStreet(true);

    try {
      onNavigateToCoords(item.lat, item.lon, 17);
      const features = await fetchStreetOrAreaFeatures(cityId, cityName, item.lat, item.lon, 350);
      setLastLoadedStreet(`${item.name} (${features.length} éléments générés)`);
      if (onStreetLoaded) onStreetLoaded(item.name, features.length);
    } catch (err) {
      console.warn("Error loading street:", err);
    } finally {
      setLoadingStreet(false);
    }
  };

  const handleCenterCity = async () => {
    if (!cityLat || !cityLon) return;
    setLoadingStreet(true);
    try {
      onNavigateToCoords(cityLat, cityLon, 16);
      const features = await fetchStreetOrAreaFeatures(cityId, cityName, cityLat, cityLon, 350);
      setLastLoadedStreet(`Centre-ville (${features.length} éléments)`);
    } finally {
      setLoadingStreet(false);
    }
  };

  return (
    <div className="relative z-[2000] w-full max-w-lg mx-auto">
      <div className="bg-slate-950/90 border border-cyan-500/40 rounded-2xl shadow-2xl p-2 sm:p-2.5 backdrop-blur-md flex items-center gap-2">
        <form onSubmit={handleSearch} className="flex-1 flex items-center gap-2 relative">
          <Search className="w-4 h-4 text-cyan-400 shrink-0 ml-1.5" />
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value) setResults([]);
            }}
            placeholder={`Rechercher une rue à ${cityName}... (ex: Rue de la Gare, Grand-Rue)`}
            className="w-full bg-transparent text-white placeholder-slate-400 text-xs sm:text-sm outline-none font-medium"
          />
          {searching && <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin shrink-0 mr-1" />}
        </form>

        <button
          onClick={handleCenterCity}
          disabled={loadingStreet || !cityLat}
          className="bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-700/60 text-cyan-300 text-xs font-semibold px-2.5 py-1.5 rounded-xl transition-colors flex items-center gap-1.5 shrink-0 cursor-pointer disabled:opacity-50"
          title="Centrer sur le centre-ville et générer la zone"
        >
          <Navigation className="w-3.5 h-3.5 text-cyan-400" />
          <span className="hidden sm:inline">Centre-ville</span>
        </button>
      </div>

      {/* Street search suggestions list */}
      {results.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden z-[2500]">
          <div className="px-3 py-2 text-[10px] uppercase font-bold text-slate-400 bg-slate-900/60 border-b border-slate-800/80">
            Rues trouvées à {cityName}
          </div>
          <div className="max-h-48 overflow-y-auto">
            {results.map((item, idx) => (
              <button
                key={idx}
                onClick={() => handleSelectStreet(item)}
                className="w-full text-left px-3.5 py-2.5 text-xs text-slate-200 hover:bg-cyan-950/60 hover:text-cyan-300 transition-colors flex items-center gap-2.5 border-b border-slate-900/80 last:border-b-0 cursor-pointer"
              >
                <MapPin className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-white truncate">{item.name}</div>
                  <div className="text-[10px] text-slate-400 truncate">{item.displayName}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {loadingStreet && (
        <div className="mt-1.5 flex items-center justify-center gap-2 text-[11px] font-semibold text-cyan-400 bg-cyan-950/90 border border-cyan-800/60 rounded-xl py-1 px-3 animate-pulse text-center">
          <Loader2 className="w-3 h-3 animate-spin" />
          Génération de la rue & structures en cours...
        </div>
      )}

      {lastLoadedStreet && !loadingStreet && (
        <div className="mt-1.5 flex items-center justify-center gap-1.5 text-[11px] font-medium text-emerald-400 bg-emerald-950/70 border border-emerald-800/40 rounded-xl py-0.5 px-3 text-center">
          <Sparkles className="w-3 h-3 text-emerald-400 shrink-0" />
          <span>{lastLoadedStreet}</span>
        </div>
      )}
    </div>
  );
}
