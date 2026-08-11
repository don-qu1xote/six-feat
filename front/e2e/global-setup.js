import fs from "node:fs";

export default async function globalSetup() {
  const envFile = process.env.E2E_ENV_FILE || "/tmp/six_feat_e2e_env.json";
  if (!fs.existsSync(envFile)) {
    throw new Error(
      `[global-setup] ${envFile} not found. Start the E2E environment first: ` +
        `python3 scripts/e2e_env.py up`,
    );
  }

  const env = JSON.parse(fs.readFileSync(envFile, "utf-8"));
  const { hostname } = new URL(env.base_url);
  const storageStatePath = process.env.E2E_STORAGE_STATE || ".e2e-storage-state.json";

  const storageState = {
    cookies: [
      {
        name: "six_feat_session",
        value: env.session_cookie,
        domain: hostname,
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 3600,
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };

  fs.writeFileSync(storageStatePath, JSON.stringify(storageState));
}
