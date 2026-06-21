// All on-chain ids + env. Testnet only.
// PKG is the UPGRADED v2 package (call target for all PTBs). Struct *type* identity still
// resolves to the original publish (0xc76cfc04...) per Sui upgrade rules — do not use the
// original id as a call target.
export const NETWORK = 'testnet' as const;

export const PKG = import.meta.env.VITE_PKG; // new v2 pkg id (Task 1 upgrade) — PTB call target
// Original publish id = the STRUCT TYPE identity. Sui upgrades preserve type identity, so
// on-chain object types (e.g. PlayerProfile) always serialize with THIS id, not the v2 PKG.
// Use for owned-object `type` filters / parsing object types — never as a call target.
export const PKG_TYPE = '0xc76cfc044354aab402cfd007c866a6ba95546bd35783dc251bc28b4cd467e250';
export const LEAGUE = import.meta.env.VITE_LEAGUE; // shared, unchanged across upgrade
export const SUB_REGISTRY = import.meta.env.VITE_SUB_REGISTRY; // shared, unchanged across upgrade

export const PREDICT = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
export const PREDICT_SINGLETON = '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';
export const DUSDC = '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';
export const CLOCK = '0x6';
export const INDEXER = 'https://predict-server.testnet.mystenlabs.com/oracles';

export const ENOKI_API_KEY = import.meta.env.VITE_ENOKI_API_KEY;
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

// DIR_UP = 0 (win if settlement_price >= strike), DIR_DOWN = 1. expiry unit = ms.
export const DIR_UP = 0;
export const DIR_DOWN = 1;
