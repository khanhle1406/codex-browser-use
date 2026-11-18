#!/opt/homebrew/bin/node

import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const SOCKET_PATH = "/tmp/antigravity-browser-gateway.sock";
const LOG_FILE = "/tmp/antigravity-browser-gateway.log";

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(" ")}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

log("Starting Antigravity Native Messaging Host...");

// --- Chrome Native Messaging Stdio Protocol ---
let incomingBuffer = Buffer.alloc(0);
const pendingToChrome = new Map();
let nextChromeMsgId = 0;

function sendToChrome(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextChromeMsgId;
    const msg = { id, method, params };
    const payload = Buffer.from(JSON.stringify(msg), "utf-8");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);

    pendingToChrome.set(id, { resolve, reject });

    try {
      process.stdout.write(header);
      process.stdout.write(payload);
    } catch (err) {
      pendingToChrome.delete(id);
      reject(err);
    }
  });
}

process.stdin.on("data", (chunk) => {
  incomingBuffer = Buffer.concat([incomingBuffer, chunk]);

  while (incomingBuffer.length >= 4) {
    const msgLength = incomingBuffer.readUInt32LE(0);
    if (incomingBuffer.length < 4 + msgLength) {
      break; // Wait for more data
    }

    const msgBytes = incomingBuffer.subarray(4, 4 + msgLength);
    incomingBuffer = incomingBuffer.subarray(4 + msgLength);

    try {
      const msg = JSON.parse(msgBytes.toString("utf-8"));
      handleChromeMessage(msg);
    } catch (err) {
      log("Error parsing message from Chrome:", err.message);
    }
  }
});

function handleChromeMessage(msg) {
  if (msg.id && pendingToChrome.has(msg.id)) {
    const { resolve, reject } = pendingToChrome.get(msg.id);
    pendingToChrome.delete(msg.id);
    if (msg.error) {
      reject(new Error(msg.error));
    } else {
      resolve(msg.result);
    }
    return;
  }

  // Broadcast events from Chrome to connected agent clients
  if (msg.event) {
    broadcastToClients(msg);
  }
}

// --- Multi-Client Agent Gateway Server ---
const connectedClients = new Set();
const claimedTabs = new Map(); // tabId -> clientId

if (fs.existsSync(SOCKET_PATH)) {
  try {
    fs.unlinkSync(SOCKET_PATH);
  } catch {}
}

const gatewayServer = net.createServer((socket) => {
  const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  log("Agent client connected:", clientId);
  connectedClients.add(socket);

  let clientBuffer = "";
  socket.on("data", async (chunk) => {
    clientBuffer += chunk.toString("utf-8");
    const lines = clientBuffer.split("\n");
    clientBuffer = lines.pop(); // keep remainder

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line);
        const res = await processAgentRequest(clientId, req);
        socket.write(`${JSON.stringify({ id: req.id, ok: true, result: res })}\n`);
      } catch (err) {
        log("Client request error:", err.message);
        try {
          const req = JSON.parse(line);
          socket.write(`${JSON.stringify({ id: req.id, ok: false, error: err.message })}\n`);
        } catch {}
      }
    }
  });

  socket.on("close", () => {
    log("Agent client disconnected:", clientId);
    connectedClients.delete(socket);
    // Release claimed tabs for this client
    for (const [tabId, owner] of claimedTabs.entries()) {
      if (owner === clientId) {
        claimedTabs.delete(tabId);
        log(`Released claimed tab ${tabId} from ${clientId}`);
      }
    }
  });

  socket.on("error", (err) => {
    log("Socket error for client", clientId, ":", err.message);
  });
});

gatewayServer.listen(SOCKET_PATH, () => {
  try {
    fs.chmodSync(SOCKET_PATH, 0o777);
  } catch {}
  log("Gateway socket listening at", SOCKET_PATH);
});

function broadcastToClients(msg) {
  const payload = `${JSON.stringify(msg)}\n`;
  for (const client of connectedClients) {
    try {
      client.write(payload);
    } catch {}
  }
}

async function processAgentRequest(clientId, req) {
  const { method, params = {} } = req;

  switch (method) {
    case "list_tabs": {
      const tabs = await sendToChrome("list_tabs");
      return tabs.map(t => ({
        ...t,
        claimed_by: claimedTabs.get(t.tabId) || null,
        is_mine: claimedTabs.get(t.tabId) === clientId,
      }));
    }

    case "claim_tab": {
      const tabId = Number(params.tabId);
      const currentOwner = claimedTabs.get(tabId);
      if (currentOwner && currentOwner !== clientId) {
        throw new Error(`Tab ${tabId} is already claimed by another agent (${currentOwner}).`);
      }
      claimedTabs.set(tabId, clientId);
      await sendToChrome("attach_debugger", { tabId });
      return { tabId, claimed: true };
    }

    case "release_tab": {
      const tabId = Number(params.tabId);
      if (claimedTabs.get(tabId) === clientId) {
        claimedTabs.delete(tabId);
        await sendToChrome("detach_debugger", { tabId });
      }
      return { tabId, released: true };
    }

    case "new_tab": {
      const tab = await sendToChrome("new_tab", params);
      claimedTabs.set(tab.tabId, clientId);
      await sendToChrome("attach_debugger", { tabId: tab.tabId });
      return tab;
    }

    case "select_tab": {
      return sendToChrome("select_tab", params);
    }

    case "close_tab": {
      const tabId = Number(params.tabId);
      claimedTabs.delete(tabId);
      return sendToChrome("close_tab", params);
    }

    case "send_cdp": {
      const tabId = Number(params.tabId);
      const owner = claimedTabs.get(tabId);
      if (owner && owner !== clientId) {
        throw new Error(`Permission denied: Tab ${tabId} is claimed by another agent.`);
      }
      return sendToChrome("send_cdp", params);
    }

    case "move_mouse": {
      return sendToChrome("move_mouse", params);
    }

    default:
      throw new Error(`Unsupported gateway method: ${method}`);
  }
}

process.on("exit", () => {
  log("Native host exiting...");
  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {}
  }
});
