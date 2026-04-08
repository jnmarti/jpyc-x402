import { randomBytes } from "node:crypto";

import { getAddress } from "viem";

import { resolveJpycConfig } from "./config.js";
import {
  X402_EIP3009_ASSET_TRANSFER_METHOD,
  X402_EXACT_SCHEME,
} from "./constants.js";

const TRANSFER_WITH_AUTHORIZATION_TYPES = Object.freeze({
  TransferWithAuthorization: Object.freeze([
    Object.freeze({ name: "from", type: "address" }),
    Object.freeze({ name: "to", type: "address" }),
    Object.freeze({ name: "value", type: "uint256" }),
    Object.freeze({ name: "validAfter", type: "uint256" }),
    Object.freeze({ name: "validBefore", type: "uint256" }),
    Object.freeze({ name: "nonce", type: "bytes32" }),
  ]),
});

export const transferWithAuthorizationAbi = Object.freeze([
  Object.freeze({
    type: "function",
    stateMutability: "nonpayable",
    name: "transferWithAuthorization",
    inputs: Object.freeze([
      Object.freeze({ name: "from", type: "address" }),
      Object.freeze({ name: "to", type: "address" }),
      Object.freeze({ name: "value", type: "uint256" }),
      Object.freeze({ name: "validAfter", type: "uint256" }),
      Object.freeze({ name: "validBefore", type: "uint256" }),
      Object.freeze({ name: "nonce", type: "bytes32" }),
      Object.freeze({ name: "v", type: "uint8" }),
      Object.freeze({ name: "r", type: "bytes32" }),
      Object.freeze({ name: "s", type: "bytes32" }),
    ]),
    outputs: Object.freeze([]),
  }),
  Object.freeze({
    type: "function",
    stateMutability: "view",
    name: "authorizationState",
    inputs: Object.freeze([
      Object.freeze({ name: "authorizer", type: "address" }),
      Object.freeze({ name: "nonce", type: "bytes32" }),
    ]),
    outputs: Object.freeze([
      Object.freeze({ name: "", type: "bool" }),
    ]),
  }),
]);

function readAmount(input = {}) {
  return input.maxAmountRequired
    ?? input.amount
    ?? input.value
    ?? input?.accepted?.amount
    ?? input?.accepted?.maxAmountRequired;
}

function readRecipient(input = {}) {
  return input.payTo
    ?? input.recipient
    ?? input.paymentAddress
    ?? input?.accepted?.payTo
    ?? input?.accepted?.recipient;
}

function readTokenAddress(input = {}) {
  return input.asset
    ?? input.assetAddress
    ?? input.tokenAddress
    ?? input?.accepted?.asset;
}

function toSeconds(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }

  return Number(BigInt(value));
}

function normalizeBytes32(value) {
  const normalized = String(value ?? "").trim().toLowerCase();

  if (!/^0x[0-9a-f]{64}$/u.test(normalized)) {
    throw new Error(`Invalid EIP-3009 nonce: ${value}`);
  }

  return normalized;
}

export function createEip3009Nonce() {
  return `0x${randomBytes(32).toString("hex")}`;
}

export function normalizeExactPaymentRequirements(requirement, options = {}) {
  const config = options.config ?? resolveJpycConfig(options);
  const scheme = requirement?.scheme ?? X402_EXACT_SCHEME;
  const network = requirement?.network ?? config.caip2;
  const amount = readAmount(requirement);
  const payTo = readRecipient(requirement);
  const asset = readTokenAddress(requirement) ?? config.tokenAddress;
  const assetTransferMethod = requirement?.extra?.assetTransferMethod
    ?? X402_EIP3009_ASSET_TRANSFER_METHOD;

  if (scheme !== X402_EXACT_SCHEME) {
    throw new Error(`Unsupported payment scheme: ${scheme}`);
  }

  if (!amount || !/^\d+$/u.test(String(amount))) {
    throw new Error("Payment requirements must include an integer token amount.");
  }

  if (!payTo) {
    throw new Error("Payment requirements must include a recipient.");
  }

  if (!asset) {
    throw new Error("Payment requirements must include an asset address.");
  }

  if (assetTransferMethod !== X402_EIP3009_ASSET_TRANSFER_METHOD) {
    throw new Error(
      `Unsupported asset transfer method: ${assetTransferMethod}. Expected ${X402_EIP3009_ASSET_TRANSFER_METHOD}.`,
    );
  }

  return {
    scheme,
    network,
    maxAmountRequired: String(amount),
    amount: String(amount),
    payTo: getAddress(payTo),
    asset: getAddress(asset),
    resource: requirement?.resource,
    description: requirement?.description,
    mimeType: requirement?.mimeType,
    maxTimeoutSeconds: requirement?.maxTimeoutSeconds,
    extra: {
      ...requirement?.extra,
      assetTransferMethod,
      name: requirement?.extra?.name ?? options.tokenName ?? config.assetName,
      version: requirement?.extra?.version ?? options.tokenVersion ?? "1",
      decimals: requirement?.extra?.decimals ?? config.decimals,
      symbol: requirement?.extra?.symbol ?? config.assetSymbol,
      asset: getAddress(asset),
      payTo: getAddress(payTo),
      amount: String(amount),
      network,
    },
  };
}

export function createJpycExactPaymentRequirements(input = {}) {
  const config = input.config ?? resolveJpycConfig(input);

  return normalizeExactPaymentRequirements({
    scheme: X402_EXACT_SCHEME,
    network: input.network ?? config.caip2,
    maxAmountRequired: input.amount ?? input.maxAmountRequired,
    payTo: input.payTo ?? input.recipient,
    asset: input.asset ?? input.tokenAddress ?? config.tokenAddress,
    resource: input.resource,
    description: input.description,
    mimeType: input.mimeType,
    maxTimeoutSeconds: input.maxTimeoutSeconds
      ?? Math.ceil((input.invoiceTtlMs ?? config.invoiceTtlMs) / 1000),
    extra: {
      ...input.extra,
      assetTransferMethod: input.extra?.assetTransferMethod
        ?? X402_EIP3009_ASSET_TRANSFER_METHOD,
      name: input.tokenName ?? config.assetName,
      version: input.tokenVersion ?? "1",
      decimals: input.decimals ?? config.decimals,
      symbol: input.assetSymbol ?? config.assetSymbol,
    },
  }, { config });
}

export function normalizeEip3009Authorization(authorization, options = {}) {
  if (!authorization) {
    throw new Error("Missing EIP-3009 authorization payload.");
  }

  const fallbackNowSeconds = toSeconds(options.now, Math.floor(Date.now() / 1000));
  const validAfter = toSeconds(authorization.validAfter, fallbackNowSeconds - 60);
  const ttlSeconds = toSeconds(options.ttlSeconds, 300);
  const validBefore = toSeconds(authorization.validBefore, validAfter + ttlSeconds);
  const value = authorization.value ?? authorization.amount;

  if (!authorization.from || !authorization.to || value === undefined || value === null) {
    throw new Error("Authorization must include from, to, and value.");
  }

  if (!/^\d+$/u.test(String(value))) {
    throw new Error("Authorization value must be an integer token amount.");
  }

  if (validBefore <= validAfter) {
    throw new Error("Authorization validBefore must be greater than validAfter.");
  }

  return {
    from: getAddress(authorization.from),
    to: getAddress(authorization.to),
    value: String(value),
    validAfter: String(validAfter),
    validBefore: String(validBefore),
    nonce: normalizeBytes32(authorization.nonce ?? createEip3009Nonce()),
  };
}

export function createEip3009TypedData(input = {}) {
  const authorization = normalizeEip3009Authorization(input.authorization, input);

  return {
    domain: {
      name: String(input.tokenName ?? "JPY Coin"),
      version: String(input.tokenVersion ?? "1"),
      chainId: Number(input.chainId),
      verifyingContract: getAddress(input.tokenAddress),
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: authorization.from,
      to: authorization.to,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  };
}

export function createJpycExactPaymentPayload(input = {}) {
  const paymentRequirements = normalizeExactPaymentRequirements(
    input.paymentRequirements,
    input,
  );
  const authorization = normalizeEip3009Authorization(
    input.authorization,
    input,
  );

  return {
    x402Version: input.x402Version ?? 1,
    scheme: X402_EXACT_SCHEME,
    network: paymentRequirements.network,
    accepted: {
      scheme: paymentRequirements.scheme,
      network: paymentRequirements.network,
      amount: paymentRequirements.maxAmountRequired,
      asset: paymentRequirements.asset,
      payTo: paymentRequirements.payTo,
      extra: paymentRequirements.extra,
    },
    payload: {
      signature: input.signature,
      authorization,
    },
  };
}
