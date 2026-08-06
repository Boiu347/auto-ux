import { NextResponse } from "next/server";

import type { DeviceService } from "../../../server/devices/device-service";
import { pairedBrowserCookie } from "../../../server/devices/device-http";
import { deviceService } from "../../../server/devices/device-runtime";

type PairingCreator = Pick<DeviceService, "createPairing">;

export function createPairingHandlers(service: PairingCreator) {
  return {
    async POST(request: Request): Promise<Response> {
      const pairing = await service.createPairing();
      const response = NextResponse.json(
        {
          pairingId: pairing.pairingId,
          code: pairing.code,
          expiresAt: pairing.expiresAt
        },
        { status: 201 }
      );
      response.headers.set(
        "set-cookie",
        pairedBrowserCookie(
          pairing.browserToken,
          new URL(request.url).protocol === "https:"
        )
      );
      return response;
    }
  };
}

const handlers = createPairingHandlers(deviceService);
export const POST = handlers.POST;
export const runtime = "nodejs";
