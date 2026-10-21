import "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import Fastify from "fastify";
import { SITE } from "@aihot/site";
import { registerStatic } from "../apps/api/src/routes/static.ts";

const app = Fastify();
registerStatic(app);
after(() => app.close());

test("installed-app icons use the current brand version and resolve to image files", async () => {
  const response = await app.inject(`/manifest.webmanifest?v=${SITE.iconVersion}`);
  assert.equal(response.statusCode, 200);
  const manifest = response.json();
  assert.equal(manifest.short_name, SITE.name);
  for (const icon of manifest.icons) {
    const url = new URL(icon.src, "https://example.test");
    assert.equal(url.searchParams.get("v"), SITE.iconVersion);
    const image = await app.inject(url.pathname + url.search);
    assert.equal(image.statusCode, 200);
    assert.equal(image.headers["content-type"], "image/png");
    assert.ok(image.rawPayload.length > 0);
  }
});
