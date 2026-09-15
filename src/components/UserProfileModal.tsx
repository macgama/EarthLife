import React, { useState, useEffect } from 'react';
import { User, Shield, Award, Edit3, Check, X, Calendar, Sparkles, Biohazard } from 'lucide-react';
import { updateUserProfile } from '../lib/api';

interface UserProfileModalProps {
  userProfile: any;
  currentUser: any;
  onClose: () => void;
}

export function UserProfileModal({ userProfile, currentUser, onClose }: UserProfileModalProps) {
  const [displayName, setDisplayName] = useState(userProfile?.displayName || currentUser?.email?.split('@')[0] || 'Survivant');
  const [title, setTitle] = useState(userProfile?.title || 'Commandant de la Résistance');
  const [bio, setBio] = useState(userProfile?.bio || 'En quête de survie dans ce monde apocalyptique.');
  const [photoURL, setPhotoURL] = useState(userProfile?.photoURL || `https://api.dicebear.com/7.x/bottts/svg?seed=${currentUser?.uid}`);
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    if (userProfile) {
      if (userProfile.displayName) setDisplayName(userProfile.displayName);
      if (userProfile.title) setTitle(userProfile.title);
      if (userProfile.bio) setBio(userProfile.bio);
      if (userProfile.photoURL) setPhotoURL(userProfile.photoURL);
    }
  }, [userProfile]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) return;
    setIsSaving(true);
    try {
      await updateUserProfile(currentUser.uid, {
        displayName: displayName.trim(),
        title: title.trim(),
        bio: bio.trim(),
        photoURL: photoURL.trim()
      });
      setSavedSuccess(true);
      setTimeout(() => setSavedSuccess(false), 2000);
    } catch (err) {
      console.error('Failed to update profile:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const joinedDate = userProfile?.createdAt 
    ? new Date(userProfile.createdAt).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' })
    : 'Récemment';

  return (
    <div className="fixed inset-0 z-[5000] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#0f172a] border border-slate-800 rounded-3xl max-w-lg w-full overflow-hidden shadow-2xl relative">
        {/* Header background banner */}
        <div className="h-24 bg-gradient-to-r from-rose-950 via-cyan-950 to-slate-900 relative p-4 flex items-start justify-between">
          <div className="flex items-center gap-2 text-xs font-mono text-cyan-300 uppercase tracking-widest font-bold">
            <Biohazard className="w-4 h-4 text-rose-400" /> Profil Joueur Enregistré (DB)
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-slate-900/60 text-slate-400 hover:text-white border border-slate-700/50 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Avatar badge */}
        <div className="px-6 relative -mt-10 mb-4 flex items-end justify-between">
          <div className="relative">
            <img
              src={photoURL}
              alt="Avatar"
              className="w-20 h-20 rounded-2xl bg-slate-900 border-2 border-cyan-500 shadow-xl object-cover"
            />
            <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-emerald-500 border-2 border-slate-900 shadow-md"></div>
          </div>

          <div className="text-right">
            <div className="text-[10px] font-mono text-slate-400 uppercase tracking-wider">Membre de la résistance</div>
            <div className="text-xs font-semibold text-emerald-400 flex items-center justify-end gap-1">
              <Calendar className="w-3.5 h-3.5" /> Inscrit en {joinedDate}
            </div>
          </div>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSave} className="p-6 pt-2 space-y-4">
          <div className="space-y-3">
            <div>
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300 block mb-1">
                Pseudo / Nom d'Affichage :
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                required
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white font-semibold text-sm focus:outline-none focus:border-cyan-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300 block mb-1">
                Titre dans le Jeu :
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ex: Commandant de la Résistance, Chef de Clan..."
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-cyan-300 font-mono text-xs focus:outline-none focus:border-cyan-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300 block mb-1">
                Bio / Citation du Survivant :
              </label>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={2}
                placeholder="Racontez l'histoire de votre escouade..."
                className="w-full px-3.5 py-2 bg-slate-950 border border-slate-800 rounded-xl text-slate-300 text-xs focus:outline-none focus:border-cyan-500 transition-colors resize-none"
              />
            </div>

            <div>
              <label className="text-[11px] font-bold uppercase tracking-wider text-slate-300 block mb-1">
                Email du Compte Google (Inchangé) :
              </label>
              <div className="px-3 py-2 bg-slate-900/60 border border-slate-800/80 rounded-xl text-xs font-mono text-slate-400">
                {currentUser?.email}
              </div>
            </div>
          </div>

          {/* Stats Summary */}
          <div className="bg-slate-900/80 border border-slate-800 rounded-2xl p-3 grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-[10px] text-slate-400 uppercase font-mono">Statut DB</div>
              <div className="text-xs font-bold text-emerald-400">Synchronisé</div>
            </div>
            <div>
              <div className="text-[10px] text-slate-400 uppercase font-mono">Rôle</div>
              <div className="text-xs font-bold text-cyan-400">Joueur</div>
            </div>
            <div>
              <div className="text-[10px] text-slate-400 uppercase font-mono">ID Compte</div>
              <div className="text-[10px] font-mono text-slate-300 truncate max-w-[90px] mx-auto">{currentUser?.uid}</div>
            </div>
          </div>

          {/* Submit */}
          <div className="pt-2 flex items-center justify-between">
            {savedSuccess ? (
              <div className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                <Check className="w-4 h-4" /> Profil sauvegardé dans la base de données !
              </div>
            ) : (
              <span className="text-[11px] text-slate-500 italic">Enregistrement instantané dans Firestore</span>
            )}

            <button
              type="submit"
              disabled={isSaving}
              className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white font-bold text-xs rounded-xl flex items-center gap-2 transition-all cursor-pointer shadow-lg shadow-cyan-950/50"
            >
              {isSaving ? 'Sauvegarde...' : 'Mettre à jour mon profil'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
