const fs = require('fs');
let appCode = fs.readFileSync('src/App.tsx', 'utf8');
let modalCode = fs.readFileSync('src/components/survival/MissionsModal.tsx', 'utf8');

appCode = appCode.replace(
  `import { Trophy, MapPin, Users, Crosshair, HeartPulse, Hammer, Box, Shield, ScrollText, ArrowRight, Play, CheckCircle2, ChevronRight, Zap, Droplets, Target, User, RefreshCw, X, LogOut, Sun, Moon, Flame, Wind, Droplet, Plus, Building2, Home } from 'lucide-react';`,
  `import { Trophy, Medal, MapPin, Users, Crosshair, HeartPulse, Hammer, Box, Shield, ScrollText, ArrowRight, Play, CheckCircle2, ChevronRight, Zap, Droplets, Target, User, RefreshCw, X, LogOut, Sun, Moon, Flame, Wind, Droplet, Plus, Building2, Home } from 'lucide-react';`
);

fs.writeFileSync('src/App.tsx', appCode);

modalCode = modalCode.replace(
  `export const MissionsModal: React.FC<MissionsModalProps> = ({ progression, onClose, onClaimMissionReward, onOpenAdjacentCitiesModal }) => {`,
  `export const MissionsModal: React.FC<MissionsModalProps> = ({ progression, maxSquadSlots, onClose, onClaimMissionReward, onOpenAdjacentCitiesModal }) => {`
);

fs.writeFileSync('src/components/survival/MissionsModal.tsx', modalCode);
