import React, { useState, useEffect } from 'react';
import { Save, CheckCircle2 } from 'lucide-react';
import { getGameRules, saveGameRules, GameRulesConfig, subscribeToGameRules } from '../../lib/gameRules';

export const GameRulesEditor: React.FC = () => {
  const [rules, setRules] = useState<GameRulesConfig | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    const unsub = subscribeToGameRules((data) => {
      setRules(data);
    });
    return () => unsub();
  }, []);

  if (!rules) return <div className="text-slate-400 p-4">Chargement des règles...</div>;

  const handleChange = (key: keyof GameRulesConfig, value: string) => {
    setRules(prev => prev ? { ...prev, [key]: Number(value) } : null);
  };

  const handleSave = async () => {
    if (!rules) return;
    setIsSaving(true);
    await saveGameRules(rules);
    setIsSaving(false);
    setSaveSuccess(true);
    setTimeout(() => setSaveSuccess(false), 2000);
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h3 className="font-bold text-white text-lg flex items-center gap-2">⚙️ Règles du Jeu (Globales)</h3>
          <span className="text-xs text-slate-400">Ces règles s'appliquent à tous les joueurs et toutes les sessions en temps réel.</span>
        </div>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center gap-2 bg-rose-600 hover:bg-rose-500 text-white px-4 py-2 rounded-xl font-bold transition-all disabled:opacity-50"
        >
          {saveSuccess ? <CheckCircle2 className="w-4 h-4" /> : <Save className="w-4 h-4" />}
          {isSaving ? 'Enregistrement...' : saveSuccess ? 'Enregistré !' : 'Enregistrer'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Temps et Horloge */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 space-y-4">
          <h4 className="font-bold text-sm text-cyan-400 border-b border-slate-800 pb-2">Temps & Horloge</h4>
          <div>
            <label className="block text-xs font-bold text-slate-400 mb-1">1 minute en jeu = X secondes réelles</label>
            <input
              type="number"
              value={rules.realSecondsPerGameMinute}
              onChange={(e) => handleChange('realSecondsPerGameMinute', e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm"
              min="1"
            />
            <p className="text-[10px] text-slate-500 mt-1">Ex: 10 sec réelles = 1 minute de jeu.</p>
          </div>
        </div>

        {/* Coûts des actions (Temps) */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 space-y-4">
          <h4 className="font-bold text-sm text-amber-400 border-b border-slate-800 pb-2">Durée des Actions (Minutes de jeu)</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1">Fouille</label>
              <input type="number" value={rules.scavengeTimeMinutes} onChange={(e) => handleChange('scavengeTimeMinutes', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1">Fortification</label>
              <input type="number" value={rules.fortificationTimeMinutes} onChange={(e) => handleChange('fortificationTimeMinutes', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1">Manger</label>
              <input type="number" value={rules.eatTimeMinutes} onChange={(e) => handleChange('eatTimeMinutes', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1">Boire</label>
              <input type="number" value={rules.drinkTimeMinutes} onChange={(e) => handleChange('drinkTimeMinutes', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1">Soins médicaux</label>
              <input type="number" value={rules.healTimeMinutes} onChange={(e) => handleChange('healTimeMinutes', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1">Infiltration furtive</label>
              <input type="number" value={rules.stealthTimeMinutes} onChange={(e) => handleChange('stealthTimeMinutes', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1">Nettoyage (Combat)</label>
              <input type="number" value={rules.combatTimeMinutes} onChange={(e) => handleChange('combatTimeMinutes', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1">Fuite de combat</label>
              <input type="number" value={rules.fleeTimeMinutes} onChange={(e) => handleChange('fleeTimeMinutes', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm" />
            </div>
          </div>
        </div>

        {/* Map & Vision */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 space-y-4">
          <h4 className="font-bold text-sm text-emerald-400 border-b border-slate-800 pb-2">Carte & Vision</h4>
          <div>
            <label className="block text-xs font-bold text-slate-400 mb-1">Rayon de vision (mètres)</label>
            <input
              type="number"
              value={rules.visionRadiusMeters}
              onChange={(e) => handleChange('visionRadiusMeters', e.target.value)}
              className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm"
            />
            <p className="text-[10px] text-slate-500 mt-1">Distance de dissipation du brouillard de guerre autour des survivants et bâtiments occupés.</p>
          </div>
        </div>
        
        {/* Déplacements */}
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-4 space-y-4">
          <h4 className="font-bold text-sm text-blue-400 border-b border-slate-800 pb-2">Déplacements</h4>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1">Vitesse Marche (km/h)</label>
              <input type="number" value={rules.walkingSpeedKmH} onChange={(e) => handleChange('walkingSpeedKmH', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1">Vitesse Voiture (km/h)</label>
              <input type="number" value={rules.drivingSpeedKmH} onChange={(e) => handleChange('drivingSpeedKmH', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm" />
            </div>
            <div>
              <label className="block text-xs font-bold text-slate-400 mb-1">Conso Carburant (L/km)</label>
              <input type="number" step="0.1" value={rules.fuelConsumptionPerKm} onChange={(e) => handleChange('fuelConsumptionPerKm', e.target.value)} className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-white font-mono text-sm" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
