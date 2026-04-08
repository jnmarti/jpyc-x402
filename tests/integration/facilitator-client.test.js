import test from "node:test";
import assert from "node:assert/strict";

import express from "express";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import {
  createAndSettleJpycPayment,
  createSignedJpycPayment,
  createViemAuthorizationSigner,
  fetchFacilitatorSupported,
  settleJpycPayment,
  verifyJpycPayment,
} from "../../packages/jpyc-x402-client/src/index.js";
import {
  createJpycFacilitatorRouter,
} from "../../packages/jpyc-x402-facilitator/src/index.js";
import {
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

test("client signs JPYC payments and settles them through the facilitator", async () => {
  const config = resolveJpycConfig({ env: "testnet" });
  const amount = encodeTokenAmount("1", config.decimals);
  const seller = "0x1111111111111111111111111111111111111111";
  const payerPrivateKey = generatePrivateKey();
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
  const signer = createViemAuthorizationSigner({
    privateKey: payerPrivateKey,
    config,
  });
  const paymentRequirements = createJpycExactPaymentRequirements({
    config,
    amount,
    payTo: seller,
    resource: "/posts/premium",
  });

  try {
    const supported = await fetchFacilitatorSupported(`${url}/facilitator`);
    const payment = await createSignedJpycPayment(paymentRequirements, signer);
    const verification = await verifyJpycPayment(`${url}/facilitator`, payment);
    const settlement = await settleJpycPayment(`${url}/facilitator`, payment);

    assert.equal(supported.body.kinds.length, 1);
    assert.equal(verification.body.isValid, true);
    assert.equal(settlement.body.success, true);
    assert.ok(settlement.body.txHash);
  } finally {
    await closeServer(server);
  }
});

test("client can create and settle JPYC payments in one call", async () => {
  const config = resolveJpycConfig({ env: "testnet" });
  const amount = encodeTokenAmount("2", config.decimals);
  const seller = "0x1111111111111111111111111111111111111111";
  const payerPrivateKey = generatePrivateKey();
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
  const signer = createViemAuthorizationSigner({
    privateKey: payerPrivateKey,
    config,
  });
  const paymentRequirements = createJpycExactPaymentRequirements({
    config,
    amount,
    payTo: seller,
    resource: "/posts/premium",
  });

  try {
    const paid = await createAndSettleJpycPayment(
      `${url}/facilitator`,
      paymentRequirements,
      signer,
    );

    assert.equal(paid.verification.body.isValid, true);
    assert.equal(paid.settlement.body.success, true);
    assert.ok(paid.settlement.body.txHash);
  } finally {
    await closeServer(server);
  }
});

test("client explains when a facilitator action url is passed instead of the base url", async () => {
  const config = resolveJpycConfig({ env: "testnet" });
  const amount = encodeTokenAmount("1", config.decimals);
  const seller = "0x1111111111111111111111111111111111111111";
  const payerPrivateKey = generatePrivateKey();
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
  const signer = createViemAuthorizationSigner({
    privateKey: payerPrivateKey,
    config,
  });
  const paymentRequirements = createJpycExactPaymentRequirements({
    config,
    amount,
    payTo: seller,
    resource: "/posts/premium",
  });

  try {
    const payment = await createSignedJpycPayment(paymentRequirements, signer);

    await assert.rejects(
      settleJpycPayment(`${url}/facilitator/settle`, payment),
      (error) => {
        assert.match(error.message, /Expected JSON response/u);
        assert.match(error.message, /Pass the facilitator base URL instead/u);
        assert.match(error.message, /appends \/settle internally/u);
        assert.match(error.message, /facilitator\/settle/u);
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});
