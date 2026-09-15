const fs = require('fs');
let code = fs.readFileSync('src/components/survival/GameSetupWizard.tsx', 'utf8');

code = code.replace(
  `                {(displayedCharIds.length > 0 
                  ? characterPool.filter(c => displayedCharIds.includes(c.id) || selectedCharIds.includes(c.id))
                  : characterPool.slice(0, 10)
                ).map(rawChar => {`,
  `                {(displayedCharIds.length > 0 
                  ? characterPool.filter(c => displayedCharIds.includes(c.id) || selectedCharIds.includes(c.id))
                  : characterPool.slice(0, 10)
                ).sort((a, b) => {
                  const aSel = selectedCharIds.includes(a.id);
                  const bSel = selectedCharIds.includes(b.id);
                  if (aSel && !bSel) return -1;
                  if (!aSel && bSel) return 1;
                  return 0;
                }).map(rawChar => {`
);

fs.writeFileSync('src/components/survival/GameSetupWizard.tsx', code);
