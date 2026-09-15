#!/bin/bash
cat src/components/survival/BuildingDetailModal.tsx | sed 's/                              <input\n                                type="checkbox"r.role}\n                                    <\/span>\n                                  <\/div>\n                                <\/div>\n                              <\/div>//' > temp.tsx
mv temp.tsx src/components/survival/BuildingDetailModal.tsx
