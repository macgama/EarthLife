const fs = require('fs');
let code = fs.readFileSync('src/components/survival/BuildingDetailModal.tsx', 'utf8');
const search = `                              <input
                                type="checkbox"r.role}
                                    </span>
                                  </div>
                                </div>
                              </div>`;
code = code.replace(search, '');
fs.writeFileSync('src/components/survival/BuildingDetailModal.tsx', code);
