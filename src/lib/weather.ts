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

export async function fetchWeather(
  lat: number = 18.5204, // Default to Pune, India or user location
  lon: number = 73.8567
): Promise<WeatherInfo> {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min,weather_code&timezone=auto`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Open-Meteo returned status ${response.status}`);
    }

    const data = await response.json();

    const temp = Math.round(data.current.temperature_2m);
    const condition = translateWeatherCode(data.current.weather_code);
    const tomorrowMin = Math.round(data.daily.temperature_2m_min[1]);
    const tomorrowMax = Math.round(data.daily.temperature_2m_max[1]);

    return {
      temp,
      condition,
      tomorrowMin,
      tomorrowMax,
    };
  } catch (error) {
    console.error("Failed to fetch weather:", error);
    return {
      temp: 24,
      condition: "Partly cloudy",
      tomorrowMin: 20,
      tomorrowMax: 28,
    };
  }
}
