async function listSubroutines() {
  const res = await fetch("http://127.0.0.1:4173/api/clay/subroutines");
  const data = await res.json();
  const list = data.structuredContent?.subroutines || [];
  console.log("Found", list.length, "subroutines:");
  list.forEach(s => console.log(`  - [${s.id}] ${s.name} (${s.entityType})`));
}

listSubroutines();
