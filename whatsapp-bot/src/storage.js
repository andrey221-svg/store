import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function safeName(id) {
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/** Facts the owner asked the bot to remember (address, name, allergies...). */
export const profile = {
  file: () => path.join(config.dataDir, "profile.json"),
  load() {
    return readJson(this.file(), {});
  },
  set(key, value) {
    const data = this.load();
    if (value === null || value === "") delete data[key];
    else data[key] = value;
    writeJson(this.file(), data);
    return data;
  },
};

/** Conversation history per chat, so the bot keeps context between messages and restarts. */
export const sessions = {
  file: (chatId) => path.join(config.sessionsDir, `${safeName(chatId)}.json`),
  load(chatId) {
    return readJson(this.file(chatId), null);
  },
  save(chatId, session) {
    writeJson(this.file(chatId), session);
  },
  reset(chatId) {
    try {
      fs.rmSync(this.file(chatId));
    } catch {
      // nothing to delete
    }
  },
};

/** Small key/value state: the owner's chat id, businesses the bot messaged, etc. */
export const state = {
  file: () => path.join(config.dataDir, "state.json"),
  load() {
    return readJson(this.file(), { ownerChat: null, contacted: {} });
  },
  update(mutator) {
    const data = this.load();
    mutator(data);
    writeJson(this.file(), data);
    return data;
  },
};
