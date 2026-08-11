"use client";

import { useState } from "react";

const PRESETS = [
  { id: "gateway", label: "Gateway 8081", hint: "sticky sid" },
  { id: "direct", label: "Direct", hint: "IP VPS" },
  { id: "warp", label: "WARP :40000", hint: "mode proxy" },
  { id: "custom", label: "Custom", hint: "input manual" },
];

const PRESET_URLS = {
  gateway: "http://127.0.0.1:8081",
  warp: "http://127.0.0.1:40000",
  direct: "",
  custom: "",
};

/**
 * Preset proxy picker: Gateway 8081 (sticky sid) / Direct (IP VPS) /
 * WARP :40000 (mode proxy — IP publik VPS tidak berubah) / Custom.
 * Controlled: value = proxyUrl, onChange(url). Preset state internal.
 */
export default function ProxyPresetPicker({ value, onChange, disabled = false }) {
  const [preset, setPreset] = useState(() => {
    if (!value) return "direct";
    if (value.includes("127.0.0.1:8081")) return "gateway";
    if (value.includes("127.0.0.1:40000")) return "warp";
    return "custom";
  });

  const selectPreset = (id) => {
    setPreset(id);
    onChange(PRESET_URLS[id] ?? "");
  };

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          disabled={disabled}
          onClick={() => selectPreset(p.id)}
          className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
            preset === p.id
              ? "border-indigo-400 bg-indigo-500/10"
              : "border-border bg-background hover:bg-white/5"
          }`}
        >
          <p className="text-sm font-medium">{p.label}</p>
          <p className="text-[11px] text-text-muted">{p.hint}</p>
        </button>
      ))}
    </div>
  );
}
