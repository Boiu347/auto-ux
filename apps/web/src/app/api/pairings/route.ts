import { NextResponse } from "next/server";

import type { DeviceService } from "../../../server/devices/device-service";
import { pairedBrowserCookie } from "../../../server/devices/device-http";
import { deviceService } from "../../../server/devices/device-runtime";
import { getRequestUser } from "../../../server/auth/request-user";
import type { CurrentUser } from "../../../server/auth/current-user";

type PairingCreator = Pick<DeviceService, "createPairing">;

export function createPairingHandlers(
  service: PairingCreator,
  currentUser: (request: Request) => Promise<CurrentUser | null> = getRequestUser
) {
  return {
    async POST(request: Request): Promise<Response> {
      const user = await currentUser(request);
      if (!user) {
        return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
      }
      const pairing = await service.createPairing(user);
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
