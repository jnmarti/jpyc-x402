import { getAddress } from "viem";

import { X402_EXACT_SCHEME } from "./constants.js";

function createCaip2(chainId) {
  return `eip155:${Number(chainId)}`;
}

export function isExpiredAt(expiresAt, now = Date.now()) {
  return now >= Date.parse(expiresAt);
}

export function createVerificationResult(input) {
  const network = input.network ?? (input.chainId ? createCaip2(input.chainId) : undefined);
  const paymentId = input.paymentId ?? input.invoiceId;

  return {
    kind: "jpyc-x402-verification",
    scheme: input.scheme ?? X402_EXACT_SCHEME,
    network,
    networkId: network,
    ok: input.ok,
    isValid: input.isValid ?? input.ok,
    paymentId,
    invoiceId: paymentId,
    txHash: input.txHash,
    payer: input.payer ? getAddress(input.payer) : undefined,
    recipient: input.recipient ? getAddress(input.recipient) : undefined,
    tokenAddress: input.tokenAddress ? getAddress(input.tokenAddress) : undefined,
    asset: input.tokenAddress ? getAddress(input.tokenAddress) : undefined,
    amount: input.amount,
    chainId: input.chainId,
    confirmations: input.confirmations,
    blockNumber: input.blockNumber,
    verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    reason: input.reason,
    invalidReason: input.invalidReason ?? input.reason,
  };
}
