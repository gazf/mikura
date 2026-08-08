/**
 * UI の配信。
 *
 * asset は起動時に一度読んでメモリに載せる。リクエストごとに FS を触らない
 * ので、`--allow-read=./src/ui` は起動時にしか効かず、実行中の console は
 * ファイルシステムに対して何もできない (ADR-033 の「Deno のパーミッションが
 * 分離の実効力になる」の一部)。
 *
 * ビルドステップは持たない。単一 HTML + vanilla JS で足りる規模だし、
 * `deno task dev` 一発で立ち上がる単純さの方が価値がある。
 */

import type { Hono } from "hono";
import type { ConsoleEnv } from "../app.ts";

export interface UiAssets {
  html: string;
  js: string;
  css: string;
}

/** 起動時に UI asset を読み込む。 */
export async function loadUiAssets(dir: string): Promise<UiAssets> {
  const [html, js, css] = await Promise.all([
    Deno.readTextFile(`${dir}/index.html`),
    Deno.readTextFile(`${dir}/app.js`),
    Deno.readTextFile(`${dir}/app.css`),
  ]);
  return { html, js, css };
}

export function registerStaticRoutes(app: Hono<ConsoleEnv>) {
  app.get("/", (c) => c.redirect("/console/", 302));
  app.get("/console", (c) => c.redirect("/console/", 302));

  app.get("/console/", (c) => {
    const { ui } = c.get("deps");
    return c.html(ui.html);
  });

  app.get("/console/assets/app.js", (c) => {
    const { ui } = c.get("deps");
    return c.body(ui.js, 200, {
      "Content-Type": "text/javascript; charset=utf-8",
    });
  });

  app.get("/console/assets/app.css", (c) => {
    const { ui } = c.get("deps");
    return c.body(ui.css, 200, { "Content-Type": "text/css; charset=utf-8" });
  });
}
