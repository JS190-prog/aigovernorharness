import { installLifecycleDiagnostics } from "../build/lifecycle.js";

installLifecycleDiagnostics();

const mode = process.argv[2];
if (mode === "uncaught") {
  setImmediate(() => {
    throw new Error("lifecycle fixture uncaught exception");
  });
} else if (mode === "rejection") {
  Promise.reject(new Error("lifecycle fixture unhandled rejection"));
} else {
  throw new Error(`unknown lifecycle fixture mode: ${mode}`);
}
