#!/bin/bash
sed -i 's#          ) : null}#          ) : activeTab === '"'"'rules'"'"' ? (\n            <GameRulesEditor />\n          ) : null}#g' src/components/AdminModal.tsx
