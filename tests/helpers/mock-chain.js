import { randomBytes } from "node:crypto";

import { getAddress, recoverTypedDataAddress, signatureToHex } from "viem";

import { createVerificationResult } from "../../packages/jpyc-x402-shared/src/index.js";
import { createEip3009TypedData } from "../../packages/jpyc-x402-shared/src/x402.js";

function randomHash() {
  return `0x${randomBytes(32).toString("hex")}`;
}

export function createMockChain(options = {}) {
  const chainId = options.chainId ?? 80002;
  const tokenAddress = getAddress(
    options.tokenAddress ?? "0x34E1Cd120Ba2618c1142a4622de47f5DA82Fe04a",
  );
  const tokenName = options.tokenName ?? "JPY Coin";
  const tokenVersion = options.tokenVersion ?? "1";
  const defaultConfirmations = options.confirmations ?? 1;
  const estimateContractGasError = options.estimateContractGasError ?? null;
  const gasEstimate = BigInt(options.gasEstimate ?? 120_000);
  const nativeBalance = BigInt(options.nativeBalance ?? 10n ** 18n);
  const transfers = new Map();
  const usedAuthorizations = new Set();
  let latestBlockNumber = BigInt(options.startBlock ?? 1000);
  let latestTimestampMs = options.startTimeMs ?? Date.now();

  function createAuthorizationKey(from, nonce) {
    return `${getAddress(from)}:${String(nonce).toLowerCase()}`;
  }

  return {
    config: {
      chainId,
      tokenAddress,
      confirmations: defaultConfirmations,
    },

    advance({ blocks = 1, seconds = 12 } = {}) {
      latestBlockNumber += BigInt(blocks);
      latestTimestampMs += seconds * 1000;
    },

    createSigner(address) {
      const payer = getAddress(address);

      return {
        async getAddress() {
          return payer;
        },

        async sendTokenTransfer(input) {
          latestBlockNumber += 1n;
          latestTimestampMs += 12_000;

          const txHash = randomHash();
          transfers.set(txHash.toLowerCase(), {
            txHash,
            payer,
            recipient: getAddress(input.recipient),
            amount: String(input.amount),
            tokenAddress: getAddress(input.tokenAddress),
            chainId: input.chainId,
            blockNumber: latestBlockNumber,
            timestampMs: latestTimestampMs,
          });

          return {
            txHash,
            payer,
          };
        },
      };
    },

    createVerifier() {
      return {
        async verify({ invoice, proof }) {
          const transfer = transfers.get(String(proof.txHash).toLowerCase());

          if (!transfer) {
            return createVerificationResult({
              ok: false,
              invoiceId: invoice.invoiceId,
              txHash: proof.txHash,
              reason: "transaction_not_found",
            });
          }

          const confirmations = Number(latestBlockNumber - transfer.blockNumber + 1n);

          if (transfer.chainId !== invoice.chainId) {
            return createVerificationResult({
              ok: false,
              invoiceId: invoice.invoiceId,
              txHash: proof.txHash,
              reason: "wrong_chain",
            });
          }

          if (transfer.tokenAddress !== invoice.tokenAddress) {
            return createVerificationResult({
              ok: false,
              invoiceId: invoice.invoiceId,
              txHash: proof.txHash,
              reason: "wrong_token",
            });
          }

          if (transfer.recipient !== invoice.recipient) {
            return createVerificationResult({
              ok: false,
              invoiceId: invoice.invoiceId,
              txHash: proof.txHash,
              reason: "wrong_recipient",
            });
          }

          if (transfer.amount !== invoice.amount) {
            return createVerificationResult({
              ok: false,
              invoiceId: invoice.invoiceId,
              txHash: proof.txHash,
              reason: "wrong_amount",
            });
          }

          if (confirmations < invoice.confirmations) {
            return createVerificationResult({
              ok: false,
              invoiceId: invoice.invoiceId,
              txHash: proof.txHash,
              reason: "not_enough_confirmations",
            });
          }

          if (transfer.timestampMs > Date.parse(invoice.expiresAt)) {
            return createVerificationResult({
              ok: false,
              invoiceId: invoice.invoiceId,
              txHash: proof.txHash,
              reason: "invoice_expired",
            });
          }

          return createVerificationResult({
            ok: true,
            invoiceId: invoice.invoiceId,
            txHash: proof.txHash,
            payer: transfer.payer,
            recipient: transfer.recipient,
            tokenAddress: transfer.tokenAddress,
            amount: transfer.amount,
            chainId: transfer.chainId,
            confirmations,
            blockNumber: Number(transfer.blockNumber),
          });
        },
      };
    },

    createFacilitatorClients(submitterAddress) {
      const submitter = getAddress(submitterAddress);
      let submitterNonce = 0;

      const publicClient = {
        async readContract({ address, functionName, args = [] }) {
          if (getAddress(address) !== tokenAddress) {
            throw new Error("wrong_token");
          }

          if (functionName === "name") {
            return tokenName;
          }

          if (functionName === "authorizationState") {
            return usedAuthorizations.has(createAuthorizationKey(args[0], args[1]));
          }

          throw new Error(`Unsupported readContract call: ${functionName}`);
        },

        async simulateContract({ address, functionName, args = [] }) {
          if (getAddress(address) !== tokenAddress) {
            throw new Error("wrong_token");
          }

          if (functionName !== "transferWithAuthorization") {
            throw new Error(`Unsupported simulateContract call: ${functionName}`);
          }

          const [from, to, value, validAfter, validBefore, nonce, v, r, s] = args;
          const authorization = {
            from,
            to,
            value: String(value),
            validAfter: String(validAfter),
            validBefore: String(validBefore),
            nonce,
          };
          const signature = signatureToHex({ v, r, s });
          const recoveredAddress = await recoverTypedDataAddress({
            ...createEip3009TypedData({
              chainId,
              tokenAddress,
              tokenName,
              tokenVersion,
              authorization,
            }),
            signature,
          });

          if (recoveredAddress !== getAddress(from)) {
            throw new Error("invalid_signature");
          }

          if (usedAuthorizations.has(createAuthorizationKey(from, nonce))) {
            throw new Error("authorization_already_used");
          }

          const nowSeconds = Math.floor(latestTimestampMs / 1000);

          if (Number(validAfter) > nowSeconds) {
            throw new Error("authorization_not_yet_valid");
          }

          if (Number(validBefore) <= nowSeconds) {
            throw new Error("authorization_expired");
          }

          return {
            request: {
              address,
              functionName,
              args,
            },
          };
        },

        async estimateContractGas({ address, functionName, args = [] }) {
          await publicClient.simulateContract({
            address,
            functionName,
            args,
          });

          if (estimateContractGasError) {
            throw new Error(estimateContractGasError);
          }

          return gasEstimate;
        },

        async estimateFeesPerGas() {
          return {
            maxFeePerGas: 2n,
            maxPriorityFeePerGas: 1n,
          };
        },

        async getTransactionCount({ address }) {
          if (getAddress(address) !== submitter) {
            throw new Error("wrong_sender");
          }

          return submitterNonce;
        },

        async getBalance({ address }) {
          if (getAddress(address) !== submitter) {
            throw new Error("wrong_sender");
          }

          return nativeBalance;
        },
      };

      return {
        publicClient,
        walletClient: {
          account: {
            address: submitter,
            type: "local",
          },
          async writeContract({ address, functionName, args = [], gas, account }) {
            await publicClient.estimateContractGas({
              address,
              functionName,
              args,
            });

            if (typeof account === "string") {
              throw new Error("unexpected_json_rpc_account");
            }

            if (gas !== undefined && gas !== gasEstimate) {
              throw new Error("unexpected_gas");
            }

            const [from, to, value, _validAfter, _validBefore, nonce] = args;

            latestBlockNumber += 1n;
            latestTimestampMs += 12_000;

            const txHash = randomHash();
            transfers.set(txHash.toLowerCase(), {
              txHash,
              payer: getAddress(from),
              recipient: getAddress(to),
              amount: String(value),
              tokenAddress: getAddress(address),
              chainId,
              blockNumber: latestBlockNumber,
              timestampMs: latestTimestampMs,
              submitter,
            });
            usedAuthorizations.add(createAuthorizationKey(from, nonce));
            submitterNonce += 1;

            return txHash;
          },
        },
      };
    },
  };
}
