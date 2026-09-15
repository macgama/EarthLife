const fs = require('fs');

let appCode = fs.readFileSync('src/App.tsx', 'utf8');

appCode = appCode.replace(/import { getCityGeoJSON } from '.\/lib\/api';/, "import { subscribeToCityData } from './lib/api';");

appCode = appCode.replace(/useEffect\(\(\) => \{\n    if \(\!selectedCityId\) return;\n\n    const fetchData = async \(\) => \{[\s\S]*?\}\(\);\n  \}, \[selectedCityId\]\);/g, `
  const [cityStatus, setCityStatus] = useState<string>('ready');

  useEffect(() => {
    if (!selectedCityId) {
      setGeoData(null);
      return;
    }
    
    setLoading(true);
    setError(null);
    
    const unsubscribe = subscribeToCityData(selectedCityId, (data, status) => {
      setGeoData(data);
      setCityStatus(status);
      
      // We can stop showing the central loading spinner once we have at least the boundary
      if (data && data.features && data.features.length > 0) {
        setLoading(false);
      }
      
      if (status === 'error') {
        setError("Erreur lors de l'importation de la ville.");
        setLoading(false);
      }
    });

    return () => unsubscribe();
  }, [selectedCityId]);
`);

fs.writeFileSync('src/App.tsx', appCode);
