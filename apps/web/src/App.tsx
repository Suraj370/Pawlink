import { useEffect, useState } from "react";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

type ApiStatus = "checking" | "online" | "offline";

export default function App() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>("checking");

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_URL}/health`)
      .then((res) => (res.ok ? setApiStatus("online") : setApiStatus("offline")))
      .catch(() => {
        if (!cancelled) setApiStatus("offline");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>PawLink</h1>
      <p>This platform is under development.</p>
      <p data-testid="api-status">API status: {apiStatus}</p>
    </main>
  );
}
