import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';

const UK_CITIES: Record<string, [number, number]> = {
  london: [51.5074, -0.1278],
  manchester: [53.4808, -2.2426],
  birmingham: [52.4862, -1.8904],
  edinburgh: [55.9533, -3.1883],
  glasgow: [55.8642, -4.2518],
  liverpool: [53.4084, -2.9916],
  bristol: [51.4545, -2.5879],
  sheffield: [53.3811, -1.4701],
  leeds: [53.8008, -1.5491],
  newcastle: [54.9783, -1.6178],
  cardiff: [51.4816, -3.1791],
  belfast: [54.5973, -5.9301],
  nottingham: [52.9548, -1.1581],
  leicester: [52.6369, -1.1398],
  coventry: [52.4068, -1.5197],
  bradford: [53.7960, -1.7594],
  plymouth: [50.3755, -4.1427],
  southampton: [50.9097, -1.4044],
};

function resolveLocation(location: string): [number, number] {
  const key = location.toLowerCase().trim().replace(/\s+/g, '');
  if (UK_CITIES[key]) return UK_CITIES[key];
  if (location.includes(',')) {
    const parts = location.split(',').map((s) => parseFloat(s.trim()));
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
      return [parts[0], parts[1]];
    }
  }
  throw new Error(`Unknown UK city or invalid coords: ${location}. Supported: ${Object.keys(UK_CITIES).join(', ')} or "lat,lon"`);
}

interface WeatherProvider {
  name: string;
  hasKey(): boolean;
  getForecast(lat: number, lon: number, options?: { days?: number; variables?: string[] }): Promise<any>;
  getHistorical(lat: number, lon: number, options: { startDate: string; endDate: string; variables?: string[] }): Promise<any>;
  getCurrent(lat: number, lon: number, options?: { variables?: string[] }): Promise<any>;
}

class OpenMeteoProvider implements WeatherProvider {
  name = 'OpenMeteo';
  hasKey() { return true; } // no key needed

  async getForecast(lat: number, lon: number, options: { days?: number; variables?: string[] } = {}) {
    const days = options.days || 7;
    const vars = options.variables || ['temperature_2m', 'precipitation', 'rain', 'showers', 'cloud_cover', 'wind_speed_10m'];
    const hourly = vars.join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${hourly}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&forecast_days=${days}&timezone=auto&models=ukmo_seamless`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OpenMeteo forecast failed: ${res.status}`);
    return res.json();
  }

  async getHistorical(lat: number, lon: number, options: { startDate: string; endDate: string; variables?: string[] }) {
    const vars = options.variables || ['temperature_2m', 'precipitation', 'rain', 'cloud_cover'];
    const hourly = vars.join(',');
    const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${options.startDate}&end_date=${options.endDate}&hourly=${hourly}&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OpenMeteo historical failed: ${res.status}`);
    return res.json();
  }

  async getCurrent(lat: number, lon: number, options: { variables?: string[] } = {}) {
    const vars = options.variables || ['temperature_2m', 'precipitation', 'cloud_cover', 'wind_speed_10m'];
    const current = vars.join(',');
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=${current}&timezone=auto&models=ukmo_seamless`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OpenMeteo current failed: ${res.status}`);
    return res.json();
  }
}

class OpenWeatherMapProvider implements WeatherProvider {
  name = 'OpenWeatherMap';
  private key: string;
  constructor(key: string) { this.key = key; }
  hasKey() { return !!this.key; }

  async getForecast(lat: number, lon: number, options: { days?: number; variables?: string[] } = {}) {
    const days = Math.min(options.days || 5, 5); // free tier limit
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${this.key}&units=metric&cnt=${days * 8}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OWM forecast failed: ${res.status}`);
    return res.json();
  }

  async getHistorical(lat: number, lon: number, options: { startDate: string; endDate: string; variables?: string[] }) {
    // Free tier limited; use one call example, in practice may need paid for full hist
    const url = `https://api.openweathermap.org/data/2.5/onecall/timemachine?lat=${lat}&lon=${lon}&dt=${Math.floor(new Date(options.startDate).getTime()/1000)}&appid=${this.key}&units=metric`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OWM historical failed: ${res.status}`);
    return res.json();
  }

  async getCurrent(lat: number, lon: number, options: { variables?: string[] } = {}) {
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${this.key}&units=metric`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`OWM current failed: ${res.status}`);
    return res.json();
  }
}

class VisualCrossingProvider implements WeatherProvider {
  name = 'VisualCrossing';
  private key: string;
  constructor(key: string) { this.key = key; }
  hasKey() { return !!this.key; }

  async getForecast(lat: number, lon: number, options: { days?: number; variables?: string[] } = {}) {
    const days = options.days || 7;
    const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${lat},${lon}/next${days}days?key=${this.key}&unitGroup=metric&include=hours,days`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`VisualCrossing forecast failed: ${res.status}`);
    return res.json();
  }

  async getHistorical(lat: number, lon: number, options: { startDate: string; endDate: string; variables?: string[] }) {
    const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${lat},${lon}/${options.startDate}/${options.endDate}?key=${this.key}&unitGroup=metric&include=hours,days`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`VisualCrossing historical failed: ${res.status}`);
    return res.json();
  }

  async getCurrent(lat: number, lon: number, options: { variables?: string[] } = {}) {
    const url = `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${lat},${lon}/today?key=${this.key}&unitGroup=metric&include=current`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`VisualCrossing current failed: ${res.status}`);
    return res.json();
  }
}

class WeatherAPIProvider implements WeatherProvider {
  name = 'WeatherAPI';
  private key: string;
  constructor(key: string) { this.key = key; }
  hasKey() { return !!this.key; }

  async getForecast(lat: number, lon: number, options: { days?: number; variables?: string[] } = {}) {
    const days = Math.min(options.days || 7, 7);
    const url = `https://api.weatherapi.com/v1/forecast.json?key=${this.key}&q=${lat},${lon}&days=${days}&aqi=no&alerts=no`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`WeatherAPI forecast failed: ${res.status}`);
    return res.json();
  }

  async getHistorical(lat: number, lon: number, options: { startDate: string; endDate: string; variables?: string[] }) {
    // WeatherAPI historical is /history.json , for range may need multiple or premium
    const url = `https://api.weatherapi.com/v1/history.json?key=${this.key}&q=${lat},${lon}&dt=${options.startDate}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`WeatherAPI historical failed: ${res.status}`);
    return res.json();
  }

  async getCurrent(lat: number, lon: number, options: { variables?: string[] } = {}) {
    const url = `https://api.weatherapi.com/v1/current.json?key=${this.key}&q=${lat},${lon}&aqi=no`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`WeatherAPI current failed: ${res.status}`);
    return res.json();
  }
}

export class WeatherClient {
  private providers: WeatherProvider[] = [];
  private cache = new Map<string, { data: any; ts: number }>();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000; // 15 min

  constructor() {
    this.providers.push(new OpenMeteoProvider());
    if (process.env.OPENWEATHERMAP_API_KEY) {
      this.providers.push(new OpenWeatherMapProvider(process.env.OPENWEATHERMAP_API_KEY));
    }
    if (process.env.VISUALCROSSING_API_KEY) {
      this.providers.push(new VisualCrossingProvider(process.env.VISUALCROSSING_API_KEY));
    }
    if (process.env.WEATHERAPI_KEY) {
      this.providers.push(new WeatherAPIProvider(process.env.WEATHERAPI_KEY));
    }
    logger.info(`WeatherClient initialized with ${this.providers.length} providers (fallbacks enabled)`);
  }

  private getCacheKey(type: string, lat: number, lon: number, options: any) {
    return `${type}:${lat.toFixed(4)},${lon.toFixed(4)}:${JSON.stringify(options)}`;
  }

  private getCached(key: string) {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.ts < this.CACHE_TTL_MS) return entry.data;
    return null;
  }

  private setCached(key: string, data: any) {
    this.cache.set(key, { data, ts: Date.now() });
  }

  async getForecast(location: string, days = 7, variables?: string[]) {
    const [lat, lon] = resolveLocation(location);
    const key = this.getCacheKey('forecast', lat, lon, { days, variables });
    const cached = this.getCached(key);
    if (cached) return cached;

    for (const provider of this.providers) {
      if (!provider.hasKey() && provider.name !== 'OpenMeteo') continue;
      try {
        const data = await withErrorHandling(
          () => provider.getForecast(lat, lon, { days, variables }),
          `weather.forecast.${provider.name}`
        );
        const result = { provider: provider.name, location: { lat, lon, city: location }, data };
        this.setCached(key, result);
        logger.debug(`Weather forecast from ${provider.name} for ${location}`);
        return result;
      } catch (err: any) {
        logger.warn(`Weather provider ${provider.name} forecast failed for ${location}: ${err.message}. Trying fallback...`);
      }
    }
    throw new Error('All weather providers failed for forecast');
  }

  async getHistorical(location: string, startDate: string, endDate: string, variables?: string[]) {
    const [lat, lon] = resolveLocation(location);
    const key = this.getCacheKey('historical', lat, lon, { startDate, endDate, variables });
    const cached = this.getCached(key);
    if (cached) return cached;

    for (const provider of this.providers) {
      if (!provider.hasKey() && provider.name !== 'OpenMeteo') continue;
      try {
        const data = await withErrorHandling(
          () => provider.getHistorical(lat, lon, { startDate, endDate, variables }),
          `weather.historical.${provider.name}`
        );
        const result = { provider: provider.name, location: { lat, lon, city: location }, data };
        this.setCached(key, result);
        logger.debug(`Weather historical from ${provider.name} for ${location}`);
        return result;
      } catch (err: any) {
        logger.warn(`Weather provider ${provider.name} historical failed for ${location}: ${err.message}. Trying fallback...`);
      }
    }
    throw new Error('All weather providers failed for historical');
  }

  async getCurrent(location: string, variables?: string[]) {
    const [lat, lon] = resolveLocation(location);
    const key = this.getCacheKey('current', lat, lon, { variables });
    const cached = this.getCached(key);
    if (cached) return cached;

    for (const provider of this.providers) {
      if (!provider.hasKey() && provider.name !== 'OpenMeteo') continue;
      try {
        const data = await withErrorHandling(
          () => provider.getCurrent(lat, lon, { variables }),
          `weather.current.${provider.name}`
        );
        const result = { provider: provider.name, location: { lat, lon, city: location }, data };
        this.setCached(key, result);
        logger.debug(`Weather current from ${provider.name} for ${location}`);
        return result;
      } catch (err: any) {
        logger.warn(`Weather provider ${provider.name} current failed for ${location}: ${err.message}. Trying fallback...`);
      }
    }
    throw new Error('All weather providers failed for current');
  }
}

export const weatherClient = new WeatherClient();
