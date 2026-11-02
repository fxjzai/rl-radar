import "./standalone.ts";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { SITE } from "@aihot/site";
import { formatAlert, formatRecovery, sendAlert } from "@aihot/backend/notify/feishu";

const originalFetch = globalThis.fetch;
const keys = ["FEISHU_INTERNAL_ENABLED", "FEISHU_ALERT_WEBHOOK_URL", "FEISHU_ALERT_CHAT_ID", "FEISHU_INTERNAL_CHAT_ID", "FEISHU_APP_ID", "FEISHU_APP_SECRET"];
const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
interface Card {
  schema: string;
  header: { title: { content: string }; subtitle: { content: string }; template: string };
  config: { summary: { content: string } };
  body: { elements: Array<{ tag: string; content?: string; behaviors?: Array<{ type: string; default_url: string }> }> };
}
const requests: Array<{ url: string; body: { msg_type: string; card: Card; content: string } }> = [];
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
  assert.equal(requests[0].body.msg_type, "interactive");
  const card = requests[0].body.card;
  assert.equal(card.schema, "2.0");
  assert.ok(card.header.title.content.startsWith(`【${SITE.name}】`));
  assert.match(card.body.elements[0].content!, /这是测试，不是真实故障。/);
  assert.match(card.config.summary.content, /运行通知 · 测试通知/);
  assert.ok(card.body.elements.some(e => e.content?.includes("北京时间")));
  assert.match(card.body.elements.at(-1)!.behaviors![0].default_url, /\/admin$/);
});

for (const [prefix, color, status] of [["🔴", "red", "需立即处理"], ["🟠", "orange", "今日跟进"], ["✅", "green", "已恢复"], ["📋", "blue", "系统日报"], ["📊", "blue", "信源周报"]]) {
  test(`${status} has a distinct card header`, async () => {
    await sendAlert(`${prefix} 通知标题`, ["第一段", "", "第二段"]);
    const card = requests[0].body.card;
    assert.equal(card.header.template, color);
    assert.equal(card.header.subtitle.content, status);
    assert.ok(card.header.title.content.endsWith("通知标题"));
    assert.match(card.body.elements[0].content!, /第一段\n\n\n\n第二段/);
  });
}

test("an alert renders impact, recovery and action as labeled sections, including repeat duration", async () => {
  const since = new Date("2026-11-03T00:00:00Z");
  const msg = formatAlert({ key: "test", level: "now", title: "采集暂停", impact: "没有新内容", heals: "不会自动恢复", action: "检查服务" }, since, since.getTime() + 3600_000, true);
  await sendAlert(msg.title, msg.lines);
  const card = requests[0].body.card;
  assert.match(card.header.title.content, /仍未恢复：采集暂停（已持续 1 小时）/);
  assert.equal(card.body.elements[0].content, "**影响范围**\n没有新内容\n\n**恢复方式**\n不会自动恢复\n\n**处理建议**\n检查服务");
  const recovery = formatRecovery("采集暂停", since, since.getTime() + 3600_000);
  await sendAlert(recovery.title, recovery.lines);
  assert.match(requests[1].body.card.body.elements[0].content!, /持续 1 小时（11月3日 08:00 起）/);
});

test("source and error text cannot inject card mentions or Markdown", async () => {
  await sendAlert("测试", ["影响：<at id=all></at> **假重点** [链接](https://example.com) &"]);
  const content = requests[0].body.card.body.elements[0].content!;
  assert.ok(!content.includes("<at"));
  assert.ok(content.includes("&lt;at id=all&gt;"));
  assert.ok(content.includes("\\*\\*假重点\\*\\*"));
  assert.ok(content.includes("\\[链接\\]"));
});

test("long reports stay below the custom bot's 20 KB limit and retain the backend link", async () => {
  await sendAlert("📊 信源周报", ["本周收录 100 条", ...Array.from({ length: 500 }, () => "信源异常".repeat(100))]);
  assert.ok(Buffer.byteLength(JSON.stringify(requests[0].body)) < 20_000);
  assert.match(requests[0].body.card.body.elements[0].content!, /本周收录 100 条/);
  assert.match(requests[0].body.card.body.elements[0].content!, /内容较长/);
  assert.equal(requests[0].body.card.body.elements.at(-1)!.tag, "button");
});

test("a single oversized section keeps its beginning instead of hiding the whole message", async () => {
  await sendAlert("📊 信源周报", ["本周收录 100 条。" + "异常详情".repeat(6000)]);
  assert.ok(Buffer.byteLength(JSON.stringify(requests[0].body)) < 20_000);
  assert.match(requests[0].body.card.body.elements[0].content!, /^本周收录 100 条。/);
  assert.match(requests[0].body.card.body.elements[0].content!, /内容较长/);
});

test("the application chat receives the same structured card serialized as content", async () => {
  delete process.env.FEISHU_ALERT_WEBHOOK_URL;
  Object.assign(process.env, { FEISHU_ALERT_CHAT_ID: "fictional-chat", FEISHU_APP_ID: "fictional-app", FEISHU_APP_SECRET: "fictional-secret" });
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json(String(input).includes("tenant_access_token")
      ? { code: 0, tenant_access_token: "fictional-token", expire: 3600 }
      : { code: 0, data: { message_id: "fictional-message" } });
  }) as typeof fetch;
  assert.equal(await sendAlert("✅ 已恢复：采集", ["持续 1 分钟"]), "sent");
  const request = requests.at(-1)!;
  assert.equal(request.body.msg_type, "interactive");
  const card = JSON.parse(request.body.content) as Card;
  assert.equal(card.schema, "2.0");
  assert.equal(card.header.template, "green");
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
