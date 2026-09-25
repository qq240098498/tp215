// 水库的水量与水位的口径都集中在这里
const store = require('./store');

function decimalsOf(settings) {
  const precision = Number(settings.levelPrecision) || 0.01;
  return Math.max(0, String(precision).split('.')[1] ? String(precision).split('.')[1].length : 0);
}

function curveOf(data, reservoirId) {
  return data.curves.find((c) => c.reservoirId === reservoirId) || null;
}

function sortedPoints(curve) {
  return (curve.points || []).slice().sort((a, b) => Number(a.level) - Number(b.level));
}

// 由水位查库容：在水位-库容曲线的分段之间线性插值
function capacityAt(curve, level, settings) {
  const points = sortedPoints(curve);
  const result = (value) => store.round(value, 4);
  const target = Number(level);
  if (!points.length) return 0;
  if (target <= Number(points[0].level)) return result(Number(points[0].capacity));
  if (target >= Number(points[points.length - 1].level)) return result(Number(points[points.length - 1].capacity));
  for (let i = 0; i < points.length - 1; i += 1) {
    const low = points[i];
    const high = points[i + 1];
    if (target >= Number(low.level) && target <= Number(high.level)) {
      const ratio = (target - Number(low.level)) / (Number(high.level) - Number(low.level));
      return result(Number(low.capacity) + ratio * (Number(high.capacity) - Number(low.capacity)));
    }
  }
  return result(Number(points[points.length - 1].capacity));
}

// 由库容反查水位：同样按曲线分段反解
function levelAt(curve, capacity) {
  const points = sortedPoints(curve);
  const digits = 2;
  const target = Number(capacity);
  if (!points.length) return 0;
  if (target <= Number(points[0].capacity)) return store.round(Number(points[0].level), digits);
  if (target >= Number(points[points.length - 1].capacity)) return store.round(Number(points[points.length - 1].level), digits);
  const first = points[0];
  const last = points[points.length - 1];
  const ratio = (target - Number(first.capacity)) / (Number(last.capacity) - Number(first.capacity));
  return store.round(Number(first.level) + ratio * (Number(last.level) - Number(first.level)), digits);
}

// 取月-日（MM-DD），用于不依赖年份的汛期口径比较
function monthDayOf(dateStr) {
  const match = String(dateStr || '').match(/^\d{4}-(\d{2}-\d{2})$/);
  return match ? match[1] : '';
}

// 汛期判断：按 月-日 比较，起止当天算汛期；起止跨年（如 11-01 至 03-01）时取并集
function inFloodSeason(dateStr, settings) {
  const md = monthDayOf(dateStr);
  const start = String(settings.floodSeasonStart || '');
  const end = String(settings.floodSeasonEnd || '');
  if (!md || !/^\d{2}-\d{2}$/.test(start) || !/^\d{2}-\d{2}$/.test(end)) return false;
  if (start <= end) return md >= start && md <= end;
  return md >= start || md <= end;
}

function limitLevelOf(reservoir, dateStr, settings) {
  return inFloodSeason(dateStr, settings) ? Number(reservoir.floodLimitLevel) : Number(reservoir.normalLevel);
}

function levelCheck(reservoir, level, dateStr, settings) {
  const limit = limitLevelOf(reservoir, dateStr, settings);
  const over = store.round(Number(level) - limit, 2);
  return { limit, level: Number(level), over, exceeded: over > 0, floodSeason: inFloodSeason(dateStr, settings) };
}

// 预警等级：水位到警戒/限水位，或者入库流量超过门槛，都要提级。
// 严重级门槛与限水位同一口径：汛期看汛限水位，非汛期看正常蓄水位
function warningOf(reservoir, level, inflowFlow, dateStr, settings) {
  const levelValue = Number(level);
  const flow = Number(inflowFlow);
  const seriousLevel = limitLevelOf(reservoir, dateStr, settings);
  let grade = '正常';
  if (levelValue >= seriousLevel) grade = '严重';
  else if (levelValue >= Number(reservoir.warningLevel)) grade = '警戒';
  else if (levelValue >= Number(reservoir.warningLevel) - 0.5) grade = '注意';
  return { level: grade, byLevel: grade, inflowFlow: flow };
}

// 时段水量平衡：入库水量 - 出库水量 - 损失 = 蓄变
function balance(data, reservoirId, fromDate, toDate) {
  const settings = data.settings;
  const reservoir = data.reservoirs.find((r) => r.id === reservoirId);
  const curve = curveOf(data, reservoirId);
  if (!reservoir || !curve) return null;

  const from = data.levels
    .filter((l) => l.reservoirId === reservoirId && l.date >= fromDate && l.date <= toDate)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const days = store.daysBetween(fromDate, toDate);

  const inflowRows = data.inflows.filter((r) => r.reservoirId === reservoirId && r.date >= fromDate && r.date < toDate);
  const releaseRows = data.releases.filter((r) => r.reservoirId === reservoirId && r.date >= fromDate && r.date < toDate);
  const meanInflow = store.round(inflowRows.reduce((s, r) => s + Number(r.flow), 0) / Math.max(1, inflowRows.length), 3);
  const meanRelease = store.round(releaseRows.reduce((s, r) => s + Number(r.flow), 0) / Math.max(1, releaseRows.length), 3);

  const inflowVolume = store.round((meanInflow * days * 86400) / 10000, 3);
  const releaseVolume = store.round((meanRelease * days * 3600) / 10000, 3);
  const lossVolume = 0;
  const startLevel = from.length ? Number(from[0].level) : 0;
  const endLevel = from.length ? Number(from[from.length - 1].level) : 0;
  const startCapacity = curve ? capacityAt(curve, startLevel, settings) : 0;
  const endCapacity = curve ? capacityAt(curve, endLevel, settings) : 0;
  const deltaStorage = store.round(endCapacity - startCapacity, 3);
  const residual = store.round(inflowVolume - releaseVolume - lossVolume - deltaStorage, 3);
  const balanced = Math.abs(residual) < Number(settings.balanceToleranceWan);
  return {
    reservoirId,
    reservoirName: reservoir.name,
    fromDate,
    toDate,
    days,
    meanInflow,
    meanRelease,
    inflowVolume,
    releaseVolume,
    lossVolume,
    startLevel,
    endLevel,
    startCapacity,
    endCapacity,
    deltaStorage,
    residual,
    tolerance: Number(settings.balanceToleranceWan),
    balanced,
  };
}

module.exports = {
  decimalsOf,
  curveOf,
  sortedPoints,
  capacityAt,
  levelAt,
  inFloodSeason,
  limitLevelOf,
  levelCheck,
  warningOf,
  balance,
};
