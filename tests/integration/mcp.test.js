import test from "node:test";
import assert from "node:assert/strict";

import express from "express";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { createMcpServer } from "../../packages/jpyc-x402-mcp/src/index.js";
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

test("mcp server signs and settles facilitator payments", async () => {
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
  const mcp = createMcpServer({
    signerOptions: {
      privateKey: payerPrivateKey,
      config,
    },
  });
  const paymentRequirements = createJpycExactPaymentRequirements({
    config,
    amount,
    payTo: seller,
    resource: "/posts/premium",
  });

  try {
    const initialize = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "jpyc-x402-test",
          version: "0.2.0",
        },
      },
    });
    assert.equal(initialize.result.serverInfo.name, "jpyc-x402-mcp");

    const tools = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    assert.equal(tools.result.tools.length, 5);

    const supported = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "facilitator_supported",
        arguments: {
          url: `${url}/facilitator`,
        },
      },
    });
    assert.equal(supported.result.structuredContent.body.kinds.length, 1);

    const createdPayment = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "create_jpyc_payment",
        arguments: {
          paymentRequirements,
        },
      },
    });
    const paymentPayload = createdPayment.result.structuredContent.paymentPayload;
    assert.ok(paymentPayload.payload.signature);

    const verification = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "verify_jpyc_payment",
        arguments: {
          url: `${url}/facilitator`,
          paymentPayload,
          paymentRequirements,
        },
      },
    });
    assert.equal(verification.result.structuredContent.body.isValid, true);

    const settlement = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "settle_jpyc_payment",
        arguments: {
          url: `${url}/facilitator`,
          paymentPayload,
          paymentRequirements,
        },
      },
    });
    assert.equal(settlement.result.structuredContent.body.success, true);
    assert.equal(
      settlement.result.structuredContent.nextStep.action,
      "retry_protected_resource",
    );
    assert.equal(
      settlement.result.structuredContent.nextStep.bundledExpressExample.queryParameters.txHash.source,
      "body.txHash",
    );
    assert.equal(
      settlement.result.structuredContent.nextStep.bundledExpressExample.queryParameters.txHash.value,
      settlement.result.structuredContent.body.txHash,
    );
    assert.equal(
      settlement.result.structuredContent.nextStep.bundledExpressExample.queryParameters.payer.source,
      "paymentPayload.payload.authorization.from",
    );
    assert.equal(
      settlement.result.structuredContent.nextStep.bundledExpressExample.queryParameters.payer.value,
      paymentPayload.payload.authorization.from,
    );
    assert.match(
      settlement.result.structuredContent.nextStep.bundledExpressExample.retryPath,
      /\?txHash=.*&payer=/u,
    );

    const oneShot = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "create_and_settle_jpyc_payment",
        arguments: {
          url: `${url}/facilitator`,
          paymentRequirements,
        },
      },
    });
    assert.equal(oneShot.result.structuredContent.verification.body.isValid, true);
    assert.equal(oneShot.result.structuredContent.settlement.body.success, true);
    assert.equal(
      oneShot.result.structuredContent.nextStep.action,
      "retry_protected_resource",
    );
    assert.equal(
      oneShot.result.structuredContent.nextStep.bundledExpressExample.queryParameters.txHash.source,
      "settlement.body.txHash",
    );
    assert.equal(
      oneShot.result.structuredContent.nextStep.bundledExpressExample.queryParameters.txHash.value,
      oneShot.result.structuredContent.settlement.body.txHash,
    );
    assert.equal(
      oneShot.result.structuredContent.nextStep.bundledExpressExample.queryParameters.payer.value,
      oneShot.result.structuredContent.paymentPayload.payload.authorization.from,
    );
  } finally {
    await closeServer(server);
  }
});

test("mcp server publishes 402 handling guidance in initialize instructions and tool metadata", async () => {
  const mcp = createMcpServer();

  const initialize = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "jpyc-x402-test",
        version: "0.2.0",
      },
    },
  });

  assert.match(initialize.result.instructions, /402 Payment Required/u);
  assert.match(initialize.result.instructions, /accepts\[0\]/u);
  assert.match(initialize.result.instructions, /create_and_settle_jpyc_payment/u);
  assert.match(initialize.result.instructions, /Do not append \/supported, \/verify, or \/settle/u);
  assert.match(initialize.result.instructions, /txHash=settlement\.body\.txHash/u);
  assert.match(initialize.result.instructions, /nextStep\.bundledExpressExample/u);

  const tools = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });

  const createTool = tools.result.tools.find((tool) => tool.name === "create_jpyc_payment");
  const verifyTool = tools.result.tools.find((tool) => tool.name === "verify_jpyc_payment");
  const settleTool = tools.result.tools.find((tool) => tool.name === "settle_jpyc_payment");
  const oneShotTool = tools.result.tools.find((tool) => tool.name === "create_and_settle_jpyc_payment");

  assert.ok(createTool);
  assert.ok(verifyTool);
  assert.ok(settleTool);
  assert.ok(oneShotTool);

  assert.match(createTool.description, /Manual step 1 after a 402 challenge/u);
  assert.match(
    createTool.inputSchema.properties.paymentRequirements.description,
    /body\.accepts\[0\]/u,
  );
  assert.match(verifyTool.description, /Optional manual step 2/u);
  assert.match(
    verifyTool.inputSchema.properties.paymentPayload.description,
    /create_jpyc_payment/u,
  );
  assert.match(settleTool.description, /Manual final step after create_jpyc_payment/u);
  assert.match(
    settleTool.inputSchema.properties.paymentRequirements.description,
    /paymentPayload\.accepted/u,
  );
  assert.match(oneShotTool.description, /Recommended reaction to a 402 Payment Required challenge/u);
  assert.match(
    oneShotTool.inputSchema.properties.url.description,
    /Do not include \/supported, \/verify, or \/settle/u,
  );
});

test("mcp server reports a clear error when url already includes a facilitator action", async () => {
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
  const mcp = createMcpServer({
    signerOptions: {
      privateKey: payerPrivateKey,
      config,
    },
  });
  const paymentRequirements = createJpycExactPaymentRequirements({
    config,
    amount,
    payTo: seller,
    resource: "/posts/premium",
  });

  try {
    await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "jpyc-x402-test",
          version: "0.2.0",
        },
      },
    });

    const createdPayment = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "create_jpyc_payment",
        arguments: {
          paymentRequirements,
        },
      },
    });
    const paymentPayload = createdPayment.result.structuredContent.paymentPayload;

    const settlement = await mcp.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "settle_jpyc_payment",
        arguments: {
          url: `${url}/facilitator/settle`,
          paymentPayload,
          paymentRequirements,
        },
      },
    });

    assert.equal(settlement.result.isError, true);
    assert.match(settlement.result.structuredContent.error, /Pass the facilitator base URL instead/u);
    assert.match(settlement.result.structuredContent.error, /appends \/settle internally/u);
    assert.match(settlement.result.structuredContent.error, /facilitator\/settle/u);
  } finally {
    await closeServer(server);
  }
});
