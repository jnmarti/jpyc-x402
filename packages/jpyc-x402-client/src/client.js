function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? "").replace(/\/+$/u, "");
}

function createFacilitatorRequest(baseUrl, action) {
  const inputUrl = normalizeBaseUrl(baseUrl);
  const actionEndpoint = inputUrl.match(/\/(supported|verify|settle)$/u)?.[1] ?? null;

  return {
    action,
    inputUrl,
    actionEndpoint,
    url: `${inputUrl}/${action}`,
  };
}

function withFacilitatorUrlHint(request, promise) {
  return promise.catch((error) => {
    if (request.actionEndpoint) {
      const hintedBaseUrl = request.inputUrl.replace(/\/(supported|verify|settle)$/u, "");

      error.message += ` The provided url looks like a facilitator action endpoint (${request.inputUrl}). Pass the facilitator base URL instead, for example ${hintedBaseUrl}; this client appends /${request.action} internally.`;
    }

    throw error;
  });
}

function createJsonInit(init = {}, body) {
  const headers = new Headers(init.headers ?? {});

  headers.set("content-type", "application/json");

  return {
    ...init,
    method: init.method ?? "POST",
    headers,
    body: JSON.stringify(body),
  };
}

function normalizePayment(input = {}, fallbackRequirements = null) {
  const paymentPayload = input.paymentPayload ?? input;
  const paymentRequirements = input.paymentRequirements
    ?? fallbackRequirements
    ?? input.paymentPayload?.accepted
    ?? null;

  if (!paymentPayload || !paymentRequirements) {
    throw new Error("Expected paymentPayload and paymentRequirements.");
  }

  return {
    x402Version: input.x402Version ?? paymentPayload.x402Version ?? 1,
    paymentPayload,
    paymentRequirements,
  };
}

async function readJsonResponse(response, requestUrl = null) {
  const text = await response.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      const contentType = response.headers.get("content-type") ?? "unknown";
      const snippet = text.replace(/\s+/gu, " ").trim().slice(0, 160);
      const resolvedRequestUrl = response.url || requestUrl || null;
      let message = `Expected JSON response from ${resolvedRequestUrl ?? "facilitator"}, but received invalid JSON (${response.status} ${response.statusText}, content-type: ${contentType}).`;

      if (snippet) {
        message += ` Response snippet: ${JSON.stringify(snippet)}.`;
      }

      throw Object.assign(new Error(message), {
        cause: error,
        responseText: text,
        responseStatus: response.status,
        responseStatusText: response.statusText,
      });
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    bodyText: text,
    body,
  };
}

export async function fetchFacilitatorSupported(baseUrl, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const request = createFacilitatorRequest(baseUrl, "supported");
  const response = await fetchFn(request.url, options.init);
  const summary = await withFacilitatorUrlHint(
    request,
    readJsonResponse(response, request.url),
  );

  return {
    url: request.url,
    ...summary,
  };
}

export async function verifyJpycPayment(baseUrl, payment, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const normalized = normalizePayment(payment, options.paymentRequirements);
  const request = createFacilitatorRequest(baseUrl, "verify");
  const response = await fetchFn(
    request.url,
    createJsonInit(options.init, normalized),
  );
  const summary = await withFacilitatorUrlHint(request, readJsonResponse(response, request.url));

  return {
    url: request.url,
    paymentPayload: normalized.paymentPayload,
    paymentRequirements: normalized.paymentRequirements,
    ...summary,
  };
}

export async function settleJpycPayment(baseUrl, payment, options = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const normalized = normalizePayment(payment, options.paymentRequirements);
  const request = createFacilitatorRequest(baseUrl, "settle");
  const response = await fetchFn(
    request.url,
    createJsonInit(options.init, normalized),
  );
  const summary = await withFacilitatorUrlHint(request, readJsonResponse(response, request.url));

  return {
    url: request.url,
    paymentPayload: normalized.paymentPayload,
    paymentRequirements: normalized.paymentRequirements,
    ...summary,
  };
}

export async function createSignedJpycPayment(paymentRequirements, signer, options = {}) {
  return signer.signAuthorization({
    paymentRequirements,
    ...options,
  });
}

export async function createAndSettleJpycPayment(baseUrl, paymentRequirements, signer, options = {}) {
  const payment = await createSignedJpycPayment(paymentRequirements, signer, options);
  const verification = await verifyJpycPayment(baseUrl, payment, options);

  if (!verification.body?.isValid) {
    return {
      paymentPayload: payment.paymentPayload,
      paymentRequirements: payment.paymentRequirements,
      verification,
      settlement: null,
    };
  }

  const settlement = await settleJpycPayment(baseUrl, payment, options);

  return {
    paymentPayload: payment.paymentPayload,
    paymentRequirements: payment.paymentRequirements,
    verification,
    settlement,
  };
}
