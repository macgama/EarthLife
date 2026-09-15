import React, { useState } from 'react';
import { 
  X, Hammer, Sparkles, Check, AlertTriangle, Wrench, Package, 
  ShieldAlert, ArrowRight, Search, Info, Plus
} from 'lucide-react';
import { CraftRecipe, DEFAULT_CRAFT_RECIPES, canCraftRecipe, executeCraft } from '../../lib/crafting';
import { SurvivorCharacter } from './GameSetupWizard';

interface CraftingModalProps {
  activeSquadCharacters: SurvivorCharacter[];
  charInventories: Record<string, any[]>;
  buildingItems?: any[];
  onUpdateInventories: (updatedCharInventories: Record<string, any[]>, updatedBuildingItems?: any[]) => void;
  onClose: () => void;
}

export const CraftingModal: React.FC<CraftingModalProps> = ({
  activeSquadCharacters,
  charInventories,
  buildingItems = [],
  onUpdateInventories,
  onClose
}) => {
  const [selectedCharId, setSelectedCharId] = useState<string>(activeSquadCharacters[0]?.id || '');
  const [sourceMode, setSourceMode] = useState<'character' | 'combined'>('combined');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [recipes, setRecipes] = useState<CraftRecipe[]>(DEFAULT_CRAFT_RECIPES);
  const [feedbackMessage, setFeedbackMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  const selectedChar = activeSquadCharacters.find(c => c.id === selectedCharId) || activeSquadCharacters[0];
  const charSkillLevel = selectedChar?.skills?.bricolage ?? selectedChar?.crafting ?? 50;

  // Gather available items depending on source mode
  const getAvailableItemsPool = () => {
    if (sourceMode === 'character') {
      return charInventories[selectedCharId] || [];
    } else {
      // Combined pool: character inventory + squad inventories + building items
      const combined: any[] = [];
      Object.values(charInventories).forEach((inv: any) => {
        if (Array.isArray(inv)) {
          combined.push(...inv);
        }
      });
      combined.push(...buildingItems);
      return combined;
    };
  };

  const availablePool = getAvailableItemsPool();

  // Filter recipes
  const filteredRecipes = recipes.filter(r => {
    const matchesCat = selectedCategory === 'all' || r.category === selectedCategory;
    const matchesSearch = r.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          r.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          r.ingredients.some(i => i.itemName.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesCat && matchesSearch;
  });

  // Handle crafting an item
  const handleCraft = (recipe: CraftRecipe) => {
    if (!selectedChar) return;

    if (sourceMode === 'character') {
      const currentInv = charInventories[selectedCharId] || [];
      const result = executeCraft(recipe, currentInv, charSkillLevel);

      if (result.success) {
        const newCharInventories = {
          ...charInventories,
          [selectedCharId]: result.updatedInventory
        };
        onUpdateInventories(newCharInventories, buildingItems);
        setFeedbackMessage({ text: result.message || 'Objet fabriqué avec succès !', type: 'success' });
      } else {
        setFeedbackMessage({ text: result.message || 'Impossible de fabriquer cet objet.', type: 'error' });
      }
    } else {
      // Combined mode: consume ingredients priority order (character -> building)
      const currentInv = charInventories[selectedCharId] || [];
      // Combine pool to verify
      const combinedPool = getAvailableItemsPool();
      const check = canCraftRecipe(recipe, combinedPool, charSkillLevel);

      if (!check.canCraft) {
        setFeedbackMessage({ text: check.missingReason || 'Ingrédients insuffisants.', type: 'error' });
        return;
      }

      // Execute craft using combined pool
      let updatedCharInventories = { ...charInventories };
      let updatedBuildingItems = [...buildingItems];

      for (const ing of recipe.ingredients) {
        let needed = ing.quantity;

        // First consume from selected character's inventory
        if (updatedCharInventories[selectedCharId]) {
          let charInv = [...updatedCharInventories[selectedCharId]];
          for (let i = 0; i < charInv.length && needed > 0; i++) {
            const item = charInv[i];
            const nameMatch = item.name.toLowerCase().includes(ing.itemName.toLowerCase().slice(0, 4));
            if (item.id === ing.itemId || nameMatch) {
              const qty = item.quantity || 1;
              if (qty <= needed) {
                needed -= qty;
                charInv.splice(i, 1);
                i--;
              } else {
                charInv[i] = { ...item, quantity: qty - needed };
                needed = 0;
              }
            }
          }
          updatedCharInventories[selectedCharId] = charInv;
        }

        // Next consume from other characters if needed
        if (needed > 0) {
          for (const cId of Object.keys(updatedCharInventories)) {
            if (cId === selectedCharId) continue;
            let charInv = [...updatedCharInventories[cId]];
            for (let i = 0; i < charInv.length && needed > 0; i++) {
              const item = charInv[i];
              const nameMatch = item.name.toLowerCase().includes(ing.itemName.toLowerCase().slice(0, 4));
              if (item.id === ing.itemId || nameMatch) {
                const qty = item.quantity || 1;
                if (qty <= needed) {
                  needed -= qty;
                  charInv.splice(i, 1);
                  i--;
                } else {
                  charInv[i] = { ...item, quantity: qty - needed };
                  needed = 0;
                }
              }
            }
            updatedCharInventories[cId] = charInv;
            if (needed <= 0) break;
          }
        }

        // Next consume from building storage if needed
        if (needed > 0) {
          for (let i = 0; i < updatedBuildingItems.length && needed > 0; i++) {
            const item = updatedBuildingItems[i];
            const nameMatch = item.name.toLowerCase().includes(ing.itemName.toLowerCase().slice(0, 4));
            if (item.id === ing.itemId || nameMatch) {
              const qty = item.quantity || 1;
              if (qty <= needed) {
                needed -= qty;
                updatedBuildingItems.splice(i, 1);
                i--;
              } else {
                updatedBuildingItems[i] = { ...item, quantity: qty - needed };
                needed = 0;
              }
            }
          }
        }
      }

      // Add crafted item to selected character's inventory
      const craftedItem = {
        ...recipe.resultItem,
        id: `crafted_${recipe.resultItem.id}_${Date.now()}`,
        quantity: recipe.resultQuantity
      };

      updatedCharInventories[selectedCharId] = [
        ...(updatedCharInventories[selectedCharId] || []),
        craftedItem
      ];

      const noiseLevel = recipe.noiseDb ?? 45;
      onUpdateInventories(updatedCharInventories, updatedBuildingItems);
      setFeedbackMessage({ text: `Fabriqué : +${recipe.resultQuantity} ${recipe.resultItem.name} par ${selectedChar.name} ! (🔊 Bruit émis : ${noiseLevel} dB dans le bâtiment)`, type: 'success' });
    }

    // Auto-clear message after 4s
    setTimeout(() => {
      setFeedbackMessage(null);
    }, 4000);
  };

  return (
    <div className="fixed inset-0 z-[3200] bg-slate-950/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 overflow-y-auto">
      <div className="bg-[#090d16] border border-amber-500/50 rounded-3xl max-w-3xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="p-5 border-b border-slate-800 bg-slate-900/80 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-2xl text-amber-400">
              <Hammer className="w-6 h-6 animate-pulse" />
            </div>
            <div>
              <h2 className="text-lg font-black text-white flex items-center gap-2">
                Atelier de Fabrication & Craft
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Combinez vos ressources simples pour créer armes, outils et équipements de survie.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Character & Pool Configuration Bar */}
        <div className="p-4 bg-slate-950/80 border-b border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-4 items-center">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
              Artisan en charge :
            </label>
            <div className="flex gap-2">
              <select
                value={selectedCharId}
                onChange={e => setSelectedCharId(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-xs font-bold text-white focus:border-amber-500 outline-none"
              >
                {activeSquadCharacters.map(char => (
                  <option key={char.id} value={char.id}>
                    {char.name} ({char.role}) - Bricolage : {char.skills?.bricolage ?? char.crafting ?? 50} pts
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-1">
              Origine des Matériaux :
            </label>
            <div className="flex bg-slate-900 p-1 rounded-xl border border-slate-800">
              <button
                onClick={() => setSourceMode('combined')}
                className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  sourceMode === 'combined'
                    ? 'bg-amber-500 text-slate-950 shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Équipe & Stock QG
              </button>
              <button
                onClick={() => setSourceMode('character')}
                className={`flex-1 py-1.5 px-2 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                  sourceMode === 'character'
                    ? 'bg-amber-500 text-slate-950 shadow-md'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Sac Perso Uniquement
              </button>
            </div>
          </div>
        </div>

        {/* Feedback Alert */}
        {feedbackMessage && (
          <div className={`px-5 py-2.5 text-xs font-bold text-center flex items-center justify-center gap-2 ${
            feedbackMessage.type === 'success' ? 'bg-emerald-500/20 text-emerald-300 border-b border-emerald-500/40' : 'bg-rose-500/20 text-rose-300 border-b border-rose-500/40'
          }`}>
            <Sparkles className="w-4 h-4" />
            <span>{feedbackMessage.text}</span>
          </div>
        )}

        {/* Content Area */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1 custom-scrollbar">
          
          {/* Search & Category Filter */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
              <input
                type="text"
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Rechercher une recette ou ingrédient (ex: couteau, bois, métal...)"
                className="w-full bg-slate-900 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 focus:border-amber-500 outline-none"
              />
            </div>

            <select
              value={selectedCategory}
              onChange={e => setSelectedCategory(e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:border-amber-500 outline-none"
            >
              <option value="all">Toutes recettes</option>
              <option value="weapon">Armes</option>
              <option value="tool">Outils</option>
              <option value="medical">Médical</option>
              <option value="tech">Technologie</option>
              <option value="food">Nourriture</option>
              <option value="clothing">Équipements</option>
            </select>
          </div>

          {/* Recipes List */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredRecipes.map(recipe => {
              const check = canCraftRecipe(recipe, availablePool, charSkillLevel);

              return (
                <div 
                  key={recipe.id}
                  className="bg-slate-900/70 border border-slate-800 hover:border-slate-700 rounded-2xl p-4 flex flex-col justify-between space-y-3 transition-all"
                >
                  <div>
                    {/* Title & Icon */}
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2.5">
                        <div className="w-10 h-10 rounded-xl bg-slate-950 border border-amber-500/30 flex items-center justify-center text-xl shrink-0">
                          {recipe.icon}
                        </div>
                        <div>
                          <h3 className="text-xs font-bold text-white leading-tight">{recipe.name}</h3>
                          <span className="text-[10px] text-amber-400 font-mono capitalize">
                            Catégorie: {recipe.category}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1">
                        {recipe.requiredSkill && (
                          <span className={`text-[9px] px-2 py-0.5 rounded-full font-mono border font-bold ${
                            charSkillLevel >= recipe.requiredSkill.minLevel
                              ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                              : 'bg-rose-950 text-rose-400 border-rose-800'
                          }`}>
                            Bricolage : {recipe.requiredSkill.minLevel}+
                          </span>
                        )}
                        <span className={`text-[9px] px-2 py-0.5 rounded-full font-mono border font-bold flex items-center gap-1 ${
                          (recipe.noiseDb || 40) <= 30
                            ? 'bg-emerald-950/80 text-emerald-300 border-emerald-800'
                            : (recipe.noiseDb || 40) <= 60
                            ? 'bg-amber-950/80 text-amber-300 border-amber-800'
                            : 'bg-rose-950/80 text-rose-300 border-rose-800'
                        }`}>
                          🔊 {recipe.noiseDb || 40} dB
                        </span>
                      </div>
                    </div>

                    <p className="text-[11px] text-slate-400 mt-2 line-clamp-2 leading-relaxed">
                      {recipe.description}
                    </p>

                    {/* Ingredients Required */}
                    <div className="mt-3 bg-slate-950/80 p-2.5 rounded-xl border border-slate-800/80 space-y-1.5">
                      <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">
                        Ingrédients Requis :
                      </span>
                      <div className="flex flex-wrap gap-1.5">
                        {recipe.ingredients.map((ing, idx) => {
                          // Check how many available in pool
                          let count = 0;
                          for (const item of availablePool) {
                            const ingName = ing.itemName.toLowerCase().trim();
                            const itemName = item.name.toLowerCase().trim();
                            const matchesKw = ingName.includes('bois') && itemName.includes('bois') ||
                                              ingName.includes('métal') && itemName.includes('métal') ||
                                              ingName.includes('pierre') && itemName.includes('pierre') ||
                                              ingName.includes('tissu') && itemName.includes('tissu') ||
                                              ingName.includes('fil') && itemName.includes('fil') ||
                                              ingName.includes('chimique') && itemName.includes('chimique') ||
                                              ingName.includes('plastique') && itemName.includes('plastique') ||
                                              ingName.includes('électronique') && itemName.includes('électronique');

                            if (item.id === ing.itemId || itemName === ingName || matchesKw) {
                              count += item.quantity || 1;
                            }
                          }
                          const hasEnough = count >= ing.quantity;

                          return (
                            <span 
                              key={idx}
                              className={`text-[10px] px-2 py-1 rounded-lg border font-mono flex items-center gap-1 ${
                                hasEnough 
                                  ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800/60'
                                  : 'bg-rose-950/60 text-rose-300 border-rose-800/60'
                              }`}
                            >
                              <span>{ing.icon || '📦'}</span>
                              <span>{ing.quantity}x {ing.itemName}</span>
                              <span className="opacity-70">({count}/{ing.quantity})</span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Craft Action Button */}
                  <button
                    onClick={() => handleCraft(recipe)}
                    disabled={!check.canCraft}
                    className={`w-full py-2.5 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all cursor-pointer shadow-md ${
                      check.canCraft
                        ? 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-amber-950/50'
                        : 'bg-slate-800 text-slate-500 border border-slate-700/50 cursor-not-allowed'
                    }`}
                  >
                    <Hammer className="w-4 h-4" />
                    <span>
                      {check.canCraft ? `FABRIQUER (+${recipe.resultQuantity})` : check.missingReason || 'Composants manquants'}
                    </span>
                  </button>
                </div>
              );
            })}

            {filteredRecipes.length === 0 && (
              <div className="col-span-full text-center py-12 text-slate-500 text-xs">
                Aucune recette de fabrication ne correspond à votre recherche.
              </div>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-900/80 border-t border-slate-800 flex justify-between items-center">
          <div className="text-[11px] text-slate-400 font-mono">
            Matériaux disponibles dans le groupe : <span className="text-amber-400 font-bold">{availablePool.length} objet(s)</span>
          </div>

          <button
            onClick={onClose}
            className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-xl transition-all cursor-pointer"
          >
            Fermer l'Atelier
          </button>
        </div>

      </div>
    </div>
  );
};
