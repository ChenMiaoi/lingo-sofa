import { createRoot } from "react-dom/client";
import { ProviderPage } from "../../src/ProviderPage.js";
import { App } from "../../src/App.js";
import "../popup/style.css";
document.body.classList.add("options-page");
createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).get("view") === "activity" ? (
    <App />
  ) : (
    <ProviderPage />
  ),
);
