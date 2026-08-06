import { HomeDashboard } from "../components/home-dashboard";

export default function HomePage() {
  const nonProductionAdapter =
    process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  const bootstrap =
    nonProductionAdapter
      ? {
          userId: process.env.DEV_USER_ID ?? "U-1",
          workspaceId: process.env.DEV_WORKSPACE_ID ?? "W-1"
        }
      : undefined;
  return (
    <HomeDashboard
      bootstrap={bootstrap}
      localLaunchEnabled={
        nonProductionAdapter && process.env.AUTO_UX_LOCAL_CODEX_LAUNCH === "1"
      }
      cloudPairingEnabled={!nonProductionAdapter}
    />
  );
}
