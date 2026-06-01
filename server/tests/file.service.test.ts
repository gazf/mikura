/**
 * file.service.ts の責務テスト:
 *   - パス検証 (.., null byte, ストレージルート脱出) を全て弾く
 *   - 正常パスは listDirectory/statFile 経由で実ファイル操作ができる
 *
 * resolveAndValidate が export されていないため、副作用 (NotFound 等の
 * FileServiceError) を含めて挙動で検証する。
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import * as path from "@std/path";
import {
  deleteFile,
  FileServiceError,
  getFileInfo,
  listDirectory,
  readFile,
  writeFile,
} from "../src/services/file.service.ts";

// 注意: file.service.ts は DATA_ROOT を import 時に読み込む静的な値で持つ。
// 動的に環境変数で切り替えても反映されないため、ファイル I/O 系のテストは
// 既定の `<cwd>/data/` 配下に専用 fixture ディレクトリを作って隔離する。

Deno.test("path validation: rejects null byte", async () => {
  await assertRejects(
    () => listDirectory("/foo\0bar"),
    FileServiceError,
    "Invalid path",
  );
});

Deno.test("path validation: rejects traversal that escapes data root", async () => {
  // /../etc/passwd → 正規化後も先頭が .. で残るので拒否
  await assertRejects(
    () => listDirectory("/../etc/passwd"),
    FileServiceError,
    "Invalid path",
  );
});

Deno.test("path validation: rejects deeper escape '/../../etc/passwd'", async () => {
  await assertRejects(
    () => listDirectory("/../../etc/passwd"),
    FileServiceError,
    "Invalid path",
  );
});

Deno.test("path normalization: in-bounds '..' is collapsed (no escape)", async () => {
  // /safe/../etc → 正規化で /etc に潰れる。escape ではないので
  // 「Invalid path」ではなく実体が無いので NotFound として返る。
  // = 正規化が正しく働き、ルート外へは出ていない、ことの確認。
  await assertRejects(
    () => listDirectory("/safe/../etc"),
    FileServiceError,
    "Not found",
  );
});

Deno.test("listDirectory: NotFound for non-existent path", async () => {
  // root 配下で実在しないパスは 404 で返る
  await assertRejects(
    () => listDirectory("/__definitely_not_existing_test_dir__"),
    FileServiceError,
    "Not found",
  );
});

Deno.test("getFileInfo: NotFound for non-existent path", async () => {
  await assertRejects(
    () => getFileInfo("/__missing__"),
    FileServiceError,
    "Not found",
  );
});

Deno.test("readFile: NotFound for non-existent path", async () => {
  await assertRejects(
    () => readFile("/__missing__"),
    FileServiceError,
    "Not found",
  );
});

Deno.test("deleteFile: NotFound for non-existent path", async () => {
  await assertRejects(
    () => deleteFile("/__missing__"),
    FileServiceError,
    "Not found",
  );
});

Deno.test("writeFile + readFile + listDirectory: roundtrip via real data dir", async () => {
  // DATA_ROOT は import 時に決まるので、テストでは既定の `<cwd>/data` に
  // 書き込んでクリーンナップする。専用ディレクトリ名 (test-fixture) で隔離。
  const TEST_DIR = "/__test_fixture_roundtrip__";
  const TEST_FILE = `${TEST_DIR}/sample.txt`;
  const root = path.join(Deno.cwd(), "data");

  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });
    await writeFile(TEST_FILE, body);

    const info = await getFileInfo(TEST_FILE);
    assertEquals(info.type, "file");
    assertEquals(info.size, 5);

    const list = await listDirectory(TEST_DIR);
    assert(list.some((e) => e.name === "sample.txt"));

    const { body: readBody, size } = await readFile(TEST_FILE);
    assertEquals(size, 5);
    const content = await new Response(readBody as BodyInit).text();
    assertEquals(content, "hello");

    await deleteFile(TEST_FILE);
    await assertRejects(() => getFileInfo(TEST_FILE), FileServiceError);
  } finally {
    // ディレクトリも掃除 (失敗時の散らかり防止)
    try {
      await Deno.remove(path.join(root, "__test_fixture_roundtrip__"), {
        recursive: true,
      });
    } catch { /* already cleaned */ }
  }
});
