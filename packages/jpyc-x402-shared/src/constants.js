export const X402_EXACT_SCHEME = "exact";
export const X402_EIP3009_ASSET_TRANSFER_METHOD = "eip3009";
export const DEFAULT_INVOICE_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_CONFIRMATIONS = {
  testnet: 1,
  mainnet: 2,
};

export const JPYC_NETWORK_PRESETS = Object.freeze({
  testnet: Object.freeze({
    env: "testnet",
    chainId: 80002,
    caip2: "eip155:80002",
    chainName: "Polygon Amoy",
    nativeCurrencyName: "POL",
    nativeCurrencySymbol: "POL",
    assetSymbol: "JPYC",
    assetName: "JPY Coin",
    decimals: 18,
    rpcUrl: "https://rpc-amoy.polygon.technology",
    explorerUrl: "https://amoy.polygonscan.com",
    tokenAddress: "0xe7c3d8c9a439fede00d2600032d5db0be71c3c29",
    tokenAddressSource: "amoy-polygonscan-wallet-confirmation-2026-04-08",
  }),
  mainnet: Object.freeze({
    env: "mainnet",
    chainId: 137,
    caip2: "eip155:137",
    chainName: "Polygon",
    nativeCurrencyName: "POL",
    nativeCurrencySymbol: "POL",
    assetSymbol: "JPYC",
    assetName: "JPY Coin",
    decimals: 18,
    rpcUrl: "https://polygon.drpc.org",
    explorerUrl: "https://polygonscan.com",
    tokenAddress: "0x431D5dfF03120AFA4bDf332c61A6e1766eF37BDB",
    tokenAddressSource: "official-jpyc-website-consensus",
  }),
});
