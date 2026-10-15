import { installDocumentAppearance } from "../../src/appearance.js";
import { createRoot } from "react-dom/client";
import { ProviderPage } from "../../src/ProviderPage.js";
import "../popup/style.css";
document.body.classList.add("options-page");
installDocumentAppearance(document);
// Keep bookmarked activity links within the unified settings workspace.
const url = new URL(location.href);
if (url.searchParams.get("view") === "activity") {
  url.searchParams.delete("view");
  url.hash = "usage";
  history.replaceState(null, "", url);
}
createRoot(document.getElementById("root")!).render(<ProviderPage />);
