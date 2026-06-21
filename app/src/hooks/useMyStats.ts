import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { fetchMyState } from '../lib/reads';

// PATH B: client from `useCurrentClient` (the registered SuiGrpcClient).
//
// KEY SEMANTICS: `League.stats` is keyed by the PlayerProfile OBJECT id (the contract uses
// `object::uid_to_address(&profile.id)` as `player`/`profile_addr`), NOT the wallet/sender address.
// So we read by `profileId` (== that object id), never `account.address` — a wallet-keyed read finds
// nothing and a wallet-keyed settle aborts ENoProfileStat. Re-polls every 15s so a pick placed or an
// oracle that just resolved shows up (and a settled pick disappears) without a manual refresh.
export function useMyStats(profileId?: string) {
  const client = useCurrentClient();
  return useQuery({
    enabled: !!profileId,
    queryKey: ['my-state', profileId],
    queryFn: () => fetchMyState(client, profileId!),
    refetchInterval: 15_000,
  });
}
