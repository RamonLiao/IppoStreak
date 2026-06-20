import { useCurrentAccount } from '@mysten/dapp-kit-react';
import Login from './pages/Login';
import Markets from './pages/Markets';

export default function App() {
  const account = useCurrentAccount();
  if (!account) return <Login />;
  // Pick routing lands in Task 5; for now log the chosen oracle.
  return (
    <div className="min-h-screen">
      <div className="p-4 font-mono text-xs text-gray-500 border-b">
        Connected: {account.address}
      </div>
      <Markets onPick={(oracleId) => console.log('picked oracle', oracleId)} />
    </div>
  );
}
