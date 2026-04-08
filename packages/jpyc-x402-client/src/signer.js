import { privateKeyToAccount } from "viem/accounts";

import {
  createEip3009Nonce,
  createEip3009TypedData,
  createJpycExactPaymentPayload,
  createJpycExactPaymentRequirements,
  getRequiredEnv,
  resolveJpycConfig,
} from "jpyc-x402-shared";

export function createViemAuthorizationSigner(options = {}) {
  const config = options.config ?? resolveJpycConfig(options);
  const account = privateKeyToAccount(
    options.privateKey ?? getRequiredEnv("BUYER_PRIVATE_KEY"),
  );

  return {
    config,

    async getAddress() {
      return account.address;
    },

    async signAuthorization(input = {}) {
      const paymentRequirements = createJpycExactPaymentRequirements({
        ...input.paymentRequirements,
        config,
      });
      const nowSeconds = Math.floor(Date.now() / 1000);
      const authorization = {
        from: input.from ?? input.payer ?? account.address,
        to: input.to ?? paymentRequirements.payTo,
        value: input.value ?? paymentRequirements.maxAmountRequired,
        validAfter: input.validAfter ?? (nowSeconds - 60),
        validBefore: input.validBefore ?? (nowSeconds + (input.ttlSeconds ?? 300)),
        nonce: input.nonce ?? createEip3009Nonce(),
      };
      const signature = await account.signTypedData(
        createEip3009TypedData({
          chainId: config.chainId,
          tokenAddress: paymentRequirements.asset,
          tokenName: paymentRequirements.extra.name,
          tokenVersion: paymentRequirements.extra.version,
          authorization,
        }),
      );
      const paymentPayload = createJpycExactPaymentPayload({
        x402Version: input.x402Version,
        paymentRequirements,
        authorization,
        signature,
      });

      return {
        paymentRequirements,
        authorization,
        signature,
        paymentPayload,
      };
    },
  };
}
