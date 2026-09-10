import { handleUpload } from "@vercel/blob/client";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();

// This runs on Vercel as a serverless function (the /api folder is auto-detected).
// It never touches the raw file bytes itself — the browser uploads directly to
// Vercel Blob using a short-lived token this route issues, which is why large
// files (like a 40MB+ .spn file) work fine despite serverless payload limits.
export default async function handler(request, response) {
  const body = request.body;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        return {
          allowedContentTypes: ["text/csv", "text/plain", "application/xml", "text/xml", "application/octet-stream"],
          maximumSizeInBytes: 100 * 1024 * 1024, // 100MB — SPAN files can be large
          tokenPayload: clientPayload, // "bhavcopy" | "span" | "elm", passed through from the frontend
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        // tokenPayload is whatever string the frontend passed as clientPayload
        const kind = tokenPayload;
        if (!kind) return;
        await redis.set(`shared:${kind}`, {
          url: blob.url,
          filename: blob.pathname,
          uploadedAt: Date.now(),
        });
      },
    });
    response.status(200).json(jsonResponse);
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
