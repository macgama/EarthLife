const fs = require('fs');
let code = fs.readFileSync('src/components/AdminModal.tsx', 'utf8');

code = code.replace(
  `          ) : activeTab === 'events' ? (`,
  `          ) : activeTab === 'sessions' ? (
            <div className="space-y-6">
              <div className="flex justify-between items-center">
                <h3 className="font-bold text-white text-lg flex items-center gap-2"><Database className="w-5 h-5 text-indigo-400"/> Scénarios & Sessions ({dbSessions.length})</h3>
                <span className="text-xs text-slate-400">Gérez les parties multijoueurs</span>
              </div>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {dbSessions.map(session => (
                  <div key={session.id} className="bg-slate-800/50 border border-slate-700 rounded-xl p-5 flex flex-col justify-between gap-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-indigo-950/80 text-indigo-300 border border-indigo-500/30">
                          {session.id}
                        </span>
                        {session.status === 'active' ? (
                          <span className="text-emerald-400 text-xs font-bold flex items-center gap-1"><Activity className="w-3.5 h-3.5"/> Actif</span>
                        ) : (
                          <span className="text-slate-400 text-xs font-bold">Terminé</span>
                        )}
                      </div>
                      <h4 className="font-bold text-white line-clamp-1">{session.scenario || 'Scénario Inconnu'}</h4>
                      <p className="text-xs text-slate-400 line-clamp-2">{session.description || 'Aucune description.'}</p>
                      <div className="text-xs text-slate-400">
                        Host: <span className="text-slate-200">{session.hostEmail || 'Système'}</span>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2 pt-3 border-t border-slate-700">
                      <button
                        onClick={async () => {
                          if (window.confirm("Êtes-vous sûr de vouloir supprimer cette session et toutes ses données (équipes, états des villes, etc.) ?")) {
                            await deleteGameSession(session.id);
                          }
                        }}
                        className="px-3 py-1.5 bg-rose-950/80 hover:bg-rose-900 border border-rose-500/30 text-rose-300 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-all w-full justify-center"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Supprimer la Session
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : activeTab === 'events' ? (`
);

fs.writeFileSync('src/components/AdminModal.tsx', code);
