const fs = require("fs");
const path = require("path");

const root = process.cwd();
const distDir = path.resolve(root, process.env.NEXT_DIST_DIR || ".next");
const standaloneDir = path.join(distDir, "standalone");

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
}

function copyFile(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

if (!fs.existsSync(standaloneDir)) {
  process.exit(0);
}

copyDir(path.join(root, "public"), path.join(standaloneDir, "public"));
copyDir(path.join(distDir, "static"), path.join(standaloneDir, path.basename(distDir), "static"));
copyDir(path.join(root, "open-sse"), path.join(standaloneDir, "open-sse"));
copyDir(path.join(root, "src", "lib", "db"), path.join(standaloneDir, "src", "lib", "db"));
copyFile(path.join(root, "src", "lib", "dataDir.js"), path.join(standaloneDir, "src", "lib", "dataDir.js"));
copyDir(path.join(root, "src", "mitm"), path.join(standaloneDir, "src", "mitm"));
copyDir(path.join(root, "src", "shared", "constants"), path.join(standaloneDir, "src", "shared", "constants"));
copyFile(path.join(root, "src", "sse", "services", "codexOAuthRefresh.js"), path.join(standaloneDir, "src", "sse", "services", "codexOAuthRefresh.js"));
copyDir(path.join(root, "node_modules", "header-generator", "data_files"), path.join(standaloneDir, "node_modules", "header-generator", "data_files"));
copyDir(path.join(root, "node_modules", "header-generator", "data_files"), path.join(standaloneDir, path.basename(distDir), "server", "chunks", "data_files"));
