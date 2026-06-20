import { useMarkets } from '../hooks/useMarkets';

// Oracle prices carry 9 implied decimals (e.g. spot 63955070622009 == $63,955.07).
const PRICE_SCALE = 1_000_000_000n;
function fmtUsd(v: bigint): string {
  const whole = v / PRICE_SCALE;
  return `$${Number(whole).toLocaleString('en-US')}`;
}

export default function Markets({ onPick }: { onPick: (oracleId: string) => void }) {
  const { data, isLoading, error } = useMarkets();

  if (isLoading) return <div className="p-6">Loading markets…</div>;
  if (error) return <div className="p-6 text-red-600">Failed to load markets: {String(error)}</div>;
  if (!data?.length) return <div className="p-6 text-gray-500">No live BTC markets right now.</div>;

  return (
    <div className="p-6 grid gap-3 max-w-xl mx-auto">
      <h2 className="text-xl font-semibold">Live BTC Markets</h2>
      {data.map((m) => (
        <button
          key={m.oracleId}
          onClick={() => onPick(m.oracleId)}
          className="border rounded p-3 text-left hover:bg-gray-50"
        >
          <div className="font-medium">
            BTC · strike {fmtUsd(m.strike)}
          </div>
          <div className="text-sm text-gray-500">
            spot {fmtUsd(m.spot)} · expires {new Date(Number(m.expiry)).toLocaleTimeString()}
          </div>
        </button>
      ))}
    </div>
  );
}
