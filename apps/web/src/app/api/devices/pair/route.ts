import { NextResponse } from "next/server";
import { z } from "zod";

import type { DeviceService } from "../../../../server/devices/device-service";
import { deviceService } from "../../../../server/devices/device-runtime";

const ClaimSchema = z.object({
  code: z.string().regex(/^[A-Fa-f0-9]{8}$/),
  agentId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
}).strict();

type PairingClaimer = Pick<DeviceService, "claimPairing">;

export function createDevicePairHandler(service: PairingClaimer) {
  return async function POST(request: Request): Promise<Response> {
    try {
      const input = ClaimSchema.parse(await request.json());
      return NextResponse.json(await service.claimPairing(input));
    } catch (error) {
      const code = error instanceof Error ? error.message : "INVALID_PAIRING_REQUEST";
      const status = code === "PAIRING_NOT_FOUND" ? 404 : code === "PAIRING_EXPIRED" ? 410 : code === "PAIRING_ALREADY_CLAIMED" ? 409 : 400;
      return NextResponse.json({ code }, { status });
    }
  };
}

export const POST = createDevicePairHandler(deviceService);
export const runtime = "nodejs";
