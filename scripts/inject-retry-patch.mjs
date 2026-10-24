// 构建期注入：把 body-retry-patch.js 以内联 <script> 形式插进
// dist/index.html 的 <head> 首位（经典脚本先于应用的 module 脚本执行，
// 因此 fetch / XHR 补丁在应用 JS 发起任何请求前就已生效）。
// 必须在 fetch-frontend 之后、build-edge 之前运行：build-edge 会把
// dist/index.html 内联进云函数 bundle（SPA 兜底壳），顺序错了内联的
// 那份就没有补丁。静态托管直接 served 的 dist/index.html 同样带补丁。
// 幂等：已含标记则跳过。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INDEX = path.join(ROOT, "dist", "index.html");
const PATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), "body-retry-patch.js");
const MARKER = "openlist-body-retry-patch";

const html = fs.readFileSync(INDEX, "utf8");
if (html.includes(MARKER)) {
  console.log("retry patch already present in dist/index.html, skip");
  process.exit(0);
}
if (!html.includes("<head")) {
  throw new Error("dist/index.html has no <head> tag, cannot inject retry patch");
}
const patch = fs.readFileSync(PATCH, "utf8");
const injected = html.replace(
  "<head>",
  `<head>\n<!-- ${MARKER} -->\n<script>\n${patch}\n</script>`,
);
fs.writeFileSync(INDEX, injected);
console.log("retry patch injected into dist/index.html");
