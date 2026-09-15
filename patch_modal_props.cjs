const fs = require('fs');
let code = fs.readFileSync('src/components/survival/MissionsModal.tsx', 'utf8');

code = code.replace(
  `interface Props {
  progression: UserProgression;
  onClose: () => void;`,
  `interface Props {
  progression: UserProgression;
  maxSquadSlots: number;
  onClose: () => void;`
);

code = code.replace(
  `export const MissionsModal: React.FC<Props> = ({
  progression,
  onClose,`,
  `export const MissionsModal: React.FC<Props> = ({
  progression,
  maxSquadSlots,
  onClose,`
);

fs.writeFileSync('src/components/survival/MissionsModal.tsx', code);
