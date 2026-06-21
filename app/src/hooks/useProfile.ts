import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { PKG_TYPE } from '../config';

export type Profile = { profileId: string; managerId: string };

// PlayerProfile is a `key`-only owned object delivered to the caller by create_profile_open.
// The struct type resolves to the ORIGINAL package id (PKG_TYPE), not the v2 call target.
// gRPC core API: `listOwnedObjects` with a struct `type` filter; `json` carries the fields
// (shape may be flat or `.fields`-wrapped across API impls — tolerate both, per reads.ts).
export function useProfile() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  return useQuery({
    enabled: !!account,
    queryKey: ['profile', account?.address],
    queryFn: async (): Promise<Profile | null> => {
      const { objects } = await client.core.listOwnedObjects({
        owner: account!.address,
        type: `${PKG_TYPE}::league::PlayerProfile`,
        include: { json: true },
      });
      const obj = objects[0];
      if (!obj) return null;
      const json = (obj.json ?? {}) as Record<string, any>;
      const managerId = (json.predict_manager ?? json.fields?.predict_manager) as string;
      return { profileId: obj.objectId, managerId };
    },
  });
}
