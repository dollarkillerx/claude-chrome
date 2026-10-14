import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { CLOSE_UNAUTHORIZED, PROTOCOL_VERSION, type Message } from "@claude-chrome/protocol";
import { Hub } from "../src/hub.js";
import { Peer } from "../src/peer.js";
import { BridgeManager } from "../src/manager.js";

const TOKEN = "test-token";
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnop";
const log = () => {};
const cleanups: Array<() => Promise<unknown> | void> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function startHub(extra: Partial<Parameters<typeof Hub.start>[0]> = {}) {
  const hub = await Hub.start({ port: 0, token: TOKEN, log, extensionWaitMs: 300, session: "hub-session", ...extra });
  cleanups.push(() => hub.close());
  return hub;
}

/** Fake extension: answers every request via `handler`. */
type Handler = (method: string, params: unknown) => unknown;

function connectExtension(
  port: number,
  opts: { token?: string; origin?: string; seen?: Message[] } = {},
  handler: Handler = echo,
) {
  return new Promise<{ socket: WebSocket; closeCode?: number }>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: opts.origin ?? EXT_ORIGIN });
    cleanups.push(() => socket.terminate());
    socket.on("open", () =>
      socket.send(
        JSON.stringify({ type: "hello", role: "extension", token: opts.token ?? TOKEN, protocol: PROTOCOL_VERSION }),
      ),
    );
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Message;
      opts.seen?.push(msg);
      if (msg.type === "welcome") resolve({ socket });
      if (msg.type === "request") {
        Promise.resolve(handler(msg.method, msg.params)).then(
          (result) => socket.send(JSON.stringify({ type: "response", id: msg.id, result })),
          (error) =>
            socket.send(JSON.stringify({ type: "response", id: msg.id, error: { code: "INTERNAL", message: String(error) } })),
        );
      }
    });
    socket.on("close", (code) => resolve({ socket, closeCode: code }));
  });
}

function echo(method: string, params: unknown) {
  return { method, params };
}

describe("Hub", () => {
  it("forwards calls to the extension and matches responses by id", async () => {
    const hub = await startHub();
    await connectExtension(hub.port, {}, async (method, params) => {
      // Respond out of order to make sure ids are matched, not FIFO.
      if (method === "tabs_list") await new Promise((r) => setTimeout(r, 50));
      return { method, params };
    });
    const [slow, fast] = await Promise.all([hub.call("tabs_list", {}, "s1"), hub.call("navigate", { url: "x" }, "s1")]);
    expect(slow).toEqual({ method: "tabs_list", params: {} });
    expect(fast).toEqual({ method: "navigate", params: { url: "x" } });
  });

  it("rejects a wrong token", async () => {
    const hub = await startHub();
    const { closeCode } = await connectExtension(hub.port, { token: "nope" });
    expect(closeCode).toBe(CLOSE_UNAUTHORIZED);
    expect(hub.extensionConnected()).toBe(false);
  });

  it("rejects extensions connecting from a web origin", async () => {
    const hub = await startHub();
    const { closeCode } = await connectExtension(hub.port, { origin: "https://evil.example" });
    expect(closeCode).toBe(CLOSE_UNAUTHORIZED);
  });

  it("enforces the configured extension id", async () => {
    const hub = await startHub({ extensionId: "someotherid" });
    const { closeCode } = await connectExtension(hub.port);
    expect(closeCode).toBe(CLOSE_UNAUTHORIZED);
  });

  it("fails with NOT_CONNECTED when no extension shows up", async () => {
    const hub = await startHub();
    await expect(hub.call("tabs_list", {}, "s1")).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });

  it("answers status locally when the extension is absent", async () => {
    const hub = await startHub();
    await expect(hub.call("status", {}, "s1")).resolves.toMatchObject({ extensionConnected: false });
  });

  it("waits for a late extension connection", async () => {
    const hub = await startHub({ extensionWaitMs: 2000 });
    const call = hub.call("tabs_list", {}, "s1");
    setTimeout(() => connectExtension(hub.port), 100);
    await expect(call).resolves.toEqual({ method: "tabs_list", params: {} });
  });

  it("propagates extension errors", async () => {
    const hub = await startHub();
    await connectExtension(hub.port, {}, () => Promise.reject("boom"));
    await expect(hub.call("tabs_list", {}, "s1")).rejects.toMatchObject({ code: "INTERNAL", message: "boom" });
  });

  it("rejects pending calls when the extension disconnects", async () => {
    const hub = await startHub();
    const { socket } = await connectExtension(hub.port, {}, () => new Promise(() => {}));
    const call = hub.call("tabs_list", {}, "s1");
    setTimeout(() => socket.close(), 50);
    await expect(call).rejects.toMatchObject({ code: "NOT_CONNECTED" });
  });
});

describe("sessions", () => {
  it("tags requests with the caller's session, including relayed peer calls", async () => {
    const hub = await startHub();
    const seen: Message[] = [];
    await connectExtension(hub.port, { seen });
    const peer = await Peer.connect({ port: hub.port, token: TOKEN, session: "peer-session", log });
    cleanups.push(() => peer.close());
    await hub.call("tabs_list", {}, "hub-session");
    await peer.call("tabs_list", {}, "peer-session");
    const sessions = seen.filter((m) => m.type === "request").map((m) => (m as { session: string }).session);
    expect(sessions).toEqual(["hub-session", "peer-session"]);
  });

  it("binds the peer's session at hello and ignores what requests claim", async () => {
    const hub = await startHub();
    const seen: Message[] = [];
    await connectExtension(hub.port, { seen });
    const peer = await Peer.connect({ port: hub.port, token: TOKEN, session: "peer-session", log });
    cleanups.push(() => peer.close());
    await peer.call("tabs_list", {}, "hub-session"); // impersonation attempt
    const request = seen.find((m) => m.type === "request") as { session: string };
    expect(request.session).toBe("peer-session");
  });

  it("rejects a second peer claiming an already connected session", async () => {
    const hub = await startHub();
    const first = await Peer.connect({ port: hub.port, token: TOKEN, session: "dup", log });
    cleanups.push(() => first.close());
    await expect(Peer.connect({ port: hub.port, token: TOKEN, session: "dup", log })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(Peer.connect({ port: hub.port, token: TOKEN, session: "hub-session", log })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("announces live sessions when the extension connects, and new peers as they arrive", async () => {
    const hub = await startHub();
    const early = await Peer.connect({ port: hub.port, token: TOKEN, session: "early", log });
    cleanups.push(() => early.close());
    const seen: Message[] = [];
    await connectExtension(hub.port, { seen });
    const late = await Peer.connect({ port: hub.port, token: TOKEN, session: "late", log });
    cleanups.push(() => late.close());
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toContainEqual({ type: "sessions", sessions: ["hub-session", "early"] });
    expect(seen).toContainEqual({ type: "session_start", session: "late" });
  });

  it("ends the hub's own session when the hub shuts down", async () => {
    const hub = await Hub.start({ port: 0, token: TOKEN, log, session: "hub-session" });
    const seen: Message[] = [];
    await connectExtension(hub.port, { seen });
    await hub.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toContainEqual({ type: "session_end", session: "hub-session" });
  });

  it("re-validates file_upload paths relayed from peers", async () => {
    const hub = await startHub({ uploadPolicy: { allowedDirs: [] } });
    await connectExtension(hub.port);
    const peer = await Peer.connect({ port: hub.port, token: TOKEN, session: "peer-session", log });
    cleanups.push(() => peer.close());
    await expect(peer.call("file_upload", { paths: ["relative.txt"] }, "x")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("rejects mismatched protocol versions", async () => {
    const hub = await startHub();
    const closeCode = await new Promise<number>((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${hub.port}`, { origin: EXT_ORIGIN });
      cleanups.push(() => socket.terminate());
      socket.on("open", () =>
        socket.send(JSON.stringify({ type: "hello", role: "extension", token: TOKEN, protocol: PROTOCOL_VERSION - 1 })),
      );
      socket.on("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(CLOSE_UNAUTHORIZED);
  });

  it("notifies the extension when a peer session goes away", async () => {
    const hub = await startHub();
    const seen: Message[] = [];
    await connectExtension(hub.port, { seen });
    const peer = await Peer.connect({ port: hub.port, token: TOKEN, session: "peer-session", log });
    await peer.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toContainEqual({ type: "session_end", session: "peer-session" });
  });
});

describe("Peer", () => {
  it("relays calls through the hub", async () => {
    const hub = await startHub();
    await connectExtension(hub.port);
    const peer = await Peer.connect({ port: hub.port, token: TOKEN, session: "peer-session", log });
    cleanups.push(() => peer.close());
    await expect(peer.call("find", { query: "q" }, "s1")).resolves.toEqual({ method: "find", params: { query: "q" } });
  });

  it("is rejected with a wrong token", async () => {
    const hub = await startHub();
    await expect(Peer.connect({ port: hub.port, token: "bad", session: "peer-session", log })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("BridgeManager", () => {
  it("elects a hub, then a peer, and promotes the peer when the hub goes away", async () => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const first = new BridgeManager({ port, token: TOKEN, log });
    const second = new BridgeManager({ port, token: TOKEN, log });
    cleanups.push(() => second.close());

    await first.get();
    await second.get();
    expect(first.mode).toBe("hub");
    expect(second.mode).toBe("peer");

    await first.close();
    await new Promise((r) => setTimeout(r, 1500));
    expect(second.mode).toBe("hub");
  });
});
