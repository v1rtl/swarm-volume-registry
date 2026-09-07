import { describe, expect, test } from "bun:test";
import {
  formatMessage,
  notify,
  readNotifyConfig,
  runUrl,
  type Notification,
} from "../src/notify.ts";

const CONFIGURED = { telegramBotToken: "token", telegramChatId: "chat" };

describe("readNotifyConfig", () => {
  test("blank variables read as unconfigured, not as empty credentials", () => {
    const config = readNotifyConfig({
      TELEGRAM_BOT_TOKEN: "  ",
      TELEGRAM_CHAT_ID: "",
    } as NodeJS.ProcessEnv);
    expect(config.telegramBotToken).toBeUndefined();
    expect(config.telegramChatId).toBeUndefined();
  });
});

describe("runUrl", () => {
  test("builds the Actions run link", () => {
    expect(
      runUrl({
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "org/repo",
        GITHUB_RUN_ID: "42",
      } as NodeJS.ProcessEnv),
    ).toBe("https://github.com/org/repo/actions/runs/42");
  });

  test("outside Actions there is no run to link to", () => {
    expect(runUrl({} as NodeJS.ProcessEnv)).toBeUndefined();
  });
});

describe("formatMessage", () => {
  test("distinguishes a failure from a warning at a glance", () => {
    expect(formatMessage({ severity: "failure", title: "t", details: [] })).toStartWith(
      "🔴",
    );
    expect(formatMessage({ severity: "warning", title: "t", details: [] })).toStartWith(
      "🟡",
    );
  });

  test("details become bullets and the run link goes last", () => {
    expect(
      formatMessage(
        { severity: "failure", title: "Cycle failed", details: ["a", "b"] },
        "https://example/run",
      ),
    ).toBe("🔴 Cycle failed\n• a\n• b\nhttps://example/run");
  });
});

describe("notify", () => {
  const notification: Notification = {
    severity: "failure",
    title: "t",
    details: [],
  };

  test("no channel configured is reported, not thrown", async () => {
    const result = await notify({}, notification, {} as NodeJS.ProcessEnv);
    expect(result).toEqual({ sent: false, reason: "no notification channel configured" });
  });

  // A notifier that throws would turn a warning into a failed run, which is
  // exactly backwards — so every transport failure has to come back as a value.
  test("a network failure comes back as a reason", async () => {
    const result = await notify(
      CONFIGURED,
      notification,
      {} as NodeJS.ProcessEnv,
      // An immediate timeout is the cheapest way to force the failure path
      // without reaching the network.
      1,
    );
    expect(result.sent).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});
