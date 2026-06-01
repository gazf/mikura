/**
 * 開発用の self-signed cert / key を生成する。
 *
 * 出力:
 *   server/dev-cert.pem
 *   server/dev-key.pem
 *
 * Subject Alternative Name に `localhost` / `127.0.0.1` / `::1` を含む。
 * 有効期限 10 年 (3650 日)。.gitignore 済み、絶対に commit しないこと。
 *
 * 既に存在する場合は上書きを避けて exit 1。再生成したい場合は手で消す:
 *   rm dev-cert.pem dev-key.pem && deno task gen-cert
 *
 * 前提: openssl が PATH 上にあること (WSL/Linux なら標準、Windows なら別途)。
 */

const CERT_PATH = "dev-cert.pem";
const KEY_PATH = "dev-key.pem";

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

if (await exists(CERT_PATH) || await exists(KEY_PATH)) {
  console.error(`Existing ${CERT_PATH} or ${KEY_PATH} found.`);
  console.error("Delete them first if you really want to regenerate.");
  Deno.exit(1);
}

console.log("Generating self-signed dev cert (10-year validity)…");

const cmd = new Deno.Command("openssl", {
  args: [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    KEY_PATH,
    "-out",
    CERT_PATH,
    "-days",
    "3650",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
  ],
  stderr: "piped",
});

const { success, stderr } = await cmd.output();
if (!success) {
  console.error("openssl failed:");
  console.error(new TextDecoder().decode(stderr));
  console.error("");
  console.error(
    "Is openssl installed? On Debian/Ubuntu: `sudo apt install openssl`",
  );
  Deno.exit(1);
}

console.log(`Created ${CERT_PATH} and ${KEY_PATH}.`);
console.log("These files are gitignored — do not commit them.");
