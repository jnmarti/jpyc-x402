const state = {
  config: null,
  account: null,
  paymentRequirements: null,
};

const elements = {
  connectButton: document.getElementById("connect-button"),
  unlockButton: document.getElementById("unlock-button"),
  walletSummary: document.getElementById("wallet-summary"),
  networkName: document.getElementById("network-name"),
  invoicePrice: document.getElementById("invoice-price"),
  invoiceStatus: document.getElementById("invoice-status"),
  statusMessage: document.getElementById("status-message"),
  articleActions: document.getElementById("article-actions"),
  txLink: document.getElementById("tx-link"),
  postSection: document.getElementById("post-section"),
  postTitle: document.getElementById("post-title"),
  postDek: document.getElementById("post-dek"),
  postAuthor: document.getElementById("post-author"),
  postRole: document.getElementById("post-role"),
  postDate: document.getElementById("post-date"),
  postReadTime: document.getElementById("post-read-time"),
  postPreview: document.getElementById("post-preview"),
  articleContinuation: document.getElementById("article-continuation"),
  flowItems: Array.from(document.querySelectorAll("[data-flow-step]")),
};

function hasEthereum() {
  return typeof window.ethereum !== "undefined";
}

function setStatus(message, tone = "neutral") {
  elements.statusMessage.textContent = message;
  elements.statusMessage.dataset.tone = tone;
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

function formatUnits(value, decimals = 18) {
  const raw = BigInt(value).toString();
  const padded = raw.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/u, "");

  return fraction ? `${whole}.${fraction}` : whole;
}

function shortHash(value, leading = 6, trailing = 4) {
  if (!value) {
    return "";
  }

  const text = String(value);

  if (text.length <= leading + trailing + 3) {
    return text;
  }

  return `${text.slice(0, leading + 2)}…${text.slice(-trailing)}`;
}

function createNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function setFlowProgress(progress) {
  const finalIndex = elements.flowItems.length;

  elements.flowItems.forEach((item, index) => {
    let nextState = "idle";

    if (progress >= finalIndex || index < progress) {
      nextState = "done";
    } else if (index === progress) {
      nextState = "active";
    }

    item.dataset.state = nextState;
  });
}

function setRequirementSummary(paymentRequirements, label = "Locked") {
  const amount = paymentRequirements?.maxAmountRequired ?? state.config?.price?.amount;
  const decimals = paymentRequirements ? 18 : (state.config?.price?.decimals ?? 18);
  const symbol = state.config?.price?.symbol ?? "JPYC";

  elements.invoicePrice.textContent = amount ? `${formatUnits(amount, decimals)} ${symbol}` : "-";
  elements.invoiceStatus.textContent = label;
}

function renderArticleMeta(article) {
  elements.postSection.textContent = article.section ?? "AI Commerce";
  elements.postTitle.textContent = article.title ?? "Premium article";
  elements.postDek.textContent = article.dek ?? "";
  elements.postAuthor.textContent = article.author ?? "Editorial desk";
  elements.postRole.textContent = article.authorRole ?? "";
  elements.postDate.textContent = article.publishedAt ?? "";
  elements.postReadTime.textContent = article.readTime ?? "";
}

function setTransactionLink(txHash) {
  if (txHash && state.config?.network?.explorerUrl) {
    elements.txLink.href = `${state.config.network.explorerUrl}/tx/${txHash}`;
    elements.articleActions.classList.remove("hidden");
    elements.txLink.classList.remove("hidden");
    return;
  }

  elements.txLink.href = "#";
  elements.txLink.classList.add("hidden");
  elements.articleActions.classList.add("hidden");
}

function runTransition(update) {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  if (typeof document.startViewTransition === "function" && !prefersReducedMotion) {
    document.startViewTransition(update);
    return;
  }

  update();
}

function showPremiumPost(body) {
  const paragraphs = (body.paragraphs ?? [])
    .map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`)
    .join("");

  runTransition(() => {
    renderArticleMeta(body);
    setTransactionLink(body.verification?.txHash ?? null);
    document.body.classList.add("article-unlocked");
    elements.articleContinuation.classList.remove("is-locked");
    elements.articleContinuation.classList.add("is-unlocked");
    elements.articleContinuation.innerHTML = paragraphs;
  });
}

function resetWalletSummary() {
  state.account = null;
  elements.walletSummary.textContent = "MetaMask not connected";
  elements.connectButton.textContent = "Connect MetaMask";
  elements.connectButton.disabled = false;

  if (!document.body.classList.contains("article-unlocked")) {
    elements.invoiceStatus.textContent = "Locked";
    setFlowProgress(0);
  }
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

  const chainIdHex = await ethereumRequest("eth_chainId");
  const chainId = Number.parseInt(chainIdHex, 16);
  const chainLabel = chainId === state.config.network.chainId
    ? state.config.network.chainName
    : `Chain ${chainId}`;

  elements.walletSummary.textContent = `${shortHash(state.account)} on ${chainLabel}`;
  elements.connectButton.textContent = "Wallet connected";
}

async function connectWallet() {
  if (!hasEthereum()) {
    throw new Error("MetaMask was not found in this browser.");
  }

  const accounts = await ethereumRequest("eth_requestAccounts");
  state.account = accounts[0];
  await ensureMetaMaskChain();
  await refreshWalletSummary();
  setFlowProgress(1);
  setRequirementSummary(state.paymentRequirements, "Ready");
  setStatus("Wallet connected. Review the price and unlock when you're ready.");
}

async function loadConfig() {
  const { body } = await fetchJson("/");

  state.config = body;
  elements.networkName.textContent = body.network.chainName;
  elements.unlockButton.textContent = `Unlock for ${formatUnits(body.price.amount, body.price.decimals)} ${body.price.symbol}`;
  setRequirementSummary(null, "Locked");
}

async function loadFreePost() {
  const { body } = await fetchJson("/posts/free");
  renderArticleMeta(body);
  elements.postPreview.textContent = body.preview ?? body.body ?? "";
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
  setRequirementSummary(paymentRequirements, "Awaiting signature");

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
  setTransactionLink(null);

  if (!state.account) {
    setStatus("Connecting to MetaMask...");
    await connectWallet();
  } else {
    await ensureMetaMaskChain();
    await refreshWalletSummary();
  }

  setStatus("Requesting payment requirements for this article.");
  const { response, body, paymentRequirements } = await requestPremiumRoute();

  if (response.status === 200) {
    showPremiumPost(body);
    setFlowProgress(elements.flowItems.length);
    setRequirementSummary(state.paymentRequirements, "Unlocked");
    setStatus("The article is already unlocked.", "success");
    return;
  }

  setFlowProgress(1);
  setStatus("Asking MetaMask to sign the JPYC authorization.");
  const signedPayment = await signPayment(paymentRequirements);

  setFlowProgress(2);
  setStatus("The facilitator is verifying the signature and preparing settlement.");
  const verification = await postFacilitator("/verify", signedPayment);

  if (!verification.isValid) {
    throw new Error(verification.invalidReason ?? "Facilitator rejected the payment.");
  }

  setRequirementSummary(paymentRequirements, "Authorized");
  setStatus("Authorization verified. Settling payment onchain.");
  const settlement = await postFacilitator("/settle", signedPayment);

  if (!settlement.success) {
    throw new Error(settlement.error ?? "Facilitator settlement failed.");
  }

  setRequirementSummary(paymentRequirements, "Settled");
  setStatus("Settlement confirmed. Rechecking the protected route.");
  const premiumUrl = `/posts/premium?txHash=${encodeURIComponent(settlement.txHash)}&payer=${encodeURIComponent(state.account)}`;
  const { response: premiumResponse, body: premiumBody } = await fetchJson(premiumUrl);

  if (premiumResponse.status !== 200) {
    throw new Error(premiumBody?.message ?? premiumBody?.error ?? `Unexpected status: ${premiumResponse.status}`);
  }

  setFlowProgress(elements.flowItems.length);
  setRequirementSummary(paymentRequirements, "Unlocked");
  setStatus("Article unlocked. The protected route accepted the settlement proof.", "success");
  showPremiumPost(premiumBody);
  await refreshWalletSummary();
}

function bindEthereumEvents() {
  if (!hasEthereum() || typeof window.ethereum.on !== "function") {
    return;
  }

  window.ethereum.on("accountsChanged", async (accounts) => {
    if (!accounts[0]) {
      resetWalletSummary();

      if (!document.body.classList.contains("article-unlocked")) {
        setStatus("MetaMask disconnected. Reconnect to unlock the article.", "error");
      }

      return;
    }

    state.account = accounts[0];

    try {
      await refreshWalletSummary();

      if (!document.body.classList.contains("article-unlocked")) {
        setFlowProgress(1);
        setRequirementSummary(state.paymentRequirements, "Ready");
        setStatus("Wallet updated. You can continue the unlock flow.");
      }
    } catch (error) {
      setStatus(`Wallet update failed. ${formatError(error)}`, "error");
    }
  });

  window.ethereum.on("chainChanged", async () => {
    if (!state.account) {
      return;
    }

    try {
      await refreshWalletSummary();
    } catch (error) {
      setStatus(`Network update failed. ${formatError(error)}`, "error");
    }
  });
}

function syncScrollProgress() {
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  const progress = scrollable > 0 ? window.scrollY / scrollable : 0;
  document.documentElement.style.setProperty("--scroll-progress", String(progress));
}

async function restoreExistingWallet() {
  const accounts = await ethereumRequest("eth_accounts");

  if (!accounts[0]) {
    return;
  }

  state.account = accounts[0];
  await refreshWalletSummary();
  setFlowProgress(1);
  setRequirementSummary(state.paymentRequirements, "Ready");
  setStatus("Connected wallet detected. Unlock when you're ready.");
}

async function bootstrap() {
  setFlowProgress(0);
  syncScrollProgress();
  window.addEventListener("scroll", syncScrollProgress, { passive: true });

  await Promise.all([
    loadConfig(),
    loadFreePost(),
  ]);
  setStatus("Connect MetaMask to begin the unlock flow.");

  if (!hasEthereum()) {
    elements.connectButton.disabled = true;
    elements.unlockButton.disabled = true;
    setStatus("MetaMask was not detected in this browser.", "error");
    return;
  }

  bindEthereumEvents();
  await restoreExistingWallet();

  elements.connectButton.addEventListener("click", async () => {
    try {
      await connectWallet();
    } catch (error) {
      setStatus(`Wallet connection failed. ${formatError(error)}`, "error");
    }
  });

  elements.unlockButton.addEventListener("click", async () => {
    elements.unlockButton.disabled = true;

    try {
      await unlockPremiumPost();
    } catch (error) {
      setRequirementSummary(state.paymentRequirements, "Retry needed");
      setStatus(`Unlock failed. ${formatError(error)}`, "error");
    } finally {
      elements.unlockButton.disabled = false;
    }
  });
}

bootstrap().catch((error) => {
  setStatus(`Initialization failed. ${formatError(error)}`, "error");
});
