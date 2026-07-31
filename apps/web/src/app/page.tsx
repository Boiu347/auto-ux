import { HomeDashboard } from "../components/home-dashboard";

export default function HomePage() {
  const nonProductionAdapter =
    process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  const demoBootstrap =
    nonProductionAdapter && process.env.DEV_DEMO_STATE_FILE
      ? {
          userId: process.env.DEV_USER_ID ?? "U-1",
          workspaceId: process.env.DEV_WORKSPACE_ID ?? "W-1"
        }
      : undefined;
  return (
    <HomeDashboard
      developmentSessionEnabled={nonProductionAdapter}
      demoBootstrap={demoBootstrap}
    />
  );
}
