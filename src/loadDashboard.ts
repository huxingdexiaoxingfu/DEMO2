import {
  cachedMarket,
  chainLabel,
  isAbortError,
  loadBinance,
  loadCoinList,
  loadDerivatives,
  loadHolderStats,
  loadMarkets,
  loadOpenInterest,
  loadOpenInterestHist,
  openInterestChange,
  supportedChain,
  type BinanceBundle,
  type CoinMeta,
  type DerivativeTicker,
  type HolderStat,
} from "./api";
import { chunks, mapPool } from "./asyncPool";
import { mappingRejected, symbolCompatible } from "./symbols";
import type { BoardRow, CapCell, DashboardSnapshot, OiCell, OnchainCell, QuoteCell } from "./types";

const TOP_ONCHAIN = 40;
const TOP_OI_CONFIRM = 80;
const TOP_OI_CHANGE = 40;

const onchainCache = new Map<string, { at: number; stat: HolderStat }>();
const ONCHAIN_TTL = 10 * 60 * 1000;

export interface LoadOptions {
  signal?: AbortSignal;
  onUpdate?: (snapshot: DashboardSnapshot) => void;
}

function emptyOi(detail: string, source: OiCell["source"]): OiCell {
  return {
    contracts: null,
    contractsEstimated: false,
    notional: null,
    notionalUnit: null,
    changePct: null,
    source,
    changeDetail: detail,
  };
}

function noMatchCap(detail: string): CapCell {
  return { status: "no-match", marketCap: null, circulatingSupply: null, coinName: null, detail };
}

function pendingCap(): CapCell {
  return {
    status: "pending",
    marketCap: null,
    circulatingSupply: null,
    coinName: null,
    detail: "正在向 CoinGecko 查询流通市值。",
  };
}

function emptyChain(detail: string): OnchainCell {
  return {
    status: "empty",
    chainLabel: null,
    holderCount: null,
    top10Pct: null,
    top1Pct: null,
    exchangePct: null,
    topTag: null,
    detail,
  };
}

function pendingChain(): OnchainCell {
  return {
    status: "pending",
    chainLabel: null,
    holderCount: null,
    top10Pct: null,
    top1Pct: null,
    exchangePct: null,
    topTag: null,
    detail: "正在向 GoPlus 查询持币集中度。",
  };
}

function sortByNotional(rows: BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => {
    const av = a.oi.notional;
    const bv = b.oi.notional;
    if (av == null && bv == null) return a.symbol.localeCompare(b.symbol);
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
}

function fromCoinGecko(ticker: DerivativeTicker, binanceBlocked: boolean): { quote: QuoteCell; oi: OiCell } {
  const last = ticker.last;
  const notional = ticker.oiUsd;
  const canDivide = last != null && last > 0 && notional != null;
  return {
    quote: {
      markPrice: null,
      lastPrice: last,
      indexPrice: ticker.index,
      changePct: ticker.changePct,
      source: "coingecko",
    },
    oi: {
      contracts: canDivide ? notional / last : null,
      contractsEstimated: canDivide,
      notional,
      notionalUnit: notional == null ? null : "USD",
      changePct: null,
      source: notional == null ? null : "coingecko",
      changeDetail: binanceBlocked
        ? "没有 24 小时持仓变化。CoinGecko 不提供，币安 fapi 当前也不可用。"
        : "24 小时持仓变化只查询持仓额前 40 名。",
    },
  };
}

function buildRows(binance: BinanceBundle | null, tickers: DerivativeTicker[] | null): BoardRow[] {
  const cg = new Map((tickers ?? []).map((ticker) => [ticker.symbol, ticker]));
  const blocked = binance == null;
  const universe = binance
    ? binance.symbols
    : (tickers ?? []).map((ticker) => ({ symbol: ticker.symbol, base: ticker.base }));

  return universe.map((item) => {
    const ticker = cg.get(item.symbol) ?? null;
    const quoteSrc = binance?.quotes.get(item.symbol);
    const cgParts = ticker ? fromCoinGecko(ticker, blocked) : null;
    const hasBinancePrice =
      quoteSrc != null && (quoteSrc.mark != null || quoteSrc.last != null || quoteSrc.changePct != null);
    const quote: QuoteCell = hasBinancePrice
      ? {
          markPrice: quoteSrc?.mark ?? null,
          lastPrice: quoteSrc?.last ?? cgParts?.quote.lastPrice ?? null,
          indexPrice: quoteSrc?.index ?? cgParts?.quote.indexPrice ?? null,
          changePct: quoteSrc?.changePct ?? cgParts?.quote.changePct ?? null,
          source: "binance",
        }
      : (cgParts?.quote ?? {
          markPrice: null,
          lastPrice: null,
          indexPrice: null,
          changePct: null,
          source: "coingecko",
        });
    const oi = cgParts?.oi ?? emptyOi(blocked ? "没有持仓数据。" : "等待币安持仓。", null);
    const coinId = ticker?.coinId ?? null;
    return {
      symbol: item.symbol,
      base: item.base,
      coinId,
      quote,
      oi,
      cap: coinId ? pendingCap() : noMatchCap("无匹配。CoinGecko 没有把这个合约对应到币种。"),
      onchain: emptyChain(coinId ? "正在确认币种映射，随后查询链上持仓。" : "没有可靠的币种映射，无法定位链上合约。"),
    };
  });
}

async function confirmBinanceOpenInterest(
  rows: BoardRow[],
  volumes: Map<string, number>,
  signal?: AbortSignal,
): Promise<{ rows: BoardRow[]; confirmed: Set<string> }> {
  const ranked = [...rows].sort((a, b) => {
    const av = a.oi.notional ?? volumes.get(a.symbol) ?? 0;
    const bv = b.oi.notional ?? volumes.get(b.symbol) ?? 0;
    return bv - av;
  });
  const picked = ranked.slice(0, TOP_OI_CONFIRM);
  const confirmed = new Set<string>();
  const values = await mapPool(picked, 6, async (row) => {
    try {
      const contracts = await loadOpenInterest(row.symbol, signal);
      return { symbol: row.symbol, contracts };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { symbol: row.symbol, contracts: null };
    }
  });
  const bySymbol = new Map(values.map((item) => [item.symbol, item.contracts]));
  const next = rows.map((row) => {
    if (!bySymbol.has(row.symbol)) return row;
    const contracts = bySymbol.get(row.symbol);
    if (contracts == null) return row;
    const mark = row.quote.markPrice;
    const notional = mark != null ? contracts * mark : null;
    confirmed.add(row.symbol);
    return {
      ...row,
      oi: {
        contracts,
        contractsEstimated: false,
        notional: notional ?? row.oi.notional,
        notionalUnit: notional != null ? "USDT" : row.oi.notionalUnit,
        changePct: null,
        source: "binance" as const,
        changeDetail: "正在读取持仓变化。",
      },
    };
  });
  return { rows: next, confirmed };
}

async function attachOpenInterestChange(rows: BoardRow[], signal?: AbortSignal): Promise<BoardRow[]> {
  const ranked = sortByNotional(rows);
  const targets = new Set(
    ranked.filter((row) => row.oi.source === "binance").slice(0, TOP_OI_CHANGE).map((row) => row.symbol),
  );
  const changes = await mapPool([...targets], 4, async (symbol) => {
    try {
      const points = await loadOpenInterestHist(symbol, signal);
      return { symbol, change: points ? openInterestChange(points) : null };
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { symbol, change: null };
    }
  });
  const bySymbol = new Map(changes.map((item) => [item.symbol, item.change]));
  return rows.map((row) => {
    if (!targets.has(row.symbol)) {
      if (row.oi.source === "binance") {
        return {
          ...row,
          oi: { ...row.oi, changeDetail: "只为持仓额前 40 名请求币安持仓历史。" },
        };
      }
      return row;
    }
    const change = bySymbol.get(row.symbol);
    if (!change) {
      return {
        ...row,
        oi: { ...row.oi, changePct: null, changeDetail: "币安没有返回该合约的持仓历史。" },
      };
    }
    return {
      ...row,
      oi: { ...row.oi, changePct: change.pct, changeDetail: change.detail },
    };
  });
}

function applyMarketCaps(rows: BoardRow[], list: Map<string, CoinMeta> | null, rateLimited: boolean): BoardRow[] {
  return rows.map((row) => {
    if (!row.coinId) return row;
    const meta = list?.get(row.coinId) ?? null;
    const cached = cachedMarket(row.coinId);
    const market = cached?.coin ?? null;
    const symbol = meta?.symbol ?? market?.symbol ?? null;
    const name = market?.name ?? meta?.name ?? null;
    if (symbol && !symbolCompatible(row.base, symbol)) {
      return {
        ...row,
        cap: {
          status: "rejected",
          marketCap: null,
          circulatingSupply: null,
          coinName: null,
          detail: `未采用。CoinGecko 把 ${row.symbol} 映射到「${name ?? row.coinId}」，符号和合约标的对不上。`,
        },
      };
    }
    if (!cached) {
      return {
        ...row,
        cap: rateLimited
          ? {
              status: "error",
              marketCap: null,
              circulatingSupply: null,
              coinName: null,
              detail: "本轮没有取到流通市值（CoinGecko 限流或失败）。",
            }
          : pendingCap(),
      };
    }
    if (!market || (market.marketCap == null && market.circulatingSupply == null)) {
      return {
        ...row,
        cap: {
          status: "missing",
          marketCap: null,
          circulatingSupply: null,
          coinName: name,
          detail: name
            ? `已匹配到「${name}」，但 CoinGecko 没有返回流通市值或流通量。`
            : "CoinGecko 没有返回这个币种的流通市值。",
        },
      };
    }
    if (mappingRejected(row.oi.notional, market.marketCap)) {
      return {
        ...row,
        cap: {
          status: "rejected",
          marketCap: null,
          circulatingSupply: null,
          coinName: null,
          detail: `未采用。CoinGecko 把 ${row.symbol} 映射到「${name ?? row.coinId}」，流通市值和合约持仓额差异过大。`,
        },
      };
    }
    return {
      ...row,
      cap: {
        status: "ok",
        marketCap: market.marketCap,
        circulatingSupply: market.circulatingSupply,
        coinName: name,
        detail: name ? `${name} · CoinGecko` : "CoinGecko",
      },
    };
  });
}

function holderKey(platform: string, address: string): string {
  return `${platform}:${address}`;
}

function onchainFromStat(stat: HolderStat): OnchainCell {
  if (stat.top10Pct == null && stat.holderCount == null) {
    return emptyChain(`${stat.chainLabel} 合约已找到，但 GoPlus 没有返回持币明细。`);
  }
  const tagNote =
    stat.exchangePct && stat.exchangePct > 0
      ? "前 10 名里带交易所标签的地址已单独标出。"
      : "前 10 名地址没有交易所标签，所以不估算交易所持仓。";
  return {
    status: "ok",
    chainLabel: stat.chainLabel,
    holderCount: stat.holderCount,
    top10Pct: stat.top10Pct,
    top1Pct: stat.top1Pct,
    exchangePct: stat.exchangePct,
    topTag: stat.topTag,
    detail: `${stat.chainLabel} ${stat.address} · GoPlus。${tagNote} 这是该链合约的持币集中度，不是币安账户持仓。`,
  };
}

function planOnchain(rows: BoardRow[], list: Map<string, CoinMeta> | null, listFailed: boolean): BoardRow[] {
  const top = new Set(sortByNotional(rows).slice(0, TOP_ONCHAIN).map((row) => row.symbol));
  return rows.map((row) => {
    if (!top.has(row.symbol)) {
      return { ...row, onchain: emptyChain("只查询持仓额前 40 名的链上数据，避免打满免费接口。") };
    }
    if (row.cap.status === "rejected") {
      return { ...row, onchain: emptyChain("币种映射不可靠，没有查询链上持仓。") };
    }
    if (!row.coinId || row.cap.status === "no-match") {
      return { ...row, onchain: emptyChain("没有可靠的币种映射，无法定位链上合约。") };
    }
    if (listFailed || !list) {
      return { ...row, onchain: emptyChain("币种合约地址表没有加载成功，链上持仓留空。") };
    }
    const meta = list.get(row.coinId);
    if (!meta) {
      return { ...row, onchain: emptyChain("CoinGecko 币种列表里没有这个 id，无法定位合约。") };
    }
    if (!symbolCompatible(row.base, meta.symbol)) {
      return { ...row, onchain: emptyChain("币种符号和合约标的对不上，没有查询链上持仓。") };
    }
    const entries = Object.entries(meta.platforms).filter(([, address]) => address.trim());
    const first = entries[0];
    if (!first) {
      return {
        ...row,
        onchain: emptyChain("原生资产或未登记代币合约。GoPlus 免费接口统计不了持币集中度。"),
      };
    }
    const [platform, address] = first;
    if (!supportedChain(platform)) {
      return {
        ...row,
        onchain: emptyChain(
          `主链是 ${chainLabel(platform)}，GoPlus 免费接口没有覆盖。没有改用其他链上的桥接合约。`,
        ),
      };
    }
    const cached = onchainCache.get(holderKey(platform, address));
    if (cached && Date.now() - cached.at < ONCHAIN_TTL) {
      return { ...row, onchain: onchainFromStat(cached.stat) };
    }
    return { ...row, onchain: pendingChain() };
  });
}

async function fetchOnchain(rows: BoardRow[], list: Map<string, CoinMeta>, signal?: AbortSignal): Promise<BoardRow[]> {
  const jobs: { platform: string; address: string; key: string; symbols: string[] }[] = [];
  const jobByKey = new Map<string, { platform: string; address: string; key: string; symbols: string[] }>();
  for (const row of rows) {
    if (row.onchain.status !== "pending" || !row.coinId) continue;
    const meta = list.get(row.coinId);
    const first = meta ? Object.entries(meta.platforms).find(([, address]) => address.trim()) : undefined;
    if (!first) continue;
    const [platform, address] = first;
    const key = holderKey(platform, address);
    const existing = jobByKey.get(key);
    if (existing) {
      existing.symbols.push(row.symbol);
      continue;
    }
    const job = { platform, address, key, symbols: [row.symbol] };
    jobByKey.set(key, job);
    jobs.push(job);
  }
  if (jobs.length === 0) return rows;
  const stats = await loadHolderStats(jobs, signal);
  const bySymbol = new Map<string, OnchainCell>();
  for (const job of jobs) {
    const stat = stats.get(job.key);
    let cell: OnchainCell;
    if (stat instanceof Error) {
      cell = {
        status: "error",
        chainLabel: chainLabel(job.platform),
        holderCount: null,
        top10Pct: null,
        top1Pct: null,
        exchangePct: null,
        topTag: null,
        detail: `GoPlus 查询失败（${stat.message}）。没有填入持仓数字。`,
      };
    } else if (!stat) {
      cell = emptyChain("GoPlus 没有返回该合约。");
    } else {
      onchainCache.set(job.key, { at: Date.now(), stat });
      cell = onchainFromStat(stat);
    }
    for (const symbol of job.symbols) bySymbol.set(symbol, cell);
  }
  return rows.map((row) => {
    const cell = bySymbol.get(row.symbol);
    return cell ? { ...row, onchain: cell } : row;
  });
}

export async function loadDashboard(options: LoadOptions = {}): Promise<DashboardSnapshot> {
  const { signal, onUpdate } = options;
  const warnings: string[] = [];
  let binance: BinanceBundle | null = null;
  let tickers: DerivativeTicker[] | null = null;
  let list: Map<string, CoinMeta> | null = null;
  let listFailed = false;

  const [binanceResult, tickerResult, listResult] = await Promise.allSettled([
    loadBinance(signal),
    loadDerivatives(signal),
    loadCoinList(signal),
  ]);

  if (signal?.aborted) throw new DOMException("aborted", "AbortError");

  if (binanceResult.status === "fulfilled") {
    binance = binanceResult.value;
  } else if (isAbortError(binanceResult.reason)) {
    throw binanceResult.reason;
  } else {
    warnings.push(
      `币安接口失败：${binanceResult.reason instanceof Error ? binanceResult.reason.message : "未知错误"}`,
    );
  }

  if (tickerResult.status === "fulfilled") tickers = tickerResult.value;
  else if (isAbortError(tickerResult.reason)) throw tickerResult.reason;
  else {
    warnings.push(
      `CoinGecko 合约行情失败：${tickerResult.reason instanceof Error ? tickerResult.reason.message : "未知错误"}`,
    );
  }

  if (listResult.status === "fulfilled") list = listResult.value;
  else if (isAbortError(listResult.reason)) throw listResult.reason;
  else {
    listFailed = true;
    warnings.push(
      `CoinGecko 币种列表失败：${listResult.reason instanceof Error ? listResult.reason.message : "未知错误"}`,
    );
  }

  if (!binance && !tickers) {
    throw new Error("币安 fapi 和 CoinGecko 合约行情都不可用，看板没有可显示的数据。");
  }

  let rows = buildRows(binance, tickers);
  const volumes = new Map<string, number>();
  if (binance) {
    for (const [symbol, quote] of binance.quotes) {
      if (quote.quoteVolume != null) volumes.set(symbol, quote.quoteVolume);
    }
    const confirmed = await confirmBinanceOpenInterest(rows, volumes, signal);
    rows = confirmed.rows;
    if (confirmed.confirmed.size === 0) {
      warnings.push("币安持仓接口没有返回数量，持仓额保留 CoinGecko 的数值。");
    }
    rows = await attachOpenInterestChange(rows, signal);
  }

  rows = sortByNotional(rows);
  const binanceOk = binance != null;
  const coingeckoOk = tickers != null;

  const publish = (current: BoardRow[], refreshing: boolean): DashboardSnapshot => {
    const snapshot: DashboardSnapshot = {
      rows: sortByNotional(current),
      updatedAt: refreshing ? null : Date.now(),
      refreshing,
      binanceOk,
      coingeckoOk,
      warnings: [...warnings],
    };
    onUpdate?.(snapshot);
    return snapshot;
  };

  rows = applyMarketCaps(rows, list, false);
  publish(rows, true);

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of sortByNotional(rows)) {
    if (!row.coinId || seen.has(row.coinId)) continue;
    const meta = list?.get(row.coinId);
    if (meta && !symbolCompatible(row.base, meta.symbol)) continue;
    const hit = cachedMarket(row.coinId);
    if (hit?.fresh) continue;
    seen.add(row.coinId);
    ids.push(row.coinId);
  }

  let marketsFailed = false;
  for (const group of chunks(ids, 80)) {
    try {
      await loadMarkets(group, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      marketsFailed = true;
      warnings.push("部分合约的流通市值本轮没有取到，已经取到的会保留。");
      break;
    }
    rows = applyMarketCaps(rows, list, false);
    publish(rows, true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
  }
  rows = applyMarketCaps(rows, list, marketsFailed);
  rows = planOnchain(rows, list, listFailed);
  publish(rows, true);

  if (list) {
    rows = await fetchOnchain(rows, list, signal);
  }

  return publish(rows, false);
}
