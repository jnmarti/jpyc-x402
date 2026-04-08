import "dotenv/config";

import {
  createAndSettleJpycPayment,
  createViemAuthorizationSigner,
} from "jpyc-x402-client";
import { getRequiredEnv, resolveJpycConfig } from "jpyc-x402-shared";

const config = resolveJpycConfig();
const port = Number(process.env.BLOG_PORT ?? 4021);
const facilitatorUrl = process.env.FACILITATOR_URL ?? `http://127.0.0.1:${port}/facilitator`;
const requirementsUrl = process.env.PAYMENT_REQUIREMENTS_URL
  ?? `http://127.0.0.1:${port}/requirements/premium-post`;

async function main() {
  const signer = createViemAuthorizationSigner({
    privateKey: getRequiredEnv("BUYER_PRIVATE_KEY"),
    config,
  });
  const response = await fetch(requirementsUrl);
  const payload = await response.json();
  const result = await createAndSettleJpycPayment(
    facilitatorUrl,
    payload.paymentRequirements,
    signer,
  );

  console.log("Facilitator:", facilitatorUrl);
  console.log("Requirements:", requirementsUrl);
  console.log("Verification:");
  console.log(JSON.stringify(result.verification.body, null, 2));
  console.log("Settlement:");
  console.log(JSON.stringify(result.settlement?.body ?? null, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
