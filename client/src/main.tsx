import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { startHeartbeat } from "./lib/heartbeat";

if (!window.location.hash) {
  window.location.hash = "#/";
}

startHeartbeat();

createRoot(document.getElementById("root")!).render(<App />);
