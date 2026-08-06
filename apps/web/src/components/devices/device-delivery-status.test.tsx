import { render, screen } from "@testing-library/react";
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
