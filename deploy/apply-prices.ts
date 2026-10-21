// The IC deployment only runs its worker during off-peak hours. This command configures the
// existing cost estimator; it never calls a model or changes any provider's account/balance.
// Verified 2026-10-21: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
import { sql, closeDb } from "@aihot/backend/db";
import { audit } from "@aihot/backend/audit";

const price = { service: "llm", model: "deepseek-flash", currency: "CNY", input: 1, cached: 0.02, output: 4 };
try {
  if (new URL(process.env.LLM_BASE_URL ?? "http://unset").hostname !== "api.deepseek.com" || process.env.LLM_MODEL !== price.model) {
    throw new Error("This price sheet requires the official DeepSeek Flash default model");
  }
  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify({ dryRun: true, price, basis: "off-peak token estimate; not a bill" }));
  } else {
    await sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM service_prices WHERE service = ${price.service} AND model = ${price.model} FOR UPDATE`;
      if (before && before.currency === price.currency && Number(before.input_per_mtok) === price.input && Number(before.cached_per_mtok) === price.cached && Number(before.output_per_mtok) === price.output) return;
      await tx`INSERT INTO service_prices (service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok)
        VALUES (${price.service}, ${price.model}, ${price.currency}, ${price.input}, ${price.cached}, ${price.output})
        ON CONFLICT (service, model) DO UPDATE SET currency = EXCLUDED.currency, input_per_mtok = EXCLUDED.input_per_mtok,
          cached_per_mtok = EXCLUDED.cached_per_mtok, output_per_mtok = EXCLUDED.output_per_mtok, updated_at = now()`;
      await audit("operator", "prices.configure", "service:llm", "IC worker runs off-peak; official prices verified 2026-10-21", before ?? null, price, { db: tx });
    });
    console.log(JSON.stringify({ configured: true, price, basis: "off-peak token estimate; not a bill" }));
  }
} finally {
  await closeDb();
}
