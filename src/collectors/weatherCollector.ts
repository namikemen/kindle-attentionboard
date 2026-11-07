export interface WeatherData {
  temperature: number;
  feelsLike: number;
  tempMin: number;
  tempMax: number;
  condition: string;
  icon: 'sunny' | 'partly-cloudy' | 'cloudy' | 'rain' | 'thunder' | 'snow' | 'fog';
  humidity: number;
  windSpeed: number;
  precipitationProbability: number;
  city: string;
  unit: string;
  lastUpdated: string;
}

let cachedWeather: WeatherData | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function mapWmoCode(code: number): { condition: string; icon: WeatherData['icon'] } {
  if (code === 0) return { condition: 'Clear Sky', icon: 'sunny' };
  if (code === 1 || code === 2) return { condition: 'Partly Cloudy', icon: 'partly-cloudy' };
  if (code === 3) return { condition: 'Overcast', icon: 'cloudy' };
  if (code >= 45 && code <= 48) return { condition: 'Foggy', icon: 'fog' };
  if (code >= 51 && code <= 55) return { condition: 'Drizzle', icon: 'rain' };
  if (code >= 61 && code <= 67) return { condition: 'Rain', icon: 'rain' };
  if (code >= 71 && code <= 77) return { condition: 'Snow', icon: 'snow' };
  if (code >= 80 && code <= 82) return { condition: 'Showers', icon: 'rain' };
  if (code >= 95) return { condition: 'Thunderstorm', icon: 'thunder' };
  return { condition: 'Partly Cloudy', icon: 'partly-cloudy' };
}

export async function getWeatherData(preferredCity?: string): Promise<WeatherData> {
  const now = Date.now();
  if (cachedWeather && now - lastFetchTime < CACHE_TTL_MS) {
    return cachedWeather;
  }

  let latitude = 41.9028; // Rome default
  let longitude = 12.4964;
  let city = preferredCity || 'Rome';

  try {
    const geoRes = await fetch('http://ip-api.com/json', { signal: AbortSignal.timeout(3000) });
    if (geoRes.ok) {
      const geo = (await geoRes.json()) as Record<string, unknown>;
      if (typeof geo.lat === 'number' && typeof geo.lon === 'number') {
        latitude = geo.lat;
        longitude = geo.lon;
        city = (typeof geo.city === 'string' && geo.city) || (typeof geo.regionName === 'string' && geo.regionName) || city;
      }
    }
  } catch {
    // Keep default coords
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Weather fetch failed: ${res.status}`);

    const data = (await res.json()) as {
      current?: {
        weather_code?: number;
        temperature_2m?: number;
        apparent_temperature?: number;
        relative_humidity_2m?: number;
        wind_speed_10m?: number;
      };
      daily?: {
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_probability_max?: number[];
      };
    };
    const current = data.current || {};
    const daily = data.daily || {};

    const code = current.weather_code ?? 0;
    const { condition, icon } = mapWmoCode(code);

    const temp = Math.round(current.temperature_2m ?? 20);
    const feelsLike = Math.round(current.apparent_temperature ?? temp);
    const tempMax = Math.round(daily.temperature_2m_max?.[0] ?? temp + 3);
    const tempMin = Math.round(daily.temperature_2m_min?.[0] ?? temp - 4);
    const humidity = Math.round(current.relative_humidity_2m ?? 65);
    const windSpeed = Math.round(current.wind_speed_10m ?? 8);
    const precipitationProbability = daily.precipitation_probability_max?.[0] ?? 10;

    cachedWeather = {
      temperature: temp,
      feelsLike,
      tempMin,
      tempMax,
      condition,
      icon,
      humidity,
      windSpeed,
      precipitationProbability,
      city,
      unit: '°C',
      lastUpdated: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    lastFetchTime = now;
    return cachedWeather;
  } catch {
    if (cachedWeather) return cachedWeather;
    return {
      temperature: 20,
      feelsLike: 20,
      tempMin: 14,
      tempMax: 23,
      condition: 'Fair',
      icon: 'partly-cloudy',
      humidity: 60,
      windSpeed: 10,
      precipitationProbability: 10,
      city: 'Local',
      unit: '°C',
      lastUpdated: 'Cached',
    };
  }
}
