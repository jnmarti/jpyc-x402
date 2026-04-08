import test from "node:test";
import assert from "node:assert/strict";

import express from "express";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  createJpycFacilitator,
  createJpycFacilitatorRouter,
} from "../../packages/jpyc-x402-facilitator/src/index.js";
import {
  createEip3009Nonce,
  createEip3009TypedData,
  createJpycExactPaymentPayload,
  createJpycExactPaymentRequirements,
  encodeTokenAmount,
  resolveJpycConfig,
} from "../../packages/jpyc-x402-shared/src/index.js";
import { createMockChain } from "../helpers/mock-chain.js";

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1");
    server.on("listening", () => {
      const address = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function createSignedPayment({ config, amount, seller }) {
  const payerAccount = privateKeyToAccount(generatePrivateKey());
  const nowSeconds = Math.floor(Date.now() / 1000);
  const paymentRequirements = createJpycExactPaymentRequirements({
    config,
    amount,
    payTo: seller,
    resource: "/posts/premium",
    description: "Premium facilitator test resource",
  });
  const authorization = {
    from: payerAccount.address,
    to: seller,
    value: amount,
    validAfter: nowSeconds - 30,
    validBefore: nowSeconds + 300,
    nonce: createEip3009Nonce(),
  };
  const signature = await payerAccount.signTypedData(
    createEip3009TypedData({
      chainId: config.chainId,
      tokenAddress: config.tokenAddress,
      tokenName: paymentRequirements.extra.name,
      tokenVersion: paymentRequirements.extra.version,
      authorization,
    }),
  );
  const paymentPayload = createJpycExactPaymentPayload({
    paymentRequirements,
    authorization,
    signature,
  });

  return {
    payerAccount,
    paymentRequirements,
    paymentPayload,
  };
}

test("facilitator verifies and settles JPYC exact payments", async () => {
  const config = resolveJpycConfig({ env: "testnet" });
  const amount = encodeTokenAmount("1", config.decimals);
  const seller = "0x1111111111111111111111111111111111111111";
  const facilitatorSubmitter = privateKeyToAccount(generatePrivateKey());
  const mockChain = createMockChain({
    chainId: config.chainId,
    tokenAddress: config.tokenAddress,
    confirmations: config.confirmations,
  });
  const { publicClient, walletClient } = mockChain.createFacilitatorClients(
    facilitatorSubmitter.address,
  );
  const facilitator = createJpycFacilitator({
    config,
    publicClient,
    walletClient,
    transferVerifier: mockChain.createVerifier(),
  });
  const { paymentRequirements, paymentPayload } = await createSignedPayment({
    config,
    amount,
    seller,
  });

  const verification = await facilitator.verify({
    paymentPayload,
    paymentRequirements,
  });
  const settlement = await facilitator.settle({
    paymentPayload,
    paymentRequirements,
  });
  const repeatSettlement = await facilitator.settle({
    paymentPayload,
    paymentRequirements,
  });

  assert.equal(verification.isValid, true);
  assert.equal(verification.invalidReason, null);
  assert.equal(settlement.success, true);
  assert.ok(settlement.txHash);
  assert.equal(repeatSettlement.txHash, settlement.txHash);
});

test("facilitator rejects payments that cannot pass relay gas estimation", async () => {
  const config = resolveJpycConfig({ env: "testnet" });
  const amount = encodeTokenAmount("1", config.decimals);
  const seller = "0x1111111111111111111111111111111111111111";
  const facilitatorSubmitter = privateKeyToAccount(generatePrivateKey());
  const mockChain = createMockChain({
    chainId: config.chainId,
    tokenAddress: config.tokenAddress,
    confirmations: config.confirmations,
    estimateContractGasError: "execution reverted",
  });
  const { publicClient, walletClient } = mockChain.createFacilitatorClients(
    facilitatorSubmitter.address,
  );
  const facilitator = createJpycFacilitator({
    config,
    publicClient,
    walletClient,
    transferVerifier: mockChain.createVerifier(),
  });
  const { paymentRequirements, paymentPayload } = await createSignedPayment({
    config,
    amount,
    seller,
  });

  const verification = await facilitator.verify({
    paymentPayload,
    paymentRequirements,
  });
  const settlement = await facilitator.settle({
    paymentPayload,
    paymentRequirements,
  });

  assert.equal(verification.isValid, false);
  assert.match(verification.invalidReason, /execution reverted/u);
  assert.equal(settlement.success, false);
  assert.match(settlement.error, /execution reverted/u);
});

test("facilitator rejects payments when the relay account lacks native gas funds", async () => {
  const config = resolveJpycConfig({ env: "testnet" });
  const amount = encodeTokenAmount("1", config.decimals);
  const seller = "0x1111111111111111111111111111111111111111";
  const facilitatorSubmitter = privateKeyToAccount(generatePrivateKey());
  const mockChain = createMockChain({
    chainId: config.chainId,
    tokenAddress: config.tokenAddress,
    confirmations: config.confirmations,
    gasEstimate: 120_000,
    nativeBalance: 100_000,
  });
  const { publicClient, walletClient } = mockChain.createFacilitatorClients(
    facilitatorSubmitter.address,
  );
  const facilitator = createJpycFacilitator({
    config,
    publicClient,
    walletClient,
    transferVerifier: mockChain.createVerifier(),
  });
  const { paymentRequirements, paymentPayload } = await createSignedPayment({
    config,
    amount,
    seller,
  });

  const verification = await facilitator.verify({
    paymentPayload,
    paymentRequirements,
  });
  const settlement = await facilitator.settle({
    paymentPayload,
    paymentRequirements,
  });

  assert.equal(verification.isValid, false);
  assert.match(verification.invalidReason, /facilitator_insufficient_native_balance/u);
  assert.equal(settlement.success, false);
  assert.match(settlement.error, /facilitator_insufficient_native_balance/u);
});

test("facilitator router serves supported, verify, and settle endpoints", async () => {
  const config = resolveJpycConfig({ env: "testnet" });
  const amount = encodeTokenAmount("2", config.decimals);
  const seller = "0x1111111111111111111111111111111111111111";
  const facilitatorSubmitter = privateKeyToAccount(generatePrivateKey());
  const mockChain = createMockChain({
    chainId: config.chainId,
    tokenAddress: config.tokenAddress,
    confirmations: config.confirmations,
  });
  const { publicClient, walletClient } = mockChain.createFacilitatorClients(
    facilitatorSubmitter.address,
  );
  const app = express();

  app.use("/facilitator", createJpycFacilitatorRouter({
    config,
    publicClient,
    walletClient,
    transferVerifier: mockChain.createVerifier(),
  }));

  const { server, url } = await listen(app);
  const { paymentRequirements, paymentPayload } = await createSignedPayment({
    config,
    amount,
    seller,
  });
  const paymentHeader = Buffer.from(
    JSON.stringify(paymentPayload),
    "utf8",
  ).toString("base64url");

  try {
    const supported = await fetch(`${url}/facilitator/supported`);
    const verification = await fetch(`${url}/facilitator/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        paymentHeader,
        paymentRequirements,
      }),
    });
    const settlement = await fetch(`${url}/facilitator/settle`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        paymentHeader,
        paymentRequirements,
      }),
    });

    assert.deepEqual(await supported.json(), {
      kinds: [
        {
          scheme: "exact",
          network: config.caip2,
        },
      ],
    });

    const verificationBody = await verification.json();
    const settlementBody = await settlement.json();

    assert.equal(verificationBody.isValid, true);
    assert.equal(settlementBody.success, true);
    assert.ok(settlementBody.txHash);
  } finally {
    await closeServer(server);
  }
});
