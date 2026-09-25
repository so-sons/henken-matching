// data.src.js（平文のキャラデータ）を AES-256-GCM で暗号化して data.bin を生成する。
// カギは .secret-key に保存され（初回に自動生成）、公開URLの #k=... に付けて配布する。
//   node build-data.js
const fs = require("fs");
const crypto = require("crypto");

const src = fs.readFileSync("data.src.js", "utf8");
const json = src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1);
JSON.parse(json); // 構文チェック

let key;
if (fs.existsSync(".secret-key")) key = fs.readFileSync(".secret-key", "utf8").trim();
else { key = crypto.randomBytes(16).toString("base64url"); fs.writeFileSync(".secret-key", key + "\n"); }
const keyBytes = Buffer.from(key, "base64url");
if (keyBytes.length !== 16 && keyBytes.length !== 32) throw new Error("bad key length");

const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv(keyBytes.length === 16 ? "aes-128-gcm" : "aes-256-gcm", keyBytes, iv);
const ct = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
const tag = cipher.getAuthTag(); // WebCrypto は ciphertext||tag の形式
fs.writeFileSync("data.bin", Buffer.concat([iv, ct, tag]));
console.log(`data.bin: ${(fs.statSync("data.bin").size / 1024).toFixed(0)} KB`);
const cfg = fs.readFileSync("config.js", "utf8"); const m = cfg.match(/siteUrl:\s*"([^"]+)"/);
console.log(`共有リンク: ${m ? m[1] : "<公開URL>"}#k=${key}`);
