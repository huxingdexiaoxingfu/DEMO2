export type PriceSource = "binance" | "coingecko";

export type OiSource = "binance" | "coingecko";

export interface QuoteCell {
  markPrice: number | null;
  lastPrice: number | null;
  indexPrice: number | null;
  changePct: number | null;
  source: PriceSource;
}

export interface OiCell {
  contracts: number | null;
  /** True when contracts were derived as notional / price, not returned by the exchange. */
  contractsEstimated: boolean;
  notional: number | null;
  /** "USDT" when the notional comes from Binance mark price; "USD" for CoinGecko. */
  notionalUnit: "USDT" | "USD" | null;
  changePct: number | null;
  source: OiSource | null;
  changeDetail: string;
}

export type CapStatus = "ok" | "no-match" | "rejected" | "missing" | "pending" | "error";

export interface CapCell {
  status: CapStatus;
  marketCap: number | null;
  circulatingSupply: number | null;
  coinName: string | null;
  detail: string;
}

export type OnchainStatus = "ok" | "empty" | "pending" | "error";

export interface OnchainCell {
  status: OnchainStatus;
  chainLabel: string | null;
  holderCount: number | null;
  /** Fraction, 0.1 means 10%. */
  top10Pct: number | null;
  top1Pct: number | null;
  /** Share of the top 10 holders whose tag names an exchange. Fraction. */
  exchangePct: number | null;
  topTag: string | null;
  detail: string;
}

export interface BoardRow {
  symbol: string;
  base: string;
  coinId: string | null;
  quote: QuoteCell;
  oi: OiCell;
  cap: CapCell;
  onchain: OnchainCell;
}

export interface DashboardSnapshot {
  rows: BoardRow[];
  /** Completion time of the latest refresh. Null while the first paint is still in progress. */
  updatedAt: number | null;
  refreshing: boolean;
  binanceOk: boolean;
  coingeckoOk: boolean;
  warnings: string[];
}
