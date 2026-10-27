import { useEffect, useMemo, useState } from "react";
import { formatCompact, formatFractionPct, formatFull, formatPct, formatPrice, formatQty, formatShanghai, pctClass } from "./format";
import { loadDashboard } from "./loadDashboard";
import type { BoardRow, CapCell, DashboardSnapshot, OiCell, OnchainCell, QuoteCell } from "./types";

type SortKey =
  | "symbol"
  | "price"
  | "change"
  | "contracts"
  | "notional"
  | "oiChange"
  | "supply"
  | "marketCap"
  | "top10";

const TOP_N = 40;
const REFRESH_MS = 60_000;

const SORT_LABELS: Record<SortKey, string> = {
  symbol: "合约",
  price: "价格",
  change: "24 小时涨跌",
  contracts: "持仓量",
  notional: "持仓额",
  oiChange: "持仓变化",
  supply: "流通量",
  marketCap: "流通市值",
  top10: "前 10 持仓占比",
};

function priceValue(quote: QuoteCell): number | null {
  return quote.markPrice ?? quote.lastPrice ?? quote.indexPrice;
}

function sortValue(row: BoardRow, key: SortKey): number | string | null {
  switch (key) {
    case "symbol":
      return row.symbol;
    case "price":
      return priceValue(row.quote);
    case "change":
      return row.quote.changePct;
    case "contracts":
      return row.oi.contracts;
    case "notional":
      return row.oi.notional;
    case "oiChange":
      return row.oi.changePct;
    case "supply":
      return row.cap.status === "ok" ? row.cap.circulatingSupply : null;
    case "marketCap":
      return row.cap.status === "ok" ? row.cap.marketCap : null;
    case "top10":
      return row.onchain.status === "ok" ? row.onchain.top10Pct : null;
  }
}

function compareRows(a: BoardRow, b: BoardRow, key: SortKey, dir: 1 | -1): number {
  const av = sortValue(a, key);
  const bv = sortValue(b, key);
  const aEmpty = av == null || av === "";
  const bEmpty = bv == null || bv === "";
  if (aEmpty && bEmpty) return a.symbol.localeCompare(b.symbol);
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
  return String(av).localeCompare(String(bv), "zh") * dir;
}

function matches(row: BoardRow, query: string): boolean {
  if (!query) return true;
  const name = row.cap.coinName ?? "";
  return `${row.symbol} ${row.base} ${name} ${row.coinId ?? ""}`.toLowerCase().includes(query.toLowerCase());
}

function EmptyNote({ children }: { children: string }) {
  return <p className="empty">{children}</p>;
}

function QuoteBlock({ quote, binanceOk }: { quote: QuoteCell; binanceOk: boolean }) {
  const price = priceValue(quote);
  if (price == null && quote.changePct == null) {
    return <EmptyNote>没有价格。币安和 CoinGecko 都没返回这个合约的行情。</EmptyNote>;
  }
  const label = quote.markPrice != null ? "标记价" : quote.lastPrice != null ? "最新价" : "指数价";
  const source = quote.source === "binance" ? "Binance" : "CoinGecko";
  return (
    <div className="stack">
      {price != null && (
        <strong title={formatFull(price)}>
          {formatPrice(price)}
        </strong>
      )}
      <span className="sub">
        {label} · {source}
      </span>
      {quote.markPrice == null && quote.indexPrice != null && quote.lastPrice != null && (
        <span className="sub" title={formatFull(quote.indexPrice)}>
          指数价 {formatPrice(quote.indexPrice)}
        </span>
      )}
      {quote.changePct != null ? (
        <span className={pctClass(quote.changePct)}>24h {formatPct(quote.changePct)}</span>
      ) : (
        <span className="sub">24h 涨跌未返回</span>
      )}
      {quote.markPrice == null && binanceOk && <span className="sub">这个合约没有标记价。</span>}
    </div>
  );
}

function OiBlock({ oi }: { oi: OiCell }) {
  return (
    <div className="stack">
      {oi.contracts != null ? (
        <strong title={formatFull(oi.contracts)}>{formatQty(oi.contracts)}</strong>
      ) : (
        <EmptyNote>
          {oi.notional != null ? "缺少价格，无法把持仓额换算成数量。" : "没有持仓量。"}
        </EmptyNote>
      )}
      {oi.contracts != null && (
        <span className="sub">
          {oi.contractsEstimated ? "按持仓额 ÷ 价格估算" : "币安 openInterest"}
          {oi.source === "binance" ? " · 基础资产数量" : ""}
        </span>
      )}
    </div>
  );
}

function NotionalBlock({ oi }: { oi: OiCell }) {
  if (oi.notional == null || oi.notionalUnit == null) {
    return <EmptyNote>没有持仓额。</EmptyNote>;
  }
  const source = oi.source === "binance" ? "Binance" : "CoinGecko";
  return (
    <div className="stack">
      <strong title={`${formatFull(oi.notional)} ${oi.notionalUnit}`}>{formatCompact(oi.notional)}</strong>
      <span className="sub">
        {oi.notionalUnit} · {source}
      </span>
    </div>
  );
}

function ChangeBlock({ oi }: { oi: OiCell }) {
  if (oi.changePct == null) return <EmptyNote>{oi.changeDetail}</EmptyNote>;
  return (
    <div className="stack">
      <strong className={pctClass(oi.changePct)}>{formatPct(oi.changePct)}</strong>
      <span className="sub">{oi.changeDetail}</span>
    </div>
  );
}

const CAP_SHORT: Record<CapCell["status"], string> = {
  ok: "",
  "no-match": "无匹配",
  rejected: "映射未采用",
  missing: "未返回",
  pending: "查询中",
  error: "本轮未取到",
};

function SupplyBlock({ cap }: { cap: CapCell }) {
  if (cap.status !== "ok") return <EmptyNote>{CAP_SHORT[cap.status]}</EmptyNote>;
  if (cap.circulatingSupply == null) return <EmptyNote>CoinGecko 没有返回流通量。</EmptyNote>;
  return (
    <div className="stack">
      <strong title={formatFull(cap.circulatingSupply)}>{formatCompact(cap.circulatingSupply)}</strong>
      <span className="sub">CoinGecko</span>
    </div>
  );
}

function CapBlock({ cap }: { cap: CapCell }) {
  if (cap.status !== "ok") return <EmptyNote>{cap.detail}</EmptyNote>;
  if (cap.marketCap == null) return <EmptyNote>CoinGecko 没有返回流通市值。</EmptyNote>;
  return (
    <div className="stack">
      <strong title={`${formatFull(cap.marketCap)} USD`}>{formatCompact(cap.marketCap)}</strong>
      <span className="sub">USD · {cap.coinName ?? "CoinGecko"}</span>
    </div>
  );
}

function ChainBlock({ cell }: { cell: OnchainCell }) {
  if (cell.status !== "ok") return <EmptyNote>{cell.detail}</EmptyNote>;
  return (
    <div className="stack" title={cell.detail}>
      {cell.top10Pct != null ? (
        <strong>{formatFractionPct(cell.top10Pct)}</strong>
      ) : (
        <span className="sub">前 10 占比未返回</span>
      )}
      <span className="sub">{cell.chainLabel} · 前 10 地址 · GoPlus</span>
      {cell.top1Pct != null && (
        <span className="sub">
          最大地址 {formatFractionPct(cell.top1Pct)}
          {cell.topTag ? ` · ${cell.topTag}` : ""}
        </span>
      )}
      {cell.holderCount != null && <span className="sub">持币地址 {formatCompact(cell.holderCount)}</span>}
      {cell.exchangePct != null && cell.exchangePct > 0 ? (
        <span className="sub">前 10 中交易所标签 {formatFractionPct(cell.exchangePct)}</span>
      ) : (
        <span className="sub">前 10 无交易所标签</span>
      )}
    </div>
  );
}

function useDesktopLayout(): boolean {
  const [desktop, setDesktop] = useState(() => window.matchMedia("(min-width: 981px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 981px)");
    const apply = () => setDesktop(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);
  return desktop;
}

function App() {
  const desktop = useDesktopLayout();
  const [sourcesOpen, setSourcesOpen] = useState(desktop);
  useEffect(() => {
    setSourcesOpen(desktop);
  }, [desktop]);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("notional");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [now, setNow] = useState(() => Date.now());
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let stopped = false;
    let running = false;
    const current = { controller: new AbortController() };

    const run = () => {
      if (stopped || running) return;
      running = true;
      current.controller.abort();
      current.controller = new AbortController();
      const signal = current.controller.signal;
      setError(null);
      void loadDashboard({
        signal,
        onUpdate: (next) => {
          if (stopped || signal.aborted) return;
          setSnapshot((prev) => ({
            ...next,
            updatedAt: next.updatedAt ?? prev?.updatedAt ?? null,
          }));
          setLoading(false);
        },
      })
        .catch((reason: unknown) => {
          if (stopped || signal.aborted) return;
          const message = reason instanceof Error ? reason.message : "加载失败";
          setError(message);
          setLoading(false);
        })
        .finally(() => {
          if (current.controller.signal === signal) running = false;
        });
    };

    run();
    const interval = window.setInterval(run, REFRESH_MS);
    return () => {
      stopped = true;
      current.controller.abort();
      window.clearInterval(interval);
    };
  }, [reloadKey]);

  const rows = snapshot?.rows ?? [];
  const visible = useMemo(() => {
    const filtered = rows.filter((row) => matches(row, query.trim()));
    const sorted = [...filtered].sort((a, b) => compareRows(a, b, sortKey, sortDir));
    if (showAll || query.trim()) return sorted;
    return sorted.slice(0, TOP_N);
  }, [rows, query, showAll, sortKey, sortDir]);

  const matchedCount = useMemo(
    () => rows.filter((row) => matches(row, query.trim())).length,
    [rows, query],
  );

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((dir) => (dir === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === "symbol" ? 1 : -1);
    }
  }

  const remainMs = snapshot?.updatedAt ? snapshot.updatedAt + REFRESH_MS - now : null;
  const remainSec = remainMs == null ? null : Math.max(0, Math.ceil(remainMs / 1000));

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">USDT-M 永续 · 只读公开数据</p>
          <h1>币安合约看板</h1>
          <p className="lede">
            三列分开看：合约持仓、流通市值和链上持币集中度。对不上的格子留空，不补数字。不能下单，也不使用 API 密钥。
          </p>
        </div>
        <div className="status-card">
          <p>
            上次更新（北京时间）
            <strong>{snapshot?.updatedAt ? formatShanghai(snapshot.updatedAt) : "尚未完成"}</strong>
          </p>
          <p>
            {snapshot?.refreshing
              ? "正在补充流通市值和链上数据"
              : remainSec == null
                ? "等待数据"
                : `${remainSec} 秒后自动刷新`}
          </p>
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            立即刷新
          </button>
        </div>
      </header>

      <details
        className="source-details"
        open={sourcesOpen}
        onToggle={(event) => setSourcesOpen(event.currentTarget.open)}
      >
        <summary>查看四列数据来源</summary>
        <section className="sources" aria-label="数据来源">
        <article>
          <h2>合约持仓</h2>
          <p>持仓量、持仓额、标记价、24 小时涨跌：Binance fapi。持仓 24 小时变化：Binance openInterestHist。</p>
        </article>
        <article>
          <h2>备用行情</h2>
          <p>fapi 不可用时，持仓额和最新价改用 CoinGecko 的 binance_futures 行情。标记价和持仓变化留空。</p>
        </article>
        <article>
          <h2>流通市值</h2>
          <p>CoinGecko coins/markets 的流通量和美元流通市值。没有唯一映射就不显示数字。</p>
        </article>
        <article>
          <h2>链上持仓</h2>
          <p>GoPlus 免费接口的主链前 10 地址占比。不是币安所内持仓。没有免密钥来源就写明原因。</p>
        </article>
        </section>
      </details>

      {snapshot && !snapshot.binanceOk && (
        <p className="banner">
          当前网络访问不了币安 fapi。持仓额、最新价和 24 小时涨跌来自 CoinGecko 收录的币安 USDT 永续。持仓量按持仓额除以价格估算。标记价和持仓 24 小时变化留空。
        </p>
      )}
      {snapshot?.warnings.map((warning) => (
        <p className="banner" key={warning}>
          {warning}
        </p>
      ))}
      {error && <p className="banner danger">{error}</p>}

      <div className="toolbar">
        <label>
          搜索
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="合约或币种，例如 BTC、1000PEPE"
          />
        </label>
        <p className="count">
          {loading && !snapshot
            ? "正在读取公开行情…"
            : query.trim()
              ? `匹配 ${matchedCount} 个合约`
              : showAll
                ? `全部 ${rows.length} 个 USDT 永续`
                : `按${SORT_LABELS[sortKey]}显示前 ${Math.min(TOP_N, visible.length)} 个，共 ${rows.length} 个`}
        </p>
        <button type="button" className="ghost" onClick={() => setShowAll((value) => !value)} disabled={Boolean(query.trim())}>
          {showAll ? "只看前 40" : "显示全部"}
        </button>
      </div>

      {loading && !snapshot ? (
        <p className="loading">正在连接 CoinGecko 和币安公开接口。</p>
      ) : visible.length === 0 ? (
        <p className="loading">没有匹配的合约。</p>
      ) : (
        <>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <SortHeader label="合约" source="Binance / CoinGecko" active={sortKey === "symbol"} dir={sortDir} onClick={() => toggleSort("symbol")} />
                  <SortHeader label="价格" source="Binance 标记价，否则最新价" active={sortKey === "price"} dir={sortDir} onClick={() => toggleSort("price")} />
                  <SortHeader label="持仓量" source="Binance，或按价格估算" active={sortKey === "contracts"} dir={sortDir} onClick={() => toggleSort("contracts")} />
                  <SortHeader label="持仓额" source="USDT 或 USD" active={sortKey === "notional"} dir={sortDir} onClick={() => toggleSort("notional")} />
                  <SortHeader label="持仓 24h" source="Binance 持仓历史" active={sortKey === "oiChange"} dir={sortDir} onClick={() => toggleSort("oiChange")} />
                  <SortHeader label="流通量" source="CoinGecko" active={sortKey === "supply"} dir={sortDir} onClick={() => toggleSort("supply")} />
                  <SortHeader label="流通市值" source="USD · CoinGecko" active={sortKey === "marketCap"} dir={sortDir} onClick={() => toggleSort("marketCap")} />
                  <SortHeader label="链上持仓" source="GoPlus 前 10 地址" active={sortKey === "top10"} dir={sortDir} onClick={() => toggleSort("top10")} />
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr key={row.symbol} data-symbol={row.symbol}>
                    <td data-label="合约">
                      <div className="stack">
                        <strong>{row.symbol}</strong>
                        <span className="sub">{row.cap.status === "ok" && row.cap.coinName ? row.cap.coinName : row.base}</span>
                      </div>
                    </td>
                    <td data-label="价格">
                      <QuoteBlock quote={row.quote} binanceOk={snapshot?.binanceOk ?? false} />
                    </td>
                    <td data-label="持仓量">
                      <OiBlock oi={row.oi} />
                    </td>
                    <td data-label="持仓额">
                      <NotionalBlock oi={row.oi} />
                    </td>
                    <td data-label="持仓 24h">
                      <ChangeBlock oi={row.oi} />
                    </td>
                    <td data-label="流通量">
                      <SupplyBlock cap={row.cap} />
                    </td>
                    <td data-label="流通市值">
                      <CapBlock cap={row.cap} />
                    </td>
                    <td data-label="链上持仓">
                      <ChainBlock cell={row.onchain} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="cards">
            {visible.map((row) => (
              <li key={row.symbol} data-symbol={row.symbol}>
                <header>
                  <strong>{row.symbol}</strong>
                  <span>{row.cap.status === "ok" && row.cap.coinName ? row.cap.coinName : row.base}</span>
                </header>
                <div>
                  <h3>价格</h3>
                  <QuoteBlock quote={row.quote} binanceOk={snapshot?.binanceOk ?? false} />
                </div>
                <div>
                  <h3>合约持仓</h3>
                  <OiBlock oi={row.oi} />
                  <NotionalBlock oi={row.oi} />
                  <ChangeBlock oi={row.oi} />
                </div>
                <div>
                  <h3>流通市值</h3>
                  <SupplyBlock cap={row.cap} />
                  <CapBlock cap={row.cap} />
                </div>
                <div>
                  <h3>链上持仓</h3>
                  <ChainBlock cell={row.onchain} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <footer>
        <p>北京时间使用 Asia/Shanghai。约每 60 秒刷新价格和持仓；流通市值缓存约 3 分钟，链上数据缓存约 10 分钟。</p>
        <p>接口：fapi.binance.com、api.coingecko.com、api.gopluslabs.io。全部是公开只读接口。</p>
      </footer>
    </div>
  );
}

function SortHeader({
  label,
  source,
  active,
  dir,
  onClick,
}: {
  label: string;
  source: string;
  active: boolean;
  dir: 1 | -1;
  onClick: () => void;
}) {
  return (
    <th aria-sort={active ? (dir === 1 ? "ascending" : "descending") : "none"}>
      <button type="button" onClick={onClick}>
        <span>{label}</span>
        <small>
          {source}
          {active ? (dir === 1 ? " ↑" : " ↓") : ""}
        </small>
      </button>
    </th>
  );
}

export default App;
