import "./standalone.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { SITE } from "@aihot/site";
import { sendAlert } from "@aihot/backend/notify/feishu";

const originalFetch = globalThis.fetch;
const keys = ["FEISHU_INTERNAL_ENABLED", "FEISHU_ALERT_WEBHOOK_URL", "FEISHU_ALERT_CHAT_ID", "FEISHU_INTERNAL_CHAT_ID"];
const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
const requests: Array<{ url: string; body: { msg_type: string; content: { text: string } } }> = [];
const webhook = "https://open.feishu.cn/open-apis/bot/v2/hook/fictional-test-hook";

beforeEach(() => {
  Object.assign(process.env, { FEISHU_INTERNAL_ENABLED: "true", FEISHU_ALERT_WEBHOOK_URL: webhook, FEISHU_ALERT_CHAT_ID: "", FEISHU_INTERNAL_CHAT_ID: "" });
  requests.length = 0;
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ code: 0 });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("a custom bot sends an alert without application credentials and includes the site's keyword", async () => {
  assert.equal(await sendAlert("测试通知", ["这是测试，不是真实故障。"]), "sent");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, webhook);
  assert.equal(requests[0].body.msg_type, "text");
  assert.ok(requests[0].body.content.text.startsWith(`【${SITE.name}】`));
  assert.match(requests[0].body.content.text, /这是测试，不是真实故障。/);
});

test("the safety valve prevents webhook requests", async () => {
  process.env.FEISHU_INTERNAL_ENABLED = "false";
  assert.equal(await sendAlert("测试通知", []), "disabled");
  assert.equal(requests.length, 0);
});

test("an absent webhook and absent app destination leave notifications disabled", async () => {
  delete process.env.FEISHU_ALERT_WEBHOOK_URL;
  assert.equal(await sendAlert("测试通知", []), "disabled");
  assert.equal(requests.length, 0);
});

test("a configured webhook takes priority over the application destination", async () => {
  process.env.FEISHU_ALERT_CHAT_ID = "fictional-chat";
  assert.equal(await sendAlert("测试通知", []), "sent");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, webhook);
});

for (const [label, response] of [
  ["keyword rejection", () => Response.json({ code: 19024 })],
  ["legacy rejection", () => Response.json({ StatusCode: 19024 })],
  ["missing acknowledgment", () => Response.json({})],
  ["non-JSON response", () => new Response("upstream error")],
  ["HTTP error", () => Response.json({ code: 0 }, { status: 503 })],
] as const) {
  test(`${label} is not recorded as a successful delivery`, async () => {
    globalThis.fetch = (async () => response()) as typeof fetch;
    await assert.rejects(sendAlert("测试通知", []), /not acknowledged/);
  });
}

test("legacy successful acknowledgments are accepted", async () => {
  globalThis.fetch = (async () => Response.json({ StatusCode: 0 })) as typeof fetch;
  assert.equal(await sendAlert("测试通知", []), "sent");
});

test("transport errors never include the secret webhook URL", async () => {
  globalThis.fetch = (async () => { throw new Error(`timeout: ${webhook}`); }) as typeof fetch;
  await assert.rejects(sendAlert("测试通知", []), (error: Error) => {
    assert.equal(error.message, "Feishu alert webhook request failed");
    assert.ok(!error.message.includes("fictional-test-hook"));
    return true;
  });
});

test("a foreign destination is rejected before any network request", async () => {
  process.env.FEISHU_ALERT_WEBHOOK_URL = "https://example.com/open-apis/bot/v2/hook/test";
  await assert.rejects(sendAlert("测试通知", []), /must be a Feishu/);
  assert.equal(requests.length, 0);
});

test("a malformed secret URL is never included in an error", async () => {
  process.env.FEISHU_ALERT_WEBHOOK_URL = "fictional secret with invalid URL";
  await assert.rejects(sendAlert("测试通知", []), (error: Error) => {
    assert.match(error.message, /must be a Feishu/);
    assert.ok(!error.message.includes("fictional secret"));
    return true;
  });
  assert.equal(requests.length, 0);
});
