import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  expandAdvancedSection,
  signup,
} from "./helpers";

test("local execution settings progressively reveal pairing and project access", async ({
  page,
}, testInfo) => {
  await signup(page, `local-agent-${Date.now()}@rakazo.test`, "password12", "Local agent");
  await completeOnboarding(page);
  const botId = await activeBotId(page);
  await page.route("**/rpc/localAgent/settings", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          allowedOrigins: [],
          connections: [],
          target: null,
          pairing: { spaceId: "fixture-space", userId: "fixture-user", botId },
        },
      },
    }),
  );
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const advanced = page.getByTestId("bot-settings-advanced");
  await expandAdvancedSection(advanced);
  const settings = page.getByTestId("local-agent-settings");
  await expect(settings.getByRole("combobox", { name: "Execution", exact: true })).toBeVisible();
  await expect(settings.getByLabel("Pairing token")).toHaveCount(0);
  await settings.getByRole("button", { name: "Connect local agent", exact: true }).click();
  await expect(settings.getByLabel("Pairing token")).toHaveAttribute("type", "password");
  await captureScreenshot(page, testInfo, "local-agent-pairing");
});
