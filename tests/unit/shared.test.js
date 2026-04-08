import test from "node:test";
import assert from "node:assert/strict";

import {
  createEip3009TypedData,
  createJpycExactPaymentPayload,
  createJpycExactPaymentRequirements,
  createVerificationResult,
  decodeTokenAmount,
  encodeTokenAmount,
  isExpiredAt,
  resolveJpycConfig,
} from "../../packages/jpyc-x402-shared/src/index.js";

test("resolveJpycConfig switches between testnet and mainnet", () => {
  const testnet = resolveJpycConfig({ env: "testnet" });
  const mainnet = resolveJpycConfig({ env: "mainnet" });

  assert.equal(testnet.chainId, 80002);
  assert.equal(mainnet.chainId, 137);
  assert.notEqual(testnet.tokenAddress, mainnet.tokenAddress);
});

test("token amount helpers preserve decimal values", () => {
  const encoded = encodeTokenAmount("12.345", 18);
  const decoded = decodeTokenAmount(encoded, 18);

  assert.equal(encoded, "12345000000000000000");
  assert.equal(decoded, "12.345");
});

test("x402 exact payment requirements and EIP-3009 payload are created for JPYC", () => {
  const config = resolveJpycConfig({ env: "testnet" });
  const paymentRequirements = createJpycExactPaymentRequirements({
    config,
    amount: "1000000000000000000",
    payTo: "0x1111111111111111111111111111111111111111",
    resource: "/posts/premium",
  });
  const authorization = {
    from: "0x2222222222222222222222222222222222222222",
    to: paymentRequirements.payTo,
    value: paymentRequirements.maxAmountRequired,
    validAfter: 1,
    validBefore: 301,
    nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
  const typedData = createEip3009TypedData({
    chainId: config.chainId,
    tokenAddress: config.tokenAddress,
    tokenName: paymentRequirements.extra.name,
    tokenVersion: paymentRequirements.extra.version,
    authorization,
  });
  const paymentPayload = createJpycExactPaymentPayload({
    paymentRequirements,
    authorization,
    signature: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb1b",
  });

  assert.equal(paymentRequirements.scheme, "exact");
  assert.equal(paymentRequirements.network, config.caip2);
  assert.equal(paymentRequirements.extra.assetTransferMethod, "eip3009");
  assert.equal(typedData.domain.name, "JPY Coin");
  assert.equal(typedData.domain.version, "1");
  assert.equal(paymentPayload.accepted.amount, paymentRequirements.maxAmountRequired);
  assert.equal(paymentPayload.payload.authorization.to, paymentRequirements.payTo);
});

test("verification helper normalizes x402 verification shape", () => {
  const verification = createVerificationResult({
    ok: true,
    invoiceId: "verification_1",
    txHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    payer: "0x2222222222222222222222222222222222222222",
    recipient: "0x1111111111111111111111111111111111111111",
    tokenAddress: "0x431D5dfF03120AFA4bDf332c61A6e1766eF37BDB",
    amount: "1000000000000000000",
    chainId: 137,
  });

  assert.equal(verification.scheme, "exact");
  assert.equal(verification.network, "eip155:137");
  assert.equal(verification.isValid, true);
  assert.equal(verification.asset, verification.tokenAddress);
});

test("isExpiredAt compares ISO timestamps", () => {
  assert.equal(isExpiredAt("2026-04-09T00:00:00.000Z", Date.parse("2026-04-09T00:00:00.000Z")), true);
  assert.equal(isExpiredAt("2026-04-09T00:00:01.000Z", Date.parse("2026-04-09T00:00:00.000Z")), false);
});
