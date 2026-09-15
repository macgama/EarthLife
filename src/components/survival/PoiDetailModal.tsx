import React, { useState } from 'react';
import { 
  X, MapPin, Package, Plus, Car, Fuel, Wrench, ShieldAlert, Users, ArrowRight
} from 'lucide-react';
import { BuildingDetails, BuildingLootItem } from '../../lib/buildingDetails';
import { SurvivorCharacter } from './GameSetupWizard';
import { getCharacterColor } from '../../lib/character';

interface PoiDetailModalProps {
  poi: BuildingDetails;
  activeSquadCharacters: SurvivorCharacter[];
  savedPoiState?: any;
  onSavePoiState?: (bldgId: string, state: any) => Promise<void> | void;
  onClose: () => void;
  onScavengeItem?: (item: BuildingLootItem, charId: string) => void;
  onSaveCharacter?: (updatedChar: SurvivorCharacter) => void;
}

export const PoiDetailModal: React.FC<PoiDetailModalProps> = ({
  poi,
  activeSquadCharacters,
  savedPoiState,
  onSavePoiState,
  onClose,
  onScavengeItem,
  onSaveCharacter
}) => {
  const [poiItems, setPoiItems] = useState<BuildingLootItem[]>(() => savedPoiState?.buildingItems ?? poi.lootItems ?? []);
  
  const [scoutingSquadIds, setScoutingSquadIds] = useState<string[]>([]);
  const [isScouting, setIsScouting] = useState(false);
  
  const [selectedCharId, setSelectedCharId] = useState<string>('');
  const selectedChar = activeSquadCharacters.find(c => c.id === selectedCharId);

  // Transfer item from POI to character inventory
  const handleTransferToChar = (item: BuildingLootItem) => {
    if (!selectedChar) return;
    
    const charMaxWeight = 10 + Math.floor((selectedChar.skills?.combat || selectedChar.combat || 50) / 10);
    const charUsedWeight = parseFloat((selectedChar.inventory || []).reduce((acc, i) => acc + (i.weight || 1), 0).toFixed(1));
    
    if (charUsedWeight + (item.weight || 1) > charMaxWeight) {
      alert(`Le sac de ${selectedChar.name} est trop lourd (${charUsedWeight}/${charMaxWeight} kg) !`);
      return;
    }

    // Optimistically update character's local inventory array so UI updates immediately
    if (!selectedChar.inventory) selectedChar.inventory = [];
    selectedChar.inventory.push(item);

    if (onScavengeItem) {
      onScavengeItem(item, selectedChar.id);
    }
    
    // Remove from local POI items
    const newItems = poiItems.filter(i => i.id !== item.id);
    setPoiItems(newItems);
    
    if (onSavePoiState) {
      onSavePoiState(poi.id, {
        ...(savedPoiState || {}),
        buildingItems: newItems
      });
    }
  };

  const handleConfirmScouting = () => {
    if (scoutingSquadIds.length === 0) return;
    setIsScouting(true);
    if (!selectedCharId || !scoutingSquadIds.includes(selectedCharId)) {
      setSelectedCharId(scoutingSquadIds[0]);
    }
    if (onSaveCharacter) {
      activeSquadCharacters.forEach(c => {
        if (scoutingSquadIds.includes(c.id)) {
          onSaveCharacter({
            ...c,
            locationType: 'street',
            buildingName: poi.name,
            lat: poi.lat,
            lon: poi.lon
          });
        }
      });
    }
  };

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-2 sm:p-4 bg-slate-950/80 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-full">
        {/* Header */}
        <div className="relative p-4 pb-4 border-b border-slate-800 shrink-0">
          <div className="flex justify-between items-start gap-4">
            <div>
              <div className="flex items-center gap-2 text-cyan-400 mb-1">
                <MapPin className="w-4 h-4" />
                <span className="text-[10px] font-bold uppercase tracking-widest">Point d'Intérêt</span>
              </div>
              <h2 className="text-xl font-black text-white">{poi.name}</h2>
              <p className="text-sm text-slate-400 font-medium capitalize mt-1">{poi.categoryLabel || poi.buildingType}</p>
            </div>
            <button 
              onClick={onClose}
              className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white rounded-full transition-colors shrink-0"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Content */}
        {!isScouting ? (
          <div className="p-4 space-y-4">
            <div className="bg-slate-800/50 rounded-xl p-4 border border-slate-700">
              <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                <Users className="w-4 h-4 text-cyan-400" />
                Envoyer une équipe fouiller
              </h3>
              <p className="text-xs text-slate-400 mb-4">
                Sélectionnez les survivants qui vont explorer ce lieu. Ils pourront récupérer des objets dans la limite de leur capacité de portage.
              </p>
              
              <div className="space-y-2 max-h-60 overflow-y-auto pr-2">
                {activeSquadCharacters.map((char, index) => {
                  const isSelected = scoutingSquadIds.includes(char.id);
                  const charMaxWeight = 10 + Math.floor((char.skills?.combat || char.combat || 50) / 10);
                  const charUsedWeight = parseFloat((char.inventory || []).reduce((acc, i) => acc + (i.weight || 1), 0).toFixed(1));
                  const color = getCharacterColor(index);
                  
                  return (
                    <button
                      key={char.id}
                      onClick={() => setScoutingSquadIds(prev => prev.includes(char.id) ? prev.filter(id => id !== char.id) : [...prev, char.id])}
                      className={`w-full flex items-center justify-between p-3 rounded-xl border transition-all ${
                        isSelected ? 'bg-cyan-950/40 border-cyan-500/50' : 'bg-slate-900 border-slate-700 hover:border-slate-500'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <span 
                          style={{ backgroundColor: color.hex }}
                          className="w-5 h-5 rounded-full border border-white flex items-center justify-center text-[10px] font-extrabold text-white shadow shrink-0"
                        >
                          {index + 1}
                        </span>
                        <span className={`text-sm font-bold ${isSelected ? 'text-cyan-300' : 'text-slate-300'}`}>{char.name}</span>
                      </div>
                      <div className="text-xs text-slate-400 font-mono">
                        {charUsedWeight} / {charMaxWeight} kg
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
            
            <button
              onClick={handleConfirmScouting}
              disabled={scoutingSquadIds.length === 0}
              className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              Confirmer l'équipe <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <div className="p-4 overflow-y-auto space-y-6">
            <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-800">
              <h3 className="text-sm font-bold text-white mb-2 flex items-center gap-2">
                <Package className="w-4 h-4 text-emerald-400" />
                Objets trouvables
              </h3>
              <p className="text-xs text-slate-400 mb-4">
                Ce lieu ne peut pas servir de QG et ne contient pas de survivants, mais vous pouvez y trouver des objets utiles.
              </p>

              {poiItems.length === 0 ? (
                <div className="text-center p-4 bg-slate-900/50 rounded-xl border border-slate-800 text-slate-500 text-xs italic">
                  Il n'y a plus rien d'intéressant ici.
                </div>
              ) : (
                <div className="space-y-2">
                  {poiItems.map(item => (
                    <div key={item.id} className="flex items-center justify-between p-2.5 bg-slate-900/60 rounded-xl border border-slate-800 hover:border-slate-700 transition-colors">
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <div className="w-8 h-8 bg-slate-800 rounded-lg flex items-center justify-center text-lg border border-slate-700 shadow-inner">
                            {item.icon}
                          </div>
                          {item.quantity > 1 && (
                            <div className="absolute -bottom-1 -right-1 bg-slate-700 text-[9px] font-bold px-1 rounded border border-slate-600">
                              x{item.quantity}
                            </div>
                          )}
                        </div>
                        <div>
                          <div className="text-xs font-bold text-white group-hover:text-cyan-400 transition-colors">
                            {item.name}
                          </div>
                          <div className="text-[9px] text-slate-400 mt-0.5">
                            {(item.weight || 1).toFixed(1)} kg • {item.description}
                          </div>
                        </div>
                      </div>
                      
                      <button
                        onClick={() => handleTransferToChar(item)}
                        disabled={
                          !selectedChar || 
                          (selectedChar && parseFloat((selectedChar.inventory || []).reduce((acc, i) => acc + (i.weight || 1), 0).toFixed(1)) + (item.weight || 1) > (10 + Math.floor((selectedChar.skills?.combat || selectedChar.combat || 50) / 10)))
                        }
                        className="px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1 transition-all shrink-0 bg-emerald-600 hover:bg-emerald-500 text-white shadow-md disabled:bg-slate-800 disabled:text-slate-500 disabled:opacity-50"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Prendre
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {poi.vehicles && poi.vehicles.length > 0 && (
              <div className="bg-slate-800/30 rounded-xl p-4 border border-slate-800">
                <h3 className="text-sm font-bold text-white mb-3 flex items-center gap-2">
                  <Car className="w-4 h-4 text-cyan-400" />
                  Véhicules sur place
                </h3>
                <div className="space-y-3">
                  {poi.vehicles.map(veh => (
                    <div key={veh.id} className="p-3 bg-slate-900/60 rounded-xl border border-slate-800">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-2">
                          <span className="text-xl">{veh.icon}</span>
                          <div className="font-bold text-sm text-white">{veh.name}</div>
                        </div>
                        <div className="text-xs font-mono px-2 py-1 bg-slate-800 rounded text-slate-300">
                          État : {veh.condition}%
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <div className="flex-1 bg-slate-800/50 p-2 rounded-lg text-[10px] text-slate-400 flex flex-col items-center">
                          <Fuel className="w-3 h-3 mb-1 text-amber-400" />
                          {(veh.currentFuelLiters || 0).toFixed(1)} / {veh.tankCapacityLiters}L
                        </div>
                        <div className="flex-1 bg-slate-800/50 p-2 rounded-lg text-[10px] text-slate-400 flex flex-col items-center">
                          <Package className="w-3 h-3 mb-1 text-emerald-400" />
                          {veh.storageCapacityKg}kg max
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer selector for character */}
        {isScouting && (
          <div className="p-3 bg-slate-900 border-t border-slate-800 flex items-center justify-between gap-3">
            <div className="text-xs text-slate-400">Transférer vers :</div>
            <select 
              value={selectedCharId}
              onChange={(e) => setSelectedCharId(e.target.value)}
              className="flex-1 bg-slate-800 border-none rounded-xl text-xs text-white p-2 outline-none cursor-pointer"
            >
              {activeSquadCharacters
                .filter(c => scoutingSquadIds.includes(c.id))
                .map(c => {
                  const charMaxWeight = 10 + Math.floor((c.skills?.combat || c.combat || 50) / 10);
                  const charUsedWeight = parseFloat((c.inventory || []).reduce((acc, i) => acc + (i.weight || 1), 0).toFixed(1));
                  return (
                    <option key={c.id} value={c.id}>
                      {c.name} ({charUsedWeight} / {charMaxWeight} kg)
                    </option>
                  );
                })}
            </select>
          </div>
        )}
      </div>
    </div>
  );
};
