import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import * as mediaStore from "../../media/store.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";

const bufferSendPlugin: ChannelPlugin = {
  id: "bufferchat",
  meta: {
    id: "bufferchat",
    label: "BufferChat",
    selectionLabel: "BufferChat",
    docsPath: "/channels/bufferchat",
    blurb: "Buffer send hydration test plugin.",
  },
  capabilities: { chatTypes: ["direct", "group"], media: true },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ enabled: true }),
    isConfigured: () => true,
  },
  actions: {
    listActions: () => ["send"],
    supportsAction: ({ action }) => action === "send",
    handleAction: async ({ params }) =>
      jsonResult({
        ok: true,
        message: params.message ?? null,
        media: params.media ?? null,
        filename: params.filename ?? null,
        contentType: params.contentType ?? null,
      }),
  },
};

const cfg = {
  channels: {
    bufferchat: {
      enabled: true,
    },
  },
} as OpenClawConfig;

async function withSandbox(test: (sandboxDir: string) => Promise<void>) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "msg-send-buffer-"));
  try {
    await test(sandboxDir);
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true });
  }
}

describe("runMessageAction send buffer hydration", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    vi.restoreAllMocks();
  });

  it("materializes host buffer payloads into media for dry-run sends", async () => {
    const saveMediaBufferSpy = vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      id: "media-1",
      path: "/tmp/openclaw-outbound/test-buffer.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      createdAt: Date.now(),
    });
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "bufferchat", source: "test", plugin: bufferSendPlugin }]),
    );

    const result = await runMessageAction({
      cfg,
      action: "send",
      params: {
        channel: "bufferchat",
        target: "channel:abc",
        message: "buffer payload",
        buffer: Buffer.from("hello").toString("base64"),
        filename: "test-buffer.txt",
        contentType: "text/plain",
      },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
    expect(result.handledBy).toBe("core");
    expect(saveMediaBufferSpy).toHaveBeenCalledWith(
      Buffer.from("hello"),
      "text/plain",
      "outbound",
      undefined,
      "test-buffer.txt",
    );
    expect(result.sendResult?.mediaUrl).toBe("/tmp/openclaw-outbound/test-buffer.txt");
  });

  it("materializes sandbox buffer payloads into sandbox outbound for dry-run sends", async () => {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "bufferchat", source: "test", plugin: bufferSendPlugin }]),
    );
    await withSandbox(async (sandboxDir) => {
      const result = await runMessageAction({
        cfg,
        action: "send",
        params: {
          channel: "bufferchat",
          target: "channel:abc",
          message: "buffer payload",
          buffer: Buffer.from("hello").toString("base64"),
          filename: "sandbox-buffer.txt",
          contentType: "text/plain",
        },
        dryRun: true,
        sandboxRoot: sandboxDir,
      });

      expect(result.kind).toBe("send");
      expect(result.handledBy).toBe("core");
      expect(result.sendResult?.mediaUrl).toBe(
        path.join(sandboxDir, "outbound", "sandbox-buffer.txt"),
      );
      await expect(
        fs.readFile(path.join(sandboxDir, "outbound", "sandbox-buffer.txt"), "utf8"),
      ).resolves.toBe("hello");
    });
  });
});
