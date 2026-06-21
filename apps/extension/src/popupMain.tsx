import React from "react";
import { createRoot } from "react-dom/client";
import { Popup } from "./Popup";
import "./styles.css";
import "./popup.css";

createRoot(document.getElementById("root")!).render(<Popup />);
