const state = {
  config: null,
  account: null,
  paymentRequirements: null,
};

const elements = {
  connectButton: document.getElementById("connect-button"),
  unlockButton: document.getElementById("unlock-button"),
  walletAddress: document.getElementById("wallet-address"),
  walletChain: document.getElementById("wallet-chain"),
  walletPol: document.getElementById("wallet-pol"),
  walletJpyc: document.getElementById("wallet-jpyc"),
  networkEnv: document.getElementById("network-env"),
  networkName: document.getElementById("network-name"),
  tokenAddress: document.getElementById("token-address"),
  sellerAddress: document.getElementById("seller-address"),
  facilitatorUrl: document.getElementById("facilitator-url"),
  freePostBody: document.getElementById("free-post-body"),
  invoicePrice: document.getElementById("invoice-price"),
  invoiceRecipient: document.getElementById("invoice-recipient"),
  invoiceMethod: document.getElementById("invoice-method"),
  invoiceStatus: document.getElementById("invoice-status"),
  statusLog: document.getElementById("status-log"),
  premiumPost: document.getElementById("premium-post"),
  txLink: document.getElementById("tx-link"),
};

function hasEthereum() {
  return typeof window.ethereum !== "undefined";
}

function setStatus(message) {
  elements.statusLog.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const message = error.message
      ?? error.shortMessage
      ?? error.details
      ?? error.data?.message
      ?? error.data?.originalError?.message;

    if (message) {
      return message;
    }

    try {
      return JSON.stringify(error, null, 2);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

function normalizeHex(value) {
  return value.startsWith("0x") ? value : `0x${value}`;
}

function formatUnits(value, decimals = 18) {
  const raw = BigInt(value).toString();
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/u, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

function toRpcHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function addressWord(address) {
  return normalizeHex(address).slice(2).toLowerCase().padStart(64, "0");
}

function encodeBalanceOfData(address) {
  return `0x70a08231${addressWord(address)}`;
}

function createNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function setRequirementSummary(paymentRequirements, label = "Payment required") {
  if (!paymentRequirements) {
    elements.invoicePrice.textContent = "-";
    elements.invoiceRecipient.textContent = "-";
    elements.invoiceMethod.textContent = "-";
    elements.invoiceStatus.textContent = "Awaiting payment requirements";
    return;
  }

  elements.invoicePrice.textContent = `${formatUnits(paymentRequirements.maxAmountRequired, 18)} JPYC`;
  elements.invoiceRecipient.textContent = paymentRequirements.payTo;
  elements.invoiceMethod.textContent = paymentRequirements.extra?.assetTransferMethod ?? "eip3009";
  elements.invoiceStatus.textContent = label;
}

function showPremiumPost(body) {
  elements.premiumPost.innerHTML = `
    <h3>${escapeHtml(body.title ?? "Premium post")}</h3>
    <p>${escapeHtml(body.body ?? "Unlocked.")}</p>
    <p><strong>Transaction:</strong> <code>${escapeHtml(body.verification?.txHash ?? "n/a")}</code></p>
    <p><strong>Payer:</strong> <code>${escapeHtml(body.verification?.payer ?? "n/a")}</code></p>
  `;
  elements.premiumPost.classList.remove("hidden");
}

async function ethereumRequest(method, params = []) {
  return window.ethereum.request({ method, params });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { response, body };
}

async function ensureMetaMaskChain() {
  const chainIdHex = `0x${state.config.network.chainId.toString(16)}`;

  try {
    await ethereumRequest("wallet_switchEthereumChain", [{ chainId: chainIdHex }]);
  } catch (error) {
    if (error?.code !== 4902) {
      throw error;
    }

    await ethereumRequest("wallet_addEthereumChain", [{
      chainId: chainIdHex,
      chainName: state.config.network.chainName,
      nativeCurrency: {
        name: state.config.network.nativeCurrencyName,
        symbol: state.config.network.nativeCurrencySymbol,
        decimals: 18,
      },
      rpcUrls: [state.config.network.rpcUrl],
      blockExplorerUrls: state.config.network.explorerUrl
        ? [state.config.network.explorerUrl]
        : [],
    }]);
  }
}

async function refreshWalletSummary() {
  if (!state.account) {
    return;
  }

  const [chainIdHex, polHex, tokenHex] = await Promise.all([
    ethereumRequest("eth_chainId"),
    ethereumRequest("eth_getBalance", [state.account, "latest"]),
    ethereumRequest("eth_call", [{
      to: state.config.network.tokenAddress,
      data: encodeBalanceOfData(state.account),
    }, "latest"]),
  ]);
  const chainId = Number.parseInt(chainIdHex, 16);

  elements.walletAddress.textContent = state.account;
  elements.walletChain.textContent = `${state.config.network.chainName} (${chainId})`;
  elements.walletPol.textContent = formatUnits(polHex, 18);
  elements.walletJpyc.textContent = formatUnits(tokenHex, state.config.price.decimals);
}

async function connectWallet() {
  if (!hasEthereum()) {
    throw new Error("MetaMask was not found in this browser.");
  }

  const accounts = await ethereumRequest("eth_requestAccounts");
  state.account = accounts[0];
  await ensureMetaMaskChain();
  await refreshWalletSummary();
  elements.connectButton.textContent = "MetaMask Connected";
}

async function loadConfig() {
  const { body } = await fetchJson("/");

  state.config = body;
  elements.networkEnv.textContent = body.network.env;
  elements.networkName.textContent = `${body.network.chainName} (${body.network.chainId})`;
  elements.tokenAddress.textContent = body.network.tokenAddress;
  elements.sellerAddress.textContent = body.sellerAddress;
  elements.facilitatorUrl.textContent = body.facilitatorUrl;
  setRequirementSummary({
    maxAmountRequired: body.price.amount,
    payTo: body.sellerAddress,
    extra: {
      assetTransferMethod: "eip3009",
    },
  }, "Ready");
}

async function loadFreePost() {
  const { body } = await fetchJson("/posts/free");
  elements.freePostBody.textContent = body.body;
}

async function requestPremiumRoute() {
  const { response, body } = await fetchJson("/posts/premium");

  if (response.status === 200) {
    return { response, body, paymentRequirements: null };
  }

  if (response.status !== 402 || !body?.accepts?.[0]) {
    throw new Error(body?.message ?? body?.error ?? `Unexpected status: ${response.status}`);
  }

  const paymentRequirements = body.accepts[0];
  state.paymentRequirements = paymentRequirements;
  setRequirementSummary(paymentRequirements, "Payment required");

  return { response, body, paymentRequirements };
}

function buildTypedData(paymentRequirements, authorization) {
  return {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    domain: {
      name: paymentRequirements.extra?.name ?? "JPY Coin",
      version: paymentRequirements.extra?.version ?? "1",
      chainId: state.config.network.chainId,
      verifyingContract: paymentRequirements.asset,
    },
    message: authorization,
  };
}

async function signPayment(paymentRequirements) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const authorization = {
    from: state.account,
    to: paymentRequirements.payTo,
    value: paymentRequirements.maxAmountRequired,
    validAfter: String(nowSeconds - 60),
    validBefore: String(nowSeconds + 300),
    nonce: createNonce(),
  };
  const typedData = buildTypedData(paymentRequirements, authorization);
  const signature = await ethereumRequest("eth_signTypedData_v4", [
    state.account,
    JSON.stringify(typedData),
  ]);

  return {
    paymentRequirements,
    paymentPayload: {
      x402Version: 1,
      scheme: paymentRequirements.scheme,
      network: paymentRequirements.network,
      accepted: {
        ...paymentRequirements,
        amount: paymentRequirements.maxAmountRequired,
      },
      payload: {
        signature,
        authorization,
      },
    },
  };
}

async function postFacilitator(path, payload) {
  const { response, body } = await fetchJson(`${state.config.facilitatorUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(body?.error ?? body?.invalidReason ?? `Unexpected status: ${response.status}`);
  }

  return body;
}

async function unlockPremiumPost() {
  elements.premiumPost.classList.add("hidden");
  elements.txLink.classList.add("hidden");

  if (!state.account) {
    await connectWallet();
  }

  setStatus("Requesting premium route payment requirements...");
  const { response, body, paymentRequirements } = await requestPremiumRoute();

  if (response.status === 200) {
    setStatus("The premium route is already accessible.");
    showPremiumPost(body);
    return;
  }

  setStatus("Payment requirements loaded. Asking MetaMask to sign transferWithAuthorization...");
  const signedPayment = await signPayment(paymentRequirements);

  setStatus("Signature created. Sending it to the facilitator for verification...");
  const verification = await postFacilitator("/verify", signedPayment);

  if (!verification.isValid) {
    throw new Error(verification.invalidReason ?? "Facilitator rejected the payment.");
  }

  elements.invoiceStatus.textContent = "Verified";
  setStatus("Facilitator accepted the signature. Settling onchain...");
  const settlement = await postFacilitator("/settle", signedPayment);

  if (!settlement.success) {
    throw new Error(settlement.error ?? "Facilitator settlement failed.");
  }

  elements.invoiceStatus.textContent = "Settled";
  elements.txLink.href = `${state.config.network.explorerUrl}/tx/${settlement.txHash}`;
  elements.txLink.classList.remove("hidden");

  setStatus(`Settlement complete.\nTx hash: ${settlement.txHash}\nRetrying premium route with the settled transaction...`);
  const premiumUrl = `/posts/premium?txHash=${encodeURIComponent(settlement.txHash)}&payer=${encodeURIComponent(state.account)}`;
  const { response: premiumResponse, body: premiumBody } = await fetchJson(premiumUrl);

  if (premiumResponse.status !== 200) {
    throw new Error(premiumBody?.message ?? premiumBody?.error ?? `Unexpected status: ${premiumResponse.status}`);
  }

  elements.invoiceStatus.textContent = "Unlocked";
  setStatus("Payment settled and premium content unlocked.");
  showPremiumPost(premiumBody);
  await refreshWalletSummary();
}

async function bootstrap() {
  await Promise.all([
    loadConfig(),
    loadFreePost(),
  ]);
  setStatus("Ready. Connect MetaMask and unlock the premium route.");

  if (!hasEthereum()) {
    elements.connectButton.disabled = true;
    elements.unlockButton.disabled = true;
    setStatus("MetaMask was not detected in this browser.");
    return;
  }

  elements.connectButton.addEventListener("click", async () => {
    try {
      await connectWallet();
      setStatus("MetaMask connected.");
    } catch (error) {
      setStatus(`Wallet connection failed.\n${formatError(error)}`);
    }
  });

  elements.unlockButton.addEventListener("click", async () => {
    elements.unlockButton.disabled = true;

    try {
      await unlockPremiumPost();
    } catch (error) {
      elements.invoiceStatus.textContent = "Failed";
      setStatus(`Unlock failed.\n${formatError(error)}`);
    } finally {
      elements.unlockButton.disabled = false;
    }
  });
}

bootstrap().catch((error) => {
  setStatus(`Initialization failed.\n${formatError(error)}`);
});
