import { copyFileSync, writeFileSync } from "node:fs";
copyFileSync("dist/index.html", "dist/404.html");
writeFileSync("dist/.nojekyll", "");
writeFileSync("dist/version.json", JSON.stringify({ version: new Date().toISOString() }));
console.log("postbuild: 404.html + .nojekyll + version.json");
