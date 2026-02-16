import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: {
          configPath: "./wrangler.toml",
        },
        miniflare: {
          d1Databases: ["DB"],
          queueProducers: {
            CLASSIFICATION_QUEUE: "thought-classification",
            DIGEST_DELIVERY_QUEUE: "digest-delivery",
          },
          queueConsumers: {
            "thought-classification": {},
            "digest-delivery": {},
          },
        },
      },
    },
  },
});
