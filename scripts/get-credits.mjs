async function run() {
  const r = await fetch("http://127.0.0.1:4173/api/clay/credits");
  const data = await r.json();
  console.log(data);
}
run();
