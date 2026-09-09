import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
// Imported before the app so `ThemeProvider`'s module side-effect writes
// `data-theme` onto <html> before the first paint. See ThemeProvider.tsx.
import { ThemeProvider } from "./theme/ThemeProvider.js";
import "./styles/global.css";

const container = document.getElementById("root");
if (!container) throw new Error("Renderer root element is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
