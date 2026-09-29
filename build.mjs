/* index.html を作る: src/main.js と編集部品を1つの JS / CSS にまとめ、テンプレートに埋め込む
 *   npm install && npm run build
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
/* OUT で出力先を変えられる（テスト用） */
const OUT = process.env.OUT || "index.html";
writeFileSync(OUT, html);
console.log(OUT, (html.length / 1024).toFixed(0) + " KB");
