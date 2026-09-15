const fs = require('fs');
let css = fs.readFileSync('src/index.css', 'utf8');

css += `
.city-tooltip {
  background-color: transparent !important;
  border: none !important;
  box-shadow: none !important;
  color: #94a3b8 !important;
  font-weight: 500 !important;
  font-size: 14px !important;
  text-transform: uppercase !important;
  letter-spacing: 0.1em !important;
  text-shadow: 0 0 4px #000, 0 0 8px #000 !important;
}
.leaflet-tooltip-top:before,
.leaflet-tooltip-bottom:before,
.leaflet-tooltip-left:before,
.leaflet-tooltip-right:before {
  display: none !important;
}
`;

fs.writeFileSync('src/index.css', css);
