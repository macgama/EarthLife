const fs = require('fs');
let code = fs.readFileSync('src/components/survival/BuildingDetailModal.tsx', 'utf8');

if (!code.includes('Eye,')) {
    code = code.replace(/import {([^}]+)} from 'lucide-react';/, "import {$1, Eye} from 'lucide-react';");
}
fs.writeFileSync('src/components/survival/BuildingDetailModal.tsx', code);
