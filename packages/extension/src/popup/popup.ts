import type { ConnectionStatus } from "../background";
import { getSettings, saveSettings } from "../settings";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const LABELS: Record<ConnectionStatus["state"], string> = {
  connected: "已连接",
  connecting: "连接中…",
  disconnected: "未连接",
  unauthorized: "Token 错误",
  replaced: "已被其他实例接管",
  paused: "已暂停",
  no_token: "未配对",
};

const DETAILS: Partial<Record<ConnectionStatus["state"], string>> = {
  disconnected: "本地 MCP Server 未运行（启动一个 Claude Code 会话即可）",
  unauthorized: "Token 与 ~/.claude-chrome/token 不一致",
  replaced: "另一个 Chrome 配置文件中的插件连上了；点「保存并连接」可抢回",
  paused: "Claude 当前无法操作浏览器",
  no_token: "请粘贴配对 Token",
};

function render(status: ConnectionStatus): void {
  $("dot").className = `dot ${status.state}`;
  $("state").textContent = LABELS[status.state] + (status.port && status.state === "connected" ? ` · 127.0.0.1:${status.port}` : "");
  $("detail").textContent = DETAILS[status.state] ?? "";
}

async function init(): Promise<void> {
  const settings = await getSettings();
  $<HTMLInputElement>("token").value = settings.token;
  $<HTMLInputElement>("port").value = String(settings.port);
  $<HTMLTextAreaElement>("blocked").value = settings.blockedHosts.join("\n");
  $("pause").textContent = settings.paused ? "恢复控制" : "暂停控制";

  render(await chrome.runtime.sendMessage({ type: "getStatus" }));
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "status") render(message.status);
  });

  $("toggleToken").addEventListener("click", () => {
    const input = $<HTMLInputElement>("token");
    input.type = input.type === "password" ? "text" : "password";
  });

  $("save").addEventListener("click", async () => {
    const port = Number($<HTMLInputElement>("port").value) || settings.port;
    const blockedHosts = $<HTMLTextAreaElement>("blocked")
      .value.split(/\s+/)
      .map((h) => h.trim())
      .filter(Boolean);
    await saveSettings({ token: $<HTMLInputElement>("token").value.trim(), port, blockedHosts, paused: false });
    $("pause").textContent = "暂停控制";
    render(await chrome.runtime.sendMessage({ type: "reconnect" }));
  });

  $("pause").addEventListener("click", async () => {
    const { paused } = await getSettings();
    await saveSettings({ paused: !paused });
    $("pause").textContent = paused ? "暂停控制" : "恢复控制";
  });

  $("detach").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "detachAll" });
    $("detail").textContent = "已断开所有调试会话";
  });
}

void init();
