/* beta.html を作る: src/main.js と編集部品を1つの JS / CSS にまとめ、テンプレートに埋め込む
 *   cd beta && npm install && npm run build
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";

const out = await build({
  entryPoints: ["src/main.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: ["es2020", "safari15"],
  write: false,
  outdir: "out",
  legalComments: "none",
  loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".svg": "dataurl" },
});

const pick = ext => out.outputFiles.filter(f => f.path.endsWith(ext)).map(f => f.text).join("\n");
/* </script> や </style> が中に出てきても、埋め込み先のタグが閉じないようにする */
const js = pick(".js").replace(/<\/script/gi, "<\\/script");
const css = pick(".css").replace(/<\/style/gi, "<\\/style");

const html = readFileSync("src/template.html", "utf8")
  .replace("/*__CSS__*/", () => css)
  .replace("/*__JS__*/", () => js);
writeFileSync("../beta.html", html);
console.log("beta.html", (html.length / 1024).toFixed(0) + " KB");
