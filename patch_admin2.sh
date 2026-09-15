#!/bin/bash
sed -i 's/useState<'"'"'list'"'"' | '"'"'create'"'"' | '"'"'profile'"'"' | '"'"'roles'"'"' | '"'"'items'"'"' | '"'"'events'"'"' | '"'"'sessions'"'"'>/useState<'"'"'list'"'"' | '"'"'create'"'"' | '"'"'profile'"'"' | '"'"'roles'"'"' | '"'"'items'"'"' | '"'"'events'"'"' | '"'"'sessions'"'"' | '"'"'rules'"'"'>/g' src/components/AdminModal.tsx
sed -i '/🌍 Scénarios (Sessions)/a \
          </button>\
          <button\
            onClick={() => setActiveTab('"'"'rules'"'"')}\
            className={"pb-3 px-2 text-sm font-bold border-b-2 transition-all whitespace-nowrap " + (activeTab === '"'"'rules'"'"' ? '"'"'border-rose-500 text-rose-400'"'"' : '"'"'border-transparent text-slate-500 hover:text-slate-300'"'"')}\
          >\
            ⚙️ Règles du Jeu\
' src/components/AdminModal.tsx
sed -i 's/activeTab === '"'"'sessions'"'"' || activeTab === '"'"'rules'"'"' ?/activeTab === '"'"'sessions'"'"' ?/g' src/components/AdminModal.tsx
