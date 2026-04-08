import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import express from "express";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { startStdioMcpServer } from "../packages/jpyc-x402-mcp/src/index.js";
import {
  createJpycFacilitatorRouter,
} from "../packages/jpyc-x402-facilitator/src/index.js";
import {
  createJpycExactPaymentRequirements,
  encodeTokenAmount,
  resolveJpycConfig,
} from "../packages/jpyc-x402-shared/src/index.js";
import { createMockChain } from "../tests/helpers/mock-chain.js";

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

function createJsonRpcLineClient(input, output) {
  let nextId = 1;
  let buffer = "";
  const pending = new Map();

  output.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    while (buffer.includes("\n")) {
      const newlineIndex = buffer.indexOf("\n");
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      const message = JSON.parse(line);
      const resolver = pending.get(message.id);

      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      const request = {
        jsonrpc: "2.0",
        id,
        method,
        params,
      };

      return new Promise((resolve) => {
        pending.set(id, resolve);
        input.write(`${JSON.stringify(request)}\n`);
      });
    },

    notify(method, params) {
      input.write(`${JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
      })}\n`);
    },
  };
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

async function main() {
  const config = resolveJpycConfig({ env: "testnet" });
  const amount = encodeTokenAmount("1", config.decimals);
  const seller = "0x1111111111111111111111111111111111111111";
  const payerPrivateKey = generatePrivateKey();
  const facilitatorSubmitter = privateKeyToAccount(generatePrivateKey());
  const paymentRequirements = createJpycExactPaymentRequirements({
    config,
    amount,
    payTo: seller,
    resource: "/posts/premium",
  });
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
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const errorChunks = [];

  errors.on("data", (chunk) => {
    errorChunks.push(chunk.toString("utf8"));
  });

  startStdioMcpServer({
    input,
    output,
    errorOutput: errors,
    signerOptions: {
      privateKey: payerPrivateKey,
      config,
    },
  });

  const client = createJsonRpcLineClient(input, output);

  try {
    const initialize = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "jpyc-x402-smoke",
        version: "0.2.0",
      },
    });
    client.notify("notifications/initialized", {});
    assert.equal(initialize.result.serverInfo.name, "jpyc-x402-mcp");

    const tools = await client.request("tools/list", {});
    const names = tools.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, [
      "facilitator_supported",
      "create_jpyc_payment",
      "verify_jpyc_payment",
      "settle_jpyc_payment",
      "create_and_settle_jpyc_payment",
    ]);

    const supported = await client.request("tools/call", {
      name: "facilitator_supported",
      arguments: {
        url: `${url}/facilitator`,
      },
    });
    assert.equal(supported.result.structuredContent.body.kinds.length, 1);

    const payment = await client.request("tools/call", {
      name: "create_jpyc_payment",
      arguments: {
        paymentRequirements,
      },
    });
    const paymentPayload = payment.result.structuredContent.paymentPayload;
    assert.ok(paymentPayload.payload.signature);

    const verified = await client.request("tools/call", {
      name: "verify_jpyc_payment",
      arguments: {
        url: `${url}/facilitator`,
        paymentPayload,
        paymentRequirements,
      },
    });
    assert.equal(verified.result.structuredContent.body.isValid, true);

    const settled = await client.request("tools/call", {
      name: "settle_jpyc_payment",
      arguments: {
        url: `${url}/facilitator`,
        paymentPayload,
        paymentRequirements,
      },
    });
    assert.equal(settled.result.structuredContent.body.success, true);

    const oneShot = await client.request("tools/call", {
      name: "create_and_settle_jpyc_payment",
      arguments: {
        url: `${url}/facilitator`,
        paymentRequirements,
      },
    });
    assert.equal(oneShot.result.structuredContent.verification.body.isValid, true);
    assert.equal(oneShot.result.structuredContent.settlement.body.success, true);

    if (errorChunks.length > 0) {
      throw new Error(errorChunks.join(""));
    }

    console.log("MCP smoke test passed.");
  } finally {
    await closeServer(server);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
