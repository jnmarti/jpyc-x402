import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

console.log("Generated EVM-compatible wallet");
console.log(`Address: ${account.address}`);
console.log(`Private key: ${privateKey}`);
