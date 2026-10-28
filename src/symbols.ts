/**
 * Binance multiplier prefixes (1000PEPE, 1000000MOG, 1MBABYDOGE) are not separate coins.
 * Accept the CoinGecko symbol when it matches either the raw base asset or the stripped asset.
 */
export function symbolCompatible(baseAsset: string, coinSymbol: string): boolean {
  const base = baseAsset.trim().toLowerCase();
  const coin = coinSymbol.trim().toLowerCase();
  if (!base || !coin) return false;
  if (base === coin) return true;
  const stripped = stripMultiplier(base);
  return stripped !== base && stripped === coin;
}

function stripMultiplier(base: string): string {
  if (/^10{3,}/.test(base)) return base.replace(/^10{3,}/, "");
  if (/^1m/.test(base)) return base.replace(/^1m/, "");
  return base;
}

/**
 * Reject a CoinGecko id when the mapped coin's circulating market cap is far too small
 * for the futures open interest. This catches wrong ids such as PUMPUSDT -> PumpBTC
 * without substituting a different coin.
 */
export function mappingRejected(oiNotional: number | null, marketCap: number | null): boolean {
  if (oiNotional == null || marketCap == null) return false;
  if (!(marketCap > 0) || !(oiNotional > 0)) return false;
  return marketCap < 100_000_000 && oiNotional > marketCap * 8;
}

/**
 * CoinGecko ids whose canonical asset is a native chain coin. Their `platforms`
 * entries are wrapped or bridged contracts, not the native holder set.
 * BNB, for example, only lists the Ethereum ERC-20.
 */
const NATIVE_ASSET_IDS = new Set([
  "algorand",
  "aptos",
  "avalanche-2",
  "binancecoin",
  "bitcoin",
  "bitcoin-cash",
  "bittensor",
  "cardano",
  "celestia",
  "cosmos",
  "crypto-com-chain",
  "dash",
  "dogecoin",
  "eos",
  "ethereum",
  "ethereum-classic",
  "fantom",
  "filecoin",
  "hedera-hashgraph",
  "hyperliquid",
  "injective-protocol",
  "internet-computer",
  "iota",
  "kaspa",
  "litecoin",
  "mantle",
  "matic-network",
  "monero",
  "near",
  "neo",
  "polkadot",
  "polygon-ecosystem-token",
  "ripple",
  "sei-network",
  "solana",
  "stellar",
  "sui",
  "tezos",
  "the-open-network",
  "thorchain",
  "tron",
  "vechain",
  "zcash",
]);

export function isNativeAsset(coinId: string | null | undefined): boolean {
  return coinId != null && NATIVE_ASSET_IDS.has(coinId);
}
