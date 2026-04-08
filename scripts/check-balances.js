import "dotenv/config";
import { createPublicClient, erc20Abi, formatUnits, getAddress, http, parseAbiItem } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  getRequiredEnv,
  resolveJpycConfig,
} from "../packages/jpyc-x402-shared/src/index.js";

const config = resolveJpycConfig();
const client = createPublicClient({
  chain: config.viemChain,
  transport: http(config.rpcUrl),
});

function printResolvedConfig() {
  console.log("Resolved JPYC balance config");
  console.log(`  env: ${config.env}`);
  console.log(`  chain: ${config.chainName} (${config.chainId})`);
  console.log(`  rpc: ${config.rpcUrl}`);
  console.log(`  token: ${config.tokenAddress}`);

  if (!process.env.JPYC_ENV) {
    console.log("  note: JPYC_ENV was not set, so the script defaulted to testnet.");
  }
}

function collectKnownAddresses() {
  if (process.env.BALANCE_ADDRESS) {
    const address = getAddress(process.env.BALANCE_ADDRESS);

    return [{
      label: "target",
      address,
    }];
  }

  const candidates = [
    ["seller", process.env.SELLER_ADDRESS],
    ["browser", process.env.BROWSER_WALLET_ADDRESS],
  ];

  if (process.env.BUYER_PRIVATE_KEY) {
    candidates.push([
      "buyer",
      privateKeyToAccount(getRequiredEnv("BUYER_PRIVATE_KEY")).address,
    ]);
  }

  return [...new Map(
    candidates
      .filter(([, address]) => Boolean(address))
      .map(([label, address]) => [getAddress(address), { label, address: getAddress(address) }]),
  ).values()];
}

async function readTokenMetadata() {
  const [symbol, name, decimals] = await Promise.all([
    client.readContract({
      address: config.tokenAddress,
      abi: erc20Abi,
      functionName: "symbol",
    }),
    client.readContract({
      address: config.tokenAddress,
      abi: erc20Abi,
      functionName: "name",
    }),
    client.readContract({
      address: config.tokenAddress,
      abi: erc20Abi,
      functionName: "decimals",
    }),
  ]);

  return { symbol, name, decimals };
}

async function readTransferHints(address) {
  const latestBlock = await client.getBlockNumber();
  const requestedWindow = Number(process.env.BALANCE_LOG_WINDOW ?? 100_000);
  const safeWindow = Number.isFinite(requestedWindow) && requestedWindow > 0
    ? BigInt(Math.floor(requestedWindow))
    : 100_000n;
  const fromBlock = latestBlock > safeWindow ? latestBlock - safeWindow : 0n;
  const transferEvent = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  );

  try {
    const [incoming, outgoing] = await Promise.all([
      client.getLogs({
        address: config.tokenAddress,
        event: transferEvent,
        args: { to: address },
        fromBlock,
        toBlock: latestBlock,
      }),
      client.getLogs({
        address: config.tokenAddress,
        event: transferEvent,
        args: { from: address },
        fromBlock,
        toBlock: latestBlock,
      }),
    ]);

    return {
      incomingTransfersRecent: incoming.length,
      outgoingTransfersRecent: outgoing.length,
      logWindowBlocks: safeWindow.toString(),
    };
  } catch (error) {
    return {
      transferHintError: error instanceof Error ? error.message : String(error),
      logWindowBlocks: safeWindow.toString(),
    };
  }
}

async function readBalance(label, address) {
  const [nativeBalance, tokenBalance] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: config.tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);
  const row = {
    label,
    address,
    [config.nativeCurrencySymbol.toLowerCase()]: formatUnits(nativeBalance, 18),
    [config.assetSymbol.toLowerCase()]: formatUnits(tokenBalance, config.decimals),
  };

  if (tokenBalance === 0n && process.env.BALANCE_DEBUG_TRANSFERS === "true") {
    const hints = await readTransferHints(address);

    return {
      ...row,
      ...hints,
    };
  }

  return row;
}

async function main() {
  const addresses = collectKnownAddresses();

  if (addresses.length === 0) {
    throw new Error("No known addresses were configured.");
  }

  printResolvedConfig();
  const metadata = await readTokenMetadata();
  console.log(`  token name: ${metadata.name}`);
  console.log(`  token symbol: ${metadata.symbol}`);
  console.log(`  token decimals: ${metadata.decimals}`);

  if (process.env.BALANCE_DEBUG_TRANSFERS === "true") {
    console.log("  transfer hints: enabled");
  }

  console.log("");

  const balances = await Promise.all(
    addresses.map(({ label, address }) => readBalance(label, address)),
  );

  console.table(balances);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
