import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// React Flow styles
import "reactflow/dist/style.css";

import "./index.css";
import "./railLogo.css";
import App from "./App.jsx";

// Debugger Level 0 (source of truth) — запускается до React render
import { initDebuggerLevel0 } from "./debugger/level0.js";

// MUST be called before React render (Level 0 requirement)
window.__DBG0_ACTIVE__ = true;
initDebuggerLevel0();

// React app start
createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// НЕ выключаем Level 0 после render — он должен собирать ошибки всегда.
window.__DBG0_ACTIVE__ = true;
