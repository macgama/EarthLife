import React from "react";
import { useState, useEffect } from 'react';
import { subscribeToCities, createCityProgressive, searchCitiesWithNominatim, isValidCityOrVillage } from '../lib/api';
import { Loader2, Search, Map as MapIcon, ChevronRight, Sun, Cloud, CloudRain, Snowflake, CloudLightning, CloudFog, Users, Mountain } from 'lucide-react';


function CityWeather({ lat, lon, cityName }: { lat?: number, lon?: number, cityName: string }) {
  const [weather, setWeather] = useState<any>(null);

  useEffect(() => {
    async function fetchWeather() {
      try {
        let fetchLat = lat;
        let fetchLon = lon;
        
        // If no lat/lon, try to geocode quickly using Nominatim (just taking the first result)
        if (!fetchLat || !fetchLon) {
          const res = await searchCitiesWithNominatim(cityName);
          if (res && res.length > 0) {
            fetchLat = parseFloat(res[0].lat);
            fetchLon = parseFloat(res[0].lon);
          }
        }

        if (fetchLat && fetchLon) {
          const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${fetchLat}&longitude=${fetchLon}&current_weather=true`);
          const data = await res.json();
          if (data.current_weather) {
            setWeather(data.current_weather);
          }
        }
      } catch (e) {
        console.warn("Weather fetch failed for", cityName, e);
      }
    }
    fetchWeather();
  }, [lat, lon, cityName]);

  if (!weather) return <div className="h-6"></div>;

  let WeatherIcon = Sun;
  const code = weather.weathercode;
  if (code === 0) WeatherIcon = Sun;
  else if (code === 1 || code === 2 || code === 3) WeatherIcon = Cloud;
  else if (code === 45 || code === 48) WeatherIcon = CloudFog;
  else if (code >= 51 && code <= 67) WeatherIcon = CloudRain;
  else if (code >= 71 && code <= 77) WeatherIcon = Snowflake;
  else if (code >= 80 && code <= 82) WeatherIcon = CloudRain;
  else if (code >= 95 && code <= 99) WeatherIcon = CloudLightning;

  return (
    <div className="flex items-center gap-2 text-slate-300 mt-2 bg-slate-900/50 rounded-md px-2 py-1 w-fit border border-slate-700/50">
      <WeatherIcon className="w-3.5 h-3.5 text-cyan-400" />
      <span className="text-[10px] font-medium">{weather.temperature}°C</span>
    </div>
  );
}

export function CitySelector({ onSelectCity }: { onSelectCity: (cityId: string, cityName: string) => void }) {
  const [cities, setCities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const unsubscribe = subscribeToCities((data) => {
      setCities(data);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim()) return;

    setSearching(true);
    setError('');
    setSearchResults([]);
    
    try {
      const results = await searchCitiesWithNominatim(searchQuery);
      if (results.length === 0) {
        throw new Error("Aucune ville trouvée.");
      }
      setSearchResults(results);
    } catch (err: any) {
      setError(err.message || 'Erreur de recherche');
    } finally {
      setSearching(false);
    }
  };

  const handleGenerate = async (result: any) => {
    // If it already exists in DB, just select it
    const existingCity = cities.find(c => c.name.toLowerCase() === result.name.toLowerCase());
    if (existingCity) {
      onSelectCity(existingCity.id, existingCity.name);
      return;
    }

    setGenerating(true);
    setError('');
    
    try {
      // Pass the name, and if it's a relation, pass the osm_id
      const relationId = result.osm_type === 'relation' ? result.osm_id : undefined;
      const cityId = await createCityProgressive(result.name, relationId, parseFloat(result.lat), parseFloat(result.lon));
      
      onSelectCity(cityId, result.name);
    } catch (err: any) {
      setError(err.message || 'Erreur de génération');
      setGenerating(false);
    }
  };

  if (loading) {
    return (
      <div className="py-12 w-full flex flex-col items-center justify-center">
        <Loader2 className="w-8 h-8 text-cyan-400 animate-spin mb-3" />
        <span className="text-xs text-slate-400">Chargement des villes...</span>
      </div>
    );
  }

  return (
    <div className="w-full text-slate-200 font-sans">
      <div className="w-full grid grid-cols-1 md:grid-cols-2 gap-6">
        
        {/* Left column: Create new */}
        <div className="bg-[#0f172a]/40 p-5 sm:p-6 rounded-2xl border border-slate-800/80 backdrop-blur-md shadow-xl flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center gap-2 mb-4">
              <div className="w-2.5 h-2.5 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#22d3ee]"></div>
              <span className="text-[11px] font-bold uppercase tracking-[0.2em] text-cyan-400">Nouvelle Zone</span>
            </div>
            
            <h2 className="text-xl sm:text-2xl font-light text-white mb-1.5">Générer une ville</h2>
            <p className="text-slate-400 text-xs sm:text-sm mb-6">Entrez le nom d'une commune pour importer sa frontière et sa rue de départ instantanément.</p>
            
            <form onSubmit={handleSearch} className="space-y-3">
              <div>
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input 
                    type="text" 
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Ex: Vulliens, Bulle, Paris..."
                    className="w-full bg-[#020617] border border-slate-700 text-white pl-9 pr-4 py-2.5 rounded-xl text-sm outline-none focus:border-cyan-400 transition-colors"
                    disabled={searching || generating}
                  />
                </div>
              </div>
              {error && <div className="text-red-400 text-xs">{error}</div>}
              
              <button 
                type="submit" 
                disabled={searching || generating || !searchQuery.trim()}
                className="w-full bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white text-sm font-semibold py-2.5 px-4 rounded-xl transition-colors flex items-center justify-center gap-2 cursor-pointer"
              >
                {searching ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Recherche en cours...</>
                ) : (
                  <><Search className="w-4 h-4" /> Rechercher la ville</>
                )}
              </button>
            </form>
          </div>

          {searchResults.length > 0 && !generating && (
            <div className="mt-4 pt-4 border-t border-slate-800">
              <h3 className="text-xs font-medium text-slate-400 mb-2">Résultats ({searchResults.length})</h3>
              <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                {searchResults.map((result, i) => (
                  <button
                    key={i}
                    onClick={() => handleGenerate(result)}
                    className="w-full text-left bg-[#020617] border border-slate-800 hover:border-cyan-500/50 p-2.5 rounded-xl flex items-center justify-between transition-colors group cursor-pointer"
                  >
                    <div className="min-w-0 flex-1 mr-2">
                      <div className="text-white font-medium text-xs sm:text-sm truncate">{result.name}</div>
                      <div className="text-slate-500 text-[11px] truncate" title={result.display_name}>
                        {result.display_name}
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-cyan-400 shrink-0" />
                  </button>
                ))}
              </div>
            </div>
          )}

          {generating && (
            <div className="mt-4 flex flex-col items-center justify-center p-4 bg-[#020617] rounded-xl border border-cyan-500/30">
              <Loader2 className="w-6 h-6 text-cyan-400 animate-spin mb-2" />
              <div className="text-xs text-cyan-400 font-medium text-center">Génération de la frontière et de la rue de départ...</div>
              <div className="text-[11px] text-slate-400 mt-1.5 text-center leading-relaxed">
                Initialisation rapide en cours (~2 secondes)...
              </div>
            </div>
          )}
        </div>

        {/* Right column: Existing cities */}
        <div className="bg-[#0f172a]/40 p-5 sm:p-6 rounded-2xl border border-slate-800/80 backdrop-blur-md shadow-xl flex flex-col max-h-[480px]">
          <h2 className="text-lg sm:text-xl font-light text-white mb-4">Villes disponibles</h2>
          
          {cities.filter(isValidCityOrVillage).length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-slate-500 text-xs sm:text-sm italic py-8">
              Aucune ville dans la base de données.
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto pr-1.5 space-y-2.5 custom-scrollbar">
              {cities.filter(isValidCityOrVillage).map(city => {
                const isLoading = city.status === 'loading';
                return (
                  <button
                    key={city.id}
                    onClick={() => onSelectCity(city.id, city.name)}
                    className="w-full text-left bg-[#020617] border border-slate-800/90 p-3 sm:p-3.5 rounded-xl flex items-center justify-between gap-3 transition-all group hover:border-cyan-500/50 cursor-pointer overflow-hidden"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="w-10 h-10 rounded-lg bg-cyan-900/30 border border-cyan-800/50 flex items-center justify-center text-cyan-400 group-hover:bg-cyan-900/50 transition-colors shrink-0">
                        <MapIcon className="w-5 h-5" />
                      </div>
                      
                      <div className="space-y-1 min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <h3 className="text-white font-semibold text-sm truncate max-w-[130px] sm:max-w-[160px]">{city.name}</h3>
                          {city.region && (
                            <span className="text-[10px] bg-slate-800 text-slate-300 px-1.5 py-0.5 rounded font-medium border border-slate-700 truncate max-w-[110px]" title={city.region}>
                              {city.region}
                            </span>
                          )}
                        </div>

                        {/* Real statistics badges */}
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                          {city.population !== null && city.population !== undefined && (
                            <span className="flex items-center gap-1 text-slate-300 font-medium">
                              <Users className="w-3 h-3 text-cyan-400 shrink-0" />
                              {city.population.toLocaleString('fr-FR')} hab.
                            </span>
                          )}
                          {city.altitude !== null && city.altitude !== undefined && (
                            <span className="flex items-center gap-1 text-slate-300 font-medium">
                              <Mountain className="w-3 h-3 text-emerald-400 shrink-0" />
                              {city.altitude} m
                            </span>
                          )}
                          <CityWeather lat={city.lat} lon={city.lon} cityName={city.name} />
                        </div>
                      </div>
                    </div>

                    {isLoading ? (
                      <div className="flex items-center gap-1.5 text-cyan-400 text-[11px] font-medium bg-cyan-950/60 px-2 py-1 rounded border border-cyan-800/50 shrink-0">
                        <Loader2 className="w-3 h-3 animate-spin" />
                        <span className="hidden sm:inline">Génération...</span>
                      </div>
                    ) : (
                      <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-cyan-400 transition-colors shrink-0" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      
      <style>{`
        .custom-scrollbar::-webkit-scrollbar { width: 5px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: #020617; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 4px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #334155; }
      `}</style>
    </div>
  );
}
