import { createInterface } from "node:readline";

import {
  createAndSettleJpycPayment,
  createSignedJpycPayment,
  createViemAuthorizationSigner,
  fetchFacilitatorSupported,
  settleJpycPayment,
  verifyJpycPayment,
} from "jpyc-x402-client";

const SERVER_INFO = {
  name: "jpyc-x402-mcp",
  version: "0.2.0",
};

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const FACILITATOR_BASE_URL_DESCRIPTION = "Facilitator base URL, for example http://127.0.0.1:4021/facilitator. Do not include /supported, /verify, or /settle.";
const PAYMENT_REQUIREMENTS_DESCRIPTION = "The full payment requirement object from the 402 challenge entry you are paying, usually body.accepts[0]. Pass it through unchanged; for JPYC exact/eip3009 this includes scheme, network, maxAmountRequired, payTo, asset, resource, and extra.assetTransferMethod.";
const PAYMENT_PAYLOAD_DESCRIPTION = "The exact paymentPayload object returned by create_jpyc_payment. Reuse it unchanged for verify_jpyc_payment or settle_jpyc_payment.";
const MCP_USAGE_INSTRUCTIONS = [
  "Set BUYER_PRIVATE_KEY for the MCP payer wallet. Optional JPYC_ENV, JPYC_RPC_URL, and JPYC_TOKEN_ADDRESS override network defaults.",
  "When a protected HTTP request returns 402 Payment Required, read the JSON challenge and select the accepts entry you intend to pay. In this repository the challenge usually exposes body.accepts[0], which should be passed as paymentRequirements without rebuilding or trimming fields.",
  "Determine the facilitator base URL from the challenge. If the challenge includes facilitatorUrl, resolve it against the protected resource origin. Pass only the facilitator base URL to MCP tools, for example http://127.0.0.1:4021/facilitator. Do not append /supported, /verify, or /settle.",
  "Recommended tool after a 402 challenge: create_and_settle_jpyc_payment({ url, paymentRequirements }). It signs with the MCP payer wallet, verifies the authorization, and settles it in one call.",
  "Manual flow when you need more control: create_jpyc_payment({ paymentRequirements }) -> optional verify_jpyc_payment({ url, paymentPayload, paymentRequirements }) -> settle_jpyc_payment({ url, paymentPayload, paymentRequirements }). paymentPayload must be the exact object returned by create_jpyc_payment. verify_jpyc_payment and settle_jpyc_payment can omit paymentRequirements to reuse paymentPayload.accepted.",
  "facilitator_supported({ url }) is optional and lets you confirm that the facilitator advertises a compatible JPYC exact/eip3009 kind before signing.",
  "After settlement, retry the protected resource with whatever proof that resource server expects. In the bundled express example, replay /posts/premium with txHash=settlement.body.txHash and payer=paymentPayload.payload.authorization.from. The settlement tools also return this replay hint in nextStep.bundledExpressExample.",
].join("\n");

function createToolResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
  };
}

function createProtectedResourceRetryHint(toolName, payload) {
  if (toolName !== "settle_jpyc_payment" && toolName !== "create_and_settle_jpyc_payment") {
    return null;
  }

  const settlement = toolName === "create_and_settle_jpyc_payment"
    ? payload?.settlement
    : payload;
  const txHashSource = toolName === "create_and_settle_jpyc_payment"
    ? "settlement.body.txHash"
    : "body.txHash";
  const txHash = settlement?.body?.txHash ?? null;
  const payer = payload?.paymentPayload?.payload?.authorization?.from ?? null;
  const resourcePath = payload?.paymentRequirements?.resource ?? "/posts/premium";

  return {
    action: "retry_protected_resource",
    note: "Settlement only relays the authorization. Accessing the protected content still requires retrying the original resource request with the proof format expected by that server.",
    bundledExpressExample: {
      proofTransport: "query_parameters",
      method: "GET",
      resourcePath,
      queryParameters: {
        txHash: {
          source: txHashSource,
          value: txHash,
        },
        payer: {
          source: "paymentPayload.payload.authorization.from",
          value: payer,
        },
      },
      retryPath: txHash && payer
        ? `${resourcePath}?txHash=${encodeURIComponent(txHash)}&payer=${encodeURIComponent(payer)}`
        : null,
    },
  };
}

function decorateToolPayload(toolName, payload) {
  const nextStep = createProtectedResourceRetryHint(toolName, payload);

  if (!nextStep) {
    return payload;
  }

  return {
    ...payload,
    nextStep,
  };
}

function createToolError(error) {
  const payload = {
    error: error instanceof Error ? error.message : String(error),
  };

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent: payload,
    isError: true,
  };
}

function normalizeHeaders(headers = {}) {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, String(value)]),
  );
}

function createFetchInit(args = {}) {
  const init = {};

  if (args.method) {
    init.method = args.method;
  }

  if (args.headers) {
    init.headers = normalizeHeaders(args.headers);
  }

  if (typeof args.body === "string") {
    init.body = args.body;
  }

  return init;
}

export function createJpycMcpToolset(options = {}) {
  let signer;

  function getSigner() {
    if (!signer) {
      signer = createViemAuthorizationSigner(options.signerOptions);
    }

    return signer;
  }

  return {
    async facilitator_supported(args = {}) {
      if (!args.url) {
        throw new Error("facilitator_supported requires url.");
      }

      return fetchFacilitatorSupported(args.url, {
        fetchFn: options.fetchFn,
        init: createFetchInit(args),
      });
    },

    async create_jpyc_payment(args = {}) {
      if (!args.paymentRequirements) {
        throw new Error("create_jpyc_payment requires paymentRequirements.");
      }

      return createSignedJpycPayment(
        args.paymentRequirements,
        getSigner(),
        args,
      );
    },

    async verify_jpyc_payment(args = {}) {
      if (!args.url) {
        throw new Error("verify_jpyc_payment requires url.");
      }

      if (!args.paymentPayload) {
        throw new Error("verify_jpyc_payment requires paymentPayload.");
      }

      return verifyJpycPayment(args.url, {
        paymentPayload: args.paymentPayload,
        paymentRequirements: args.paymentRequirements,
      }, {
        fetchFn: options.fetchFn,
        init: createFetchInit(args),
      });
    },

    async settle_jpyc_payment(args = {}) {
      if (!args.url) {
        throw new Error("settle_jpyc_payment requires url.");
      }

      if (!args.paymentPayload) {
        throw new Error("settle_jpyc_payment requires paymentPayload.");
      }

      return settleJpycPayment(args.url, {
        paymentPayload: args.paymentPayload,
        paymentRequirements: args.paymentRequirements,
      }, {
        fetchFn: options.fetchFn,
        init: createFetchInit(args),
      });
    },

    async create_and_settle_jpyc_payment(args = {}) {
      if (!args.url) {
        throw new Error("create_and_settle_jpyc_payment requires url.");
      }

      if (!args.paymentRequirements) {
        throw new Error("create_and_settle_jpyc_payment requires paymentRequirements.");
      }

      return createAndSettleJpycPayment(
        args.url,
        args.paymentRequirements,
        getSigner(),
        {
          fetchFn: options.fetchFn,
          init: createFetchInit(args),
          ...args,
        },
      );
    },
  };
}

export function createMcpServer(options = {}) {
  const toolset = createJpycMcpToolset(options);
  let initialized = false;
  let protocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0];

  const toolDefinitions = [
    {
      name: "facilitator_supported",
      description: "Optional first step after a 402 challenge. Pass the facilitator base URL to confirm the facilitator advertises a compatible JPYC exact/eip3009 kind. The client appends /supported internally.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            format: "uri",
            description: FACILITATOR_BASE_URL_DESCRIPTION,
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "create_jpyc_payment",
      description: "Manual step 1 after a 402 challenge. Pass the full paymentRequirements object from the challenge accepts entry unchanged. Returns paymentPayload for verify_jpyc_payment or settle_jpyc_payment.",
      inputSchema: {
        type: "object",
        properties: {
          paymentRequirements: {
            type: "object",
            description: PAYMENT_REQUIREMENTS_DESCRIPTION,
          },
          validAfter: {
            type: "integer",
            description: "Optional unix timestamp in seconds before which the EIP-3009 authorization is not valid yet.",
          },
          validBefore: {
            type: "integer",
            description: "Optional unix timestamp in seconds after which the EIP-3009 authorization expires.",
          },
          ttlSeconds: {
            type: "integer",
            minimum: 1,
            description: "Optional relative authorization lifetime in seconds. Use this instead of validBefore when you want the signer to derive expiry from the current time.",
          },
          nonce: {
            type: "string",
            description: "Optional 32-byte nonce for the EIP-3009 authorization. If omitted, the signer generates one.",
          },
        },
        required: ["paymentRequirements"],
        additionalProperties: false,
      },
    },
    {
      name: "verify_jpyc_payment",
      description: "Optional manual step 2 after create_jpyc_payment. Pass the facilitator base URL and the exact paymentPayload returned by create_jpyc_payment. The client posts to /verify internally.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            format: "uri",
            description: FACILITATOR_BASE_URL_DESCRIPTION,
          },
          paymentPayload: {
            type: "object",
            description: PAYMENT_PAYLOAD_DESCRIPTION,
          },
          paymentRequirements: {
            type: "object",
            description: "Optional copy of the 402 challenge entry used to create the payment. If omitted, the client reuses paymentPayload.accepted.",
          },
        },
        required: ["url", "paymentPayload"],
        additionalProperties: false,
      },
    },
    {
      name: "settle_jpyc_payment",
      description: "Manual final step after create_jpyc_payment. Pass the facilitator base URL and the exact paymentPayload returned by create_jpyc_payment. The client posts to /settle internally.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            format: "uri",
            description: FACILITATOR_BASE_URL_DESCRIPTION,
          },
          paymentPayload: {
            type: "object",
            description: PAYMENT_PAYLOAD_DESCRIPTION,
          },
          paymentRequirements: {
            type: "object",
            description: "Optional copy of the 402 challenge entry used to create the payment. If omitted, the client reuses paymentPayload.accepted.",
          },
        },
        required: ["url", "paymentPayload"],
        additionalProperties: false,
      },
    },
    {
      name: "create_and_settle_jpyc_payment",
      description: "Recommended reaction to a 402 Payment Required challenge. Pass the facilitator base URL plus the full paymentRequirements object from the challenge accepts entry; the MCP server signs with the payer wallet, verifies, and settles in one call.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            format: "uri",
            description: FACILITATOR_BASE_URL_DESCRIPTION,
          },
          paymentRequirements: {
            type: "object",
            description: PAYMENT_REQUIREMENTS_DESCRIPTION,
          },
          validAfter: {
            type: "integer",
            description: "Optional unix timestamp in seconds before which the EIP-3009 authorization is not valid yet.",
          },
          validBefore: {
            type: "integer",
            description: "Optional unix timestamp in seconds after which the EIP-3009 authorization expires.",
          },
          ttlSeconds: {
            type: "integer",
            minimum: 1,
            description: "Optional relative authorization lifetime in seconds. Use this instead of validBefore when you want the signer to derive expiry from the current time.",
          },
          nonce: {
            type: "string",
            description: "Optional 32-byte nonce for the EIP-3009 authorization. If omitted, the signer generates one.",
          },
        },
        required: ["url", "paymentRequirements"],
        additionalProperties: false,
      },
    },
  ];

  async function handleRequest(request) {
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      throw Object.assign(new Error("Invalid JSON-RPC request."), { code: -32600 });
    }

    if (request.method === "initialize") {
      const requestedVersion = request.params?.protocolVersion;

      if (requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
        protocolVersion = requestedVersion;
      }

      initialized = true;

      return {
        protocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
        instructions: MCP_USAGE_INSTRUCTIONS,
      };
    }

    if (request.method === "notifications/initialized") {
      return null;
    }

    if (request.method === "ping") {
      return {};
    }

    if (!initialized) {
      throw Object.assign(new Error("Server not initialized."), { code: -32002 });
    }

    if (request.method === "tools/list") {
      return { tools: toolDefinitions };
    }

    if (request.method === "tools/call") {
      const toolName = request.params?.name;
      const args = request.params?.arguments ?? {};
      const tool = toolset[toolName];

      if (!tool) {
        throw Object.assign(new Error(`Unknown tool: ${toolName}`), { code: -32601 });
      }

      try {
        const payload = await tool(args);
        return createToolResult(decorateToolPayload(toolName, payload));
      } catch (error) {
        return createToolError(error);
      }
    }

    throw Object.assign(new Error(`Unsupported method: ${request.method}`), { code: -32601 });
  }

  return {
    async handleMessage(request) {
      const id = Object.prototype.hasOwnProperty.call(request, "id") ? request.id : undefined;

      try {
        const result = await handleRequest(request);

        if (typeof id === "undefined" || result === null) {
          return null;
        }

        return {
          jsonrpc: "2.0",
          id,
          result,
        };
      } catch (error) {
        if (typeof id === "undefined") {
          return null;
        }

        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: error?.code ?? -32000,
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}

export function startStdioMcpServer(options = {}) {
  const server = createMcpServer(options);
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const rl = createInterface({
    input,
    crlfDelay: Infinity,
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();

    if (!trimmed) {
      return;
    }

    let request;

    try {
      request = JSON.parse(trimmed);
    } catch (error) {
      errorOutput.write(`Invalid MCP input: ${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }

    const response = await server.handleMessage(request);

    if (response) {
      output.write(`${JSON.stringify(response)}\n`);
    }
  });

  return {
    close() {
      rl.close();
    },
  };
}
