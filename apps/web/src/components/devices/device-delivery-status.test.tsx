import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { DeviceDeliveryStatus } from "./device-delivery-status";

afterEach(() => vi.unstubAllGlobals());

it("shows a concrete Mac delivery failure on the execution page", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    status: "failed", errorCode: "PHONE_FILE_NOT_FOUND", updatedAt: "2026-08-06T04:00:00Z"
  })));
  render(<DeviceDeliveryStatus executionId="EX-1" />);
  expect(await screen.findByText(/Mac 上找不到号码文件/)).toBeInTheDocument();
});

it("tells the user that the Mac is waiting for one-time Accessibility approval", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    status: "waiting_permission",
    errorCode: "MAC_ACCESSIBILITY_REQUIRED",
    updatedAt: "2026-08-06T04:00:00Z"
  })));
  render(<DeviceDeliveryStatus executionId="EX-1" />);
  expect(await screen.findByText(/等待同事在 Mac 上允许辅助功能/)).toBeInTheDocument();
});

it("does not call a successful keystroke delivery a successful Codex handoff", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    status: "prompt_sent", errorCode: null, updatedAt: "2026-08-06T04:00:00Z", retryable: false
  })));
  render(<DeviceDeliveryStatus executionId="EX-1" />);
  expect(await screen.findByText(/等待 Codex 接管/)).toBeInTheDocument();
  expect(screen.queryByText(/任务已经自动发送给 Codex/)).not.toBeInTheDocument();
});

it("shows verified success after the Codex agent starts", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    status: "agent_started", errorCode: null, updatedAt: "2026-08-06T04:00:00Z", retryable: false
  })));
  render(<DeviceDeliveryStatus executionId="EX-1" />);
  expect(await screen.findByText(/Codex 已接管任务/)).toBeInTheDocument();
});

it("lets the user explicitly retry an acknowledgement timeout", async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({
      status: "ack_timeout",
      errorCode: "CODEX_ACK_TIMEOUT",
      updatedAt: "2026-08-06T04:00:00Z",
      retryable: true
    }))
    .mockResolvedValueOnce(Response.json({
      status: "queued", errorCode: null, updatedAt: "2026-08-06T04:01:01Z", retryable: false
    }));
  vi.stubGlobal("fetch", fetch);
  render(<DeviceDeliveryStatus executionId="EX-1" />);

  await userEvent.click(await screen.findByRole("button", { name: "重新发送" }));

  expect(fetch).toHaveBeenNthCalledWith(2, "/api/paired-tasks/EX-1", {
    method: "POST"
  });
  expect(await screen.findByText(/等待 Mac 助手接收/)).toBeInTheDocument();
});
