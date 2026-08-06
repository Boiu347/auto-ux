import { DeviceService } from "./device-service";
import { PrismaDeviceStore } from "./prisma-device-store";

export const deviceService = new DeviceService(new PrismaDeviceStore());
