import React, { useState, useEffect } from 'react';
import { 
  X, MapPin, Search, Globe, ShieldCheck, Biohazard, 
  ArrowRight, Sparkles, Navigation, Loader2, Trophy, Compass
} from 'lucide-react';
import { subscribeToCities, createCityProgressive } from '../../lib/api';

interface Props {
  currentCityId: string;
  currentCityName: string;
  onSelectCity: (cityId: string, cityName: string) => void;
  onClose: () => void;
  unlockedBadges?: string[];
}

export const AdjacentCitiesModal: React.FC<Props> = ({
  currentCityId,
  currentCityName,
  onSelectCity,
  onClose,
  unlockedBadges = []
}) => {
  const [existingCities, setExistingCities] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  // Subscribe to all available cities in Firestore
  useEffect(() => {
    const unsub = subscribeToCities((cities) => {
      setExistingCities(cities);
    });
    return () => unsub();
  }, []);

  // Search OSM Nominatim for new communes/cities
  const handleSearchOSM = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    setSearchResults([]);
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(searchQuery)}&addressdetails=1&limit=5`);
      const data = await res.json();
      setSearchResults(data || []);
    } catch (err) {
      console.error('Error searching OSM cities:', err);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelectExistingCity = (city: any) => {
    onSelectCity(city.id, city.name || city.cityName || 'Commune');
    onClose();
  };

  const handleCreateAndSelectOSMCity = async (item: any) => {
    setIsCreating(true);
    try {
      const cityName = item.name || item.display_name?.split(',')[0] || 'Commune';
      const lat = parseFloat(item.lat);
      const lon = parseFloat(item.lon);
      const osmRelationId = item.osm_type === 'relation' ? item.osm_id : undefined;

      const newCityId = await createCityProgressive(cityName, osmRelationId, lat, lon);
      onSelectCity(newCityId, cityName);
      onClose();
    } catch (err) {
      console.error('Error creating city from OSM:', err);
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-950/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-6 overflow-y-auto animate-fadeIn">
      <div className="bg-[#0b1329] border border-cyan-500/40 w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="bg-gradient-to-r from-cyan-950/80 via-slate-900 to-indigo-950/80 p-5 border-b border-cyan-500/30 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-cyan-500/20 border border-cyan-500/40 rounded-2xl text-cyan-400 shadow-lg shadow-cyan-500/10">
              <Compass className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-cyan-400">Carte du Monde & Communes</span>
                <span className="bg-emerald-950 border border-emerald-500/40 text-emerald-300 text-[9px] font-mono px-2 py-0.5 rounded-full font-bold">
                  LIBÉRATION GLOBALE
                </span>
              </div>
              <h2 className="text-lg font-black text-white flex items-center gap-2">
                Communes Limitrophes & Déplacements
              </h2>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white bg-slate-800/60 hover:bg-slate-700/80 rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Current Location Banner */}
        <div className="p-4 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-emerald-400" />
            <span className="text-slate-400">Commune Actuelle :</span>
            <strong className="text-white text-sm">{currentCityName}</strong>
          </div>
          <span className="px-2.5 py-1 rounded-full bg-emerald-950 border border-emerald-500/40 text-emerald-300 font-mono text-[10px] font-bold">
            Zone d'Opération
          </span>
        </div>

        {/* Content Body */}
        <div className="p-5 overflow-y-auto space-y-5 flex-1 bg-[#0b1329]">

          {/* Existing Known Cities in Database */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">
              Communes Cartographiées ({existingCities.length}) :
            </h4>

            {existingCities.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500 bg-slate-950 rounded-2xl border border-slate-800">
                Aucune autre commune n'est enregistrée pour le moment.
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {existingCities.map((city) => {
                  const isCurrent = city.id === currentCityId;
                  const cName = city.name || city.cityName || 'Commune';
                  const badgeTitle = `Libérateur de ${cName}`;
                  const isPacified = unlockedBadges.includes(badgeTitle);

                  return (
                    <div 
                      key={city.id}
                      className={`p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 ${
                        isCurrent
                          ? 'bg-emerald-950/30 border-emerald-500/50 text-emerald-200'
                          : isPacified
                          ? 'bg-amber-950/20 border-amber-500/40 text-amber-200'
                          : 'bg-slate-900/90 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <h4 className="text-sm font-bold text-white flex items-center gap-1.5">
                            <MapPin className="w-3.5 h-3.5 text-cyan-400" />
                            {cName}
                          </h4>
                          {isPacified && (
                            <span className="px-2 py-0.5 rounded-full bg-amber-500/20 border border-amber-400/40 text-amber-300 text-[9px] font-bold flex items-center gap-1">
                              <Trophy className="w-3 h-3" /> Pacifiée
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-slate-400 font-mono">
                          Commune Vaudoise / Suisse
                        </p>
                      </div>

                      <div className="flex items-center justify-between pt-2 border-t border-slate-800/60">
                        {isCurrent ? (
                          <span className="text-[10px] font-bold text-emerald-400 font-mono uppercase">
                            ✓ Position Actuelle
                          </span>
                        ) : (
                          <button
                            onClick={() => handleSelectExistingCity(city)}
                            className="w-full px-3 py-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                          >
                            <span>Se Déplacer ici</span>
                            <ArrowRight className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-950 border-t border-slate-800 flex justify-between items-center text-xs text-slate-400">
          <span>Déplacements sécurisés par la Résistance.</span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold transition-colors cursor-pointer"
          >
            Fermer
          </button>
        </div>

      </div>
    </div>
  );
};
