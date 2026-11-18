import React, { useEffect, useRef, useState } from "react";
import LOGO from "./assets/logo.png";

/* AI-Powered Maintenance Predictor | MCSA & Multimodal Fault Detection
   Engineering Technology — Bahrain Polytechnic · Supervisor: Dr. Abdulla Desmal
   Rig model: single-phase 2-pole induction motor, 50 Hz, run-capacitor start/run, centrifugal pump.
   Telemetry is simulated; replace tick() with your ESP32 WebSocket/HTTP feed. */

const C = { cy: "#38BDF8", teal: "#2DD4BF", ok: "#34D399", warn: "#FBBF24", bad: "#F87171", mut: "#94A3B8" };
const AMB = 31; // lab ambient (GY-906 ambient channel)
const CAP_RATED = 25; // µF run capacitor
const FAULTS = {
  healthy: { name: "Healthy Operation", sev: "Normal", col: C.ok, desc: "All signatures within baseline. No action required.",
    I: 4.2, V: 230.5, T: 42.8, A: 0.35, PF: 0.93, K: 3.0, CF: 3.2, thd: 3.2, slip: 0.032, cap: 25, sbdB: -54, h2dB: -52, h3dB: -44, eccdB: -70, v1: 0.1, v2: 0.03, vl: 0.08, floor: 0.012, load: 82, share: [0.55, 0.62, 0.55], sE: 96, sT: 95, sM: 94, sC: 97, rul: 8400, h: 94, },
  cap: { name: "Run Capacitor Wear", sev: "Warning", col: C.warn, desc: "Capacitance drift: raised current, low power factor, strong lower sideband and 3rd harmonic.",
    I: 4.9, V: 229.4, T: 49.5, A: 0.44, PF: 0.78, K: 3.3, CF: 3.4, thd: 9.5, slip: 0.042, cap: 16.5, sbdB: -34, h2dB: -38, h3dB: -30, eccdB: -66, v1: 0.12, v2: 0.04, vl: 0.2, floor: 0.014, load: 88, share: [0.6, 0.6, 0.5], sE: 70, sT: 78, sM: 88, sC: 22, rul: 420, h: 66, },
  unb: { name: "Dynamic Rotor Unbalance", sev: "Critical", col: C.bad, desc: "Rotation-frequency vibration rise with f ± fr sidebands around the 50 Hz line.",
    I: 4.5, V: 230.1, T: 46.2, A: 1.02, PF: 0.9, K: 2.1, CF: 1.7, thd: 4.4, slip: 0.034, cap: 24.8, sbdB: -46, h2dB: -52, h3dB: -44, eccdB: -34, v1: 0.85, v2: 0.12, vl: 0.08, floor: 0.015, load: 84, share: [0.7, 0.68, 0.2], sE: 90, sT: 80, sM: 18, sC: 95, rul: 96, h: 48, },
  flow: { name: "Flow Restriction (Throttled Valve)", sev: "Warning", col: C.warn, desc: "Reduced hydraulic load: lower current and slip, rising casing temperature, impulsive vibration.",
    I: 3.3, V: 230.3, T: 52.4, A: 0.58, PF: 0.84, K: 4.8, CF: 4.4, thd: 3.8, slip: 0.02, cap: 24.9, sbdB: -50, h2dB: -50, h3dB: -42, eccdB: -68, v1: 0.14, v2: 0.05, vl: 0.08, floor: 0.05, load: 52, share: [0.5, 0.5, 0.7], sE: 80, sT: 58, sM: 75, sC: 90, rul: 260, h: 62, },
};
const KEYS = Object.keys(FAULTS);
const NUM = ["I", "V", "A", "PF", "K", "h", "slip", "cap", "thd", "sbdB", "h2dB", "h3dB", "eccdB", "v1", "v2", "vl", "floor", "CF", "load", "rul", "sE", "sT", "sM", "sC"];
const TRIP = { I: 0, PF: 0, K: 0, A: 0.02, load: 0, v1: 0, v2: 0, vl: 0, floor: 0.004, CF: 0, thd: 0 };
const SEV = { Info: C.cy, Normal: C.ok, Warning: C.warn, Critical: C.bad };
const SENSORS = [
  ["Current", "ACS712-20A", "ESP32 ADC1", "100 mV/A · ±20 A", "10 kS/s"],
  ["Voltage", "ZMPT101B", "ESP32 ADC1", "Isolated AC transformer", "10 kS/s"],
  ["Temperature", "GY-906 (MLX90614)", "I²C 0x5A", "−70…380 °C · ±0.5 °C", "10 Hz"],
  ["Vibration", "MPU6050", "I²C 0x68", "±2 g · 16 384 LSB/g", "1 kHz"],
];

const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;
const stamp = () => new Date().toLocaleTimeString("en-GB");
const pad = (n) => String(n).padStart(2, "0");
const lin = (d) => 10 ** (d / 20);
const gauss = (f, c0, a) => a * Math.exp(-((f - c0) ** 2) / (2 * 0.45 ** 2));
const lvl = (v, w, b) => (v >= b ? C.bad : v >= w ? C.warn : C.ok);
const pkAt = (spec, f) => { const i = Math.round(f * 2); let v = -Infinity; for (let j = i - 2; j <= i + 2; j++) if (spec[j]) v = Math.max(v, spec[j][1]); return v; };
const grade = (v, [w, b]) => (v > b ? ["Critical", C.bad] : v > w ? ["Warning", C.warn] : ["OK", C.ok]);

/* Current spectrum in dB relative to the 50 Hz fundamental (dBc) */
function currentSpec(c, run) {
  const s = c.slip, fr = 50 * (1 - s);
  const pk = [[50, 1], [100, lin(c.h2dB)], [150, lin(c.h3dB)], [50 * (1 - 2 * s), lin(c.sbdB)], [50 * (1 + 2 * s), lin(c.sbdB - 2)], [50 - fr, lin(c.eccdB)], [50 + fr, lin(c.eccdB - 2)]];
  const out = [];
  for (let f = 0; f <= 200; f += 0.5) {
    let a = lin(run ? -78 : -86) * (0.7 + Math.random() * 0.6);
    if (run) for (const [p, h] of pk) a += gauss(f, p, h);
    out.push([f, Math.max(-90, 20 * Math.log10(a))]);
  }
  return out;
}
/* Vibration spectrum (g) */
function vibSpec(c) {
  const fr = 50 * (1 - c.slip), pk = [[fr, c.v1], [2 * fr, c.v2], [100, c.vl]];
  const out = [];
  for (let f = 0; f <= 200; f += 0.5) {
    let a = c.floor * (0.6 + Math.random() * 0.8);
    for (const [p, h] of pk) a += gauss(f, p, h);
    out.push([f, Math.min(a, 1.2)]);
  }
  return out;
}

/* ---------- styles ---------- */
const CSS = `
.mcsa{font-family:Inter,Roboto,system-ui,sans-serif;color:#E2E8F0;min-height:100vh;
background:radial-gradient(900px 480px at 12% -8%,rgba(56,189,248,.10),transparent 60%),radial-gradient(800px 420px at 100% 0,rgba(45,212,191,.07),transparent 60%),#0F172A}
.mcsa .num{font-variant-numeric:tabular-nums}
.mcsa .card{background:linear-gradient(180deg,#223049,#1E293B);border:1px solid #334155;border-radius:16px;padding:20px;transition:border-color .3s;box-shadow:0 8px 24px -12px rgba(0,0,0,.45)}
.mcsa .card:hover{border-color:#475569}
.mcsa .tcard{position:relative;overflow:hidden}
.mcsa .tcard::before{content:"";position:absolute;inset:0 0 auto 0;height:2px;background:linear-gradient(90deg,#38BDF8,#2DD4BF);opacity:.7}
.mcsa .lbl{color:#94A3B8;font-size:13px}
.mcsa .bar{height:8px;border-radius:99px;background:#0F172A;overflow:hidden}
.mcsa .bar>i{display:block;height:100%;border-radius:99px;transition:width .6s ease,background .4s}
.mcsa .chip{display:flex;align-items:center;gap:10px;padding:6px 14px 6px 6px;border-radius:99px;background:#0F172A99;border:1px solid #334155}
.mcsa .av{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:600;background:linear-gradient(135deg,#0ea5e9,#2dd4bf);color:#082f49;flex:none}
.mcsa .av.sup{background:linear-gradient(135deg,#fbbf24,#fb923c);color:#451a03}
.mcsa .stat{padding:8px 14px;border-radius:12px;background:#0F172A80;border:1px solid #33415588}
.mcsa .stat b{display:block;font-size:14px;font-weight:600}
.mcsa .tab{padding:6px 14px;border-radius:99px;font-size:13px;color:#94A3B8;border:1px solid transparent;background:transparent;cursor:pointer;transition:all .2s}
.mcsa .tab[aria-selected=true]{color:#E2E8F0;background:#0F172A;border-color:#38BDF8}
.mcsa .sw{width:42px;height:24px;border-radius:99px;background:#334155;position:relative;transition:background .25s;flex:none;border:0;cursor:pointer}
.mcsa .sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#E2E8F0;transition:transform .25s}
.mcsa .sw[aria-checked=true]{background:#2DD4BF}.mcsa .sw[aria-checked=true]::after{transform:translateX(18px)}
.mcsa .pulse{animation:mcsap 2s infinite}
@keyframes mcsap{0%{box-shadow:0 0 0 0 rgba(52,211,153,.5)}70%{box-shadow:0 0 0 8px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.mcsa button:focus-visible{outline:2px solid #38BDF8;outline-offset:2px}
.mcsa .tip{cursor:help;text-decoration:underline dotted #64748B;text-underline-offset:3px;outline:none}
.mcsa .tipb{display:block;cursor:help;outline:none}
.mcsa .tip:focus-visible,.mcsa .tipb:focus-visible{outline:2px solid #38BDF8;border-radius:6px}
.mcsa .tipbox{position:fixed;z-index:60;pointer-events:none;background:#0B1220;border:1px solid #475569;border-radius:12px;padding:10px 12px;box-shadow:0 12px 32px -8px rgba(0,0,0,.7);font-size:12.5px;line-height:1.45;color:#CBD5E1;font-weight:400;text-align:left;white-space:normal;cursor:default}
.mcsa .tipbox b{display:block;color:#E2E8F0;font-size:13px;margin-bottom:4px;font-weight:600}
.mcsa .tipbox code{display:block;margin:6px 0;padding:6px 8px;border-radius:8px;background:#1E293B;color:#38BDF8;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;white-space:pre-wrap}
@media (prefers-reduced-motion:reduce){.mcsa *{animation:none!important;transition:none!important}}
`;

/* ---------- components ---------- */
const Badge = ({ text, color }) => (
  <span className="text-xs px-2 py-0.5 rounded-full h-fit whitespace-nowrap" style={{ color, background: color + "22" }}>{text}</span>
);
const TIPS = {
  cur: ["Current · ACS712", "I_rms = √( (1/N) · Σ iₖ² )\nI = (V_adc − V_offset) / 0.100 V/A", "Hall-effect sensor read by the ESP32 ADC. The mid-supply offset is removed, then the RMS is taken over each window. Higher current with falling power factor points to a weak run capacitor."],
  vol: ["Voltage · ZMPT101B", "V_rms = √( (1/N) · Σ vₖ² )", "Isolated voltage transformer module. A stable supply is needed so that voltage effects are not mistaken for motor faults."],
  tmp: ["Temperature · GY-906", "T_obj from IR thermopile (MLX90614)", "Contactless infrared sensor aimed at the motor casing. Reports object and ambient temperature over I²C, ±0.5 °C. Warning at 48 °C, trip at 55 °C."],
  vib: ["Vibration · MPU6050", "a_rms = √( x² + y² + z² )  (axis RMS values)\na[g] = raw / 16384  (±2 g range)", "3-axis MEMS accelerometer on the motor housing. Rotor unbalance raises the 1× rotation component, mostly on the radial axes."],
  peakI: ["Peak current", "I_peak ≈ √2 · I_rms", "Valid for a near-sinusoidal current. Distortion makes the true peak higher."],
  thd: ["Total harmonic distortion", "THD = √(I₂² + I₃² + … + Iₙ²) / I₁ × 100 %", "Harmonic content relative to the 50 Hz fundamental. Capacitor wear and magnetic saturation raise it."],
  load: ["Motor load", "Load % ≈ P / P_rated × 100", "Estimated from electrical power against the rated value. A throttled valve lowers it; a jammed rotor raises it."],
  freq: ["Line frequency", "f = 1 / T  (zero-crossing period)", "Measured from the ZMPT101B waveform. The supply frequency sets the fundamental and the sideband positions."],
  dev: ["Voltage deviation", "δV = (V_rms − 230) / 230 × 100 %", "Difference from the 230 V nominal supply."],
  iec: ["IEC 60038 tolerance", "0.9 · 230 V ≤ V ≤ 1.1 · 230 V", "Standard supply tolerance of ±10 %. Outside it, voltage effects can mimic motor faults."],
  amb: ["Ambient temperature", "T_amb (MLX90614 die sensor)", "Surrounding air temperature, used as the reference for the temperature rise."],
  dT: ["Temperature rise", "ΔT = T_surface − T_ambient", "Heat produced by losses. A steady rise above baseline points to overload, poor cooling or winding faults."],
  ttt: ["Time to trip", "t = (T_trip − T) / (dT/dt)", "Linear extrapolation of the current heating rate to the 55 °C trip limit. Shown as — when the temperature is not rising."],
  axis: ["Per-axis vibration", "a_axis = √( (1/N) · Σ aₖ² )", "RMS acceleration along one sensor axis. Unbalance shows mainly on the radial axes (X, Y); misalignment shows more on the axial axis (Z)."],
  peakA: ["Peak acceleration", "a_peak = CF × a_rms", "Highest instantaneous acceleration in the window."],
  crest: ["Crest factor", "CF = x_peak / x_rms", "Sine ≈ 1.41, random noise ≈ 3–4. High values mean impulsive events such as cavitation or looseness."],
  dom: ["Dominant frequency", "f_r = (1 − s) · f", "Frequency of the highest vibration peak. For this motor it is the rotor speed."],
  rmsI: ["RMS current", "I_rms = √( (1/N) · Σ iₖ² )", "Effective heating value of the current over a 1 s window."],
  rmsA: ["Vibration RMS", "a_rms = √( (1/N) · Σ aₖ² )", "Overall vibration energy. Elevated above 0.5 g, trip at 0.9 g."],
  kurt: ["Kurtosis (vibration)", "K = [ (1/N) · Σ (x − μ)⁴ ] / σ⁴", "Shape of the amplitude distribution. Pure sine ≈ 1.5, Gaussian noise ≈ 3. Rotor unbalance pushes it below 3 (sinusoidal); impulsive faults such as cavitation push it above 4."],
  pf: ["Power factor", "PF = P / S = cos φ", "Real power divided by apparent power. A worn run capacitor shifts the phase between the windings and lowers it."],
  S: ["Apparent power", "S = V_rms · I_rms", "Total power drawn from the supply, in kVA."],
  Q: ["Reactive power", "Q = √( S² − P² )", "Power exchanged with the magnetic field and the capacitor, in kvar."],
  kwh: ["Session energy", "E = ∫ P dt ≈ Σ P · Δt / 3600", "Energy used since the dashboard started."],
  rpm: ["Rotor speed", "n = 120 · f · (1 − s) / p\n  = 3000 · (1 − s)  for p = 2", "Estimated from the slip found in the current spectrum."],
  slip: ["Slip", "s = (n_s − n) / n_s\ns = (f_hi − f_lo) / (4f)", "Read from the spacing of the sidebands at (1 ± 2s)f. It rises with load and with capacitor or rotor faults."],
  cap: ["Run capacitor estimate", "C = I_c / (2π · f · V_c)", "Falling capacitance weakens the auxiliary winding field and creates a backward-rotating field that raises the lower sideband. Replace below 90 % of rating."],
  mcsa: ["MCSA · Motor Current Signature Analysis", "X[k] = Σ x[n] · e^(−j2πkn/N)\ndBc = 20 · log₁₀( A / A₅₀Hz )\nf_sb = f · (1 ± 2s)\nΔf = f_s / N ≈ 0.49 Hz", "FFT of the stator current. Rotor and winding faults add sidebands around the 50 Hz line; their level above the noise floor is the fault indicator."],
  vibspec: ["Vibration spectrum", "f_r = (1 − s) · f\n2 · f_r,   2 · f (magnetic hum)", "A peak at 1× rotation indicates unbalance, 2× indicates misalignment or looseness, and 100 Hz comes from magnetic forces."],
  power: ["Electrical power", "P = V · I · cos φ\nS = V · I,   Q = √(S² − P²)", "Real, apparent and reactive power computed from the voltage and current channels."],
  motor: ["Motor and capacitor", "n = 3000 · (1 − s)", "Mechanical state estimated from the current spectrum and the electrical readings."],
  sub: ["Subsystem health", "H = Σ wᵢ · hᵢ", "Each score comes from the sensors that watch it: electrical (current, PF, THD), thermal (GY-906), mechanical (vibration) and capacitor (capacitance, sidebands)."],
  rul: ["Remaining useful life", "RUL ≈ (H_now − H_fail) / (dH/dt)", "Hours until the health score is predicted to reach the failure limit if the trend continues. Values here are illustrative."],
  clf: ["Classifier probabilities", "P(class) = ½ · ( P_RF + P_SVM )", "Random Forest and SVM outputs are averaged. Inputs: sideband levels, THD, PF, RMS, kurtosis, crest factor and temperature rise."],
  inj: ["Fault injection", "", "Switch on one fault to see how every sensor, the spectrum and the classifier respond. Rotor unbalance trips the relay automatically after a few seconds."],
  state: ["Detected operating state", "class = argmax P(class)", "The class with the highest probability."],
  conf: ["Model confidence", "conf = max P(class)", "Probability of the winning class."],
  health: ["System health score", "H = Σ wᵢ · sᵢ", "Fusion of the four sensors and the classifier. Green at 80 % or more, amber 55–79 %, red below 55 %."],
  daq: ["Data acquisition", "Δf = f_s / N", "ADC1 carries current and voltage; I²C carries temperature and vibration. A 2 s window at 10 kS/s gives about 0.5 Hz resolution."],
  prot: ["Active protection", "Trip if a > 0.9 g  or  T > 55 °C", "Time-stamped alarms and relay actions."],
  tdf: ["Time-domain features", "", "Statistics of the raw waveforms, computed on a 1 s window, that feed the classifier."],
  evid: ["Key evidence", "", "The measurements that contribute most to the current classification."],
  conn: ["Connection", "ESP32 → Wi-Fi → dashboard", "Telemetry is streamed at 1 Hz. In this prototype the data is simulated."],
  estop: ["Emergency shutdown", "Relay: CLOSED → OPEN", "Opens the relay and cuts power to the motor. It also trips automatically above 0.9 g vibration."],
  m_f: ["Fundamental", "f = 50 Hz", "Supply frequency, used as the 0 dBc reference."],
  m_lo: ["Lower sideband", "f_lo = (1 − 2s) · f", "Rises with rotor and winding asymmetry, including capacitor wear. Warning above −46 dBc, critical above −38 dBc."],
  m_hi: ["Upper sideband", "f_hi = (1 + 2s) · f", "Mirror of the lower sideband; both rising together confirms an asymmetry."],
  m_h3: ["3rd harmonic", "f₃ = 3 · f = 150 Hz", "Grows with magnetic saturation and with winding or capacitor faults."],
  m_ecc: ["Eccentricity / unbalance", "f_ecc = f ± f_r", "Sidebands spaced by the rotor frequency indicate rotor eccentricity or dynamic unbalance."],
  m_1x: ["1× rotation", "f_r = (1 − s) · f", "Dominant vibration component for rotor unbalance."],
  m_2x: ["2× rotation", "2 · f_r", "Indicates misalignment or looseness."],
  m_2l: ["2× line frequency", "2 · f = 100 Hz", "Magnetic force hum; rises with electrical asymmetry."],
  f_healthy: ["Healthy operation", "All features near baseline", "Sidebands below −46 dBc, PF about 0.93, vibration about 0.35 g."],
  f_cap: ["Run capacitor wear", "C ↓  ⇒  PF ↓,  I ↑,  lower sideband ↑", "A backward-rotating field creates a strong (1 − 2s)f sideband and a higher 3rd harmonic, seen as low PF and high current."],
  f_unb: ["Dynamic rotor unbalance", "F = m · e · ω²", "Centrifugal force at the rotation frequency: 1× vibration rises and f ± f_r sidebands appear in the current."],
  f_flow: ["Flow restriction", "P_hyd = ρ · g · Q · H  ↓", "A throttled valve reduces the load: lower current and slip, higher casing temperature and impulsive (cavitation) vibration."],
  s_Current: ["ACS712-20A", "V_out = V_cc/2 + 0.100 · I", "Hall-effect sensor, 100 mV per ampere, ±20 A range."],
  s_Voltage: ["ZMPT101B", "V_adc ∝ V_mains", "Isolated transformer module with an offset-biased output."],
  s_Temperature: ["GY-906 (MLX90614)", "T_obj, T_amb over I²C", "Infrared thermometer, −70…380 °C, ±0.5 °C."],
  s_Vibration: ["MPU6050", "a[g] = raw / 16384", "16-bit MEMS accelerometer, ±2 g range; 1 kHz sampling covers frequencies up to 500 Hz."],
};
const MK = { "Fundamental f": "m_f", "Lower sideband (1−2s)f": "m_lo", "Upper sideband (1+2s)f": "m_hi", "3rd harmonic 3f": "m_h3", "Eccentricity f + fr": "m_ecc", "1× rotation (fr)": "m_1x", "2× rotation": "m_2x", "2× line (magnetic)": "m_2l" };

function Tip({ k, block, children }) {
  const t = TIPS[k];
  const [p, setP] = useState(null);
  if (!t) return children;
  const show = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const w = Math.min(300, window.innerWidth - 16);
    const x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    const below = r.top < 200;
    setP({ x, w, y: below ? r.bottom + 8 : r.top - 8, below });
  };
  return (
    <span className={block ? "tipb" : "tip"} tabIndex={0} onMouseEnter={show} onMouseLeave={() => setP(null)} onFocus={show} onBlur={() => setP(null)} onClick={p ? () => setP(null) : show}>
      {children}
      {p && (
        <span role="tooltip" className="tipbox" style={{ left: p.x, top: p.y, width: p.w, transform: p.below ? "none" : "translateY(-100%)" }}>
          <b>{t[0]}</b>
          {t[1] && <code>{t[1]}</code>}
          {t[2]}
        </span>
      )}
    </span>
  );
}

const Mini = ({ l, v, k }) => (
  <div><div className="lbl text-[11px]"><Tip k={k}>{l}</Tip></div><div className="text-sm font-medium num">{v}</div></div>
);
const Tile = ({ l, v, u, w, col, sub, k }) => (
  <Tip k={k} block><div className="rounded-xl p-3.5 border border-slate-700" style={{ background: "#0F172A55" }}>
    <div className="lbl text-xs">{l}</div>
    <div className="flex items-baseline gap-1.5"><span className="text-2xl font-semibold num">{v}</span><span className="lbl text-xs">{u}</span></div>
    {w != null && <div className="bar mt-2"><i style={{ width: `${Math.max(0, Math.min(100, w))}%`, background: col || C.cy }} /></div>}
    {sub && <div className="lbl text-[11px] mt-1.5">{sub}</div>}
  </div></Tip>
);

function Spark({ data, color, id, min, max }) {
  const w = 240, h = 44, n = data.length;
  if (n < 2) return <div className="h-11" />;
  const d = data.map((v, i) => {
    const y = Math.max(1, Math.min(h - 1, h - 2 - ((v - min) / (max - min)) * (h - 6)));
    return `${i ? "L" : "M"}${((i / (n - 1)) * w).toFixed(1)} ${y.toFixed(1)}`;
  }).join("");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-11" preserveAspectRatio="none">
      <defs><linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity=".3" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={`${d}L${w} ${h}L0 ${h}Z`} fill={`url(#g${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function TeleCard({ tip, title, sub, value, unit, badge, stats, children }) {
  return (
    <div className="card tcard">
      <div className="flex justify-between gap-2">
        <div><div className="font-medium"><Tip k={tip}>{title}</Tip></div><div className="lbl text-xs">{sub}</div></div>
        <Badge text={badge[0]} color={badge[1]} />
      </div>
      <div className="my-3 text-4xl font-semibold num">{value}<span className="text-lg lbl ml-1">{unit}</span></div>
      {children}
      <div className="grid grid-cols-3 gap-x-2 gap-y-3 mt-4 pt-3 border-t border-slate-700">
        {stats.map(([l, v, k]) => <Mini key={l} l={l} v={v} k={k} />)}
      </div>
    </div>
  );
}

function Spectrum({ data, yMin, yMax, ticks, fmt, marks = [], shade }) {
  const W = 700, H = 270, pl = 46, pb = 26, pt = 16, pw = W - pl - 10, ph = H - pb - pt;
  const X = (f) => pl + (f / 200) * pw;
  const Y = (v) => pt + ph - ((Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin)) * ph;
  const d = data.map(([f, v], i) => `${i ? "L" : "M"}${X(f).toFixed(1)} ${Y(v).toFixed(1)}`).join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Frequency spectrum">
      <defs><linearGradient id="fg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={C.cy} stopOpacity=".35" /><stop offset="1" stopColor={C.cy} stopOpacity="0" /></linearGradient></defs>
      {ticks.map((t) => (
        <g key={t}><line x1={pl} x2={W - 10} y1={Y(t)} y2={Y(t)} stroke="#334155" strokeOpacity=".6" /><text x={pl - 6} y={Y(t) + 4} fill={C.mut} fontSize="10" textAnchor="end">{fmt(t)}</text></g>
      ))}
      {[0, 25, 50, 75, 100, 125, 150, 175, 200].map((f) => (
        <g key={f}><line x1={X(f)} x2={X(f)} y1={pt} y2={pt + ph} stroke="#334155" strokeDasharray="3 4" strokeOpacity=".6" /><text x={X(f)} y={H - 8} fill={C.mut} fontSize="10.5" textAnchor="middle">{f} Hz</text></g>
      ))}
      {shade && <rect x={X(shade[0])} y={pt} width={X(shade[1]) - X(shade[0])} height={ph} fill={C.warn} opacity=".09" rx="6" />}
      <path d={`${d}L${X(200)} ${pt + ph}L${pl} ${pt + ph}Z`} fill="url(#fg)" />
      <path d={d} fill="none" stroke={C.cy} strokeWidth="1.6" strokeLinejoin="round" />
      {marks.map((k, i) => (
        <g key={i}>
          <line x1={X(k.f)} x2={X(k.f)} y1={pt} y2={pt + ph} stroke={k.color} strokeOpacity=".55" strokeDasharray="3 3" />
          <text x={X(k.f) + (k.anchor === "start" ? 4 : k.anchor === "end" ? -4 : 0)} y={pt + 10 + (k.row || 0) * 12} fill={k.color} fontSize="10.5" textAnchor={k.anchor || "middle"}>{k.label}</text>
        </g>
      ))}
    </svg>
  );
}

/* ---------- main ---------- */
export default function MCSADashboard() {
  const [fault, setFaultState] = useState("healthy");
  const [trip, setTripState] = useState(false);
  const [tab, setTab] = useState("mcsa");
  const [log, setLog] = useState(() => [
    { id: 1, time: stamp(), sev: "Normal", ev: "Baseline model loaded · all classes healthy", act: "Monitoring" },
    { id: 0, time: stamp(), sev: "Info", ev: "ESP32 data acquisition unit connected", act: "Streaming 4 channels" },
  ]);
  const [m, setM] = useState(null);
  const faultR = useRef("healthy");
  const tripR = useRef(false);
  const sim = useRef({ c: Object.fromEntries(NUM.map((k) => [k, FAULTS.healthy[k]])), T: 42.8, rate: 0, rpm: 2904, kwh: 0, aI: [], aV: [], aA: [], probs: [1, 0, 0, 0], t: 0, tw: false });

  const addLog = (sev, ev, act) => setLog((l) => [{ id: Math.random(), time: stamp(), sev, ev, act }, ...l].slice(0, 14));
  const doTrip = (auto) => {
    const next = !tripR.current;
    tripR.current = next; setTripState(next);
    if (next) addLog("Critical", auto ? "Vibration above 0.9 g trip limit" : "Operator emergency shutdown", auto ? "Relay tripped automatically" : "Relay tripped manually");
    else addLog("Info", "Operator reset requested", "Relay closed · motor restarted");
  };
  const setFault = (k) => {
    if (k === faultR.current) return;
    faultR.current = k; setFaultState(k);
    const f = FAULTS[k];
    if (k === "healthy") addLog("Normal", "Signatures returned to baseline", "Fault simulation cleared");
    else addLog(f.sev, `${f.name} signature detected`, tripR.current ? "Motor already tripped" : "Alert raised · monitoring");
    if (k === "unb" && !tripR.current) setTimeout(() => { if (faultR.current === "unb" && !tripR.current) doTrip(true); }, 6000);
  };

  useEffect(() => {
    const tick = () => {
      const s = sim.current, c = s.c, f = FAULTS[faultR.current], run = !tripR.current;
      s.t++;
      for (const k of NUM) c[k] += (((!run && k in TRIP) ? TRIP[k] : f[k]) - c[k]) * 0.35;
      s.rpm += ((run ? 3000 * (1 - f.slip) : 0) - s.rpm) * (run ? 0.35 : 0.15);
      const I = Math.max(0, c.I + (run ? (faultR.current === "cap" ? rnd(0.3) : rnd(0.07)) : 0));
      const V = c.V + rnd(0.5);
      const A = Math.max(0, c.A + (run ? rnd(faultR.current === "unb" ? 0.1 : 0.03) : 0));
      const prevT = s.T;
      s.T += ((run ? f.T : AMB) - s.T) * 0.05;
      s.rate += ((s.T - prevT) * 60 - s.rate) * 0.2;
      [[s.aI, I], [s.aV, V], [s.aA, A]].forEach(([a, v]) => { a.push(v); if (a.length > 40) a.shift(); });
      const S = V * I, P = V * I * c.PF, Q = Math.sqrt(Math.max(0, S * S - P * P));
      s.kwh += P / 3.6e6;
      if (run && s.T >= 48 && !s.tw) { s.tw = true; addLog("Warning", `Surface temperature ${s.T.toFixed(1)} °C above 48 °C`, "Alert raised"); }
      if (s.T < 46) s.tw = false;
      const idx = KEYS.indexOf(faultR.current), conf = 0.86 + Math.random() * 0.1;
      const raw = KEYS.map((_, i) => (i === idx ? conf : ((1 - conf) / 3) * (0.5 + Math.random())));
      const sum = raw.reduce((a, b) => a + b);
      s.probs = s.probs.map((p, i) => p + (raw[i] / sum - p) * 0.4);
      return {
        ...c, I, V, A, P, S, Q, kwh: s.kwh, T: s.T, rate: s.rate, rpm: s.rpm, freq: 50 + rnd(0.03), h: Math.round(c.h + (run ? rnd(0.6) : 0)),
        aI: [...s.aI], aV: [...s.aV], aA: [...s.aA], probs: [...s.probs], t: s.t,
        specI: currentSpec(c, run), specV: vibSpec(c),
      };
    };
    let last;
    for (let i = 0; i < 40; i++) last = tick();
    setM(last);
    const id = setInterval(() => setM(tick()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!m) return null;
  const f = FAULTS[fault], run = !trip, idx = KEYS.indexOf(fault);
  const hc = m.h >= 80 ? C.ok : m.h >= 55 ? C.warn : C.bad;
  const dev = m.V - 230, tc = lvl(m.T, 48, 55);
  const up = `${pad(Math.floor(m.t / 3600))}:${pad(Math.floor(m.t / 60) % 60)}:${pad(m.t % 60)}`;
  const s = m.slip, fr = 50 * (1 - s), lo = 50 * (1 - 2 * s), hi = 50 * (1 + 2 * s);
  const norm = f.share.reduce((a, b) => a + b * b, 0) ** 0.5;
  const [ax, ay, az] = f.share.map((x) => (m.A * x) / norm);
  const ttt = run && m.rate > 0.05 && m.T < 55 ? `${Math.min(999, Math.round((55 - m.T) / m.rate))} min` : "—";
  const kd = Math.abs(m.K - 3), kc = kd >= 1.5 ? C.bad : kd >= 0.7 ? C.warn : C.cy;
  const capC = m.cap < 18 ? C.bad : m.cap < 22 ? C.warn : C.ok;
  const sbL = pkAt(m.specI, lo), eccU = pkAt(m.specI, 50 + fr);
  const evidence = { healthy: [`Sidebands ${sbL.toFixed(0)} dBc`, `Power factor ${m.PF.toFixed(2)}`, `Vibration ${m.A.toFixed(2)} g`], cap: [`Lower sideband ${sbL.toFixed(0)} dBc`, `Power factor ${m.PF.toFixed(2)}`, `Capacitance ${m.cap.toFixed(1)} µF`], unb: [`1× vibration ${m.v1.toFixed(2)} g`, `f + fr sideband ${eccU.toFixed(0)} dBc`, `Kurtosis ${m.K.toFixed(1)} (sinusoidal)`], flow: [`Current down to ${m.I.toFixed(1)} A`, `Motor load ${Math.round(m.load)}%`, `Kurtosis ${m.K.toFixed(1)} (impulsive)`] }[fault];
  const team = [["AZ", "Abdulla Zuhiar", "202301078"], ["JH", "Jassim Hayyan", "202303646"], ["AM", "Abdulla Marhoon", "202303667"]];

  const rowsI = [["Fundamental f", 50, pkAt(m.specI, 50), null], ["Lower sideband (1−2s)f", lo, sbL, [-46, -38]], ["Upper sideband (1+2s)f", hi, pkAt(m.specI, hi), [-48, -40]], ["3rd harmonic 3f", 150, pkAt(m.specI, 150), [-38, -28]], ["Eccentricity f + fr", 50 + fr, eccU, [-48, -40]]]
    .map(([n, hz, v, th]) => [n, hz, `${v.toFixed(1)} dBc`, th ? grade(v, th) : ["Reference", C.mut]]);
  const rowsV = [["1× rotation (fr)", fr, pkAt(m.specV, fr), [0.3, 0.7]], ["2× rotation", 2 * fr, pkAt(m.specV, 2 * fr), [0.15, 0.4]], ["2× line (magnetic)", 100, pkAt(m.specV, 100), [0.3, 0.7]]]
    .map(([n, hz, v, th]) => [n, hz, `${v.toFixed(3)} g`, grade(v, th)]);
  const rows = tab === "mcsa" ? rowsI : rowsV;

  return (
    <div className="mcsa">
      <style>{CSS}</style>
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6">

        {/* Identity bar */}
        <div className="card !p-0 overflow-hidden">
          <div className="flex flex-col md:flex-row md:items-stretch">
            <div className="bg-white px-6 py-3 flex items-center justify-center md:justify-start"><img alt="Bahrain Polytechnic" src={LOGO} className="h-12 w-auto" /></div>
            <div className="flex-1 px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="lbl mr-1">Project team</span>
              {team.map(([ini, n, id]) => (
                <div className="chip" key={id}><span className="av">{ini}</span><div className="leading-tight"><div className="text-sm font-medium">{n}</div><div className="text-[11px] lbl num">{id}</div></div></div>
              ))}
            </div>
            <div className="px-5 py-3 flex items-center gap-3 border-t md:border-t-0 md:border-l border-slate-700" style={{ background: "#0F172A55" }}>
              <span className="av sup">AD</span>
              <div className="leading-tight"><div className="lbl text-[11px]">Under the supervision of</div><div className="text-sm font-semibold">Dr. Abdulla Desmal</div></div>
            </div>
          </div>
        </div>

        {/* Header */}
        <header className="card !p-6 flex flex-col gap-6 xl:flex-row xl:items-center xl:justify-between">
          <div className="space-y-3">
            <h1 className="text-2xl sm:text-3xl font-semibold leading-tight tracking-tight">
              AI-Powered Maintenance Predictor <span className="text-slate-600 font-normal">|</span><br className="hidden sm:block" />{" "}
              <span style={{ color: C.cy }}>MCSA &amp; Multimodal Fault Detection</span>
            </h1>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs px-3 py-1 rounded-full border border-slate-600 text-slate-300">Engineering Technology — Bahrain Polytechnic</span>
              <span className="text-xs px-3 py-1 rounded-full flex items-center gap-2" style={{ background: "rgba(52,211,153,.12)", color: C.ok }}><i className="w-2 h-2 rounded-full pulse" style={{ background: C.ok }} /><Tip k="conn">ESP32 Wi-Fi Connected</Tip></span>
            </div>
            <div className="flex flex-wrap gap-2 pt-1">
              <div className="stat"><span className="lbl text-xs">Test rig</span><b>1-phase 2-pole motor · 50 Hz · pump</b></div>
              <div className="stat"><span className="lbl text-xs">Sampling</span><b className="num">10 kS/s I,V · 1 kHz vibration</b></div>
              <div className="stat"><span className="lbl text-xs">Session uptime</span><b className="num">{up}</b></div>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-5">
            <div className="flex items-center gap-4 rounded-2xl border border-slate-600 px-5 py-4" style={{ background: "#0F172A66" }}>
              <div className="relative w-24 h-24 flex-none">
                <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90"><circle cx="50" cy="50" r="42" fill="none" stroke="#334155" strokeWidth="8" /><circle cx="50" cy="50" r="42" fill="none" stroke={hc} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${m.h * 2.64} 264`} style={{ transition: "stroke-dasharray .6s, stroke .4s" }} /></svg>
                <div className="absolute inset-0 grid place-items-center"><div className="text-2xl font-semibold num leading-none">{m.h}<span className="text-sm lbl">%</span></div></div>
              </div>
              <div><div className="lbl"><Tip k="health">System health</Tip></div><div className="text-lg font-semibold" style={{ color: hc }}>{m.h >= 80 ? "Normal" : m.h >= 55 ? "Warning" : "Critical"}</div><div className="lbl text-xs mt-1">Fused from 4 sensors<br />and the AI classifier</div></div>
            </div>
            <div className="flex flex-col gap-2">
              <Tip k="estop" block><button onClick={() => doTrip(false)} className="rounded-xl px-5 py-4 text-sm font-semibold transition hover:brightness-125" style={{ background: trip ? "rgba(52,211,153,.14)" : "rgba(248,113,113,.14)", color: trip ? C.ok : C.bad, border: `1px solid ${trip ? "rgba(52,211,153,.55)" : "rgba(248,113,113,.55)"}` }}>
                {trip ? "RESET RELAY / RESTART MOTOR" : "EMERGENCY SHUTDOWN / TRIP RELAY"}
              </button></Tip>
              <div className="text-xs lbl">Relay: <b style={{ color: trip ? C.bad : C.ok }}>{trip ? "OPEN · motor de-energised" : "CLOSED · motor energised"}</b></div>
            </div>
          </div>
        </header>

        {/* Telemetry */}
        <section className="grid gap-4 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
          <TeleCard tip="cur" title="Current" sub="ACS712" value={m.I.toFixed(1)} unit="A" badge={m.I > 4.7 ? ["High", C.warn] : run ? ["Normal", C.ok] : ["Off", C.mut]}
            stats={[["Peak", `${(m.I * 1.414).toFixed(1)} A`, "peakI"], ["THD", `${m.thd.toFixed(1)}%`, "thd"], ["Motor load", `${Math.round(m.load)}%`, "load"]]}>
            <Spark data={m.aI} color={C.cy} id="I" min={0} max={6} />
          </TeleCard>
          <TeleCard tip="vol" title="Voltage" sub="ZMPT101B" value={m.V.toFixed(1)} unit="V" badge={Math.abs(dev) < 3 ? ["Stable", C.ok] : ["Drifting", C.warn]}
            stats={[["Frequency", `${m.freq.toFixed(2)} Hz`, "freq"], ["Deviation", `${((dev / 230) * 100).toFixed(2)}%`, "dev"], ["IEC ±10%", Math.abs(dev / 230) < 0.1 ? "Within" : "Outside", "iec"]]}>
            <Spark data={m.aV} color={C.teal} id="V" min={226} max={234} />
          </TeleCard>
          <TeleCard tip="tmp" title="Temperature" sub="GY-906 · object IR" value={m.T.toFixed(1)} unit="°C" badge={m.T >= 55 ? ["Over limit", C.bad] : m.T >= 48 ? ["Warning", C.warn] : ["Normal", C.ok]}
            stats={[["Ambient", `${AMB.toFixed(1)} °C`, "amb"], ["ΔT rise", `${(m.T - AMB).toFixed(1)} °C`, "dT"], ["To 55 °C trip", ttt, "ttt"]]}>
            <div className="flex justify-between lbl text-xs mb-2"><span>Warn 48 °C · Trip 55 °C</span><span className="num">{m.rate >= 0 ? "+" : ""}{m.rate.toFixed(2)} °C/min</span></div>
            <div className="bar"><i style={{ width: `${Math.min(100, (m.T / 70) * 100)}%`, background: tc }} /></div>
            <div className="text-xs mt-2" style={{ color: tc }}>{m.T >= 55 ? "Threshold exceeded" : m.T >= 48 ? "Approaching alarm threshold" : "Below alarm threshold"}</div>
          </TeleCard>
          <TeleCard tip="vib" title="Vibration" sub="MPU6050 · 3-axis RMS" value={m.A.toFixed(2)} unit="g" badge={m.A > 0.9 ? ["Critical", C.bad] : m.A > 0.5 ? ["Elevated", C.warn] : ["Normal", C.ok]}
            stats={[["X axis", `${ax.toFixed(2)} g`, "axis"], ["Y axis", `${ay.toFixed(2)} g`, "axis"], ["Z axis", `${az.toFixed(2)} g`, "axis"], ["Peak", `${(m.A * m.CF).toFixed(2)} g`, "peakA"], ["Crest factor", m.CF.toFixed(1), "crest"], ["Dominant", `${fr.toFixed(1)} Hz`, "dom"]]}>
            <Spark data={m.aA} color={C.cy} id="A" min={0} max={1.4} />
          </TeleCard>
        </section>

        {/* Spectrum + features */}
        <section className="grid gap-4 grid-cols-1 lg:grid-cols-3">
          <div className="card lg:col-span-2">
            <div className="flex flex-wrap justify-between items-start gap-3 mb-3">
              <div>
                <h2 className="font-semibold"><Tip k={tab === "mcsa" ? "mcsa" : "vibspec"}>{tab === "mcsa" ? "MCSA stator current spectrum (FFT)" : "Vibration spectrum (MPU6050)"}</Tip></h2>
                <div className="lbl">{tab === "mcsa" ? `dB relative to 50 Hz fundamental · slip ${(s * 100).toFixed(1)}% → sidebands at 50 ± 2sf = ${lo.toFixed(1)} / ${hi.toFixed(1)} Hz` : `Acceleration amplitude · rotor speed ${(fr * 60).toFixed(0)} rpm (${fr.toFixed(1)} Hz)`} · 0.5 Hz resolution</div>
              </div>
              <div role="tablist" className="flex gap-1 p-1 rounded-full border border-slate-700" style={{ background: "#0F172A88" }}>
                <button role="tab" className="tab" aria-selected={tab === "mcsa"} onClick={() => setTab("mcsa")}>Current (MCSA)</button>
                <button role="tab" className="tab" aria-selected={tab === "vib"} onClick={() => setTab("vib")}>Vibration</button>
              </div>
            </div>
            {tab === "mcsa" ? (
              <Spectrum data={m.specI} yMin={-90} yMax={0} ticks={[-90, -60, -30, 0]} fmt={(t) => `${t} dB`} shade={[lo - 1, hi + 1]}
                marks={[{ f: 50, label: "50 Hz", color: "#E2E8F0", row: 0 }, { f: lo, label: lo.toFixed(1), color: C.warn, anchor: "end", row: 1 }, { f: hi, label: hi.toFixed(1), color: C.warn, anchor: "start", row: 1 }, { f: 150, label: "3f", color: C.mut }]} />
            ) : (
              <Spectrum data={m.specV} yMin={0} yMax={1} ticks={[0, 0.25, 0.5, 0.75, 1]} fmt={(t) => `${t} g`}
                marks={[{ f: fr, label: `1× ${fr.toFixed(1)}`, color: C.warn, anchor: "end" }, { f: 2 * fr, label: "2×", color: C.mut, anchor: "start" }]} />
            )}
            <div className="overflow-x-auto mt-3">
              <table className="w-full text-sm" style={{ minWidth: 440 }}>
                <thead><tr className="lbl text-left border-b border-slate-700"><th className="py-2 pr-3 font-medium">Marker</th><th className="pr-3 font-medium">Frequency</th><th className="pr-3 font-medium">Amplitude</th><th className="font-medium">Status</th></tr></thead>
                <tbody>{rows.map(([n, hz, a, st]) => (
                  <tr key={n} className="border-b border-slate-800"><td className="py-2 pr-3"><Tip k={MK[n]}>{n}</Tip></td><td className="pr-3 num">{hz.toFixed(1)} Hz</td><td className="pr-3 num">{a}</td><td><Badge text={st[0]} color={st[1]} /></td></tr>
                ))}</tbody>
              </table>
            </div>
          </div>
          <div className="card">
            <h2 className="font-semibold"><Tip k="tdf">Time-domain features</Tip></h2><div className="lbl mb-4">Computed on a 1 s window</div>
            <div className="grid grid-cols-2 gap-3">
              <Tile k="rmsI" l="RMS current" v={m.I.toFixed(2)} u="A" w={(m.I / 6) * 100} />
              <Tile k="rmsA" l="Vibration RMS" v={m.A.toFixed(2)} u="g" w={(m.A / 1.4) * 100} col={m.A > 0.9 ? C.bad : m.A > 0.5 ? C.warn : C.cy} />
              <Tile k="kurt" l="Kurtosis" v={m.K.toFixed(2)} u="" w={(m.K / 6) * 100} col={kc} sub="Gaussian ≈ 3 · sine ≈ 1.5" />
              <Tile k="crest" l="Crest factor" v={m.CF.toFixed(1)} u="" w={(m.CF / 6) * 100} sub="Peak ÷ RMS (vibration)" />
              <Tile k="pf" l="Power factor" v={m.PF.toFixed(2)} u="cos φ" w={m.PF * 100} col={m.PF < 0.8 ? C.warn : C.cy} />
              <Tile k="thd" l="Current THD" v={m.thd.toFixed(1)} u="%" w={(m.thd / 15) * 100} col={m.thd > 8 ? C.warn : C.cy} />
            </div>
          </div>
        </section>

        {/* Motor insights */}
        <section className="grid gap-4 grid-cols-1 lg:grid-cols-3">
          <div className="card">
            <h2 className="font-semibold"><Tip k="power">Electrical power</Tip></h2><div className="lbl mb-3">From ACS712 × ZMPT101B</div>
            <div className="text-4xl font-semibold num mb-3">{(m.P / 1000).toFixed(2)}<span className="text-lg lbl ml-1">kW</span></div>
            <div className="grid grid-cols-2 gap-3">
              <Tile k="S" l="Apparent S" v={(m.S / 1000).toFixed(2)} u="kVA" />
              <Tile k="Q" l="Reactive Q" v={(m.Q / 1000).toFixed(2)} u="kvar" />
              <Tile k="pf" l="Power factor" v={m.PF.toFixed(2)} u="" />
              <Tile k="kwh" l="Session energy" v={m.kwh.toFixed(3)} u="kWh" />
            </div>
          </div>
          <div className="card">
            <h2 className="font-semibold"><Tip k="motor">Motor &amp; run capacitor</Tip></h2><div className="lbl mb-3">Estimated from MCSA and electrical data</div>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <Tile k="rpm" l="Speed" v={Math.round(m.rpm)} u="rpm" />
              <Tile k="slip" l="Slip" v={(s * 100).toFixed(1)} u="%" />
            </div>
            <Tile k="load" l="Motor load" v={Math.round(m.load)} u="%" w={m.load} col={m.load > 95 ? C.bad : C.cy} sub="Share of rated torque" />
            <div className="mt-3"><Tile k="cap" l="Run capacitor (est.)" v={m.cap.toFixed(1)} u={`µF of ${CAP_RATED} µF`} w={(m.cap / CAP_RATED) * 100} col={capC} sub={m.cap < 22 ? "Replace when below 90% of rating" : "Within tolerance"} /></div>
          </div>
          <div className="card">
            <h2 className="font-semibold"><Tip k="sub">Subsystem health</Tip></h2><div className="lbl mb-4">Remaining useful life estimate</div>
            <div className="space-y-3.5">
              {[["Electrical", m.sE], ["Thermal", m.sT], ["Mechanical", m.sM], ["Capacitor / start", m.sC]].map(([n, v]) => {
                const col = v >= 80 ? C.ok : v >= 55 ? C.warn : C.bad;
                return (<div key={n}><div className="flex justify-between text-sm mb-1.5"><span>{n}</span><b className="num" style={{ color: col }}>{Math.round(v)}%</b></div><div className="bar"><i style={{ width: `${v}%`, background: col }} /></div></div>);
              })}
            </div>
            <div className="mt-5 pt-4 border-t border-slate-700 flex items-baseline justify-between"><span className="lbl"><Tip k="rul">Estimated RUL</Tip></span><span className="text-2xl font-semibold num" style={{ color: m.rul < 200 ? C.bad : m.rul < 1000 ? C.warn : C.ok }}>{Math.round(m.rul).toLocaleString("en-US")} <span className="text-sm lbl">h</span></span></div>
          </div>
        </section>

        {/* AI */}
        <section className="grid gap-4 grid-cols-1 lg:grid-cols-3">
          <div className="card">
            <div className="lbl"><Tip k="state">Detected operating state</Tip></div>
            <div className="text-2xl font-semibold mt-1 mb-1" style={{ color: f.col }}><Tip k={"f_" + fault}>{f.name}</Tip></div>
            <div className="text-sm lbl mb-4">{run ? f.desc : "Motor tripped. Classifier holding the last detected state."}</div>
            <div className="flex items-center gap-2 text-sm mb-4"><i className="w-2.5 h-2.5 rounded-full" style={{ background: f.col }} /><span className="lbl"><Tip k="conf">Model confidence</Tip></span><b className="num ml-auto">{(m.probs[idx] * 100).toFixed(1)}%</b></div>
            <div className="lbl text-xs mb-2"><Tip k="evid">Key evidence from sensors</Tip></div>
            <div className="flex flex-wrap gap-2">{evidence.map((e) => <span key={e} className="text-xs px-2.5 py-1 rounded-full border border-slate-600 num">{e}</span>)}</div>
          </div>
          <div className="card">
            <h2 className="font-semibold"><Tip k="clf">Classifier probabilities</Tip></h2><div className="lbl mb-4">Random Forest · SVM ensemble</div>
            <div className="space-y-4">{KEYS.map((k, i) => (
              <div key={k}><div className="flex justify-between text-sm mb-1.5"><span><Tip k={"f_" + k}>{FAULTS[k].name}</Tip></span><b className="num">{(m.probs[i] * 100).toFixed(1)}%</b></div><div className="bar"><i style={{ width: `${m.probs[i] * 100}%`, background: i === idx ? FAULTS[k].col : "#475569" }} /></div></div>
            ))}</div>
          </div>
          <div className="card">
            <h2 className="font-semibold"><Tip k="inj">Fault injection simulator</Tip></h2><div className="lbl mb-4">Only one fault can be active at a time</div>
            <div className="space-y-4">{KEYS.slice(1).map((k) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <div><div className="text-sm font-medium"><Tip k={"f_" + k}>{FAULTS[k].name}</Tip></div><div className="lbl text-xs">Simulate {FAULTS[k].sev.toLowerCase()} condition</div></div>
                <button className="sw" role="switch" aria-checked={fault === k} aria-label={FAULTS[k].name} onClick={() => setFault(fault === k ? "healthy" : k)} />
              </div>
            ))}</div>
          </div>
        </section>

        {/* Sensor channels */}
        <section className="card">
          <h2 className="font-semibold"><Tip k="daq">Data acquisition channels</Tip></h2><div className="lbl mb-3">ESP32 multi-channel unit · FFT window 2 s (≈0.5 Hz resolution)</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 620 }}>
              <thead><tr className="lbl text-left border-b border-slate-700">{["Quantity", "Sensor", "Interface", "Range / sensitivity", "Sample rate", "Status"].map((h) => <th key={h} className="py-2 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{SENSORS.map((r) => (
                <tr key={r[0]} className="border-b border-slate-800">{r.map((x, i) => <td key={i} className={`py-2.5 pr-4 ${i === 0 ? "font-medium" : "lbl"}`}>{i === 1 ? <Tip k={"s_" + r[0]}>{x}</Tip> : x}</td>)}<td><Badge text="Online" color={C.ok} /></td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>

        {/* Log */}
        <section className="card">
          <div className="flex justify-between items-center mb-3">
            <div><h2 className="font-semibold"><Tip k="prot">Active protection &amp; event log</Tip></h2><div className="lbl">Anomalies, warnings and relay actions</div></div>
            <button onClick={() => setLog([])} className="text-xs px-3 py-1.5 rounded-lg border border-slate-600 text-slate-300 hover:bg-slate-700">Clear log</button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 560 }}>
              <thead><tr className="lbl text-left border-b border-slate-700"><th className="py-2 pr-4 font-medium">Time</th><th className="pr-4 font-medium">Severity</th><th className="pr-4 font-medium">Event</th><th className="font-medium">Action</th></tr></thead>
              <tbody>{log.map((r) => (
                <tr key={r.id} className="border-b border-slate-800"><td className="py-2.5 pr-4 num lbl whitespace-nowrap">{r.time}</td><td className="pr-4"><Badge text={r.sev} color={SEV[r.sev]} /></td><td className="pr-4">{r.ev}</td><td className="lbl">{r.act}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </section>

        <footer className="text-center text-sm lbl pt-2 pb-6 space-y-2">
          <div>Engineering Technology — Bahrain Polytechnic · Under the supervision of <span className="text-slate-200">Dr. Abdulla Desmal</span></div>
          <div className="flex flex-wrap justify-center gap-x-8 gap-y-1 num">{team.map(([, n, id]) => <span key={id}>{n} (ID: {id})</span>)}</div>
          <div className="text-xs opacity-70">Prototype phase: simulated telemetry. Live ESP32 hardware integration to follow.</div>
        </footer>
      </div>
    </div>
  );
}
