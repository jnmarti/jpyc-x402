import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";

import {
  createJpycExactPaymentRequirements,
  createJpycFacilitatorRouter,
  createViemTransferVerifier,
} from "jpyc-x402-facilitator";
import { encodeTokenAmount, getRequiredEnv, resolveJpycConfig } from "jpyc-x402-shared";

const app = express();
const config = resolveJpycConfig();
const publicDir = fileURLToPath(new URL("./public", import.meta.url));
const port = Number(process.env.BLOG_PORT ?? 4021);
const sellerAddress = getRequiredEnv("SELLER_ADDRESS");
const amount = process.env.JPYC_PRICE_ASSET_UNITS
  ?? encodeTokenAmount(process.env.JPYC_PRICE_TOKEN_AMOUNT ?? "10", config.decimals);
const verifier = createViemTransferVerifier({ config });

function createPremiumRequirements() {
  return createJpycExactPaymentRequirements({
    config,
    amount,
    payTo: sellerAddress,
    resource: "/posts/premium",
    description: "Premium post access settled by the JPYC facilitator.",
  });
}

function createPremiumInvoice() {
  return {
    invoiceId: "demo-premium-post",
    chainId: config.chainId,
    tokenAddress: config.tokenAddress,
    recipient: sellerAddress,
    amount,
    confirmations: config.confirmations,
    expiresAt: new Date(Date.now() + (24 * 60 * 60 * 1000)).toISOString(),
  };
}

function getSingleQueryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

app.use("/facilitator", createJpycFacilitatorRouter({
  config,
  privateKey: getRequiredEnv("FACILITATOR_PRIVATE_KEY"),
}));
app.use("/demo", express.static(publicDir, {
  extensions: ["html"],
}));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    product: "jpyc-x402 facilitator",
    routes: ["/demo", "/facilitator", "/requirements/premium-post", "/posts/free", "/posts/premium"],
    network: {
      env: config.env,
      chainId: config.chainId,
      chainName: config.chainName,
      tokenAddress: config.tokenAddress,
      rpcUrl: config.rpcUrl,
      explorerUrl: config.explorerUrl,
      nativeCurrencyName: config.nativeCurrencyName,
      nativeCurrencySymbol: config.nativeCurrencySymbol,
    },
    price: {
      amount,
      decimals: config.decimals,
      symbol: config.assetSymbol,
    },
    sellerAddress,
    facilitatorUrl: "/facilitator",
    demoUrl: "/demo/",
  });
});

app.get("/posts/free", (_req, res) => {
  res.json({
    title: "Free post",
    body: "This route is open. The facilitator demo uses the premium route below for the payment flow.",
  });
});

app.get("/requirements/premium-post", (_req, res) => {
  res.json({
    paymentRequirements: createPremiumRequirements(),
  });
});

app.get("/posts/premium", async (req, res) => {
  const txHash = getSingleQueryValue(req.query.txHash);
  const payer = getSingleQueryValue(req.query.payer);
  const paymentRequirements = createPremiumRequirements();

  if (!txHash || !payer) {
    res.setHeader("cache-control", "no-store");
    res.status(402).json({
      error: "payment_required",
      message: "Sign and settle the JPYC facilitator payment to unlock this post.",
      facilitatorUrl: "/facilitator",
      accepts: [paymentRequirements],
    });
    return;
  }

  const verification = await verifier.verify({
    invoice: createPremiumInvoice(),
    proof: {
      txHash,
      payer,
      chainId: config.chainId,
      tokenAddress: config.tokenAddress,
    },
  });

  if (!verification.ok) {
    res.setHeader("cache-control", "no-store");
    res.status(402).json({
      error: "payment_verification_failed",
      message: verification.reason,
      facilitatorUrl: "/facilitator",
      accepts: [paymentRequirements],
      verification,
    });
    return;
  }

  res.json({
    title: "Premium post",
    body: "This premium content was unlocked through a facilitator-settled JPYC EIP-3009 authorization.",
    verification,
  });
});

app.listen(port, () => {
  console.log(`Facilitator example listening on http://127.0.0.1:${port}`);
  console.log(`Browser demo: http://127.0.0.1:${port}/demo/`);
  console.log(`Supported: http://127.0.0.1:${port}/facilitator/supported`);
  console.log(`Verify: POST http://127.0.0.1:${port}/facilitator/verify`);
  console.log(`Settle: POST http://127.0.0.1:${port}/facilitator/settle`);
  console.log(`Example requirements: http://127.0.0.1:${port}/requirements/premium-post`);
  console.log(`Free route: http://127.0.0.1:${port}/posts/free`);
  console.log(`Premium route: http://127.0.0.1:${port}/posts/premium`);
  console.log(`JPYC env: ${config.env} (${config.chainName})`);
  console.log(`Recipient: ${sellerAddress}`);
});
