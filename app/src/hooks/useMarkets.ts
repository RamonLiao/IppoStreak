import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { fetchMarkets } from '../lib/reads';

// PATH B: client comes from `useCurrentClient` (the registered SuiGrpcClient), not the
// deprecated dapp-kit `useSuiClient`. Markets re-poll every 30s (oracles expire on a ~15min
// cadence and spot drifts continuously).
export function useMarkets() {
  const client = useCurrentClient();
  return useQuery({
    queryKey: ['markets'],
    queryFn: () => fetchMarkets(client),
    refetchInterval: 30_000,
  });
}
