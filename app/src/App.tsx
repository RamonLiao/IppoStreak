import { useCurrentAccount } from '@mysten/dapp-kit-react';
import Login from './pages/Login';

export default function App() {
  const account = useCurrentAccount();
  if (!account) return <Login />;
  // Replaced by the real authed shell in later tasks.
  return <div className="p-6 font-mono text-sm">Connected: {account.address}</div>;
}
