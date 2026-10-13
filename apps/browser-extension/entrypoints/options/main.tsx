import { createRoot } from "react-dom/client";
import { App } from "../../src/App.js";
import "../popup/style.css";
document.body.classList.add("options-page");
createRoot(document.getElementById("root")!).render(<App />);
