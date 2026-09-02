import { NextResponse } from "next/server";

import type { DeviceService } from "../../../../server/devices/device-service";
import { readPairedBrowserToken } from "../../../../server/devices/device-http";
import { deviceService } from "../../../../server/devices/device-runtime";
import { getRequestUser } from "../../../../server/auth/request-user";
import type { CurrentUser } from "../../../../server/auth/current-user";

type PairingReader = Pick<DeviceService, "getBrowserPairing">;

export function createCurrentPairingHandler(
  service: PairingReader,
  currentUser: (request: Request) => Promise<CurrentUser | null> = getRequestUser
) {
  return async function GET(request: Request): Promise<Response> {
    const user = await currentUser(request);
    if (!user) {
      return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    }
    const token = readPairedBrowserToken(request);
    if (!token) return NextResponse.json({ status: "unpaired" });
    const pairing = await service.getBrowserPairing(token, user);
    return NextResponse.json(pairing ?? { status: "unpaired" });
  };
}

export const GET = createCurrentPairingHandler(deviceService);
export const runtime = "nodejs";
