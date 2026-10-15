import { installDocumentAppearance } from "../../src/appearance.js";
import { createRoot } from "react-dom/client";
import { QuickPopup } from "../../src/QuickPopup.js";
import "./quick.css";
installDocumentAppearance(document);
createRoot(document.getElementById("root")!).render(<QuickPopup />);
