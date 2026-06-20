import { ConnectButton } from '@mysten/dapp-kit-react/ui';

export default function Login() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-bold">PredictLeague</h1>
      <p className="text-gray-500">Sign in with Google to play.</p>
      <ConnectButton />
    </div>
  );
}
