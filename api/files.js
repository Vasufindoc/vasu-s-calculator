import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

export default async function handler(request, response) {
  const [bhavcopy, span, elm, elmContracts] = await Promise.all([
    redis.get("shared:bhavcopy"),
    redis.get("shared:span"),
    redis.get("shared:elm"),
    redis.get("shared:elmContracts"),
  ]);
  response.status(200).json({ bhavcopy, span, elm, elmContracts });
}
