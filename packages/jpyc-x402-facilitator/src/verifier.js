import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  parseEventLogs,
} from "viem";

import {
  createVerificationResult,
  isExpiredAt,
  resolveJpycConfig,
} from "jpyc-x402-shared";

function normalizeHash(hash) {
  return String(hash).toLowerCase();
}

export function createViemTransferVerifier(options = {}) {
  const config = options.config ?? resolveJpycConfig(options);
  const publicClient = options.publicClient ?? createPublicClient({
    chain: config.viemChain,
    transport: http(config.rpcUrl),
  });

  return {
    async verify({ invoice, proof }) {
      if (proof.chainId !== invoice.chainId) {
        return createVerificationResult({
          ok: false,
          invoiceId: invoice.invoiceId,
          txHash: proof.txHash,
          reason: "wrong_chain",
        });
      }

      if (normalizeHash(proof.tokenAddress) !== normalizeHash(invoice.tokenAddress)) {
        return createVerificationResult({
          ok: false,
          invoiceId: invoice.invoiceId,
          txHash: proof.txHash,
          reason: "wrong_token",
        });
      }

      let receipt;

      try {
        receipt = await publicClient.waitForTransactionReceipt({
          hash: proof.txHash,
          confirmations: invoice.confirmations,
          timeout: options.receiptTimeoutMs ?? 20_000,
        });
      } catch (error) {
        return createVerificationResult({
          ok: false,
          invoiceId: invoice.invoiceId,
          txHash: proof.txHash,
          reason: error instanceof Error ? error.message : "receipt_not_found",
        });
      }

      if (receipt.status !== "success") {
        return createVerificationResult({
          ok: false,
          invoiceId: invoice.invoiceId,
          txHash: proof.txHash,
          reason: "transaction_failed",
        });
      }

      const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
      const confirmations = Math.max(invoice.confirmations, receipt.blockNumber ? 1 : 0);

      const invoiceExpiredAtBlock = isExpiredAt(
        invoice.expiresAt,
        Number(block.timestamp) * 1000,
      );

      if (invoiceExpiredAtBlock) {
        return createVerificationResult({
          ok: false,
          invoiceId: invoice.invoiceId,
          txHash: proof.txHash,
          reason: "invoice_expired",
        });
      }

      const matchingTransfers = parseEventLogs({
        abi: erc20Abi,
        logs: receipt.logs,
        eventName: "Transfer",
        strict: false,
      }).filter((event) => {
        const args = event.args ?? {};

        return (
          normalizeHash(event.address) === normalizeHash(invoice.tokenAddress)
          && normalizeHash(args.from ?? "") === normalizeHash(proof.payer)
          && normalizeHash(args.to ?? "") === normalizeHash(invoice.recipient)
          && String(args.value ?? "") === String(invoice.amount)
        );
      });

      if (matchingTransfers.length !== 1) {
        return createVerificationResult({
          ok: false,
          invoiceId: invoice.invoiceId,
          txHash: proof.txHash,
          reason: "matching_transfer_not_found",
        });
      }

      const payer = getAddress(proof.payer);

      return createVerificationResult({
        ok: true,
        invoiceId: invoice.invoiceId,
        txHash: proof.txHash,
        payer,
        recipient: invoice.recipient,
        tokenAddress: invoice.tokenAddress,
        amount: invoice.amount,
        chainId: invoice.chainId,
        confirmations,
        blockNumber: Number(receipt.blockNumber),
      });
    },
  };
}
