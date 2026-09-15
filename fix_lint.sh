sed -i '1s/^/import React from "react";\n/' src/components/Auth.tsx
sed -i '1s/^/import React from "react";\n/' src/components/CitySelector.tsx
sed -i 's/return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));/return snapshot.docs.map(doc => ({ id: doc.id, ...(doc.data() as any) }));/' src/lib/api.ts
