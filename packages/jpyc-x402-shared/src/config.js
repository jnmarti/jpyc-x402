import { defineChain, getAddress } from "viem";

import {
  DEFAULT_CONFIRMATIONS,
  DEFAULT_INVOICE_TTL_MS,
  JPYC_NETWORK_PRESETS,
} from "./constants.js";

export function getRequiredEnv(name, env = process.env) {
  const value = env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function resolveJpycEnv(value = process.env.JPYC_ENV ?? "testnet") {
  if (!JPYC_NETWORK_PRESETS[value]) {
    throw new Error(`Unsupported JPYC_ENV: ${value}. Expected testnet or mainnet.`);
  }

  return value;
}

export function encodeTokenAmount(value, decimals = 18) {
  const [wholePart, fractionalPart = ""] = String(value).trim().split(".");
  const whole = wholePart.replace(/^0+(?=\d)/, "") || "0";
  const fraction = fractionalPart.padEnd(decimals, "0").slice(0, decimals);
  const units = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");

  return units || "0";
}

export function decodeTokenAmount(value, decimals = 18) {
  const raw = String(value).replace(/^0+(?=\d)/, "") || "0";

  if (decimals === 0) {
    return raw;
  }

  const padded = raw.padStart(decimals + 1, "0");
  const splitIndex = padded.length - decimals;
  const whole = padded.slice(0, splitIndex);
  const fraction = padded.slice(splitIndex).replace(/0+$/, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

export function normalizeUnits(value) {
  const normalized = String(value).trim();

  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid token amount in base units: ${value}`);
  }

  return normalized;
}

export function resolveJpycConfig(options = {}) {
  const env = resolveJpycEnv(options.env ?? process.env.JPYC_ENV);
  const preset = JPYC_NETWORK_PRESETS[env];
  const rpcUrl = options.rpcUrl ?? process.env.JPYC_RPC_URL ?? preset.rpcUrl;
  const rawTokenAddress = options.tokenAddress ?? process.env.JPYC_TOKEN_ADDRESS ?? preset.tokenAddress;
  const confirmations = Number(
    options.confirmations
      ?? process.env.JPYC_CONFIRMATIONS
      ?? DEFAULT_CONFIRMATIONS[env],
  );
  const invoiceTtlMs = Number(
    options.invoiceTtlMs
      ?? process.env.JPYC_INVOICE_TTL_MS
      ?? DEFAULT_INVOICE_TTL_MS,
  );

  if (!rpcUrl) {
    throw new Error(`Missing RPC URL for ${env}.`);
  }

  if (!rawTokenAddress) {
    throw new Error(`Missing JPYC token address for ${env}. Set JPYC_TOKEN_ADDRESS.`);
  }

  if (!Number.isFinite(confirmations) || confirmations < 0) {
    throw new Error(`Invalid confirmation count: ${confirmations}`);
  }

  if (!Number.isFinite(invoiceTtlMs) || invoiceTtlMs <= 0) {
    throw new Error(`Invalid invoice TTL: ${invoiceTtlMs}`);
  }

  const tokenAddress = getAddress(rawTokenAddress);

  return {
    ...preset,
    rpcUrl,
    tokenAddress,
    confirmations,
    invoiceTtlMs,
    viemChain: defineChain({
      id: preset.chainId,
      name: preset.chainName,
      nativeCurrency: {
        name: preset.nativeCurrencyName,
        symbol: preset.nativeCurrencySymbol,
        decimals: 18,
      },
      rpcUrls: {
        default: { http: [rpcUrl] },
      },
      blockExplorers: preset.explorerUrl
        ? {
            default: {
              name: `${preset.chainName} Explorer`,
              url: preset.explorerUrl,
            },
          }
        : undefined,
    }),
  };
}
