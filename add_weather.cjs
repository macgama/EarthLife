const fs = require('fs');

let code = fs.readFileSync('src/components/CitySelector.tsx', 'utf8');

// Add imports
code = code.replace(
  /import \{ Loader2, Search, Map as MapIcon, Plus, ChevronRight, Check \} from 'lucide-react';/,
  "import { Loader2, Search, Map as MapIcon, Plus, ChevronRight, Check, Sun, Cloud, CloudRain, Snowflake, CloudLightning, CloudFog } from 'lucide-react';"
);

const weatherComponent = `
function CityWeather({ lat, lon, cityName }: { lat?: number, lon?: number, cityName: string }) {
  const [weather, setWeather] = useState<any>(null);

  useEffect(() => {
    async function fetchWeather() {
      try {
        let fetchLat = lat;
        let fetchLon = lon;
        
        // If no lat/lon, try to geocode quickly using Nominatim (just taking the first result)
        if (!fetchLat || !fetchLon) {
          const res = await searchCitiesWithNominatim(cityName);
          if (res && res.length > 0) {
            fetchLat = parseFloat(res[0].lat);
            fetchLon = parseFloat(res[0].lon);
          }
        }

        if (fetchLat && fetchLon) {
          const res = await fetch(\`https://api.open-meteo.com/v1/forecast?latitude=\${fetchLat}&longitude=\${fetchLon}&current_weather=true\`);
          const data = await res.json();
          if (data.current_weather) {
            setWeather(data.current_weather);
          }
        }
      } catch (e) {
        console.warn("Weather fetch failed for", cityName, e);
      }
    }
    fetchWeather();
  }, [lat, lon, cityName]);

  if (!weather) return <div className="h-6"></div>;

  let WeatherIcon = Sun;
  const code = weather.weathercode;
  if (code === 0) WeatherIcon = Sun;
  else if (code === 1 || code === 2 || code === 3) WeatherIcon = Cloud;
  else if (code === 45 || code === 48) WeatherIcon = CloudFog;
  else if (code >= 51 && code <= 67) WeatherIcon = CloudRain;
  else if (code >= 71 && code <= 77) WeatherIcon = Snowflake;
  else if (code >= 80 && code <= 82) WeatherIcon = CloudRain;
  else if (code >= 95 && code <= 99) WeatherIcon = CloudLightning;

  return (
    <div className="flex items-center gap-2 text-slate-300 mt-2 bg-slate-900/50 rounded-md px-2 py-1 w-fit border border-slate-700/50">
      <WeatherIcon className="w-3.5 h-3.5 text-cyan-400" />
      <span className="text-[10px] font-medium">{weather.temperature}°C</span>
    </div>
  );
}

`;

code = code.replace(
  /export function CitySelector/,
  weatherComponent + "export function CitySelector"
);

code = code.replace(
  /<h3 className="text-white font-medium">\{city\.name\}<\/h3>\s*<p className="text-slate-500 text-xs mt-1">\s*\{new Date\(city\.createdAt\)\.toLocaleDateString\(\)\}\s*<\/p>/,
  `<h3 className="text-white font-medium">{city.name}</h3>
                        <div className="flex items-center gap-3">
                          <p className="text-slate-500 text-xs mt-1">
                            {new Date(city.createdAt).toLocaleDateString()}
                          </p>
                          <CityWeather lat={city.lat} lon={city.lon} cityName={city.name} />
                        </div>`
);

fs.writeFileSync('src/components/CitySelector.tsx', code);
