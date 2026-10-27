import { loadDashboard } from "../src/loadDashboard";
import { mappingRejected, symbolCompatible } from "../src/symbols";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(symbolCompatible("BTC", "btc"), "BTC 应对上 btc");
assert(symbolCompatible("1000PEPE", "pepe"), "1000PEPE 应对上 pepe");
assert(symbolCompatible("1000SATS", "1000sats"), "1000SATS 应对上 1000sats");
assert(symbolCompatible("1MBABYDOGE", "babydoge"), "1MBABYDOGE 应对上 babydoge");
assert(!symbolCompatible("PUMP", "pumpbtc"), "PUMP 不应对上 pumpbtc");
assert(mappingRejected(75_000_000, 1_200_000), "持仓额远大于过小市值时应拒绝映射");
assert(!mappingRejected(85_000_000, 1_800_000_000), "正常市值不应被拒绝");
assert(!mappingRejected(7_900_000_000, 1_600_000_000_000), "BTC 量级不应被拒绝");

const snapshot = await loadDashboard();
assert(snapshot.rows.length > 100, `合约数量太少：${snapshot.rows.length}`);
assert(snapshot.coingeckoOk || snapshot.binanceOk, "两个行情源都不可用");

const btcIndex = snapshot.rows.findIndex((row) => row.symbol === "BTCUSDT");
const btc = snapshot.rows[btcIndex];
assert(btc && btcIndex >= 0 && btcIndex < 5, "BTCUSDT 应排在持仓额前列");
assert(btc.oi.notional != null && btc.oi.notional > 1_000_000_000, "BTC 持仓额异常");
assert(btc.oi.contracts != null && btc.oi.contracts > 0, "BTC 持仓量缺失");
assert((btc.quote.markPrice ?? btc.quote.lastPrice ?? 0) > 1000, "BTC 价格异常");
assert(btc.cap.status === "ok" && (btc.cap.marketCap ?? 0) > 100_000_000_000, "BTC 流通市值缺失");
assert((btc.cap.circulatingSupply ?? 0) > 10_000_000, "BTC 流通量缺失");
assert(btc.onchain.status === "empty", "BTC 没有免费持仓集中度接口，不应填数字");
assert(btc.onchain.top10Pct == null, "BTC 链上占比不应有数字");

if (!snapshot.binanceOk) {
  assert(btc.quote.markPrice == null, "fapi 不可用时不应出现标记价");
  assert(btc.oi.changePct == null, "fapi 不可用时不应出现持仓 24h 变化");
  assert(btc.oi.contractsEstimated, "备用行情的持仓量应标明为估算");
  assert(btc.oi.notionalUnit === "USD", "CoinGecko 持仓额单位应为 USD");
} else {
  assert(btc.quote.markPrice != null && btc.quote.markPrice > 0, "币安可用时应有标记价");
  assert(btc.oi.source === "binance", "币安可用时 BTC 持仓应来自币安");
  assert(!btc.oi.contractsEstimated, "币安持仓量不应标成估算");
}

const xau = snapshot.rows.find((row) => row.symbol === "XAUUSDT");
if (xau) {
  assert(xau.cap.status === "no-match", "黄金合约不应填流通市值");
  assert(xau.cap.marketCap == null, "黄金合约市值应为空");
  assert(xau.onchain.status !== "ok", "黄金合约不应有链上持仓数字");
}

const pump = snapshot.rows.find((row) => row.symbol === "PUMPUSDT");
if (pump?.cap.status === "ok") {
  assert((pump.cap.marketCap ?? 0) > 100_000_000, "PUMP 若展示市值，不能是明显错配的小市值币");
}

for (const row of snapshot.rows) {
  if (row.cap.status !== "ok") {
    assert(row.cap.marketCap == null && row.cap.circulatingSupply == null, `${row.symbol} 非成功状态仍带市值数字`);
  }
  if (row.onchain.status !== "ok") {
    assert(row.onchain.top10Pct == null, `${row.symbol} 链上状态非成功但仍有占比`);
  }
}

const top = snapshot.rows.slice(0, 40);
const onchainOk = top.filter((row) => row.onchain.status === "ok");
assert(onchainOk.length > 0, "前 40 名里至少一个代币应有 GoPlus 持仓集中度");
for (const row of onchainOk) {
  assert(row.onchain.top10Pct == null || (row.onchain.top10Pct >= 0 && row.onchain.top10Pct < 1.5), `${row.symbol} 前 10 占比异常`);
}

console.log(`binance=${snapshot.binanceOk} coingecko=${snapshot.coingeckoOk} rows=${snapshot.rows.length} onchainOk=${onchainOk.length}`);
console.log("warnings:", snapshot.warnings.join(" | ") || "(none)");
console.log("symbol\toi\tunit\tprice\tchange\tcap\tchain");
for (const row of top) {
  const price = row.quote.markPrice ?? row.quote.lastPrice;
  console.log(
    [
      row.symbol,
      row.oi.notional == null ? "-" : Math.round(row.oi.notional),
      row.oi.notionalUnit ?? "-",
      price == null ? "-" : price,
      row.quote.changePct ?? "-",
      `${row.cap.status}${row.cap.coinName ? ":" + row.cap.coinName : ""}`,
      `${row.onchain.status}${row.onchain.chainLabel ? ":" + row.onchain.chainLabel : ""}`,
    ].join("\t"),
  );
}
