# AI-Powered Maintenance Predictor | MCSA & Multimodal Fault Detection

HMI dashboard prototype for an ESP32 multi-channel data acquisition unit monitoring a single-phase AC motor / pump test rig.
**Engineering Technology — Bahrain Polytechnic**

**Supervisor:** Dr. Abdulla Desmal

**Team:** Abdulla Zuhiar (202301078) · Jassim Hayyan (202303646) · Abdulla Marhoon (202303667)

## Features
- Live telemetry cards with derived values: current (peak, THD, load), voltage (frequency, deviation, IEC ±10% check), temperature (ambient, rise, heating rate, time to trip), vibration (X/Y/Z axes, peak, crest factor, dominant frequency)
- MCSA current spectrum in dBc with slip-based sideband positions at (1 ± 2s)f, plus a vibration spectrum tab and marker tables with OK / Warning / Critical grading
- Time-domain features: RMS, kurtosis, crest factor, power factor, current THD
- Electrical power (P, S, Q, energy), motor speed, slip, load and estimated run-capacitor value
- Subsystem health, and remaining useful life
- AI fault classification (Random Forest / SVM) with probability bars and key evidence
- Fault injection simulator: run capacitor wear, dynamic rotor unbalance, flow restriction
- Hover (or tap) tooltips on metrics, markers, faults and sensors showing the formula and a plain-language explanation
- Emergency shutdown / relay trip with auto-trip, event log and data acquisition channel table

**Status:** prototype phase with **simulated** telemetry. Hardware integration (live ESP32 data) will follow once the rig is ready. To use real data, replace the `tick()` function in `src/App.jsx` with your ESP32 WebSocket or HTTP feed.

## Run locally
```bash
npm install
npm run dev
```

## Deploy
**GitHub:** create a new repository, then
```bash
git init
git add .
git commit -m "Initial commit: MCSA maintenance predictor dashboard"
git branch -M main
git remote add origin https://github.com/<your-username>/mcsa-predictor-dashboard.git
git push -u origin main
```
**Vercel:** go to vercel.com/new, import the GitHub repository and click Deploy. Vercel detects Vite automatically (build: `npm run build`, output: `dist`).

## Stack
React 18 · Vite 5 · Tailwind CSS 3
