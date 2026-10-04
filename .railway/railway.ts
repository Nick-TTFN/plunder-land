import { defineRailway, github, postgres, preserve, project, redis, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "ams" });
  const Redis = redis("Redis", { region: "ams" });
  Redis.deploy = { startCommand: "/bin/sh -c \"rm -rf $RAILWAY_VOLUME_MOUNT_PATH/lost+found/ && exec docker-entrypoint.sh redis-server --requirepass $REDIS_PASSWORD --save 60 1 --dir $RAILWAY_VOLUME_MOUNT_PATH\"" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "ams", sizeMB: 5000 });
  const redisVolume = volume("redis-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "ams", sizeMB: 5000 });
  const server = service("server", {
    source: github("Nick-TTFN/plunder-land", { checkSuites: false, rootDirectory: "/services/battle-royale-server" }),
    build: { buildEnvironment: "V3", builder: "RAILPACK", watchPatterns: ["/services/battle-royale-server/**"] },
    start: "node dist/index.js",
    healthcheck: "/healthcheck",
    healthcheckTimeout: 60,
    replicas: { "ams": 1 },
    deploy: { drainingSeconds: 600, overlapSeconds: 30 },
    env: { DATABASE_URL: preserve(), GA_API_SECRET: preserve(), GA_MEASUREMENT_ID: preserve(), REDIS_URL: preserve(), SENTRY_DSN: preserve() },
  });

  return project("plunderland", {
    resources: [Postgres, server, Redis, postgresVolume, redisVolume],
  });
});
