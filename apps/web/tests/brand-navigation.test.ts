// Production SSR: readers can return to the brand site, without a source-code promotion.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import * as cheerio from "cheerio";
import { SITE } from "@aihot/site";
import { startWebServer, type WebServer } from "./web-server.ts";

let web: WebServer;
const api = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/site/meta") return res.end(JSON.stringify({ changelogVersion: null }));
  if (req.url?.startsWith("/api/site/timeline")) return res.end(JSON.stringify({
    cards: [], nextCursor: null, dayCounts: {}, hot: null,
    filters: { category: null, channel: "all", tag: null },
  }));
  res.statusCode = 404;
  res.end(JSON.stringify({ code: "not_found" }));
});
before(async () => { web = await startWebServer(api); });
after(() => web?.stop());

for (const path of ["/", "/more", "/about"]) {
  test(`${path} offers the official website without advertising the source repository`, async () => {
    const response = await fetch(web.origin + path);
    assert.equal(response.status, 200, web.logs());
    const $ = cheerio.load(await response.text());
    for (const file of ["favicon.ico", "icon.png", "favicon.svg", "apple-icon.png", "manifest.webmanifest"]) {
      assert.equal($(`head link[href='/${file}?v=${SITE.iconVersion}']`).length, 1, `${file} must bypass the previous icon cache`);
    }
    assert.equal($("aside a").filter((_, el) => $(el).text().includes("返回官网")).attr("href"), SITE.officialUrl);
    assert.equal($("a").filter((_, el) => $(el).text().includes("GitHub 开源")).length, 0);
    assert.equal($("a[href='https://github.com/fxjzai/rl-radar']").length, 0);
    assert.ok(!$("body").text().includes("由 AIHOT 开源框架驱动"));
    if (path === "/more") {
      assert.equal($("main a").filter((_, el) => $(el).text().includes("返回官网")).attr("href"), SITE.officialUrl);
    }
  });
}
