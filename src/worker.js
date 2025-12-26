import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { createClient } from "@supabase/supabase-js";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import readline from "readline/promises";
import { stdin as inputStream, stdout as outputStream } from "process";
import fs from "fs/promises";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TELEGRAM_API_ID = Number(process.env.TELEGRAM_API_ID);
const TELEGRAM_API_HASH = process.env.TELEGRAM_API_HASH;
const BOT_USERNAME = process.env.BOT_USERNAME || "@CatStarssRobot";
const DELAY_BETWEEN_ACCOUNTS_SECONDS =
  Number(process.env.DELAY_BETWEEN_ACCOUNTS_SECONDS) || 10;
const ELIGIBILITY_MINUTES = Number(process.env.ELIGIBILITY_MINUTES) || 240;
const HOUR_INTERVAL_MINUTES = Number(process.env.HOUR_INTERVAL_MINUTES) || 60;
const RUN_ONCE = (process.env.RUN_ONCE || "false") === "true";
const ACCOUNT_TIMEOUT_SECONDS =
  Number(process.env.ACCOUNT_TIMEOUT_SECONDS) || 30;
const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const SESSIONS_SOURCE = (
  process.env.SESSIONS_SOURCE || "supabase"
).toLowerCase();
const LOCAL_SESSIONS_FILE =
  process.env.LOCAL_SESSIONS_FILE || "./sessions.json";
const RUN_SECRET = process.env.RUN_SECRET || "default-secret";
const HTTP_PORT = Number(process.env.HTTP_PORT) || 3000;

let isRunning = false;

if (!TELEGRAM_API_ID || !TELEGRAM_API_HASH) {
  console.error(
    "Missing required Telegram API environment variables. See .env.example"
  );
  process.exit(1);
}

let supabase = null;
if (SESSIONS_SOURCE === "supabase") {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error(
      "SESSIONS_SOURCE=supabase requires SUPABASE_URL and SUPABASE_KEY"
    );
    process.exit(1);
  }
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function log(event, payload = {}) {
  const entry = { ts: new Date().toISOString(), event, ...payload };
  console.log(JSON.stringify(entry));
}

const originalError = console.error;
console.error = function (...args) {
  const msg = String(args[0] || "");
  const fullArgs = args.map((a) => String(a)).join(" ");
  if (
    msg.includes("TIMEOUT") ||
    fullArgs.includes("_updateLoop") ||
    fullArgs.includes("updates.js") ||
    msg.includes("Connection reset") ||
    msg.includes("connection closed")
  ) {
    return;
  }
  originalError.apply(console, args);
};

process.on("unhandledRejection", (reason) => {
  const msg = String(reason?.message || reason || "");
  const stack = String(reason?.stack || "");
  if (
    msg.includes("TIMEOUT") &&
    (stack.includes("updates.js") || stack.includes("_updateLoop"))
  ) {
    return;
  }
  console.error("Unhandled rejection:", reason);
});

async function ask(question) {
  const rl = readline.createInterface({
    input: inputStream,
    output: outputStream,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function fetchActiveSessions() {
  if (SESSIONS_SOURCE === "local") {
    try {
      const raw = await fs.readFile(LOCAL_SESSIONS_FILE, "utf-8");
      const arr = JSON.parse(raw || "[]");
      return (arr || [])
        .filter((r) => r.status === "active")
        .sort((a, b) => (a.id || 0) - (b.id || 0));
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  const { data, error } = await supabase
    .from("sessions")
    .select("id,phone,session_string,last_click,status")
    .eq("status", "active")
    .order("id", { ascending: true });

  if (error) throw error;
  return data || [];
}

function isEligible(last_click) {
  if (!last_click) return true;
  const last = new Date(last_click);
  const diff = (Date.now() - last.getTime()) / 1000 / 60;
  return diff >= ELIGIBILITY_MINUTES;
}

async function markLastClick(id) {
  if (SESSIONS_SOURCE === "local") {
    try {
      const raw = await fs.readFile(LOCAL_SESSIONS_FILE, "utf-8");
      const arr = JSON.parse(raw || "[]");
      const idx = arr.findIndex((r) => String(r.id) === String(id));
      if (idx !== -1) {
        arr[idx].last_click = new Date().toISOString();
        await fs.writeFile(
          LOCAL_SESSIONS_FILE,
          JSON.stringify(arr, null, 2),
          "utf-8"
        );
      }
    } catch (e) {
      console.warn("Failed to update local sessions file:", e?.message || e);
    }
    return;
  }

  await supabase
    .from("sessions")
    .update({
      last_click: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

async function markError(id, reason) {
  if (SESSIONS_SOURCE === "local") {
    try {
      const raw = await fs.readFile(LOCAL_SESSIONS_FILE, "utf-8");
      const arr = JSON.parse(raw || "[]");
      const idx = arr.findIndex((r) => String(r.id) === String(id));
      if (idx !== -1) {
        arr[idx].status = "error";
        arr[idx].error_reason = reason;
        await fs.writeFile(
          LOCAL_SESSIONS_FILE,
          JSON.stringify(arr, null, 2),
          "utf-8"
        );
      }
    } catch (e) {
      console.warn("Failed to update local sessions file:", e?.message || e);
    }
    return;
  }

  await supabase
    .from("sessions")
    .update({
      status: "error",
      error_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}

async function clearStaleInProgress() {
  const staleThresholdMs = 60 * 60 * 1000;
  const cutoffIso = new Date(Date.now() - staleThresholdMs).toISOString();

  if (SESSIONS_SOURCE === "local") {
    try {
      const raw = await fs.readFile(LOCAL_SESSIONS_FILE, "utf-8");
      const arr = JSON.parse(raw || "[]");
      const now = Date.now();
      let modified = false;
      for (const row of arr) {
        if (row.status === "in_progress" && row.in_progress_since) {
          const since = new Date(row.in_progress_since).getTime();
          if (now - since > staleThresholdMs) {
            row.status = "active";
            row.in_progress_since = null;
            modified = true;
            log("startup_cleared_stale_in_progress", { id: row.id });
          }
        }
      }
      if (modified) {
        await fs.writeFile(
          LOCAL_SESSIONS_FILE,
          JSON.stringify(arr, null, 2),
          "utf-8"
        );
      }
    } catch (e) {
      console.warn("Failed to clear stale in_progress:", e?.message || e);
    }
    return;
  }

  if (SESSIONS_SOURCE === "supabase" && supabase) {
    try {
      const { data, error } = await supabase
        .from("sessions")
        .update({
          status: "active",
          in_progress_since: null,
          updated_at: new Date().toISOString(),
        })
        .lt("in_progress_since", cutoffIso)
        .eq("status", "in_progress");
      if (error) throw error;
    } catch (e) {
      console.warn(
        "Failed to clear stale in_progress in Supabase:",
        e?.message || e
      );
    }
  }
}

async function safeDisconnect(client) {
  try {
    if (client._updatesHandler) client._updatesHandler = null;
    if (client._updateLoop) {
      try {
        client._updateLoop.cancel?.();
      } catch (e) {}
      client._updateLoop = null;
    }
    await client.disconnect();
  } catch (e) {}
}

async function processAccount(row) {
  const { id, phone, session_string } = row;
  log("account_start", { phone, id });

  if (SESSIONS_SOURCE === "local") {
    try {
      const raw = await fs.readFile(LOCAL_SESSIONS_FILE, "utf-8");
      const arr = JSON.parse(raw || "[]");
      const idx = arr.findIndex((r) => String(r.id) === String(id));
      if (idx !== -1) {
        arr[idx].status = "in_progress";
        arr[idx].in_progress_since = new Date().toISOString();
        await fs.writeFile(
          LOCAL_SESSIONS_FILE,
          JSON.stringify(arr, null, 2),
          "utf-8"
        );
      }
    } catch (e) {
      console.warn("Failed to mark in_progress:", e?.message || e);
    }
  }

  const stringSession = new StringSession(session_string || "");
  const client = new TelegramClient(
    stringSession,
    TELEGRAM_API_ID,
    TELEGRAM_API_HASH,
    { connectionRetries: 3, requestRetries: 3, updateHandler: null }
  );

  if (client._updatesHandler) client._updatesHandler = null;
  if (client._updateLoop) {
    try {
      client._updateLoop.cancel?.();
    } catch (e) {}
    client._updateLoop = null;
  }

  const work = (async () => {
    await client.start({
      botAuthToken: undefined,
      phoneNumber: async () => phone,
      password: async () => await ask("Two-step password (if required): "),
      phoneCode: async () => await ask("Phone code (if required): "),
    });

    // Send start
    await client.sendMessage(BOT_USERNAME, { message: "/start" });
    await sleep(5000);

    let botEntity = await client.getEntity(BOT_USERNAME);
    let messages = await client.getMessages(botEntity, { limit: 5 });

    // --- START NEW SUBSCRIPTION GATE LOGIC ---
    const subMsg = messages.find(
      (m) =>
        m.replyMarkup && JSON.stringify(m.replyMarkup).includes("Я подписался")
    );

    if (subMsg) {
      log("subscription_gate_found", { phone });
      const subRows = subMsg.replyMarkup.rows || [];
      let subData = null;
      for (const row of subRows) {
        for (const btn of row.buttons) {
          if ((btn.text || "").includes("Я подписался")) {
            subData = btn.data || btn.callbackData || null;
            break;
          }
        }
        if (subData) break;
      }

      if (subData) {
        try {
          await client.invoke(
            new Api.messages.GetBotCallbackAnswer({
              peer: subMsg.peerId,
              msgId: subMsg.id,
              data: subData,
            })
          );
          log("subscription_confirmed", { phone });
          await sleep(5000);
          // Re-fetch messages after clicking to find the Bonus button
          messages = await client.getMessages(botEntity, { limit: 5 });
        } catch (e) {
          log("subscription_click_failed", { phone, error: e.message });
        }
      }
    }
    // --- END NEW SUBSCRIPTION GATE LOGIC ---

    if (!messages || messages.length === 0) {
      log("bonus_unavailable", { phone, reason: "no_messages" });
      await safeDisconnect(client);
      return;
    }

    const msg = messages.find(
      (m) => m.replyMarkup && JSON.stringify(m.replyMarkup).includes("Бонус")
    );

    if (!msg) {
      log("bonus_unavailable", { phone, reason: "no_matching_button" });
      await safeDisconnect(client);
      return;
    }

    const rows = msg.replyMarkup.rows || [];
    let targetData = null;
    for (const row of rows) {
      for (const btn of row.buttons) {
        const text = btn.text || btn.message || "";
        if (text.includes("Бонус")) {
          targetData = btn.data || btn.callbackData || null;
          break;
        }
      }
      if (targetData) break;
    }

    if (!targetData) {
      log("bonus_unavailable", { phone, reason: "no_callback_data" });
      await safeDisconnect(client);
      return;
    }

    try {
      const dataBuf = Buffer.isBuffer(targetData)
        ? targetData
        : Buffer.from(String(targetData), "utf-8");
      await client.invoke(
        new Api.messages.GetBotCallbackAnswer({
          peer: msg.peerId,
          msgId: msg.id,
          data: dataBuf,
          game: false,
        })
      );
    } catch (invokeErr) {
      log("account_error", { phone, error: String(invokeErr) });
      await markError(id, String(invokeErr));
      await safeDisconnect(client);
      return;
    }

    log("bonus_clicked", { phone, id });
    await sleep(5000);
    await markLastClick(id);
    await safeDisconnect(client);
  })();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error("account_timeout")),
      ACCOUNT_TIMEOUT_SECONDS * 1000
    )
  );

  try {
    await Promise.race([work, timeoutPromise]);
  } catch (err) {
    const em = String(err?.message || err);
    if (/FLOOD_WAIT|FLOOD/i.test(em)) {
      const m = em.match(/(\d+)/);
      const wait = m ? Number(m[0]) : 60;
      log("flood_wait", { phone, wait_seconds: wait });
      await sleep((wait + 2) * 1000);
      await safeDisconnect(client);
      // Reset status so it can retry
      if (SESSIONS_SOURCE === "local") {
        const raw = await fs.readFile(LOCAL_SESSIONS_FILE, "utf-8");
        const arr = JSON.parse(raw);
        const idx = arr.findIndex((r) => String(r.id) === String(id));
        if (idx !== -1) {
          arr[idx].status = "active";
          arr[idx].in_progress_since = null;
          await fs.writeFile(LOCAL_SESSIONS_FILE, JSON.stringify(arr, null, 2));
        }
      } else {
        await supabase
          .from("sessions")
          .update({ status: "active", in_progress_since: null })
          .eq("id", id);
      }
      return;
    }

    if (em === "account_timeout") {
      log("timeout", { phone, id });
      await safeDisconnect(client);
      if (SESSIONS_SOURCE === "local") {
        const raw = await fs.readFile(LOCAL_SESSIONS_FILE, "utf-8");
        const arr = JSON.parse(raw);
        const idx = arr.findIndex((r) => String(r.id) === String(id));
        if (idx !== -1) {
          arr[idx].status = "active";
          arr[idx].in_progress_since = null;
          await fs.writeFile(LOCAL_SESSIONS_FILE, JSON.stringify(arr, null, 2));
        }
      } else {
        await supabase
          .from("sessions")
          .update({ status: "active", in_progress_since: null })
          .eq("id", id);
      }
      return;
    }

    log("account_error", { phone, error: em });
    await markError(id, em);
    await safeDisconnect(client);
  }
}

async function runOnce() {
  console.log("hour_start: ", new Date().toISOString());
  let rows;
  try {
    rows = await fetchActiveSessions();
  } catch (err) {
    console.error("Failed to fetch sessions:", err);
    return;
  }

  for (const row of rows) {
    if (!isEligible(row.last_click)) {
      console.log(`account_skipped_not_eligible: ${row.phone}`);
      continue;
    }
    await processAccount(row);
    await sleep(DELAY_BETWEEN_ACCOUNTS_SECONDS * 1000);
  }
  console.log("hour_complete: ", new Date().toISOString());
}

async function startHttpServer() {
  const app = express();
  app.use(express.json());
  app.get("/health", (req, res) =>
    res.json({ status: "ok", ts: new Date().toISOString() })
  );

  const runHandler = (req, res) => {
    const token = req.query.token || req.headers["x-run-secret"];
    if (token && token !== RUN_SECRET)
      return res.status(401).json({ error: "Unauthorized" });
    if (isRunning)
      return res.status(409).json({ error: "Run already in progress" });

    isRunning = true;
    runOnce()
      .catch((e) => console.error("Run error:", e))
      .finally(() => {
        isRunning = false;
      });
    res.json({ status: "started", ts: new Date().toISOString() });
  };

  app.get("/run", runHandler);
  app.post("/run", runHandler);
  app.head("/run", runHandler);
  app.listen(HTTP_PORT, () => console.log(`Server on port ${HTTP_PORT}`));
}

async function mainLoop() {
  await startHttpServer();
  await clearStaleInProgress();
  if (RUN_ONCE) {
    console.log("RUN_ONCE=true; awaiting /run endpoint trigger");
    return;
  }
}

mainLoop().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
