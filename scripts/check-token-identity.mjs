import fs from "node:fs";

async function checkTokenIdentity() {
  const tokenData = JSON.parse(fs.readFileSync("data/.clay-tokens.json", "utf8"));
  const token = tokenData.accessToken;

  const endpoints = [
    "https://api.clay.com/v3/users/me",
    "https://api.clay.com/v3/workspaces",
    "https://api.clay.com/v3/credits",
    "https://api.clay.com/v3/account"
  ];

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep, {
        headers: { "Authorization": `Bearer ${token}` }
      });
      console.log(`Endpoint: ${ep} -> Status: ${res.status}`);
      const text = await res.text();
      console.log(`Response: ${text.substring(0, 250)}\n`);
    } catch (err) {
      console.error(`Error on ${ep}:`, err.message);
    }
  }
}

checkTokenIdentity();
