import { ClayMcpClient } from "../src/clay-mcp.mjs";

const client = new ClayMcpClient({
  redirectUri: "http://127.0.0.1:4173/api/clay/oauth/callback",
  metadataPath: "./data/clay-mcp-client.json",
  tokenPath: "./data/.clay-tokens.json"
});

const subroutines = await client.listSubroutines();
console.log("=== CLAY SUBROUTINES ===");
if (subroutines.content && subroutines.content[0]?.text) {
  const parsed = JSON.parse(subroutines.content[0].text);
  console.log("Total subroutines:", parsed.subroutines?.length);
  parsed.subroutines?.forEach(s => {
    console.log(`\nSubroutine: ${s.name} (id: ${s.id})`);
    console.log(`  Inputs:`, s.requiredInputs?.map(i => `${i.name} (${i.type})`).join(", "));
  });
} else {
  console.log(JSON.stringify(subroutines, null, 2));
}
