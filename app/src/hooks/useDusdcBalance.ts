import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { DUSDC } from '../config';

// DUSDC funding is manual in P1 (admin transfers to the user's address). Poll so the gate in
// App.tsx flips from "waiting for funding" to Markets without a refresh once funds land.
export function useDusdcBalance() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  return useQuery({
    enabled: !!account,
    queryKey: ['dusdc', account?.address],
    queryFn: async (): Promise<bigint> => {
      const { balance } = await client.core.getBalance({ owner: account!.address, coinType: DUSDC });
      return BigInt(balance.balance);
    },
    refetchInterval: 10_000,
  });
}
