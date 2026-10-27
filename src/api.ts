import { chunks, mapPool } from "./asyncPool";

const FAPI = "https://fapi.binance.com";
const COINGECKO = "https://api.coingecko.com/api/v3";
const GOPLUS = "https://api.gopluslabs.io";

export interface BinanceQuote {
  mark: number | null;
  index: number | null;
  last: number | null;
  changePct: number | null;
  quoteVolume: number | null;
}

export interface BinanceBundle {
  symbols: { symbol: string; base: string }[];
  quotes: Map<string, BinanceQuote>;
}

export interface DerivativeTicker {
  symbol: string;
  base: string;
  coinId: string | null;
  last: number | null;
  index: number | null;
  changePct: number | null;
  oiUsd: number | null;
}

export interface CoinMeta {
  id: string;
  symbol: string;
  name: string;
  platforms: Record<string, string>;
}

export interface MarketInfo {
  id: string;
  symbol: string;
  name: string;
  marketCap: number | null;
  circulatingSupply: number | null;
}

export interface HolderStat {
  chainLabel: string;
  holderCount: number | null;
  top10Pct: number | null;
  top1Pct: number | null;
  exchangePct: number | null;
  topTag: string | null;
  address: string;
}

interface SupportedChain {
  id: string;
  kind: "evm" | "solana";
  label: string;
}

const SUPPORTED_CHAINS: Record<string, SupportedChain> = {
  ethereum: { id: "1", kind: "evm", label: "以太坊" },
  "binance-smart-chain": { id: "56", kind: "evm", label: "BSC" },
  "polygon-pos": { id: "137", kind: "evm", label: "Polygon" },
  "arbitrum-one": { id: "42161", kind: "evm", label: "Arbitrum" },
  "optimistic-ethereum": { id: "10", kind: "evm", label: "Optimism" },
  base: { id: "8453", kind: "evm", label: "Base" },
  avalanche: { id: "43114", kind: "evm", label: "Avalanche" },
  solana: { id: "solana", kind: "solana", label: "Solana" },
};

const CHAIN_LABELS: Record<string, string> = {
  sui: "Sui",
  hyperliquid: "Hyperliquid",
  tron: "Tron",
  aptos: "Aptos",
  "the-open-network": "TON",
  "near-protocol": "NEAR",
  cardano: "Cardano",
  ripple: "XRP Ledger",
};

const EXCHANGE_TAG =
  /binance|coinbase|kraken|okx|okex|bybit|bitfinex|kucoin|gate\.?io|huobi|htx|crypto\.com|robinhood|bitstamp|mexc|upbit|bithumb/i;

export function chainLabel(platform: string): string {
  return SUPPORTED_CHAINS[platform]?.label ?? CHAIN_LABELS[platform] ?? platform;
}

export function supportedChain(platform: string): SupportedChain | null {
  return SUPPORTED_CHAINS[platform] ?? null;
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

export async function fetchJson(
  url: string,
  parent?: AbortSignal,
  ms = 25000,
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onAbort = () => controller.abort();
  parent?.addEventListener("abort", onAbort);
  if (parent?.aborted) controller.abort();
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = null;
      }
    }
    return { status: res.status, data };
  } catch (error) {
    if (parent?.aborted) throw error;
    if (isAbortError(error)) throw new Error(`请求超时：${url}`);
    throw error;
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
  }
}

export function isRestricted(status: number, data: unknown): boolean {
  if (status === 451) return true;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const msg = String((data as { msg?: unknown }).msg ?? "");
  return msg.toLowerCase().includes("restricted location");
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError ||
    (error instanceof Error && /failed to fetch|networkerror|load failed|请求超时/i.test(error.message))
  );
}

/** Null when the region block or a network failure hides Binance. Throws on other failures. */
export async function loadBinance(signal?: AbortSignal): Promise<BinanceBundle | null> {
  try {
    return await loadBinanceUncached(signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isNetworkError(error)) return null;
    throw error;
  }
}

async function loadBinanceUncached(signal?: AbortSignal): Promise<BinanceBundle | null> {
  const premium = await fetchJson(`${FAPI}/fapi/v1/premiumIndex`, signal);
  if (isRestricted(premium.status, premium.data)) return null;
  if (premium.status !== 200 || !Array.isArray(premium.data)) {
    throw new Error(`币安标记价格接口不可用（HTTP ${premium.status}）`);
  }

  const [info, ticker] = await Promise.all([
    fetchJson(`${FAPI}/fapi/v1/exchangeInfo`, signal),
    fetchJson(`${FAPI}/fapi/v1/ticker/24hr`, signal),
  ]);
  if (isRestricted(info.status, info.data) || isRestricted(ticker.status, ticker.data)) return null;
  if (info.status !== 200 || ticker.status !== 200) {
    throw new Error(`币安合约列表或 24 小时行情不可用（HTTP ${info.status}/${ticker.status}）`);
  }

  const infoBody = info.data as { symbols?: unknown };
  if (!Array.isArray(infoBody?.symbols) || !Array.isArray(ticker.data)) {
    throw new Error("币安合约列表返回了无法识别的结构");
  }

  const symbols: { symbol: string; base: string }[] = [];
  for (const item of infoBody.symbols) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const symbol = str(row.symbol);
    const base = str(row.baseAsset);
    if (!symbol || !base) continue;
    if (row.contractType !== "PERPETUAL") continue;
    if (row.quoteAsset !== "USDT") continue;
    if (row.status !== "TRADING") continue;
    symbols.push({ symbol, base });
  }

  const quotes = new Map<string, BinanceQuote>();
  for (const item of premium.data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const symbol = str(row.symbol);
    if (!symbol) continue;
    quotes.set(symbol, {
      mark: num(row.markPrice),
      index: num(row.indexPrice),
      last: null,
      changePct: null,
      quoteVolume: null,
    });
  }
  for (const item of ticker.data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const symbol = str(row.symbol);
    if (!symbol) continue;
    const prev = quotes.get(symbol) ?? {
      mark: null,
      index: null,
      last: null,
      changePct: null,
      quoteVolume: null,
    };
    prev.last = num(row.lastPrice);
    prev.changePct = num(row.priceChangePercent);
    prev.quoteVolume = num(row.quoteVolume);
    quotes.set(symbol, prev);
  }

  if (symbols.length === 0) throw new Error("币安没有返回交易中的 USDT 永续合约");
  return { symbols, quotes };
}

export async function loadDerivatives(signal?: AbortSignal): Promise<DerivativeTicker[]> {
  const url = `${COINGECKO}/derivatives/exchanges/binance_futures?include_tickers=unexpired`;
  const { status, data } = await fetchJson(url, signal, 30000);
  if (status === 429) throw new Error("CoinGecko 合约行情被限流");
  if (status !== 200 || !data || typeof data !== "object") {
    throw new Error(`CoinGecko 合约行情不可用（HTTP ${status}）`);
  }
  const tickers = (data as { tickers?: unknown }).tickers;
  if (!Array.isArray(tickers)) throw new Error("CoinGecko 合约行情结构无法识别");

  const bySymbol = new Map<string, DerivativeTicker>();
  for (const item of tickers) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const symbol = str(row.symbol);
    const base = str(row.base);
    if (!symbol || !base) continue;
    if (String(row.contract_type ?? "").toLowerCase() !== "perpetual") continue;
    if (String(row.target ?? "").toUpperCase() !== "USDT") continue;
    if (!symbol.endsWith("USDT")) continue;
    const next: DerivativeTicker = {
      symbol,
      base,
      coinId: str(row.coin_id),
      last: num(row.last),
      index: num(row.index),
      changePct: num(row.h24_percentage_change),
      oiUsd: num(row.open_interest_usd),
    };
    const prev = bySymbol.get(symbol);
    if (!prev || (next.oiUsd ?? -1) > (prev.oiUsd ?? -1)) bySymbol.set(symbol, next);
  }
  if (bySymbol.size === 0) throw new Error("CoinGecko 没有返回币安 USDT 永续合约");
  return [...bySymbol.values()];
}

let coinListCache: { at: number; map: Map<string, CoinMeta> } | null = null;
const COIN_LIST_TTL = 30 * 60 * 1000;

export async function loadCoinList(signal?: AbortSignal): Promise<Map<string, CoinMeta>> {
  if (coinListCache && Date.now() - coinListCache.at < COIN_LIST_TTL) return coinListCache.map;
  const { status, data } = await fetchJson(`${COINGECKO}/coins/list?include_platform=true`, signal, 40000);
  if (status === 429) throw new Error("CoinGecko 币种列表被限流");
  if (status !== 200 || !Array.isArray(data)) {
    throw new Error(`CoinGecko 币种列表不可用（HTTP ${status}）`);
  }
  const map = new Map<string, CoinMeta>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = str(row.id);
    const symbol = str(row.symbol);
    const name = str(row.name);
    if (!id || !symbol || !name) continue;
    const platforms: Record<string, string> = {};
    if (row.platforms && typeof row.platforms === "object" && !Array.isArray(row.platforms)) {
      for (const [key, value] of Object.entries(row.platforms as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) platforms[key] = value.trim();
      }
    }
    map.set(id, { id, symbol, name, platforms });
  }
  coinListCache = { at: Date.now(), map };
  return map;
}

const marketCache = new Map<string, { at: number; coin: MarketInfo | null }>();
const MARKET_TTL = 3 * 60 * 1000;

export function cachedMarket(id: string): { fresh: boolean; coin: MarketInfo | null } | null {
  const hit = marketCache.get(id);
  if (!hit) return null;
  return { fresh: Date.now() - hit.at < MARKET_TTL, coin: hit.coin };
}

export async function loadMarkets(ids: readonly string[], signal?: AbortSignal): Promise<MarketInfo[]> {
  if (ids.length === 0) return [];
  const missing: string[] = [];
  const fresh: MarketInfo[] = [];
  for (const id of ids) {
    const hit = cachedMarket(id);
    if (hit?.fresh) {
      if (hit.coin) fresh.push(hit.coin);
      continue;
    }
    missing.push(id);
  }
  const loaded: MarketInfo[] = [];
  for (const group of chunks(missing, 80)) {
    const query = group.map((id) => encodeURIComponent(id)).join(",");
    const url =
      `${COINGECKO}/coins/markets?vs_currency=usd&locale=zh&sparkline=false` +
      `&per_page=250&ids=${query}`;
    let response: { status: number; data: unknown };
    try {
      response = await fetchJson(url, signal, 30000);
    } catch (error) {
      if (isAbortError(error)) throw error;
      await delay(800, signal);
      response = await fetchJson(url, signal, 30000);
    }
    if (response.status === 429) {
      await delay(1500, signal);
      response = await fetchJson(url, signal, 30000);
    }
    const { status, data } = response;
    if (status === 429) {
      const error = new Error("部分合约的流通市值本轮没取到：CoinGecko 限流。已取到的会保留。");
      (error as Error & { rateLimited?: boolean }).rateLimited = true;
      throw error;
    }
    if (status !== 200 || !Array.isArray(data)) {
      throw new Error(`CoinGecko 市值接口不可用（HTTP ${status}）`);
    }
    const seen = new Set<string>();
    for (const item of data) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const id = str(row.id);
      const symbol = str(row.symbol);
      const name = str(row.name);
      if (!id || !symbol || !name) continue;
      const coin: MarketInfo = {
        id,
        symbol,
        name,
        marketCap: num(row.market_cap),
        circulatingSupply: num(row.circulating_supply),
      };
      marketCache.set(id, { at: Date.now(), coin });
      seen.add(id);
      loaded.push(coin);
    }
    for (const id of group) {
      if (!seen.has(id)) marketCache.set(id, { at: Date.now(), coin: null });
    }
  }
  return [...fresh, ...loaded];
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort);
  });
}

interface HistPoint {
  ts: number;
  notional: number;
}

export async function loadOpenInterest(symbol: string, signal?: AbortSignal): Promise<number | null> {
  const { status, data } = await fetchJson(
    `${FAPI}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`,
    signal,
    15000,
  );
  if (isRestricted(status, data)) return null;
  if (status !== 200 || !data || typeof data !== "object") return null;
  return num((data as { openInterest?: unknown }).openInterest);
}

export async function loadOpenInterestHist(
  symbol: string,
  signal?: AbortSignal,
): Promise<HistPoint[] | null> {
  const url =
    `${FAPI}/futures/data/openInterestHist?symbol=${encodeURIComponent(symbol)}` +
    `&period=1h&limit=30`;
  const { status, data } = await fetchJson(url, signal, 15000);
  if (isRestricted(status, data) || status !== 200 || !Array.isArray(data)) return null;
  const points: HistPoint[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const ts = num(row.timestamp);
    const notional = num(row.sumOpenInterestValue);
    if (ts == null || notional == null) continue;
    points.push({ ts, notional });
  }
  return points;
}

export function openInterestChange(points: HistPoint[]): { pct: number; detail: string } | null {
  if (points.length < 2) return null;
  const latest = points[points.length - 1];
  if (!latest) return null;
  const target = latest.ts - 24 * 60 * 60 * 1000;
  let best = points[0];
  if (!best) return null;
  for (const point of points) {
    if (Math.abs(point.ts - target) < Math.abs(best.ts - target)) best = point;
  }
  if (best.ts === latest.ts || best.notional === 0) return null;
  const hours = Math.abs(latest.ts - best.ts) / 3600000;
  const pct = ((latest.notional - best.notional) / best.notional) * 100;
  if (!Number.isFinite(pct)) return null;
  const rounded = Math.round(hours);
  const detail =
    hours >= 20 && hours <= 28
      ? `较约 ${rounded} 小时前的持仓额（Binance openInterestHist）`
      : `较约 ${rounded} 小时前的持仓额，窗口不是完整 24 小时`;
  return { pct, detail };
}

function parseFraction(value: unknown): number | null {
  const parsed = num(value);
  if (parsed == null || parsed < 0) return null;
  return parsed > 1 ? parsed / 100 : parsed;
}

export async function loadHolderStat(
  platform: string,
  address: string,
  signal?: AbortSignal,
): Promise<HolderStat> {
  const chain = SUPPORTED_CHAINS[platform];
  if (!chain) throw new Error("不支持的链");
  const contract = chain.kind === "evm" ? address.toLowerCase() : address;
  const url =
    chain.kind === "solana"
      ? `${GOPLUS}/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(contract)}`
      : `${GOPLUS}/api/v1/token_security/${chain.id}?contract_addresses=${encodeURIComponent(contract)}`;
  const { status, data } = await fetchJson(url, signal, 20000);
  if (status === 429) throw new Error("GoPlus 限流");
  if (status !== 200 || !data || typeof data !== "object") {
    throw new Error(`GoPlus HTTP ${status}`);
  }
  const body = data as { code?: unknown; message?: unknown; result?: unknown };
  if (body.code !== 1 || !body.result || typeof body.result !== "object") {
    throw new Error(str(body.message) ?? "GoPlus 未返回持仓");
  }
  const result = body.result as Record<string, unknown>;
  const entryKey = Object.keys(result).find((key) => key.toLowerCase() === contract.toLowerCase()) ?? contract;
  const entry = result[entryKey];
  if (!entry || typeof entry !== "object") throw new Error("GoPlus 未收录该合约");
  const token = entry as Record<string, unknown>;
  const holdersRaw = Array.isArray(token.holders) ? token.holders : [];
  const holders: { pct: number; tag: string }[] = [];
  for (const item of holdersRaw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const pct = parseFraction(row.percent);
    if (pct == null) continue;
    holders.push({ pct, tag: str(row.tag) ?? "" });
  }
  const top = holders.slice(0, 10);
  const top10 = top.length ? top.reduce((sum, item) => sum + item.pct, 0) : null;
  const top1 = top[0]?.pct ?? null;
  const tagged = top.filter((item) => item.tag && EXCHANGE_TAG.test(item.tag));
  const exchangePct = tagged.length ? tagged.reduce((sum, item) => sum + item.pct, 0) : 0;
  const topTag = top.find((item) => item.tag)?.tag ?? null;
  return {
    chainLabel: chain.label,
    holderCount: num(token.holder_count),
    top10Pct: top10,
    top1Pct: top1,
    exchangePct: tagged.length ? exchangePct : 0,
    topTag,
    address: contract,
  };
}

export async function loadHolderStats(
  jobs: { platform: string; address: string; key: string }[],
  signal?: AbortSignal,
): Promise<Map<string, HolderStat | Error>> {
  const pairs = await mapPool(jobs, 4, async (job) => {
    try {
      const stat = await loadHolderStat(job.platform, job.address, signal);
      return [job.key, stat] as [string, HolderStat | Error];
    } catch (error) {
      if (isAbortError(error)) throw error;
      const wrapped = error instanceof Error ? error : new Error("GoPlus 查询失败");
      return [job.key, wrapped] as [string, HolderStat | Error];
    }
  });
  return new Map<string, HolderStat | Error>(pairs);
}
