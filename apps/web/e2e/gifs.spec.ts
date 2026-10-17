import { expect, test } from "@playwright/test";
import { createCommunity, newUserPage, signUp } from "./helpers";

test("GIF links require consent before an external media request", async ({ browser }) => {
  const page = await newUserPage(browser);
  await signUp(page, "GIF Tester");
  await createCommunity(page, "GIF Lab");

  const requested: string[] = [];
  await page.route("https://media4.giphy.com/**", async (route) => {
    requested.push(route.request().url());
    // A decodable 1x1 GIF keeps this test independent of the remote provider; a broken one hits onError.
    await route.fulfill({
      contentType: "image/gif",
      body: Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"),
    });
  });

  const composer = page.getByRole("textbox", { name: "Message #general" });
  await composer.fill("https://media4.giphy.com/media/test/giphy.gif");
  await composer.press("Enter");

  const load = page.getByRole("button", { name: "Load GIF from GIPHY" });
  await expect(load).toBeVisible();
  expect(requested).toEqual([]);
  await load.click();
  await expect(page.getByRole("img", { name: "GIF from GIPHY" })).toBeVisible();
  await expect.poll(() => requested.length).toBeGreaterThan(0);
  await expect(page.getByRole("link", { name: "Powered by GIPHY" })).toHaveAttribute("href", "https://giphy.com");
  await page.context().close();
});


test("configured KLIPY and GIPHY providers can send a GIF through the channel composer", async ({ browser }) => {
  const page = await newUserPage(browser);
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
  const klipyUrl = "https://static.klipy.com/sample.gif";
  const giphyUrl = "https://media4.giphy.com/media/sample/giphy.gif";

  await page.route("**/api/gifs/providers", (route) =>
    route.fulfill({ json: { klipy: "test-klipy", giphy: "test-giphy" } }),
  );
  await page.route("https://static.klipy.com/**", (route) =>
    route.fulfill({ contentType: "image/gif", body: gif }),
  );
  await page.route("https://media4.giphy.com/**", (route) =>
    route.fulfill({ contentType: "image/gif", body: gif }),
  );
  await page.route("https://api.klipy.com/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/categories")) {
      return route.fulfill({ json: { result: true, data: { locale: "en", categories: [] } } });
    }
    if (url.pathname.includes("/share/")) {
      return route.fulfill({ json: { result: true, data: {} } });
    }
    const asset = { url: klipyUrl, width: 1, height: 1, size: 32 };
    return route.fulfill({ json: {
      result: true, data: {
        data: [{ id: 1, slug: "sample", title: "KLIPY sample", type: "gif", file: { md: { gif: asset }, sm: { gif: asset } } }],
        current_page: 1, per_page: 50, has_next: false,
      },
    } });
  });
  await page.route("https://api.giphy.com/**", (route) => {
    const url = new URL(route.request().url());
    const response = { meta: { status: 200, msg: "OK", response_id: "mock" }, pagination: { total_count: 1, count: 1, offset: 0 } };
    if (url.pathname.endsWith("/categories")) return route.fulfill({ json: { ...response, data: [] } });
    return route.fulfill({ json: {
      ...response,
      data: [{ id: "sample", title: "GIPHY sample", type: "gif", images: {
        original: { url: giphyUrl, width: "1", height: "1" },
        fixed_width: { url: giphyUrl, width: "1", height: "1" },
      } }],
    } });
  });

  await signUp(page, "GIF Picker Tester");
  await createCommunity(page, "GIF Picker Lab");
  const trigger = page.getByRole("button", { name: "Choose GIF" });
  await expect(trigger).toBeVisible();

  await trigger.click();
  // The picker opens on categories; trending results need one click.
  await page.getByRole("button", { name: "Trending GIFs" }).click();
  await page.getByRole("button", { name: "Select GIF" }).first().click();
  await expect(page.getByRole("button", { name: "Load GIF from KLIPY" })).toBeVisible();

  await trigger.click();
  await page.getByRole("button", { name: "GIPHY", exact: true }).click();
  // The picker opens on categories; trending results need one click.
  await page.getByRole("button", { name: "Trending GIFs" }).click();
  await page.getByRole("button", { name: "Select GIF" }).first().click();
  await expect(page.getByRole("button", { name: "Load GIF from GIPHY" })).toBeVisible();
  await page.context().close();
});
