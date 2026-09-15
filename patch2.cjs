const fs = require('fs');
const path = 'src/components/survival/BuildingDetailModal.tsx';
let code = fs.readFileSync(path, 'utf8');

code = code.replace(
  `                    </div>
                  ))}
                </div>
              )}
            </div>
          )}`,
  `                    </div>
                  );
                })}
                </div>
              )}
            </div>
          )}`
);

fs.writeFileSync(path, code);
