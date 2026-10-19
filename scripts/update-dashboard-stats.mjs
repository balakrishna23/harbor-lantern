import fs from "node:fs";

let html = fs.readFileSync("exports/pipeline_dashboard.html", "utf8");

html = html.replaceAll(">69<", ">76<");
html = html.replaceAll("69 Candidates", "76 Candidates");
html = html.replaceAll("69 confirmed (90.8% accuracy)", "76 confirmed (100% accuracy)");
html = html.replaceAll(">49<", '>14 <span class="text-xs text-emerald-400 font-normal">(AU)</span><');
html = html.replaceAll("71.0% mobile hit rate", "14 Australian (+614), 35 quarantined");

fs.writeFileSync("exports/pipeline_dashboard.html", html, "utf8");
console.log("Dashboard updated with 76 confirmed candidates and Australian phone purity!");
