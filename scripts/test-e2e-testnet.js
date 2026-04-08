import "dotenv/config";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  createAndSettleJpycPayment,
  createViemAuthorizationSigner,
} from "../packages/jpyc-x402-client/src/index.js";
import { getRequiredEnv, resolveJpycConfig } from "../packages/jpyc-x402-shared/src/index.js";

async function sleep(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForHttp(url, timeoutMs = 30_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);

      if (response.ok) {
        return;
      }
    } catch {
      // ignore until server is ready
    }

    await sleep(1_000);
  }

  throw new Error(`Timed out while waiting for ${url}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) {
    return;
  }

  child.kill("SIGTERM");

  await new Promise((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 5_000);
  });
}

async function main() {
  const config = resolveJpycConfig();

  assert.equal(
    config.env,
    "testnet",
    "test:e2e:testnet only runs against JPYC_ENV=testnet.",
  );

  getRequiredEnv("BUYER_PRIVATE_KEY");
  getRequiredEnv("SELLER_ADDRESS");
  getRequiredEnv("FACILITATOR_PRIVATE_KEY");

  const port = Number(process.env.BLOG_PORT ?? 4021);
  const facilitatorUrl = process.env.FACILITATOR_URL ?? `http://127.0.0.1:${port}/facilitator`;
  const requirementsUrl = process.env.PAYMENT_REQUIREMENTS_URL
    ?? `http://127.0.0.1:${port}/requirements/premium-post`;
  let serverProcess;

  if (!process.env.FACILITATOR_URL || !process.env.PAYMENT_REQUIREMENTS_URL) {
    serverProcess = spawn(
      process.execPath,
      ["examples/express-blog/server.js"],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      },
    );

    await waitForHttp(`http://127.0.0.1:${port}/`);
  }

  try {
    const signer = createViemAuthorizationSigner({
      privateKey: getRequiredEnv("BUYER_PRIVATE_KEY"),
      config,
    });
    const requirementsResponse = await fetch(requirementsUrl);
    const requirementsPayload = await requirementsResponse.json();
    const result = await createAndSettleJpycPayment(
      facilitatorUrl,
      requirementsPayload.paymentRequirements,
      signer,
    );

    assert.equal(result.verification.body.isValid, true, "Expected facilitator verification to pass.");
    assert.equal(result.settlement.body.success, true, "Expected facilitator settlement to pass.");

    console.log("E2E testnet facilitator settlement succeeded.");
    console.log(`Facilitator: ${facilitatorUrl}`);
    console.log(`Requirements: ${requirementsUrl}`);
    console.log(`Tx hash: ${result.settlement.body.txHash}`);
    console.log(JSON.stringify(result.settlement.body, null, 2));
  } finally {
    await stopChild(serverProcess);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
