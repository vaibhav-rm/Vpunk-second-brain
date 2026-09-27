export interface WeatherInfo {
  temp: number;
  condition: string;
  tomorrowMin: number;
  tomorrowMax: number;
}

// Maps WMO Weather Interpretation Codes (WW) to human readable descriptions
function translateWeatherCode(code: number): string {
  if (code === 0) return "Clear sky";
  if ([1, 2, 3].includes(code)) return "Partly cloudy";
  if ([45, 48].includes(code)) return "Foggy";
  if ([51, 53, 55].includes(code)) return "Drizzle";
  if ([61, 63, 65].includes(code)) return "Rainy";
  if ([71, 73, 75].includes(code)) return "Snowy";
  if ([80, 81, 82].includes(code)) return "Rain showers";
  if ([95, 96, 99].includes(code)) return "Thunderstorm";
  return "Cloudy";
}

// Module-scope cache (dev server is a single long-lived process)
const weatherCache = new Map<string, { at: number; info: WeatherInfo }>();

export async function fetchWeather(
  lat: number = 18.5204, // Default to Pune, India or user location
  lon: number = 73.8567
): Promise<WeatherInfo> {
  // 10-minute cache: weather barely moves, but every snapshot/page used to
  // pay a full round-trip to Open-Meteo (often 0.5-2s). Cached reads are ~1ms.
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const now = Date.now();
  const hit = weatherCache.get(key);
  if (hit && now - hit.at < 10 * 60 * 1000) return hit.info;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto`;
    // Bounded: a hung Open-Meteo call must never hold a voice POST open.
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      throw new Error(`Open-Meteo returned status ${response.status}`);
    }

    const data = await response.json();

    const temp = Math.round(data.current.temperature_2m);
    const condition = translateWeatherCode(data.current.weather_code);
    const tomorrowMin = Math.round(data.daily.temperature_2m_min[1]);
    const tomorrowMax = Math.round(data.daily.temperature_2m_max[1]);

    const info = {
      temp,
      condition,
      tomorrowMin,
      tomorrowMax,
    };
    weatherCache.set(key, { at: now, info });
    return info;
  } catch (error) {
    console.error("Failed to fetch weather:", error);
    // Serve stale cache over the hardcoded fallback when possible
    if (hit) return hit.info;
    return {
      temp: 24,
      condition: "Partly cloudy",
      tomorrowMin: 20,
      tomorrowMax: 28,
    };
  }
}
