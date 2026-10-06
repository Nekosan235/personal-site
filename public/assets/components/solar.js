const radians = Math.PI / 180;
const dayMs = 86_400_000;
const normalize = (value, period) => ((value % period) + period) % period;

export const referenceCities = [
  { id: 'shanghai', name: '上海', latitude: 31.23, longitude: 121.47, timeZone: 'Asia/Shanghai' },
  { id: 'beijing', name: '北京', latitude: 39.90, longitude: 116.41, timeZone: 'Asia/Shanghai' },
  { id: 'guangzhou', name: '广州', latitude: 23.13, longitude: 113.26, timeZone: 'Asia/Shanghai' },
  { id: 'shenzhen', name: '深圳', latitude: 22.54, longitude: 114.06, timeZone: 'Asia/Shanghai' },
  { id: 'chengdu', name: '成都', latitude: 30.57, longitude: 104.07, timeZone: 'Asia/Shanghai' },
  { id: 'tokyo', name: '东京', latitude: 35.68, longitude: 139.69, timeZone: 'Asia/Tokyo' },
  { id: 'singapore', name: '新加坡', latitude: 1.35, longitude: 103.82, timeZone: 'Asia/Singapore' },
  { id: 'london', name: '伦敦', latitude: 51.51, longitude: -0.13, timeZone: 'Europe/London' },
  { id: 'berlin', name: '柏林', latitude: 52.52, longitude: 13.41, timeZone: 'Europe/Berlin' },
  { id: 'new-york', name: '纽约', latitude: 40.71, longitude: -74.01, timeZone: 'America/New_York' },
  { id: 'los-angeles', name: '洛杉矶', latitude: 34.05, longitude: -118.24, timeZone: 'America/Los_Angeles' },
  { id: 'sydney', name: '悉尼', latitude: -33.87, longitude: 151.21, timeZone: 'Australia/Sydney' },
];

const timeZoneReferences = {
  'Asia/Shanghai': 'shanghai', 'Asia/Chongqing': 'shanghai', 'Asia/Harbin': 'shanghai',
  'Asia/Hong_Kong': { name: '香港', latitude: 22.32, longitude: 114.17 },
  'Asia/Taipei': { name: '台北', latitude: 25.03, longitude: 121.57 },
  'Asia/Tokyo': 'tokyo', 'Asia/Seoul': { name: '首尔', latitude: 37.57, longitude: 126.98 },
  'Asia/Singapore': 'singapore', 'Asia/Kuala_Lumpur': 'singapore',
  'Asia/Kolkata': { name: '新德里', latitude: 28.61, longitude: 77.21 },
  'Asia/Calcutta': { name: '新德里', latitude: 28.61, longitude: 77.21 },
  'Asia/Dubai': { name: '迪拜', latitude: 25.20, longitude: 55.27 },
  'Europe/London': 'london', 'Europe/Berlin': 'berlin',
  'Europe/Paris': { name: '巴黎', latitude: 48.86, longitude: 2.35 },
  'America/New_York': 'new-york', 'US/Eastern': 'new-york',
  'America/Los_Angeles': 'los-angeles', 'US/Pacific': 'los-angeles',
  'America/Chicago': { name: '芝加哥', latitude: 41.88, longitude: -87.63 },
  'America/Denver': { name: '丹佛', latitude: 39.74, longitude: -104.99 },
  'Australia/Sydney': 'sydney',
  'Pacific/Auckland': { name: '奥克兰', latitude: -36.85, longitude: 174.76 },
  UTC: { name: '格林尼治', latitude: 51.48, longitude: 0 },
  'Etc/UTC': { name: '格林尼治', latitude: 51.48, longitude: 0 },
};

export function validTimeZone(value) {
  try {
    if (typeof value !== 'string' || !value) return false;
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    return true;
  } catch { return false; }
}

export function detectedTimeZone() {
  const value = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return validTimeZone(value) ? value : 'UTC';
}

function civilDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const part = (type) => Number(parts.find((item) => item.type === type)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

function timeZoneLongitude(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en', { timeZone, timeZoneName: 'longOffset' }).formatToParts(date);
  const offset = parts.find((item) => item.type === 'timeZoneName')?.value || 'GMT';
  const match = offset.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const hours = (Number(match[2]) + Number(match[3]) / 60) * (match[1] === '-' ? -1 : 1);
  return normalize(hours * 15 + 180, 360) - 180;
}

export function resolveLocation(preference = { source: 'timezone' }, timeZone = detectedTimeZone(), date = new Date()) {
  const zone = validTimeZone(timeZone) ? timeZone : 'UTC';
  if (preference.source === 'custom' && Number.isFinite(preference.latitude) && Number.isFinite(preference.longitude)
    && Math.abs(preference.latitude) <= 90 && Math.abs(preference.longitude) <= 180) {
    return { ...preference, name: '自定义参考位置', timeZone: zone, approximate: false };
  }
  if (preference.source === 'preset') {
    const city = referenceCities.find((item) => item.id === preference.city);
    if (city) return { ...city, source: 'preset', approximate: false };
  }
  const reference = timeZoneReferences[zone];
  const city = typeof reference === 'string' ? referenceCities.find((item) => item.id === reference) : reference;
  return city
    ? { ...city, timeZone: zone, source: 'timezone', approximate: false }
    : { name: '时区参考点（近似）', latitude: 0, longitude: timeZoneLongitude(zone, date),
      timeZone: zone, source: 'timezone', approximate: true };
}

/** Solar zenith approximation; all computation stays in the browser. */
export function solarTimes(date, location) {
  const timeZone = validTimeZone(location.timeZone) ? location.timeZone : 'UTC';
  const { year, month, day } = civilDate(date, timeZone);
  const midnight = Date.UTC(year, month - 1, day);
  const dayOfYear = Math.round((midnight - Date.UTC(year, 0, 1)) / dayMs) + 1;
  const latitude = location.latitude * radians;
  const longitudeHours = location.longitude / 15;

  function event(rise) {
    const approximate = dayOfYear + ((rise ? 6 : 18) - longitudeHours) / 24;
    const mean = (0.9856 * approximate - 3.289) * radians;
    const longitude = normalize(mean / radians + 1.916 * Math.sin(mean)
      + 0.020 * Math.sin(2 * mean) + 282.634, 360);
    let ascension = normalize(Math.atan(0.91764 * Math.tan(longitude * radians)) / radians, 360);
    ascension += Math.floor(longitude / 90) * 90 - Math.floor(ascension / 90) * 90;
    ascension /= 15;
    const declination = Math.asin(0.39782 * Math.sin(longitude * radians));
    const cosine = (Math.cos(90.833 * radians) - Math.sin(declination) * Math.sin(latitude))
      / (Math.cos(declination) * Math.cos(latitude));
    if (cosine > 1) return { polar: 'night' };
    if (cosine < -1) return { polar: 'day' };
    const angle = Math.acos(cosine) / radians;
    const hour = (rise ? 360 - angle : angle) / 15;
    const utc = normalize(hour + ascension - 0.06571 * approximate - 6.622 - longitudeHours, 24);
    let value = new Date(midnight + Math.round(utc * 3_600_000));
    const candidate = civilDate(value, timeZone);
    const candidateDay = Date.UTC(candidate.year, candidate.month - 1, candidate.day);
    value = new Date(value.getTime() + midnight - candidateDay);
    return { value };
  }
  const rise = event(true);
  const set = event(false);
  return {
    sunrise: rise.value || null, sunset: set.value || null,
    polar: rise.polar || set.polar || null,
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    timeZone,
  };
}

export function solarIsDay(date, times) {
  if (times.polar) return times.polar === 'day';
  if (!times.sunrise || !times.sunset) return false;
  return times.sunrise > times.sunset
    ? date >= times.sunrise || date < times.sunset
    : date >= times.sunrise && date < times.sunset;
}
