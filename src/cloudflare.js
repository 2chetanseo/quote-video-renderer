// Cloudflare Workers AI client with multi-account rotation + failover.
//
// Configure accounts via env vars. Two ways:
//  1) JSON list:  CF_ACCOUNTS='[{"id":"acct1","token":"tok1"},{"id":"acct2","token":"tok2"}]'
//  2) Individual:  CF_ACCOUNT_ID / CF_API_TOKEN  and  CF_ACCOUNT_ID_2 / CF_API_TOKEN_2
//
// The client round-robins across accounts and, on a 429 / quota (code 4006)
// error, automatically retries the same request on the next account.

const IMAGE_MODEL = process.env.CF_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell";
const TEXT_MODEL = process.env.CF_TEXT_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function loadAccounts() {
  const accounts = [];
  if (process.env.CF_ACCOUNTS) {
    try {
      for (const a of JSON.parse(process.env.CF_ACCOUNTS)) {
        if (a && a.id && a.token) accounts.push({ id: a.id, token: a.token });
      }
    } catch (e) {
      console.warn("CF_ACCOUNTS is not valid JSON:", e.message);
    }
  }
  // Individual env pairs: CF_ACCOUNT_ID(+_2,_3...) / CF_API_TOKEN(+_2,_3...)
  const pairs = [
    [process.env.CF_ACCOUNT_ID, process.env.CF_API_TOKEN],
    [process.env.CF_ACCOUNT_ID_2, process.env.CF_API_TOKEN_2],
    [process.env.CF_ACCOUNT_ID_3, process.env.CF_API_TOKEN_3],
  ];
  for (const [id, token] of pairs) {
    if (id && token && !accounts.some((a) => a.id === id)) accounts.push({ id, token });
  }
  return accounts;
}

const ACCOUNTS = loadAccounts();
let rr = 0; // round-robin cursor

export function cfConfigured() {
  return ACCOUNTS.length > 0;
}

export function cfAccountCount() {
  return ACCOUNTS.length;
}

// Order accounts starting at the round-robin cursor, then advance it.
function accountOrder() {
  if (!ACCOUNTS.length) return [];
  const order = [];
  for (let i = 0; i < ACCOUNTS.length; i++) {
    order.push(ACCOUNTS[(rr + i) % ACCOUNTS.length]);
  }
  rr = (rr + 1) % ACCOUNTS.length;
  return order;
}

function isRetryable(status, bodyText) {
  if (status === 429) return true;
  if (bodyText && /\b4006\b|daily free allocation|too many requests|capacity/i.test(bodyText)) return true;
  return false;
}

/**
 * Generate quote JSON via chat completions. Rotates accounts on rate/quota errors.
 * Returns the parsed JSON object { quote, author, description, hashtags }.
 */
export async function cfQuote(idea) {
  const messages = [
    {
      role: "system",
      content:
        "You are a social media copywriter for motivational/wealth-mindset short videos. You ALWAYS respond with a single valid JSON object and nothing else.",
    },
    {
      role: "user",
      content:
        `Idea: "${idea}"\nReturn JSON keys: quote (<=200 chars, punchy), author (or "Unknown"), ` +
        `description (2-3 sentences), hashtags (array of 8-12). JSON only.`,
    },
  ];

  let lastErr = "no accounts configured";
  for (const acct of accountOrder()) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${acct.id}/ai/v1/chat/completions`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${acct.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: TEXT_MODEL, response_format: { type: "json_object" }, messages }),
      });
      const text = await resp.text();
      if (!resp.ok) {
        lastErr = `acct ${acct.id.slice(0, 6)}: ${resp.status} ${text.slice(0, 200)}`;
        if (isRetryable(resp.status, text)) continue; // try next account
        throw new Error(lastErr);
      }
      const data = JSON.parse(text);
      let content = data?.choices?.[0]?.message?.content || "";
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : {};
      }
      return parsed;
    } catch (e) {
      lastErr = String(e?.message || e);
      // network error -> try next account too
      continue;
    }
  }
  throw new Error(`cfQuote failed on all accounts: ${lastErr}`);
}

/**
 * Generate a background image (returns a Buffer). Rotates accounts on rate/quota.
 */
export async function cfImage(prompt) {
  const fullPrompt =
    `Cinematic vertical 9:16 background for a motivational quote short. ${prompt}. ` +
    `Moody, dramatic lighting, dark tones so white text is readable, no text, no watermark, high detail.`;

  let lastErr = "no accounts configured";
  for (const acct of accountOrder()) {
    try {
      const url = `https://api.cloudflare.com/client/v4/accounts/${acct.id}/ai/run/${IMAGE_MODEL}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${acct.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: fullPrompt }),
      });
      const ct = resp.headers.get("content-type") || "";
      if (!resp.ok) {
        const t = await resp.text();
        lastErr = `acct ${acct.id.slice(0, 6)}: ${resp.status} ${t.slice(0, 200)}`;
        if (isRetryable(resp.status, t)) continue;
        throw new Error(lastErr);
      }
      if (ct.includes("application/json")) {
        const data = await resp.json();
        const b64 = data?.result?.image;
        if (!b64) {
          lastErr = `acct ${acct.id.slice(0, 6)}: empty image`;
          continue;
        }
        return Buffer.from(b64, "base64");
      }
      return Buffer.from(await resp.arrayBuffer());
    } catch (e) {
      lastErr = String(e?.message || e);
      continue;
    }
  }
  throw new Error(`cfImage failed on all accounts: ${lastErr}`);
}
