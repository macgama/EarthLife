import React from "react";
import { useState, useEffect } from 'react';
import { signInWithPopup, GoogleAuthProvider, onAuthStateChanged, User } from 'firebase/auth';
import { auth } from '../lib/firebase';
import { Loader2 } from 'lucide-react';

export function Auth({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = async () => {
    if (isLoggingIn) return;
    setIsLoggingIn(true);
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error("Login failed", error);
    } finally {
      setIsLoggingIn(false);
    }
  };

  if (loading) {
    return (
      <div className="h-screen w-full bg-[#020617] flex flex-col items-center justify-center">
        <Loader2 className="w-10 h-10 text-cyan-400 animate-spin mb-4" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="h-screen w-full bg-[#0b0f1a] flex flex-col items-center justify-center text-slate-200 font-sans">
        <div className="absolute inset-0 z-0 bg-[url('https://cartodb-basemaps-a.global.ssl.fastly.net/dark_all/14/8500/5800.png')] bg-cover bg-center opacity-20"></div>
        <div className="absolute inset-0 pointer-events-none shadow-[inset_0_0_150px_rgba(0,0,0,0.8)] z-0"></div>
        
        <div className="z-10 bg-[#020617]/80 p-10 rounded-2xl border border-slate-800 backdrop-blur-md max-w-md w-full mx-4 text-center shadow-2xl">
          <div className="flex items-center justify-center gap-2 mb-6">
            <div className="w-4 h-4 rounded-full bg-cyan-400 animate-pulse shadow-[0_0_8px_#22d3ee]"></div>
            <span className="text-sm font-bold uppercase tracking-[0.2em] text-cyan-400">Earth Survival</span>
          </div>
          
          <h1 className="text-3xl font-light tracking-tight text-white mb-2">Bienvenue</h1>
          <p className="text-slate-400 text-sm mb-8">Connectez-vous pour accéder au moteur vectoriel mondial et générer des villes.</p>
          
          <button 
            onClick={handleLogin}
            disabled={isLoggingIn}
            className="w-full bg-white text-black font-semibold py-3 px-4 rounded hover:bg-slate-200 transition-colors flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoggingIn ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="currentColor" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
              </svg>
            )}
            {isLoggingIn ? "Connexion en cours..." : "Se connecter avec Google"}
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
