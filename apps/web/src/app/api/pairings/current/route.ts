import { NextResponse } from "next/server";

import type { DeviceService } from "../../../../server/devices/device-service";
import { readPairedBrowserToken } from "../../../../server/devices/device-http";
import { deviceService } from "../../../../server/devices/device-runtime";

type PairingReader = Pick<DeviceService, "getBrowserPairing">;

export function createCurrentPairingHandler(service: PairingReader) {
  return async function GET(request: Request): Promise<Response> {
    const token = readPairedBrowserToken(request);
    if (!token) return NextResponse.json({ status: "unpaired" });
    const pairing = await service.getBrowserPairing(token);
    return NextResponse.json(pairing ?? { status: "unpaired" });
  };
}

export const GET = createCurrentPairingHandler(deviceService);
export const runtime = "nodejs";
