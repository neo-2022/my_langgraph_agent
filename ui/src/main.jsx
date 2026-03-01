import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// React Flow styles
import "reactflow/dist/style.css";

import "./index.css";
import "./railLogo.css";
import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
