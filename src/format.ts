export function formatShanghai(ts: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(ts));
}

export function formatPrice(value: number): string {
  const abs = Math.abs(value);
  let digits = 2;
  if (abs > 0 && abs < 0.0001) digits = 8;
  else if (abs < 0.01) digits = 6;
  else if (abs < 1) digits = 4;
  else if (abs < 100) digits = 3;
  return value.toLocaleString("zh-CN", {
    minimumFractionDigits: Math.min(2, digits),
    maximumFractionDigits: digits,
  });
}

export function formatCompact(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)} 万亿`;
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)} 亿`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(2)} 万`;
  return `${sign}${abs.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

export function formatQty(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e4) return formatCompact(value);
  if (abs >= 1) return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return value.toLocaleString("zh-CN", { maximumSignificantDigits: 4 });
}

export function formatFull(value: number): string {
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}

/** Percent already expressed in percentage points: -0.15 -> "-0.15%". */
export function formatPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

/** Fraction: 0.109 -> "10.9%". */
export function formatFractionPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

export function formatInt(value: number): string {
  return Math.round(value).toLocaleString("zh-CN");
}

export function pctClass(value: number | null): string {
  if (value == null || !Number.isFinite(value) || value === 0) return "flat";
  return value > 0 ? "up" : "down";
}
