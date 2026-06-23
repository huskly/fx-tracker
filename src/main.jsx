import React from "react";
import { createRoot } from "react-dom/client";
import FXPositionTracker from "./fx-position-tracker.jsx";
import "./styles.css";

const STORAGE_PREFIX = "fx-tracker:";

if (!window.storage) {
  window.storage = {
    async get(key) {
      const value = window.localStorage.getItem(`${STORAGE_PREFIX}${key}`);
      return value === null ? null : { value };
    },
    async set(key, value) {
      window.localStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
      return { value };
    },
  };
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <FXPositionTracker />
  </React.StrictMode>,
);
