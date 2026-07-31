import { HomeDashboard } from "../components/home-dashboard";

export default function HomePage() {
  const localTestKey = process.env.AUTO_UX_LOCAL_TEST_KEY;
  const demoBootstrap =
    process.env.DEV_DEMO_STATE_FILE &&
    localTestKey &&
    localTestKey.length >= 32
      ? {
          userId: process.env.DEV_USER_ID ?? "U-1",
          workspaceId: process.env.DEV_WORKSPACE_ID ?? "W-1",
          localTestKey
        }
      : undefined;
  return (
    <HomeDashboard
      developmentSessionEnabled={process.env.NODE_ENV !== "production"}
      demoBootstrap={demoBootstrap}
    />
  );
}
