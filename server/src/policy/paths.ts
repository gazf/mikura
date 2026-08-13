/**
 * ADR-035: ポリシー文書が扱うパスの正規化と照合。
 *
 * 照合は **ASCII の A-Z / a-z だけを畳む** case-insensitive。Unicode の
 * case folding を使わないのは、テーブルが Unicode 版で変わる = 「どのルールが
 * 一致するか」が黙って変わる = 保護が黙って外れる、から。NTFS が format 時の
 * 大文字テーブルを volume に焼き込み、ext4 が superblock に Unicode 版を
 * 記録しているのと同じ理由。畳み方を広げるのは runtime の upgrade ではなく
 * 明示的な migration として扱うので、版を持たせる。
 */
export const POLICY_CASE_FOLDING_VERSION = 1;

/** ASCII のみを畳む。String.toLowerCase() は Unicode 依存なので使わない。 */
export function foldAscii(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += (c >= 0x41 && c <= 0x5a) ? String.fromCharCode(c + 0x20) : s[i];
  }
  return out;
}

/**
 * ルール／テストに書けるパスかを検査する。書き手のタイプミスを拾うのが目的
 * なので、黙って直さずに理由を返す。
 */
export function validatePolicyPath(path: string): string | null {
  if (path.length === 0) return "パスが空です";
  if (!path.startsWith("/")) return "パスは / で始めてください";
  // 改行を通すと、レコード → テキスト → パース の往復でパスが別の行として
  // 解釈され、ポリシーに任意のロールを注入できてしまう。制御文字はまとめて弾く。
  for (const ch of path) {
    if (ch.codePointAt(0)! < 0x20 || ch === "\u007f") {
      return "パスに制御文字を含められません";
    }
  }
  if (path.includes("\\")) return "パス区切りは / です (\\ は使えません)";
  if (path.includes("//")) return "パスに空のセグメント (//) を含められません";
  if (path !== "/" && path.endsWith("/")) {
    return "末尾の / は付けないでください";
  }
  for (const seg of path.split("/")) {
    if (seg === "." || seg === "..") return "パスに . / .. を含められません";
  }
  return null;
}

/**
 * 照合用の正規形。ルール側もリクエスト側も必ずこれを通してから比較する。
 * 空文字・末尾スラッシュ・重複スラッシュはリクエスト側では実際に来るので、
 * ここでは弾かずに畳む (弾くのは `validatePolicyPath` = 書き手向けの検査)。
 */
export function normalizeForMatch(path: string): string {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return "/";
  return "/" + foldAscii(parts.join("/"));
}

/**
 * 正規化済みパスの「自分自身 → ルート」の並び。最も具体的なものが先頭。
 * 最近傍祖先の解決はこの順に最初に見つかったルールで決まる。
 */
export function selfAndAncestors(normalized: string): string[] {
  if (normalized === "/") return ["/"];
  const out: string[] = [];
  let cur = normalized;
  while (cur !== "/") {
    out.push(cur);
    const cut = cur.lastIndexOf("/");
    cur = cut === 0 ? "/" : cur.slice(0, cut);
  }
  out.push("/");
  return out;
}

/** `ancestor` が `path` の **真の** 祖先か (正規化済み前提)。 */
export function isProperAncestor(ancestor: string, path: string): boolean {
  if (ancestor === path) return false;
  if (ancestor === "/") return true;
  return path.startsWith(ancestor + "/");
}
