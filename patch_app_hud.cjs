const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

code = code.replace(
  `import { Trophy, MapPin, Users, Crosshair, HeartPulse, Hammer, Box, Shield, ScrollText, ArrowRight, Play, CheckCircle2, ChevronRight, Zap, Droplets, Target, User, RefreshCw, X, LogOut, Sun, Moon, Flame, Wind, Droplet, Plus, Building2, Home } from 'lucide-react';`,
  `import { Trophy, Medal, MapPin, Users, Crosshair, HeartPulse, Hammer, Box, Shield, ScrollText, ArrowRight, Play, CheckCircle2, ChevronRight, Zap, Droplets, Target, User, RefreshCw, X, LogOut, Sun, Moon, Flame, Wind, Droplet, Plus, Building2, Home } from 'lucide-react';`
);

code = code.replace(
  `            <button
              onClick={() => setShowMissionsModal(true)}
              className="px-3 py-1.5 bg-gradient-to-r from-amber-950/80 to-indigo-950/80 border border-amber-500/50 hover:border-amber-400 text-amber-300 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shrink-0 shadow-sm"
              title="Ouvrir les Missions et la Progression du Commandant"
            >
              <Trophy className="w-3.5 h-3.5 text-amber-400" />
              <span>Niv. {progression.level} ({progression.xp} XP)</span>
            </button>`,
  `            <button
              onClick={() => setShowMissionsModal(true)}
              className="px-3 py-1.5 bg-gradient-to-r from-amber-950/80 to-indigo-950/80 border border-amber-500/50 hover:border-amber-400 text-amber-300 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shrink-0 shadow-sm"
              title="Ouvrir les Missions et la Progression du Commandant"
            >
              <Trophy className="w-3.5 h-3.5 text-amber-400" />
              <span>Général Niv. {progression.level}</span>
            </button>
            <div 
              className="px-3 py-1.5 bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 rounded-xl text-xs font-bold flex items-center gap-1.5 shrink-0 shadow-sm"
              title={\`Niveau de Scénario (\${mySessionPlayer?.xp || 0} XP) : détermine le nombre max d'équipes\`}
            >
              <Medal className="w-3.5 h-3.5 text-emerald-400" />
              <span>Scénario Niv. {mySessionPlayer?.level || 1}</span>
            </div>`
);

fs.writeFileSync('src/App.tsx', code);
