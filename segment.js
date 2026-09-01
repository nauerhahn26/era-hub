// segment.js — garment cut-out with the same model Ellie's Python pipeline
// uses (U^2-Net "u2netp", the small variant rembg ships), run locally through
// ONNX Runtime. Dad 9/1: "add the 50mb so trim is nice looking" — the
// heuristic flood could only trim about half of real photos safely, because a
// garment whose colour matches the floor cannot be separated by colour alone.
//
// Nothing leaves the machine: the model sits next to the app and runs on the
// CPU. We use the WEBASSEMBLY build, not the native binding: a clean Windows
// 10 has no Visual C++ runtime, so the native .node refused to load on the QA
// machine ("the specified module could not be found") and would have done the
// same on any freshly-installed family PC. WASM needs nothing but Node, is
// half the size, and takes about a second per photo. Everything degrades to
// the colour heuristic if the runtime is missing (see clothing-worker.js).
//
// Licences: U^2-Net model Apache-2.0 (Qin et al.), rembg MIT (the weights we
// fetch), ONNX Runtime MIT — see vendor/NOTICE-vendor.txt.
"use strict";
const fs = require("fs");
const path = require("path");

const SIZE = 320;                       // u2netp's fixed input
const MEAN = [0.485, 0.456, 0.406];     // rembg's normalisation
const STD = [0.229, 0.224, 0.225];

let session = null;
let unavailable = false;

function loadOrt() {
  return require("./vendor/onnxruntime-web/dist/ort.node.min.js");
}

function modelPath() { return path.join(__dirname, "vendor", "models", "u2netp.onnx"); }

async function getSession() {
  if (session) return session;
  if (unavailable) return null;
  try {
    const ort = loadOrt();
    ort.env.logLevel = "error";
    // single-threaded: no worker plumbing, and one photo at a time is plenty
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.wasmPaths = path.join(__dirname, "vendor", "onnxruntime-web", "dist") + path.sep;
    session = await ort.InferenceSession.create(modelPath(), {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
    return session;
  } catch (e) {
    unavailable = true;
    console.error("[segment] model unavailable (" + e.message + ") — falling back");
    return null;
  }
}

// nearest-neighbour resize into the model's square input
function toTensorInput(img) {
  const { data, width: w, height: h } = img;
  const f = new Float32Array(3 * SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const sy = Math.min(h - 1, Math.round((y + 0.5) * h / SIZE - 0.5));
    for (let x = 0; x < SIZE; x++) {
      const sx = Math.min(w - 1, Math.round((x + 0.5) * w / SIZE - 0.5));
      const s = (sy * w + sx) * 4;
      const d = y * SIZE + x;
      f[d] = (data[s] / 255 - MEAN[0]) / STD[0];
      f[SIZE * SIZE + d] = (data[s + 1] / 255 - MEAN[1]) / STD[1];
      f[2 * SIZE * SIZE + d] = (data[s + 2] / 255 - MEAN[2]) / STD[2];
    }
  }
  return f;
}

// Run the model and paint everything it calls background pure white. Returns
// null when the runtime is unavailable so the caller can fall back.
async function cutOut(img, opts) {
  const s = await getSession();
  if (!s) return null;
  const ort = loadOrt();
  const input = new ort.Tensor("float32", toTensorInput(img), [1, 3, SIZE, SIZE]);
  const out = await s.run({ [s.inputNames[0]]: input });
  const mask = out[s.outputNames[0]].data;    // d0: [1,1,320,320]

  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < mask.length; i++) { if (mask[i] < lo) lo = mask[i]; if (mask[i] > hi) hi = mask[i]; }
  const span = hi - lo || 1;
  const cut = (opts && opts.threshold) || 0.5;

  const { data, width: w, height: h } = img;
  const res = Buffer.from(data);
  let keptPx = 0;
  for (let y = 0; y < h; y++) {
    const my = Math.min(SIZE - 1, Math.round((y + 0.5) * SIZE / h - 0.5));
    for (let x = 0; x < w; x++) {
      const mx = Math.min(SIZE - 1, Math.round((x + 0.5) * SIZE / w - 0.5));
      const v = (mask[my * SIZE + mx] - lo) / span;
      const o = (y * w + x) * 4;
      if (v < cut) { res[o] = 255; res[o + 1] = 255; res[o + 2] = 255; res[o + 3] = 255; }
      else keptPx++;
    }
  }
  // A mask that keeps nearly nothing (or nearly everything) means the model saw
  // no clear subject — say so rather than hand back a blank tile.
  const frac = keptPx / (w * h);
  if (frac < 0.02 || frac > 0.97) return null;
  return { data: res, width: w, height: h, kept: frac };
}

function available() { return !unavailable; }

module.exports = { cutOut, available, modelPath };
