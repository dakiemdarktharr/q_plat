import { readFileSync } from "node:fs";
import { Script } from "node:vm";
const html = readFileSync("index.html", "utf8");
new Script(html.split("<script>")[1].split("</script>")[0]);
console.log("Inline frontend JS syntax: PASS");
