import { createHash } from "node:crypto";

import express from "express";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  getAddress,
  http,
  parseSignature,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  createEip3009TypedData,
  createJpycExactPaymentRequirements,
  normalizeEip3009Authorization,
  normalizeExactPaymentRequirements,
  resolveJpycConfig,
  transferWithAuthorizationAbi,
  X402_EXACT_SCHEME,
} from "jpyc-x402-shared";

import { createViemTransferVerifier } from "./verifier.js";

function normalizeHash(value) {
  return String(value ?? "").toLowerCase();
}

function parseSerializedJson(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Expected a serialized payment payload string.");
  }

  const normalized = value.trim();

  try {
    return JSON.parse(normalized);
  } catch {
    try {
      return JSON.parse(Buffer.from(normalized, "base64url").toString("utf8"));
    } catch {
      return JSON.parse(Buffer.from(normalized, "base64").toString("utf8"));
    }
  }
}

function readPaymentPayload(request = {}) {
  if (request.paymentPayload) {
    return request.paymentPayload;
  }

  if (request.paymentHeader) {
    return parseSerializedJson(request.paymentHeader);
  }

  if (request.payload?.authorization && request.payload?.signature) {
    return request;
  }

  throw new Error("Facilitator request must include paymentPayload or paymentHeader.");
}

function buildSettlementKey({ paymentPayload, paymentRequirements }) {
  return createHash("sha256")
    .update(JSON.stringify({
      paymentPayload,
      paymentRequirements,
    }))
    .digest("hex");
}

function buildTransferCallArgs(authorization, signature) {
  const parsedSignature = parseSignature(signature);

  return [
    authorization.from,
    authorization.to,
    BigInt(authorization.value),
    BigInt(authorization.validAfter),
    BigInt(authorization.validBefore),
    authorization.nonce,
    parsedSignature.v,
    parsedSignature.r,
    parsedSignature.s,
  ];
}

function getWalletAccountAddress(walletClient) {
  const account = walletClient?.account;

  if (!account) {
    return null;
  }

  if (typeof account === "string") {
    return getAddress(account);
  }

  if (typeof account.address === "string") {
    return getAddress(account.address);
  }

  return null;
}

function getWalletAccount(walletClient) {
  return walletClient?.account ?? null;
}

function buildSettlementRequest({
  paymentRequirements,
  authorization,
  signature,
  account,
  gas,
}) {
  return {
    address: paymentRequirements.asset,
    abi: transferWithAuthorizationAbi,
    functionName: "transferWithAuthorization",
    args: buildTransferCallArgs(authorization, signature),
    ...(account ? { account } : {}),
    ...(gas ? { gas } : {}),
  };
}

function readFeeRequest(feesEstimate = {}) {
  if (
    typeof feesEstimate.maxFeePerGas === "bigint"
    && typeof feesEstimate.maxPriorityFeePerGas === "bigint"
  ) {
    return {
      maxFeePerGas: feesEstimate.maxFeePerGas,
      maxPriorityFeePerGas: feesEstimate.maxPriorityFeePerGas,
    };
  }

  if (typeof feesEstimate.gasPrice === "bigint") {
    return {
      gasPrice: feesEstimate.gasPrice,
    };
  }

  throw new Error("Unable to determine facilitator fee parameters.");
}

function readRelayMaxCost(request = {}) {
  if (typeof request.gas !== "bigint") {
    return null;
  }

  if (typeof request.maxFeePerGas === "bigint") {
    return request.gas * request.maxFeePerGas;
  }

  if (typeof request.gasPrice === "bigint") {
    return request.gas * request.gasPrice;
  }

  return null;
}

function toIsoFromUnixSeconds(value) {
  return new Date(Number(value) * 1000).toISOString();
}

async function readTokenName(publicClient, tokenAddress) {
  return publicClient.readContract({
    address: getAddress(tokenAddress),
    abi: erc20Abi,
    functionName: "name",
  });
}

function createVerificationSummary({
  x402Version,
  paymentRequirements,
  authorization,
  isValid,
  invalidReason = null,
}) {
  return {
    x402Version,
    scheme: paymentRequirements.scheme,
    network: paymentRequirements.network,
    networkId: paymentRequirements.network,
    asset: paymentRequirements.asset,
    payTo: paymentRequirements.payTo,
    amount: paymentRequirements.maxAmountRequired,
    payer: authorization.from,
    isValid,
    invalidReason,
  };
}

function createSettlementSummary({
  x402Version,
  paymentRequirements,
  authorization,
  success,
  error = null,
  txHash = null,
  confirmations,
  blockNumber,
}) {
  return {
    x402Version,
    scheme: paymentRequirements.scheme,
    network: paymentRequirements.network,
    networkId: paymentRequirements.network,
    asset: paymentRequirements.asset,
    payTo: paymentRequirements.payTo,
    amount: paymentRequirements.maxAmountRequired,
    payer: authorization.from,
    success,
    error,
    txHash,
    confirmations,
    blockNumber,
  };
}

function createVerificationInvoice({ paymentRequirements, authorization, config, invoiceId }) {
  return {
    invoiceId,
    chainId: config.chainId,
    tokenAddress: paymentRequirements.asset,
    recipient: paymentRequirements.payTo,
    amount: paymentRequirements.maxAmountRequired,
    confirmations: config.confirmations,
    expiresAt: toIsoFromUnixSeconds(authorization.validBefore),
  };
}

export function createJpycFacilitator(options = {}) {
  const config = options.config ?? resolveJpycConfig(options);
  const facilitatorAccount = options.privateKey
    ? privateKeyToAccount(options.privateKey)
    : null;
  const walletClient = options.walletClient ?? (
    facilitatorAccount
      ? createWalletClient({
        account: facilitatorAccount,
        chain: config.viemChain,
        transport: http(config.rpcUrl),
      })
      : null
  );
  const publicClient = options.publicClient ?? createPublicClient({
    chain: config.viemChain,
    transport: http(config.rpcUrl),
  });
  const transferVerifier = options.transferVerifier ?? createViemTransferVerifier({
    config,
    publicClient,
    receiptTimeoutMs: options.receiptTimeoutMs,
  });
  const settlementCache = options.settlementCache ?? new Map();
  const inFlightSettlements = new Map();
  const settlementAccount = facilitatorAccount
    ?? getWalletAccount(walletClient);
  const settlementSender = facilitatorAccount?.address
    ?? getWalletAccountAddress(walletClient);

  if (!walletClient) {
    throw new Error("createJpycFacilitator requires walletClient or privateKey.");
  }

  async function normalizeRequest(request = {}) {
    const paymentPayload = readPaymentPayload(request);
    const paymentRequirements = normalizeExactPaymentRequirements(
      request.paymentRequirements ?? paymentPayload.accepted ?? {},
      { config },
    );
    const authorization = normalizeEip3009Authorization(
      paymentPayload?.payload?.authorization,
      { now: options.now, ttlSeconds: options.authorizationTtlSeconds },
    );
    const signature = paymentPayload?.payload?.signature;

    if (!signature) {
      throw new Error("Payment payload must include an EIP-3009 signature.");
    }

    const x402Version = request.x402Version
      ?? paymentPayload.x402Version
      ?? 1;

    if (paymentRequirements.scheme !== X402_EXACT_SCHEME) {
      throw new Error(`Unsupported payment scheme: ${paymentRequirements.scheme}`);
    }

    return {
      x402Version,
      paymentPayload,
      paymentRequirements,
      authorization,
      signature,
    };
  }

  async function validateAuthorization(request = {}) {
    const normalized = await normalizeRequest(request);
    const { x402Version, paymentRequirements, authorization, signature } = normalized;

    if (paymentRequirements.network !== config.caip2) {
      return {
        ...normalized,
        verification: createVerificationSummary({
          x402Version,
          paymentRequirements,
          authorization,
          isValid: false,
          invalidReason: "wrong_network",
        }),
      };
    }

    if (normalizeHash(paymentRequirements.asset) !== normalizeHash(config.tokenAddress)) {
      return {
        ...normalized,
        verification: createVerificationSummary({
          x402Version,
          paymentRequirements,
          authorization,
          isValid: false,
          invalidReason: "wrong_asset",
        }),
      };
    }

    if (normalizeHash(authorization.to) !== normalizeHash(paymentRequirements.payTo)) {
      return {
        ...normalized,
        verification: createVerificationSummary({
          x402Version,
          paymentRequirements,
          authorization,
          isValid: false,
          invalidReason: "wrong_recipient",
        }),
      };
    }

    if (String(authorization.value) !== String(paymentRequirements.maxAmountRequired)) {
      return {
        ...normalized,
        verification: createVerificationSummary({
          x402Version,
          paymentRequirements,
          authorization,
          isValid: false,
          invalidReason: "wrong_amount",
        }),
      };
    }

    const tokenName = paymentRequirements.extra?.name
      ?? await readTokenName(publicClient, paymentRequirements.asset);
    const tokenVersion = paymentRequirements.extra?.version ?? "1";
    const typedData = createEip3009TypedData({
      chainId: config.chainId,
      tokenAddress: paymentRequirements.asset,
      tokenName,
      tokenVersion,
      authorization,
    });

    let recoveredAddress;

    try {
      recoveredAddress = await recoverTypedDataAddress({
        ...typedData,
        signature,
      });
    } catch (error) {
      return {
        ...normalized,
        verification: createVerificationSummary({
          x402Version,
          paymentRequirements,
          authorization,
          isValid: false,
          invalidReason: error instanceof Error ? error.message : "invalid_signature",
        }),
      };
    }

    if (normalizeHash(recoveredAddress) !== normalizeHash(authorization.from)) {
      return {
        ...normalized,
        verification: createVerificationSummary({
          x402Version,
          paymentRequirements,
          authorization,
          isValid: false,
          invalidReason: "signature_sender_mismatch",
        }),
      };
    }

    try {
      const authorizationUsed = await publicClient.readContract({
        address: paymentRequirements.asset,
        abi: transferWithAuthorizationAbi,
        functionName: "authorizationState",
        args: [authorization.from, authorization.nonce],
      });

      if (authorizationUsed) {
        return {
          ...normalized,
          verification: createVerificationSummary({
            x402Version,
            paymentRequirements,
            authorization,
            isValid: false,
            invalidReason: "authorization_already_used",
          }),
        };
      }
    } catch {
      // Some environments may not expose authorizationState cleanly. The simulation below
      // is the authoritative check for settlement readiness.
    }

    const settlementRequest = buildSettlementRequest({
      paymentRequirements,
      authorization,
      signature,
      account: settlementSender ?? authorization.from,
    });

    try {
      await publicClient.simulateContract(settlementRequest);
    } catch (error) {
      return {
        ...normalized,
        verification: createVerificationSummary({
          x402Version,
          paymentRequirements,
          authorization,
          isValid: false,
          invalidReason: error instanceof Error ? error.message : "authorization_not_settleable",
        }),
      };
    }

    let estimatedGas;

    try {
      // Mirror the local-account relay path used by writeContract so `/verify`
      // cannot green-light a payment that the facilitator cannot actually send.
      estimatedGas = await publicClient.estimateContractGas(settlementRequest);
    } catch (error) {
      return {
        ...normalized,
        verification: createVerificationSummary({
          x402Version,
          paymentRequirements,
          authorization,
          isValid: false,
          invalidReason: error instanceof Error ? error.message : "authorization_not_relayable",
        }),
      };
    }

    let relayRequest = buildSettlementRequest({
      paymentRequirements,
      authorization,
      signature,
      account: settlementAccount,
      gas: estimatedGas,
    });

    if (settlementSender) {
      try {
        const [nonce, feesEstimate] = await Promise.all([
          publicClient.getTransactionCount({
            address: settlementSender,
            blockTag: "pending",
          }),
          publicClient.estimateFeesPerGas(),
        ]);

        relayRequest = {
          ...relayRequest,
          chainId: config.chainId,
          nonce,
          ...readFeeRequest(feesEstimate),
        };
      } catch (error) {
        return {
          ...normalized,
          verification: createVerificationSummary({
            x402Version,
            paymentRequirements,
            authorization,
            isValid: false,
          invalidReason: error instanceof Error ? error.message : "relay_request_preparation_failed",
        }),
      };
      }
    }

    if (settlementSender) {
      try {
        const relayMaxCost = readRelayMaxCost(relayRequest);

        if (relayMaxCost !== null) {
          const facilitatorBalance = await publicClient.getBalance({
            address: settlementSender,
          });

          if (facilitatorBalance < relayMaxCost) {
            return {
              ...normalized,
              verification: createVerificationSummary({
                x402Version,
                paymentRequirements,
                authorization,
                isValid: false,
                invalidReason: `facilitator_insufficient_native_balance: ${settlementSender} balance ${facilitatorBalance} wei, requires up to ${relayMaxCost} wei`,
              }),
            };
          }
        }
      } catch (error) {
        return {
          ...normalized,
          verification: createVerificationSummary({
            x402Version,
            paymentRequirements,
            authorization,
            isValid: false,
            invalidReason: error instanceof Error ? error.message : "relay_balance_check_failed",
          }),
        };
      }
    }

    return {
      ...normalized,
      settlementRequest: relayRequest,
      verification: createVerificationSummary({
        x402Version,
        paymentRequirements,
        authorization,
        isValid: true,
      }),
    };
  }

  async function executeSettlement(request = {}) {
    const normalized = await normalizeRequest(request);
    const {
      x402Version,
      paymentPayload,
      paymentRequirements,
      authorization,
      signature,
    } = normalized;
    const settlementKey = buildSettlementKey({
      paymentPayload,
      paymentRequirements,
    });
    const cachedSettlement = settlementCache.get(settlementKey);

    if (cachedSettlement) {
      return cachedSettlement;
    }

    const { verification, settlementRequest } = await validateAuthorization(normalized);

    if (!verification.isValid) {
      return createSettlementSummary({
        x402Version,
        paymentRequirements,
        authorization,
        success: false,
        error: verification.invalidReason,
      });
    }

    const currentSettlement = inFlightSettlements.get(settlementKey);

    if (currentSettlement) {
      return currentSettlement;
    }

    const settlementPromise = (async () => {
      try {
        const txHash = await walletClient.writeContract(settlementRequest);
        const transferVerification = await transferVerifier.verify({
          invoice: createVerificationInvoice({
            paymentRequirements,
            authorization,
            config,
            invoiceId: settlementKey,
          }),
          proof: {
            txHash,
            payer: authorization.from,
            chainId: config.chainId,
            tokenAddress: paymentRequirements.asset,
          },
        });

        if (!transferVerification.ok) {
          return createSettlementSummary({
            x402Version,
            paymentRequirements,
            authorization,
            success: false,
            error: transferVerification.reason,
            txHash,
          });
        }

        const settled = createSettlementSummary({
          x402Version,
          paymentRequirements,
          authorization,
          success: true,
          txHash,
          confirmations: transferVerification.confirmations,
          blockNumber: transferVerification.blockNumber,
        });

        settlementCache.set(settlementKey, settled);
        return settled;
      } catch (error) {
        return createSettlementSummary({
          x402Version,
          paymentRequirements,
          authorization,
          success: false,
          error: error instanceof Error ? error.message : "settlement_failed",
        });
      } finally {
        inFlightSettlements.delete(settlementKey);
      }
    })();

    inFlightSettlements.set(settlementKey, settlementPromise);
    return settlementPromise;
  }

  return {
    config,
    createPaymentRequirements(input = {}) {
      return createJpycExactPaymentRequirements({
        ...input,
        config,
      });
    },

    supported() {
      return {
        kinds: [
          {
            scheme: X402_EXACT_SCHEME,
            network: config.caip2,
          },
        ],
      };
    },

    async verify(request = {}) {
      const { verification } = await validateAuthorization(request);
      return verification;
    },

    async settle(request = {}) {
      return executeSettlement(request);
    },
  };
}

export function createJpycFacilitatorRouter(options = {}) {
  const facilitator = createJpycFacilitator(options);
  const router = express.Router();

  router.use(express.json({
    limit: options.bodyLimit ?? "256kb",
  }));

  router.get("/", (_req, res) => {
    res.json({
      service: "jpyc-x402-facilitator",
      version: "0.2.0",
      network: facilitator.config.caip2,
      endpoints: {
        supported: "GET /supported",
        verify: "POST /verify",
        settle: "POST /settle",
      },
    });
  });

  router.get("/supported", (_req, res) => {
    res.json(facilitator.supported());
  });

  router.post("/verify", async (req, res) => {
    try {
      res.json(await facilitator.verify(req.body ?? {}));
    } catch (error) {
      res.status(400).json({
        isValid: false,
        invalidReason: error instanceof Error ? error.message : String(error),
      });
    }
  });

  router.post("/settle", async (req, res) => {
    try {
      res.json(await facilitator.settle(req.body ?? {}));
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
