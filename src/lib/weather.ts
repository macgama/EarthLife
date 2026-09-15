export interface WeatherData {
  temperature: number;
  apparentTemperature: number;
  humidity: number;
  windSpeed: number;
  weatherCode: number;
  weatherDescription: string;
  isDay: boolean;
}

export function getWeatherDescription(code: number): string {
  switch (code) {
    case 0:
      return 'Ciel dégagé';
    case 1:
      return 'Ensoleillé';
    case 2:
      return 'Partiellement nuageux';
    case 3:
      return 'Couvert';
    case 45:
    case 48:
      return 'Brouillard';
    case 51:
    case 53:
    case 55:
      return 'Bruine';
    case 61:
    case 63:
    case 65:
      return 'Pluie';
    case 66:
    case 67:
      return 'Pluie verglaçante';
    case 71:
    case 73:
    case 75:
    case 77:
      return 'Neige';
    case 80:
    case 81:
    case 82:
      return 'Averses de pluie';
    case 85:
    case 86:
      return 'Averses de neige';
    case 95:
    case 96:
    case 99:
      return 'Orage';
    default:
      return 'Météo variable';
  }
}

export async function fetchCurrentWeather(lat: number, lon: number): Promise<WeatherData | null> {
  try {
    const res = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.current) return null;

    const current = data.current;
    return {
      temperature: Math.round(current.temperature_2m),
      apparentTemperature: Math.round(current.apparent_temperature),
      humidity: Math.round(current.relative_humidity_2m),
      windSpeed: Math.round(current.wind_speed_10m),
      weatherCode: current.weather_code,
      weatherDescription: getWeatherDescription(current.weather_code),
      isDay: Boolean(current.is_day)
    };
  } catch (error) {
    console.warn('Failed to fetch weather:', error);
    return null;
  }
}
