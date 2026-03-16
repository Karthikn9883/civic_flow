import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import "./styles.css";

const rootContent = import.meta.env.DEV ? (
  <App />
) : (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  rootContent
);
