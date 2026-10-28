# 币安 USDT 永续看板

单页只读看板，查看币安 USDT 本位永续合约的持仓、流通市值和链上持币集中度。不需要 API 密钥，不能下单。

## 运行

```bash
npm install
npm run dev
```

浏览器打开 http://localhost:5173 。默认按持仓额显示前 40 个合约，可搜索、排序，或改成显示全部。约每 60 秒刷新，时间显示为北京时间（Asia/Shanghai）。

生产构建：

```bash
npm run build
npm run preview
```

核对公开接口是否返回了可用数据：

```bash
npm run check:data
```

## 数据来源

| 列 | 接口 | 拿不到时 |
| --- | --- | --- |
| 标记价、24 小时涨跌、持仓量、持仓额 | [Binance USD-M Futures](https://fapi.binance.com)：`/fapi/v1/premiumIndex`、`/fapi/v1/ticker/24hr`、`/fapi/v1/exchangeInfo`、`/fapi/v1/openInterest` | 当前网络若被币安按地区拒绝，改用 CoinGecko 的 [binance_futures](https://api.coingecko.com/api/v3/derivatives/exchanges/binance_futures?include_tickers=unexpired) 最新价、指数价和 USD 持仓额。持仓量用持仓额除以价格估算，并在格子里标明。标记价留空。 |
| 持仓 24 小时变化 | Binance `/futures/data/openInterestHist` | CoinGecko 不提供这项。fapi 不可用，或该合约不在持仓额前 40 名时，格子说明原因，不填百分比。 |
| 流通量、流通市值 | [CoinGecko coins/markets](https://api.coingecko.com/api/v3/coins/markets) | 没有币种映射、符号对不上，或映射币的市值相对持仓额小到不合理时留空。股票、商品、指数合约通常没有映射。 |
| 链上持仓 | [GoPlus Token Security](https://api.gopluslabs.io)（以太坊、BSC、Base、Arbitrum、Optimism、Polygon、Avalanche、Solana） | 只查持仓额前 40 名、且 CoinGecko 登记的主链合约。原生币、未覆盖的链、或没有免密钥数据时写明原因。这里是链上持币集中度，不是币安账户持仓。 |

币种和合约地址来自 CoinGecko `coins/list?include_platform=true`。页面不抓取需要登录的页面，也不读取私钥或交易接口。
