// Open-Meteo weather with a 10-minute in-memory cache (same policy as the
// website: weather barely moves, cached reads are ~1ms, stale served on
// failure before the hardcoded fallback).

import { fetchWithTimeout } from "./net";

export interface WeatherInfo {
  temp: number;
  condition: string;
  tomorrowMin: number;
  tomorrowMax: number;
}

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

const cache = new Map<string, { at: number; info: WeatherInfo }>();

export async function fetchWeather(
  lat = 18.5204,
  lon = 73.8567
): Promise<WeatherInfo> {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < 10 * 60 * 1000) return hit.info;
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto`;
    const res = await fetchWithTimeout(url, {}, 8000);
    if (!res.ok) throw new Error(`Open-Meteo status ${res.status}`);
    const data = await res.json();
    const info: WeatherInfo = {
      temp: Math.round(data.current.temperature_2m),
      condition: translateWeatherCode(data.current.weather_code),
      tomorrowMin: Math.round(data.daily.temperature_2m_min[1]),
      tomorrowMax: Math.round(data.daily.temperature_2m_max[1]),
    };
    cache.set(key, { at: now, info });
    return info;
  } catch (e) {
    console.warn("fetchWeather failed:", (e as Error)?.message || e);
    if (hit) return hit.info;
    return { temp: 24, condition: "Partly cloudy", tomorrowMin: 20, tomorrowMax: 28 };
  }
}
