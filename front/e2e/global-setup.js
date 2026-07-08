// front/e2e/global-setup.js — IDEA-33
//
// The `six_feat_session` cookie is AES-256-GCM-encrypted with a format only
// implemented in C++ (src/auth/session_crypto.cpp) and its Python test port
// (tests/session_crypto.py) — there's no JS implementation, and one isn't
// worth adding for a single test. scripts/e2e_env.py mints a valid cookie
// via that Python port when it starts the environment and writes it (along
// with the base URL) to E2E_ENV_FILE; this just turns that into a Playwright
// storageState file so the browser context in smoke.spec.js starts already
// authenticated, the same way the Python integration suite's `client`
// fixture does via tests/conftest.py's `auth_cookie`.
import fs from "node:fs";

export default async function globalSetup() {
  const envFile = process.env.E2E_ENV_FILE || "/tmp/six_feat_e2e_env.json";
  if (!fs.existsSync(envFile)) {
    throw new Error(
      `[global-setup] ${envFile} not found. Start the E2E environment first: ` +
      `python3 scripts/e2e_env.py up`
    );
  }

  const env = JSON.parse(fs.readFileSync(envFile, "utf-8"));
  const { hostname } = new URL(env.base_url);
  const storageStatePath = process.env.E2E_STORAGE_STATE || ".e2e-storage-state.json";

  const storageState = {
    cookies: [{
      name: "six_feat_session",
      value: env.session_cookie,
      domain: hostname,
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600,
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    }],
    origins: [],
  };

  fs.writeFileSync(storageStatePath, JSON.stringify(storageState));
}
