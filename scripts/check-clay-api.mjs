async function test() {
  const creditsRes = await fetch("http://127.0.0.1:4173/api/clay/credits");
  const credits = await creditsRes.json();
  console.log("=== CLAY CREDITS API RESPONSE ===");
  console.log(JSON.stringify(credits, null, 2));

  const statusRes = await fetch("http://127.0.0.1:4173/api/clay/status");
  const status = await statusRes.json();
  console.log("\n=== CLAY STATUS API RESPONSE ===");
  console.log(JSON.stringify(status, null, 2));
}

test().catch(console.error);
