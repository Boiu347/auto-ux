import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MacPairingPanel } from "./mac-pairing-panel";

afterEach(() => vi.unstubAllGlobals());

describe("MacPairingPanel", () => {
  it("creates a one-time code and shows the exact install command", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ status: "unpaired" }))
      .mockResolvedValueOnce(Response.json({
        pairingId: "Pairing_1",
        code: "A1B2C3D4",
        expiresAt: "2026-08-06T04:10:00.000Z"
      }, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<MacPairingPanel origin="https://auto-ux.example" onReadyChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "生成 Mac 配对码" }));

    expect(await screen.findByText("A1B2C3D4")).toBeInTheDocument();
    expect(screen.getByText(/install-mac-agent\.sh/)).toHaveTextContent(
      "https://auto-ux.example/downloads/install-mac-agent.sh"
    );
    expect(screen.getByText(/install-mac-agent\.sh/)).not.toHaveTextContent("githubusercontent");
  });

  it("reports a paired online Mac to the task form", async () => {
    const onReadyChange = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      status: "paired",
      pairingId: "Pairing_1",
      agentId: "MacAgent_1",
      version: "0.1.0",
      online: true,
      lastSeenAt: "2026-08-06T04:00:00.000Z"
    })));
    render(<MacPairingPanel origin="https://auto-ux.example" onReadyChange={onReadyChange} />);

    await screen.findByText("Mac 助手在线");
    await waitFor(() => expect(onReadyChange).toHaveBeenCalledWith(true));
  });
});
