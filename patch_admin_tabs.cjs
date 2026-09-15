const fs = require('fs');
let code = fs.readFileSync('src/components/AdminModal.tsx', 'utf8');

code = code.replace(
  `  const [activeTab, setActiveTab] = useState<'list' | 'create' | 'profile' | 'roles' | 'items' | 'events'>('list');`,
  `  const [activeTab, setActiveTab] = useState<'list' | 'create' | 'profile' | 'roles' | 'items' | 'events' | 'sessions'>('list');`
);

code = code.replace(
  `          <button
            onClick={() => setActiveTab('events')}
            className={"pb-3 px-2 text-sm font-bold border-b-2 transition-all whitespace-nowrap " + (activeTab === 'events' ? 'border-rose-500 text-rose-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
          >
            ⚡ Simulation & Survie (Admin)
          </button>`,
  `          <button
            onClick={() => setActiveTab('events')}
            className={"pb-3 px-2 text-sm font-bold border-b-2 transition-all whitespace-nowrap " + (activeTab === 'events' ? 'border-rose-500 text-rose-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
          >
            ⚡ Simulation & Survie (Admin)
          </button>
          <button
            onClick={() => setActiveTab('sessions')}
            className={"pb-3 px-2 text-sm font-bold border-b-2 transition-all whitespace-nowrap " + (activeTab === 'sessions' ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-300')}
          >
            🌍 Scénarios (Sessions)
          </button>`
);

fs.writeFileSync('src/components/AdminModal.tsx', code);
