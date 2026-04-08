import "dotenv/config";

import { createPublicClient, erc20Abi, http } from "viem";

import { resolveJpycConfig } from "../packages/jpyc-x402-shared/src/index.js";

const POLYGON_MAINNET_RPC_FALLBACKS = [
  "https://polygon.drpc.org",
  "https://tenderly.rpc.polygon.community",
  "https://polygon.publicnode.com",
];

async function main() {
  const config = resolveJpycConfig({ env: "mainnet" });
  const candidateRpcUrls = [...new Set([
    process.env.JPYC_RPC_URL,
    config.rpcUrl,
    ...POLYGON_MAINNET_RPC_FALLBACKS,
  ].filter(Boolean))];
  let lastError;
  let result;

  for (const rpcUrl of candidateRpcUrls) {
    const client = createPublicClient({
      chain: config.viemChain,
      transport: http(rpcUrl),
    });

    try {
      const [blockNumber, name, symbol, decimals] = await Promise.all([
        client.getBlockNumber(),
        client.readContract({
          address: config.tokenAddress,
          abi: erc20Abi,
          functionName: "name",
        }),
        client.readContract({
          address: config.tokenAddress,
          abi: erc20Abi,
          functionName: "symbol",
        }),
        client.readContract({
          address: config.tokenAddress,
          abi: erc20Abi,
          functionName: "decimals",
        }),
      ]);

      result = {
        rpcUrl,
        blockNumber,
        name,
        symbol,
        decimals,
      };
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!result) {
    throw lastError;
  }

  console.log("Mainnet JPYC readonly smoke check");
  console.log(JSON.stringify({
    chain: config.chainName,
    chainId: config.chainId,
    rpcUrl: result.rpcUrl,
    blockNumber: result.blockNumber.toString(),
    tokenAddress: config.tokenAddress,
    name: result.name,
    symbol: result.symbol,
    decimals: Number(result.decimals),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
