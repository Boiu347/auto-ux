import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { NextResponse } from "next/server";

import type { DeviceService } from "../../../../../server/devices/device-service";
import { readDeviceBearerToken } from "../../../../../server/devices/device-http";
import { deviceService } from "../../../../../server/devices/device-runtime";

const assets = {
  "install-mac-agent.sh": "text/x-shellscript; charset=utf-8",
  "mac-agent.mjs": "text/javascript; charset=utf-8",
  "baidu-cloud-one-click-config.tar.gz": "application/gzip"
} as const;

type AssetName = keyof typeof assets;
type DeviceAuthenticator = Pick<DeviceService, "authenticateDevice">;

export function createDeviceAssetHandler(
  service: DeviceAuthenticator,
  loadAsset: (assetName: AssetName) => Promise<Uint8Array> = (assetName) =>
    readFile(join(process.cwd(), "public", "downloads", assetName))
) {
  return async function GET(
    request: Request,
    context: { params: Promise<{ assetName: string }> }
  ): Promise<Response> {
    const token = readDeviceBearerToken(request);
    if (!token) {
      return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    }
    try {
      await service.authenticateDevice(token);
    } catch {
      return NextResponse.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    }

    const { assetName } = await context.params;
    if (!(assetName in assets)) {
      return NextResponse.json({ code: "ASSET_NOT_FOUND" }, { status: 404 });
    }
    const safeAssetName = assetName as AssetName;
    const body = await loadAsset(safeAssetName);
    return new Response(body as BodyInit, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="${safeAssetName}"`,
        "content-type": assets[safeAssetName],
        "x-content-type-options": "nosniff"
      }
    });
  };
}

export const GET = createDeviceAssetHandler(deviceService);
export const runtime = "nodejs";
