// dApp Kit 2.x (Path B): single `createDAppKit` factory + gRPC client.
// NOTE (plan deviation): the P1 plan was written against the deprecated `@mysten/dapp-kit`
// three-provider API. Per the sui-frontend skill, new projects use `@mysten/dapp-kit-react`
// 2.x with `createDAppKit`/`DAppKitProvider` and `SuiGrpcClient`. There is no CSS import
// (UI components are Lit web components, self-styled via shadow DOM).
//
// OPEN RISK (verify first in Task 3): browser gRPC-web reads against the public fullnode.
// If SuiGrpcClient reads are blocked from the browser, swap createClient to a JSON-RPC/GraphQL
// client (both implement the same core API the dApp Kit consumes) — the architecture is unchanged.
import { createDAppKit } from '@mysten/dapp-kit-react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { registerEnokiWallets } from '@mysten/enoki';
import { ENOKI_API_KEY, GOOGLE_CLIENT_ID } from '../config';

const GRPC_URLS: Record<string, string> = {
  testnet: 'https://fullnode.testnet.sui.io:443',
};

// Capture the testnet client so the same instance is shared with Enoki's sponsored flow.
const testnetClient = new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC_URLS.testnet });

export const dAppKit = createDAppKit({
  networks: ['testnet'],
  defaultNetwork: 'testnet',
  createClient: (network) =>
    network === 'testnet'
      ? testnetClient
      : new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network] }),
});

// Register the instance type so hooks (useCurrentAccount, useDAppKit, ...) are typed.
declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}

// Register Enoki zkLogin wallets into the wallet-standard registry BEFORE React mounts /
// autoConnect runs. Guarded by env so a keyless `npm run build`/`dev` still works.
if (ENOKI_API_KEY && GOOGLE_CLIENT_ID) {
  registerEnokiWallets({
    apiKey: ENOKI_API_KEY,
    providers: { google: { clientId: GOOGLE_CLIENT_ID } },
    client: testnetClient,
    network: 'testnet',
  });
} else if (import.meta.env.DEV) {
  console.warn('[enoki] VITE_ENOKI_API_KEY / VITE_GOOGLE_CLIENT_ID not set — Google sign-in disabled.');
}
